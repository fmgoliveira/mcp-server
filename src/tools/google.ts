import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

const g = (label: string, url: string, opts: Parameters<typeof api>[3] = {}) => api(label, "google", url, opts);
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const stripHtml = (h: string) =>
  h
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function header(msg: any, name: string): string | undefined {
  return msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function extractBody(part: any): { text?: string; html?: string; attachments: any[] } {
  const res: { text?: string; html?: string; attachments: any[] } = { attachments: [] };
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) res.attachments.push({ filename: p.filename, mimeType: p.mimeType, size: p.body.size, attachmentId: p.body.attachmentId });
    else if (p.mimeType === "text/plain" && p.body?.data && !res.text) res.text = fromB64u(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !res.html) res.html = fromB64u(p.body.data);
    (p.parts ?? []).forEach(walk);
  };
  walk(part);
  return res;
}

const encHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

async function buildRaw(
  label: string,
  a: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; html?: boolean; replyToMessageId?: string },
) {
  let threadId: string | undefined;
  const extra: string[] = [];
  let subject = a.subject;
  if (a.replyToMessageId) {
    const orig = await g(label, `${GMAIL}/messages/${a.replyToMessageId}`, {
      query: { format: "metadata", metadataHeaders: "Message-ID" },
    });
    threadId = orig.threadId;
    const mid = header(orig, "Message-ID");
    if (mid) extra.push(`In-Reply-To: ${mid}`, `References: ${mid}`);
  }
  const lines = [
    `To: ${a.to.join(", ")}`,
    ...(a.cc?.length ? [`Cc: ${a.cc.join(", ")}`] : []),
    ...(a.bcc?.length ? [`Bcc: ${a.bcc.join(", ")}`] : []),
    `Subject: ${encHeader(subject)}`,
    ...extra,
    "MIME-Version: 1.0",
    `Content-Type: text/${a.html ? "html" : "plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(a.body).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  ];
  return { raw: b64u(lines.join("\r\n")), threadId };
}

const mailShape = {
  account,
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  body: z.string(),
  html: z.boolean().optional().describe("Body is HTML"),
  replyToMessageId: z.string().optional().describe("Gmail message id to reply to (keeps the thread)"),
};

export function registerGoogle(server: McpServer) {
  // ---------- Gmail ----------
  tool(server, "gmail_search", "Search Gmail (Gmail search syntax, e.g. 'from:bob is:unread newer_than:7d'). Omit account to search all Google accounts.",
    { account: accountOrAll, query: z.string(), maxResults: z.number().int().min(1).max(50).default(10) },
    ({ account: acc, query, maxResults }) =>
      fanOut("google", acc, async (label) => {
        const list = await g(label, `${GMAIL}/messages`, { query: { q: query, maxResults } });
        return Promise.all(
          (list.messages ?? []).map(async (m: any) => {
            const meta = await g(label, `${GMAIL}/messages/${m.id}`, { query: { format: "metadata" } }).catch(() => null);
            if (!meta) return { id: m.id };
            return {
              id: m.id,
              threadId: m.threadId,
              from: header(meta, "From"),
              to: header(meta, "To"),
              subject: header(meta, "Subject"),
              date: header(meta, "Date"),
              snippet: meta.snippet,
              labels: meta.labelIds,
            };
          }),
        );
      }),
    { readOnly: true });

  tool(server, "gmail_read", "Read a Gmail message (headers, text body, attachment list).",
    { account, messageId: z.string() },
    async ({ account: label, messageId }) => {
      const m = await g(label, `${GMAIL}/messages/${messageId}`, { query: { format: "full" } });
      const b = extractBody(m.payload);
      return {
        id: m.id, threadId: m.threadId, labels: m.labelIds,
        from: header(m, "From"), to: header(m, "To"), cc: header(m, "Cc"), subject: header(m, "Subject"), date: header(m, "Date"),
        body: b.text ?? (b.html ? stripHtml(b.html) : m.snippet),
        attachments: b.attachments,
      };
    }, { readOnly: true });

  tool(server, "gmail_send", "Send an email from a Gmail account.", mailShape,
    async ({ account: label, ...a }) => {
      const { raw, threadId } = await buildRaw(label, a);
      return g(label, `${GMAIL}/messages/send`, { body: { raw, threadId } });
    });

  tool(server, "gmail_create_draft", "Create a Gmail draft (does not send).", mailShape,
    async ({ account: label, ...a }) => {
      const { raw, threadId } = await buildRaw(label, a);
      return g(label, `${GMAIL}/drafts`, { body: { message: { raw, threadId } } });
    });

  tool(server, "gmail_modify", "Change labels on a Gmail message: mark read (remove UNREAD), archive (remove INBOX), trash (add TRASH), star (add STARRED), or custom label ids.",
    { account, messageId: z.string(), addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional() },
    ({ account: label, messageId, addLabelIds, removeLabelIds }) =>
      g(label, `${GMAIL}/messages/${messageId}/modify`, { body: { addLabelIds, removeLabelIds } }));

  // ---------- Calendar ----------
  tool(server, "calendar_list_events", "List Google Calendar events in a time range. Omit account for all Google accounts. Times are RFC3339 (e.g. 2026-11-02T00:00:00Z).",
    { account: accountOrAll, timeMin: z.string(), timeMax: z.string(), calendarId: z.string().default("primary"), q: z.string().optional(), maxResults: z.number().int().max(250).default(50) },
    ({ account: acc, calendarId, ...rest }) =>
      fanOut("google", acc, async (label) => {
        const r = await g(label, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, {
          query: { ...rest, singleEvents: true, orderBy: "startTime" },
        });
        return (r.items ?? []).map((e: any) => ({
          id: e.id, summary: e.summary, start: e.start, end: e.end, location: e.location,
          attendees: e.attendees?.map((a: any) => `${a.email} (${a.responseStatus})`), meet: e.hangoutLink, status: e.status,
        }));
      }),
    { readOnly: true });

  const eventFields = {
    summary: z.string().optional(), description: z.string().optional(), location: z.string().optional(),
    start: z.string().optional().describe("RFC3339 dateTime, or YYYY-MM-DD for all-day"),
    end: z.string().optional().describe("RFC3339 dateTime, or YYYY-MM-DD for all-day (exclusive)"),
    timeZone: z.string().optional().describe("IANA zone, e.g. Europe/Lisbon"),
    attendees: z.array(z.string()).optional().describe("Attendee emails"),
  };
  const toEvent = (a: any) => {
    const t = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v, ...(a.timeZone ? { timeZone: a.timeZone } : {}) });
    return {
      summary: a.summary, description: a.description, location: a.location,
      ...(a.start ? { start: t(a.start) } : {}), ...(a.end ? { end: t(a.end) } : {}),
      ...(a.attendees ? { attendees: a.attendees.map((email: string) => ({ email })) } : {}),
    };
  };

  tool(server, "calendar_create_event", "Create a Google Calendar event (optionally with Google Meet and invites).",
    { account, calendarId: z.string().default("primary"), ...eventFields, addMeet: z.boolean().optional(), sendUpdates: z.enum(["all", "externalOnly", "none"]).default("none") },
    ({ account: label, calendarId, addMeet, sendUpdates, ...a }) =>
      g(label, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, {
        query: { sendUpdates, ...(addMeet ? { conferenceDataVersion: 1 } : {}) },
        body: { ...toEvent(a), ...(addMeet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}) },
      }));

  tool(server, "calendar_update_event", "Update fields of a Google Calendar event (only provided fields change).",
    { account, calendarId: z.string().default("primary"), eventId: z.string(), ...eventFields, sendUpdates: z.enum(["all", "externalOnly", "none"]).default("none") },
    ({ account: label, calendarId, eventId, sendUpdates, ...a }) =>
      g(label, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "PATCH", query: { sendUpdates }, body: toEvent(a) }));

  tool(server, "calendar_delete_event", "Delete a Google Calendar event.",
    { account, calendarId: z.string().default("primary"), eventId: z.string(), sendUpdates: z.enum(["all", "externalOnly", "none"]).default("none") },
    ({ account: label, calendarId, eventId, sendUpdates }) =>
      g(label, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "DELETE", query: { sendUpdates } }),
    { destructive: true });

  // ---------- Drive ----------
  tool(server, "drive_search", "Search Google Drive. `query` may be plain text (full-text search) or Drive query syntax (e.g. \"name contains 'budget' and mimeType='application/vnd.google-apps.spreadsheet'\"). Omit account for all Google accounts.",
    { account: accountOrAll, query: z.string(), pageSize: z.number().int().max(100).default(20) },
    ({ account: acc, query, pageSize }) =>
      fanOut("google", acc, async (label) => {
        const raw = /\b(contains|in parents|mimeType|trashed|modifiedTime|name\s*=)/.test(query);
        const q = raw ? query : `fullText contains '${query.replace(/['\\]/g, "\\$&")}' and trashed=false`;
        const r = await g(label, `${DRIVE}/files`, {
          query: { q, pageSize, fields: "files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,parents)", orderBy: "modifiedTime desc", supportsAllDrives: true, includeItemsFromAllDrives: true },
        });
        return r.files;
      }),
    { readOnly: true });

  tool(server, "drive_read", "Read a Drive file as text. Google Docs/Slides export as text, Sheets as CSV (first sheet; use sheets_get_values for others), plain-text files as-is.",
    { account, fileId: z.string() },
    async ({ account: label, fileId }) => {
      const meta = await g(label, `${DRIVE}/files/${fileId}`, { query: { fields: "id,name,mimeType,size,webViewLink", supportsAllDrives: true } });
      const m: string = meta.mimeType;
      let content: string;
      if (m === "application/vnd.google-apps.document" || m === "application/vnd.google-apps.presentation")
        content = await g(label, `${DRIVE}/files/${fileId}/export`, { query: { mimeType: "text/plain" }, raw: true });
      else if (m === "application/vnd.google-apps.spreadsheet")
        content = await g(label, `${DRIVE}/files/${fileId}/export`, { query: { mimeType: "text/csv" }, raw: true });
      else if (m.startsWith("text/") || /json|xml|javascript|markdown|csv/.test(m))
        content = await g(label, `${DRIVE}/files/${fileId}`, { query: { alt: "media", supportsAllDrives: true }, raw: true });
      else return { ...meta, note: "Binary or unsupported type; text extraction not available. Use webViewLink." };
      return { ...meta, content };
    }, { readOnly: true });

  tool(server, "drive_upload_text", "Create a file in Drive from text. Set convertTo to turn it into a native Google Doc (from text/html or text/plain) or Sheet (from CSV).",
    { account, name: z.string(), content: z.string(), mimeType: z.string().default("text/plain").describe("Mime type of `content`, e.g. text/plain, text/html, text/csv"), convertTo: z.enum(["doc", "sheet"]).optional(), parentId: z.string().optional() },
    ({ account: label, name, content, mimeType, convertTo, parentId }) => {
      const meta = {
        name, ...(parentId ? { parents: [parentId] } : {}),
        ...(convertTo ? { mimeType: convertTo === "doc" ? "application/vnd.google-apps.document" : "application/vnd.google-apps.spreadsheet" } : {}),
      };
      const boundary = "b" + crypto.randomUUID();
      const body = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`,
      );
      return g(label, "https://www.googleapis.com/upload/drive/v3/files", {
        method: "POST", query: { uploadType: "multipart", fields: "id,name,mimeType,webViewLink", supportsAllDrives: true },
        headers: { "content-type": `multipart/related; boundary=${boundary}` }, body,
      });
    });

  tool(server, "drive_update_file", "Rename, move (addParents/removeParents), or trash/untrash a Drive file.",
    { account, fileId: z.string(), name: z.string().optional(), addParents: z.string().optional().describe("Comma-separated folder ids"), removeParents: z.string().optional(), trashed: z.boolean().optional() },
    ({ account: label, fileId, name, addParents, removeParents, trashed }) =>
      g(label, `${DRIVE}/files/${fileId}`, {
        method: "PATCH", query: { addParents, removeParents, supportsAllDrives: true, fields: "id,name,parents,trashed,webViewLink" },
        body: { ...(name ? { name } : {}), ...(trashed !== undefined ? { trashed } : {}) },
      }), { destructive: true });

  tool(server, "drive_share", "Share a Drive file with a person (reader/commenter/writer).",
    { account, fileId: z.string(), email: z.string(), role: z.enum(["reader", "commenter", "writer"]).default("reader"), sendNotification: z.boolean().default(false) },
    ({ account: label, fileId, email, role, sendNotification }) =>
      g(label, `${DRIVE}/files/${fileId}/permissions`, { query: { sendNotificationEmail: sendNotification, supportsAllDrives: true }, body: { type: "user", role, emailAddress: email } }));

  // ---------- Docs ----------
  tool(server, "docs_get", "Read a Google Doc. Returns paragraphs with [startIndex-endIndex] so you can build docs_batch_update requests.",
    { account, documentId: z.string() },
    async ({ account: label, documentId }) => {
      const d = await g(label, `https://docs.googleapis.com/v1/documents/${documentId}`);
      const lines: string[] = [];
      for (const el of d.body?.content ?? []) {
        if (el.paragraph) {
          const t = (el.paragraph.elements ?? []).map((e: any) => e.textRun?.content ?? "").join("");
          lines.push(`[${el.startIndex ?? 0}-${el.endIndex}] ${el.paragraph.paragraphStyle?.namedStyleType ?? ""} ${t.replace(/\n$/, "")}`);
        } else if (el.table) lines.push(`[${el.startIndex}-${el.endIndex}] <table ${el.table.rows}x${el.table.columns}>`);
      }
      return { title: d.title, documentId: d.documentId, endIndex: d.body?.content?.at(-1)?.endIndex, text: lines.join("\n") };
    }, { readOnly: true });

  tool(server, "docs_create", "Create a Google Doc, optionally with initial plain-text content.",
    { account, title: z.string(), content: z.string().optional() },
    async ({ account: label, title, content }) => {
      const d = await g(label, "https://docs.googleapis.com/v1/documents", { body: { title } });
      if (content) await g(label, `https://docs.googleapis.com/v1/documents/${d.documentId}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: 1 }, text: content } }] } });
      return { documentId: d.documentId, url: `https://docs.google.com/document/d/${d.documentId}/edit` };
    });

  tool(server, "docs_batch_update", "Apply Google Docs API batchUpdate requests (insertText, replaceAllText, updateTextStyle, insertTable, …). See docs_get for indices.",
    { account, documentId: z.string(), requests: z.array(z.record(z.string(), z.any())) },
    ({ account: label, documentId, requests }) =>
      g(label, `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, { body: { requests } }));

  // ---------- Sheets ----------
  const SH = "https://sheets.googleapis.com/v4/spreadsheets";
  tool(server, "sheets_get", "Get spreadsheet metadata (title, sheet names/ids/sizes).",
    { account, spreadsheetId: z.string() },
    async ({ account: label, spreadsheetId }) => {
      const s = await g(label, `${SH}/${spreadsheetId}`, { query: { fields: "spreadsheetId,properties.title,sheets.properties" } });
      return s;
    }, { readOnly: true });

  tool(server, "sheets_get_values", "Read cell values from a range in A1 notation (e.g. 'Sheet1!A1:D20').",
    { account, spreadsheetId: z.string(), range: z.string(), formulas: z.boolean().default(false) },
    ({ account: label, spreadsheetId, range, formulas }) =>
      g(label, `${SH}/${spreadsheetId}/values/${encodeURIComponent(range)}`, { query: { valueRenderOption: formulas ? "FORMULA" : "FORMATTED_VALUE" } }),
    { readOnly: true });

  const vio = z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED");
  tool(server, "sheets_update_values", "Write values (2D array) to a range. USER_ENTERED lets formulas like =SUM(A1:A3) work.",
    { account, spreadsheetId: z.string(), range: z.string(), values: z.array(z.array(z.any())), valueInputOption: vio },
    ({ account: label, spreadsheetId, range, values, valueInputOption }) =>
      g(label, `${SH}/${spreadsheetId}/values/${encodeURIComponent(range)}`, { method: "PUT", query: { valueInputOption }, body: { range, values } }));

  tool(server, "sheets_append_values", "Append rows after the last row of a table in a range.",
    { account, spreadsheetId: z.string(), range: z.string(), values: z.array(z.array(z.any())), valueInputOption: vio },
    ({ account: label, spreadsheetId, range, values, valueInputOption }) =>
      g(label, `${SH}/${spreadsheetId}/values/${encodeURIComponent(range)}:append`, { query: { valueInputOption, insertDataOption: "INSERT_ROWS" }, body: { values } }));

  tool(server, "sheets_create", "Create a new spreadsheet.",
    { account, title: z.string(), sheetTitles: z.array(z.string()).optional() },
    async ({ account: label, title, sheetTitles }) => {
      const s = await g(label, SH, { body: { properties: { title }, ...(sheetTitles ? { sheets: sheetTitles.map((t) => ({ properties: { title: t } })) } : {}) } });
      return { spreadsheetId: s.spreadsheetId, url: s.spreadsheetUrl };
    });

  tool(server, "sheets_batch_update", "Apply Sheets API batchUpdate requests (addSheet, formatting, merge, charts, …).",
    { account, spreadsheetId: z.string(), requests: z.array(z.record(z.string(), z.any())) },
    ({ account: label, spreadsheetId, requests }) => g(label, `${SH}/${spreadsheetId}:batchUpdate`, { body: { requests } }));

  // ---------- Slides ----------
  const SL = "https://slides.googleapis.com/v1/presentations";
  tool(server, "slides_get", "Read a Google Slides presentation: slide object ids and the text of each shape (use ids in slides_batch_update).",
    { account, presentationId: z.string() },
    async ({ account: label, presentationId }) => {
      const p = await g(label, `${SL}/${presentationId}`);
      return {
        title: p.title,
        slides: (p.slides ?? []).map((s: any, i: number) => ({
          n: i + 1, objectId: s.objectId,
          elements: (s.pageElements ?? []).map((e: any) => ({
            objectId: e.objectId,
            kind: e.shape ? "shape" : e.table ? "table" : e.image ? "image" : "other",
            text: (e.shape?.text?.textElements ?? []).map((t: any) => t.textRun?.content ?? "").join("").trim() || undefined,
          })),
        })),
      };
    }, { readOnly: true });

  tool(server, "slides_create", "Create an empty Google Slides presentation.",
    { account, title: z.string() },
    async ({ account: label, title }) => {
      const p = await g(label, SL, { body: { title } });
      return { presentationId: p.presentationId, url: `https://docs.google.com/presentation/d/${p.presentationId}/edit`, firstSlideId: p.slides?.[0]?.objectId };
    });

  tool(server, "slides_batch_update", "Apply Slides API batchUpdate requests (createSlide, insertText, createShape, replaceAllText, …).",
    { account, presentationId: z.string(), requests: z.array(z.record(z.string(), z.any())) },
    ({ account: label, presentationId, requests }) => g(label, `${SL}/${presentationId}:batchUpdate`, { body: { requests } }));

  // ---------- Forms ----------
  const FM = "https://forms.googleapis.com/v1/forms";
  tool(server, "forms_get", "Get a Google Form (questions, settings).", { account, formId: z.string() },
    ({ account: label, formId }) => g(label, `${FM}/${formId}`), { readOnly: true });
  tool(server, "forms_create", "Create a Google Form (title only; add questions with forms_batch_update).",
    { account, title: z.string(), documentTitle: z.string().optional() },
    ({ account: label, title, documentTitle }) => g(label, FM, { body: { info: { title, ...(documentTitle ? { documentTitle } : {}) } } }));
  tool(server, "forms_batch_update", "Apply Forms API batchUpdate requests (createItem, updateItem, updateFormInfo, …).",
    { account, formId: z.string(), requests: z.array(z.record(z.string(), z.any())) },
    ({ account: label, formId, requests }) => g(label, `${FM}/${formId}:batchUpdate`, { body: { requests } }));
  tool(server, "forms_list_responses", "List responses submitted to a Google Form.",
    { account, formId: z.string(), pageSize: z.number().int().max(500).default(100) },
    ({ account: label, formId, pageSize }) => g(label, `${FM}/${formId}/responses`, { query: { pageSize } }), { readOnly: true });

  // ---------- Escape hatch ----------
  tool(server, "google_api", "Call any Google REST API (*.googleapis.com) with the account's token — for anything not covered above (Tasks, People, Gmail labels, Calendar ACLs, …). Scopes are limited to those granted at connection.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), url: z.string().describe("Full https URL"), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, url, query, body }) => g(label, url, { method, query, body }));
}
