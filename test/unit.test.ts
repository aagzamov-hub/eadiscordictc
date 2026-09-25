import { describe, expect, it } from "vitest";
import { shouldClassify } from "../src/triage/prefilter.js";
import { firstRun, nextCronRun, ScheduleError } from "../src/scheduler/schedule.js";
import { matchCohort, type CohortRow } from "../src/triage/routing.js";
import { loadConfig, platformDatabaseUrl } from "../src/config.js";
import { keyMatches } from "../src/http.js";
import { WrikeClient, wrikeImportance } from "../src/integrations/wrike.js";

describe("prefilter", () => {
  it("skips chatter, emoji and bare links", () => {
    for (const s of ["lol", "thanks!", "👍👍", "<:party:12345678>", "https://example.com/x", "   "]) {
      expect(shouldClassify(s, 15)).toBe(false);
    }
  });
  it("keeps questions, problems, abuse signals and long messages", () => {
    for (const s of [
      "is it due?",
      "I can't log in",
      "help",
      "you're an idiot",
      "WHY IS THIS BROKEN AGAIN",
      "I finished module three and wanted to share my notes",
    ]) {
      expect(shouldClassify(s, 15)).toBe(true);
    }
  });
});

describe("schedule", () => {
  const now = new Date("2026-09-25T12:00:00Z"); // Friday 08:00 in Toronto

  it("computes next Monday 9am Toronto time", () => {
    expect(nextCronRun("0 9 * * 1", "America/Toronto", now).toISOString()).toBe("2026-09-28T13:00:00.000Z");
  });
  it("accepts one-off with offset and rejects without one", () => {
    expect(firstRun({ send_at: "2026-10-01T09:00:00-04:00", timezone: "America/Toronto" }, now).toISOString()).toBe(
      "2026-10-01T13:00:00.000Z",
    );
    expect(() => firstRun({ send_at: "2026-10-01T09:00:00", timezone: "America/Toronto" }, now)).toThrow(ScheduleError);
  });
  it("rejects past times, bad cron, bad timezone, and empty schedules", () => {
    expect(() => firstRun({ send_at: "2026-09-01T09:00:00Z", timezone: "UTC" }, now)).toThrow(/past/);
    expect(() => firstRun({ cron: "not a cron", timezone: "UTC" }, now)).toThrow(ScheduleError);
    expect(() => firstRun({ cron: "0 9 * * 1", timezone: "Mars/Olympus" }, now)).toThrow(/timezone/);
    expect(() => firstRun({ timezone: "UTC" }, now)).toThrow(ScheduleError);
  });
  it("recurring with a start date waits for it", () => {
    const r = firstRun({ cron: "0 9 * * *", send_at: "2026-10-05T00:00:00-04:00", timezone: "America/Toronto" }, now);
    expect(r.toISOString()).toBe("2026-10-05T13:00:00.000Z");
  });
});

describe("cohort routing", () => {
  const base = { facilitator_user_ids: [], alert_channel_id: null, wrike_folder_id: null, wrike_assignee_ids: [] };
  const cohorts: CohortRow[] = [
    { ...base, id: "1", name: "C1", channel_ids: ["100"], category_ids: [], role_ids: ["r1"] },
    { ...base, id: "2", name: "C2", channel_ids: [], category_ids: ["900"], role_ids: [] },
  ];
  it("prefers exact channel, then thread parent, then category, then role", () => {
    expect(matchCohort(cohorts, { channelId: "100", parentChannelId: null, categoryId: "900", authorRoleIds: [] })?.name).toBe("C1");
    expect(matchCohort(cohorts, { channelId: "t1", parentChannelId: "100", categoryId: "900", authorRoleIds: [] })?.name).toBe("C1");
    expect(matchCohort(cohorts, { channelId: "200", parentChannelId: null, categoryId: "900", authorRoleIds: [] })?.name).toBe("C2");
    expect(matchCohort(cohorts, { channelId: "300", parentChannelId: null, categoryId: null, authorRoleIds: ["r1"] })?.name).toBe("C1");
    expect(matchCohort(cohorts, { channelId: "300", parentChannelId: null, categoryId: null, authorRoleIds: [] })).toBeNull();
  });
});

describe("config", () => {
  const good = { DISCORD_TOKEN: "t", DATABASE_URL: "postgres://x", MCP_API_KEY: "x".repeat(32) };
  it("parses defaults", () => {
    const c = loadConfig(good);
    expect(c.REQUIRE_APPROVAL).toBe(true);
    expect(c.TRIAGE_ENABLED).toBe(false);
    expect(c.DEFAULT_TIMEZONE).toBe("America/Toronto");
  });
  it("rejects short keys and incomplete triage/wrike setups", () => {
    expect(() => loadConfig({ ...good, MCP_API_KEY: "short" })).toThrow(/MCP_API_KEY/);
    expect(() => loadConfig({ ...good, TRIAGE_ENABLED: "true" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ...good, WRIKE_ENABLED: "true" })).toThrow(/WRIKE_ACCESS_TOKEN/);
  });
  it("derives DATABASE_URL on Platform.sh", () => {
    const rels = { database: [{ username: "main", password: "p@ss", host: "db.internal", port: 5432, path: "main" }] };
    const env = { PLATFORM_RELATIONSHIPS: Buffer.from(JSON.stringify(rels)).toString("base64") };
    expect(platformDatabaseUrl(env)).toBe("postgresql://main:p%40ss@db.internal:5432/main");
    expect(loadConfig({ ...good, DATABASE_URL: undefined, ...env }).DATABASE_URL).toContain("db.internal");
  });
});

describe("misc", () => {
  it("compares keys safely", () => {
    expect(keyMatches("abc", "abc")).toBe(true);
    expect(keyMatches("abd", "abc")).toBe(false);
    expect(keyMatches("ab", "abc")).toBe(false);
    expect(keyMatches(undefined, "abc")).toBe(false);
  });
  it("maps severity to Wrike importance", () => {
    expect(wrikeImportance("critical")).toBe("High");
    expect(wrikeImportance("medium")).toBe("Normal");
    expect(wrikeImportance("low")).toBe("Low");
  });
});

describe("wrike client", () => {
  it("resolves numeric folder IDs, creates an undated task, and escapes content", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.pathname.endsWith("/ids")
        ? { data: [{ id: "IEABFOLDER", apiV2Id: "4558110989" }] }
        : { data: [{ id: "IEABTASK", permalink: "https://www.wrike.com/open.htm?id=1" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const w = new WrikeClient({ token: "tok", host: "app-us2.wrike.com" }, fake);

    const t = await w.createTask({
      folderId: "4558110989",
      title: "[abusive] Cohort 1: insult",
      fields: [["Severity", "high"], ["Discord message", "https://discord.com/channels/1/2/3"]],
      body: "<script>x</script>",
      responsibleIds: ["KUAAA"],
      importance: "High",
    });
    expect(t).toEqual({ id: "IEABTASK", permalink: "https://www.wrike.com/open.htm?id=1" });
    expect(calls[0].url.toString()).toContain("app-us2.wrike.com/api/v4/ids");
    expect(calls[1].url.pathname).toBe("/api/v4/folders/IEABFOLDER/tasks");
    expect((calls[1].init.headers as any).authorization).toBe("bearer tok");
    const form = calls[1].init.body as URLSearchParams;
    expect(form.get("importance")).toBe("High");
    expect(form.get("responsibles")).toBe('["KUAAA"]');
    expect(form.get("dates")).toBeNull();
    expect(form.get("description")).toContain("&lt;script&gt;");
    expect(form.get("description")).toContain('<a href="https://discord.com/channels/1/2/3">');

    await w.resolveFolderId("4558110989"); // cached, no new call
    expect(calls).toHaveLength(2);
  });

  it("surfaces API errors", async () => {
    const fake = (async () => new Response('{"error":"not_authorized"}', { status: 401 })) as unknown as typeof fetch;
    const w = new WrikeClient({ token: "bad", host: "www.wrike.com" }, fake);
    await expect(w.findContacts("a")).rejects.toThrow(/401/);
  });
});
