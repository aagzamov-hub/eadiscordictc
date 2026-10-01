/**
 * Outgoing email through SendGrid's v3 API. Without an API key the mailer runs in PREVIEW mode:
 * every email is rendered and logged as "preview" but nothing leaves the server — safe for testing.
 */
import type { Db } from "../db/pool.js";

export type EmailKind = "critical_alert" | "weekly_recap" | "nudge";

export interface EmailMessage {
  kind: EmailKind;
  to: string[];
  subject: string;
  html: string;
  text: string;
  cohortId?: string | null;
  /** One email per recipient so nobody sees anyone else's address (always used for learners). */
  individually?: boolean;
  /** Store recipient addresses in email_log. Off for learner email. */
  logRecipients?: boolean;
}

export interface SendResult {
  status: "sent" | "preview" | "failed";
  recipient_count: number;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s.trim());

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class Mailer {
  constructor(
    private db: Db,
    private cfg: { apiKey?: string; from?: string; fromName: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get previewMode() {
    return !this.cfg.apiKey;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const to = [...new Set(msg.to.map((s) => s.trim().toLowerCase()).filter(isEmail))];
    if (!to.length) return { status: "failed", recipient_count: 0, error: "no valid recipients" };

    let result: SendResult;
    if (this.previewMode) {
      result = { status: "preview", recipient_count: to.length };
    } else {
      result = await this.sendViaSendGrid(to, msg);
    }
    await this.db
      .query(
        "INSERT INTO email_log (kind, subject, recipient_count, recipients, cohort_id, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [msg.kind, msg.subject, to.length, msg.logRecipients ? to : null, msg.cohortId ?? null, result.status, result.error ?? null],
      )
      .catch(() => {});
    return result;
  }

  private async sendViaSendGrid(to: string[], msg: EmailMessage): Promise<SendResult> {
    // SendGrid allows up to 1000 personalizations per request.
    const batches: string[][] = [];
    if (msg.individually) {
      for (let i = 0; i < to.length; i += 1000) batches.push(to.slice(i, i + 1000));
    } else {
      batches.push(to);
    }
    try {
      for (const batch of batches) {
        const personalizations = msg.individually
          ? batch.map((email) => ({ to: [{ email }] }))
          : [{ to: batch.map((email) => ({ email })) }];
        const res = await this.fetchImpl("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            personalizations,
            from: { email: this.cfg.from, name: this.cfg.fromName },
            subject: msg.subject,
            content: [
              { type: "text/plain", value: msg.text },
              { type: "text/html", value: msg.html },
            ],
            categories: [msg.kind],
          }),
        });
        if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return { status: "sent", recipient_count: to.length };
    } catch (err) {
      return { status: "failed", recipient_count: to.length, error: (err as Error).message };
    }
  }
}

/** Minimal, mail-client-safe HTML wrapper. */
export function emailHtml(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1d1d1f">
<table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">
<tr><td><h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(title)}</h2>${bodyHtml}</td></tr></table></body></html>`;
}

// ---------- learner nudge templates ----------

export interface NudgeTemplate {
  subject: string;
  body: string; // plain text; {cohort} and {link} are replaced
}

export const NUDGE_TEMPLATES: Record<"first" | "second", NudgeTemplate> = {
  first: {
    subject: "Join your {cohort} Discord community",
    body:
      "Hi,\n\nWe noticed you haven't joined your cohort's Discord server yet. It's where your facilitators share updates, " +
      "answer questions and where you'll connect with the rest of your cohort.\n\n" +
      "To join, open your course in the learning platform and click the Discord link in the Introduction section.{link}\n\n" +
      "See you there!\nThe eLearning Pathways team",
  },
  second: {
    subject: "Reminder: your {cohort} Discord community is waiting",
    body:
      "Hi,\n\nThis is a quick reminder that you still haven't joined your cohort's Discord server. " +
      "Announcements, help from facilitators and group activities all happen there.\n\n" +
      "Open your course, go to the Introduction section and click the Discord link to join.{link}\n\n" +
      "If you're having trouble joining, just reply to this email and we'll help.\nThe eLearning Pathways team",
  },
};

export function renderNudge(t: NudgeTemplate, cohort: string, link?: string) {
  const fill = (s: string, linkText: string) => s.replaceAll("{cohort}", cohort).replaceAll("{link}", linkText);
  const subject = fill(t.subject, "");
  const text = fill(t.body, link ? `\n\nDirect link: ${link}` : "");
  const html = emailHtml(
    subject,
    escapeHtml(fill(t.body, "{LINK}"))
      .split("\n\n")
      .map((p) => `<p style="margin:0 0 12px;line-height:1.5">${p.replace(/\n/g, "<br>")}</p>`)
      .join("")
      .replace("{LINK}", link ? `<br><br><a href="${escapeHtml(link)}">Join the ${escapeHtml(cohort)} Discord</a>` : ""),
  );
  return { subject, text, html };
}
