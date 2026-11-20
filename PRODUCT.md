# DOM Inspector — Product & Implementation Document

This document describes what DOM Inspector is for, how it is built, and where it is going. Both the extension and this document are **IDE- and AI-provider-agnostic**, and the document is self-sufficient: an engineer, or an LLM, should be able to rebuild or extend the system for any VS Code–based IDE (VS Code, Kiro, Cursor, Windsurf…) from this document alone.

It was written against the working tree of **2026-11-08** and updated for the **2026-11-13** reorganisation and release: one package, `dom-inspector` **0.7.21**, whose MCP server reports version **1.1.0**. Where behaviour differs from intent, the [Known gaps and limitations](#known-gaps-and-limitations) section says so explicitly. For installation and day-to-day usage, see [README.md](README.md).

The system has two programs, built from one package (all source in `src/`):

1. **DOM Inspector Extension** (`src/`, compiled to `out/`): embeds a browser in the editor, injects an inspector into the page through a reverse proxy, resolves picked elements to source code, and provides a DevTools-style sidebar with live CSS editing.
2. **DOM Inspector MCP Server** (`src/mcp-server/`, bundled to `mcp-server/index.js`): a standalone Node.js process that holds the current selection and exposes it to AI assistants over the Model Context Protocol, fed by a local HTTP bridge.

---

## Contents

- [Product overview](#product-overview)
- [Status at a glance](#status-at-a-glance)
- [Core user journeys](#core-user-journeys)
- [System architecture](#system-architecture)
- [Package 1: DOM Inspector Extension](#package-1-dom-inspector-extension)
- [Package 2: DOM Inspector MCP Server](#package-2-dom-inspector-mcp-server)
- [Contract between the packages](#contract-between-the-packages)
- [End-to-end flows](#end-to-end-flows)
- [Build, packaging and release](#build-packaging-and-release)
- [Testing strategy](#testing-strategy)
- [Implementation constraints and conventions](#implementation-constraints-and-conventions)
- [Security and privacy model](#security-and-privacy-model)
- [Known gaps and limitations](#known-gaps-and-limitations)
- [Porting to other IDEs](#porting-to-other-ides)
- [Roadmap](#roadmap)
- [Visual Editor (planned)](#visual-editor-planned-extension)

---

## Product overview

### The problem

Front-end work constantly crosses three places: the running app in a browser, the browser's DevTools, and the source code in the editor. Getting from "that button" to the line that renders it means guessing at component names, grepping for class strings, or reading framework devtools. Every CSS tweak found in DevTools then has to be retyped into source by hand, usually translated into whatever styling system the project uses (Tailwind, CSS modules, styled-components).

AI coding assistants make the gap wider. They are good at editing source, but they can't see the UI, so users end up pasting HTML snippets and describing elements in prose.

### Who it is for

- **Front-end and full-stack developers** iterating on UI against a local dev server: React, Vue, Angular, Svelte, or server-rendered templates (Blade, ERB, Twig…).
- **Developers using AI assistants inside the editor** (Kiro, or any MCP-capable client) who want the assistant to act on what they see.
- **QA and test engineers**, who use the analysis prompt to get stable Playwright and Cypress locators and an accessibility review for a specific element.

### Value proposition

> Point at it, land in the code, tell the AI what to change.

- **Zero context switch**: the app, the inspector and the source all live in the editor.
- **Zero setup**: no browser extension and no build plugin. The proxy injects the inspector into any page, and the extension registers its MCP server automatically (in Kiro).
- **Element → source in one click**: framework debug data when available, heuristics when not.
- **Visual tweaks become source edits**: style edits made in the sidebar are recorded and handed to the AI as a precise change list.
- **AI-native context**: the selection is a first-class MCP resource with ready-made prompts, not a copy-paste ritual.

### Product principles

1. **Local only.** Everything binds to `127.0.0.1`; nothing leaves the machine unless the user's AI client sends it.
2. **Degrade gracefully.** Every strategy can fail, and the next one takes over. A failed MCP POST never blocks the UI.
3. **Don't make users annotate their app**, but reward them if they do (`data-source="file:line"` is honoured).
4. **Feel like DevTools.** Same colours, same tabs and the same mental model, so there's nothing new to learn.

### Non-goals (for now)

- Inspecting production or third-party sites. The proxy lowers page security; see [Security](#security-and-privacy-model).
- Being a full DevTools replacement: no network, performance or JS debugging.
- Writing source changes directly. Code edits are delegated to the AI assistant.

---

## Status at a glance

| Capability | Status | Notes |
|---|---|---|
| Inspected page in any browser via reverse proxy | ✅ Shipped | VS Code integrated browser, Cursor browser tab, Simple Browser, the DOM Inspector panel, or the system browser (`domInspector.browser`). HTTP(S) upstream, redirect rewriting, decompression, WebSocket tunnelling (HMR), deep links. |
| URL history | ✅ Shipped | 50 entries persisted in `globalState`, offered by the **Open URL** prompt (the sidebar omnibox was removed). |
| Inspect the page open in Cursor's browser | ✅ Shipped | No URL, no proxy in front of the page: the inspector is injected through Cursor's internal `cursor.browserView.*` commands and re-injected on reloads. |
| Detach from current page | ✅ Shipped | Removes the inspector from the page completely and releases the browser (panel, proxy, Cursor-tab injection). |
| Hover overlays and tooltip | ✅ Shipped | |
| Pick → resolve source | ✅ Shipped | Five-strategy chain; the `file:line` feeds the breadcrumb, MCP and Send to AI (selecting doesn't open the file). React 19 owner stacks + source maps give exact lines (100% on the test app); 90% without them. |
| Framework component info | ✅ Shipped | Detected from rendered DOM, not devtools hooks. React reports the owning component; Vue, Svelte and Angular are probed per element. |
| Picking accuracy (keyboard navigation, SVG promotion, layers) | ✅ Shipped | ↑/↓ parent/child, ←/→ layers under the cursor, Enter to pick. |
| Right-click menu → Send to AI / Send to… / Copy as Markdown / Inspect | ✅ Shipped | Markdown snapshot delivered through the assistant's own command: Claude Code, Cursor Chat, Kiro, Copilot Chat, Cline, Roo Code, Continue, a custom command, or the clipboard. |
| Status-bar component breadcrumb | ⚠️ Partial | Only the leaf segment carries a source file; segments can't highlight in the page. |
| Sidebar: full DOM tree | ✅ Shipped | Renders and reveals the pick; clicking a row expands/collapses it and selects the element (like picking it). No search. |
| Sidebar: Styles tab (matched rules, live edit, add property) | ⚠️ Partial | Edits always land as inline styles; toggling rule-sourced properties has no effect; some rules missed. |
| Sidebar: Computed tab | ✅ Shipped | Non-default diff plus "Show all", category accordions, filter. |
| Sidebar: element summary, DOM path, component chain, HTML preview, force-state bar | ❌ Removed | The render code was never mounted and was deleted as dead code; recover it from git history (`dom-inspector/src/sidebar.ts`, `force_state`) to build it properly. |
| MCP resource and three prompts | ✅ Shipped | |
| `[DOM] …` commands → AI | ✅ Shipped | Send / analyze / apply style edits / remove the last picked element through the same AI targets; no MCP needed. |
| MCP registration | ✅ Shipped | The editor's own AI automatically (Kiro, Cursor, VS Code); 10 clients on demand. Several clients can run the server at once (leader/follower bridge). |
| Chat participant `@dom-inspector` (VS Code chat) | ❌ Removed | It was never declared under `contributes.chatParticipants`, so VS Code never registered it; the code was deleted. |
| Visual Editor (drag, resize, inline text, edit queue) | 📝 Planned | Spec below; a React prototype lives in the git-ignored `prototype/visual-editor-preview/`. |

---

## Core user journeys

### J1: "Where is this in the code?"
1. Run **Open URL** with the dev server URL; the page renders in an editor tab.
2. Run **Inspect Element** (or press the toolbar button), hover, and click the element.
3. The sidebar shows the element (Styles, Computed, tree) and the status bar shows `App > … > Component`; clicking a component opens its file. The resolved `file:line` goes into AI snapshots and the MCP selection (selecting doesn't open the file).

**Success:** the right file and line, under 3 s, with no manual search.

### J2: "Make it look like this"
1. Pick the element (J1).
2. In **Styles**, change a value (colour picker, keyword dropdown, free text) or add a property. The page updates instantly.
3. Run **[DOM] Apply styles**. The assistant receives the element context plus the change list, finds the source and writes the change, using Tailwind classes when the project uses Tailwind.

**Success:** the visual change becomes a correct source diff without the user retyping CSS.

### J3: "Help me test and fix this element"
1. Pick the element.
2. Run **[DOM] Analyze node**, or invoke the MCP prompt from the AI client.
3. The assistant returns the element's purpose, accessibility issues, Playwright and Cypress locators, fragile selector patterns and markup improvements.

### J4: "Delete this"
1. Pick the element.
2. Run **[DOM] Remove node**. The assistant removes it from the JSX or HTML and cleans up imports, variables and styles that are no longer used.

### J5: Explore structure
1. After every page load, the Elements tab shows the full tree (minus `head`, `script`, `link`, `style`, `noscript`) with two levels expanded.
2. Picking an element expands the tree to it and highlights the row.

---

## System architecture

```
┌──────────────────────────────────── IDE (VS Code-based) ─────────────────────────────────────┐
│                                                                                              │
│  ┌────────────────────────┐            ┌─────────────────────────────┐   ┌────────────────┐  │
│  │ Browser panel (webview)│ postMessage│ Extension host              │   │ Sidebar        │  │
│  │  toolbar + relay script│◄──────────►│  extension.ts (orchestrator)│◄─►│ (webview view) │  │
│  │  ┌──────────────────┐  │            │  BridgeChannel  (panel.ts)  │   │ Elements       │  │
│  │  │ <iframe>         │  │            │  SourceMapper   (source-…)  │   │ Styles         │  │
│  │  │  user's page     │  │            │  ComponentBreadcrumb        │   │ Computed       │  │
│  │  │  + inspector.js  │  │            │  Reverse proxy  (proxy.ts) ─┼─┐ │                │  │
│  │  │    (injected)    │  │            └──────────────┬──────────────┘ │ └────────────────┘  │
│  │  └────────▲─────────┘  │                           │                │                     │
│  └───────────┼────────────┘                           │                │                     │
└──────────────┼────────────────────────────────────────┼────────────────┼─────────────────────┘
               │ GET http://127.0.0.1:<random>/…       │ POST /selection │ forwards to target
               └────────────────────────────────────────┼─────────────────┘ (e.g. localhost:5173)
                                                        │ POST /style-change
                                                        │ GET  /selection
                                                        ▼
┌──────────────────────────────── MCP server process (node) ───────────────────────────────────┐
│  HTTP bridge (Express, 127.0.0.1:3100) ──► State (in-memory) ◄── MCP server (stdio) ◄──► AI │
│                                                 │                      ▲                      │
│                                                 └──► Formatters (Markdown) ┘                  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Runtime pieces

| Piece | Runs in | Listens on | Lifetime |
|---|---|---|---|
| Extension host code | IDE extension host (Node) | — | Activated on first command or sidebar open. |
| Reverse proxy | Extension host | `127.0.0.1:<OS-assigned>` | Started on first Open URL, or on attach to a Cursor browser tab (where it only hosts the page channel); stopped on detach, or when the panel closes while it's the current browser. |
| Browser view | VS Code integrated browser / Cursor browser tab / Simple Browser / DOM Inspector panel / system browser | — | Chosen per Open URL (`domInspector.browser`); the panel is reused across calls. |
| Inspector script | The proxied page, inside the iframe | `window` `message` events | Re-injected on every HTML document load. |
| Sidebar | Webview view | — | While the view is resolved. |
| MCP server | Separate `node` process **spawned by the AI client** | stdio (MCP) and `127.0.0.1:3100` (HTTP) | As long as the MCP client keeps it alive. |

### Trust boundaries

1. **Page ↔ webview relay**: `postMessage` with `'*'` target origin. Neither side checks the message origin.
2. **Webview ↔ extension host**: VS Code webview messaging (trusted).
3. **Extension host ↔ MCP server**: plain HTTP on loopback with no authentication.
4. **MCP server ↔ AI client**: stdio. The client controls what reaches the model.

---

## Package 1: DOM Inspector Extension

### Manifest and activation

- `main`: `./out/extension.js`; `engines.vscode`: `^1.95.0`; `publisher`: `L42`.
- `activationEvents: []`. On VS Code ≥ 1.74, contributed commands and views imply activation, so the extension activates on first command use or when the sidebar view opens.
- `contributes.configuration` declares `domInspector.ai.target`, `domInspector.ai.customCommand`, `domInspector.ai.customArgs`, `domInspector.ai.customSelectSnapshot`, `domInspector.mcp.autoConfigure` and `domInspector.mcp.port`.

On activation (`activate()`), the extension:

1. Loads URL history from `globalState["domInspector.urlHistory"]`.
2. Creates the **"DOM Inspector" output channel**.
3. Calls `autoConfigureMcp()` unless `domInspector.mcp.autoConfigure` is off. `hostMcpClient(vscode.env.appName)` maps the editor to its own MCP client: Kiro → `.kiro/settings/mcp.json`, Cursor → `.cursor/mcp.json`, VS Code → `.vscode/mcp.json`. `applyMcpConfig()` then writes or refreshes the entry in every workspace folder. See [MCP registration](#mcp-registration-aimcp-configts-aimcpts).
4. Registers the sidebar `WebviewViewProvider` with callbacks for child requests, opening a URL, set style and toggle style.
5. Registers the commands and the breadcrumb click handler. It also listens for configuration and extension changes, so the context-menu label follows the current AI target.

### Commands, keybindings and views

| Command ID | Title | Keybinding (win/linux · mac) | Handler |
|---|---|---|---|
| `domInspector.openUrl` | DOM Inspector: Open URL | `ctrl+shift+u` · `cmd+shift+u` | `openUrl()` |
| `domInspector.inspectElement` | DOM Inspector: Inspect Element | `ctrl+shift+i` · `cmd+shift+i` | `activateInspection()`: attaches to the Cursor browser tab first when no page is connected |
| `domInspector.inspectBrowserTab` | DOM Inspector: Inspect Cursor Browser Tab | — | `inspectBrowserTab()` |
| `domInspector.detach` | DOM Inspector: Detach from Current Page | — | `detachFromPage()` |
| `domInspector.chooseBrowser` | DOM Inspector: Choose Browser… | — | `chooseBrowser()` |
| `domInspector.selectNode` | [DOM] Send element to AI | — | `runElementTask("select")` |
| `domInspector.analyzeNode` | [DOM] Analyze element (a11y, locators) | — | `runElementTask("analyze")` |
| `domInspector.applyStyles` | [DOM] Apply style edits to source | — | `runElementTask("apply-styles")` |
| `domInspector.removeNode` | [DOM] Remove element from source | — | `runElementTask("remove")` |
| `domInspector.chooseAiTarget` | DOM Inspector: Choose AI Assistant… | — | `chooseAiTarget()` |
| `domInspector.setupMcp` | DOM Inspector: Set Up MCP for AI Tools… | — | `setupMcpForAiTools()` |
| `domInspector.breadcrumbClicked` | *(internal, registered at runtime)* | — | Breadcrumb quick pick |

Views: activity-bar container `domInspector` (icon `media/inspect.svg`) holding the webview view `domInspector.inspectorSidebar`.

### Orchestrator (`extension.ts`)

Module-level state: `browserPanel`, `bridge`, `urlHistory` (max 50), `currentPageUrl` (the URL the user opened, not the current URL after in-page navigation), plus one `SourceMapper` and one `ComponentBreadcrumb`.

**`openUrl(url?)`**: prompts if no URL is given (default `http://localhost:5173`), moves the URL to the front of the history, persists it, and calls `startProxy(url)`. If a panel exists, its HTML is replaced and the panel revealed. Otherwise it creates `WebviewPanel("domInspectorBrowser", "🌐 <hostname>", ViewColumn.One, { enableScripts, retainContextWhenHidden })`, wraps it in a `BridgeChannel` and wires the handlers. When the panel is disposed, the bridge is disposed, the proxy stopped, and the sidebar told the browser has closed.

**`activateInspection()`**: warns if there's no panel; otherwise reveals the panel and sends `start_inspector`.

**Bridge handler (`wireUpBridge`)**:

| Incoming | Action |
|---|---|
| `inspector_ready` | Request `get_children("body")` and `get_full_tree`, then set `autoSelectPending` and send `inspect_node("body")`. |
| `element_picked` | If `autoSelectPending`, only update the sidebar (no source navigation, no MCP POST). Otherwise run `handleElementPicked()`. |
| `element_hovered` | `sidebar.updateHoverPreview()` |
| `element_pick_cancelled` | Log it. |
| `children_response` | `sidebar.childrenLoaded()` |
| `full_tree_response` | `sidebar.updateFullTree()` |
| `framework_detected` | Log it. |
| *connection lost / restored* | Show a status-bar warning, then a "reconnected" message for 3 s. |

**`handleElementPicked(element)`**:
1. Update the sidebar straight away (element, children, expand to `cssSelectorPath`). Selecting an element doesn't open its source file and doesn't warn when no source is found.
2. `SourceMapper.resolve(element, firstWorkspaceFolder)` in the background; the result is logged to the output channel.
3. Build the breadcrumb from `componentInfo.componentPath`: segments are `{ name, sourceFile }`, and only the owning component's segment (or, failing that, the leaf) gets a `sourceFile`.
4. Remember the pick for the `[DOM]` commands, then `publishSelection()` (`ai/mcp.ts`): fire-and-forget `POST http://127.0.0.1:3100/selection` with a 2 s timeout. See [Contract](#contract-between-the-packages).

**`openSourceFile(path, line)`** (`source/editor.ts`), now used only by the component breadcrumb, opens in `ViewColumn.Two`. `findClosingTagLine()` extends the selection from the opening line to the matching close, using these rules:
- A trailing `/>` on the same line counts as self-closing.
- A multi-line self-closing tag is detected by finding `/>` before the opening tag's `>`.
- Otherwise it counts `<Tag` opens minus self-closes minus `</Tag>` closes until the depth returns to ≤ 0, scanning up to 200 lines.

It then applies a whole-line decoration (`rgba(88,166,255,0.15)` with a border) that is removed after 10 s.

**`recordStyleChange(selector, property, value)`**: keeps one entry per selector and property. The first time a property is edited, its pre-edit computed value is stored as `oldValue`; later edits only update `newValue`, so colour-picker drags collapse into one entry. The list is reset when a different element is picked (`rememberPick`). Each change is also POSTed to `/style-change` for MCP clients.

**`runElementTask(kind)`** (`[DOM]` commands): uses `lastPick`, the last element picked or sent, and warns if there is none. It builds a task (`analyze`, `apply-styles` with the recorded changes, `remove`, or none for `select`) and calls `sendElementToAi(element, "primary", …, task)`. It needs neither the MCP server nor the clipboard.

### Reverse proxy (`browser/proxy.ts`)

A single `http.Server` on `127.0.0.1:0` (the OS picks the port). `startProxy(url)` updates the module-level `currentTarget`; if the server is already running it returns the existing port, so one proxy serves whatever URL was opened last.

For each request:
1. Resolve `new URL(req.url, currentTarget)`. If that fails, reply **400**.
2. Forward with the same method and headers, overriding `host` with the target host and `accept-encoding` with `identity`. The request body is piped through, over `http` or `https` according to the target.
3. **3xx with `Location`**: rewrite to `pathname + search + hash` (proxy-relative), strip the framing headers, and reply.
4. **`text/html`**: strip `content-length`, `content-encoding` and `transfer-encoding`. Decompress `gzip`, `x-gzip`, `br` or `deflate` if the server compressed anyway, buffer the body, and inject `inspectorScriptTag()` (`webview/inspector.js` in a `<script data-dom-inspector>` tag, with the session token) before the first `</body>` (case-insensitive, using a replacer function so `$'` patterns in the script stay literal), or append it if there is no `</body>`. If decompression fails, the bytes received so far are sent.
5. **Anything else**: piped through unchanged.
6. On every response, `X-Frame-Options`, `Content-Security-Policy` and `Content-Security-Policy-Report-Only` are removed.
7. An upstream error returns **502** `Proxy error: …`. The `headersSent` guard prevents a double `writeHead`.

8. **`upgrade` (WebSocket) requests**, handled by `proxyUpgrade()`. Dev-server HMR clients open their socket against the page's origin, which is the proxy, so this is what makes hot reload work. The handshake is replayed upstream with `host` set to the target host. An `Origin` equal to the proxy's own origin is rewritten to the target's origin, for dev servers that validate it. A `101` response is relayed and the two sockets are piped together. A refusal (e.g. Vite's `400` for a bad token) is relayed as-is. An error on either side destroys both sockets.

Not handled: rewriting absolute URLs in the page body, cookies scoped to the original host.

### Browsers and page transport (`browser/browsers.ts`, `browser/page-channel.ts`)

`resolveBrowser(setting, hasCommand)` is pure and unit-tested. With `auto` it picks:
1. VS Code's integrated browser, if `workbench.action.browser.open` exists;
2. else Cursor's browser tab, if `workbench.action.openBrowserEditor` exists;
3. else the DOM Inspector panel.

An explicit choice whose command is missing also falls back to the panel. `openInBrowser()` uses:

| Browser | Command |
|---|---|
| Integrated | `workbench.action.browser.open({ url, openToSide })`, verified in Kiro's VS Code core |
| Cursor | `workbench.action.openBrowserEditor({ url, reuseExistingUrlTab })`, verified in Cursor 3.29 |
| Simple Browser | `simpleBrowser.api.open(uri, { viewColumn, preserveFocus })` |
| System browser | `vscode.env.openExternal` |

If opening fails, the page opens in the panel and you're warned.

**Two transports, one message protocol.**
- **Panel:** its iframe is named `dom-inspector-panel`, and the injected script checks `window.name`. There it keeps the `postMessage` relay (`BridgeChannel`).
- **Everywhere else** (a top-level page, or a foreign iframe such as Simple Browser) it uses the **HTTP page channel** on the proxy's own origin:

  | Direction | Endpoint |
  |---|---|
  | extension → page | `GET /__dom-inspector__/events?t=<token>&c=<client>`, a Server-Sent Events stream (`EventSource`, keep-alive every 15 s, `retry: 1000`) |
  | page → extension | `POST /__dom-inspector__/message?t=<token>&c=<client>`, a JSON body (≤ 20 MB) answered with `204` |

  - The token is 16 random bytes per proxy session. It's substituted into the script for `__DI_TOKEN__` at injection time and rotated by `stopProxy()`.
  - Requests with a wrong token, or a client id that isn't `[\w-]+`, get `403`.
  - Channel paths are never forwarded upstream.
  - Each page load gets a random client id.

`HttpPageChannel` implements the same `PageChannel` interface as `BridgeChannel`, so `wireUpBridge()` works unchanged:
- `sendToPage` goes to the client that spoke last, or to all clients.
- Connection lost/restored follow the number of open SSE streams, which avoids the panel heartbeat's false alarm.
- Switching browsers disposes the other transport. Closing the panel only stops the proxy when the panel is the current browser.

**Attaching to the page open in Cursor's browser (`browser/cursor-browser.ts`).** Here the page isn't loaded through the proxy at all. Cursor exposes its browser to extensions through internal, undocumented workbench commands, the ones its own agent tools use:

| Command | Used for |
|---|---|
| `cursor.browserView.listTabs()` | `{ tabs, activeTab, lastInteractedTab }`; `pickTab()` takes the visible tab, then the last used, then any |
| `cursor.browserView.getURL(viewId)` | the tab's URL; only `http(s)` pages are attached |
| `cursor.browserView.executeJavaScript(code, viewId)` | run the inspector in the current document |
| `cursor.browserView.sendCDPCommand(method, params, viewId)` | `Page.addScriptToEvaluateOnNewDocument`, so the inspector is re-injected on reloads and navigation, and `Page.removeScriptToEvaluateOnNewDocument` on detach |

`cursorBrowserAvailable()` checks that all four exist; the start-screen button and the attach command only appear or work when they do. Tabs opened by Cursor's agent belong to it and aren't listed.

`attachToCursorBrowser()` does the following:
1. Switches to the HTTP page channel and starts the proxy, which here only hosts the channel.
2. Injects `inspectorScript(proxyOrigin())`. `__DI_BASE__` is replaced by the proxy's origin, so the page reaches the channel cross-origin. For proxied pages it stays empty (same origin).

Two details follow from injecting both immediately and on new documents:
- The script runs once per page and session: it records the token in `window.__domInspectorToken` and returns if it's already set.
- A tab still running an older session's inspector is reloaded, so only the new one runs.

**Inspect Element** attaches automatically when no page is connected. If the page doesn't connect within 4 s, it warns and points to Output → DOM Inspector.

**CORS on the page channel.** Pages attached in Cursor's browser call the channel from their own origin. So every channel response carries:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Private-Network: true`
- an answer to `OPTIONS` preflights

Access is still gated by the session token; the headers only let the browser make the request.

**Detach (`detachFromPage()`)**:
1. Sends `detach` to the page. The inspector removes every listener it registered, closes its `EventSource`, removes overlays, the right-click menu and the selection outline, and forgets its token. Live style edits stay; they're the user's.
2. Removes the Cursor tab's on-new-document script.
3. Disposes the transport and closes the panel. The proxy stops 300 ms later, giving the page time to receive `detach`.
4. Clears the pick, the recorded style edits and the breadcrumb, and returns the sidebar to its start screen.

### Browser panel webview (`browser/panel.ts`)

Generated by `panelHtml()`: a dark toolbar (reload button, read-only URL input showing the original URL, inspect toggle) above a full-height `<iframe src="http://127.0.0.1:<proxyPort>">`.

The relay script keeps two whitelists:
- `TO_PAGE_TYPES` (from the extension host): `start_inspector`, `stop_inspector`, `get_children`, `get_full_tree`, `inspect_node`, `set_style`, `toggle_style`, `ai_targets`. These are forwarded to `frame.contentWindow.postMessage(msg, '*')`.
- `TO_HOST_TYPES` (from the page): `element_hovered`, `element_picked`, `element_pick_cancelled`, `children_response`, `framework_detected`, `inspector_ready`, `full_tree_response`, `send_to_ai`. These are forwarded to `vscode.postMessage(msg)`.

Both directions arrive as `window` `message` events in the webview, so the relay routes purely by `type`. The inspect button toggles a pulsing green state and posts start or stop straight to the iframe; it also tells the host, which ignores it. Reload resets `frame.src`.

### Injected inspector script (`webview/inspector.js`)

A plain JavaScript file holding a single IIFE in ES5 style. The proxy wraps it in `<script data-dom-inspector>` and substitutes the session token. Everything it adds to the page is marked `data-dom-inspector-overlay="true"` (overlay divs, style tags) or uses `dom-inspector-*` names (`.dom-inspector-selected`, `#dom-inspector-cursor`, `data-dom-inspector-disabled_*`).

#### OverlayRenderer
- Four fixed-position, `pointer-events:none` divs at z-index `2147483646`: margin (red, 20%), border (blue, 15%), padding (green, 20%), content (blue, 20%). The tooltip sits at `2147483647`.
- `draw(el)`: derives padding, border and margin from `getComputedStyle` and the content box from `getBoundingClientRect()`, then expands outward with `computeBoxModelRects()`.
- Tooltip: `tag#id.classes`, `W × H`, a colour swatch and hex value, `font-size family`, and shorthand padding. It sits above the element, falls back to below, and is clamped to the viewport.
- `pin(el)`: adds `.dom-inspector-selected` (a 2 px blue outline and tinted background, `!important`), injected through a style tag.

#### DOMExtractor
`getFullData(el)` returns an `ElementData`:

| Field | How it's computed | Limits |
|---|---|---|
| `selector` | `uniqueSelector()`: the shortest selector that matches **only** this element, checked with `querySelectorAll`. Tries in order: `tag#id`, a test-id attribute, one stable class, two stable classes, a semantic attribute (`name`, `aria-label`, `placeholder`, `alt`, `title`, `for`, `href`, `role`, `type`), all stable classes, then a short `>` path that can be anchored at an ancestor id or test id, then the full path. Class names are `CSS.escape`d (Tailwind `md:flex` → `md\:flex`). Build-hashed classes (CSS modules, emotion, styled-components) are skipped. Attribute values only escape `"` and `\`. | Always unique at pick time |
| `tag`, `id`, `classNames`, `attrs` | Direct reads; `attrs` contains every attribute. `classNames` comes from the `class` attribute, so it works for SVG too, and never includes the inspector's own `dom-inspector-*` classes. | |
| `text` | `textContent` | first 200 chars |
| `outerSnippet` | `outerHTML` | first 2,000 chars |
| `domPath` | `tag#id.classes` from `<html>` to the element | |
| `children` | Direct children as `ChildSummary` (`tag`, `id`, `classNames`, `childCount`, `selectorPath`) | |
| `boxModel` | content rect + padding, border and margin in px | |
| `computedStyles` | `display`, `position`, `color`, `backgroundColor`, `fontSize`, `fontFamily`, `width`, `height`, `boxSizing` | |
| `xpath` | `/html/body/div[2]/…`; an index is added only when there are same-tag siblings | |
| `cssSelectorPath` | `selector` of every ancestor from `<html>`, joined with ` > ` | Used as the canonical selector for live edits and tree expansion |
| `allComputedStyles` | `{ all, nonDefault }`: `nonDefault` holds properties whose value differs from a hidden element of the same tag appended to the same parent. Inherited values therefore cancel out, and what remains is what is specific to this element. | |
| `activeStyles` | See below | |
| `componentInfo` | Filled in afterwards by `FrameworkDetector` | |

Other methods:
- `getHoverData(el)`: `tag`, `id`, `classNames`, `width`, `height`, `boxModel`.
- `getChildren(selector)`: direct children of the element the selector finds.
- `getFullTree()`: a recursive `FullTreeNode` from `<html>`, skipping `head`, `script`, `link`, `style` and `noscript`. Node `selectorPath` values come from `buildSelectorPath()`, which **excludes** the `html` segment; the root's is `"html"`.

#### Active styles (`getActiveStyles(el)`)
1. Iterate `document.styleSheets`, then `document.adoptedStyleSheets` (Tailwind v4's Vite plugin uses these). Cross-origin sheets that throw are skipped.
2. Recurse into grouping rules (`@media`, `@supports`, `@layer`…) up to depth 4. Style rules are `type === 1` with `selectorText`.
3. Skip the inspector's own rules (`dom-inspector-selected`, `dom-inspector-cursor`) and universal-selector rules (`*`, `*, …`, `…, *`).
4. **Quick reject**: take the *first* `.class` token in `selectorText`; if the element doesn't have that class, skip the rule. Otherwise call `el.matches(selectorText)`.
5. For each match, collect the properties. `inherit`, `initial`, `unset` and `revert` resolve to the computed value. Longhands are collapsed into shorthands when all four (or two) sides are equal: `margin`, `padding`, `border-{color,width,style}`, `border-radius`, `inset`, `overflow`, `gap`.
6. Put inline styles first, as a synthetic rule `element.style`.

Each property is `{ property, value, enabled: true, editable: true }`. There is no specificity ordering or "overridden" marking.

#### Live editing
- `setElementStyle(selector, prop, value)`: `el.style.setProperty(prop, value)`. Every edit lands **inline**, whichever rule it was made in.
- `toggleElementStyle(selector, prop, enabled)`: on disable, saves the current **inline** value in `data-dom-inspector-disabled_<prop>` and removes the inline property; on enable, restores it.

#### FrameworkDetector
`detect()` samples the first 400 elements under `<body>` for what frameworks leave on DOM nodes: `__reactFiber$`/`__reactInternalInstance$` keys (React), `__vueParentComponent`, `__vue__` or `__vue_app__` (Vue), and `__svelte_meta` (Svelte). Then it checks `window.ng` or `[ng-version]` (Angular), and finally the React devtools hook with registered renderers, or `window.__VUE__`. No devtools extension is needed.

`getComponentInfo(el)` tries React, Vue, Svelte, then Angular **per element**, and returns the first hit. The result is `{ framework, componentName, componentPath[], sourceFile, sourceLine, stackUrl?, stackLine?, stackColumn? }`.

- **React**: find the fiber on the element or its nearest ancestor.
  1. **Owner stack (React 19+).** Walk `fiber.return` until a fiber's `_debugStack` (an `Error` captured when its JSX was created) has a frame outside library code. Frames from `node_modules`, `.vite/deps`, `@vite/`, `@react-refresh`, `react-dom` and `jsx(-dev)-runtime` are skipped. That frame's URL, line and column are the JSX call site in the *served* module. The extension maps them through the source map (strategy `stack`). Library-internal elements (an icon's `<svg>`) reach the fiber created in app code, such as `<Eye … />`.
  2. **`_debugSource` (React ≤ 18)**: the first one up the chain that isn't in `node_modules`.
  3. **`componentName`** = the **owner**, from `_debugOwner` of the fiber found in step 1. This is the component whose render produced the element. If that isn't available, the stack frame's function name is used.
  4. **`componentPath`**: every named function, `forwardRef` or `memo` type from the root down, with consecutive duplicates removed. For an icon this is e.g. `App > Nav > Eye`, with `componentName` `Nav`.
- **Vue 3**: `__vueParentComponent` on the element or an ancestor. Name from `type.name`, `__name` or the `__file` basename, then walk `parent`.
- **Vue 2**: `__vue__` on the element or an ancestor. Name from `$options.name`, `_componentTag` or the `__file` basename, then walk `$parent`.
- **Svelte**: `__svelte_meta` on the element or its nearest ancestor. File and line come from `loc`; names are file basenames.
- **Angular**: `ng.getOwningComponent(el)`, falling back to `ng.getComponent(el)`. Component hosts among the ancestors form the path.

Every access is wrapped in `safeGet`, and each probe in its own `try`, so a failure returns `null` rather than throwing.

#### Controller
- `startInspection()`:
  - initialises the overlay
  - adds `#dom-inspector-cursor` (`*{cursor:default!important}`)
  - calls `window.focus()` so the iframe receives keys
  - adds **capture-phase** `mousemove`, `click` and `keydown` listeners
- `mousemove` → `preventDefault` and `stopPropagation`. On the next animation frame, `elementFromPoint` → `normalizeTarget()`, which ignores overlay nodes and promotes SVG internals (`<path>`, `<g>`…) to the outermost `<svg>`. When this base element changes, it becomes the hover target: draw the overlay and post `element_hovered`. Moving within the same base keeps a keyboard-navigated target.
- **Keys**:
  - **↑** goes to the parent element (never `<html>`).
  - **↓** goes to the child under the last cursor point, chosen by bounding box, so `pointer-events: none` children are reachable. With no such child, it goes to the first visible child.
  - **← / →** cycle through `document.elementsFromPoint()` (normalised, without `<html>`/`<body>`), which reaches content beneath transparent overlays.
  - **Enter** picks the target; **Escape** cancels.
  - The tooltip shows a hint row while picking.
- `click` → `preventDefault`, `stopPropagation` and `stopImmediatePropagation`. If the click lands on the current base, the keyboard-navigated target is picked; otherwise the element under the click. Then `getFullData`, attach `componentInfo`, post `element_picked`, stop inspecting, and pin the element.
- **Ready signal**: on DOM ready, a `MutationObserver` watches `documentElement`. `inspector_ready` (and `framework_detected` when applicable) is posted after **300 ms without mutations, or 2 s at most**, so hydration finishes first. It is posted **once per document**.

#### Context menu
A capture-phase `contextmenu` listener runs on every page. Shift+right-click is left to the page. Otherwise the listener cancels the event, stops any active picking, draws the box-model overlay on the element under the cursor, and shows a menu. The menu has a `tag#id.classes` header and four items:

| Item | Posts |
|---|---|
| **Send to ‹target›** (label from the extension's `ai_targets` message; "AI" until it arrives) | `send_to_ai` with `target: "primary"` |
| **Send to…** | `send_to_ai` with `target: "pick"` |
| **Copy as Markdown** | `send_to_ai` with `target: "clipboard"` |
| **Inspect element** | `element_picked` |

The `send_to_ai` messages carry `getFullData` + `componentInfo`. Every action pins the element.

Every menu node is marked `data-dom-inspector-overlay`. `isOverlayElement()` now uses `closest()`, so the picker ignores the menu's children too. The menu swallows its own `mousedown`, `click` and `contextmenu` events, so the app never sees them. It closes on Escape, a click outside, scroll, resize or window blur.

### AI targets (`ai/context.ts`, `ai/targets.ts`)

DOM Inspector never calls a model. It turns an element into a **snapshot file** and hands that file to the user's assistant through the assistant's *own* "add to chat" command. Every command below was read from the tool's shipped or published code, not guessed:

| Target id | Available when | Delivery | Verified in |
|---|---|---|---|
| `claude-code` | `anthropic.claude-code` installed | Open the snapshot with an empty selection, run `claude-vscode.insertAtMention`. The input gets an `@.dom-inspector/…md` mention. | extension bundle 2.1.319 |
| `cursor` | `vscode.env.appName` contains "Cursor" | `composer.addfilestocomposer(uri, { useExactResource: true })`, the handler behind "Add File to Cursor Chat" | Cursor 3.29 workbench |
| `kiro` | `kiro.kiro-agent` present or app is Kiro | `kiroAgent.selectFilesAsContext(uri, [uri])`, which inserts `#[[file:/abs/path]]` | Kiro agent bundle |
| `copilot` | `GitHub.copilot-chat` installed | `workbench.action.chat.open({ query, isPartialQuery: true, attachFiles: [uri] })` | VS Code core chat (as shipped in Kiro) |
| `cline` | `saoudrizwan.claude-dev` installed | Open the snapshot, select all, `cline.addToChat(fullRange)`, which inserts an `@file` mention plus the text | cline/cline `apps/vscode` |
| `roo-code` | `RooVeterinaryInc.roo-cline` installed | `roo-cline.addToContext(relativePath, markdown, 1, lineCount)` (the code-action argument form) | RooCodeInc/Roo-Code |
| `continue` | `Continue.continue` installed | `continue.selectFilesAsContext(uri, [uri])` | continuedev/continue |
| `custom` | `domInspector.ai.customCommand` set | That command with `customArgs`, substituting `${file}` (a Uri), `${path}`, `${relativePath}`, `${markdown}` and `${prompt}`. With `customSelectSnapshot` set, it runs with the snapshot open and fully selected. | — |
| `clipboard` | always | `env.clipboard.writeText(markdown)` | — |

**Choosing a target.** `resolvePrimaryTarget(setting, available, lastUsed)` is pure and unit-tested:
1. An explicit `domInspector.ai.target` wins.
2. With `auto`, the last target chosen through **Send to…** is used, if it's still available. It's stored per workspace under `domInspector.ai.lastTarget`.
3. Otherwise, the first available target in this order: `custom`, `claude-code`, `cline`, `roo-code`, `continue`, `kiro`, `cursor`, `copilot`, `clipboard`.

The extension pushes `{ type: "ai_targets", primary: "<label>" }` to the page on every `inspector_ready` and on configuration or extension changes, so the menu reads e.g. "Send to Cursor Chat".

**`sendElementToAi(element, mode, sidebar, task?)`** in `extension.ts`. `mode` is `primary`, `pick` (quick pick of available targets, remembered) or `clipboard`. It:
1. Updates the sidebar, resolves the source with `SourceMapper`, reads the element's lines (opening tag to matching close, at most 80 lines), remembers the pick, and POSTs the selection to the MCP bridge.
2. Builds the snapshot with the pure `buildElementMarkdown()`. It contains:
   - an optional `## Task`
   - the source path and range with a fenced excerpt
   - identity: tag, id, classes, CSS path, XPath, component path, text, size
   - attributes
   - up to 30 matched rules as CSS, with disabled properties commented out
   - up to 60 non-default computed styles
   - the HTML (≤ 2,000 chars)

   Fences are always longer than any backtick run in the content.
3. Writes it to `<workspace>/.dom-inspector/element-<yyyymmdd-hhmmss-mmm>-<tag>.md`. The folder holds a `.gitignore` containing `*`, and only the newest 20 snapshots are kept. With no workspace, it writes to `globalStorageUri/snapshots/`.
4. Calls `sendToTarget(id, { snapshotFile, markdown, prompt })`. Targets that read the active editor go through `withSnapshotEditor()`: open the snapshot in column two with `preview: false`, so the user's preview tab is never replaced; select nothing or everything; run the command; close the tab.
5. On any error, copies the Markdown to the clipboard and offers **Choose Another AI…**.

### MCP registration (`ai/mcp-config.ts`, `ai/mcp.ts`)

`MCP_CLIENTS` describes each client's config file and format:

| Client | Scope | File | Format |
|---|---|---|---|
| Kiro | workspace | `.kiro/settings/mcp.json` | `mcpServers` (+ `disabled`, `autoApprove`) |
| Cursor | workspace | `.cursor/mcp.json` | `mcpServers` |
| VS Code (Copilot agent mode) | workspace | `.vscode/mcp.json` | `servers` with `type: "stdio"` |
| Claude Code | workspace | `.mcp.json` | `mcpServers` |
| Roo Code | workspace | `.roo/mcp.json` | `mcpServers` |
| Gemini CLI | workspace | `.gemini/settings.json` | `mcpServers` |
| Continue | workspace | `.continue/mcpServers/dom-inspector.yaml` | YAML block (whole file is ours) |
| Cline | global | `<globalStorage>/../saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `mcpServers` (+ `disabled`, `autoApprove`) |
| Windsurf | global | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Codex CLI | global | `~/.codex/config.toml` | `[mcp_servers.dom-inspector]` table |

`upsertJsonConfig()`, `upsertCodexToml()` and `continueYaml()` are pure. How they treat existing files:
- An existing entry keeps the user's own fields (`env`, `autoApprove`…); only `command`/`args` (and `type`) are refreshed.
- A file is written only when it changes.
- A file that can't be parsed (JSONC with comments, a non-object root) produces an `error` result and is never overwritten.

**Set Up MCP for AI Tools…** is a multi-select over all clients, plus **Copy server config as JSON**. It reports each result to the output channel. The server spec is `node <extensionPath>/mcp-server/index.js` with `DOM_INSPECTOR_PORT` set to `domInspector.mcp.port`.

### Bridge channel (`browser/panel.ts`) and message protocol

`BridgeChannel` wraps a `WebviewPanel`:
- `sendToPage(msg)` → `panel.webview.postMessage(msg)`, ignored after dispose.
- `onMessage(cb)`: every inbound object with a `type` is passed on.
- Heartbeat: each `inspector_ready` sets `connected = true` and restarts a **5 s** timer. When the timer fires while connected, it sets `connected = false` and fires `onConnectionLost`. The next `inspector_ready` after that fires `onConnectionRestored`.

The `BridgeMessage` union (`types.ts`):

| Direction | Type | Payload | Sent by → handled by |
|---|---|---|---|
| host → page | `start_inspector` / `stop_inspector` | — | command or toolbar → controller |
| host → page | `get_children` | `selector` | ready handler, tree expand → `children_response` |
| host → page | `get_full_tree` | — | ready handler → `full_tree_response` |
| host → page | `inspect_node` | `selector` | ready handler → `element_picked` + pin |
| host → page | `set_style` | `selector, property, value` | sidebar → `setElementStyle` |
| host → page | `toggle_style` | `selector, property, enabled` | sidebar → `toggleElementStyle` |
| page → host | `element_hovered` | `data: HoverData` | controller → sidebar hover preview |
| page → host | `element_picked` | `data: ElementData` | controller → `handleElementPicked` |
| page → host | `element_pick_cancelled` | — | Escape → log |
| page → host | `children_response` | `selector, children[]` | → `sidebar.childrenLoaded` |
| page → host | `full_tree_response` | `tree: FullTreeNode` | → `sidebar.updateFullTree` |
| page → host | `framework_detected` | `framework` | ready → log |
| page → host | `inspector_ready` | — | ready → heartbeat + bootstrap |
| page → host | `send_to_ai` | `data: ElementData`, `target: primary \| pick \| clipboard` | right-click menu → `sendElementToAi` |
| host → page | `ai_targets` | `primary` (label) | `pushAiTargetToPage()` → context-menu label |
| host → page | `detach` | — | `detachFromPage()` → `detachInspector()` removes the inspector from the page |

### Sidebar (`ui/sidebar.ts`, `webview/sidebar.*`)

`InspectorSidebarProvider` (`viewType = "domInspector.inspectorSidebar"`) renders one HTML document assembled from `webview/sidebar.html`, `sidebar.css` (themed with `--vscode-*` tokens on a 4 px spacing grid) and `sidebar.js`.

**Layout**
- **Start screen** until a page connects: **Inspect the page open in Cursor's browser** (Cursor only, `attach_available`) and **Open URL…**.
- **Bottom bar**: **Detach from current page** (shown while a page is connected; posts `detach`) and the build stamp.
- **DevTools bar**: an inspect toggle and tabs **Elements | Styles | Computed**.
- **Elements**: `#dom-tree`. Clicking a row toggles it and selects the element (`select_node` → `inspect_node` in the page → a pick that skips the "no source" warning); the ▶ arrow only toggles. Revealing a selection expands its ancestors, never the node itself.
- **Styles**: `#active-styles`.
- **Computed**: `#computed-box-model` and `#computed-styles`.
- Diagnostic lines don't go to the webview: `InspectorSidebarProvider.log()` hands them to the logger passed in by `extension.ts`, which writes them, timestamped, to the **DOM Inspector** Output channel.

**Host → webview messages**

| Type | Payload | Effect |
|---|---|---|
| `update_element` | `data, sourceFile` | Stores the selector (`cssSelectorPath \|\| selector`); renders active styles and the computed tab; expands the tree to the element. Shows the content area. |
| `update_full_tree` | `tree` | Replaces the tree model and renders it with two levels expanded. |
| `update_dom_tree` | `children` | Fallback root rendering, used only if no full tree has arrived. |
| `children_loaded` | `selector, children` | Inserts child rows after the parent and resumes a pending expand-to-node. |
| `expand_to_node` | `selector` | Expands each ancestor segment, requesting children when needed, then highlights the row. |
| `update_hover_preview` | `data` | Shows the content area (no hover summary is rendered). |
| `browser_state` | `open` | Toggles the empty state. |

**Webview → host messages**

| Type | Handled as |
|---|---|
| `request_children` | `callbacks.onRequestChildren` → `get_children` |
| `open_url_direct` | `callbacks.onOpenUrl` → `openUrl(url)` |
| `start_inspect` | Runs `domInspector.inspectElement`. |
| `stop_inspect` | Ignored. |
| `set_style` / `toggle_style` | Forwarded to the page; `set_style` is also POSTed to `/style-change`. |

**Styles tab editors** (`getEditorType`):
- **colour** (`color`, `background-color`, `border-*-color`, `fill`, `stroke`…): `<input type=color>` plus text. Hex conversion handles rgb/rgba with commas or spaces, `#rgb`, and named colours via canvas.
- **keyword** (~55 properties with enumerated values): `<select>`; an unknown current value is kept as an extra option.
- **size** / **autocomplete**: free text. Committed on `change` or Enter.
- **Add property**: a pair of inputs per rule. The property name autocompletes from every non-prefixed property in `getComputedStyle(document.documentElement)` (20 suggestions, keyboard navigable). Enter on the value commits it.

**Computed tab**: box-model diagram, filter input and "Show all" toggle. Defaults to `nonDefault`. Accordions: Typography, Box Model, Layout & Positioning, Colors & Backgrounds, Visual Effects, Transitions & Animations, Generated Content & Lists, Specialized, Other. Vendor-prefixed properties are hidden, and accordions open automatically while filtering.

**Tree**: rows carry `--depth` for indentation, a ▸/▾ toggle, a syntax-coloured `tag#id.class` label and a `(childCount)`. Each level shows at most `MAX_CHILDREN_PER_NODE = 500` nodes, followed by an "… N more nodes" indicator. Collapsing removes the following rows that are deeper.

### Source mapper (`source/source-mapper.ts`)

`resolve(element, workspaceRoot)` runs the strategies in order, each wrapped in `withTimeout(3000)`, and returns the first non-null `SourceLocation { filePath (workspace-relative), line (1-based), column?, strategy }`.

0. **`stack`**: needs `componentInfo.stackUrl` and `stackLine`. `originalPositionFor()` in `stack-source.ts`:
   - fetches the served module (2.5 s timeout, 20 MB cap)
   - reads the last `sourceMappingURL`, either a `data:` URI (base64 or percent-encoded) or a URL fetched relative to the module
   - decodes the VLQ `mappings` (index maps with `sections` are supported) and finds the segment covering the 1-based line and column
   - resolves `sources[i]` against `sourceRoot` and the map URL

   `sourcePathCandidates()` turns the resulting source into paths: `file://` URLs, Vite `/@fs/` paths, URL pathnames, `webpack://` paths and bare paths. `resolveFilePath()` maps those onto the workspace. Decoded maps are cached per module URL (40 entries).
1. **`sourcemap`**: needs `componentInfo.sourceFile` and `sourceLine`. `resolveFilePath()` tries, in order:
   - an absolute path inside the workspace
   - the workspace-relative path
   - the path with its leading `/` removed (Vite's `/src/...`)
   - the same path under each first-level subdirectory that has a `package.json` (monorepos)
   - an existing absolute path outside the workspace

   If the file's basename ≠ `componentName`, the best `<componentName>.{ext}` file is used instead, because React's `_debugSource` points at the usage site.
2. **`framework`**: `bestFileForComponent()` collects up to 20 files named `<componentName>.{tsx,jsx,vue,svelte}`. It ranks them by line score plus path preference: `src/` and shallow paths first, tests and configs last. If no such file exists, `findComponentDeclaration()` greps `-E` for `(function|class|const|let|var) <Name>` in `*.tsx *.jsx *.ts *.js *.mjs *.vue *.svelte`. It keeps only real declarations and picks the best path. Line scoring is then limited to that declaration: from its line up to the next top-level declaration.
3. **`attribute`**: for each of `data-component`, `data-source`, `data-file`, `data-testid`, parse `value` or `value:line`. Try `resolveFilePath`, then `<value><ext>` by name. The line defaults to 1.
4. **`grep`**: build search terms in specificity order:
   - id (three quote variants)
   - **the exact `class` attribute** (when it has several classes and is under 300 chars; static Tailwind strings appear verbatim)
   - `data-testid`, `data-id`, `data-cy`, `data-test`, `name`, `aria-label`, `role`, `for`/`htmlFor` (values 2–79 chars)
   - relative `href` and `src`
   - `placeholder`
   - `alt` (more than 3 chars)
   - up to five non-trivial classes, longest first, plus the top three joined
   - form `type`
   - the first line of text (3–59 chars)
   - the `<tag` for non-generic tags

   For each term, run `grep -rn --include=<templates> --exclude-dir=<build dirs> -m 10 -F -- '<term>' .` with a 3 s `execSync` timeout. Skip the term if it has 0 or more than 50 hits. Score each hit:
   - path preference
   - +10 for a markup line
   - +5 for `.tsx/.jsx/.vue/.svelte`
   - −20 for import or require lines
   - −15 for a `<Component …>` usage line
   - +8 for a declaration line

   Then:
   - If the best hit is a `<Component>` usage or a default import, follow it to the best `<Component>.{ext}`.
   - If several hits fall in the winning file, re-score that file with `bestLineInLines()`.
   - If a hit lies on a continuation line of a multi-line opening tag, move up to the `<tag` line.

**Line scoring (`bestLineInLines`)**:
- **Candidates.** Every opening `<tag …>` block for the element's tag within the range is a candidate. A block runs from `<tag` to the first `>` outside quotes and braces, at most 12 lines.
- **Scoring.** Each block starts at 1, then:

  | Signal | Points |
  |---|---|
  | id | +100 |
  | exact `class` string | +60; otherwise up to +30 for the share of classes found as whole tokens |
  | each matching attribute value | +20 |
  | text inside or just after the block | +15 |
  | element has classes but the block has no `className`/`class`/`:class` | −10 |
  | element has no class but the block sets one | −20 |
- **Elements rendered by a child component.** The component path continues past the owner, e.g. `[App, Nav, Download]` with owner `Nav`. Then JSX component tags (`<Download`, `<t.icon`) are scored first, with +40 for the matching name. The same component-tag pass also runs when the host tag doesn't appear in range at all.
- **Choosing a winner.** It takes a clear winner, or the only candidate. Otherwise it falls back to the first non-import line containing a distinctive needle (id, class string, attribute values, non-trivial classes, text), moved to its `<tag` line.

**Trivial classes** (`isTrivialClass`) are Tailwind-style utilities (`flex`, `p-4`, `text-sm`, `w-[200px]`, `md:…`, `hover:…`, …). They are excluded from search terms because they appear everywhere.

**`findLineInFile`**: the first line containing a needle that is (for markup needles) a markup line and is not an import. The needles, in order, are: id variants, test id, name, aria-label, placeholder, alt, relative href, non-trivial classes, `<tag` (except div and span), then text. Falls back to line 1.

Excluded directories everywhere: `node_modules .git dist build .next .nuxt .svelte-kit out .output coverage .cache .turbo vendor`.

### Component breadcrumb (`ui/breadcrumb.ts`)

A left-aligned status bar item (priority 100) showing `$(symbol-class) A > B > C`. Clicking it runs `domInspector.breadcrumbClicked`, which is re-registered on every `show()`. With one segment, the callback runs immediately; with several, a quick pick lists them, with each segment's source file as its description. The extension's callback opens the segment's `sourceFile` at line 1 if it has one.

### Shared types (`types.ts`)

```typescript
type FrameworkType = 'react' | 'vue' | 'angular' | 'svelte' | null;

interface ElementData {
  selector: string; tag: string; id: string | null; classNames: string[];
  attrs: Record<string, string>;
  text: string;            // ≤ 200 chars
  outerSnippet: string;    // ≤ 2000 chars (the type comment still says 500)
  domPath: string[]; children: ChildSummary[];
  boxModel: BoxModelData; computedStyles: ComputedStyleData;
  xpath: string; cssSelectorPath: string;
  allComputedStyles: { all: Record<string,string>; nonDefault: Record<string,string> } | Record<string,string>;
  componentInfo: ComponentInfo | null;
  activeStyles?: ActiveStyleRule[];
}

interface ComponentInfo { framework: FrameworkType; componentName: string; componentPath: string[];
                          sourceFile: string | null; sourceLine: number | null;
                          // React 19: JSX call site in the *served* module, mapped by the host
                          stackUrl?: string | null; stackLine?: number | null; stackColumn?: number | null; }
interface ComponentPathEntry { name: string; sourceFile: string | null; }
interface SourceLocation { filePath: string; line: number; column?: number;
                           strategy: 'stack' | 'sourcemap' | 'framework' | 'attribute' | 'grep'; }
interface ActiveStyleRule { selector: string; properties: ActiveStyleProperty[]; }
interface ActiveStyleProperty { property: string; value: string; enabled: boolean; editable: boolean; }
interface ChildSummary { tag: string; id: string | null; classNames: string[]; childCount: number; selectorPath: string; }
interface FullTreeNode extends ChildSummary { children: FullTreeNode[]; }
interface HoverData { tag: string; id: string | null; classNames: string[]; width: number; height: number; boxModel: BoxModelData; }
```

---

## Package 2: DOM Inspector MCP Server

TypeScript in `src/mcp-server/` (the file names below are relative to it). It is type-checked with the rest of `src/` but not compiled by `tsc`: esbuild **bundles it with its dependencies** (`@modelcontextprotocol/sdk` ^1.32, `express` ^4.22, `cors` and `zod` ^3.25, all dev dependencies of the package) into a single CJS file, `mcp-server/index.js` (about 1.9 MB), which ships in the VSIX and is launched by the AI client with `node`.

### Entry (`index.ts`)

```typescript
const HTTP_PORT = parseInt(process.env.DOM_INSPECTOR_PORT ?? "3100", 10);
createHttpServer(HTTP_PORT);                         // HTTP bridge, same process => shared state
startMcpTransport(createMcpServer()).catch(exit(1)); // MCP over stdio
```

All logging goes to **stderr**, because stdout carries the MCP protocol.

### HTTP bridge (`http.ts`)

Express with `cors({ origin: true })` (reflects any origin) and `express.json({ limit: "100kb" })`.

| Method | Path | Validation | Response |
|---|---|---|---|
| `POST` | `/selection` | `SelectedDomNodeSchema` | `{ ok, selectedAt, tagName, selector }`, or `400 { ok:false, error, details }` |
| `GET` | `/selection` | — | `{ ok, selection: StoredSelection \| null }` |
| `DELETE` | `/selection` | — | `{ ok, cleared: true }` |
| `POST` | `/style-change` | `StyleChangeSchema` | `{ ok }`, or `400` |
| *any* | error handler | — | `500 { ok:false, error:"Internal server error" }` |

`GET /health` returns `{ ok: true, name: "dom-inspector-bridge", pid }`.

**Sharing the port between MCP clients (`bridge-mode.ts`).** Every MCP client spawns its own server process, so several can run at once (Claude Code, Cursor, Kiro, Cline…). `startBridge(app, port)`:
1. Tries to listen on `127.0.0.1:<port>`. On success this process is the **leader** and holds the selection in memory.
2. If the port is taken and `GET /health` reports `dom-inspector-bridge`, or an older bridge answers `GET /selection`, this process becomes a **follower**. `readSelection()` then fetches the leader's `/selection` for every MCP request.
3. If a follower's fetch fails because the leader exited, it tries to listen and takes over as leader. State starts empty until the next pick.
4. If the port belongs to an unrelated program, the bridge is marked unavailable and the server logs how to change the port.

**No process is ever killed.** Earlier versions ran `lsof` and sent `SIGTERM` to whatever held the port.

### State (`state.ts`)

```typescript
let currentSelection: StoredSelection | null = null;
interface StoredSelection { node: SelectedDomNode; selectedAt: string /* ISO 8601 */; styleChanges: StyleChange[]; }
```

- `setCurrentSelection(node)` **replaces** the selection and resets `styleChanges`.
- `addStyleChange(change)` appends only if a selection exists.
- `clearCurrentSelection()`, `getCurrentSelection()`, `getStyleChanges()`.

There is no persistence and no history; state is lost when the process exits.

### Schemas (`types.ts`)

```typescript
SelectedDomNodeSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional().default(""),
  tagName: z.string().min(1),
  id: z.string().optional().default(""),
  classes: z.array(z.string()).optional().default([]),
  text: z.string().optional().default("").transform(v => v.slice(0, 500)),
  role: z.string().optional().default(""),
  ariaLabel: z.string().optional().default(""),
  selector: z.string().optional().default(""),
  xpath: z.string().optional().default(""),
  attributes: z.record(z.string(), z.string()).optional().default({}),
  outerHTML: z.string().optional().default("").transform(v => v.slice(0, 2000)),
  nearbyContext: z.string().optional().default("").transform(v => v.slice(0, 1000)),
});

StyleChangeSchema = z.object({
  selector: z.string(), property: z.string(),
  oldValue: z.string().optional().default(""), newValue: z.string(),
});
```

### MCP surface (`mcp.ts`)

`new McpServer({ name: "dom-inspector", version: "1.1.0" })` on a `StdioServerTransport`. Every handler is async and reads the selection with `readSelection()`, which works in both leader and follower mode.

| Type | Name | Identifier | Content |
|---|---|---|---|
| Resource | `[DOM] Select node` | `dom-inspector://selected-node` (`text/markdown`) | `formatSelectionAsMarkdown`, or `formatNoSelection` |
| Prompt | `[DOM] Analyze node` | no arguments | one user message: `formatAnalysisPrompt`, or `formatNoSelectionPrompt` |
| Prompt | `[DOM] Apply styles` | no arguments | `formatApplyStylesPrompt`, or `formatNoSelectionPrompt` |
| Prompt | `[DOM] Remove node` | no arguments | `formatRemoveNodePrompt`, or `formatNoSelectionPrompt` |

There are no MCP **tools** yet; see the roadmap.

### Formatters (`formatters.ts`)

Pure `StoredSelection → string` functions.

- **`formatSelectionAsMarkdown`**: `## Selected DOM Node`, then bullets for Page, Title (the source `file:line`), Tag, ID, Classes, Text, Role, aria-label, Selector, XPath and Nearby context. After that comes `### Attributes` as a list, `### HTML` as a fenced `html` block (≤ 1,500 chars, with `<!-- truncated -->` if cut), and `_Selected at <ISO>_`.
- **`formatAnalysisPrompt`**: the context plus six numbered asks: purpose, accessibility, a Playwright locator (prefer role or test id), a Cypress locator, fragile patterns, and improvements.
- **`formatApplyStylesPrompt`**: if there are no changes, explains how to record some. Otherwise it lists `` `prop`: `old|(none)` → `new` `` and instructs the AI to find the source, apply each change, convert to Tailwind if the project uses it, update CSS modules or styled-components if relevant, preserve conventions, and only touch the listed properties.
- **`formatRemoveNodePrompt`**: find, remove the element and its children, clean up unused imports, variables and styles, preserve formatting, and note any layout impact.
- **`formatNoSelection` / `formatNoSelectionPrompt`**: step-by-step instructions for picking an element.

---

## Contract between the packages

The extension maps `ElementData` to `SelectedDomNode` in `publishSelection()` (`ai/mcp.ts`):

| `SelectedDomNode` | Source in the extension | Note |
|---|---|---|
| `url` | `currentPageUrl` (or `"http://localhost"`) | The URL the user opened, not the proxied or navigated URL. |
| `title` | `` `${source.filePath}:${source.line}` `` | Overloaded to carry the resolved source location; empty when unresolved. |
| `tagName` | `element.tag` | |
| `id` | `element.id` | |
| `classes` | `element.classNames` | Omitted when empty. |
| `text` | `element.text` | ≤ 200 from the page, ≤ 500 server cap. |
| `selector` | `element.selector` | The short selector, not `cssSelectorPath`. |
| `xpath` | `element.xpath` | |
| `attributes` | `element.attrs` | Omitted when empty. |
| `outerHTML` | `element.outerSnippet` | ≤ 2,000. |
| `nearbyContext` | `"Component: " + componentPath.join(" > ")` | Only when a framework path exists. |
| `role` / `ariaLabel` | `attrs.role` / `attrs["aria-label"]` | |

Style changes: `{ selector: cssSelectorPath || selector, property, oldValue, newValue }`, coalesced per property (see `recordStyleChange`).

The port is **3100 on both sides**. The server honours `DOM_INSPECTOR_PORT`; the extension doesn't.

---

## End-to-end flows

### Page load
1. The iframe requests `/` from the proxy, which fetches the target and injects the script into the HTML.
2. The script waits for DOM ready plus mutation quiet (300 ms, 2 s max), then posts `inspector_ready` (and `framework_detected`).
3. The relay forwards it to the host. The bridge marks itself connected and starts the 5 s timer.
4. The host sends `get_children(body)`, `get_full_tree` and `inspect_node(body)`.
5. The page replies with `children_response`, `full_tree_response` and `element_picked(body)`. The sidebar renders the tree, styles and computed values for `<body>`. Source navigation and the MCP POST are skipped because of the auto-select flag.
6. About 5 s later the heartbeat expires and the status bar shows "connection lost" (known false positive).

### Pick an element
1. `domInspector.inspectElement` (attaching to the Cursor browser tab first if no page is connected) → `start_inspector` → the page enters picking mode (cursor, capture listeners).
2. On hover, rAF → overlay + tooltip → `element_hovered` → sidebar (no visible effect today).
3. On click → `getFullData` + `getComponentInfo` → `element_picked` → the page stops picking and pins the element.
4. The sidebar gets `update_element` straight away, renders active styles and computed values, and expands the tree to the element.
5. The host then runs `SourceMapper.resolve` in the background for the breadcrumb, MCP and the `[DOM]` commands; it doesn't open the file.
6. The breadcrumb shows the component path.
7. `POST /selection` → the server replaces its state and resets style changes.

### Edit a style
1. Change a value in Styles → `set_style` → the host forwards it to the page (`el.style.setProperty`) **and** sends `POST /style-change`.
2. Toggle a checkbox → `toggle_style` → the inline property is removed or restored. Nothing is POSTed.

### Hand off through the context menu or a command
1. Right-click → **Send to ‹target›**, or a `[DOM]` command (uses `lastPick` plus a task).
2. `sendElementToAi()` resolves the source, writes `.dom-inspector/element-….md` and calls the target's own command (see [AI targets](#ai-targets-aicontextts-aitargetsts)). On failure, the Markdown goes to the clipboard.

### Hand off through MCP
1. The AI client lists resources and prompts and reads `dom-inspector://selected-node` or runs a prompt. The server formats the current state on demand.

---

## Build, packaging and release

### Package (repo root)

| Step | Command | Output |
|---|---|---|
| Type-check | `pnpm typecheck` (`tsc -p . --noEmit` over all of `src/`, the MCP server included) | |
| Compile | `pnpm compile` (`tsc -p tsconfig.build.json`: CommonJS, ES2022, strict, `src/mcp-server/` excluded), then copy `src/webview/` assets to `out/webview/` | `out/**/*.js` + source maps + webview assets |
| Bundle MCP | `pnpm bundle-mcp`: esbuild `src/mcp-server/index.ts` → `mcp-server/index.js` (bundle, platform node, target node18, format cjs, no externals) | One self-contained file. |
| Build | `pnpm build` = typecheck + compile + bundle | |
| Test | `pnpm test` (`vitest --run`, `vscode` aliased to `tests/__mocks__/vscode.ts`) | |
| Bump | `pnpm bump` = `npm version ${BUMP:-patch} --no-git-tag-version` | `package.json` version +1 patch (or `BUMP=minor`) |
| Package | `pnpm package` = bump + build + `vsce package --allow-missing-repository --no-dependencies --baseContentUrl .` | `dom-inspector-<version>.vsix` (git-ignored), new version every run |

`.vscodeignore` is an allowlist: the VSIX holds `out/**/*.js`, `out/webview/*.{html,css}`, `mcp-server/index.js`, `media/`, `package.json`, `README.md`, `CHANGELOG.md` and `LICENSE`. Build output (`out/`, `mcp-server/`, `*.vsix`) is git-ignored.

Dev dependencies: TypeScript 5, `@types/vscode` 1.95, esbuild 0.24, vitest 4, `@vitest/coverage-v8`, fast-check 4, `@vscode/vsce` 4, plus the MCP server's runtime libraries and their types. `pnpm-workspace.yaml` only allows esbuild's install script.

### Release automation (`rebuild-all.sh`)

`./rebuild-all.sh [patch|minor]`:
1. `pnpm install --frozen-lockfile` if `node_modules` is missing.
2. `yes | pnpm run package` with `BUMP` exported (version bump, build, VSIX).
3. `$EDITOR_CLI --install-extension dom-inspector-<version>.vsix --force` (`EDITOR_CLI` defaults to `kiro`).

Every run bumps the version, which explains the fast-moving patch numbers.

---

## Testing strategy

Tests use **vitest** (several suites with **fast-check**) and live in `tests/`. Every suite runs against the real modules.

| Suite | What it checks |
|---|---|
| `ai-context.test.ts` | Snapshot Markdown content, Task section, omissions, fence safety for arbitrary HTML, @-mention-safe file names, `.gitignore` + pruning to 20 (`ai/context.ts`) |
| `ai-targets.test.ts` | Target availability per editor and extension, `auto` ordering, explicit setting and last-used resolution, custom-arg placeholder substitution (`ai/targets.ts`) |
| `mcp-config.test.ts` | JSON `mcpServers`/`servers` upserts that keep user fields, idempotency, refusing JSONC, Continue YAML, Codex TOML table replace, every client written into a temp workspace/home (`ai/mcp-config.ts`) |
| `cursor-browser.test.ts` | Tab choice (visible, last used, any), http(s)-only, API detection, injection now and on new documents, once per session, reload for an older session, removal on detach (`browser/cursor-browser.ts`, against a mocked command API) |
| `sidebar-session.test.ts` | Session replay into a re-created sidebar view, in dependency order; log lines go to the output channel, not the webview (`ui/sidebar.ts`) |
| `page-channel.test.ts` | The proxy and HTTP page channel against a live upstream: injection, token checks, SSE delivery, client tracking (`browser/proxy.ts`, `browser/page-channel.ts`, `browser/browsers.ts`) |
| `inspector-script.test.ts` | The script as the proxy injects it parses as JavaScript and carries the session token; stack-frame and library-URL regexes; hashed-class detection; attribute-selector escaping (`webview/inspector.js`) |
| `sidebar-style.test.ts` | Every px spacing value in `webview/sidebar.css` is a positive integer |
| `source-mapper-real.test.ts` | Same-class links told apart by text, multi-line opening tags, line ranges, components declared inside other files, Tailwind class-string grep, on a temp fixture project (`source/source-mapper.ts`) |
| `stack-source.test.ts` | VLQ decode round-trip (property-based), segment lookup, `sourceMappingURL`/data-URI parsing, path candidates, index maps, end-to-end fetch + map from a local HTTP server (`source/stack-source.ts`) |

The MCP server has **no tests**. There are no extension-host integration tests and no CI configuration in the repo.

---

## Implementation constraints and conventions

1. **Browser-side code is plain files** in `src/webview/` (`inspector.js`, `sidebar.{html,css,js}`), loaded by `webview/assets.ts` and copied to `out/webview/` by `pnpm compile`. Prefer ES5 syntax in `inspector.js` for compatibility with arbitrary pages.
2. **The page is the source of truth for element data**: the extension never keeps DOM state of its own beyond the last pick.
3. **Inspector footprint markers**: `data-dom-inspector-overlay="true"`, `.dom-inspector-selected`, `#dom-inspector-cursor`, `data-dom-inspector-disabled_*`, `data-dom-inspector`. `isOverlayElement()` and the active-styles collector rely on them to ignore the inspector's own nodes and rules.
4. **Capture-phase listeners** with `stopImmediatePropagation` are what stop clicks from reaching the app while picking.
5. **Selectors are recomputed, not stored as node references.** Everything that crosses the bridge identifies elements by `cssSelectorPath` or `selector` and re-queries with `document.querySelector`. DOM changes between messages can therefore retarget or miss.
6. **Every error is swallowed**, by design: framework accessors (`safeGet`), cross-origin stylesheets, grep failures and MCP POSTs. The UI never crashes, but failures only show up in Output → DOM Inspector.
7. **Theme**: the browser panel is hard-coded dark (`#0d1117`, GitHub-dark palette). The sidebar follows VS Code theme tokens.
8. **Webview security**: neither webview sets a Content-Security-Policy.

---

## Security and privacy model

| Area | Behaviour | Risk | Mitigation today |
|---|---|---|---|
| Proxy | Binds `127.0.0.1` only; strips CSP and XFO; injects script into all HTML | Opening an untrusted site removes its CSP inside the editor | Local dev use only (documented). |
| Page channel | `/__dom-inspector__/*` on the proxy; random per-session token in the injected script; CORS `*` and private-network preflights (for pages attached in Cursor's browser) | A page that has the token (any page the inspector was injected into) can drive the inspector or send fake picks | Token rotates per proxy session; channel paths are never forwarded upstream |
| Cursor browser attach | Uses Cursor's internal `cursor.browserView.*` commands, including CDP and running JavaScript in the tab | Internal API: may change or disappear in any Cursor release | Feature-detected; clear warnings when unavailable |
| Inspector ↔ relay | `postMessage('*')`, no origin checks | Other frames or scripts on the page can drive the inspector or forge `element_picked` | Low impact (dev pages). |
| HTTP bridge | `127.0.0.1:3100`, no auth, `cors({origin:true})` | **Any website in the user's normal browser** can `GET /selection` (read page HTML and source paths) or `POST` (inject text that flows into AI prompts) | None. |
| Port sharing | First MCP instance owns the bridge port; others follow it via `/health`. Unrelated programs are left alone | A non-DOM-Inspector program on the port makes the bridge unavailable | Clear log message; `domInspector.mcp.port` |
| Workspace writes | The host editor's MCP config (`.kiro`, `.cursor` or `.vscode`) on activation; `.dom-inspector/` snapshots on send; other clients only on request | Unexpected files in user repos | `mcp.autoConfigure: false`; snapshots folder ignores itself; unparsable configs are never overwritten |
| Clipboard | Written only for **Copy as Markdown**, the clipboard target, or a failed delivery | Replaces clipboard content | User-initiated |
| Shell | `grep` through `execSync` with a single-quoted term | Shell injection | Quoting via `'…'` with `'\''` escaping. |
| Data egress | None by the tool itself | The AI client may send selection data (HTML, text, file paths) to its model provider | User's AI client policy. |

---

## Known gaps and limitations

### Bugs and unwired UI
1. *(Resolved: the unmounted sidebar sections — summary, DOM path, component chain, HTML preview, hover preview, force-state bar — were removed as dead code. See roadmap item 1.)*
2. *(Resolved: clicking a tree row expands/collapses it and selects the element.)*
3. *(Resolved: the unwired "Search DOM…" box was removed.)*
4. **False "connection lost".** `inspector_ready` is sent once per document, but the bridge expects it at least every 5 s, so the warning appears about 5 s after every load and stays until the next load.
5. **Toggling stylesheet properties has no effect.** `toggleElementStyle` only touches inline styles. Unchecking a property that came from a CSS rule does nothing visible unless it was edited first.
6. **Every edit becomes an inline style.** Editing a value inside `.btn { … }` sets `style="…"` on the element instead of changing the rule. That is fine as a preview, but the UI doesn't make it clear.
7. **Style change records are lossy.** There's no `oldValue`, toggles aren't recorded, and colour-picker drags produce one entry per `input` event.
8. **Breadcrumb segments lack data.** Only the owning (or leaf) segment has a `sourceFile`, and segments can't highlight anything in the page.
9. **Sidebar inspect button drifts.** `stop_inspect` is a no-op, so the sidebar toggle and the page state can disagree.
10. *(Resolved: the unreachable `navigateSourceForSelector` was removed.)*

### Accuracy limitations
11. **Active-styles quick reject is too aggressive.** It checks only the first `.class` token in the whole selector text, so it misses:
    - rules where that class sits on an ancestor (`.dark .btn`)
    - selector lists whose first member doesn't apply (`.a, .b`)
    - escaped class names (`.hover\:bg-red-500:hover` and `.w-1\/2`, whose token parsing stops at `\`)
12. There is **no cascade model**: rules appear in stylesheet order, without specificity, overridden or inherited markers.
13. *(Resolved: the unmounted force-state code was removed.)*
14. **Selector uniqueness is checked at pick time only.** A later DOM change (list reorder, toggled state class) can make a stored `selector` or `cssSelectorPath` stale.
15. **Framework detection limits**:
    - Owner stacks need React 19 dev builds, and the dev server must serve source maps. Without them, resolution drops to the component and line-scoring strategies (90% exact on the test app).
    - Identical repeated JSX inside one component, such as fifteen `<ArrowRight />` icons, can't be told apart without owner stacks.
    - Vue/Angular templates carry no runtime line info, so their lines come from scoring.
16. **Source mapper**:
    - Only the first workspace folder is searched.
    - `grep` and the directory walks are **synchronous** and block the extension host. `withTimeout` can't preempt synchronous work, so the worst case is several 3 s greps in a row. The `stack` strategy is async and usually answers first.
    - It relies on `grep` being present (no Windows support).

### Platform and environment
17. One proxy session (one target origin) at a time. Several tabs can share it, with replies going to the tab that spoke last. One selection. Inside native browser views, editor keybindings like `Ctrl+Shift+I` may not reach the editor while the view has focus; use the sidebar or the right-click menu.
18. **HMR configured to bypass the page origin.** If the dev server pins its HMR host or port (e.g. Vite's `server.hmr.host`/`clientPort`), its client connects there directly rather than through the proxy. That only works if the editor webview can reach the address.
19. Absolute same-origin URLs in the page (e.g. `http://localhost:5173/x`) bypass the proxy, and navigating to them drops the inspector.
20. The URL bar is read-only; there's no back/forward and no address-bar navigation inside the panel.
21. **AI delivery depends on third-party command IDs.** Each target uses a command verified against that tool's current code; a rename upstream breaks it until updated. The custom-command and clipboard fallbacks still work.
22. **MCP auto-config covers only the host editor's AI** (Kiro, Cursor, VS Code). Other clients need **Set Up MCP for AI Tools…** once. Windsurf, Gemini CLI, Codex CLI and similar tools have no `Send to` target; use MCP, `custom` or the clipboard.
23. *(Resolved: the never-registered `@dom-inspector` chat participant was removed.)*
24. **Attaching to Cursor's browser relies on internal commands** (`cursor.browserView.*`) that Cursor doesn't document, and tabs opened by Cursor's agent can't be attached. If Cursor changes them, use **Open URL** with the `cursor` or `panel` browser instead.

### Docs and tooling debt
25. *(Resolved: the stale package README was removed; the root `README.md` is now also the marketplace page.)* Neither `package.json` license field is set (the repo `LICENSE` is MIT).
26. The `types.ts` comment for `outerSnippet` says 500 chars (it's 2,000). A comment in the MCP `index.ts` mentions port auto-increment and a port file that don't exist.
27. *(Resolved: `rebuild-all.sh` is executable again.)*
28. *(Resolved: `.vscodeignore` keeps `src/`, `tests/` and tooling out of the VSIX.)*
29. No MCP tests and no CI (see [Testing strategy](#testing-strategy)).

---

## Porting to other IDEs

Most of the system is plain VS Code API and works unchanged in forks. The IDE-specific seams are:

| Seam | Today | To port |
|---|---|---|
| MCP registration | `MCP_CLIENTS` table in `ai/mcp-config.ts`; host detected from `vscode.env.appName` | Add a row: file path, scope, format. On VS Code ≥ 1.101, `vscode.lm.registerMcpServerDefinitionProvider` is a file-free alternative. |
| Chat hand-off | `ai/targets.ts`: one entry per assistant, using its own "add to chat" command | Find the tool's command that attaches a file or the active selection (check its `package.json` and handler), then add a target. Until then, `custom` and the clipboard work. |
| Webviews, commands, keybindings, status bar | Standard APIs | No change. |
| Browser view | `browser/browsers.ts`: `resolveBrowser` + `openInBrowser` | Add the fork's "open URL in browser editor" command. Without one, the panel or system browser works; the HTTP page channel needs nothing editor-specific. |
| MCP protocol | `@modelcontextprotocol/sdk`, stdio | Works with any MCP client (Kiro, Cursor, VS Code, Claude Code, Claude Desktop…). |
| Grep fallback | `grep -rn` through `execSync` | Use the editor's bundled ripgrep (`@vscode/ripgrep`) or `vscode.workspace.findFiles` + async reads for Windows support. |
| Port sharing | `fetch` + `/health`, no OS tools | Works on Windows too. |

---

## Roadmap

### Now: finish what's half-built
1. **Element details in the sidebar**: summary, DOM path, component chain, HTML preview with Copy, and a `:hover`/`:active`/`:focus` force-state bar. An earlier, never-mounted implementation was removed; `dom-inspector/src/sidebar.ts` and the `force_state` message in git history are a starting point.
2. **Tree search** (optional): filter `treeData`, then expand to and highlight matches. *(Row-click selection is done; the unwired search box was removed.)*
3. **Fix the heartbeat**: have the inspector post a periodic `inspector_ready` or a new `heartbeat` (e.g. every 2 s), or drop the timeout and rely on `onDidDispose` plus the next `inspector_ready`.
4. **Fix active styles**:
   - Split selector lists.
   - Quick-reject on the *rightmost compound's* classes only.
   - Unescape CSS identifiers.
   - Order by specificity and mark overridden properties.
5. **Make toggles real**: disable rule-sourced properties by writing an inline override, or by editing the `CSSStyleRule` through the CSSOM, and restore them precisely.
6. **Better change records**: send `oldValue`, record toggles, and debounce or coalesce per `(selector, property)`.

### Next: hardening and reach
7. **Auth for the bridge**: a random per-session token header, and CORS restricted to `null`/`vscode-webview://` origins. (The port is already configurable through `domInspector.mcp.port`.)
8. **More AI targets**: Windsurf Cascade, Gemini Code Assist, Codex and Amazon Q, once their "add file to chat" commands are verified. Also `vscode.lm.registerMcpServerDefinitionProvider` for file-free MCP registration on VS Code ≥ 1.101.
9. *(Done: the injected script is a plain file, `webview/inspector.js`, and tests run against it as served.)*
10. **Async, multi-root source mapping**: ripgrep or `findFiles`, cancellation, and a cache of name → path. Show alternatives in a quick pick when line scoring has no clear winner.
11. **Production builds**: offer an optional build plugin that stamps `data-source="file:line"` (strategy 3 already reads it) for apps that have no owner stacks or source maps.
12. **Proxy**: rewrite absolute same-origin URLs, and add back/forward and an editable address bar.
13. **MCP tools**: e.g. `get_selection`, `list_style_changes`, `clear_style_changes`, `highlight_selector`, so agents can act without the user running commands.
14. **Settings**: proxy default URL, grep include and exclude lists, MCP port, auto-open source on/off.

### Hygiene
15. Add `license: "MIT"` to `package.json`, refresh `CHANGELOG.md` (it stops at 0.4.1), and add CI (build + test).
16. Add MCP server tests (schema, formatters, HTTP routes with supertest), and add an integration smoke test (proxy + JSDOM page).

### Later: Visual Editor
See the next section. Prerequisites from the list above: items 1, 4–6 (a reliable styles model), 7 (a hardened bridge) and 9 (a maintainable inspector codebase).

---

## Visual Editor (Planned Extension)

> **Status: planned, not implemented.** Nothing in this section exists in the shipped packages. A React 19 + Tailwind v4 + Radix UI preview of the overlay UX lives in the git-ignored `prototype/visual-editor-preview/`. The design below predates the current code, so where it names existing modules (e.g. `SourceMapper`, the HTTP bridge, the MCP prompts), the current behaviour is described in the sections above.

The Visual Editor extends both packages above to provide a full visual editing experience. Instead of only inspecting elements, users can drag-and-drop, resize, edit text inline, and modify styles — all from the browser overlay. Every edit is recorded as an `EditOperation` and queued for the AI assistant to translate into source code changes.

The design adapts concepts from [Plasmic](https://www.plasmic.app/)'s open-source visual builder primitives.

### Architecture Extension

```
┌─────────────────────────────────────────────────────────────────┐
│                    Browser Overlay (Enhanced)                    │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Overlay      │  │  Component   │  │  Style Panel         │  │
│  │  Manager      │  │  Tree Panel  │  │  (Plasmic-style      │  │
│  │              │  │              │  │   categorized CSS)   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│  ┌──────┴───────┐  ┌─────┴────────┐  ┌─────────┴──────────┐   │
│  │  Selection   │  │  Undo/Redo   │  │  Bridge Client      │   │
│  │  Manager     │  │  Manager     │  │  (HTTP POST)        │   │
│  └──────┬───────┘  └──────────────┘  └─────────────────────┘   │
│         │                                                       │
│  ┌──────┴───────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  DragDrop    │  │  Resize      │  │  Inline Text         │  │
│  │  Engine      │  │  Engine      │  │  Editor              │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
        │ POST /edit-operation
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                  MCP Server (Extended)                           │
│                                                                 │
│  Existing:                    New:                               │
│  POST /selection              POST /edit-operation               │
│  GET  /selection              GET  /edit-operations              │
│  DELETE /selection            DELETE /edit-operations             │
│  POST /style-change                                             │
│                                                                 │
│  [DOM] Select node            [Visual] Edit operations           │
│  [DOM] Analyze node           [Visual] Apply edits               │
│  [DOM] Apply styles           [Visual] Apply single edit         │
│  [DOM] Remove node                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

### Overlay Modules

| Module | Responsibility |
|--------|---------------|
| `OverlayManager` | Lifecycle (activate/deactivate within 500ms), event interception, hover highlighting with bounding box outline |
| `SelectionManager` | Single-click select, Shift+click multi-select, click-empty to clear, combined bounding box for multi-selection, dimension badge display |
| `DragDropEngine` | Ghost preview following cursor, insertion guides for valid drop positions (horizontal for flex-row/grid, vertical for block/flex-column), move operation recording, invalid-drop revert with error flash |
| `ResizeEngine` | 8-handle resize (4 corners + 4 edge midpoints), real-time dimension update, Shift+corner for aspect ratio lock, dimension display during resize |
| `InlineTextEditor` | Double-click activation, contenteditable with rich text toolbar (Bold/Italic/Underline/Strikethrough/Alignment/Link/Lists), click-outside-to-commit pattern (not onBlur — avoids toolbar focus issues), Escape to cancel |
| `StylePanelUI` | Plasmic-style collapsible sections in order: Visibility → Size → Typography → Positioning → Spacing → Layout → Overflow → Background → Border → Shadows → Effects → Transitions → Transform. Inline value editing, color swatches, Tailwind utility badges |
| `ComponentTreeUI` | Collapsible DOM tree with `<tag>#id` labels, click-to-select, hover-to-highlight, auto-expand to selected node |
| `UndoRedoManager` | Dual-stack (undo/redo), min 50 levels, Cmd+Z / Cmd+Shift+Z, new-op-after-undo clears redo stack |
| `SourceMapper` | Reads `data-source-file`/`data-source-line` attributes, queries React DevTools fiber `_debugSource`, falls back to CSS selector + XPath |
| `BridgeClient` | HTTP POST to `/edit-operation`, `/selection`; fire-and-forget with local queue on bridge unreachable |

---

### Drag-and-Drop: Layout Direction Detection

The drag engine must detect the parent container's layout direction to show correct insertion guides and calculate drop indices:

```
function isHorizontalLayout(targetId):
  style = getComputedStyle(element)
  if display is "flex" and flexDirection is "row" → horizontal
  if display is "grid" and gridTemplateColumns has multiple columns → horizontal
  otherwise → vertical

For horizontal: use cursor X position, show vertical insertion line
For vertical: use cursor Y position, show horizontal insertion line
```

**Drop target resolution:** Find the smallest element under the cursor (by area) that is not the dragged element or a descendant of it. Then calculate the insert index based on the midpoint of each child in the layout direction.

---

### Inline Text Editing: Focus Management

The inline text editor uses `contentEditable` and requires careful focus management:

1. **Activation:** Double-click sets `contentEditable=true`, places caret at end of text
2. **Toolbar interaction:** Toolbar buttons use `onMouseDown` with `e.preventDefault()` to prevent stealing focus from the contentEditable span. The toolbar wrapper div also calls `preventDefault` on mousedown.
3. **Commit trigger:** Uses a `document.addEventListener("mousedown")` click-outside pattern instead of `onBlur`. The handler checks if the click target is inside the wrapper (which includes both the text span and the toolbar). If outside → commit. If inside → no action.
4. **Selection preservation:** While any element is being edited (`editingTextId` is set), all other elements' click/mousedown/doubleclick handlers bail out early, preventing drag initiation or selection changes from interfering with text selection.
5. **Rich text toolbar:** Plain `<button>` elements (not Radix/shadcn Tooltip wrappers — those steal focus). Uses `document.execCommand` for formatting. Tracks bold/italic/underline/strikethrough state via `document.queryCommandState` on `selectionchange`.

---

### EditOperation Data Model (Zod-validated)

All operations share a base shape, discriminated by `type`:

```typescript
BaseEditOperation {
  timestamp: string (ISO 8601)
  elementSelector: string
  elementXPath?: string
  sourceLocation?: { filePath, lineNumber, columnNumber? }
}

MoveOperation extends Base {
  type: "move"
  originalParentSelector: string
  originalIndex: number
  newParentSelector: string
  newIndex: number
}

ResizeOperation extends Base {
  type: "resize"
  originalWidth: string   // CSS value e.g. "200px"
  originalHeight: string
  newWidth: string
  newHeight: string
}

TextEditOperation extends Base {
  type: "text-edit"
  originalText: string
  newText: string
}

StyleChangeEditOperation extends Base {
  type: "style-change"
  property: string
  oldValue?: string
  newValue: string
  tailwindEquivalent?: string
}

ReorderOperation extends Base {
  type: "reorder"
  parentSelector: string
  originalIndex: number
  newIndex: number
}

DeleteOperation extends Base {
  type: "delete"
  outerHTML?: string
}
```

---

### HTTP Bridge Extensions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/edit-operation` | Validate with Zod discriminated union, append to queue. 400 on invalid/unrecognized type. |
| GET | `/edit-operations` | Return `{ operations: EditOperation[], sessionStartedAt: string }` |
| DELETE | `/edit-operations` | Clear the queue |

All existing endpoints (`/selection`, `/style-change`) remain unchanged.

### MCP Server Extensions

| Type | Name | Description |
|------|------|-------------|
| Resource | `[Visual] Edit operations` | All queued operations formatted as markdown |
| Prompt | `[Visual] Apply edits` | Translate all queued operations into source code changes |
| Prompt | `[Visual] Apply single edit` | Translate a specific operation by index |

**Formatter output per operation type:**
- Move: element identifier, original parent+index, new parent+index
- Resize: element identifier, original dimensions, new dimensions, CSS properties to modify
- Text-edit: element identifier, original text, new text
- Style-change: element identifier, property, old value, new value, Tailwind equivalent if applicable
- When queue is empty: instructional message to make edits first

---

### Undo/Redo Implementation

Managed entirely in the browser overlay (not the server):

```
State:
  undoStack: Array<{ op: EditOperation, revertFn: () => void, reapplyFn: () => void }>
  redoStack: same shape

pushOperation(op, revertFn, reapplyFn):
  undoStack.push({ op, revertFn, reapplyFn })
  redoStack = []  // clear redo on new operation

undo():
  entry = undoStack.pop()
  redoStack.push(entry)
  entry.revertFn()  // revert DOM change

redo():
  entry = redoStack.pop()
  undoStack.push(entry)
  entry.reapplyFn()  // re-apply DOM change
```

The HTTP bridge only receives the final committed operations when synced for AI consumption.

---

### Style Panel: Plasmic-Style Section Order

The right sidebar follows Plasmic's section ordering:

1. Visibility
2. Size (width, height, min/max)
3. Typography (fontSize, fontWeight, fontFamily, lineHeight, textAlign, color)
4. Positioning (position, top/right/bottom/left, zIndex)
5. Spacing (padding, margin) — with visual box model diagram
6. Layout (display, flexDirection, justifyContent, alignItems, gap, grid)
7. Overflow
8. Background (backgroundColor, backgroundImage)
9. Border (borderWidth, borderStyle, borderColor, borderRadius)
10. Shadows (boxShadow, textShadow)
11. Effects (opacity, cursor, filter, mixBlendMode)
12. Transitions
13. Transform

Each section is collapsible, shows a property count badge, and only appears if the element has matching properties. An "Other" catch-all section captures uncategorized properties.

Tailwind utility equivalents are shown as inline badges next to CSS values using a mapping table (e.g., `display:flex` → `flex`, `fontWeight:700` → `font-bold`).

---

### Error Handling

| Layer | Scenario | Behavior |
|-------|----------|----------|
| HTTP Bridge | Invalid EditOperation payload | 400 with Zod field errors |
| HTTP Bridge | Unrecognized operation type | 400 with descriptive message |
| Overlay | Invalid drop position | Revert to original, red flash 1s |
| Overlay | Bridge unreachable | Queue locally, retry on next interaction, show status indicator |
| Overlay | Source mapper fails | Degrade gracefully — CSS selector + XPath only |
| Overlay | Page navigation during session | Deactivate overlay, clear queue |
| Overlay | Inline edit on element with child HTML | Restrict to text nodes, preserve child structure |
| MCP | Apply edits with empty queue | Return instructional message |
| MCP | Apply single edit with out-of-range index | Return error with queue size |

---

### Correctness Properties (for Property-Based Testing)

| # | Property | What it validates |
|---|----------|-------------------|
| 1 | EditOperation schema round-trip: serialize → parse → deep equal | Schema correctness |
| 2 | Operation queue round-trip through HTTP: POST each → GET all → same order and fields | Bridge reliability |
| 3 | Undo then redo restores undo stack, empties redo stack | Undo/redo correctness |
| 4 | New op after K undos: redo stack empty, undo stack = N-K+1 | Redo clearing |
| 5 | Shift+corner resize preserves aspect ratio within ε tolerance | Resize constraint |
| 6 | Every CSS property maps to exactly one category | Categorization completeness |
| 7 | Formatted markdown contains all type-specific fields | Formatter completeness |
| 8 | Tree node label contains tag, id (if present), first class (if present) | Label formatting |
| 9 | Known CSS→Tailwind pairs produce valid non-empty utility classes | Tailwind mapping |
| 10 | N shift-clicks on distinct elements → exactly N selected | Multi-selection |

Use `fast-check` for property-based testing with minimum 100 iterations per property.
