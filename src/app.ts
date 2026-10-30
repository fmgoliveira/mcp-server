import express from "express";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { config } from "./config.js";
import { admin } from "./admin.js";
import { confirmAuthorize, provider } from "./auth-provider.js";
import { buildServer } from "./mcp.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: false, limit: "2mb" })); // room for a pasted backup

  // Static assets (favicon, shared CSS and the admin script) are public; they contain nothing sensitive.
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { index: false }));

  // Hardening for the pages a person sees: no framing, no sniffing, scripts only from this origin.
  app.use(["/admin", "/authorize", "/oauth"], (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });

  const issuerUrl = new URL(config.publicUrl);
  const mcpUrl = new URL(`${config.publicUrl}/mcp`);

  // OAuth endpoints for Claude (metadata, /register, /authorize, /token, /revoke)
  app.use(mcpAuthRouter({ provider, issuerUrl, resourceServerUrl: mcpUrl, resourceName: "Multi-account MCP" }));
  app.post("/authorize/confirm", confirmAuthorize);

  app.use(admin);
  app.get("/healthz", (_req, res) => void res.send("ok"));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
  });

  app.post("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const notAllowed = (_req: express.Request, res: express.Response) =>
    void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  return app;
}
