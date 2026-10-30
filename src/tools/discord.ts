import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

// Discord via a bot token (user tokens are against Discord's ToS). The bot must be invited to the server;
// reading message text needs the "Message Content" privileged intent enabled for the bot in the Developer Portal.
const DC = "https://discord.com/api/v10";
const dc = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) => api(label, "discord", DC + path, opts);
const CHANNEL_TYPES: Record<number, string> = { 0: "text", 2: "voice", 4: "category", 5: "announcement", 13: "stage", 15: "forum" };

export function registerDiscord(server: McpServer) {
  tool(server, "discord_guilds", "List Discord servers the bot is in. Omit account for all Discord accounts.",
    { account: accountOrAll },
    ({ account: acc }) =>
      fanOut("discord", acc, async (label) => (await dc(label, "/users/@me/guilds")).map((g: any) => ({ id: g.id, name: g.name, owner: g.owner }))),
    { readOnly: true });

  tool(server, "discord_channels", "List channels of a server.",
    { account, guild_id: z.string() },
    async ({ account: label, guild_id }) =>
      (await dc(label, `/guilds/${guild_id}/channels`)).map((c: any) => ({ id: c.id, name: c.name, type: CHANNEL_TYPES[c.type] ?? c.type, parent_id: c.parent_id, topic: c.topic })),
    { readOnly: true });

  tool(server, "discord_messages", "Latest messages in a channel (newest first).",
    { account, channel_id: z.string(), limit: z.number().int().min(1).max(100).default(30), before: z.string().optional().describe("Message id to page backwards from") },
    async ({ account: label, channel_id, limit, before }) =>
      (await dc(label, `/channels/${channel_id}/messages`, { query: { limit, before } })).map((m: any) => ({
        id: m.id, author: m.author?.username, bot: m.author?.bot || undefined, time: m.timestamp, content: m.content,
        attachments: m.attachments?.map((a: any) => a.url), reply_to: m.referenced_message?.id,
      })),
    { readOnly: true });

  tool(server, "discord_send", "Send a message to a channel as the bot (or reply with reply_to). Public to everyone in the channel: confirm with the user first.",
    { account, channel_id: z.string(), content: z.string().max(2000), reply_to: z.string().optional() },
    async ({ account: label, channel_id, content, reply_to }) => {
      const m = await dc(label, `/channels/${channel_id}/messages`, {
        method: "POST", body: { content, allowed_mentions: { parse: [] }, ...(reply_to ? { message_reference: { message_id: reply_to } } : {}) },
      });
      return { id: m.id, channel_id: m.channel_id };
    },
    { destructive: true });

  tool(server, "discord_api", "Call any Discord REST endpoint (discord.com/api/v10) as the bot — members, roles, threads, scheduled events, etc. `path` like /guilds/{id}/members?limit=50.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => dc(label, path, { method, query, body }),
    { destructive: true });
}
