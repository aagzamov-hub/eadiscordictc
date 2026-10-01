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
import { Mailer } from "../src/integrations/email.js";
import { claimDueJob, sendWeeklyRecaps } from "../src/reports/recap.js";
import { syncWrikeStatuses } from "../src/triage/pipeline.js";

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
const guildMembers = new Map<string, any>([
  ["m1", { id: "m1", nickname: null, displayName: "jane.doe", user: { username: "jane.doe", globalName: null, bot: false } }],
  ["m2", { id: "m2", nickname: null, displayName: "Sam Lee", user: { username: "sam_99", globalName: "Sam Lee", bot: false } }],
]);
const fakeClient: any = {
  isReady: () => true,
  guilds: { fetch: async (gid: string) => ({ id: gid, members: { fetch: async () => guildMembers } }) },
  user: { id: "1" },
  channels: { fetch: async (id: string) => (id === "404404" ? null : fakeChannel(id)) },
  users: { fetch: async (id: string) => ({ send: async (p: any) => void sent.push({ channel: `dm:${id}`, payload: p }) }) },
};
const ctx: DiscordCtx = { client: fakeClient, allowedGuildIds: ["555555"] };

describe.skipIf(!DB_URL)("integration", () => {
  let db: Db;
  let http: Server;
  let mcp: Client;
  let mailer: Mailer;

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

    mailer = new Mailer(db, { fromName: "Test" }); // preview mode
    const app = createHttpApp({
      apiKey: KEY,
      makeServer: () =>
        buildMcpServer({ db, ctx, requireApproval: true, defaultTimezone: "America/Toronto", mailer, programEmails: ["lead@ictc.test"] }),
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
      react: async () => {},
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

  // ---------------- multi-server cohorts, hashtags, email, roster ----------------

  const learnerMsg = (id: string, content: string, opts: { channel?: string; thread?: boolean; author?: string; reference?: string; staff?: boolean } = {}): any => {
    const channelId = opts.channel ?? "700700";
    const reactions: string[] = [];
    const m: any = {
      id,
      content,
      guildId: "555555",
      channelId,
      url: `https://discord.com/channels/555555/${channelId}/${id}`,
      createdAt: new Date(),
      author: { id: opts.author ?? "610610", username: "learner2", bot: false },
      member: {
        displayName: opts.author === "400400" ? "Facilitator" : "Learner Two",
        roles: { cache: new Map() },
        permissions: { has: () => !!opts.staff },
      },
      reference: opts.reference ? { messageId: opts.reference } : undefined,
      channel: {
        id: channelId,
        name: "c07-help",
        parentId: opts.thread ? "700000" : null,
        parent: opts.thread ? { parentId: null } : undefined,
        isThread: () => !!opts.thread,
        messages: { fetch: async (x: any) => (typeof x === "string" ? learnerMsg(x, "original question", { channel: channelId, thread: opts.thread }) : new Map()) },
      },
      react: async (e: string) => void reactions.push(e),
      reactions,
    };
    return m;
  };

  it("cohorts can be whole servers, with codes, announcement channels and staff emails", async () => {
    const bad = await call("upsert_cohort", { name: "Cohort 07", notify_emails: ["not-an-email"] });
    expect(bad.text).toMatch(/Not valid email/);
    const c = await call("upsert_cohort", {
      name: "Cohort 07",
      code: "C07",
      guild_id: "555555",
      announcement_channel_id: "800800",
      notify_emails: ["Fac7@ICTC.test"],
      facilitator_user_ids: ["400400"],
      wrike_folder_id: "IEABC07",
    });
    expect(c.data).toMatchObject({ code: "C07", guild_id: "555555", notify_emails: ["fac7@ictc.test"] });
    await call("upsert_cohort", { name: "Cohort 08", code: "C08", guild_id: "566666", announcement_channel_id: "811811" });
  });

  it("schedules one post into several cohorts' announcement channels", async () => {
    const none = await call("schedule_message", { content: "x", send_at: new Date(Date.now() + 60_000).toISOString() });
    expect(none.text).toMatch(/either channel_id or cohorts/);
    const missing = await call("schedule_message", { cohorts: ["all"], content: "x", cron: "0 9 * * 1" });
    expect(missing.text).toMatch(/No announcement channel set for: Cohort 1/); // the older test cohort
    const r = await call("schedule_message", { cohorts: ["c07", "Cohort 08"], content: "Weekly check-in!", cron: "0 9 * * 1" });
    expect(r.data.scheduled.map((s: any) => [s.cohort, s.channel_id])).toEqual([["C07", "800800"], ["C08", "811811"]]);
    const unknown = await call("schedule_message", { cohorts: ["C99"], content: "x", cron: "0 9 * * 1" });
    expect(unknown.text).toMatch(/Unknown cohort "C99"/);
  });

  it("hashtags raise tickets without AI, group a thread into one ticket, and staff can resolve", async () => {
    const wrikeCalls: { method: string; path: string; body: URLSearchParams | null }[] = [];
    const wrike = new WrikeClient({ token: "t", host: "www.wrike.com" }, (async (url: URL, init: any) => {
      wrikeCalls.push({ method: init.method, path: url.pathname, body: init.body ?? null });
      return new Response(JSON.stringify({ data: [{ id: "IEABTASK7", permalink: "https://www.wrike.com/open.htm?id=7" }] }));
    }) as unknown as typeof fetch);
    const triage = createTriage({
      db,
      ctx,
      wrike,
      wrikeFields: { cohort: "CF_COHORT", ticketType: "CF_TYPE", sourceTag: "CF_TAG" },
      mailer,
      programEmails: ["lead@ictc.test"],
      minChars: 15,
      concurrency: 1,
      log: { info() {}, error() {} },
    });

    // A learner's #blocker in a thread → high-severity ticket, ✅ reaction, alert email.
    const first = learnerMsg("770001", "I can't submit lab 2, the upload button is broken #blocker #week2", { thread: true, channel: "701701" });
    await triage._process(first);
    expect(first.reactions).toEqual(["✅"]);
    const ev = (await call("list_triage_events", { cohort: "Cohort 07" })).data;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ category: "course_support", severity: "high", ticket_id: "IEABTASK7" });
    const create = wrikeCalls.find((c) => c.path === "/api/v4/folders/IEABC07/tasks")!;
    expect(JSON.parse(create.body!.get("customFields")!)).toEqual([
      { id: "CF_COHORT", value: "C07" },
      { id: "CF_TYPE", value: "Support" },
      { id: "CF_TAG", value: "#blocker" },
    ]);
    expect(create.body!.get("importance")).toBe("High");

    // A follow-up in the same thread becomes a Wrike comment, not a second ticket.
    await triage._process(learnerMsg("770002", "still broken, deadline is tomorrow #help", { thread: true, channel: "701701" }));
    expect((await call("list_triage_events", { cohort: "Cohort 07" })).data).toHaveLength(1);
    expect(wrikeCalls.some((c) => c.method === "POST" && c.path === "/api/v4/tasks/IEABTASK7/comments")).toBe(true);

    // #win is counted only; a learner using a staff tag does nothing.
    await triage._process(learnerMsg("770003", "Finished my capstone draft! #win #capstone"));
    await triage._process(learnerMsg("770004", "#resolved", { reference: "770001", thread: true, channel: "701701" }));
    expect((await call("list_triage_events", { cohort: "Cohort 07", status: "open" })).data).toHaveLength(1);

    // The facilitator replies #resolved → event resolved, Wrike task completed.
    const done = learnerMsg("770005", "fixed the upload limit #resolved", { reference: "770001", thread: true, channel: "701701", author: "400400" });
    await triage._process(done);
    expect(done.reactions).toEqual(["✅"]);
    expect((await call("list_triage_events", { cohort: "Cohort 07", status: "resolved" })).data).toHaveLength(1);
    expect(wrikeCalls.some((c) => c.method === "PUT" && c.path === "/api/v4/tasks/IEABTASK7" && c.body!.get("status") === "Completed")).toBe(true);

    // The facilitator replies #followup to a learner's message → a follow-up ticket about that learner.
    await triage._process(learnerMsg("770006", "please check in with them next week #followup", { reference: "770099", author: "400400" }));
    const fu = (await call("list_triage_events", { category: "follow_up" })).data;
    expect(fu).toHaveLength(1);
    expect(fu[0].summary).toMatch(/^Follow-up requested by Facilitator: please check in with them next week/);

    const stats = (await call("get_cohort_stats", { cohort: "C07" })).data;
    expect(stats).toMatchObject({ cohort: "C07 · Cohort 07", flagged: 2, wins: 1 });
    expect(stats.hashtags).toMatchObject({ blocker: 1, help: 1, week2: 1, win: 1, capstone: 1, resolved: 2, followup: 1 });

    const log = (await call("list_email_log")).data;
    expect(log[0]).toMatchObject({ kind: "critical_alert", status: "preview", recipients: ["fac7@ictc.test", "lead@ictc.test"] });
  });

  it("does not store learner ids for hashtags unless activity tracking is on", async () => {
    const { rows } = await db.query("SELECT count(*) n FROM hashtag_events WHERE author_id IS NOT NULL");
    expect(Number(rows[0].n)).toBe(0);
  });

  it("checks a de-identified roster against the cohort's server", async () => {
    const r = await call("check_discord_membership", {
      cohort: "C07",
      csv: "email,discord_username\njane@x.ca,@Jane.Doe\nsam@x.ca,Sam Lee\nzoe@x.ca,zoe.z\n",
    });
    expect(r.data.summary).toBe("1 of 3 joined · 1 not joined · 1 need a look");
    expect(r.data.not_joined).toEqual([{ email: "zoe@x.ca", discord_username: "zoe.z" }]);
    const noServer = await call("check_discord_membership", { cohort: "Cohort 1", rows: [{ email: "a@x.ca", discord_username: "a" }] });
    expect(noServer.text).toMatch(/has no Discord server set/);
  });

  it("nudge emails always wait for approval and leave no learner addresses behind", async () => {
    const r = await call("send_nudge_emails", { cohort: "C07", emails: ["zoe@x.ca", "ZOE@x.ca", "bad"], template: "first" });
    expect(r.data.status).toBe("pending_approval");
    expect(r.data.preview).toMatchObject({ recipients: 1, skipped_invalid: 1, duplicates_removed: 1, subject: "Join your Cohort 07 (C07) Discord community" });
    expect(r.data.preview.mode).toMatch(/preview only/);

    const ok = await call("approve_action", { pending_action_id: r.data.pending_action_id });
    expect(ok.data.result).toMatchObject({ status: "preview", recipients: 1 });
    const stored = await db.query("SELECT params::text p FROM pending_actions WHERE id=$1", [r.data.pending_action_id]);
    expect(stored.rows[0].p).not.toContain("zoe@");
    const audit = await db.query("SELECT params::text p FROM audit_log WHERE tool='send_nudge_emails'");
    expect(audit.rows[0].p).toContain("redacted");
    expect(audit.rows.map((r: any) => r.p).join()).not.toContain("zoe@");
    const nudgeLog = await db.query("SELECT recipients, recipient_count FROM email_log WHERE kind='nudge'");
    expect(nudgeLog.rows).toEqual([{ recipients: null, recipient_count: 1 }]);

    const r2 = await call("send_nudge_emails", { cohort: "C07", emails: ["amy@x.ca"] });
    await call("reject_action", { pending_action_id: r2.data.pending_action_id });
    const stored2 = await db.query("SELECT params::text p FROM pending_actions WHERE id=$1", [r2.data.pending_action_id]);
    expect(stored2.rows[0].p).not.toContain("amy@");
  });

  it("builds weekly recaps per cohort and program-wide, on schedule", async () => {
    const res = await sendWeeklyRecaps(db, mailer, ["lead@ictc.test"]);
    expect(res.find((r) => r.cohort === "C07 · Cohort 07")).toMatchObject({ status: "preview", recipients: 1 });
    expect(res.find((r) => r.cohort === "Cohort 1")).toMatchObject({ status: "skipped" });
    expect(res.at(-1)).toMatchObject({ cohort: "All cohorts", status: "preview" });
    const viaTool = await call("send_weekly_recap", { cohorts: ["C07"] });
    expect(viaTool.data).toMatchObject({ preview_mode: true, results: [{ cohort: "C07 · Cohort 07", status: "preview" }] });

    // Monday 8:00 Toronto = 12:00 UTC (EDT). First start never fires for a past occurrence.
    const mon = new Date("2026-10-05T12:30:00Z");
    expect(await claimDueJob(db, "recap_test", "0 8 * * 1", "America/Toronto", mon)).toBe(false);
    expect(await claimDueJob(db, "recap_test", "0 8 * * 1", "America/Toronto", new Date("2026-10-07T12:00:00Z"))).toBe(false);
    expect(await claimDueJob(db, "recap_test", "0 8 * * 1", "America/Toronto", new Date("2026-10-12T12:01:00Z"))).toBe(true);
    expect(await claimDueJob(db, "recap_test", "0 8 * * 1", "America/Toronto", new Date("2026-10-12T12:02:00Z"))).toBe(false);
  });

  it("closes tickets that were completed in Wrike", async () => {
    await db.query("UPDATE triage_events SET status='open', resolved_at=NULL, ticket_id='IEABSYNC' WHERE category='follow_up'");
    const wrike = new WrikeClient({ token: "t", host: "www.wrike.com" }, (async (url: URL) => {
      expect(url.pathname).toBe("/api/v4/tasks/IEABSYNC");
      return new Response(JSON.stringify({ data: [{ id: "IEABSYNC", status: "Completed" }] }));
    }) as unknown as typeof fetch);
    expect(await syncWrikeStatuses(db, wrike)).toBe(1);
    expect((await call("list_triage_events", { category: "follow_up" })).data[0].status).toBe("resolved");
  });

  it("manages hashtags from chat", async () => {
    const t = await call("upsert_hashtag", { tag: "#LMS", action: "ticket", category: "technical_support", min_severity: "medium" });
    expect(t.data).toMatchObject({ tag: "lms", action: "ticket", staff_only: false });
    expect((await call("upsert_hashtag", { tag: "x1", action: "ticket" })).text).toMatch(/needs a category/);
    expect((await call("list_hashtags")).data.some((h: any) => h.tag === "lms")).toBe(true);
    expect((await call("delete_hashtag", { tag: "lms" })).isError).toBe(false);
  });
});
