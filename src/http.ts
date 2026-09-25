import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function keyMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accepts the API key three ways, because MCP clients differ:
 *  - Authorization: Bearer <key>   (Copilot Studio, most clients)
 *  - x-api-key: <key>
 *  - /mcp/<key> path segment        (claude.ai custom connectors, which take a URL only)
 */
export function extractKey(req: Request): string | undefined {
  const auth = req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.header("x-api-key") ?? (req.params as Record<string, string>).key;
}

export function createHttpApp(opts: {
  apiKey: string;
  makeServer: () => McpServer;
  health: () => Promise<Record<string, unknown>>;
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", async (_req, res) => {
    const h = await opts.health();
    res.status(h.ok ? 200 : 503).json(h);
  });

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!keyMatches(extractKey(req), opts.apiKey)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  };

  // Stateless Streamable HTTP: a fresh server + transport per request.
  const handle = async (req: Request, res: Response) => {
    const server = opts.makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };

  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };

  for (const path of ["/mcp", "/mcp/:key"]) {
    app.post(path, auth, handle);
    app.get(path, auth, notAllowed);
    app.delete(path, auth, notAllowed);
  }

  return app;
}
