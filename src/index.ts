import { Events } from "discord.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { createDiscordClient } from "./discord/client.js";
import type { DiscordCtx } from "./discord/actions.js";
import { buildMcpServer } from "./mcp/tools.js";
import { createHttpApp } from "./http.js";
import { startScheduler } from "./scheduler/runner.js";
import { createAnthropicClassifier } from "./triage/classifier.js";
import { createTriage } from "./triage/pipeline.js";
import { WrikeClient } from "./integrations/wrike.js";

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL, cfg.DATABASE_SSL);
if (cfg.RUN_MIGRATIONS) await runMigrations(db);

const client = createDiscordClient();
const ctx: DiscordCtx = { client, allowedGuildIds: cfg.DISCORD_GUILD_IDS };

const wrike = cfg.WRIKE_ENABLED ? new WrikeClient({ token: cfg.WRIKE_ACCESS_TOKEN!, host: cfg.WRIKE_API_HOST }) : undefined;

let triage: ReturnType<typeof createTriage> | undefined;
if (cfg.TRIAGE_ENABLED) {
  triage = createTriage({
    db,
    ctx,
    classify: createAnthropicClassifier(cfg.ANTHROPIC_API_KEY!, cfg.TRIAGE_MODEL),
    wrike,
    minChars: cfg.TRIAGE_MIN_CHARS,
    concurrency: cfg.TRIAGE_CONCURRENCY,
    fallbackAlertChannelId: cfg.FACILITATOR_ALERT_CHANNEL_ID,
  });
  client.on(Events.MessageCreate, (m) => triage!.onMessage(m));
}

client.once(Events.ClientReady, (c) => {
  console.info(`discord: logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s); triage ${cfg.TRIAGE_ENABLED ? "on" : "off"}`);
});
client.on(Events.Error, (err) => console.error("discord error:", err));

const app = createHttpApp({
  apiKey: cfg.MCP_API_KEY,
  makeServer: () =>
    buildMcpServer({
      db,
      ctx,
      requireApproval: cfg.REQUIRE_APPROVAL,
      defaultTimezone: cfg.DEFAULT_TIMEZONE,
      wrike,
      onTriageConfigChanged: () => triage?.invalidate(),
    }),
  health: async () => {
    const dbOk = await db.query("SELECT 1").then(() => true, () => false);
    return { ok: dbOk && client.isReady(), discord: client.isReady(), database: dbOk, triage: cfg.TRIAGE_ENABLED };
  },
});

const httpServer = app.listen(cfg.PORT, () => console.info(`http: listening on :${cfg.PORT}`));
const stopScheduler = startScheduler(db, ctx, cfg.SCHEDULER_INTERVAL_SECONDS);
try {
  await client.login(cfg.DISCORD_TOKEN);
} catch (err) {
  console.error(`discord: login failed — check DISCORD_TOKEN and that the bot's privileged intents are enabled. ${(err as Error).message}`);
  process.exit(1);
}

async function shutdown(signal: string) {
  console.info(`${signal} received, shutting down`);
  stopScheduler();
  httpServer.close();
  await client.destroy();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
