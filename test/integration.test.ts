/**
 * End-to-end over real HTTP + real Postgres, with a fake Discord client.
 * Requires TEST_DATABASE_URL (skipped otherwise). The database is wiped.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPool, type Db } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { createHttpApp } from "../src/http.js";
import { buildMcpServer } from "../src/mcp/tools.js";
import { runDueMessages } from "../src/scheduler/runner.js";
import { createTriage } from "../src/triage/pipeline.js";
import type { DiscordCtx } from "../src/discord/actions.js";
import { WrikeClient } from "../src/integrations/wrike.js";

const DB_URL = process.env.TEST_DATABASE_URL;
const KEY = "k".repeat(40);

// ---- fake Discord ----
const sent: { channel: string; payload: any }[] = [];
const deleted: string[] = [];
function fakeChannel(id: string): any {
  return {
    id,
    guildId: "555555",
    isTextBased: () => true,
    isSendable: () => true,
    isThread: () => false,
    send: async (payload: any) => {
      sent.push({ channel: id, payload });
      return { id: String(Date.now()), url: `https://discord.com/channels/555555/${id}/1`, channelId: id };
    },
    messages: {
      fetch: async (arg: any) =>
        typeof arg === "string"
          ? { id: arg, delete: async () => void deleted.push(arg) }
          : new Map(),
    },
  };
}
const fakeClient: any = {
  isReady: () => true,
  user: { id: "1" },
  channels: { fetch: async (id: string) => (id === "404404" ? null : fakeChannel(id)) },
  users: { fetch: async (id: string) => ({ send: async (p: any) => void sent.push({ channel: `dm:${id}`, payload: p }) }) },
};
const ctx: DiscordCtx = { client: fakeClient, allowedGuildIds: ["555555"] };

describe.skipIf(!DB_URL)("integration", () => {
  let db: Db;
  let http: Server;
  let mcp: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await mcp.callTool({ name, arguments: args });
    const text = r.content[0].text as string;
    return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
  };

  beforeAll(async () => {
    db = createPool(DB_URL!, false);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(db, () => {});
    await runMigrations(db, () => {}); // idempotent

    const app = createHttpApp({
      apiKey: KEY,
      makeServer: () => buildMcpServer({ db, ctx, requireApproval: true, defaultTimezone: "America/Toronto" }),
      health: async () => ({ ok: true }),
    });
    http = app.listen(0);
    const port = (http.address() as AddressInfo).port;
    mcp = new Client({ name: "test", version: "1" });
    // Path-style key, as claude.ai custom connectors use.
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${KEY}`)));
  });

  afterAll(async () => {
    await mcp?.close();
    http?.close();
    await db?.end();
  });

  it("rejects requests without the key", async () => {
    const port = (http.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const bearer = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(bearer.status).toBe(200);
  });

  it("lists all tools", async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["read_messages", "send_message", "ban_member", "approve_action", "schedule_message", "upsert_cohort", "list_triage_events"]),
    );
    expect(tools.find((t) => t.name === "ban_member")?.annotations?.destructiveHint).toBe(true);
  });

  it("sends messages and validates IDs", async () => {
    const r = await call("send_message", { channel_id: "123456", content: "hello" });
    expect(r.isError).toBe(false);
    expect(sent.at(-1)).toMatchObject({ channel: "123456" });
    const bad = await call("send_message", { channel_id: "abc", content: "x" });
    expect(bad.isError).toBe(true);
    const missing = await call("send_message", { channel_id: "404404", content: "x" });
    expect(missing.text).toMatch(/not found/);
  });

  it("gates destructive actions behind approval", async () => {
    const r = await call("delete_message", { channel_id: "123456", message_id: "777777", reason: "spam" });
    expect(r.data.status).toBe("pending_approval");
    expect(deleted).toHaveLength(0);

    const pending = await call("list_pending_actions");
    expect(pending.data).toHaveLength(1);

    const approved = await call("approve_action", { pending_action_id: r.data.pending_action_id });
    expect(approved.isError).toBe(false);
    expect(deleted).toEqual(["777777"]);

    const again = await call("approve_action", { pending_action_id: r.data.pending_action_id });
    expect(again.text).toMatch(/already approved/);

    const r2 = await call("kick_member", { guild_id: "555555", user_id: "888888" });
    expect((await call("reject_action", { pending_action_id: r2.data.pending_action_id })).isError).toBe(false);
    expect((await call("approve_action", { pending_action_id: r2.data.pending_action_id })).text).toMatch(/already rejected/);
  });

  it("schedules, sends due messages, and cancels", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const one = await call("schedule_message", { channel_id: "222222", content: "one-off", send_at: soon });
    expect(one.isError).toBe(false);
    const rec = await call("schedule_message", { channel_id: "222222", content: "weekly", cron: "0 9 * * 1" });
    expect(rec.data.recurring).toBe(true);

    // Make both due now.
    await db.query("UPDATE scheduled_messages SET next_run_at = now() - interval '1 second'");
    const before = sent.length;
    expect(await runDueMessages(db, ctx, { error() {}, info() {} } as any)).toBe(2);
    expect(sent.slice(before).map((s) => s.payload.content).sort()).toEqual(["one-off", "weekly"]);

    const list = await call("list_scheduled_messages");
    expect(list.data).toHaveLength(1); // one-off deactivated, recurring rescheduled
    expect(new Date(list.data[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect((await call("cancel_scheduled_message", { id: list.data[0].id })).isError).toBe(false);
    expect(await runDueMessages(db, ctx)).toBe(0);
  });

  it("stores cohorts with partial updates", async () => {
    await call("upsert_cohort", {
      name: "Cohort 1",
      channel_ids: ["100100"],
      alert_channel_id: "300300",
      facilitator_user_ids: ["400400"],
      wrike_folder_id: "IEABFOLDER",
      wrike_assignee_ids: ["KUAFAC"],
    });
    const upd = await call("upsert_cohort", { name: "Cohort 1", category_ids: ["900900"] });
    expect(upd.data.channel_ids).toEqual(["100100"]);
    expect(upd.data.category_ids).toEqual(["900900"]);
    expect((await call("list_cohorts")).data).toHaveLength(1);
  });

  it("triages a message end to end: classify → route → store → alert", async () => {
    const wrikeCalls: URL[] = [];
    const wrike = new WrikeClient({ token: "t", host: "www.wrike.com" }, (async (url: URL) => {
      wrikeCalls.push(url);
      return new Response(JSON.stringify({ data: [{ id: "IEABTASK1", permalink: "https://www.wrike.com/open.htm?id=9" }] }));
    }) as unknown as typeof fetch);
    const triage = createTriage({
      db,
      ctx,
      wrike,
      classify: async (input) =>
        input.content.includes("idiot")
          ? { category: "abusive", severity: "high", needs_human: true, summary: "Insult aimed at a peer." }
          : { category: "none", severity: "low", needs_human: false, summary: "" },
      minChars: 15,
      concurrency: 1,
      log: { info() {}, error() {} },
    });
    const msg = (id: string, content: string): any => ({
      id,
      content,
      guildId: "555555",
      channelId: "100100",
      url: `https://discord.com/channels/555555/100100/${id}`,
      createdAt: new Date(),
      author: { id: "600600", username: "learner", bot: false },
      member: { displayName: "Learner", roles: { cache: new Map() } },
      channel: { id: "100100", name: "cohort-1-general", parentId: "900900", isThread: () => false, messages: { fetch: async () => new Map() } },
    });

    const before = sent.length;
    await triage._process(msg("990001", "thanks everyone, see you next week"));
    await triage._process(msg("990002", "you are an idiot"));
    await triage._process(msg("990002", "you are an idiot")); // duplicate delivery is ignored

    const events = await call("list_triage_events", { cohort: "Cohort 1", min_severity: "medium" });
    expect(events.data).toHaveLength(1);
    expect(events.data[0]).toMatchObject({
      category: "abusive",
      severity: "high",
      cohort: "Cohort 1",
      alerted: true,
      ticket_id: "IEABTASK1",
      ticket_url: "https://www.wrike.com/open.htm?id=9",
    });
    expect(wrikeCalls.map((u) => u.pathname)).toEqual(["/api/v4/folders/IEABFOLDER/tasks"]);

    const alerts = sent.slice(before);
    expect(alerts.map((a) => a.channel).sort()).toEqual(["300300", "dm:400400"]); // alert channel + facilitator DM
    expect((await call("update_triage_event", { id: events.data[0].id, status: "resolved" })).isError).toBe(false);
  });
});
