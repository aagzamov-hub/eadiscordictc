import { describe, expect, it } from "vitest";
import { extractHashtags, maxSeverity, strongestTicketTag, type HashtagRow } from "../src/triage/hashtags.js";
import { compareRoster, normalizeUsername, parseRosterCsv } from "../src/discord/membership.js";
import { Mailer, NUDGE_TEMPLATES, renderNudge } from "../src/integrations/email.js";

describe("hashtags", () => {
  it("finds tags, lowercased and deduplicated, ignoring channel links, URLs and code", () => {
    expect(extractHashtags("Stuck on lab 3 #Blocker #help #help")).toEqual(["blocker", "help"]);
    expect(extractHashtags("see <#123456789> and https://x.com/page#section and `#notatag`")).toEqual([]);
    expect(extractHashtags("(#win) great day!#week3 and email me@x#nope")).toEqual(["win", "week3"]);
    expect(extractHashtags("#a is too short, #ok works")).toEqual(["ok"]);
  });
  it("picks the most severe ticket tag", () => {
    const t = (tag: string, action: HashtagRow["action"], min: HashtagRow["min_severity"]): HashtagRow => ({
      tag, action, min_severity: min, category: "course_support", staff_only: false, description: "",
    });
    expect(strongestTicketTag([t("help", "ticket", "medium"), t("blocker", "ticket", "high"), t("win", "count", null)])?.tag).toBe("blocker");
    expect(strongestTicketTag([t("win", "count", null)])).toBeNull();
    expect(maxSeverity("low", "high")).toBe("high");
    expect(maxSeverity("critical", "medium")).toBe("critical");
  });
});

describe("roster check", () => {
  const member = (id: string, username: string, globalName: string | null = null, nickname: string | null = null, bot = false): any => ({
    id, nickname, displayName: nickname ?? globalName ?? username, user: { username, globalName, bot },
  });
  const members = [
    member("1", "jane.doe"),
    member("2", "sam_99", "Sam Lee"),
    member("3", "k.r", null, "Kim R"),
    member("4", "ea-bot", null, null, true),
    member("5", "facilitator.amy"),
  ];

  it("normalizes usernames the way people type them", () => {
    expect(normalizeUsername(" @Jane.Doe ")).toBe("jane.doe");
    expect(normalizeUsername("oldstyle#1234")).toBe("oldstyle");
  });

  it("sorts learners into joined, not joined and needs a look", () => {
    const r = compareRoster(
      [
        { email: "JANE@x.ca", discord_username: "@Jane.Doe" }, // exact after normalizing
        { email: "sam@x.ca", discord_username: "Sam Lee" }, // display name, not username
        { email: "kim@x.ca", discord_username: "kim r" }, // server nickname
        { email: "zoe@x.ca", discord_username: "zoe.z" }, // not in server
        { email: "nobody@x.ca", discord_username: "" },
        { email: "not-an-email", discord_username: "x" },
        { email: "jane@x.ca", discord_username: "jane.doe" }, // duplicate email
      ],
      members,
    );
    expect(r.total).toBe(7);
    expect(r.joined.map((j) => j.email)).toEqual(["jane@x.ca"]);
    expect(r.not_joined.map((j) => j.email)).toEqual(["zoe@x.ca"]);
    expect(r.needs_review.map((n) => n.email)).toEqual(["sam@x.ca", "kim@x.ca", "nobody@x.ca", "not-an-email", "jane@x.ca"]);
    expect(r.needs_review[0].reason).toContain('"sam_99"');
    expect(r.unlisted_members).toBe(1); // facilitator.amy (bots excluded)
  });

  it("parses CSV exports with different header names and separators", () => {
    expect(parseRosterCsv('Email Address,Discord Username\n"a@x.ca",a.one\r\nb@x.ca,@b\n')).toEqual([
      { email: "a@x.ca", discord_username: "a.one" },
      { email: "b@x.ca", discord_username: "@b" },
    ]);
    expect(parseRosterCsv("courriel;discord\nc@x.ca;c")).toEqual([{ email: "c@x.ca", discord_username: "c" }]);
    expect(() => parseRosterCsv("name,phone\nx,y")).toThrow(/email column/);
  });
});

describe("email", () => {
  const fakeDb: any = { query: async () => ({ rows: [], rowCount: 0 }) };

  it("renders nudges with the cohort name and an optional link, escaping HTML", () => {
    const r = renderNudge(NUDGE_TEMPLATES.first, "Cohort 04 <C04>", "https://discord.gg/abc");
    expect(r.subject).toBe("Join your Cohort 04 <C04> Discord community");
    expect(r.text).toContain("Direct link: https://discord.gg/abc");
    expect(r.html).toContain("Cohort 04 &lt;C04&gt;");
    expect(r.html).toContain('href="https://discord.gg/abc"');
    expect(renderNudge(NUDGE_TEMPLATES.second, "C01").text).not.toContain("{link}");
  });

  it("previews without a key and sends one email per learner with a key", async () => {
    const preview = new Mailer(fakeDb, { fromName: "T" });
    expect(await preview.send({ kind: "nudge", to: ["a@x.ca", "bad"], subject: "s", text: "t", html: "h" })).toEqual({
      status: "preview",
      recipient_count: 1,
    });

    const bodies: any[] = [];
    const live = new Mailer(fakeDb, { apiKey: "SG.key", from: "noreply@x.ca", fromName: "Team" }, (async (_u: string, init: any) => {
      bodies.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response("", { status: 202 });
    }) as any);
    const r = await live.send({ kind: "nudge", to: ["a@x.ca", "B@x.ca", "a@x.ca"], subject: "s", text: "t", html: "h", individually: true });
    expect(r).toEqual({ status: "sent", recipient_count: 2 });
    expect(bodies[0].auth).toBe("Bearer SG.key");
    expect(bodies[0].body.personalizations).toEqual([{ to: [{ email: "a@x.ca" }] }, { to: [{ email: "b@x.ca" }] }]);
    expect(bodies[0].body.from).toEqual({ email: "noreply@x.ca", name: "Team" });

    const failing = new Mailer(fakeDb, { apiKey: "k", from: "f@x.ca", fromName: "T" }, (async () => new Response("bad key", { status: 401 })) as any);
    const f = await failing.send({ kind: "weekly_recap", to: ["s@x.ca"], subject: "s", text: "t", html: "h" });
    expect(f.status).toBe("failed");
    expect(f.error).toContain("401");
  });
});
