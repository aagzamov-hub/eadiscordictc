import { CronExpressionParser } from "cron-parser";
import type { Db } from "../db/pool.js";
import { emailHtml, escapeHtml, type Mailer, type SendResult } from "../integrations/email.js";
import type { CohortRow } from "../triage/routing.js";
import { cohortLabel } from "../triage/routing.js";

export interface CohortStats {
  cohort: string;
  cohort_id: string | null;
  since: string;
  flagged: number;
  by_category: Record<string, number>;
  by_status: Record<string, number>;
  urgent_or_abusive: number;
  resolved_in_period: number;
  still_open: { id: string; category: string; severity: string; summary: string; url: string; ticket_url: string | null; created_at: string }[];
  hashtags: Record<string, number>;
  wins: number;
}

const URL_SQL = `'https://discord.com/channels/' || COALESCE(guild_id,'@me') || '/' || channel_id || '/' || message_id`;

/** Stats for one cohort (cohortId) or for everything (null) since a date. */
export async function cohortStats(db: Db, cohort: Pick<CohortRow, "id" | "name" | "code"> | null, since: Date): Promise<CohortStats> {
  const where = cohort ? "cohort_id = $2" : "TRUE";
  const args = cohort ? [since, cohort.id] : [since];
  const [cat, st, urgent, resolved, open, tags] = await Promise.all([
    db.query<{ k: string; n: string }>(`SELECT category k, count(*) n FROM triage_events WHERE created_at >= $1 AND ${where} GROUP BY 1`, args),
    db.query<{ k: string; n: string }>(`SELECT status k, count(*) n FROM triage_events WHERE created_at >= $1 AND ${where} GROUP BY 1`, args),
    db.query<{ n: string }>(
      `SELECT count(*) n FROM triage_events WHERE created_at >= $1 AND ${where} AND (severity IN ('high','critical') OR category='abusive')`,
      args,
    ),
    db.query<{ n: string }>(`SELECT count(*) n FROM triage_events WHERE resolved_at >= $1 AND ${where}`, args),
    db.query(
      `SELECT id, category, severity, summary, ${URL_SQL} AS url, ticket_url, created_at FROM triage_events
       WHERE status IN ('open','in_progress') AND ${cohort ? "cohort_id = $1" : "TRUE"}
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at LIMIT 15`,
      cohort ? [cohort.id] : [],
    ),
    db.query<{ k: string; n: string }>(
      `SELECT tag k, count(*) n FROM hashtag_events WHERE created_at >= $1 AND ${where} GROUP BY 1 ORDER BY 2 DESC`,
      args,
    ),
  ]);
  const toMap = (rows: { k: string; n: string }[]) => Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
  const byCategory = toMap(cat.rows);
  const hashtags = toMap(tags.rows);
  return {
    cohort: cohort ? cohortLabel(cohort) : "All cohorts",
    cohort_id: cohort?.id ?? null,
    since: since.toISOString(),
    flagged: Object.values(byCategory).reduce((a, b) => a + b, 0),
    by_category: byCategory,
    by_status: toMap(st.rows),
    urgent_or_abusive: Number(urgent.rows[0].n),
    resolved_in_period: Number(resolved.rows[0].n),
    still_open: open.rows.map((r: any) => ({ ...r, id: String(r.id), created_at: new Date(r.created_at).toISOString() })),
    hashtags,
    wins: hashtags.win ?? 0,
  };
}

const nice = (s: string) => s.replace(/_/g, " ");

export function renderRecap(title: string, stats: CohortStats[]): { text: string; html: string } {
  const text: string[] = [];
  const html: string[] = [];
  for (const s of stats) {
    const cats = Object.entries(s.by_category).map(([k, n]) => `${nice(k)} ${n}`).join(", ") || "none";
    const tags = Object.entries(s.hashtags).slice(0, 8).map(([k, n]) => `#${k} ${n}`).join(", ") || "none";
    text.push(
      `${s.cohort}\n` +
        `  Flagged this week: ${s.flagged} (${cats})\n` +
        `  Urgent or conduct: ${s.urgent_or_abusive} · Resolved this week: ${s.resolved_in_period} · Still open: ${s.still_open.length}\n` +
        `  Hashtags: ${tags}\n` +
        s.still_open.map((o) => `  - [${o.severity}] ${o.summary} ${o.ticket_url ?? o.url}`).join("\n"),
    );
    html.push(
      `<h3 style="margin:20px 0 8px;font-size:15px">${escapeHtml(s.cohort)}</h3>` +
        `<table style="border-collapse:collapse;font-size:13px;margin-bottom:8px">` +
        [
          ["Flagged this week", `${s.flagged} (${cats})`],
          ["Urgent or conduct", String(s.urgent_or_abusive)],
          ["Resolved this week", String(s.resolved_in_period)],
          ["Still open", String(s.still_open.length)],
          ["Hashtags", tags],
        ]
          .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#6e6e73">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
          .join("") +
        `</table>` +
        (s.still_open.length
          ? `<ul style="margin:0;padding-left:18px;font-size:13px">` +
            s.still_open
              .map(
                (o) =>
                  `<li style="margin-bottom:4px"><b>${escapeHtml(o.severity)}</b> · ${escapeHtml(o.summary)} — <a href="${escapeHtml(o.ticket_url ?? o.url)}">${o.ticket_url ? "Wrike" : "Discord"}</a></li>`,
              )
              .join("") +
            `</ul>`
          : ""),
    );
  }
  return { text: `${title}\n\n${text.join("\n\n")}`, html: emailHtml(title, html.join("")) };
}

export interface RecapOutcome {
  cohort: string;
  recipients: number;
  status: SendResult["status"] | "skipped";
  error?: string;
}

/** One email per cohort (to its notify list) + one program-wide email (to PROGRAM_EMAILS). */
export async function sendWeeklyRecaps(
  db: Db,
  mailer: Mailer,
  programEmails: string[],
  opts: { cohortIds?: string[]; days?: number; now?: Date } = {},
): Promise<RecapOutcome[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 7) * 864e5);
  const { rows: cohorts } = await db.query<CohortRow>(
    `SELECT * FROM cohorts ${opts.cohortIds?.length ? "WHERE id = ANY($1)" : ""} ORDER BY COALESCE(code, name)`,
    opts.cohortIds?.length ? [opts.cohortIds] : [],
  );
  const week = since.toISOString().slice(0, 10);
  const out: RecapOutcome[] = [];
  const all: CohortStats[] = [];
  for (const c of cohorts) {
    const s = await cohortStats(db, c, since);
    all.push(s);
    if (!c.notify_emails.length) {
      out.push({ cohort: s.cohort, recipients: 0, status: "skipped" });
      continue;
    }
    const subject = `Weekly recap · ${s.cohort} · week of ${week}`;
    const body = renderRecap(subject, [s]);
    const r = await mailer.send({ kind: "weekly_recap", to: c.notify_emails, subject, ...body, cohortId: c.id, logRecipients: true });
    out.push({ cohort: s.cohort, recipients: r.recipient_count, status: r.status, error: r.error });
  }
  if (programEmails.length && !opts.cohortIds?.length) {
    const subject = `Weekly recap · all cohorts · week of ${week}`;
    const body = renderRecap(subject, [await cohortStats(db, null, since), ...all]);
    const r = await mailer.send({ kind: "weekly_recap", to: programEmails, subject, ...body, logRecipients: true });
    out.push({ cohort: "All cohorts", recipients: r.recipient_count, status: r.status, error: r.error });
  }
  return out;
}

/** True when the cron's most recent occurrence is after the job's last run (so it is due now). */
export async function claimDueJob(db: Db, job: string, cron: string, tz: string, now = new Date()): Promise<boolean> {
  const prev = CronExpressionParser.parse(cron, { currentDate: now, tz }).prev().toDate();
  const { rows } = await db.query<{ last_run: Date }>("SELECT last_run FROM job_runs WHERE job=$1", [job]);
  if (!rows[0]) {
    // First start: don't fire for an occurrence that passed before the service existed.
    await db.query("INSERT INTO job_runs (job, last_run) VALUES ($1, $2) ON CONFLICT (job) DO NOTHING", [job, now]);
    return false;
  }
  if (rows[0].last_run >= prev) return false;
  const claimed = await db.query("UPDATE job_runs SET last_run=$2 WHERE job=$1 AND last_run=$3", [job, now, rows[0].last_run]);
  return (claimed.rowCount ?? 0) > 0;
}
