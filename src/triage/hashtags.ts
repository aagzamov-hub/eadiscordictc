export interface HashtagRow {
  tag: string;
  action: "ticket" | "count" | "followup" | "escalate" | "resolve";
  category: string | null;
  min_severity: "low" | "medium" | "high" | "critical" | null;
  staff_only: boolean;
  description: string;
}

const TAG_RE = /(?:^|[\s(\[{,;:!?.])#([a-z0-9][a-z0-9_-]{1,31})\b/gi;

/** Hashtags in a message: lowercase, without '#', each once. Ignores Discord channel links (<#123>) and URLs. */
export function extractHashtags(content: string): string[] {
  const cleaned = content
    .replace(/<#\d+>/g, " ") // channel mentions
    .replace(/https?:\/\/\S+/g, " ") // URL fragments
    .replace(/```[\s\S]*?```|`[^`]*`/g, " "); // code
  const out = new Set<string>();
  for (const m of cleaned.matchAll(TAG_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

const ORDER = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof ORDER)[number];

export const maxSeverity = (a: Severity, b: Severity | null | undefined): Severity =>
  b && ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a;

/** The ticket-raising tag that should drive the ticket: highest min_severity wins. */
export function strongestTicketTag(tags: HashtagRow[]): HashtagRow | null {
  const tickets = tags.filter((t) => t.action === "ticket");
  if (!tickets.length) return null;
  return tickets.reduce((best, t) =>
    ORDER.indexOf(t.min_severity ?? "low") > ORDER.indexOf(best.min_severity ?? "low") ? t : best,
  );
}
