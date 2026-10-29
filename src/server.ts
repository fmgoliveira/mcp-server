import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { config } from "./config.js";
import { admin } from "./admin.js";
import { confirmAuthorize, provider } from "./auth-provider.js";
import { registerCommon } from "./tools/common.js";
import { registerGoogle } from "./tools/google.js";
import { registerMicrosoft } from "./tools/microsoft.js";

function buildServer(): McpServer {
  const s = new McpServer({ name: "multi-account", version: "0.1.0" });
  registerCommon(s);
  registerGoogle(s);
  registerMicrosoft(s);
  return s;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));

const issuerUrl = new URL(config.publicUrl);
const mcpUrl = new URL(`${config.publicUrl}/mcp`);

// OAuth endpoints for Claude (metadata, /register, /authorize, /token, /revoke)
app.use(mcpAuthRouter({ provider, issuerUrl, resourceServerUrl: mcpUrl, resourceName: "Multi-account Google + Microsoft" }));
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

app.listen(config.port, () => console.log(`MCP server on :${config.port} (public ${config.publicUrl})`));
