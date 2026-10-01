export interface CohortRow {
  id: string;
  name: string;
  code: string | null;
  guild_id: string | null;
  channel_ids: string[];
  category_ids: string[];
  role_ids: string[];
  facilitator_user_ids: string[];
  alert_channel_id: string | null;
  announcement_channel_id: string | null;
  notify_emails: string[];
  wrike_folder_id: string | null;
  wrike_assignee_ids: string[];
}

export interface MessagePlace {
  guildId: string | null;
  channelId: string;
  /** For a thread: the channel the thread lives in. */
  parentChannelId: string | null;
  /** Discord category of the channel (or of the thread's parent). */
  categoryId: string | null;
  authorRoleIds: string[];
}

/**
 * Most specific match wins: exact channel > parent channel (threads) > Discord category > author's role > whole server.
 * With one server per cohort, the server match alone is enough; the finer matches support shared servers.
 */
export function matchCohort(cohorts: CohortRow[], place: MessagePlace): CohortRow | null {
  const by = (pred: (c: CohortRow) => boolean) => cohorts.find(pred) ?? null;
  return (
    by((c) => c.channel_ids.includes(place.channelId)) ??
    (place.parentChannelId ? by((c) => c.channel_ids.includes(place.parentChannelId!)) : null) ??
    (place.categoryId ? by((c) => c.category_ids.includes(place.categoryId!)) : null) ??
    by((c) => c.role_ids.some((r) => place.authorRoleIds.includes(r))) ??
    (place.guildId ? by((c) => c.guild_id === place.guildId) : null)
  );
}

/** Display label: "C04 · Cohort 04" style when a code is set. */
export const cohortLabel = (c: Pick<CohortRow, "name" | "code">) => (c.code && c.code !== c.name ? `${c.code} · ${c.name}` : c.name);
