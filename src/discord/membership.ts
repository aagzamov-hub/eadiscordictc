import type { Guild, GuildMember } from "discord.js";
import { isEmail } from "../integrations/email.js";

export interface RosterRow {
  email: string;
  discord_username: string;
}

export interface MembershipReport {
  total: number;
  joined: { email: string; discord_username: string }[];
  not_joined: { email: string; discord_username: string }[];
  needs_review: { email: string; discord_username: string; reason: string }[];
  /** People in the server who are not on the list (staff, guests, or a username typed differently). */
  unlisted_members: number;
}

/** "@Jane.Doe#0" → "jane.doe": Discord usernames are lowercase, no spaces; old tags (#1234) are dropped. */
export function normalizeUsername(s: string): string {
  return s
    .trim()
    .replace(/^@+/, "")
    .replace(/#\d{1,4}$/, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Compares a de-identified roster (email + Discord username) with the members of one server. Nothing is stored. */
export function compareRoster(rows: RosterRow[], members: GuildMember[]): MembershipReport {
  const humans = members.filter((m) => !m.user.bot);
  const byUsername = new Map(humans.map((m) => [m.user.username.toLowerCase(), m]));
  const matched = new Set<string>();
  const report: MembershipReport = { total: rows.length, joined: [], not_joined: [], needs_review: [], unlisted_members: 0 };

  const seen = new Set<string>();
  for (const raw of rows) {
    const email = (raw.email ?? "").trim().toLowerCase();
    const typed = (raw.discord_username ?? "").trim();
    const row = { email, discord_username: typed };
    if (!isEmail(email)) {
      report.needs_review.push({ ...row, reason: "invalid or missing email" });
      continue;
    }
    if (seen.has(email)) {
      report.needs_review.push({ ...row, reason: "email appears more than once in the file" });
      continue;
    }
    seen.add(email);
    if (!typed) {
      report.needs_review.push({ ...row, reason: "no Discord username on file" });
      continue;
    }
    const exact = byUsername.get(normalizeUsername(typed));
    if (exact) {
      report.joined.push(row);
      matched.add(exact.id);
      continue;
    }
    // Not an exact username: maybe they gave their display name or server nickname.
    const key = loose(typed);
    const candidates = humans.filter(
      (m) =>
        !matched.has(m.id) &&
        key.length >= 3 &&
        [m.user.username, m.user.globalName ?? "", m.nickname ?? ""].some((n) => n && loose(n) === key),
    );
    if (candidates.length === 1) {
      const m = candidates[0];
      report.needs_review.push({
        ...row,
        reason: `probably joined as "${m.user.username}"${m.displayName !== m.user.username ? ` (shown as "${m.displayName}")` : ""}; username on file doesn't match exactly`,
      });
      matched.add(m.id);
    } else if (candidates.length > 1) {
      report.needs_review.push({ ...row, reason: `${candidates.length} members have a similar name; can't tell which` });
    } else {
      report.not_joined.push(row);
    }
  }
  report.unlisted_members = humans.filter((m) => !matched.has(m.id)).length;
  return report;
}

export async function checkMembership(guild: Guild, rows: RosterRow[]): Promise<MembershipReport> {
  const members = await guild.members.fetch(); // needs the Server Members intent
  return compareRoster(rows, [...members.values()]);
}

/** Parses pasted CSV text with a header row containing "email" and a Discord username column. */
export function parseRosterCsv(text: string): RosterRow[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l: string) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const ei = header.findIndex((h) => h.includes("email") || h.includes("e-mail") || h.includes("courriel"));
  const di = header.findIndex((h) => h.includes("discord") || h.includes("username") || h.includes("user name"));
  if (ei < 0 || di < 0) throw new Error(`CSV header must include an email column and a Discord username column (got: ${header.join(", ")})`);
  return lines.slice(1).map((l) => {
    const c = split(l);
    return { email: c[ei] ?? "", discord_username: c[di] ?? "" };
  });
}
