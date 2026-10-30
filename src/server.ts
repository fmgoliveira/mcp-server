import { config } from "./config.js";
import { createApp } from "./app.js";
import { startHealthChecks } from "./health.js";
import { buildServer } from "./mcp.js";

buildServer(); // registers every tool once so the admin UI can list them
createApp().listen(config.port, () => console.log(`MCP server on :${config.port} (public ${config.publicUrl})`));
startHealthChecks(Number(process.env.HEALTH_CHECK_INTERVAL_HOURS ?? 6));
