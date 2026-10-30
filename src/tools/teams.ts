import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

// Microsoft Teams via Graph, using the Microsoft 365 accounts. Needs the Teams scopes (see MS_SCOPES in README); reconnect the account after adding them.
const GRAPH = "https://graph.microsoft.com/v1.0";
const g = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) => api(label, "microsoft", GRAPH + path, opts);
const top = z.number().int().min(1).max(50).default(20);

const slimMsg = (x: any) => ({
  id: x.id, from: x.from?.user?.displayName ?? x.from?.application?.displayName, created: x.createdDateTime,
  subject: x.subject || undefined, text: (x.body?.contentType === "html" ? String(x.body?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : x.body?.content)?.slice(0, 2000),
  url: x.webUrl,
});

export function registerTeams(server: McpServer) {
  tool(server, "teams_list", "List Microsoft Teams the user has joined (id, name). Omit account for all Microsoft accounts.",
    { account: accountOrAll },
    ({ account: acc }) =>
      fanOut("microsoft", acc, async (label) =>
        ((await g(label, "/me/joinedTeams")).value ?? []).map((t: any) => ({ id: t.id, name: t.displayName, description: t.description }))),
    { readOnly: true });

  tool(server, "teams_channels", "List channels of a team.",
    { account, team_id: z.string() },
    async ({ account: label, team_id }) =>
      ((await g(label, `/teams/${encodeURIComponent(team_id)}/channels`)).value ?? []).map((c: any) => ({ id: c.id, name: c.displayName, type: c.membershipType, url: c.webUrl })),
    { readOnly: true });

  tool(server, "teams_channel_messages", "Latest messages in a team channel (needs ChannelMessage.Read.All, which requires tenant admin consent).",
    { account, team_id: z.string(), channel_id: z.string(), top },
    async ({ account: label, team_id, channel_id, top }) =>
      ((await g(label, `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages`, { query: { $top: top } })).value ?? []).map(slimMsg),
    { readOnly: true });

  tool(server, "teams_send_channel_message", "Post a message to a team channel (or reply to a message with reply_to). Visible to the whole channel: confirm with the user first.",
    { account, team_id: z.string(), channel_id: z.string(), content: z.string(), html: z.boolean().default(false), reply_to: z.string().optional().describe("Message id to reply to") },
    async ({ account: label, team_id, channel_id, content, html, reply_to }) => {
      const base = `/teams/${encodeURIComponent(team_id)}/channels/${encodeURIComponent(channel_id)}/messages`;
      return slimMsg(await g(label, reply_to ? `${base}/${encodeURIComponent(reply_to)}/replies` : base, { method: "POST", body: { body: { contentType: html ? "html" : "text", content } } }));
    },
    { destructive: true });

  tool(server, "teams_chats", "List the user's recent 1:1 and group chats. Omit account for all Microsoft accounts.",
    { account: accountOrAll, top },
    ({ account: acc, top }) =>
      fanOut("microsoft", acc, async (label) =>
        ((await g(label, "/me/chats", { query: { $top: top, $expand: "members", $orderby: "lastMessagePreview/createdDateTime desc" } })).value ?? []).map((c: any) => ({
          id: c.id, type: c.chatType, topic: c.topic, members: c.members?.map((m: any) => m.displayName), updated: c.lastUpdatedDateTime, url: c.webUrl,
        }))),
    { readOnly: true });

  tool(server, "teams_chat_messages", "Latest messages in a chat.",
    { account, chat_id: z.string(), top },
    async ({ account: label, chat_id, top }) =>
      ((await g(label, `/chats/${encodeURIComponent(chat_id)}/messages`, { query: { $top: top } })).value ?? []).map(slimMsg),
    { readOnly: true });

  tool(server, "teams_send_chat_message", "Send a message in a chat. Sent as the user: confirm with the user first.",
    { account, chat_id: z.string(), content: z.string(), html: z.boolean().default(false) },
    async ({ account: label, chat_id, content, html }) =>
      slimMsg(await g(label, `/chats/${encodeURIComponent(chat_id)}/messages`, { method: "POST", body: { body: { contentType: html ? "html" : "text", content } } })),
    { destructive: true });
}
