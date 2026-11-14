# DOM Inspector

**Pick an element in your running app, land on the line of code that renders it, and hand it to whichever AI assistant you use, without leaving the editor.**

DOM Inspector is an extension for VS Code and its forks (Cursor, Kiro, Windsurf, VSCodium…), plus a small [Model Context Protocol](https://modelcontextprotocol.io) server. The extension opens your dev server inside an editor tab, overlays Chrome DevTools-style inspection on the page, finds the source file for whatever you click, and lets you edit CSS live. It is **AI-provider agnostic**: it never calls a model itself. Instead it writes a Markdown snapshot of the element and hands it to your assistant through that assistant's own "add to chat" command. Claude Code, Cursor Chat, Kiro, GitHub Copilot Chat, Cline, Roo Code and Continue work out of the box; anything else works through a configurable command, the clipboard, or MCP. The MCP server exposes the selected element and your style edits to any MCP client.

> For the full product and implementation spec (architecture, protocols, data model, known gaps, roadmap), see [PRODUCT.md](PRODUCT.md).

---

## Table of contents

- [What's in this repo](#whats-in-this-repo)
- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [AI integration (MCP)](#ai-integration-mcp)
- [How source resolution works](#how-source-resolution-works)
- [Framework support](#framework-support)
- [Configuration](#configuration)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Security notes](#security-notes)
- [License](#license)

---

## What's in this repo

One package: the editor extension, with the MCP server bundled inside it.

| Path | What it is |
|---|---|
| [`src/`](src/) | All source code. The extension runs in the editor's extension host; [`src/mcp-server/`](src/mcp-server/) is a separate Node program (an Express HTTP bridge on `127.0.0.1:3100` plus an MCP server on stdio) that AI clients start themselves. Several clients can each run a copy; they share one bridge. |
| [`tests/`](tests/) | vitest (+ fast-check) tests of the real modules. |
| [`rebuild-all.sh`](rebuild-all.sh) | Bumps the version, builds, packages the VSIX and installs it with `$EDITOR_CLI` (default `kiro`; e.g. `EDITOR_CLI=cursor`). |
| [`PRODUCT.md`](PRODUCT.md) | Product and implementation document. |

Build output is not committed; `pnpm build` regenerates it: `out/` (the compiled extension), `mcp-server/index.js` (the MCP server bundled with its dependencies by esbuild) and `*.vsix`.

```
.
├── src/
│   ├── extension.ts             # activation, commands, orchestration (pick → source → sidebar → AI)
│   ├── types.ts                 # shared types and the BridgeMessage union
│   ├── browser/
│   │   ├── proxy.ts             # reverse proxy: script injection, header stripping, redirects, WebSocket tunnel
│   │   ├── page-channel.ts      # HTTP page channel (SSE + POST, per-session token) for browsers we don't own
│   │   ├── browsers.ts          # browser choice (integrated / Cursor / Simple / panel / external)
│   │   └── panel.ts             # DOM Inspector's own panel: HTML + typed message relay, heartbeat
│   ├── source/
│   │   ├── source-mapper.ts     # DOM element -> file:line (5-strategy chain)
│   │   ├── stack-source.ts      # React owner-stack position -> original line (source maps)
│   │   └── editor.ts            # open the file, select the element's tag range, read a snippet
│   ├── ai/
│   │   ├── context.ts           # element -> Markdown snapshot (provider-neutral)
│   │   ├── targets.ts           # delivery to Claude Code, Cursor, Kiro, Copilot, Cline, Roo, Continue, custom, clipboard
│   │   ├── mcp-config.ts        # writes MCP client config files (JSON, YAML, TOML)
│   │   └── mcp.ts               # MCP setup commands + POSTs to the MCP HTTP bridge
│   ├── ui/
│   │   ├── sidebar.ts           # DevTools-style sidebar webview provider
│   │   └── breadcrumb.ts        # component path in the status bar
│   ├── webview/                 # browser-side code, plain files (see Development)
│   │   ├── inspector.js         # injected into every proxied page
│   │   ├── sidebar.html         # sidebar document ({{style}}, {{script}})
│   │   ├── sidebar.css
│   │   ├── sidebar.js
│   │   └── assets.ts            # loads the files above
│   └── mcp-server/              # the MCP server (own process; bundled by esbuild)
│       ├── index.ts             # entry: start HTTP bridge + stdio MCP server
│       ├── bridge-mode.ts       # leader/follower port sharing between MCP instances
│       ├── http.ts              # Express routes: /selection, /style-change
│       ├── mcp.ts               # MCP resource + prompts
│       ├── formatters.ts        # selection -> Markdown
│       ├── state.ts             # in-memory selection store
│       └── types.ts             # Zod schemas
├── tests/
├── media/inspect.svg            # activity bar icon
├── package.json
├── tsconfig.json                # type-checks all of src/ (pnpm typecheck)
├── tsconfig.build.json          # compiles the extension to out/ (the MCP server is left to esbuild)
├── .vscodeignore                # allowlist of what goes into the VSIX
├── rebuild-all.sh
├── PRODUCT.md
└── README.md
```

---

## How it works

```
 ┌───────────────────────────── Editor (VS Code / Kiro / Cursor) ─────────────────────────────┐
 │                                                                                            │
 │  Browser panel (webview)            Extension host                    Sidebar (webview)    │
 │  ┌──────────────────────┐   postMessage   ┌──────────────────┐  postMessage  ┌──────────┐ │
 │  │ toolbar + <iframe>   │◄──────────────►│ BridgeChannel     │◄────────────►│ Elements │ │
 │  │   ▲                  │                 │ SourceMapper      │               │ Styles   │ │
 │  │   │ page + injected  │                 │ Breadcrumb        │               │ Computed │ │
 │  │   │ inspector script │                 │ editor highlight  │               │ Console  │ │
 │  └───┼──────────────────┘                 └───────┬───────────┘               └──────────┘ │
 │      │ http://127.0.0.1:<random>                  │ HTTP POST /selection, /style-change    │
 └──────┼────────────────────────────────────────────┼─────────────────────────────────────────┘
        │                                            ▼
 ┌──────┴────────────┐                     ┌───────────────────────────┐   stdio   ┌──────────────┐
 │ Reverse proxy     │──► your dev server  │ MCP server process        │◄────────►│ AI assistant │
 │ (inside extension)│    e.g. :5173       │ HTTP bridge 127.0.0.1:3100│           │ (MCP client) │
 └───────────────────┘                     │ in-memory selection state │           └──────────────┘
                                           └───────────────────────────┘
```

1. **Open URL** starts a local reverse proxy that forwards to your dev server. HTML responses get the inspector script injected before `</body>`, and the `X-Frame-Options` and CSP headers are stripped so the page can render in an iframe.
2. The browser panel is a webview with an iframe pointed at the proxy. A small relay script forwards typed messages between the page and the extension host.
3. **Inspect Element** puts the page into picking mode. Hovering draws box-model overlays and a tooltip; clicking captures a full snapshot of the element: identity, attributes, box model, computed styles, matching CSS rules, XPath, CSS path and framework component info.
4. The extension host resolves the element to a source file and line, opens it in the second editor column and highlights the element's full tag range. It also updates the sidebar and the status-bar breadcrumb, and POSTs the selection to the MCP server's HTTP bridge.
5. You send the element to your AI assistant: right-click it and choose **Send to ‹assistant›**, or run a `[DOM] …` command. The extension writes a Markdown snapshot and passes it to the assistant's own chat. MCP-capable assistants can also read the current selection from the MCP server at any time.

---

## Features

### Use the editor's own browser, or ours
**Open URL** shows your app in the browser set by `domInspector.browser`. **DOM Inspector: Choose Browser…** switches it and reopens the page.

| Choice | What you get |
|---|---|
| `auto` (default) | The editor's own browser if it has one, otherwise the DOM Inspector panel. |
| `integrated` | **VS Code's integrated browser** (`workbench.action.browser.open`): a real Chromium view with navigation, its own DevTools and device emulation. |
| `cursor` | **Cursor's browser tab** (`workbench.action.openBrowserEditor`). |
| `simple` | VS Code's **Simple Browser**. |
| `panel` | **DOM Inspector's own panel**: reload button, URL display and an inspect toggle that pulses while picking. |
| `external` | **Your system browser** (Chrome, Firefox…). Picks still jump to source in the editor. |

Every option loads the page through DOM Inspector's local proxy, which injects the inspector. Inside our panel, the inspector talks to the extension with `postMessage`. Everywhere else it uses a private HTTP channel on the proxy itself: Server-Sent Events in one direction and POSTs in the other, guarded by a per-session token. So picking, the right-click menu, jump to source, live style edits and Send to AI work the same in every browser.

Common to all browsers:
- The sidebar has an omnibox with **URL history**: the last 50 URLs persist across sessions, the 10 most recent show on focus, it filters as you type, and you can choose an entry with ↑/↓ and Enter. Deep links (`/dashboard?tab=2#x`) open at that path.
- The proxy tunnels WebSocket upgrades to the dev server, so hot reload (Vite, webpack, Next.js…) keeps working.
- The proxy follows redirects by rewriting `Location` headers to proxy-relative paths. It requests uncompressed HTML from upstream, and still handles gzip, brotli or deflate if the server compresses anyway.

### Visual inspection
- **Hover**: four colour-coded overlays (content, padding, border, margin) plus a tooltip showing `tag#id.classes`, `W × H`, text colour (swatch and hex), font and padding. Hover handling is throttled with `requestAnimationFrame`.
- **Click to pick**: page clicks are swallowed while picking, so links and buttons don't fire. The picked element stays outlined (a `.dom-inspector-selected` class) even through layout shifts.
- **Keyboard while picking**: **↑** selects the parent, **↓** the child under the cursor (including `pointer-events: none` children), **← / →** cycle through everything stacked under the cursor (to reach content beneath transparent overlays), **Enter** picks, **Escape** cancels. A click after navigating picks the navigated element. The tooltip shows these keys.
- **SVG icons**: hovering a `<path>` inside an icon selects the whole `<svg>`; press ↓ to go inside.
- Once the page settles after load (no DOM mutations for 300 ms, or 2 s at most) the inspector reports ready. The extension then loads the full DOM tree and selects `<body>` so the sidebar has content straight away.

### Jump to source
- A four-strategy resolver (framework debug info → component filename → `data-*` hints → scored grep) finds the file and line. See [How source resolution works](#how-source-resolution-works).
- The file opens in **column two**. The editor selects from the opening tag to its matching closing tag, handling self-closing and multi-line tags (it scans up to 200 lines), and adds a blue highlight that fades after 10 seconds.

### Sidebar (DevTools-style)
Open it from the **DOM Inspector** icon in the activity bar.

| Tab | What you get |
|---|---|
| **Elements** | The full DOM tree from `<html>`, with `<head>`, `<script>`, `<link>`, `<style>` and `<noscript>` skipped. The first two levels are expanded, other branches load children on demand, and each level shows up to 500 nodes. Picking an element expands the tree down to it and highlights it. |
| **Styles** | The CSS rules that match the picked element, inline `element.style` first. Rules come from regular and adopted stylesheets, including inside `@media`, `@supports` and `@layer`. Each property has a checkbox to toggle it and a type-aware editor: a colour picker plus text for colours, a dropdown for keyword properties (`display`, `position`, `flex-direction`…), and free text otherwise. You can add a property to any rule, with autocomplete over every CSS property the browser knows. Edits apply live in the page. |
| **Computed** | A box-model diagram, then computed styles grouped into accordions (Typography, Box Model, Layout & Positioning, Colours & Backgrounds, Visual Effects, Transitions & Animations, Generated Content & Lists, Specialised, Other). By default it shows only values that differ from a bare element of the same tag; **Show all** lists everything, and there's a text filter. |
| **Console** | A timestamped log of what the extension is doing: bridge messages, source-mapper results, MCP POST results. It's the first place to look when something doesn't work. |

### Component breadcrumb
When a framework is detected, the status bar shows the component chain of the picked element (`$(symbol-class) App > Layout > Header > NavButton`). Clicking it opens a quick pick of the components; choosing the innermost one opens its source file when the framework reported one.

### Send to any AI assistant
Right-click any element in the inspected page (in whichever browser shows it):

| Menu item | What it does |
|---|---|
| **Send to ‹assistant›** | Adds the element to your assistant's chat input, in your *current* conversation. The label shows the assistant in use, e.g. "Send to Claude Code" or "Send to Cursor Chat". |
| **Send to…** | Lets you pick another installed assistant; your choice is remembered for this workspace. |
| **Copy as Markdown** | Puts the element context on the clipboard, to paste anywhere (ChatGPT, Gemini, a terminal agent, an issue…). |
| **Inspect element** | Same as picking with the inspector: jumps to the source and updates the sidebar. |

**Shift + right-click** shows the page's own context menu instead. Escape or a click elsewhere closes ours.

What the assistant receives is a Markdown **snapshot** of the element:
- the resolved source file and lines, plus the code excerpt
- tag, id, classes, CSS path, XPath and component path
- text and attributes
- matched CSS rules and non-default computed styles
- the HTML
- for the `[DOM]` commands, a **Task** section (analyze, apply style edits, remove)

Snapshots are written to `<workspace>/.dom-inspector/`. That folder contains its own `.gitignore` (`*`), so git never sees it, and only the newest 20 snapshots are kept.

**Supported assistants.** Each one uses that tool's own command, checked against its shipped code:

| Assistant | Detected when | Delivered via |
|---|---|---|
| Claude Code | `anthropic.claude-code` installed | `claude-vscode.insertAtMention`: an `@.dom-inspector/…md` mention in the chat input |
| Cursor Chat | running in Cursor | `composer.addfilestocomposer`: the snapshot is attached to the current chat |
| Kiro | running in Kiro | `kiroAgent.selectFilesAsContext`: a `#[[file:…]]` reference |
| GitHub Copilot Chat | `GitHub.copilot-chat` installed | `workbench.action.chat.open` with the snapshot in `attachFiles` |
| Cline | `saoudrizwan.claude-dev` installed | `cline.addToChat`: the snapshot is added to the input |
| Roo Code | `RooVeterinaryInc.roo-cline` installed | `roo-cline.addToContext` |
| Continue | `Continue.continue` installed | `continue.selectFilesAsContext` |
| Anything else | `domInspector.ai.customCommand` set | your command, with `${file}`, `${path}`, `${relativePath}`, `${markdown}`, `${prompt}` placeholders |
| Clipboard | always | copies the Markdown |

With the default `domInspector.ai.target: auto`, the assistant you last chose with **Send to…** is used. If you haven't chosen one, it takes the first available in the order above: a custom command first, then dedicated agent extensions, then the editor's built-in chat. Run **DOM Inspector: Choose AI Assistant…**, or set `domInspector.ai.target`, to change it. If delivery fails, the context is copied to the clipboard and you're told so.

<details>
<summary>Custom command example: an extension with an "add file to chat" command</summary>

```jsonc
// settings.json
"domInspector.ai.target": "custom",
"domInspector.ai.customCommand": "someAiExtension.addFileToChat",
"domInspector.ai.customArgs": ["${file}"],
// for commands that read the active editor's selection instead:
"domInspector.ai.customSelectSnapshot": true
```
</details>

### AI hand-off commands
- `[DOM] Send element to AI`, `[DOM] Analyze element`, `[DOM] Apply style edits to source` and `[DOM] Remove element from source` send the **last picked element** to your assistant with a matching task. They don't need the MCP server.
- Style edits made in the Styles tab are recorded per property, keeping the original value, and listed in the **Apply style edits** task. The assistant is asked to write them back into your source, using Tailwind utilities if the project uses Tailwind.
- For MCP clients, the same selection is exposed as a **resource** (`[DOM] Select node`) and three **prompts** (`[DOM] Analyze node`, `[DOM] Apply styles`, `[DOM] Remove node`). See [AI integration](#ai-integration-mcp).

---

## Requirements

| | Version |
|---|---|
| Editor | VS Code ≥ 1.95, or a fork built on it (Kiro, Cursor, Windsurf…) |
| Node.js | ≥ 20 for development; the bundled MCP server targets Node 18+ and is launched with `node` |
| pnpm | for building (tested with pnpm 10+) |
| `grep` | on `PATH`, used by the source mapper's fallback (macOS and Linux) |

---

## Installation

### From a VSIX

```bash
# pick the CLI for your editor
kiro   --install-extension dom-inspector-<version>.vsix --force
code   --install-extension dom-inspector-<version>.vsix --force
cursor --install-extension dom-inspector-<version>.vsix --force
```

Reload the window afterwards.

### From source

```bash
git clone https://github.com/Laravel42/vscode-ide-extensions.git
cd vscode-ide-extensions
pnpm install
pnpm package                     # bump patch, type-check, tsc -> out/, esbuild -> mcp-server/index.js, vsce -> .vsix
code --install-extension "dom-inspector-$(node -p "require('./package.json').version").vsix" --force
```

Or run `./rebuild-all.sh`, which does the same and installs with `$EDITOR_CLI`.

To develop without packaging, open the repo in VS Code, run `pnpm build`, and press **F5** to start an Extension Development Host. You'll need to add a `launch.json` first, because `.vscode/` is git-ignored.

---

## Usage

1. **Start your dev server**, e.g. `npm run dev` → `http://localhost:5173`.
2. **Open it**: run **DOM Inspector: Open URL** (`Ctrl+Shift+U` / `⌘⇧U`), or type the URL into the sidebar omnibox. The command's prompt defaults to `http://localhost:5173`.
3. **Inspect**: run **DOM Inspector: Inspect Element** (`Ctrl+Shift+I` / `⌘⇧I`), use the sidebar's inspect button, or the panel toolbar's when you use the panel. Hover to preview, click to pick, Escape to cancel. You can also skip picking mode entirely: right-click any element → **Inspect element**.
4. **Read the result**: the source file opens beside the browser with the element highlighted. The sidebar's Styles and Computed tabs show its CSS, and the status bar shows its component path.
5. **Tweak styles**: in **Styles**, change values, toggle properties or add new ones. The page updates immediately.
6. **Hand off to AI**: right-click the element → **Send to ‹assistant›**, or run **[DOM] Apply style edits to source** to have the assistant write your tweaks into the source. **[DOM] Analyze element** and **[DOM] Remove element from source** work the same way.

### Commands

| Command | Default keybinding | What it does |
|---|---|---|
| `DOM Inspector: Open URL` | `Ctrl+Shift+U` / `⌘⇧U` | Prompts for a URL, starts the proxy, opens or reuses the browser panel. |
| `DOM Inspector: Inspect Element` | `Ctrl+Shift+I` / `⌘⇧I` | Enters picking mode (a browser panel must be open). |
| `[DOM] Send element to AI` | — | Sends the last picked element to your assistant. |
| `[DOM] Analyze element (a11y, locators)` | — | Same, with a task: purpose, accessibility, Playwright and Cypress locators, fragile patterns, improvements. |
| `[DOM] Apply style edits to source` | — | Same, with your recorded Styles-tab edits and instructions to apply them in the source. |
| `[DOM] Remove element from source` | — | Same, with instructions to remove the element and clean up. |
| `DOM Inspector: Choose Browser…` | — | Picks where pages open (integrated browser, Cursor browser, Simple Browser, panel, system browser) and reopens the current page there. |
| `DOM Inspector: Choose AI Assistant…` | — | Picks which installed assistant **Send to AI** uses (remembered per workspace). |
| `DOM Inspector: Set Up MCP for AI Tools…` | — | Registers the MCP server with the AI tools you select (see below). |

> On Linux and Windows, `Ctrl+Shift+U` (Show Output) and `Ctrl+Shift+I` (Format Document) collide with built-in VS Code bindings. Rebind them in **Keyboard Shortcuts** if that gets in your way.

---

## AI integration (MCP)

MCP is the second, optional channel. It lets an assistant *pull* the current selection whenever it wants, instead of you pushing it with **Send to AI**.

### Setup

- **Your editor's own AI is configured automatically** on activation. Disable this with `domInspector.mcp.autoConfigure: false`.

  | Editor | Config file |
  |---|---|
  | Kiro | `.kiro/settings/mcp.json` |
  | Cursor | `.cursor/mcp.json` |
  | VS Code (Copilot agent mode) | `.vscode/mcp.json` |

  The entry points at the server bundled inside the installed extension, `<extension>/mcp-server/index.js`, and is refreshed after every upgrade.
- **For other AI tools**, run **DOM Inspector: Set Up MCP for AI Tools…** and tick the ones you use:

  | Tool | File written |
  |---|---|
  | Claude Code | `.mcp.json` |
  | Roo Code | `.roo/mcp.json` |
  | Gemini CLI | `.gemini/settings.json` |
  | Continue | `.continue/mcpServers/dom-inspector.yaml` |
  | Cline | its global `cline_mcp_settings.json` |
  | Windsurf | `~/.codeium/windsurf/mcp_config.json` |
  | Codex CLI | `~/.codex/config.toml` |

  How existing files are handled:
  - Other servers and your own tweaks to our entry are kept; only `command` and `args` are refreshed.
  - Files are rewritten only when something changed.
  - A config file the extension can't parse safely, such as JSON with comments, is reported and left untouched.
  - **Copy server config as JSON** gives you the snippet for any other MCP client.

The equivalent manual command for Claude Code is:

```bash
claude mcp add dom-inspector -e DOM_INSPECTOR_PORT=3100 -- node /absolute/path/to/mcp-server/index.js
```

**Several AI tools at once.** Each MCP client starts its own copy of the server:
- The first copy owns the HTTP bridge port that the extension posts picks to.
- Later copies detect it (via `GET /health`) and read the selection from it.
- If the owner exits, the next copy takes over the port.
- No process is ever killed: if an unrelated program holds the port, the server says so. Pick another port with `domInspector.mcp.port`, which is written into the configs as `DOM_INSPECTOR_PORT`.

> The bridge only exists while some MCP client is running the server. Without one, **Send to AI** and the `[DOM]` commands still work, because they don't use MCP; the Console tab just logs that the MCP POST failed. For testing, run `pnpm bundle-mcp && node mcp-server/index.js` yourself.

### What the server exposes

| Kind | Name | URI / arguments | Returns |
|---|---|---|---|
| Resource | `[DOM] Select node` | `dom-inspector://selected-node` | Markdown: page URL, source `file:line`, tag, id, classes, text, role, aria-label, selector, XPath, component path, attributes, an HTML snippet (≤1,500 chars) and a timestamp. |
| Prompt | `[DOM] Analyze node` | none | The selection plus a request for purpose, accessibility issues, Playwright and Cypress locators, fragile selector patterns and markup improvements. |
| Prompt | `[DOM] Apply styles` | none | The selection plus the list of recorded `property: old → new` changes and instructions (Tailwind, CSS modules or styled-components aware; only touch the listed properties). |
| Prompt | `[DOM] Remove node` | none | The selection plus instructions to remove it from the JSX/HTML and clean up unused imports, variables and styles. |

With nothing selected, the resource and prompts return short instructions on how to pick an element.

### HTTP bridge API

The bridge listens on `127.0.0.1:${DOM_INSPECTOR_PORT:-3100}`, accepts JSON bodies up to 100 kB, and validates them with Zod.

| Method | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/selection` | `SelectedDomNode` (below) | Replaces the current selection and resets its style changes. |
| `GET` | `/selection` | — | `{ ok, selection: { node, selectedAt, styleChanges[] } \| null }` |
| `DELETE` | `/selection` | — | Clears the selection. |
| `POST` | `/style-change` | `{ selector, property, newValue, oldValue? }` | Appends a change to the current selection; ignored if nothing is selected. |

`SelectedDomNode` fields: `url` and `tagName` are required. Optional fields are `title`, `id`, `classes[]`, `text` (capped at 500 chars), `role`, `ariaLabel`, `selector`, `xpath`, `attributes{}`, `outerHTML` (capped at 2,000) and `nearbyContext` (capped at 1,000). The extension uses `title` for the resolved source `file:line` and `nearbyContext` for `Component: A > B > C`.

```bash
# What's selected right now?
curl -s http://127.0.0.1:3100/selection | jq

# Fake a selection, e.g. to test prompts without the extension
curl -s -X POST http://127.0.0.1:3100/selection \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:5173","tagName":"button","classes":["btn","btn-primary"],"text":"Save"}'
```

---

## How source resolution works

`SourceMapper.resolve()` tries five strategies in order and stops at the first hit. Each one gets a 3-second budget. It searches the **first** workspace folder.

| # | Strategy | Uses | Notes |
|---|---|---|---|
| 0 | **Owner stack** (`stack`) | React 19 `fiber._debugStack`: the stack trace React records where each element's JSX was created | The inspector finds the first stack frame in app code, which is a position in the *served* module, e.g. `/src/App.jsx?t=…:42:7`. The extension fetches that module, decodes its source map (inline or external, including index maps), and maps it to the original file and line. Elements rendered inside libraries (an icon's `<svg>`) resolve to the JSX that rendered the library component (`<Eye … />`). Works with any dev server that serves source maps: Vite, webpack and Next.js dev, etc. |
| 1 | **Debug source** (`sourcemap`) | `componentInfo.sourceFile` + `sourceLine` (React ≤ 18 `_debugSource`, Svelte `__svelte_meta.loc`) | React's `_debugSource` points at where the component is *used*. If the file name doesn't match the component name, the mapper looks for `<ComponentName>.{tsx,jsx,vue,svelte}` and picks the best line inside it. |
| 2 | **Component** (`framework`) | `componentInfo.componentName`, the component that *rendered* the element | Ranks every `<ComponentName>.{tsx,jsx,vue,svelte}` in the workspace by how well it contains the element. If there is none, it greps for the declaration (`function Nav`, `const Nav =`, `class Nav`) inside other files and scores lines within that declaration only. |
| 3 | **DOM attribute** (`attribute`) | `data-component`, `data-source`, `data-file`, `data-testid` | Values may be `path`, `path:line` or a bare component name. |
| 4 | **Grep** (`grep`) | id, the exact `class` string, test ids, `name`, `aria-label`, `role`, relative `href`/`src`, `placeholder`, `alt`, non-utility class names, form `type`, short text, uncommon tag names | Runs `grep -rnF` over template-like files (`*.tsx *.jsx *.vue *.svelte *.astro *.html *.erb *.hbs *.ejs *.pug *.blade.php *.twig *.njk *.mustache`), skipping `node_modules`, `dist`, `build`, `.next` and the like. File choice favours markup lines, component files and `src/`, and penalises tests, configs, imports and `<Component />` usages. A term with more than 50 hits is skipped as ambiguous. When several hits land in one file, the line is re-scored as below. |

**Picking the line inside a file.** Every `<tag …>` opening block (up to 12 lines) for the element's tag is scored:

| Signal | Points |
|---|---|
| id | +100 |
| exact `class` string | +60, otherwise up to +30 for the share of classes present |
| each matching attribute value (`href`, `alt`, test id…) | +20 |
| element text inside or just after the tag | +15 |
| `className` present on only one of the element and the tag | −10 to −20 |

The best block wins. That is how three `<a className="hover:text-white">` links are told apart by their text, and a bare `<div>` by having no class. For an element rendered by a child component (component path `[App, Nav, Download]`, owner `Nav`), `<Download …/>`-style JSX tags are scored instead, with a +40 bonus for the matching name.

**Measured accuracy** on `test-react` (React 19, Vite 8, Tailwind): 306 elements, with ground truth from a build-time line tag on every JSX element.

| Situation | Exact line |
|---|---|
| React 19 dev (owner stack + source map) | **100%** (including icon internals) |
| No owner stack (React ≤ 18, prod builds), component info available | **90%** (97% for elements written directly in your JSX) |
| No component info at all (plain HTML, unknown framework) | **46%** |
| Before this work, same app | 10.5% |

**Getting better hits without React 19.** The cheapest win is a hint attribute that strategy 3 reads directly:

```jsx
<button data-source="src/components/SaveButton.tsx:12">Save</button>
```

Unique ids, `data-testid`s and static `className` strings help the line scoring.

---

## Framework support

Detection looks at what is actually rendered: fiber keys on DOM nodes for React, `__vueParentComponent` / `__vue__` / `__vue_app__` for Vue, `__svelte_meta` for Svelte, `window.ng` / `[ng-version]` for Angular. It doesn't depend on a devtools extension being installed. Component info is looked up per element, with each framework tried in turn.

| Framework | Component name | Component path | Source |
|---|---|---|---|
| React | The **owner**: the component whose render produced the element, from `_debugOwner` (or the stack frame's function name). An icon's `<svg>` therefore reports `Nav`, not `Eye`. | Named function, `forwardRef` and `memo` components from root to element, consecutive duplicates removed | React 19: owner stack + source map (exact line). React ≤ 18: `_debugSource`, ignoring `node_modules` |
| Vue 2 / 3 | `name`, `__name`, `_componentTag`, or the SFC file name | Walks `parent` / `$parent` | `__file` (line found by scoring) |
| Angular (dev) | `ng.getOwningComponent(el)` (falls back to `ng.getComponent`) | Component hosts among the ancestors | Line found by scoring |
| Svelte (dev) | File name from `__svelte_meta.loc` on the element or its nearest ancestor | Distinct component files up the tree | `loc.file` and `loc.line` |

Plain HTML and server-rendered templates (Blade, ERB, Twig, Handlebars…) work through the attribute and grep strategies.

---

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `domInspector.browser` | `auto` | Where **Open URL** shows the page: `auto`, `integrated`, `cursor`, `simple`, `panel`, `external`. |
| `domInspector.ai.target` | `auto` | Which assistant **Send to AI** uses: `auto`, `claude-code`, `cursor`, `kiro`, `copilot`, `cline`, `roo-code`, `continue`, `custom`, `clipboard`. |
| `domInspector.ai.customCommand` | `""` | Command ID for the `custom` target. |
| `domInspector.ai.customArgs` | `["${file}"]` | Its arguments. Placeholders: `${file}` (a Uri), `${path}`, `${relativePath}`, `${markdown}`, `${prompt}`. |
| `domInspector.ai.customSelectSnapshot` | `false` | Open and select the snapshot before running the command, for commands that read the active editor selection. |
| `domInspector.mcp.autoConfigure` | `true` | Register the MCP server with this editor's own AI on startup. |
| `domInspector.mcp.port` | `3100` | Port of the MCP HTTP bridge. The extension posts to it, and it's written into MCP configs as `DOM_INSPECTOR_PORT`. |

Other fixed values: the proxy port is chosen by the OS (random, bound to `127.0.0.1`); URL history keeps 50 entries (`MAX_URL_HISTORY`, stored in `globalState`).

---

## Development

### Scripts

| Script | Does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over all of `src/`, the MCP server included |
| `pnpm compile` | `tsc -p tsconfig.build.json` → `out/` (everything except `src/mcp-server/`), then copies `src/webview/` assets to `out/webview/` |
| `pnpm watch` | `tsc --watch` with the same config |
| `pnpm bundle-mcp` | esbuild bundles `src/mcp-server/index.ts` and its dependencies into a single CJS file at `mcp-server/index.js` (Node 18 target) |
| `pnpm build` | `typecheck` + `compile` + `bundle-mcp` |
| `pnpm test` | `vitest --run` |
| `pnpm bump` | `npm version ${BUMP:-patch} --no-git-tag-version` |
| `pnpm package` | `bump` + `build` + `vsce package`: bumps the patch version (`BUMP=minor pnpm package` for minor) and writes `dom-inspector-<version>.vsix`. `.vscodeignore` is an allowlist: only `out/` JavaScript and webview assets, `mcp-server/index.js`, `media/`, `package.json`, the README, CHANGELOG and LICENSE ship. |

The MCP server's npm dependencies (`@modelcontextprotocol/sdk`, `express`, `cors`, `zod`) are dev dependencies: esbuild inlines them, and the VSIX is packaged with `--no-dependencies`. To try the server on its own, run `pnpm bundle-mcp && node mcp-server/index.js`.

### `rebuild-all.sh`

```bash
./rebuild-all.sh                        # patch bump
./rebuild-all.sh minor                  # minor bump
EDITOR_CLI=cursor ./rebuild-all.sh      # install into Cursor instead of Kiro
```

Installs dependencies if `node_modules` is missing, runs `pnpm package` (version bump, build, VSIX) and installs the new VSIX with `$EDITOR_CLI --install-extension`.

### Browser-side code

Code that runs in a browser, not in the extension host, lives as plain files in [`src/webview/`](src/webview/):

- [`inspector.js`](src/webview/inspector.js) is injected into every proxied HTML page: overlay, extractor, framework detector, active-style collection, live style editing, context menu and the page channel. The proxy wraps it in `<script data-dom-inspector>` and fills in the session token (`__DI_TOKEN__`).
- `sidebar.html`, `sidebar.css` and `sidebar.js` make up the sidebar webview. `sidebar.html` has `{{style}}` and `{{script}}` placeholders.

`pnpm compile` copies them to `out/webview/`, and [`assets.ts`](src/webview/assets.ts) reads them from beside itself, so they work both from source (tests) and once compiled. `pnpm watch` only recompiles TypeScript: run `pnpm compile` after editing these files.

When you edit `inspector.js`:
- Keep it **ES5-style** (`var`, function expressions), because it runs in arbitrary user pages.
- Anything the inspector adds to the page carries `data-dom-inspector-overlay="true"` or a `dom-inspector-*` class or id. The picker and the active-styles collector skip those markers, so keep using them.

### Tests

```bash
pnpm test
```

The suite uses vitest (some suites with fast-check), with `vscode` aliased to a mock in `tests/__mocks__/`. Every suite exercises the real modules: the injected script as the proxy serves it, the proxy and page channel against a live upstream, source mapping and source maps, AI context and targets, MCP config writers, and the sidebar styles. The MCP server has no tests.

### Debugging tips

- The sidebar's **Console** tab logs every bridge message, source-mapper result and MCP POST.
- **Output → DOM Inspector** shows activation and MCP-config messages.
- **Developer: Open Webview Developer Tools** shows `[webview]` and `[dom-inspector]` console logs from the browser panel and the page.
- `curl http://127.0.0.1:3100/selection` shows exactly what the AI will see.
- The MCP server logs to **stderr** (stdout is reserved for the MCP protocol). Look for them in your MCP client's server logs.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Blank panel or `Proxy error: connect ECONNREFUSED` | The dev server isn't running at that URL. Start it and reload. |
| Page loads but picking does nothing | The page isn't HTML served through the proxy (e.g. you navigated to an absolute URL on another origin). Reload from the toolbar, or reopen the URL. |
| "Could not find source for <tag>" | None of the four strategies matched. Add a `data-source="path:line"` attribute or a unique id or test id, and check the source lives in the **first** workspace folder. |
| The wrong file opens | Without React 19 owner stacks, several files sharing the component's name (e.g. many `index.tsx`) are ranked by how well they contain the element, which can still guess wrong. Add a `data-source` hint. |
| Nothing appears in the assistant after **Send to AI** | Check which assistant is used (**DOM Inspector: Choose AI Assistant…**) and the Console tab. Some chats only accept context while their panel has an open conversation. If delivery fails, the context is on your clipboard. |
| `[DOM] Apply styles` says "No style changes recorded" | Changes are cleared every time you pick a new element. Pick the element, edit in Styles, then run the command. |
| "Inspector connection lost — waiting for page reload…" shows a few seconds after every load | A known false alarm: the page only sends one ready signal, so the 5-second heartbeat always times out. Picking still works. |
| MCP server says the port is used by another program | Something else listens on 3100. Set `domInspector.mcp.port`; the MCP configs it writes follow. |
| Hot reload doesn't update the page | The proxy tunnels the dev server's HMR WebSocket, so saving a file should update the page. If it doesn't: check that your installed extension build includes WebSocket support (rebuild and reinstall), and look for `[vite] failed to connect to websocket` (or your bundler's equivalent) in **Developer: Open Webview Developer Tools**. A dev server configured with a fixed `server.hmr.host`/`clientPort` connects there directly instead of through the proxy. |

---

## Known limitations

The main ones are below. The full list, with root causes, is in [PRODUCT.md → Known gaps and limitations](PRODUCT.md#known-gaps-and-limitations).

- **Active styles can miss rules.** A quick-reject filter only looks at the first `.class` in a selector. Rules like `.dark .btn`, `.a, .b` and escaped Tailwind variants (`.hover\:bg-red-500:hover`) can be dropped from the Styles tab. Rules are listed in stylesheet order, with no specificity or override marking.
- **One page session at a time.** One proxy and one target URL. Several tabs on the same proxy all work, and replies go to the tab that spoke last. The MCP side keeps no history.
- **Keyboard shortcuts inside native browsers.** A browser view that has focus may swallow `Ctrl+Shift+I`. Use the sidebar's inspect button or right-click → **Inspect element** instead.
- **Delivery depends on each assistant's command.** The built-in targets use commands checked against each tool's current code, but extensions rename commands. If one stops working, choose another target or use the `custom` command and clipboard fallbacks.
- **MCP auto-setup covers only the editor's own AI** (Kiro, Cursor, VS Code). Other tools need **Set Up MCP for AI Tools…** once.
- **Leaving the proxy.** Navigating to absolute URLs on another origin leaves the proxy, and the inspector stops working there.

---

## Security notes

DOM Inspector is a **local development tool**. Don't point it at sites you don't trust, and don't run it on shared machines without reading this.

- The proxy listens on `127.0.0.1` only. It **removes CSP and X-Frame-Options** from every response it forwards and injects a script into every HTML page. Its inspector channel (`/__dom-inspector__/…`) requires a random per-session token embedded in that script, so other local pages can't drive or impersonate the inspector without first loading a proxied page.
- The MCP HTTP bridge listens on `127.0.0.1:3100` with **no authentication and CORS that reflects any origin**. Any website open in your normal browser could read the current selection or overwrite it, and whatever it writes ends up in AI prompts. Treat the selection as untrusted input.
- The MCP server never kills other processes. When its port is taken, it either shares the existing DOM Inspector bridge or reports the conflict.
- **Send to AI** writes element snapshots (page HTML, text, styles, source excerpts) to `<workspace>/.dom-inspector/`, which ignores itself in git. What the assistant does with them, including sending them to its model provider, is up to that assistant.
- On activation the extension writes this editor's MCP config (`.kiro/settings/mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`) into every open workspace folder. The entry contains an absolute path on your machine, so add that folder to your project's `.gitignore` if you don't want it committed.
- The clipboard is only written when you choose **Copy as Markdown**, pick the clipboard target, or a delivery fails.

---

## License

[MIT](LICENSE) © 2026 Laravel42.
