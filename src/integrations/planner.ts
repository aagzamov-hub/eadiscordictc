/**
 * Microsoft Planner (the task board inside Teams) via Microsoft Graph, app-only auth.
 * Requires an Entra ID app registration with the application permission Tasks.ReadWrite.All
 * (admin consent), and the app must be allowed on the target plan's Microsoft 365 group.
 */

export interface PlannerConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface PlannerTaskInput {
  planId: string;
  bucketId?: string | null;
  title: string;
  description: string;
  assigneeIds: string[];
  priority: number; // 0-10; Planner shows 1=Urgent, 3=Important, 5=Medium, 9=Low
  dueDateTime?: string;
}

const GRAPH = "https://graph.microsoft.com/v1.0";

export class PlannerClient {
  private token?: { value: string; expires: number };
  constructor(private cfg: PlannerConfig, private fetchImpl: typeof fetch = fetch) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) throw new Error(`Graph token request failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async graph(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${GRAPH}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`Graph ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    return res;
  }

  async createTask(input: PlannerTaskInput): Promise<{ id: string }> {
    const assignments: Record<string, unknown> = {};
    for (const id of input.assigneeIds) {
      assignments[id] = { "@odata.type": "#microsoft.graph.plannerAssignment", orderHint: " !" };
    }
    const res = await this.graph("/planner/tasks", {
      method: "POST",
      body: JSON.stringify({
        planId: input.planId,
        bucketId: input.bucketId ?? undefined,
        title: input.title.slice(0, 255),
        priority: input.priority,
        dueDateTime: input.dueDateTime,
        assignments,
      }),
    });
    const task = (await res.json()) as { id: string };

    // Description lives on the task's details object, which needs its ETag to update.
    const details = await this.graph(`/planner/tasks/${task.id}/details`);
    const etag = details.headers.get("etag") ?? ((await details.json()) as any)["@odata.etag"];
    await this.graph(`/planner/tasks/${task.id}/details`, {
      method: "PATCH",
      headers: { "if-match": etag },
      body: JSON.stringify({ description: input.description.slice(0, 30000), previewType: "description" }),
    });
    return { id: task.id };
  }
}

export function plannerPriority(severity: string): number {
  return { critical: 1, high: 3, medium: 5, low: 9 }[severity] ?? 5;
}
