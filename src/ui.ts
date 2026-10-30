// Shared HTML building blocks for the admin UI and the authorization page.
// Styles and behaviour live in public/assets (ui.css, admin.js); nothing is loaded from third parties.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Provider } from "./store.js";

// The stylesheet and script are fingerprinted so a browser (or a CDN in front of the server) never pairs new HTML with old assets.
const assetVersion = (() => {
  try {
    const h = createHash("sha1");
    for (const f of ["ui.css", "admin.js"]) h.update(readFileSync(fileURLToPath(new URL(`../public/assets/${f}`, import.meta.url))));
    return h.digest("hex").slice(0, 8);
  } catch {
    return "0";
  }
})();

export const REPO_URL = "https://github.com/fmgoliveira/mcp-server";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const META: Record<Provider, { name: string; abbr: string; color: string; blurb: string }> = {
  google: { name: "Google", abbr: "G", color: "#4285f4", blurb: "Gmail, Calendar, Drive, Docs" },
  microsoft: { name: "Microsoft 365", abbr: "M", color: "#0f6cbd", blurb: "Outlook, Calendar, OneDrive" },
  canva: { name: "Canva", abbr: "C", color: "#7d2ae8", blurb: "Designs, exports, folders" },
  github: { name: "GitHub", abbr: "GH", color: "#57606a", blurb: "Repos, issues, pull requests" },
  gitlab: { name: "GitLab", abbr: "GL", color: "#e24329", blurb: "Projects, merge requests, pipelines" },
  cloudflare: { name: "Cloudflare", abbr: "CF", color: "#c2410c", blurb: "Zones and DNS records" },
  discord: { name: "Discord", abbr: "D", color: "#5865f2", blurb: "Servers, channels, messages" },
  figma: { name: "Figma", abbr: "F", color: "#a259ff", blurb: "Files, comments, projects" },
  slack: { name: "Slack", abbr: "S", color: "#611f69", blurb: "Channels, messages, search" },
  notion: { name: "Notion", abbr: "N", color: "#37352f", blurb: "Pages, databases, search" },
  linear: { name: "Linear", abbr: "L", color: "#5e6ad2", blurb: "Issues, projects, comments" },
  atlassian: { name: "Jira and Confluence", abbr: "A", color: "#0052cc", blurb: "Issues, JQL, pages" },
};

export const badge = (p: Provider, large = false) =>
  `<span class="badge${large ? " badge-lg" : ""}" style="background:${META[p].color}" aria-hidden=true>${META[p].abbr}</span>`;

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width=16 height=16 fill=none stroke=currentColor stroke-width=2 stroke-linecap=round stroke-linejoin=round aria-hidden=true>${body}</svg>`;
export const icon = {
  copy: svg('<rect x=9 y=9 width=11 height=11 rx=2 /><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  more: svg('<circle cx=12 cy=5 r=1 /><circle cx=12 cy=12 r=1 /><circle cx=12 cy=19 r=1 />'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  edit: svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  download: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
};

const head = (title: string, script: boolean) => `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex>
<meta name=color-scheme content="light dark"><meta name=theme-color content="#0b3d36">
<title>${esc(title)}</title>
<link rel=icon href=/favicon.svg type=image/svg+xml><link rel=icon href=/favicon.ico sizes=any>
<link rel=apple-touch-icon href=/apple-touch-icon.png>
<link rel=stylesheet href="/assets/ui.css?v=${assetVersion}">${script ? `<script src="/assets/admin.js?v=${assetVersion}" defer></script>` : ""}`;

export type NavKey = "accounts" | "activity" | "tools" | "clients" | "settings";

/** Signed-in admin pages: top bar with navigation, connector URL and sign out. */
export function shell(o: { title: string; active: NavKey; mcpUrl: string; body: string }): string {
  const link = (key: NavKey, href: string, text: string) =>
    `<a href="${href}"${o.active === key ? " aria-current=page" : ""}>${text}</a>`;
  return `${head(`${o.title} · Multi-account MCP`, true)}
<body>
<header class=top><div class=wrap>
<a class=brand href=/admin><img src=/favicon.svg alt="">Multi-account MCP</a>
<nav class=nav aria-label=Main>${link("accounts", "/admin", "Accounts")}${link("activity", "/admin/activity", "Activity")}${link("tools", "/admin/tools", "Tools")}${link("clients", "/admin/clients", "Clients")}${link("settings", "/admin/settings", "Settings")}</nav>
<div class=top-end>
<button class="btn btn-quiet" type=button data-copy="${esc(o.mcpUrl)}" title="Paste this URL into Claude → Settings → Connectors">${icon.copy}<span data-copy-label>Connector URL</span></button>
<form method=post action=/admin/logout><button class="btn btn-quiet">Sign out</button></form>
</div></div></header>
<main><div class=wrap>${o.body}
<footer class=foot><span>Self-hosted and open source</span><a href="${REPO_URL}" rel=noopener>Source on GitHub</a></footer>
</div></main></body>`;
}

/** Centered single-card pages: sign in, authorize, OAuth results and errors. */
export function gate(title: string, inner: string): string {
  return `${head(title, false)}
<body><div class=gate><div class=gate-card>${inner}</div></div></body>`;
}

export function errorGate(title: string, message: string, back?: { href: string; text: string }): string {
  return gate(
    title,
    `<img class=gate-mark src=/favicon.svg alt="">
<div class=panel><h1>${esc(title)}</h1><pre>${esc(message)}</pre>
${back ? `<a class="btn btn-block" href="${esc(back.href)}">${esc(back.text)}</a>` : ""}</div>`,
  );
}
