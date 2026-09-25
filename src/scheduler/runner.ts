import type { Db } from "../db/pool.js";
import { sendMessage, type DiscordCtx } from "../discord/actions.js";
import { nextCronRun } from "./schedule.js";

const MAX_ONE_OFF_FAILURES = 3;

interface Row {
  id: string;
  channel_id: string;
  content: string;
  cron: string | null;
  timezone: string;
  fail_count: number;
}

/** Sends every due scheduled message once. Safe with multiple instances (row locks + SKIP LOCKED). */
export async function runDueMessages(db: Db, ctx: DiscordCtx, log = console): Promise<number> {
  if (!ctx.client.isReady()) return 0;
  let sent = 0;
  for (;;) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<Row>(
        `SELECT id, channel_id, content, cron, timezone, fail_count FROM scheduled_messages
         WHERE active AND next_run_at <= now() ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) {
        await client.query("COMMIT");
        return sent;
      }
      try {
        await sendMessage(ctx, row.channel_id, row.content);
        sent++;
        if (row.cron) {
          const next = nextCronRun(row.cron, row.timezone);
          await client.query(
            "UPDATE scheduled_messages SET last_run_at=now(), next_run_at=$2, fail_count=0, last_error=NULL WHERE id=$1",
            [row.id, next],
          );
        } else {
          await client.query(
            "UPDATE scheduled_messages SET last_run_at=now(), active=FALSE, last_error=NULL WHERE id=$1",
            [row.id],
          );
        }
      } catch (err) {
        const msg = (err as Error).message;
        log.error(`scheduled message ${row.id} failed: ${msg}`);
        const fails = row.fail_count + 1;
        if (row.cron) {
          // Skip this occurrence; try again at the next one.
          const next = nextCronRun(row.cron, row.timezone);
          await client.query(
            "UPDATE scheduled_messages SET next_run_at=$2, fail_count=$3, last_error=$4 WHERE id=$1",
            [row.id, next, fails, msg],
          );
        } else {
          // Retry a one-off a few times, 2 minutes apart, then give up.
          await client.query(
            `UPDATE scheduled_messages SET fail_count=$2, last_error=$3,
               active = $2 < ${MAX_ONE_OFF_FAILURES}, next_run_at = now() + interval '2 minutes' WHERE id=$1`,
            [row.id, fails, msg],
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      log.error(`scheduler error: ${(err as Error).message}`);
      return sent;
    } finally {
      client.release();
    }
  }
}

export function startScheduler(db: Db, ctx: DiscordCtx, intervalSeconds: number, log = console): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await runDueMessages(db, ctx, log);
      if (n) log.info(`scheduler: sent ${n} message(s)`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalSeconds * 1000);
  void tick();
  return () => clearInterval(timer);
}
