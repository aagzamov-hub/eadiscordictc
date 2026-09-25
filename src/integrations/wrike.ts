/**
 * Wrike tickets via the Wrike REST API v4, authenticated with a permanent access token.
 * The token acts as the Wrike user who created it: tasks appear as created by that user,
 * and only folders that user can see are reachable.
 */

export interface WrikeConfig {
  token: string;
  /** www.wrike.com, app-us2.wrike.com, app-eu.wrike.com … (the host in your Wrike URL) */
  host: string;
}

export interface WrikeTaskInput {
  folderId: string;
  title: string;
  /** Label/value pairs shown at the top of the description. */
  fields: [string, string][];
  /** The original message text (quoted in the description). */
  body: string;
  responsibleIds: string[];
  importance: "High" | "Normal" | "Low";
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class WrikeClient {
  private folderIdCache = new Map<string, string>();
  constructor(private cfg: WrikeConfig, private fetchImpl: typeof fetch = fetch) {}

  private async call<T = any>(method: string, path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`https://${this.cfg.host}/api/v4${path}`);
    const init: RequestInit = { method, headers: { authorization: `bearer ${this.cfg.token}` } };
    if (params && method === "GET") {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    } else if (params) {
      init.body = new URLSearchParams(params);
    }
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`Wrike ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /**
   * Accepts either an API v4 folder ID ("IEAB…") or the numeric ID seen in Wrike URLs
   * (e.g. …/folder/4558110989) and returns the API v4 ID.
   */
  async resolveFolderId(idOrNumeric: string): Promise<string> {
    if (!/^\d+$/.test(idOrNumeric)) return idOrNumeric;
    const cached = this.folderIdCache.get(idOrNumeric);
    if (cached) return cached;
    const res = await this.call<{ data: { id: string }[] }>("GET", "/ids", {
      ids: JSON.stringify([idOrNumeric]),
      type: "ApiV2Folder",
    });
    const id = res.data[0]?.id;
    if (!id) throw new Error(`Wrike folder ${idOrNumeric} not found or not visible to the token's user.`);
    this.folderIdCache.set(idOrNumeric, id);
    return id;
  }

  async createTask(input: WrikeTaskInput): Promise<{ id: string; permalink: string }> {
    const folderId = await this.resolveFolderId(input.folderId);
    const description =
      input.fields.map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${linkify(v)}`).join("<br>") +
      `<br><br><i>Message:</i><br>${escapeHtml(input.body).replace(/\n/g, "<br>")}`;
    const params: Record<string, string> = {
      title: input.title.slice(0, 250),
      description,
      importance: input.importance,
    };
    if (input.responsibleIds.length) params.responsibles = JSON.stringify(input.responsibleIds);
    // No dates are set on purpose: tickets stay undated unless someone schedules them.
    const res = await this.call<{ data: { id: string; permalink: string }[] }>("POST", `/folders/${folderId}/tasks`, params);
    return { id: res.data[0].id, permalink: res.data[0].permalink };
  }

  /** Folders/projects whose title contains the query (case-insensitive). */
  async findFolders(query: string) {
    const res = await this.call<{ data: { id: string; title: string; project?: unknown; scope: string }[] }>("GET", "/folders");
    const q = query.toLowerCase();
    return res.data
      .filter((f) => f.scope === "WsFolder" && f.title.toLowerCase().includes(q))
      .slice(0, 50)
      .map((f) => ({ id: f.id, title: f.title, is_project: !!f.project }));
  }

  /** People whose name or email contains the query. */
  async findContacts(query: string) {
    const res = await this.call<{
      data: { id: string; firstName: string; lastName: string; type: string; deleted: boolean; profiles?: { email?: string }[] }[];
    }>("GET", "/contacts");
    const q = query.toLowerCase();
    return res.data
      .filter((c) => c.type === "Person" && !c.deleted)
      .map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`.trim(), email: c.profiles?.[0]?.email ?? null }))
      .filter((c) => c.name.toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q))
      .slice(0, 50);
  }
}

function linkify(v: string): string {
  return /^https?:\/\/\S+$/.test(v) ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v);
}

export function wrikeImportance(severity: string): "High" | "Normal" | "Low" {
  return severity === "critical" || severity === "high" ? "High" : severity === "low" ? "Low" : "Normal";
}
