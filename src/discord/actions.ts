import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type TextBasedChannel,
} from "discord.js";

export class ToolError extends Error {}

export interface DiscordCtx {
  client: Client;
  allowedGuildIds: string[];
}

// ---------- helpers ----------

export function assertReady(ctx: DiscordCtx) {
  if (!ctx.client.isReady()) throw new ToolError("Discord bot is not connected yet. Try again in a moment.");
}

export function assertGuildAllowed(ctx: DiscordCtx, guildId: string | null | undefined) {
  if (guildId && ctx.allowedGuildIds.length && !ctx.allowedGuildIds.includes(guildId)) {
    throw new ToolError(`Server ${guildId} is not in DISCORD_GUILD_IDS; refusing to act there.`);
  }
}

export async function getGuild(ctx: DiscordCtx, guildId: string): Promise<Guild> {
  assertReady(ctx);
  assertGuildAllowed(ctx, guildId);
  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new ToolError(`Bot is not in server ${guildId}.`);
  return guild;
}

type SendableChannel = TextBasedChannel & { send: Function; messages: any };

export async function getTextChannel(ctx: DiscordCtx, channelId: string): Promise<SendableChannel> {
  assertReady(ctx);
  const ch = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!ch) throw new ToolError(`Channel ${channelId} not found or not visible to the bot.`);
  if ("guildId" in ch) assertGuildAllowed(ctx, (ch as GuildBasedChannel).guildId);
  if (!ch.isTextBased() || !("send" in ch)) throw new ToolError(`Channel ${channelId} is not a text channel.`);
  return ch as SendableChannel;
}

export function messageLink(m: Message): string {
  return m.url;
}

export function serializeMessage(m: Message) {
  return {
    id: m.id,
    channel_id: m.channelId,
    author: { id: m.author.id, name: m.member?.displayName ?? m.author.username, bot: m.author.bot },
    content: m.content,
    created_at: m.createdAt.toISOString(),
    edited_at: m.editedAt?.toISOString() ?? null,
    reply_to: m.reference?.messageId ?? null,
    attachments: [...m.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
    reactions: [...m.reactions.cache.values()].map((r) => ({ emoji: r.emoji.toString(), count: r.count })),
    thread_id: m.thread?.id ?? null,
    url: m.url,
  };
}

const TEXT_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
]);

// ---------- reads ----------

export async function listServers(ctx: DiscordCtx) {
  assertReady(ctx);
  return [...ctx.client.guilds.cache.values()]
    .filter((g) => !ctx.allowedGuildIds.length || ctx.allowedGuildIds.includes(g.id))
    .map((g) => ({ id: g.id, name: g.name, member_count: g.memberCount }));
}

export async function listChannels(ctx: DiscordCtx, guildId: string) {
  const guild = await getGuild(ctx, guildId);
  const channels = await guild.channels.fetch();
  return [...channels.values()]
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: ChannelType[c.type],
      category_id: c.parentId,
      category: c.parent?.name ?? null,
    }));
}

export async function listThreads(ctx: DiscordCtx, guildId: string) {
  const guild = await getGuild(ctx, guildId);
  const { threads } = await guild.channels.fetchActiveThreads();
  return [...threads.values()].map((t) => ({
    id: t.id,
    name: t.name,
    parent_id: t.parentId,
    message_count: t.messageCount,
    archived: t.archived,
  }));
}

export async function readMessages(
  ctx: DiscordCtx,
  channelId: string,
  opts: { limit?: number; before?: string; after?: string },
) {
  const ch = await getTextChannel(ctx, channelId);
  const msgs = await ch.messages.fetch({ limit: Math.min(opts.limit ?? 50, 100), before: opts.before, after: opts.after });
  return [...msgs.values()].sort((a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp).map(serializeMessage);
}

/** Scans recent history (Discord bots have no server-side search API) and filters by text. */
export async function searchMessages(
  ctx: DiscordCtx,
  opts: { guild_id: string; query: string; channel_ids?: string[]; per_channel_scan?: number; author_id?: string },
) {
  const guild = await getGuild(ctx, opts.guild_id);
  const scan = Math.min(opts.per_channel_scan ?? 200, 1000);
  let channelIds = opts.channel_ids;
  if (!channelIds?.length) {
    const all = await guild.channels.fetch();
    channelIds = [...all.values()].filter((c) => c && TEXT_TYPES.has(c.type)).map((c) => c!.id);
    const { threads } = await guild.channels.fetchActiveThreads();
    channelIds.push(...threads.keys());
  }
  const q = opts.query.toLowerCase();
  const hits: ReturnType<typeof serializeMessage>[] = [];
  for (const id of channelIds) {
    let ch: SendableChannel;
    try {
      ch = await getTextChannel(ctx, id);
    } catch {
      continue;
    }
    let before: string | undefined;
    let scanned = 0;
    while (scanned < scan) {
      const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;
      for (const m of batch.values() as Iterable<Message>) {
        if (opts.author_id && m.author.id !== opts.author_id) continue;
        if (m.content.toLowerCase().includes(q)) hits.push(serializeMessage(m));
      }
      scanned += batch.size;
      before = batch.last()?.id;
      if (batch.size < 100) break;
    }
    if (hits.length >= 100) break;
  }
  return hits.slice(0, 100);
}

export async function listMembers(ctx: DiscordCtx, guildId: string, query?: string, limit = 100) {
  const guild = await getGuild(ctx, guildId);
  const members = query
    ? await guild.members.search({ query, limit: Math.min(limit, 1000) })
    : await guild.members.list({ limit: Math.min(limit, 1000) });
  return [...members.values()].map((m) => ({
    id: m.id,
    username: m.user.username,
    display_name: m.displayName,
    bot: m.user.bot,
    roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => ({ id: r.id, name: r.name })),
    joined_at: m.joinedAt?.toISOString() ?? null,
    timed_out_until: m.communicationDisabledUntil?.toISOString() ?? null,
  }));
}

export async function listRoles(ctx: DiscordCtx, guildId: string) {
  const guild = await getGuild(ctx, guildId);
  const roles = await guild.roles.fetch();
  return [...roles.values()]
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, position: r.position, member_count: r.members.size, managed: r.managed }));
}

// ---------- writes (immediate) ----------

export async function sendMessage(ctx: DiscordCtx, channelId: string, content: string, replyTo?: string) {
  const ch = await getTextChannel(ctx, channelId);
  const m: Message = await ch.send({ content, reply: replyTo ? { messageReference: replyTo } : undefined });
  return { id: m.id, url: m.url };
}

export async function editMessage(ctx: DiscordCtx, channelId: string, messageId: string, content: string) {
  const ch = await getTextChannel(ctx, channelId);
  const m: Message = await ch.messages.fetch(messageId);
  if (m.author.id !== ctx.client.user!.id) throw new ToolError("Bots can only edit their own messages.");
  await m.edit(content);
  return { id: m.id, url: m.url };
}

export async function react(ctx: DiscordCtx, channelId: string, messageId: string, emoji: string) {
  const ch = await getTextChannel(ctx, channelId);
  const m: Message = await ch.messages.fetch(messageId);
  await m.react(emoji);
  return { ok: true };
}

export async function setPinned(ctx: DiscordCtx, channelId: string, messageId: string, pinned: boolean) {
  const ch = await getTextChannel(ctx, channelId);
  const m: Message = await ch.messages.fetch(messageId);
  if (pinned) await m.pin();
  else await m.unpin();
  return { ok: true };
}

export async function createThread(
  ctx: DiscordCtx,
  channelId: string,
  name: string,
  opts: { message_id?: string; private?: boolean; first_message?: string },
) {
  const ch = await getTextChannel(ctx, channelId);
  let thread;
  if (opts.message_id) {
    const m: Message = await ch.messages.fetch(opts.message_id);
    thread = await m.startThread({ name });
  } else {
    if (!("threads" in ch)) throw new ToolError("This channel does not support threads.");
    thread = await (ch as any).threads.create({
      name,
      type: opts.private ? ChannelType.PrivateThread : ChannelType.PublicThread,
    });
  }
  if (opts.first_message) await thread.send(opts.first_message);
  return { id: thread.id, name: thread.name, url: thread.url };
}

export async function createChannel(
  ctx: DiscordCtx,
  guildId: string,
  name: string,
  opts: {
    category_id?: string;
    topic?: string;
    kind?: "text" | "announcement" | "category";
    private?: boolean;
    allow_role_ids?: string[];
    allow_user_ids?: string[];
  },
) {
  const guild = await getGuild(ctx, guildId);
  const type =
    opts.kind === "category"
      ? ChannelType.GuildCategory
      : opts.kind === "announcement"
        ? ChannelType.GuildAnnouncement
        : ChannelType.GuildText;
  // Private: hidden from @everyone; visible to the bot plus the listed roles/users.
  const see = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  const permissionOverwrites = opts.private
    ? [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: ctx.client.user!.id, allow: see },
        ...(opts.allow_role_ids ?? []).map((id) => ({ id, allow: see })),
        ...(opts.allow_user_ids ?? []).map((id) => ({ id, allow: see })),
      ]
    : undefined;
  const ch = await guild.channels.create({
    name,
    type,
    parent: opts.category_id,
    topic: opts.topic,
    permissionOverwrites,
  } as any);
  return { id: ch.id, name: ch.name, private: !!opts.private };
}

export async function createRole(
  ctx: DiscordCtx,
  guildId: string,
  name: string,
  opts: { color?: string; mentionable?: boolean; hoist?: boolean },
) {
  const guild = await getGuild(ctx, guildId);
  const role = await guild.roles.create({
    name,
    color: opts.color ? (parseInt(opts.color.replace("#", ""), 16) as any) : undefined,
    mentionable: opts.mentionable ?? false,
    hoist: opts.hoist ?? false,
    permissions: [], // cohort/facilitator roles are labels; channel access comes from channel permissions
  });
  return { id: role.id, name: role.name };
}

export async function sendDm(ctx: DiscordCtx, userId: string, content: string) {
  assertReady(ctx);
  const user = await ctx.client.users.fetch(userId);
  const m = await user.send(content);
  return { id: m.id, channel_id: m.channelId };
}

export async function changeRole(ctx: DiscordCtx, guildId: string, userId: string, roleId: string, add: boolean) {
  const guild = await getGuild(ctx, guildId);
  const member = await guild.members.fetch(userId);
  if (add) await member.roles.add(roleId);
  else await member.roles.remove(roleId);
  return { ok: true };
}

export async function timeoutMember(ctx: DiscordCtx, guildId: string, userId: string, minutes: number, reason?: string) {
  const guild = await getGuild(ctx, guildId);
  const member = await guild.members.fetch(userId);
  await member.timeout(minutes > 0 ? minutes * 60_000 : null, reason);
  return { ok: true, until: member.communicationDisabledUntil?.toISOString() ?? null };
}

// ---------- destructive (run only via approval when REQUIRE_APPROVAL=true) ----------

export const destructiveActions = {
  async delete_message(ctx: DiscordCtx, p: { channel_id: string; message_id: string; reason?: string }) {
    const ch = await getTextChannel(ctx, p.channel_id);
    const m: Message = await ch.messages.fetch(p.message_id);
    await m.delete();
    return { ok: true };
  },
  async kick_member(ctx: DiscordCtx, p: { guild_id: string; user_id: string; reason?: string }) {
    const guild = await getGuild(ctx, p.guild_id);
    await guild.members.kick(p.user_id, p.reason);
    return { ok: true };
  },
  async ban_member(ctx: DiscordCtx, p: { guild_id: string; user_id: string; reason?: string; delete_message_days?: number }) {
    const guild = await getGuild(ctx, p.guild_id);
    await guild.members.ban(p.user_id, {
      reason: p.reason,
      deleteMessageSeconds: Math.min(p.delete_message_days ?? 0, 7) * 86400,
    });
    return { ok: true };
  },
  async unban_member(ctx: DiscordCtx, p: { guild_id: string; user_id: string; reason?: string }) {
    const guild = await getGuild(ctx, p.guild_id);
    await guild.members.unban(p.user_id, p.reason);
    return { ok: true };
  },
  async delete_channel(ctx: DiscordCtx, p: { channel_id: string; reason?: string }) {
    assertReady(ctx);
    const ch = await ctx.client.channels.fetch(p.channel_id);
    if (!ch || !("guildId" in ch)) throw new ToolError("Channel not found.");
    assertGuildAllowed(ctx, (ch as GuildBasedChannel).guildId);
    await (ch as GuildBasedChannel).delete(p.reason);
    return { ok: true };
  },
} as const;

export type DestructiveAction = keyof typeof destructiveActions;
