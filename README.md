# EA Discord Connector

A Discord bot plus an MCP server that lets an AI assistant (Claude, or a Copilot Studio agent in Teams) manage a Discord server. It includes:

- **Management tools:** read and search messages, post and reply, create threads and channels, pin, react, DM, assign roles, time out members, and kick or ban. Destructive actions need approval.
- **Scheduled messages:** one-off or recurring (cron). They are sent by the bot itself, so no chat session has to be open.
- **24/7 AI triage:** every message is checked. Anything that needs a human is sorted into a category (abusive, urgent, technical/course/content support, or your own categories), matched to the right **cohort**, and sent to that cohort's facilitators. A **Wrike** task can also be opened for it.

The bot runs as one Node process with Postgres. It has no host-specific code: the same Docker image runs on Railway now and on Platform.sh later.

```
Discord ⇄ bot (discord.js) ─┬─ MCP endpoint /mcp  ⇄ Claude / Copilot Studio
                            ├─ scheduler (every 30s)
                            ├─ triage → alerts (Discord channel / DMs) → Wrike tasks (API v4)
                            └─ Postgres (schedules, cohorts, triage events, approvals, audit log)
```

---

## 1. Create the Discord bot (≈10 min)

1. Go to https://discord.com/developers/applications, click **New Application**, and name it (e.g. "EA Dev"). Make a **separate app for dev and for production**.
2. On **Bot**, click **Reset Token** and copy the token into `DISCORD_TOKEN`. Anyone with this token controls the bot, so treat it like a password.
3. On **Bot → Privileged Gateway Intents**, turn on **Server Members Intent** and **Message Content Intent**. Under 100 servers this is a toggle and needs no review.
4. On **General Information**, copy the **Application ID** into `DISCORD_CLIENT_ID`.
5. Generate the invite link:
   ```bash
   DISCORD_CLIENT_ID=<application id> npm run invite
   ```
   It asks only for the permissions the tools use, not Administrator. The person who opens it needs **Manage Server**, and can only grant permissions they have themselves.
6. After the bot joins, go to **Server Settings → Roles** and drag the bot's role **above** every role it should manage or moderate.
7. Copy the server ID into `DISCORD_GUILD_IDS`, so the bot refuses to act anywhere else. To get it, turn on Developer Mode, right-click the server, and choose Copy Server ID.

## 2. Run locally

```bash
cp .env.example .env         # fill in DISCORD_TOKEN, DATABASE_URL, MCP_API_KEY
npm install
npm run dev                  # migrations run automatically on start
curl localhost:3000/healthz
```

## 3. Deploy to Railway

1. Create a new project from this GitHub repo. Railway picks up `railway.json` and the `Dockerfile`.
2. Add a **PostgreSQL** service and set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the app.
3. Set `DISCORD_TOKEN`, `DISCORD_GUILD_IDS`, and `MCP_API_KEY` (`openssl rand -hex 32`).
4. Generate a public domain. `https://<domain>/healthz` should return `"ok": true`.

Keep **one replica**. Discord allows one gateway connection per bot token.

## 4. Connect an AI client

The MCP endpoint accepts the key three ways:

| Client | URL | Auth |
|---|---|---|
| **claude.ai** (Settings → Connectors → Add custom connector) | `https://<domain>/mcp/<MCP_API_KEY>` | key in URL, no OAuth |
| **Copilot Studio** (Agent → Tools → Add tool → MCP) | `https://<domain>/mcp` | API key, header `Authorization: Bearer <MCP_API_KEY>` or `x-api-key` |
| Claude Code / other | `https://<domain>/mcp` | `Authorization: Bearer <MCP_API_KEY>` |

Anyone who has the claude.ai URL can use the connector, so share it only as carefully as you would a password. Rotate `MCP_API_KEY` if it leaks.

## 5. Approvals

When `REQUIRE_APPROVAL=true` (the default), `delete_message`, `kick_member`, `ban_member`, `unban_member` and `delete_channel` don't run right away. They return a pending action ID, the assistant shows you what will happen, and the action only runs when `approve_action` is called after you confirm. `list_pending_actions` shows what's waiting. Every write is recorded in `audit_log`.

## 6. Scheduled messages

Ask the assistant things like "post the weekly reminder in #announcements every Monday at 9am." It then calls `schedule_message` with `cron: "0 9 * * 1"`. Times use `DEFAULT_TIMEZONE` (America/Toronto) unless you name another zone. A recurring message that fails skips that occurrence. A one-off retries 3 times, 2 minutes apart.

To post something that needs thinking at send time (e.g. "summarize this week's questions every Friday"), use a Claude scheduled task that calls `list_triage_events` / `read_messages` and then `send_message`.

## 7. Triage and cohorts

Turn it on with `TRIAGE_ENABLED=true` and `ANTHROPIC_API_KEY`. **Try it on a test server first.**

1. **Cohorts:** ask the assistant to set up each one, e.g. "Create cohort *Cohort 3* with category 1234… and facilitators @A and @B, alerts to #cohort-3-facilitators." This calls `upsert_cohort`. A message is matched to a cohort by exact channel, then the thread's parent channel, then the Discord category, then the author's role.
2. **Categories:** the defaults are `abusive`, `urgent`, `technical_support`, `course_support` and `content_support`. Change them or add more with `upsert_triage_category`. The AI decides from the description, so make it specific.
3. **What happens to a message:**
   - A local filter skips obvious chatter ("thanks", emoji, bare links), so it never reaches the AI.
   - Everything else is classified by `TRIAGE_MODEL` (Claude Haiku by default), with the last 5 messages as context.
   - Only messages that need a human are stored. Normal conversation is not kept.
   - **High/critical** items, or categories with `alert_immediately`, post an alert to the cohort's alert channel. Facilitators are DM'd when the category has `dm_facilitators` or the severity is critical.
   - Everything else waits in `list_triage_events`, e.g. for a daily digest.
4. **Discord AutoMod:** also turn on Discord's built-in AutoMod (Server Settings → AutoMod). It blocks slurs and spam before they're posted. This bot handles the judgment calls.
5. **Tell members:** add a line to the server rules saying an AI assistant reviews messages so facilitators can help faster. Check your organization's policy on learner data before using this on the real server.

## 8. Wrike tickets

Categories with `create_ticket=true` can open a Wrike task in each cohort's folder or project. Each task gets:
- a title like `[abusive] Cohort 3: summary`
- **importance** from the severity (high/critical → High, medium → Normal, low → Low)
- the assigned people as **assignees**
- a description with the severity, author, channel, a link to the Discord message, and the message text

No dates are set on these tasks. The task ID and link are saved on the triage event.

**Before you turn this on, check with your Wrike admin.** The integration uses an API token, and Wrike admins can see and restrict API apps. For production, the token should belong to an account the admin approves, ideally a shared service account rather than your personal login.

1. In Wrike, go to **Apps & Integrations → API**, create an app, and generate a **permanent access token**.
2. Set `WRIKE_ENABLED=true`, `WRIKE_ACCESS_TOKEN`, and `WRIKE_API_HOST` (the host in your Wrike URL, e.g. `www.wrike.com` or `app-us2.wrike.com`).
3. For each cohort, ask the assistant to set the folder and assignees. It uses `wrike_lookup` to find the IDs, e.g. "route Cohort 3 tickets to the AI Bootcamp folder, assigned to Sam." `wrike_folder_id` also accepts the numeric ID from a Wrike folder URL.

The token acts as the Wrike user who created it, so tasks show as created by that user, and it can only reach folders that user can see.

## 9. Cohorts as servers, scheduling to many cohorts

Each cohort can be its own Discord server. Set it up from chat:

> "Set up Cohort 04: code C04, server 1234…, announcements channel 5678…, staff emails fac4@…, facilitator @Amy, Wrike folder 4558…"

Messages anywhere in that server are routed to the cohort. Scheduling can target cohorts instead of a channel: "every Monday 9am post the weekly check-in in **all** cohorts" creates one scheduled post per cohort's announcements channel, each one cancellable on its own.

## 10. Hashtags

Learners and staff can type hashtags in any message. They work even with AI triage off; manage them with `list_hashtags` / `upsert_hashtag`.

| Tag | Effect |
|---|---|
| `#urgent` `#blocker` | Ticket, high severity, alert + email |
| `#help` `#question` `#tech` `#content` | Ticket in the matching category |
| `#win` `#capstone` `#resource` `#feedback` `#week1`…`#week14` | Counted for stats and the weekly recap |
| `#followup` `#escalate` `#resolved` | **Staff only**, used when replying to a message: follow-up ticket, escalation, or close the ticket (and its Wrike task) |

- With AI triage on, a learner's tag is a strong hint, but obvious misuse (e.g. `#urgent` on small talk) is downgraded.
- Untagged messages are still caught by the AI.
- One conversation means one ticket: later messages in the same thread become comments on the Wrike task.
- The bot reacts ✅ when it picks something up.
- Per-learner hashtag history is only stored with `TRACK_LEARNER_ACTIVITY=true`. Otherwise counts are cohort-level.

## 11. Email: critical alerts, weekly recap, join nudges

Email goes through SendGrid. **Without `SENDGRID_API_KEY` everything is a preview:** emails are rendered and logged (`list_email_log`), never sent.

- **Critical alerts:** high/critical items email the cohort's `notify_emails` plus `PROGRAM_EMAILS`.
- **Weekly recap:** sent every Monday 8:00 (`RECAP_CRON`), or on demand with `send_weekly_recap`. Each cohort's staff get their cohort; `PROGRAM_EMAILS` get all cohorts. It covers flagged items by category, urgent/conduct items, items resolved, what's still open (with Wrike links), and hashtag counts.
- **Discord join check:** export a de-identified CSV from the LMS (`email, discord_username`), drop it in the chat, and ask "who in C04 hasn't joined Discord?". `check_discord_membership` returns three lists: joined, not joined, and needs a look (typos, display names, duplicates).
- **Nudges:** `send_nudge_emails` always waits for approval, even with `REQUIRE_APPROVAL=false`, and shows the exact email first. It sends one email per learner, so no one sees other addresses.
- **What's stored:** learner addresses are never stored. They're removed from the pending action once it's approved or rejected, redacted from the audit log, and not written to the email log.

## 12. Wrike ticket board

- **Custom fields:** if the board has **Cohort**, **Ticket type** and **Source tag** custom fields, put their IDs in `WRIKE_FIELD_COHORT`, `WRIKE_FIELD_TICKET_TYPE` and `WRIKE_FIELD_SOURCE_TAG`, and every ticket is filled in.
- **Two-way sync:** completing a task in Wrike resolves it in the agent (checked every `WRIKE_SYNC_MINUTES`), and `#resolved` in Discord completes the Wrike task.

## 13. Moving to company GitHub + Platform.sh

1. **Code:** transfer this repo to the company org (GitHub → Settings → Transfer), or push it to a new company repo. Both keep the history.
2. **Discord:** create a **production** bot app under a company-owned account and don't reuse the dev token.
3. **Hosting:** `.upsun/config.yaml` defines the app and a PostgreSQL service. `DATABASE_URL` is derived automatically from the `database` relationship. Add `DISCORD_TOKEN`, `MCP_API_KEY` and the rest as sensitive `env:` variables. Have the Platform.sh admins check the runtime version and make sure the app is not scaled beyond one instance.
4. **Data:** schedules and cohorts are plain Postgres tables, so `pg_dump` from Railway and restore into Platform.sh, or re-enter them.
5. **Clients:** point the claude.ai / Copilot Studio connector at the new URL.

## Development

```bash
npm run typecheck
npm test                                                        # unit tests
TEST_DATABASE_URL=postgres://… npm test                          # + end-to-end over HTTP + Postgres (wipes that DB)
```

## Limits worth knowing

- Bots **cannot read anyone's personal DMs**, only DMs sent to the bot. That limit is Discord's.
- `search_messages` scans recent history (default 200 messages per channel), because Discord offers bots no server-side search.
- The approval gate depends on the AI client asking you before it calls `approve_action`. For a second check, set Claude or Copilot Studio to ask before running `approve_action` (per-tool confirmation), and keep the connector URL private.
