# Changelog

All notable changes to DOM Inspector are documented here.

## [0.7.14] — 2026-11-13

Covers 0.7.1 – 0.7.14 (patch builds made while testing).

### Added
- **Elements tree selection**: clicking a row expands/collapses it and selects the element, like picking it (outlined in the page, Styles/Computed updated, source opened). The ▶ arrow only expands/collapses.
- **Session persistence**: the sidebar keeps its tree, selected element, Console and current tab when you switch to another view and back, and restores them if VS Code recreates the view.
- **Version footer** at the bottom of the sidebar (`DOM Inspector v0.7.14`, `(dev)` when running from source).
- The inspect button follows the real picking state wherever picking starts or stops (button, `Ctrl+Shift+I`, panel toolbar, pick, Escape, right-click menu, page reload); clicking it while active stops picking.

### Changed
- **Single package**: the extension and the MCP server now build from one `package.json` at the repo root, with all source in `src/` (MCP server in `src/mcp-server/`, still bundled into `mcp-server/index.js`). Source is grouped into `browser/`, `source/`, `ai/`, `ui/` and `webview/`.
- The injected inspector script and the sidebar's HTML/CSS/JS are plain files in `src/webview/` instead of strings inside TypeScript.
- Injected DOM markers renamed from `data-kiro-*` / `.kiro-*` to `data-dom-inspector-*` / `.dom-inspector-*`.
- Sidebar typography unified: 12px for content (monospace for code), 11px for secondary text. The Computed tab, previously 9–11px, now matches the Elements and Styles tabs.
- Tab bar fills the sidebar width; tabs and the inspect button are larger; the selected tab is bold.
- Elements tree arrows use the same ▶ as the Computed accordions; the selected row has a solid highlight.
- The VSIX only ships the compiled extension, the MCP bundle, webview assets and media (about 545 KB, was 745 KB).
- `pnpm build` type-checks everything, including the MCP server, before compiling and bundling.

### Fixed
- Selected tab, active inspect button, selected tree row and the box-model size were faint or invisible in themes with a translucent focus colour (Cursor's built-in themes).
- The inspect button stayed active after a pick, and clicking it to stop did nothing.
- 20px of side padding (VS Code's default webview style) around the whole sidebar.
- Add-property inputs in the Styles tab were shorter than the property editors.
- `rebuild-all.sh` stopped after packaging and never installed the VSIX.

### Removed
- Sidebar code that was never shown (element summary, DOM path, component chain, HTML preview, force-state bar) and the messages only it used.
- The "Search DOM…" box, which did nothing.
- The `@dom-inspector` chat participant, which VS Code never registered (it wasn't declared in `package.json`).
- Outdated TypeScript copies of the inspector (`src/inspector/`) and tests that only checked local copies of the logic.
- Committed build output (`dom-inspector-mcp/dist/`, the MCP bundle) and the stale package README.

## [0.4.2 – 0.7.0] — 2026-04-03 to 2026-11-09

Released as frequent patch builds; changes are grouped by period rather than listed per version.

### Added (November, up to 0.7.0)
- **Browser choice** (`domInspector.browser`): VS Code's integrated browser, Cursor's browser tab, Simple Browser, the DOM Inspector panel or the system browser. Outside the panel, the inspector talks to the editor over a token-protected HTTP channel on the proxy.
- **Send to AI**: right-click menu in the page (Send to ‹assistant›, Send to…, Copy as Markdown, Inspect element). Elements go to Claude Code, Cursor Chat, Kiro, Copilot Chat, Cline, Roo Code, Continue, a custom command or the clipboard, as Markdown snapshots in `.dom-inspector/`. `[DOM]` commands (send, analyze, apply style edits, remove) work without MCP.
- **MCP registration**: automatic for the editor's own AI (Kiro, Cursor, VS Code) and on demand for other clients (**Set Up MCP for AI Tools…**). Several AI clients can run the server at once and share one bridge.
- **Exact source lines for React 19** from owner stacks and the dev server's source maps; better line scoring for other setups.
- Picker keyboard navigation (↑ parent, ↓ child, ← / → elements stacked under the cursor), and SVG internals promoted to their `<svg>`.
- Hot reload through the proxy (WebSocket tunnelling); styles from adopted stylesheets.

### Added (April, 0.4.x)
- Styles tab with live editing (type-aware editors, toggles, add property with autocomplete) and a Computed tab (box model, non-default values, grouped accordions, filter).
- Full DOM tree in the sidebar, URL history (50 entries), and selecting `<body>` automatically when a page loads.
- Selecting the element's whole tag range in the editor (opening to closing tag).
- MCP server (`dom-inspector-mcp`): the selected element as a resource plus analyze, apply-styles and remove prompts, fed by a local HTTP bridge.
- Detailed logging (Output channel and the sidebar Console).

## [0.4.1] — 2026-04-02

### Fixed
- Webview inline scripts blocked by missing CSP nonce — inspect button and all message relay now work correctly.

### Changed
- Renamed extension from "AI Terminal" to "DOM Inspector" across all commands, view IDs, and contribution points.
- Consolidated duplicate inspect commands (`pickElement` + `inspectElement`) into a single `domInspector.inspectElement` command.
- Activity bar icon changed from `$(search)` to a custom inspect SVG (`media/inspect.svg`).
- Sidebar view renamed from "Inspector" to "DOM Inspector".

## [0.4.0] — 2026-04-02

### Added
- Sidebar hover preview — hovering elements during inspection now updates the sidebar with tag, classes, and dimensions in real time.
- Property-based test suite using `fast-check` and `vitest` covering overlay rendering, box model containment, element data completeness, framework detection priority, bridge message serialization, proxy HTML injection, source mapper strategy chain, DOM attribute hints, sidebar label formatting, and chat context completeness (43 tests).

### Fixed
- Proxy crashes on malformed URLs — `new URL()` failures now return a 400 instead of crashing the request handler.
- Proxy redirects escape the iframe — 3xx `Location` headers are now rewritten to proxy-relative paths.
- Proxy garbles compressed HTML — added `accept-encoding: identity` header and fallback gzip/brotli/deflate decompression before script injection.
- Proxy double `writeHead` on error — guarded with `res.headersSent` check.

## [0.3.0] — 2026-04-01

### Added
- Full DOM Inspector implementation: overlay renderer, DOM extractor, framework detector, inspector script, bridge channel, source mapper, sidebar panel, component breadcrumb, chat context builder.
- Chrome DevTools-style box model overlays with color-coded content/padding/border/margin layers.
- Multi-strategy source resolution chain (source map → framework hook → DOM attribute → grep fallback).
- Framework detection for React, Vue (v2 & v3), Angular, and Svelte.
- Lazy-loaded DOM tree in sidebar with expand/collapse and 500-node limit per level.
- Component breadcrumb in status bar with clickable segments.
- AI chat context insertion with Markdown formatting and fenced code snippets.
- Bidirectional typed message bridge with heartbeat-based connection monitoring.

## [0.2.0] — 2026-03-28

### Added
- Initial element picker with basic overlay.
- Embedded browser panel with proxy for local dev server URLs.
- Header stripping for `X-Frame-Options` and `Content-Security-Policy`.
- Inspector script injection into proxied HTML responses.
