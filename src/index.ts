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
import { createTriage, syncWrikeStatuses } from "./triage/pipeline.js";
import { WrikeClient } from "./integrations/wrike.js";
import { Mailer } from "./integrations/email.js";
import { claimDueJob, sendWeeklyRecaps } from "./reports/recap.js";

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL, cfg.DATABASE_SSL);
if (cfg.RUN_MIGRATIONS) await runMigrations(db);

const client = createDiscordClient();
const ctx: DiscordCtx = { client, allowedGuildIds: cfg.DISCORD_GUILD_IDS };

const wrike = cfg.WRIKE_ENABLED ? new WrikeClient({ token: cfg.WRIKE_ACCESS_TOKEN!, host: cfg.WRIKE_API_HOST }) : undefined;
const mailer = new Mailer(db, { apiKey: cfg.SENDGRID_API_KEY, from: cfg.EMAIL_FROM, fromName: cfg.EMAIL_FROM_NAME });

// Hashtags and staff tags always work; AI classification is added when TRIAGE_ENABLED.
const triage = createTriage({
  db,
  ctx,
  classify: cfg.TRIAGE_ENABLED ? createAnthropicClassifier(cfg.ANTHROPIC_API_KEY!, cfg.TRIAGE_MODEL) : undefined,
  wrike,
  wrikeFields: { cohort: cfg.WRIKE_FIELD_COHORT, ticketType: cfg.WRIKE_FIELD_TICKET_TYPE, sourceTag: cfg.WRIKE_FIELD_SOURCE_TAG },
  mailer,
  programEmails: cfg.PROGRAM_EMAILS,
  trackLearnerActivity: cfg.TRACK_LEARNER_ACTIVITY,
  minChars: cfg.TRIAGE_MIN_CHARS,
  concurrency: cfg.TRIAGE_CONCURRENCY,
  fallbackAlertChannelId: cfg.FACILITATOR_ALERT_CHANNEL_ID,
});
client.on(Events.MessageCreate, (m) => triage.onMessage(m));

client.once(Events.ClientReady, (c) => {
  console.info(
    `discord: logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s); ` +
      `AI triage ${cfg.TRIAGE_ENABLED ? "on" : "off"}, email ${mailer.previewMode ? "preview" : "live"}, wrike ${wrike ? "on" : "off"}`,
  );
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
      mailer,
      programEmails: cfg.PROGRAM_EMAILS,
      onTriageConfigChanged: () => triage.invalidate(),
    }),
  health: async () => {
    const dbOk = await db.query("SELECT 1").then(() => true, () => false);
    return {
      ok: dbOk && client.isReady(),
      discord: client.isReady(),
      database: dbOk,
      ai_triage: cfg.TRIAGE_ENABLED,
      email: mailer.previewMode ? "preview" : "live",
      wrike: !!wrike,
    };
  },
});

const httpServer = app.listen(cfg.PORT, () => console.info(`http: listening on :${cfg.PORT}`));
const stopScheduler = startScheduler(db, ctx, cfg.SCHEDULER_INTERVAL_SECONDS);

// Background jobs: weekly recap (cron) and Wrike status sync.
const timers: NodeJS.Timeout[] = [];
if (cfg.RECAP_ENABLED) {
  timers.push(
    setInterval(async () => {
      try {
        if (await claimDueJob(db, "weekly_recap", cfg.RECAP_CRON, cfg.DEFAULT_TIMEZONE)) {
          const r = await sendWeeklyRecaps(db, mailer, cfg.PROGRAM_EMAILS);
          console.info(`weekly recap: ${r.map((x) => `${x.cohort}=${x.status}`).join(", ") || "no cohorts"}`);
        }
      } catch (err) {
        console.error(`weekly recap failed: ${(err as Error).message}`);
      }
    }, 60_000),
  );
}
if (wrike) {
  timers.push(
    setInterval(async () => {
      const n = await syncWrikeStatuses(db, wrike);
      if (n) console.info(`wrike sync: ${n} ticket(s) closed from Wrike`);
    }, cfg.WRIKE_SYNC_MINUTES * 60_000),
  );
}

try {
  await client.login(cfg.DISCORD_TOKEN);
} catch (err) {
  console.error(`discord: login failed — check DISCORD_TOKEN and that the bot's privileged intents are enabled. ${(err as Error).message}`);
  process.exit(1);
}

async function shutdown(signal: string) {
  console.info(`${signal} received, shutting down`);
  stopScheduler();
  timers.forEach(clearInterval);
  httpServer.close();
  await client.destroy();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
