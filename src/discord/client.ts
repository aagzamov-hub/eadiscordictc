import { Client, GatewayIntentBits, Partials } from "discord.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers, // privileged: "Server Members Intent"
      GatewayIntentBits.MessageContent, // privileged: "Message Content Intent"
      GatewayIntentBits.DirectMessages, // DMs sent *to the bot* only
    ],
    partials: [Partials.Channel, Partials.Message],
    allowedMentions: { parse: ["users"] }, // never @everyone/@here/role pings unless explicitly added
  });
}
