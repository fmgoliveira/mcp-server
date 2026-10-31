import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { account, tool } from "./common.js";
import { callCanvaMcp, listCanvaMcpTools } from "./canva-mcp.js";

const tx = z.string().describe("transaction_id from canva_edit_start");

/**
 * Editing existing Canva designs. The Connect REST API cannot do this, so these tools drive Canva's hosted MCP:
 * canva_edit_start → canva_edit_apply (repeat) → canva_edit_commit. Edits stay drafts until committed.
 */
export function registerCanvaEdit(server: McpServer) {
  tool(server, "canva_edit_start",
    "Open an editing transaction on an existing Canva design (first step of editing). Returns transaction_id, the pages, and the editable text/image elements with their element_ids (plus thumbnails). Nothing changes until canva_edit_commit.",
    { account, design_id: z.string() },
    ({ account: label, design_id }) => callCanvaMcp(label, "start-editing-transaction", { design_id }));

  tool(server, "canva_edit_apply",
    "Apply edit operations to an open transaction (draft only). `operations` uses Canva's operation objects, e.g. {type:'replace_text',element_id,text}, {type:'find_and_replace_text',...}, {type:'update_fill'|'insert_fill',...,asset_id}; call canva_mcp_tools for the exact schema. Pass `pages` from the previous response if it returned them. Batch several operations per call.",
    { account, transaction_id: tx, page_index: z.number().int().min(0).describe("Index of the first page being changed"), operations: z.array(z.record(z.string(), z.any())).min(1), pages: z.array(z.any()).optional().describe("The pages array from canva_edit_start / the last canva_edit_apply") },
    ({ account: label, ...args }) => callCanvaMcp(label, "perform-editing-operations", args));

  tool(server, "canva_edit_commit",
    "Save the draft edits of a transaction to the design. After this the transaction_id is invalid. If it fails because the design changed meanwhile, cancel, start a new transaction and re-apply.",
    { account, transaction_id: tx },
    ({ account: label, transaction_id }) => callCanvaMcp(label, "commit-editing-transaction", { transaction_id }),
    { destructive: true });

  tool(server, "canva_edit_cancel",
    "Discard an open editing transaction without saving.",
    { account, transaction_id: tx },
    ({ account: label, transaction_id }) => callCanvaMcp(label, "cancel-editing-transaction", { transaction_id }));

  tool(server, "canva_design_content",
    "Read a design's text content (and structure) through Canva's MCP, useful before editing. Optional `arguments` are passed to get-design-content as-is.",
    { account, design_id: z.string(), arguments: z.record(z.string(), z.any()).optional() },
    ({ account: label, design_id, arguments: extra }) => callCanvaMcp(label, "get-design-content", { ...extra, design_id }),
    { readOnly: true });

  tool(server, "canva_mcp_tools",
    "List the tools Canva's hosted MCP offers with their exact input schemas (use to check operation formats for canva_edit_apply).",
    { account },
    ({ account: label }) => listCanvaMcpTools(label),
    { readOnly: true });

  tool(server, "canva_mcp",
    "Call any Canva MCP tool by name (resize-design, merge-designs, comments, generate-design, …). Not available on read-only accounts. See canva_mcp_tools.",
    { account, tool: z.string().describe("Canva MCP tool name, e.g. 'resize-design'"), arguments: z.record(z.string(), z.any()).default({}) },
    ({ account: label, tool: name, arguments: args }) => callCanvaMcp(label, name, args),
    { destructive: true });
}
