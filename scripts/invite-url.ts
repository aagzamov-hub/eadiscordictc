/**
 * Prints the invite link for the bot with exactly the permissions the connector uses (no Administrator).
 *   DISCORD_CLIENT_ID=123... npm run invite
 * Whoever opens the link needs "Manage Server" on the target server, and can only grant permissions they have.
 */
import { OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } from "discord.js";

const clientId = process.env.DISCORD_CLIENT_ID ?? process.argv[2];
if (!clientId) {
  console.error("Usage: DISCORD_CLIENT_ID=<application id> npm run invite");
  process.exit(1);
}

const perms = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.ManageMessages, // delete + pin
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ModerateMembers, // timeouts
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
]);

const url = new URL("https://discord.com/oauth2/authorize");
url.searchParams.set("client_id", clientId);
url.searchParams.set("scope", OAuth2Scopes.Bot);
url.searchParams.set("permissions", perms.bitfield.toString());

console.log(url.toString());
