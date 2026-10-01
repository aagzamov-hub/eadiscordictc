import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []));

const schema = z.object({
  // Discord
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().optional(),
  /** Optional allowlist: the bot refuses to act in any other server. */
  DISCORD_GUILD_IDS: csv,

  // Storage
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: bool(false),
  RUN_MIGRATIONS: bool(true),

  // HTTP / MCP
  PORT: z.coerce.number().int().default(3000),
  MCP_API_KEY: z.string().min(24, "MCP_API_KEY must be at least 24 characters"),
  /** Destructive tools (delete, kick, ban, delete channel) wait for approve_action. */
  REQUIRE_APPROVAL: bool(true),

  DEFAULT_TIMEZONE: z.string().default("America/Toronto"),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),

  // Triage
  TRIAGE_ENABLED: bool(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  TRIAGE_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  TRIAGE_MIN_CHARS: z.coerce.number().int().default(15),
  TRIAGE_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  /** Fallback channel for alerts when a message's cohort has no alert channel. */
  FACILITATOR_ALERT_CHANNEL_ID: z.string().optional(),

  // Wrike tickets — optional
  WRIKE_ENABLED: bool(false),
  WRIKE_ACCESS_TOKEN: z.string().optional(),
  /** API host for your Wrike data centre, e.g. www.wrike.com, app-us2.wrike.com, app-eu.wrike.com */
  WRIKE_API_HOST: z.string().default("www.wrike.com"),
  /** Optional Wrike custom field IDs, filled on every ticket when set. */
  WRIKE_FIELD_COHORT: z.string().optional(),
  WRIKE_FIELD_TICKET_TYPE: z.string().optional(),
  WRIKE_FIELD_SOURCE_TAG: z.string().optional(),
  /** How often to pull ticket status back from Wrike (Done in Wrike → resolved here). */
  WRIKE_SYNC_MINUTES: z.coerce.number().int().min(1).default(10),

  // Hashtags & engagement
  /** Store which learner used which hashtag (per-learner engagement). Off = cohort-level counts only. */
  TRACK_LEARNER_ACTIVITY: bool(false),

  // Email (SendGrid). Without SENDGRID_API_KEY every email is a preview: rendered and logged, never sent.
  SENDGRID_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default("eLearning Pathways"),
  /** Program-wide recipients: critical alerts for every cohort + the all-cohorts weekly recap. */
  PROGRAM_EMAILS: csv,
  /** When the weekly recap goes out (cron, DEFAULT_TIMEZONE). Default Monday 8:00. */
  RECAP_CRON: z.string().default("0 8 * * 1"),
  RECAP_ENABLED: bool(true),
});

export type Config = z.infer<typeof schema>;

/** On Platform.sh/Upsun, build DATABASE_URL from the "database" relationship if it isn't set explicitly. */
export function platformDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.PLATFORM_RELATIONSHIPS) return undefined;
  const rels = JSON.parse(Buffer.from(env.PLATFORM_RELATIONSHIPS, "base64").toString("utf8"));
  const db = rels.database?.[0];
  if (!db) return undefined;
  const auth = `${encodeURIComponent(db.username)}:${encodeURIComponent(db.password ?? "")}`;
  return `postgresql://${auth}@${db.host}:${db.port}/${db.path}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.DATABASE_URL) {
    const derived = platformDatabaseUrl(env);
    if (derived) env = { ...env, DATABASE_URL: derived };
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.TRIAGE_ENABLED && !cfg.ANTHROPIC_API_KEY) {
    throw new Error("TRIAGE_ENABLED=true requires ANTHROPIC_API_KEY");
  }
  if (cfg.WRIKE_ENABLED && !cfg.WRIKE_ACCESS_TOKEN) {
    throw new Error("WRIKE_ENABLED=true requires WRIKE_ACCESS_TOKEN");
  }
  if (cfg.SENDGRID_API_KEY && !cfg.EMAIL_FROM) {
    throw new Error("SENDGRID_API_KEY requires EMAIL_FROM (a SendGrid-verified sender address)");
  }
  return cfg;
}
