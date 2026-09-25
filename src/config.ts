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

  // Microsoft Planner (Teams board) — optional
  PLANNER_ENABLED: bool(false),
  MS_TENANT_ID: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
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
  if (cfg.PLANNER_ENABLED && !(cfg.MS_TENANT_ID && cfg.MS_CLIENT_ID && cfg.MS_CLIENT_SECRET)) {
    throw new Error("PLANNER_ENABLED=true requires MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET");
  }
  return cfg;
}
