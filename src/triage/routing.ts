export interface CohortRow {
  id: string;
  name: string;
  channel_ids: string[];
  category_ids: string[];
  role_ids: string[];
  facilitator_user_ids: string[];
  alert_channel_id: string | null;
  wrike_folder_id: string | null;
  wrike_assignee_ids: string[];
}

export interface MessagePlace {
  channelId: string;
  /** For a thread: the channel the thread lives in. */
  parentChannelId: string | null;
  /** Discord category of the channel (or of the thread's parent). */
  categoryId: string | null;
  authorRoleIds: string[];
}

/**
 * Most specific match wins: exact channel > parent channel (threads) > Discord category > author's role.
 */
export function matchCohort(cohorts: CohortRow[], place: MessagePlace): CohortRow | null {
  const by = (pred: (c: CohortRow) => boolean) => cohorts.find(pred) ?? null;
  return (
    by((c) => c.channel_ids.includes(place.channelId)) ??
    (place.parentChannelId ? by((c) => c.channel_ids.includes(place.parentChannelId!)) : null) ??
    (place.categoryId ? by((c) => c.category_ids.includes(place.categoryId!)) : null) ??
    by((c) => c.role_ids.some((r) => place.authorRoleIds.includes(r)))
  );
}
