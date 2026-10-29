import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { unzipSync, strFromU8 } from "fflate";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const m = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) =>
  api(label, "microsoft", path.startsWith("http") ? path : GRAPH + path, opts);

const recipients = (xs?: string[]) => xs?.map((address) => ({ emailAddress: { address } }));

function item(a: { itemId?: string; path?: string; driveId?: string }): string {
  if (a.itemId) return a.driveId ? `/drives/${a.driveId}/items/${a.itemId}` : `/me/drive/items/${a.itemId}`;
  if (a.path) return `/me/drive/root:/${a.path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}:`;
  throw new Error("Provide itemId or path");
}

const target = {
  itemId: z.string().optional().describe("Drive item id (from onedrive_search)"),
  path: z.string().optional().describe("Path in the user's OneDrive, e.g. Documents/plan.docx"),
  driveId: z.string().optional().describe("Drive id for SharePoint/other drives (with itemId)"),
};

async function download(label: string, base: string): Promise<Uint8Array> {
  const meta = await m(label, `${base}`, { query: { select: "@microsoft.graph.downloadUrl" } });
  const url = meta["@microsoft.graph.downloadUrl"];
  if (!url) throw new Error("No download URL");
  const r = await fetch(url); // pre-authenticated URL, no bearer
  if (!r.ok) throw new Error(`Download failed ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function officeText(name: string, bytes: Uint8Array): string | undefined {
  const lower = name.toLowerCase();
  const xmlText = (xml: string, para: string, run: string) =>
    xml
      .split(new RegExp(`</${para}>`))
      .map((p) => [...p.matchAll(new RegExp(`<${run}[^>]*>([^<]*)</${run}>`, "g"))].map((x) => x[1]).join(""))
      .filter(Boolean)
      .join("\n")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  if (lower.endsWith(".docx")) {
    const z = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
    return xmlText(strFromU8(z["word/document.xml"]), "w:p", "w:t");
  }
  if (lower.endsWith(".pptx")) {
    const z = unzipSync(bytes, { filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name) });
    return Object.keys(z)
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
      .map((k, i) => `--- Slide ${i + 1} ---\n${xmlText(strFromU8(z[k]), "a:p", "a:t")}`)
      .join("\n\n");
  }
  return undefined;
}

const sendShape = {
  account,
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  body: z.string(),
  html: z.boolean().optional().describe("Body is HTML"),
};

export function registerMicrosoft(server: McpServer) {
  // ---------- Outlook mail ----------
  tool(server, "outlook_search", "Search Outlook mail (KQL, e.g. 'from:bob subject:invoice'). Omit query to list newest messages. Omit account to search all Microsoft accounts.",
    { account: accountOrAll, query: z.string().optional(), folder: z.string().default("inbox").describe("Well-known folder (inbox, sentitems, drafts, archive, deleteditems) or id; ignored when query is set"), top: z.number().int().min(1).max(50).default(10) },
    ({ account: acc, query, folder, top }) =>
      fanOut("microsoft", acc, async (label) => {
        const select = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,conversationId,hasAttachments";
        const r = query
          ? await m(label, "/me/messages", { query: { $search: `"${query.replace(/"/g, "")}"`, $top: top, $select: select } })
          : await m(label, `/me/mailFolders/${folder}/messages`, { query: { $top: top, $select: select, $orderby: "receivedDateTime desc" } });
        return r.value;
      }),
    { readOnly: true });

  tool(server, "outlook_read", "Read an Outlook message (text body, recipients, attachment list).",
    { account, messageId: z.string() },
    async ({ account: label, messageId }) => {
      const msg = await m(label, `/me/messages/${messageId}`, { headers: { Prefer: 'outlook.body-content-type="text"' }, query: { $expand: "attachments($select=id,name,contentType,size)" } });
      return {
        id: msg.id, subject: msg.subject, from: msg.from, to: msg.toRecipients, cc: msg.ccRecipients, date: msg.receivedDateTime,
        body: msg.body?.content, attachments: msg.attachments,
      };
    }, { readOnly: true });

  const message = (a: any) => ({
    subject: a.subject,
    body: { contentType: a.html ? "HTML" : "Text", content: a.body },
    toRecipients: recipients(a.to), ccRecipients: recipients(a.cc), bccRecipients: recipients(a.bcc),
  });

  tool(server, "outlook_send", "Send an email from an Outlook / Microsoft 365 account.", sendShape,
    ({ account: label, ...a }) => m(label, "/me/sendMail", { body: { message: message(a), saveToSentItems: true } }));

  tool(server, "outlook_create_draft", "Create an Outlook draft (does not send).", sendShape,
    ({ account: label, ...a }) => m(label, "/me/messages", { body: message(a) }));

  tool(server, "outlook_reply", "Reply (or reply-all) to an Outlook message with a plain-text comment.",
    { account, messageId: z.string(), comment: z.string(), replyAll: z.boolean().default(false) },
    ({ account: label, messageId, comment, replyAll }) =>
      m(label, `/me/messages/${messageId}/${replyAll ? "replyAll" : "reply"}`, { body: { comment } }));

  tool(server, "outlook_update_message", "Mark an Outlook message read/unread, set categories, or move it (to inbox, archive, deleteditems, junkemail, or a folder id).",
    { account, messageId: z.string(), isRead: z.boolean().optional(), categories: z.array(z.string()).optional(), moveTo: z.string().optional() },
    async ({ account: label, messageId, isRead, categories, moveTo }) => {
      let res: any = { ok: true };
      if (isRead !== undefined || categories) res = await m(label, `/me/messages/${messageId}`, { method: "PATCH", body: { ...(isRead !== undefined ? { isRead } : {}), ...(categories ? { categories } : {}) } });
      if (moveTo) res = await m(label, `/me/messages/${messageId}/move`, { body: { destinationId: moveTo } });
      return { id: res.id, ok: true };
    }, { destructive: true });

  // ---------- Outlook calendar ----------
  tool(server, "ms_calendar_list_events", "List Outlook calendar events in a time range (ISO 8601). Omit account for all Microsoft accounts.",
    { account: accountOrAll, start: z.string(), end: z.string(), top: z.number().int().max(200).default(50), timeZone: z.string().default("UTC").describe("Zone for returned times, e.g. Europe/Lisbon") },
    ({ account: acc, start, end, top, timeZone }) =>
      fanOut("microsoft", acc, async (label) => {
        const r = await m(label, "/me/calendarView", {
          query: { startDateTime: start, endDateTime: end, $top: top, $orderby: "start/dateTime", $select: "id,subject,start,end,location,attendees,onlineMeeting,isCancelled,organizer" },
          headers: { Prefer: `outlook.timezone="${timeZone}"` },
        });
        return r.value;
      }),
    { readOnly: true });

  const ev = {
    subject: z.string().optional(), body: z.string().optional(), location: z.string().optional(),
    start: z.string().optional().describe("ISO 8601 local datetime, e.g. 2026-11-02T10:00:00"),
    end: z.string().optional(), timeZone: z.string().default("UTC"),
    attendees: z.array(z.string()).optional(), onlineMeeting: z.boolean().optional().describe("Add a Teams meeting"),
  };
  const toEv = (a: any) => ({
    ...(a.subject ? { subject: a.subject } : {}),
    ...(a.body ? { body: { contentType: "Text", content: a.body } } : {}),
    ...(a.location ? { location: { displayName: a.location } } : {}),
    ...(a.start ? { start: { dateTime: a.start, timeZone: a.timeZone } } : {}),
    ...(a.end ? { end: { dateTime: a.end, timeZone: a.timeZone } } : {}),
    ...(a.attendees ? { attendees: a.attendees.map((address: string) => ({ emailAddress: { address }, type: "required" })) } : {}),
    ...(a.onlineMeeting ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  });

  tool(server, "ms_calendar_create_event", "Create an Outlook calendar event (attendees are invited).", { account, ...ev },
    ({ account: label, ...a }) => m(label, "/me/events", { body: toEv(a) }));
  tool(server, "ms_calendar_update_event", "Update an Outlook calendar event (only provided fields change).", { account, eventId: z.string(), ...ev },
    ({ account: label, eventId, ...a }) => m(label, `/me/events/${eventId}`, { method: "PATCH", body: toEv(a) }));
  tool(server, "ms_calendar_delete_event", "Delete an Outlook calendar event.", { account, eventId: z.string() },
    ({ account: label, eventId }) => m(label, `/me/events/${eventId}`, { method: "DELETE" }), { destructive: true });

  // ---------- OneDrive / SharePoint ----------
  tool(server, "onedrive_search", "Search the account's OneDrive (and content shared with it). Omit account for all Microsoft accounts. For SharePoint sites use graph_api with /sites?search=.",
    { account: accountOrAll, query: z.string(), top: z.number().int().max(50).default(20) },
    ({ account: acc, query, top }) =>
      fanOut("microsoft", acc, async (label) => {
        const r = await m(label, `/me/drive/root/search(q='${query.replace(/'/g, "''")}')`, { query: { $top: top, $select: "id,name,size,webUrl,lastModifiedDateTime,file,folder,parentReference" } });
        return r.value;
      }),
    { readOnly: true });

  tool(server, "onedrive_list", "List children of a OneDrive folder (default: root).",
    { account, ...target, top: z.number().int().max(200).default(50) },
    ({ account: label, top, ...t }) =>
      m(label, `${t.itemId || t.path ? item(t) : "/me/drive/root"}/children`, { query: { $top: top, $select: "id,name,size,webUrl,lastModifiedDateTime,file,folder" } }).then((r) => r.value),
    { readOnly: true });

  tool(server, "onedrive_read", "Read a OneDrive/SharePoint file as text. Plain-text files as-is; .docx and .pptx text is extracted; for .xlsx use excel_get_range. Other binaries return metadata only.",
    { account, ...target },
    async ({ account: label, ...t }) => {
      const base = item(t);
      const meta = await m(label, base, { query: { $select: "id,name,size,webUrl,file" } });
      const name: string = meta.name;
      if (meta.size > 15 * 1024 * 1024) return { ...meta, note: "File too large to read" };
      const bytes = await download(label, base);
      const office = officeText(name, bytes);
      if (office !== undefined) return { id: meta.id, name, webUrl: meta.webUrl, content: office };
      if (/\.(txt|md|csv|json|xml|html?|log|ya?ml|js|ts|py)$/i.test(name) || /^text\//.test(meta.file?.mimeType ?? ""))
        return { id: meta.id, name, webUrl: meta.webUrl, content: new TextDecoder().decode(bytes) };
      return { id: meta.id, name, webUrl: meta.webUrl, note: "Unsupported binary type for text extraction" };
    }, { readOnly: true });

  tool(server, "onedrive_upload_text", "Create or overwrite a text file in OneDrive at a path (max ~4 MB).",
    { account, path: z.string().describe("e.g. Documents/notes.md"), content: z.string() },
    ({ account: label, path, content }) =>
      m(label, `${item({ path })}/content`, { method: "PUT", body: Buffer.from(content), headers: { "content-type": "text/plain" } }));

  tool(server, "onedrive_manage", "Rename (name), move (parentId) or delete a OneDrive item.",
    { account, ...target, name: z.string().optional(), parentId: z.string().optional().describe("Destination folder item id"), delete: z.boolean().optional() },
    ({ account: label, name, parentId, delete: del, ...t }) =>
      del
        ? m(label, item(t), { method: "DELETE" })
        : m(label, item(t), { method: "PATCH", body: { ...(name ? { name } : {}), ...(parentId ? { parentReference: { id: parentId } } : {}) } }),
    { destructive: true });

  // ---------- Excel (workbook API) ----------
  const ws = z.string().describe("Worksheet name");
  tool(server, "excel_list_worksheets", "List worksheets of an Excel workbook stored in OneDrive/SharePoint.", { account, ...target },
    ({ account: label, ...t }) => m(label, `${item(t)}/workbook/worksheets`, { query: { $select: "id,name,position" } }).then((r) => r.value), { readOnly: true });
  tool(server, "excel_get_range", "Read a range (e.g. A1:D20) from an Excel workbook (.xlsx) in OneDrive/SharePoint.",
    { account, ...target, worksheet: ws, address: z.string().describe("A1 range, e.g. A1:D20") },
    ({ account: label, worksheet, address, ...t }) =>
      m(label, `${item(t)}/workbook/worksheets/${encodeURIComponent(worksheet)}/range(address='${address}')`, { query: { $select: "address,values,formulas" } }),
    { readOnly: true });
  tool(server, "excel_update_range", "Write values/formulas (2D array) to a range in an Excel workbook; array size must match the range.",
    { account, ...target, worksheet: ws, address: z.string(), values: z.array(z.array(z.any())) },
    ({ account: label, worksheet, address, values, ...t }) =>
      m(label, `${item(t)}/workbook/worksheets/${encodeURIComponent(worksheet)}/range(address='${address}')`, { method: "PATCH", body: { values } }));

  // ---------- Escape hatch ----------
  tool(server, "graph_api", "Call any Microsoft Graph endpoint with the account's token — Teams, SharePoint sites, To Do, Planner, contacts, etc. Limited to the scopes granted at connection. `path` is relative to /v1.0 (e.g. /me/todo/lists) or a full graph.microsoft.com URL.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => m(label, path, { method, query, body }));
}
