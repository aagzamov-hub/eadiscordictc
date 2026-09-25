import { CronExpressionParser } from "cron-parser";

export class ScheduleError extends Error {}

/** Next run strictly after `from` for a cron expression in the given IANA timezone. */
export function nextCronRun(cron: string, tz: string, from: Date = new Date()): Date {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz }).next().toDate();
  } catch (err) {
    throw new ScheduleError(`Invalid cron "${cron}": ${(err as Error).message}`);
  }
}

export function assertTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new ScheduleError(`Unknown timezone "${tz}". Use an IANA name like America/Toronto.`);
  }
}

/**
 * Resolve the first run time for a new schedule.
 * - `send_at` alone: one-off at that instant (ISO 8601; include an offset or Z).
 * - `cron` alone: recurring, first run at the next match.
 * - both: recurring, but not before `send_at`.
 */
export function firstRun(opts: { send_at?: string; cron?: string; timezone: string }, now = new Date()): Date {
  assertTimezone(opts.timezone);
  if (!opts.send_at && !opts.cron) throw new ScheduleError("Provide send_at (one-off) or cron (recurring).");
  let at: Date | undefined;
  if (opts.send_at) {
    at = new Date(opts.send_at);
    if (Number.isNaN(at.getTime())) throw new ScheduleError(`send_at "${opts.send_at}" is not a valid ISO date-time.`);
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(opts.send_at)) {
      throw new ScheduleError("send_at must include a timezone offset, e.g. 2026-10-01T09:00:00-04:00.");
    }
  }
  if (!opts.cron) {
    if (at!.getTime() < now.getTime() - 60_000) throw new ScheduleError("send_at is in the past.");
    return at!;
  }
  const base = at && at > now ? new Date(at.getTime() - 1000) : now;
  return nextCronRun(opts.cron, opts.timezone, base);
}
