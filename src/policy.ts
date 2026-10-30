// Rules that decide whether a tool call may run and which account it runs on. Pure functions over the store,
// so they are easy to test and the tool() wrapper stays small.
import { getState, listAccounts, type Provider } from "./store.js";

const PREFIXES: [string, Provider][] = [
  ["gmail_", "google"], ["calendar_", "google"], ["drive_", "google"], ["docs_", "google"], ["sheets_", "google"],
  ["slides_", "google"], ["forms_", "google"], ["google_", "google"],
  ["outlook_", "microsoft"], ["ms_calendar_", "microsoft"], ["onedrive_", "microsoft"], ["excel_", "microsoft"],
  ["graph_", "microsoft"], ["teams_", "microsoft"],
  ["canva_", "canva"], ["github_", "github"], ["gitlab_", "gitlab"], ["cloudflare_", "cloudflare"],
  ["discord_", "discord"], ["figma_", "figma"], ["slack_", "slack"], ["notion_", "notion"], ["linear_", "linear"],
  ["jira_", "atlassian"], ["confluence_", "atlassian"], ["atlassian_", "atlassian"],
];

export function providerOf(tool: string): Provider | undefined {
  return PREFIXES.find(([p]) => tool.startsWith(p))?.[1];
}

export class PolicyError extends Error {}

/** Turn the `account` argument into a concrete label. Empty means "the default account of this tool's service". */
export function resolveAccount(tool: string, given: string | undefined): string {
  const g = (given ?? "").trim();
  const state = getState();
  if (g && g !== "all") {
    if (state.accounts[g]) return g;
    const members = Object.values(state.accounts).filter((a) => a.group === g);
    if (members.length) {
      throw new PolicyError(`"${g}" is a group (${members.map((a) => a.label).join(", ")}). This tool works on one account: pass a single label.`);
    }
    return g; // unknown: let getAccount() produce the usual "Unknown account" message with the list
  }
  const provider = providerOf(tool);
  const pool = provider ? listAccounts(provider) : [];
  if (!pool.length) throw new PolicyError(provider ? `No ${provider} accounts are connected.` : "Pass an account label (see list_accounts).");
  const dflt = pool.find((a) => a.isDefault) ?? (pool.length === 1 ? pool[0] : undefined);
  if (!dflt) throw new PolicyError(`Several ${provider} accounts are connected (${pool.map((a) => a.label).join(", ")}). Pass \`account\`, or set a default in the admin UI.`);
  return dflt.label;
}

// Conservative on purpose: any mention of "mutation" in a GraphQL document counts, so a query can't smuggle one in.
const mentionsMutation = (q: string) => /\bmutation\b/i.test(q);

/** Read-only accounts may only use read-only tools, plus GET requests (or GraphQL queries) through the *_api escape hatches. */
export function assertAllowed(tool: string, hint: { readOnly?: boolean }, label: string | undefined, args: any): void {
  if (hint.readOnly || !label) return;
  const acc = getState().accounts[label];
  if (!acc?.readOnly) return;
  if (tool === "linear_api") {
    if (typeof args?.query === "string" && !mentionsMutation(args.query)) return;
  } else if (tool === "slack_api") {
    if (typeof args?.method === "string" && /\.(list|info|history|replies|search|get|read)$/.test(args.method)) return;
  } else if (tool.endsWith("_api")) {
    if (String(args?.method ?? "GET").toUpperCase() === "GET") return;
  }
  throw new PolicyError(`Account "${label}" is read-only, so "${tool}" is not allowed. Change it in the admin UI (Accounts → ${label}) if you want to allow changes.`);
}
