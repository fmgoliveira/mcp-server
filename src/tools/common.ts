import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { out } from "../api.js";
import { assertAllowed, PolicyError, providerOf, resolveAccount } from "../policy.js";
import { getState, listAccounts, logActivity, type Provider } from "../store.js";

export const account = z
  .string()
  .default("")
  .describe("Label of a connected account (see list_accounts). Omit to use this service's default account, or its only one.");
export const accountOrAll = z
  .string()
  .optional()
  .describe('Account label or group name; omit or "all" to run on every connected account of this service');

export interface Hint {
  readOnly?: boolean;
  destructive?: boolean;
}

export interface ToolInfo {
  name: string;
  provider?: Provider;
  description: string;
  readOnly: boolean;
  destructive: boolean;
}
/** Every tool that has been defined, whether or not it is currently switched on. Filled when the server is built. */
export const TOOL_REGISTRY = new Map<string, ToolInfo>();

export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  hint: Hint = {},
) {
  const provider = providerOf(name);
  TOOL_REGISTRY.set(name, { name, provider, description, readOnly: !!hint.readOnly, destructive: !!hint.destructive });
  if (getState().settings.disabledTools.includes(name)) return; // switched off in the admin UI: Claude never sees it

  (server as any).registerTool(
    name,
    {
      description,
      inputSchema: shape,
      annotations: {
        readOnlyHint: !!hint.readOnly,
        destructiveHint: !!hint.destructive,
        openWorldHint: true,
      },
    },
    async (args: any, extra?: any) => {
      const started = Date.now();
      const client = String(extra?.authInfo?.clientId ?? "").slice(0, 8) || undefined;
      let target: string | undefined = typeof args?.account === "string" ? args.account : undefined;
      try {
        if ("account" in shape && account === (shape as any).account) {
          args.account = target = resolveAccount(name, args.account);
        } else if ("account" in shape) {
          target = typeof args.account === "string" ? args.account : undefined;
        }
        assertAllowed(name, hint, target, args);
        const result = await handler(args);
        log(true);
        return out(result);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        log(false, msg, e instanceof PolicyError);
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }

      function log(ok: boolean, error?: string, blocked?: boolean) {
        logActivity({ t: started, tool: name, provider, account: target || undefined, ok, ms: Date.now() - started, error: error?.split("\n")[0].slice(0, 200), blocked: blocked || undefined, client });
        if (client) {
          const c = Object.values(getState().clients).find((x: any) => String(x.client_id).startsWith(client));
          if (c) (c as any).last_used = started;
        }
      }
    },
  );
}

/** Run fn for one account, for a named group, or fan out over all accounts of a provider. */
export async function fanOut<T>(provider: Provider, acct: string | undefined, fn: (label: string) => Promise<T>) {
  let accounts = listAccounts(provider);
  if (acct && acct !== "all") {
    if (getState().accounts[acct]) return fn(acct);
    const members = accounts.filter((a) => a.group === acct);
    if (!members.length) return fn(acct); // unknown label: the usual error lists what is connected
    accounts = members;
  }
  if (!accounts.length) throw new Error(`No ${provider} accounts connected`);
  return Promise.all(
    accounts.map(async (a) => {
      try {
        return { account: a.label, result: await fn(a.label) };
      } catch (e: any) {
        return { account: a.label, error: String(e?.message ?? e) };
      }
    }),
  );
}

export function registerCommon(server: McpServer) {
  tool(
    server,
    "list_accounts",
    "List connected accounts with label, service, identity, group, read-only flag and whether it is the default for its service. Use the label (or a group name, where a tool accepts one) as the `account` argument of other tools.",
    {},
    async () =>
      listAccounts().map((a) => ({
        label: a.label,
        provider: a.provider,
        email: a.email,
        group: a.group,
        readOnly: a.readOnly || undefined,
        default: a.isDefault || undefined,
        status: a.health ? (a.health.ok ? "ok" : `failing: ${a.health.error ?? "unknown error"}`) : undefined,
        addedAt: a.addedAt,
      })),
    { readOnly: true },
  );
}
