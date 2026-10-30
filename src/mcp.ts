import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCommon } from "./tools/common.js";
import { registerGoogle } from "./tools/google.js";
import { registerMicrosoft } from "./tools/microsoft.js";
import { registerCanva } from "./tools/canva.js";
import { registerGithub } from "./tools/github.js";
import { registerTeams } from "./tools/teams.js";
import { registerGitlab } from "./tools/gitlab.js";
import { registerCloudflare } from "./tools/cloudflare.js";
import { registerDiscord } from "./tools/discord.js";
import { registerFigma } from "./tools/figma.js";
import { registerSlack } from "./tools/slack.js";
import { registerNotion } from "./tools/notion.js";
import { registerLinear } from "./tools/linear.js";
import { registerAtlassian } from "./tools/atlassian.js";

/** A fresh server per request, so tools switched off in the admin UI disappear immediately. */
export function buildServer(): McpServer {
  const s = new McpServer({ name: "multi-account", version: "0.2.0" });
  registerCommon(s);
  registerGoogle(s);
  registerMicrosoft(s);
  registerCanva(s);
  registerGithub(s);
  registerTeams(s);
  registerGitlab(s);
  registerCloudflare(s);
  registerDiscord(s);
  registerFigma(s);
  registerSlack(s);
  registerNotion(s);
  registerLinear(s);
  registerAtlassian(s);
  return s;
}
