import { EmbedBuilder, PermissionFlagsBits, type Message } from "discord.js";
import type { Db } from "../db/pool.js";
import type { DiscordCtx } from "../discord/actions.js";
import { WrikeClient, wrikeImportance, wrikeTicketType } from "../integrations/wrike.js";
import { emailHtml, escapeHtml, type Mailer } from "../integrations/email.js";
import type { Category, Classification, Classifier } from "./classifier.js";
import { shouldClassify } from "./prefilter.js";
import { cohortLabel, matchCohort, type CohortRow } from "./routing.js";
import { extractHashtags, maxSeverity, strongestTicketTag, type HashtagRow, type Severity } from "./hashtags.js";

interface CategoryRow extends Category {
  alert_immediately: boolean;
  dm_facilitators: boolean;
  create_ticket: boolean;
}

export interface WrikeFieldIds {
  cohort?: string;
  ticketType?: string;
  sourceTag?: string;
}

export interface TriageDeps {
  db: Db;
  ctx: DiscordCtx;
  /** AI classifier; when absent, only hashtags raise tickets. */
  classify?: Classifier;
  wrike?: WrikeClient;
  wrikeFields?: WrikeFieldIds;
  mailer?: Mailer;
  programEmails?: string[];
  trackLearnerActivity?: boolean;
  minChars: number;
  concurrency: number;
  fallbackAlertChannelId?: string;
  log?: Pick<Console, "info" | "error">;
}

interface NewEvent {
  msg: Message;
  category: CategoryRow;
  severity: Severity;
  summary: string;
  cohort: CohortRow | null;
  sourceTag?: string;
  requestedBy?: string;
}

const SEVERITY_COLOR = { low: 0x95a5a6, medium: 0xf1c40f, high: 0xe67e22, critical: 0xe74c3c } as const;
const OPEN = "status IN ('open','in_progress')";

export function createTriage(deps: TriageDeps) {
  const log = deps.log ?? console;
  const queue: Message[] = [];
  let active = 0;
  let cache: { at: number; categories: CategoryRow[]; cohorts: CohortRow[]; hashtags: HashtagRow[] } | null = null;

  async function loadConfig() {
    if (cache && Date.now() - cache.at < 60_000) return cache;
    const [cats, cohorts, tags] = await Promise.all([
      deps.db.query<CategoryRow>("SELECT * FROM triage_categories WHERE enabled"),
      deps.db.query<CohortRow>("SELECT * FROM cohorts"),
      deps.db.query<HashtagRow>("SELECT * FROM hashtags"),
    ]);
    cache = { at: Date.now(), categories: cats.rows, cohorts: cohorts.rows, hashtags: tags.rows };
    return cache;
  }

  function invalidate() {
    cache = null;
  }

  function placeOf(msg: Message) {
    const ch = msg.channel;
    const isThread = ch.isThread();
    const parent = isThread ? ch.parent : null;
    return {
      guildId: msg.guildId,
      channelId: ch.id,
      parentChannelId: isThread ? ch.parentId : null,
      categoryId: (isThread ? parent?.parentId : "parentId" in ch ? ch.parentId : null) ?? null,
      authorRoleIds: msg.member ? [...msg.member.roles.cache.keys()] : [],
      threadKey: isThread ? ch.id : null,
      channelName: "name" in ch && ch.name ? ch.name : "direct-message",
    };
  }

  const authorName = (m: Message) => m.member?.displayName ?? m.author.username;

  function isStaff(msg: Message, cohort: CohortRow | null) {
    if (cohort?.facilitator_user_ids.includes(msg.author.id)) return true;
    try {
      return !!msg.member?.permissions.has(PermissionFlagsBits.ManageMessages);
    } catch {
      return false;
    }
  }

  async function process(msg: Message) {
    const { categories, cohorts, hashtags } = await loadConfig();
    const place = placeOf(msg);
    const cohort = matchCohort(cohorts, place);
    const tags = extractHashtags(msg.content)
      .map((t) => hashtags.find((h) => h.tag === t))
      .filter((h): h is HashtagRow => !!h);

    // 1. Count every known hashtag (cohort-level; author only when tracking is on).
    for (const t of tags) {
      await deps.db
        .query(
          `INSERT INTO hashtag_events (tag, cohort_id, guild_id, channel_id, message_id, author_id)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (message_id, tag) DO NOTHING`,
          [t.tag, cohort?.id ?? null, msg.guildId, msg.channelId, msg.id, deps.trackLearnerActivity ? msg.author.id : null],
        )
        .catch((err) => log.error(`hashtag log failed: ${(err as Error).message}`));
    }

    // 2. Staff tags act on the message they reply to (or the thread's open ticket).
    const staffTag = tags.find((t) => t.staff_only);
    if (staffTag) {
      if (isStaff(msg, cohort)) await handleStaffTag(msg, staffTag, cohort, categories, place.threadKey);
      return;
    }

    // 3. Decide whether this needs a human.
    const ticketTag = strongestTicketTag(tags);
    let result: Classification | null = null;
    if (deps.classify && (ticketTag || shouldClassify(msg.content, deps.minChars))) {
      const recent = await msg.channel.messages
        .fetch({ limit: 5, before: msg.id })
        .then((c) => [...c.values()].reverse().map((m) => ({ author: authorName(m), content: m.content.slice(0, 300) })))
        .catch(() => []);
      result = await deps.classify(
        {
          content: msg.content.slice(0, 2000),
          channelName: place.channelName,
          authorName: authorName(msg),
          recentContext: recent,
          tagHints: tags.map((t) => `#${t.tag} (${t.description})`),
        },
        categories,
      );
      if (result.category === "none" || !result.needs_human) {
        if (ticketTag) log.info(`#${ticketTag.tag} on ${msg.id} judged not to need a facilitator`);
        return;
      }
      if (ticketTag) result.severity = maxSeverity(result.severity, ticketTag.min_severity);
    } else if (ticketTag) {
      // No AI: the learner's tag is taken at its word.
      result = {
        category: ticketTag.category ?? "course_support",
        severity: ticketTag.min_severity ?? "medium",
        needs_human: true,
        summary: `#${ticketTag.tag}: ${msg.content.replace(/\s+/g, " ").slice(0, 140)}`,
      };
    }
    if (!result) return;
    const category = categories.find((c) => c.name === result!.category);
    if (!category) return;

    // 4. One ticket per conversation: later messages in the same thread become comments.
    if (place.threadKey) {
      const existing = await deps.db.query<{ id: string; ticket_id: string | null; severity: string }>(
        `SELECT id, ticket_id, severity FROM triage_events WHERE thread_key=$1 AND ${OPEN} ORDER BY id LIMIT 1`,
        [place.threadKey],
      );
      const ev = existing.rows[0];
      if (ev) {
        if (ev.ticket_id && deps.wrike) {
          await deps.wrike
            .addComment(ev.ticket_id, `${authorName(msg)} in Discord: ${msg.content.slice(0, 1500)}\n${msg.url}`)
            .catch((err) => log.error(`wrike comment failed: ${(err as Error).message}`));
        }
        return;
      }
    }

    await createEvent({
      msg,
      category,
      severity: result.severity,
      summary: result.summary,
      cohort,
      sourceTag: ticketTag?.tag,
    });
  }

  async function handleStaffTag(msg: Message, tag: HashtagRow, cohort: CohortRow | null, categories: CategoryRow[], threadKey: string | null) {
    const target = msg.reference?.messageId
      ? await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null)
      : null;

    if (tag.action === "resolve") {
      const { rows } = await deps.db.query<{ id: string; ticket_id: string | null }>(
        target
          ? `SELECT id, ticket_id FROM triage_events WHERE message_id=$1 AND ${OPEN}`
          : `SELECT id, ticket_id FROM triage_events WHERE thread_key=$1 AND ${OPEN}`,
        [target ? target.id : threadKey ?? "-"],
      );
      for (const ev of rows) {
        await deps.db.query("UPDATE triage_events SET status='resolved', resolved_at=now() WHERE id=$1", [ev.id]);
        if (ev.ticket_id && deps.wrike) {
          await deps.wrike.completeTask(ev.ticket_id).catch((err) => log.error(`wrike complete failed: ${(err as Error).message}`));
        }
      }
      if (rows.length) await msg.react("✅").catch(() => {});
      return;
    }

    // followup / escalate need something to point at.
    const subject = target ?? null;
    if (!subject) return;
    const category = categories.find((c) => c.name === (tag.category ?? "follow_up"));
    if (!category) return;
    const note = msg.content.replace(/#\w+/g, "").trim();
    await createEvent({
      msg: subject,
      category,
      severity: tag.min_severity ?? "medium",
      summary:
        (tag.action === "escalate" ? "Escalated" : "Follow-up requested") +
        ` by ${authorName(msg)}${note ? `: ${note.slice(0, 160)}` : ""}`,
      cohort,
      sourceTag: tag.tag,
      requestedBy: msg.author.id,
    });
    await msg.react("👍").catch(() => {});
  }

  async function createEvent(e: NewEvent) {
    const { msg, cohort } = e;
    const place = placeOf(msg);
    const inserted = await deps.db.query<{ id: string }>(
      `INSERT INTO triage_events (guild_id, channel_id, message_id, author_id, author_name, excerpt, category, severity, summary, cohort_id, thread_key, source_tag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [
        msg.guildId,
        msg.channelId,
        msg.id,
        msg.author.id,
        authorName(msg),
        msg.content.slice(0, 500),
        e.category.name,
        e.severity,
        e.summary,
        cohort?.id ?? null,
        place.threadKey,
        e.sourceTag ?? null,
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) return null; // already a ticket for this message

    const urgent = e.severity === "high" || e.severity === "critical";
    if (e.category.alert_immediately || urgent) await alert(e, eventId);
    if (e.category.create_ticket) await openTicket(e, eventId, place.channelName);
    await msg.react("✅").catch(() => {}); // tells the learner it was picked up
    return eventId;
  }

  async function openTicket(e: NewEvent, eventId: string, channelName: string) {
    const { msg, cohort } = e;
    if (!deps.wrike || !cohort?.wrike_folder_id) return;
    const f = deps.wrikeFields ?? {};
    try {
      const task = await deps.wrike.createTask({
        folderId: cohort.wrike_folder_id,
        title: `[${e.category.name.replace(/_/g, " ")}] ${cohortLabel(cohort)}: ${e.summary}`,
        fields: [
          ["Severity", e.severity],
          ["Cohort", cohortLabel(cohort)],
          ["From", authorName(msg)],
          ["Channel", `#${channelName}`],
          ...(e.sourceTag ? ([["Hashtag", `#${e.sourceTag}`]] as [string, string][]) : []),
          ["Discord message", msg.url],
          ["Triage event", `#${eventId}`],
        ],
        body: msg.content.slice(0, 1500),
        responsibleIds: cohort.wrike_assignee_ids,
        importance: wrikeImportance(e.severity),
        customFields: [
          { id: f.cohort ?? "", value: cohort.code ?? cohort.name },
          { id: f.ticketType ?? "", value: wrikeTicketType(e.category.name) },
          { id: f.sourceTag ?? "", value: e.sourceTag ? `#${e.sourceTag}` : "" },
        ],
      });
      await deps.db.query("UPDATE triage_events SET ticket_id=$2, ticket_url=$3 WHERE id=$1", [eventId, task.id, task.permalink]);
    } catch (err) {
      log.error(`wrike task for event ${eventId} failed: ${(err as Error).message}`);
    }
  }

  async function alert(e: NewEvent, eventId: string) {
    const { msg, cohort } = e;
    const where = cohort ? ` · ${cohortLabel(cohort)}` : "";
    const embed = new EmbedBuilder()
      .setTitle(`${e.severity.toUpperCase()} · ${e.category.name.replace(/_/g, " ")}${where}`)
      .setDescription(e.summary)
      .addFields(
        { name: "From", value: `<@${msg.author.id}>`, inline: true },
        { name: "Where", value: `<#${msg.channelId}>`, inline: true },
        { name: "Message", value: `[Jump to message](${msg.url})`, inline: true },
      )
      .setColor(SEVERITY_COLOR[e.severity])
      .setFooter({ text: `Triage event #${eventId}` })
      .setTimestamp(msg.createdAt);

    let sent = false;
    const channelId = cohort?.alert_channel_id ?? deps.fallbackAlertChannelId;
    if (channelId) {
      try {
        const ch = await deps.ctx.client.channels.fetch(channelId);
        if (ch?.isSendable()) {
          await ch.send({ embeds: [embed] });
          sent = true;
        }
      } catch (err) {
        log.error(`alert to channel ${channelId} failed: ${(err as Error).message}`);
      }
    }
    if (cohort && (e.category.dm_facilitators || e.severity === "critical")) {
      for (const uid of cohort.facilitator_user_ids) {
        if (uid === e.requestedBy) continue;
        try {
          const user = await deps.ctx.client.users.fetch(uid);
          await user.send({ embeds: [embed] });
          sent = true;
        } catch (err) {
          log.error(`alert DM to ${uid} failed: ${(err as Error).message}`);
        }
      }
    }
    // Email: high/critical only, to the cohort's list + program-wide list.
    const recipients = [...(cohort?.notify_emails ?? []), ...(deps.programEmails ?? [])];
    if (deps.mailer && recipients.length && (e.severity === "high" || e.severity === "critical")) {
      const subject = `[${e.severity.toUpperCase()}] ${e.category.name.replace(/_/g, " ")}${where}`;
      const lines: [string, string][] = [
        ["Summary", e.summary],
        ["Cohort", cohort ? cohortLabel(cohort) : "Unassigned"],
        ["From", authorName(msg)],
        ["Discord", msg.url],
        ["Triage event", `#${eventId}`],
      ];
      const r = await deps.mailer.send({
        kind: "critical_alert",
        to: recipients,
        subject,
        text: lines.map(([k, v]) => `${k}: ${v}`).join("\n"),
        html: emailHtml(
          subject,
          lines
            .map(([k, v]) => `<p style="margin:0 0 8px"><b>${escapeHtml(k)}:</b> ${k === "Discord" ? `<a href="${escapeHtml(v)}">Open the message</a>` : escapeHtml(v)}</p>`)
            .join(""),
        ),
        cohortId: cohort?.id,
        logRecipients: true,
      });
      if (r.status !== "failed") sent = true;
    }
    if (sent) await deps.db.query("UPDATE triage_events SET alerted=TRUE WHERE id=$1", [eventId]);
  }

  function pump() {
    while (active < deps.concurrency && queue.length) {
      const msg = queue.shift()!;
      active++;
      process(msg)
        .catch((err) => log.error(`triage failed for ${msg.id}: ${(err as Error).message}`))
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function onMessage(msg: Message) {
    if (msg.author.bot || msg.system || msg.webhookId) return;
    if (!msg.guildId) return; // DMs to the bot are not triaged
    const allowed = deps.ctx.allowedGuildIds;
    if (allowed.length && !allowed.includes(msg.guildId)) return;
    const hasTag = msg.content.includes("#");
    if (!hasTag && !(deps.classify && shouldClassify(msg.content, deps.minChars))) return;
    if (queue.length > 500) {
      log.error("triage queue full; dropping message");
      return;
    }
    queue.push(msg);
    pump();
  }

  return { onMessage, invalidate, _process: process };
}

/** Pull ticket status back from Wrike: Completed → resolved, Cancelled → dismissed. */
export async function syncWrikeStatuses(db: Db, wrike: WrikeClient, log: Pick<Console, "error" | "info"> = console) {
  const { rows } = await db.query<{ id: string; ticket_id: string }>(
    `SELECT id, ticket_id FROM triage_events WHERE ticket_id IS NOT NULL AND ${OPEN}`,
  );
  if (!rows.length) return 0;
  let changed = 0;
  try {
    const statuses = await wrike.getTaskStatuses(rows.map((r) => r.ticket_id));
    for (const s of statuses) {
      const next = s.status === "Completed" ? "resolved" : s.status === "Cancelled" ? "dismissed" : null;
      if (!next) continue;
      const r = await db.query(
        `UPDATE triage_events SET status=$2, resolved_at=now() WHERE ticket_id=$1 AND ${OPEN}`,
        [s.id, next],
      );
      changed += r.rowCount ?? 0;
    }
  } catch (err) {
    log.error(`wrike sync failed: ${(err as Error).message}`);
  }
  return changed;
}
