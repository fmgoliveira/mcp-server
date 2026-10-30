import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

// Slack Web API. Errors come back as HTTP 200 with {ok:false,error}, so every call goes through sl() which throws on them.
// Bot tokens (xoxb-) can't use search; a user token (xoxp-) is needed for slack_search.
const SLACK = "https://slack.com/api/";
async function sl(label: string, method: string, params: Record<string, any> = {}, post = false) {
  const r = post
    ? await api(label, "slack", SLACK + method, { method: "POST", body: params })
    : await api(label, "slack", SLACK + method, { query: params });
  if (r?.ok === false) throw new Error(`Slack ${method}: ${r.error}${r.needed ? ` (needs scope ${r.needed})` : ""}`);
  return r;
}
const ts = (t?: string) => (t ? new Date(Number(t) * 1000).toISOString() : undefined);
const slimMsg = (m: any) => ({ ts: m.ts, time: ts(m.ts), user: m.user ?? m.username ?? m.bot_id, text: m.text, thread_ts: m.thread_ts !== m.ts ? m.thread_ts : undefined, replies: m.reply_count || undefined, files: m.files?.map((f: any) => f.name) });

export function registerSlack(server: McpServer) {
  tool(server, "slack_channels", "List Slack channels the token can see. Omit account for all Slack workspaces.",
    { account: accountOrAll, types: z.string().default("public_channel,private_channel").describe("Comma list: public_channel, private_channel, mpim, im"), limit: z.number().int().min(1).max(500).default(100) },
    ({ account: acc, types, limit }) =>
      fanOut("slack", acc, async (label) =>
        (await sl(label, "conversations.list", { types, limit, exclude_archived: true })).channels.map((c: any) => ({ id: c.id, name: c.name, private: c.is_private, member: c.is_member, members: c.num_members, topic: c.topic?.value || undefined }))),
    { readOnly: true });

  tool(server, "slack_history", "Recent messages in a channel (newest first). Use slack_thread to open a thread.",
    { account, channel: z.string().describe("Channel id, e.g. C0123ABC"), limit: z.number().int().min(1).max(200).default(30), oldest: z.string().optional().describe("Only messages after this ts"), latest: z.string().optional() },
    async ({ account: label, channel, limit, oldest, latest }) => (await sl(label, "conversations.history", { channel, limit, oldest, latest })).messages.map(slimMsg),
    { readOnly: true });

  tool(server, "slack_thread", "All replies in a thread.",
    { account, channel: z.string(), thread_ts: z.string(), limit: z.number().int().min(1).max(200).default(100) },
    async ({ account: label, channel, thread_ts, limit }) => (await sl(label, "conversations.replies", { channel, ts: thread_ts, limit })).messages.map(slimMsg),
    { readOnly: true });

  tool(server, "slack_search", "Search messages (needs a user token with search:read). Supports Slack operators like in:#channel from:@user. Omit account for all Slack workspaces.",
    { account: accountOrAll, query: z.string(), count: z.number().int().min(1).max(100).default(20) },
    ({ account: acc, query, count }) =>
      fanOut("slack", acc, async (label) =>
        (await sl(label, "search.messages", { query, count })).messages.matches.map((m: any) => ({ channel: m.channel?.name, user: m.username, time: ts(m.ts), ts: m.ts, text: m.text, link: m.permalink }))),
    { readOnly: true });

  tool(server, "slack_users", "List workspace members (name, title, id).",
    { account, limit: z.number().int().min(1).max(500).default(200) },
    async ({ account: label, limit }) =>
      (await sl(label, "users.list", { limit })).members.filter((u: any) => !u.deleted).map((u: any) => ({ id: u.id, name: u.name, real_name: u.real_name, title: u.profile?.title || undefined, bot: u.is_bot || undefined })),
    { readOnly: true });

  tool(server, "slack_send", "Post a message to a channel or thread. Visible to others: confirm the text with the user first.",
    { account, channel: z.string(), text: z.string(), thread_ts: z.string().optional() },
    async ({ account: label, channel, text, thread_ts }) => {
      const r = await sl(label, "chat.postMessage", { channel, text, thread_ts }, true);
      return { ok: true, channel: r.channel, ts: r.ts };
    },
    { destructive: true });

  tool(server, "slack_api", "Call any Slack Web API method, e.g. method \"reactions.add\" or \"conversations.info\", with `params`.",
    { account, method: z.string().describe("Slack method name, e.g. conversations.info"), params: z.record(z.string(), z.any()).optional() },
    ({ account: label, method, params }) => sl(label, method, params ?? {}, true),
    { destructive: true });
}
