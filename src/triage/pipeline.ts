import { EmbedBuilder, type Message } from "discord.js";
import type { Db } from "../db/pool.js";
import type { DiscordCtx } from "../discord/actions.js";
import { WrikeClient, wrikeImportance } from "../integrations/wrike.js";
import type { Category, Classification, Classifier } from "./classifier.js";
import { shouldClassify } from "./prefilter.js";
import { matchCohort, type CohortRow } from "./routing.js";

interface CategoryRow extends Category {
  alert_immediately: boolean;
  dm_facilitators: boolean;
  create_ticket: boolean;
}

export interface TriageDeps {
  db: Db;
  ctx: DiscordCtx;
  classify: Classifier;
  wrike?: WrikeClient;
  minChars: number;
  concurrency: number;
  fallbackAlertChannelId?: string;
  log?: Pick<Console, "info" | "error">;
}

const SEVERITY_COLOR = { low: 0x95a5a6, medium: 0xf1c40f, high: 0xe67e22, critical: 0xe74c3c } as const;

export function createTriage(deps: TriageDeps) {
  const log = deps.log ?? console;
  const queue: Message[] = [];
  let active = 0;
  let cache: { at: number; categories: CategoryRow[]; cohorts: CohortRow[] } | null = null;

  async function loadConfig() {
    if (cache && Date.now() - cache.at < 60_000) return cache;
    const [cats, cohorts] = await Promise.all([
      deps.db.query<CategoryRow>("SELECT * FROM triage_categories WHERE enabled"),
      deps.db.query<CohortRow>("SELECT * FROM cohorts"),
    ]);
    cache = { at: Date.now(), categories: cats.rows, cohorts: cohorts.rows };
    return cache;
  }

  function invalidate() {
    cache = null;
  }

  async function process(msg: Message) {
    const { categories, cohorts } = await loadConfig();
    if (!categories.length) return;

    const recent = await msg.channel.messages
      .fetch({ limit: 5, before: msg.id })
      .then((c) =>
        [...c.values()]
          .reverse()
          .map((m) => ({ author: m.member?.displayName ?? m.author.username, content: m.content.slice(0, 300) })),
      )
      .catch(() => []);

    const channelName = "name" in msg.channel && msg.channel.name ? msg.channel.name : "direct-message";
    const result: Classification = await deps.classify(
      {
        content: msg.content.slice(0, 2000),
        channelName,
        authorName: msg.member?.displayName ?? msg.author.username,
        recentContext: recent,
      },
      categories,
    );
    if (result.category === "none" || !result.needs_human) return;
    const category = categories.find((c) => c.name === result.category);
    if (!category) return;

    const ch = msg.channel;
    const isThread = ch.isThread();
    const parentId = isThread ? ch.parentId : null;
    const parent = isThread ? ch.parent : null;
    const categoryId = (isThread ? parent?.parentId : "parentId" in ch ? ch.parentId : null) ?? null;
    const cohort = matchCohort(cohorts, {
      channelId: ch.id,
      parentChannelId: parentId,
      categoryId,
      authorRoleIds: msg.member ? [...msg.member.roles.cache.keys()] : [],
    });

    const inserted = await deps.db.query<{ id: string }>(
      `INSERT INTO triage_events (guild_id, channel_id, message_id, author_id, author_name, excerpt, category, severity, summary, cohort_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [
        msg.guildId,
        ch.id,
        msg.id,
        msg.author.id,
        msg.member?.displayName ?? msg.author.username,
        msg.content.slice(0, 500),
        result.category,
        result.severity,
        result.summary,
        cohort?.id ?? null,
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) return; // already processed

    const urgent = result.severity === "high" || result.severity === "critical";
    if (category.alert_immediately || urgent) {
      await alert(msg, result, cohort, category, eventId);
    }
    if (category.create_ticket && deps.wrike && cohort?.wrike_folder_id) {
      try {
        const task = await deps.wrike.createTask({
          folderId: cohort.wrike_folder_id,
          title: `[${result.category.replace(/_/g, " ")}] ${cohort.name}: ${result.summary}`,
          fields: [
            ["Severity", result.severity],
            ["From", msg.member?.displayName ?? msg.author.username],
            ["Channel", `#${channelName}`],
            ["Discord message", msg.url],
            ["Triage event", `#${eventId}`],
          ],
          body: msg.content.slice(0, 1500),
          responsibleIds: cohort.wrike_assignee_ids,
          importance: wrikeImportance(result.severity),
        });
        await deps.db.query("UPDATE triage_events SET ticket_id=$2, ticket_url=$3 WHERE id=$1", [eventId, task.id, task.permalink]);
      } catch (err) {
        log.error(`wrike task for event ${eventId} failed: ${(err as Error).message}`);
      }
    }
  }

  async function alert(msg: Message, r: Classification, cohort: CohortRow | null, cat: CategoryRow, eventId: string) {
    const embed = new EmbedBuilder()
      .setTitle(`${r.severity.toUpperCase()} · ${r.category.replace(/_/g, " ")}${cohort ? ` · ${cohort.name}` : ""}`)
      .setDescription(r.summary)
      .addFields(
        { name: "From", value: `<@${msg.author.id}>`, inline: true },
        { name: "Where", value: `<#${msg.channelId}>`, inline: true },
        { name: "Message", value: `[Jump to message](${msg.url})`, inline: true },
      )
      .setColor(SEVERITY_COLOR[r.severity])
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
    if (cohort && (cat.dm_facilitators || r.severity === "critical")) {
      for (const uid of cohort.facilitator_user_ids) {
        try {
          const user = await deps.ctx.client.users.fetch(uid);
          await user.send({ embeds: [embed] });
          sent = true;
        } catch (err) {
          log.error(`alert DM to ${uid} failed: ${(err as Error).message}`);
        }
      }
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
    if (!shouldClassify(msg.content, deps.minChars)) return;
    if (queue.length > 500) {
      log.error("triage queue full; dropping message");
      return;
    }
    queue.push(msg);
    pump();
  }

  return { onMessage, invalidate, _process: process };
}

