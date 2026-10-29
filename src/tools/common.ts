import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { out } from "../api.js";
import { listAccounts, type Provider } from "../store.js";

export const account = z.string().describe("Label of a connected account (see list_accounts)");
export const accountOrAll = z
  .string()
  .optional()
  .describe('Account label, or omit / "all" to search every connected account of this provider');

export interface Hint {
  readOnly?: boolean;
  destructive?: boolean;
}

export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  hint: Hint = {},
) {
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
    async (args: any) => {
      try {
        return out(await handler(args));
      } catch (e: any) {
        return { isError: true, content: [{ type: "text" as const, text: String(e?.message ?? e) }] };
      }
    },
  );
}

/** Run fn for one account, or fan out over all accounts of a provider. */
export async function fanOut<T>(provider: Provider, acct: string | undefined, fn: (label: string) => Promise<T>) {
  if (acct && acct !== "all") return fn(acct);
  const accounts = listAccounts(provider);
  if (!accounts.length) throw new Error(`No ${provider} accounts connected`);
  const results = await Promise.all(
    accounts.map(async (a) => {
      try {
        return { account: a.label, result: await fn(a.label) };
      } catch (e: any) {
        return { account: a.label, error: String(e?.message ?? e) };
      }
    }),
  );
  return results;
}

export function registerCommon(server: McpServer) {
  tool(
    server,
    "list_accounts",
    "List connected accounts (Google, Microsoft 365, Canva, GitHub): labels, providers, emails/usernames. Use the label as the `account` argument of other tools.",
    {},
    async () =>
      listAccounts().map((a) => ({ label: a.label, provider: a.provider, email: a.email, addedAt: a.addedAt })),
    { readOnly: true },
  );
}
