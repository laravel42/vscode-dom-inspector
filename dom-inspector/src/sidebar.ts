import * as vscode from "vscode";
import { ElementData, ChildSummary, ComputedStyleData, HoverData, BoxModelData, ComponentInfo, FullTreeNode } from "./types";

/**
 * Format a DOM tree node label: `tag#id.class1.class2`
 */
export function formatNodeLabel(tag: string, id: string | null, classNames: string[]): string {
  let label = tag;
  if (id) label += `#${id}`;
  for (const cls of classNames) {
    label += `.${cls}`;
  }
  return label;
}

/** Callbacks the host wires up so the sidebar can communicate outward. */
export interface SidebarCallbacks {
  onNodeClicked(selector: string): void;
  onRequestChildren(selector: string): void;
  onOpenUrl?(url: string): void;
  onForceState?(selector: string, state: string, enabled: boolean): void;
  onSetStyle?(selector: string, property: string, value: string): void;
  onToggleStyle?(selector: string, property: string, enabled: boolean): void;
}

const MAX_CHILDREN_PER_NODE = 500;

/* ------------------------------------------------------------------ */
/*  Helper: HTML-escape for use in renderer functions                  */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/*  Renderer Functions (exported, pure string → string)               */
/* ------------------------------------------------------------------ */

/**
 * Render the element summary HTML: tag, id, classes, selector, dimensions,
 * attributes, and text preview.
 */
export function renderElementSummary(data: ElementData): string {
  let html = '<span class="el-tag">&lt;' + esc(data.tag) + '&gt;</span>';
  if (data.id) html += ' <span class="el-id">#' + esc(data.id) + '</span>';
  if (data.classNames && data.classNames.length) {
    html += ' ' + data.classNames.map(c => '<span class="el-class">.' + esc(c) + '</span>').join(" ");
  }
  if (data.boxModel && data.boxModel.content) {
    const c = data.boxModel.content;
    html += '<div class="dims">';
    html += '<span class="dim-label">W</span> <span class="dim-val">' + Math.round(c.width) + 'px</span>';
    html += '<span class="dim-label">H</span> <span class="dim-val">' + Math.round(c.height) + 'px</span>';
    html += '<span class="dim-label">X</span> <span class="dim-val">' + Math.round(c.x) + '</span>';
    html += '<span class="dim-label">Y</span> <span class="dim-val">' + Math.round(c.y) + '</span>';
    html += '</div>';
  }
  if (data.attrs && Object.keys(data.attrs).length) {
    const filtered = Object.entries(data.attrs).filter(([k]) => k !== 'class' && k !== 'id' && k !== 'style');
    if (filtered.length) {
      html += '<div class="attr-row">';
      for (const [k, v] of filtered) {
        html += '<span class="attr"><span class="attr-key">' + esc(k) + '</span>=<span class="attr-val">"' + esc(String(v).slice(0, 60)) + '"</span></span> ';
      }
      html += '</div>';
    }
  }
  if (data.xpath) {
    html += '<div class="el-path-row"><span class="el-path-label">XPath</span><span class="el-path-value">' + esc(data.xpath) + '</span></div>';
  }
  if (data.cssSelectorPath) {
    html += '<div class="el-path-row"><span class="el-path-label">CSS Path</span><span class="el-path-value">' + esc(data.cssSelectorPath) + '</span></div>';
  }
  if (data.text && data.text.trim()) {
    html += '<div class="text-preview">"' + esc(data.text.slice(0, 150)) + '"</div>';
  }
  return html;
}

/**
 * Render the box model diagram HTML.
 * Returns empty string when boxModel is undefined.
 */
export function renderBoxModel(boxModel: BoxModelData | undefined): string {
  if (!boxModel) return '';
  const c = boxModel.content, p = boxModel.padding, b = boxModel.border, m = boxModel.margin;
  const w = Math.round(c.width), h = Math.round(c.height);
  return '<div class="box-model"><div class="box-model-diagram">' +
    '<div class="bm-layer bm-margin"><span class="bm-label">margin</span>' +
      '<div class="bm-vals"><span>' + m.left + '</span><span>' + m.right + '</span></div>' +
      '<div class="bm-h"><span class="bm-vals-v"><span>' + m.top + '</span></span>' +
      '<div class="bm-layer bm-border"><span class="bm-label">border</span>' +
        '<div class="bm-vals"><span>' + b.left + '</span><span>' + b.right + '</span></div>' +
        '<div class="bm-h"><span class="bm-vals-v"><span>' + b.top + '</span></span>' +
        '<div class="bm-layer bm-padding"><span class="bm-label">padding</span>' +
          '<div class="bm-vals"><span>' + p.left + '</span><span>' + p.right + '</span></div>' +
          '<div class="bm-h"><span class="bm-vals-v"><span>' + p.top + '</span></span>' +
          '<div class="bm-layer bm-content">' +
            '<span class="bm-content-size">' + w + ' \u00d7 ' + h + '</span>' +
          '</div>' +
          '<span class="bm-vals-v"><span>' + p.bottom + '</span></span></div>' +
        '</div>' +
        '<span class="bm-vals-v"><span>' + b.bottom + '</span></span></div>' +
      '</div>' +
      '<span class="bm-vals-v"><span>' + m.bottom + '</span></span></div>' +
    '</div>' +
  '</div></div>';
}

/**
 * Render the DOM path breadcrumb HTML.
 * Segments with syntax-colored tag, id, class parts separated by ›.
 */
export function renderDOMPath(domPath: string[]): string {
  if (!domPath || !domPath.length) {
    return '<span style="color:var(--text-muted)">\u2014</span>';
  }
  return '<div class="dom-path">' +
    domPath.map(function(seg) {
      const parts = seg.match(/^([a-z0-9-]+)(#[^.]*)?(\..*)?\s*$/i) || [seg, seg];
      let h = '<span class="dp-seg">' + esc(parts[1] || seg);
      if (parts[2]) h += '<span class="dp-id">' + esc(parts[2]) + '</span>';
      if (parts[3]) h += '<span class="dp-cls">' + esc(parts[3]) + '</span>';
      return h + '</span>';
    }).join('<span class="dp-sep"> \u203a </span>') +
    '</div>';
}

/**
 * Render the component hierarchy HTML.
 * Framework badge in uppercase, indented component chain, source file/line.
 * Returns empty string when componentInfo is null or has empty componentPath.
 */
export function renderComponentHierarchy(componentInfo: ComponentInfo | null): string {
  if (!componentInfo || !componentInfo.componentPath || !componentInfo.componentPath.length) {
    return '';
  }
  const ci = componentInfo;
  let html = '';
  if (ci.framework) {
    html += '<span class="comp-badge">' + esc(ci.framework.toUpperCase()) + '</span> ';
  }
  html += '<div class="comp-chain">';
  ci.componentPath.forEach(function(name: string, i: number) {
    html += '<div class="comp-node" style="--cdepth:' + i + '"><span class="comp-name">' + esc(name) + '</span></div>';
  });
  html += '</div>';
  if (ci.sourceFile) {
    html += '<div class="comp-meta">' + esc(ci.sourceFile) + (ci.sourceLine ? ':' + ci.sourceLine : '') + '</div>';
  }
  return html;
}

/**
 * Render the computed styles HTML.
 * Groups: Layout (display, position, width, height, boxSizing),
 *         Typography (fontSize, fontFamily),
 *         Color (color, backgroundColor).
 * Color swatches for rgb/hex values.
 */
export function renderComputedStyles(styles: ComputedStyleData): string {
  function isColorValue(v: string): boolean { return v != null && (v.startsWith('rgb') || v.startsWith('#')); }
  function colorSwatch(v: string): string {
    if (!isColorValue(v)) return '';
    return '<span class="color-swatch" style="background:' + esc(v) + '"></span>';
  }

  const groups: { label: string; keys: (keyof ComputedStyleData)[] }[] = [
    { label: 'Layout', keys: ['display', 'position', 'width', 'height', 'boxSizing'] },
    { label: 'Typography', keys: ['fontSize', 'fontFamily'] },
    { label: 'Color', keys: ['color', 'backgroundColor'] },
  ];

  let html = '';
  for (const group of groups) {
    html += '<div class="style-group"><div style="font-size:10px;color:var(--text-muted);padding:4px 0;text-transform:uppercase;letter-spacing:0.3px">' + esc(group.label) + '</div>';
    html += '<div class="style-grid">';
    for (const k of group.keys) {
      const v = String(styles[k] ?? '');
      html += '<span class="style-key">' + esc(k) + '</span><span class="style-val">' + colorSwatch(v) + esc(v) + '</span>';
    }
    html += '</div></div>';
  }
  return html;
}

/**
 * Render the HTML preview with syntax highlighting.
 * Returns empty string when outerSnippet is empty.
 */
export function renderHTMLPreview(outerSnippet: string): string {
  if (!outerSnippet) return '';
  const highlighted = esc(outerSnippet)
    .replace(/&lt;(\/?)([a-zA-Z][a-zA-Z0-9-]*)/g, '<span class="hl-punct">&lt;$1</span><span class="hl-tag">$2</span>')
    .replace(/&gt;/g, '<span class="hl-punct">&gt;</span>')
    .replace(/\s([a-zA-Z][a-zA-Z0-9-]*)=/g, ' <span class="hl-attr">$1</span>=')
    .replace(/=&quot;([^&]*)&quot;/g, '=<span class="hl-punct">&quot;</span><span class="hl-val">$1</span><span class="hl-punct">&quot;</span>');
  return '<button class="code-copy" id="copy-html">Copy</button>' +
    '<pre class="code-editor">' + highlighted + '</pre>';
}

/**
 * Render the initial DOM tree HTML from children.
 * Tree nodes with syntax-colored labels, 16px depth indentation,
 * toggle indicators, child counts. Cap at 500 nodes with overflow indicator.
 */
export function renderDOMTree(children: ChildSummary[]): string {
  let html = '';
  const limit = Math.min(children.length, MAX_CHILDREN_PER_NODE);
  for (let i = 0; i < limit; i++) {
    const child = children[i];
    const toggle = child.childCount > 0 ? '▸' : ' ';
    let label = '<span class="t-tag">' + esc(child.tag) + '</span>';
    if (child.id) label += '<span class="t-id">#' + esc(child.id) + '</span>';
    if (child.classNames && child.classNames.length) {
      label += child.classNames.map(c => '<span class="t-class">.' + esc(c) + '</span>').join('');
    }
    if (child.childCount > 0) {
      label += ' <span class="t-count">(' + child.childCount + ')</span>';
    }
    html += '<div class="tree-node" style="--depth:0" data-selector="' + esc(child.selectorPath) + '">' +
      '<span class="tree-toggle">' + toggle + '</span>' +
      '<span class="tree-label">' + label + '</span>' +
      '</div>';
  }
  if (children.length > MAX_CHILDREN_PER_NODE) {
    html += '<div class="show-more" style="--depth:0">\u2026 ' + (children.length - MAX_CHILDREN_PER_NODE) + ' more nodes</div>';
  }
  return html;
}

/**
 * Render the empty debug log container HTML.
 */
export function renderDebugLog(): string {
  return '<div id="debug-log" style="overflow-y:auto;font:11px/1.4 monospace;padding:8px 12px;color:var(--text-muted);background:var(--bg);border-top:1px solid var(--border);flex:1;"></div>';
}

/**
 * Render all computed styles as an alphabetically sorted two-column grid.
 * Adds inline color swatches for rgb, rgba, #, and hsl values.
 */
export function renderAllComputedStyles(styles: Record<string, string>): string {
  const keys = Object.keys(styles).sort().filter(k => k.charAt(0) !== '-');
  if (keys.length === 0) return '';
  let html = '<div class="all-styles-grid">';
  for (const k of keys) {
    const v = styles[k];
    let swatch = '';
    if (v && (v.startsWith('rgb') || v.startsWith('rgba') || v.startsWith('#') || v.startsWith('hsl'))) {
      swatch = '<span class="color-swatch" style="background:' + esc(v) + '"></span>';
    }
    html += '<span class="style-key">' + esc(k) + '</span><span class="style-val">' + swatch + esc(v) + '</span>';
  }
  html += '</div>';
  return html;
}

/**
 * All CSS rules for the sidebar webview, extracted from buildHtml().
 * Uses VSCode theme tokens for theme-sensitive colors and a 4px spacing grid.
 */
export const SIDEBAR_STYLE: string = `
  :root {
    --bg: var(--vscode-editor-background);
    --bg-secondary: var(--vscode-sideBar-background);
    --border: var(--vscode-panel-border);
    --text: var(--vscode-editor-foreground);
    --text-muted: var(--vscode-descriptionForeground);
    --accent: var(--vscode-focusBorder);
    --tag-color: #ff7b72;
    --id-color: #d2a8ff;
    --class-color: #79c0ff;
    --attr-key: #79c0ff;
    --attr-val: #a5d6ff;
    --highlight-bg: rgba(88,166,255,0.12);
    --green: #3fb950;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font: 11px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--text);
    background: var(--bg);
    overflow-y: auto;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    padding: 8px 12px 4px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
  }
  .section { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .empty-state { padding: 24px 12px; text-align: center; color: var(--text-muted); }
  .open-url-btn {
    display: inline-block; margin-top: 12px; padding: 8px 16px;
    background: var(--accent); color: var(--vscode-editor-background); border: none; border-radius: 4px;
    font: 12px/1.4 system-ui; cursor: pointer; font-weight: 500;
  }
  .open-url-btn:hover { opacity: 0.85; }

  /* Element summary */
  .el-tag { color: var(--tag-color); font-weight: 600; }
  .el-id { color: var(--id-color); }
  .el-class { color: var(--class-color); }
  .el-selector { font-size: 11px; color: var(--text-muted); margin-top: 4px; font-family: monospace; }
  .attr-row { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  .attr { font-size: 11px; background: rgba(110,118,129,0.1); padding: 0 4px; border-radius: 3px; }
  .attr-key { color: var(--attr-key); }
  .attr-val { color: var(--attr-val); }

  /* Text & HTML preview */
  .text-preview {
    margin-top: 8px; padding: 4px 8px; background: rgba(110,118,129,0.08);
    border-radius: 4px; font-size: 11px; color: var(--text-muted);
    max-height: 48px; overflow: hidden; word-break: break-word;
  }
  .code-editor {
    margin: 0; padding: 8px 12px; background: var(--vscode-editor-background);
    border: 1px solid var(--border); border-radius: 4px;
    font: 12px/1.5 "SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace;
    color: var(--text); white-space: pre-wrap; word-break: break-all;
    overflow-x: auto; max-height: 200px; overflow-y: auto;
    tab-size: 2; counter-reset: line;
  }
  .code-editor .hl-tag { color: var(--tag-color); }
  .code-editor .hl-attr { color: var(--attr-key); }
  .code-editor .hl-val { color: var(--attr-val); }
  .code-editor .hl-punct { color: var(--text-muted); }
  .code-editor .hl-text { color: var(--text); opacity: 0.7; }
  .code-copy {
    float: right; background: none; border: 1px solid var(--border); border-radius: 3px;
    color: var(--text-muted); font-size: 10px; padding: 0 8px; cursor: pointer;
    margin-bottom: 4px; transition: color 0.1s, border-color 0.1s;
  }
  .code-copy:hover { color: var(--text); border-color: var(--text-muted); }

  /* Dimensions bar */
  .dims { display: flex; gap: 8px; align-items: center; margin-top: 8px; font-size: 11px; }
  .dims .dim-label { color: var(--text-muted); }
  .dims .dim-val { color: var(--text); font-family: monospace; font-weight: 500; }

  /* Box model diagram */
  .box-model { margin-top: 8px; display: flex; justify-content: center; }
  .box-model-diagram { position: relative; text-align: center; font: 10px/1 monospace; width: 100%; max-width: 260px; }
  .bm-layer { border: 1px dashed; padding: 8px 12px; border-radius: 3px; position: relative; }
  .bm-margin { border-color: rgba(246,178,107,0.7); background: rgba(246,178,107,0.06); }
  .bm-border { border-color: rgba(255,229,153,0.7); background: rgba(255,229,153,0.06); }
  .bm-padding { border-color: rgba(147,196,125,0.7); background: rgba(147,196,125,0.06); }
  .bm-content { border-color: rgba(111,168,220,0.7); background: rgba(111,168,220,0.1); min-height: 24px; display: flex; align-items: center; justify-content: center; }
  .bm-label { position: absolute; font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; }
  .bm-margin > .bm-label { top: 0; left: 4px; color: rgba(246,178,107,0.8); }
  .bm-border > .bm-label { top: 0; left: 4px; color: rgba(255,229,153,0.8); }
  .bm-padding > .bm-label { top: 0; left: 4px; color: rgba(147,196,125,0.8); }
  .bm-vals { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); }
  .bm-vals-v { display: flex; flex-direction: column; align-items: center; font-size: 10px; color: var(--text-muted); }
  .bm-h { display: flex; align-items: center; gap: 4px; }
  .bm-content-size { font-size: 11px; color: var(--accent); font-weight: 500; }

  /* DOM path */
  .dom-path { display: flex; flex-wrap: wrap; gap: 0; align-items: center; font: 11px/1.4 monospace; }
  .dom-path .dp-seg {
    cursor: pointer; padding: 4px 8px; border-radius: 3px;
    color: var(--tag-color); transition: background 0.1s;
  }
  .dom-path .dp-seg:hover { background: var(--highlight-bg); }
  .dom-path .dp-seg .dp-id { color: var(--id-color); }
  .dom-path .dp-seg .dp-cls { color: var(--class-color); opacity: 0.7; }
  .dom-path .dp-sep { color: var(--border); padding: 0; user-select: none; }

  /* Component hierarchy */
  .comp-chain { display: flex; flex-direction: column; gap: 0; font: 11px/1 monospace; }
  .comp-node {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 8px 4px calc(var(--cdepth, 0) * 16px + 8px);
    border-left: 1px solid var(--border); margin-left: 8px;
    cursor: default; transition: background 0.1s;
  }
  .comp-node:first-child { border-left-color: transparent; }
  .comp-node:hover { background: var(--highlight-bg); }
  .comp-name { color: var(--accent); font-weight: 500; }
  .comp-badge {
    display: inline-block; font-size: 9px; padding: 0 4px; border-radius: 3px;
    background: rgba(88,166,255,0.1); color: var(--accent); text-transform: uppercase;
    letter-spacing: 0.3px; font-weight: 600;
  }
  .comp-meta { font-size: 10px; color: var(--text-muted); margin-top: 4px; padding: 0 8px; }
  .comp-meta a { color: var(--accent); text-decoration: none; }
  .comp-meta a:hover { text-decoration: underline; }

  /* Force state bar */
  .force-state-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .force-state-bar label { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--text-muted); cursor: pointer; user-select: none; }
  .force-state-bar label:hover { color: var(--text); }
  .force-state-bar .fs-label { font-size: 10px; color: var(--text-muted); font-weight: 500; }

  /* Active styles list */
  .as-rule { margin-bottom: 4px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  .as-selector { font: 11px/1.5 monospace; color: var(--accent); padding: 2px 8px; user-select: text; }
  .as-row {
    display: grid; grid-template-columns: 18px auto 1fr; gap: 0 6px; align-items: center;
    padding: 3px 8px; font: 11px/1.5 monospace; border-bottom: 1px solid rgba(128,128,128,0.08);
    transition: background 0.06s;
  }
  .as-row:hover { background: rgba(88,166,255,0.06); }
  .as-row.disabled { opacity: 0.4; }
  .as-row.disabled .as-val-wrap { text-decoration: line-through; }
  .as-cb { width: 12px; height: 12px; margin: 0; cursor: pointer; accent-color: var(--accent); }
  .as-prop { color: var(--attr-key); white-space: nowrap; }
  .as-val-wrap { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }
  .as-select {
    font: 11px/1.4 monospace; color: var(--text); background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; outline: none;
    min-width: 0; flex: 1; max-width: 100%; cursor: pointer;
  }
  .as-select:focus { border-color: var(--accent); }
  .as-num {
    font: 11px/1.4 monospace; color: var(--text); background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; outline: none;
    width: 52px; flex-shrink: 0; text-align: right;
  }
  .as-num:focus { border-color: var(--accent); }
  .as-unit {
    font: 11px/1.4 monospace; color: var(--text); background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; outline: none;
    width: 48px; flex-shrink: 0; cursor: pointer;
  }
  .as-unit:focus { border-color: var(--accent); }
  .as-text {
    font: 11px/1.4 monospace; color: var(--text); background: transparent;
    border: none; outline: none; padding: 0 2px; border-radius: 2px;
    min-width: 0; flex: 1;
  }
  .as-text:focus { background: var(--vscode-input-background, var(--bg-secondary)); box-shadow: 0 0 0 1px var(--accent); }
  .as-color-input { width: 16px; height: 16px; padding: 0; border: 1px solid rgba(128,128,128,0.3); border-radius: 2px; cursor: pointer; background: none; flex-shrink: 0; }
  .as-color-input::-webkit-color-swatch-wrapper { padding: 0; }
  .as-color-input::-webkit-color-swatch { border: none; border-radius: 1px; }
  .as-add-row {
    display: flex; align-items: center; gap: 6px; padding: 4px 8px;
    border-top: 1px solid var(--border); margin-top: 2px;
  }
  .as-add-input {
    font: 11px/1.4 monospace; color: var(--text); background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--border); border-radius: 3px; padding: 2px 6px; outline: none; flex: 1;
  }
  .as-add-input:focus { border-color: var(--accent); }
  .as-add-input::placeholder { color: var(--text-muted); opacity: 0.5; }
  .ac-popup { position: fixed; z-index: 9999; background: var(--vscode-editorSuggestWidget-background, var(--bg-secondary)); border: 1px solid var(--vscode-editorSuggestWidget-border, var(--border)); border-radius: 3px; max-height: 160px; overflow-y: auto; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .ac-popup::-webkit-scrollbar { width: 6px; }
  .ac-popup::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 3px; }
  .ac-item { padding: 0 6px; font: 10px/16px monospace; color: var(--text); cursor: pointer; white-space: nowrap; }
  .ac-item.active { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--accent)); color: var(--vscode-editorSuggestWidget-selectedForeground, #fff); }

  /* Computed styles */
  .style-grid { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; font-size: 11px; }
  .style-key { color: var(--attr-key); }
  .style-val { color: var(--text); word-break: break-all; }
  .color-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; border: 1px solid var(--border); vertical-align: middle; margin-right: 4px; }

  /* DOM tree */
  #dom-tree { font: 12px/1.4 monospace; padding: 4px 0; }
  .tree-node {
    padding: 4px 0 4px calc(var(--depth, 0) * 16px + 8px);
    cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    display: flex; align-items: center; gap: 4px;
    border-left: 2px solid transparent; transition: background 0.08s;
  }
  .tree-node:hover { background: rgba(88,166,255,0.06); }
  .tree-node.highlighted {
    background: rgba(88,166,255,0.18);
    border-left-color: var(--accent);
    outline: 1px solid rgba(88,166,255,0.4);
    outline-offset: -1px;
  }
  .tree-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; font-size: 10px;
    color: var(--text-muted); flex-shrink: 0; user-select: none;
    border-radius: 3px; transition: background 0.1s;
  }
  .tree-toggle:hover { background: rgba(110,118,129,0.15); }
  .tree-label { display: inline; }
  .tree-label .t-tag { color: var(--tag-color); }
  .tree-label .t-id { color: var(--id-color); font-weight: 500; }
  .tree-label .t-class { color: var(--class-color); opacity: 0.75; }
  .tree-label .t-count { color: var(--text-muted); font-size: 10px; opacity: 0.6; }
  .show-more {
    padding: 4px 12px; color: var(--accent); cursor: pointer; font-size: 11px;
  }
  .show-more:hover { text-decoration: underline; }

  /* DevTools tab bar */
  .devtools-bar {
    display: flex; align-items: center; gap: 0;
    background: var(--bg-secondary); border-bottom: 1px solid var(--border);
    padding: 0; overflow-x: auto; flex-shrink: 0;
    scrollbar-width: none;
  }
  .devtools-bar::-webkit-scrollbar { display: none; }
  .dt-inspect-btn {
    display: flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; flex-shrink: 0;
    background: none; border: none; border-right: 1px solid var(--border);
    color: var(--text-muted); cursor: pointer; transition: color 0.1s, background 0.1s;
  }
  .dt-inspect-btn:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .dt-inspect-btn.active { color: var(--accent); }
  .dt-inspect-btn svg { width: 14px; height: 14px; fill: currentColor; }
  .dt-tab {
    padding: 6px 12px; font: 11px/1 system-ui; color: var(--text-muted);
    cursor: pointer; border: none; background: none; white-space: nowrap;
    border-bottom: 2px solid transparent; transition: color 0.1s, border-color 0.1s;
    flex-shrink: 0;
  }
  .dt-tab:hover { color: var(--text); }
  .dt-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .dt-panel { display: none; flex: 1; overflow-y: auto; }
  .dt-panel.active { display: block; }
  #tab-console.active { display: flex; flex-direction: column; }

  /* DOM search input */
  .dom-search {
    display: block; width: 100%; padding: 4px 8px; margin-bottom: 8px;
    font-size: 11px; font-family: inherit;
    color: var(--text); background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--border); border-radius: 4px; outline: none;
    box-sizing: border-box;
  }
  .dom-search:focus { border-color: var(--accent); }

  /* XPath / CSS selector path rows */
  .el-path-row { display: flex; gap: 8px; align-items: baseline; margin-top: 4px; font-size: 11px; }
  .el-path-label { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
  .el-path-value { color: var(--text); font-family: monospace; word-break: break-all; }

  /* Computed tab filter input */
  .computed-filter-input {
    display: block; width: 100%; padding: 4px 8px; margin-bottom: 8px;
    font-size: 11px; font-family: inherit;
    color: var(--text); background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--border); border-radius: 4px; outline: none;
    box-sizing: border-box;
  }
  .computed-filter-input:focus { border-color: var(--accent); }

  /* All computed styles grid */
  .all-styles-grid { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; font-size: 11px; }

  /* Computed style accordions */
  .cs-accordion { border-bottom: 1px solid var(--border); }
  .cs-accordion-header {
    display: flex; align-items: center; gap: 4px;
    padding: 8px; cursor: pointer; user-select: none;
    font-size: 11px; font-weight: 500; color: var(--text);
    background: none; border: none; width: 100%; text-align: left;
    transition: background 0.08s;
  }
  .cs-accordion-header:hover { background: rgba(88,166,255,0.06); }
  .cs-accordion-arrow {
    display: inline-block; width: 12px; font-size: 10px; color: var(--text-muted);
    transition: transform 0.15s; flex-shrink: 0;
  }
  .cs-accordion.open > .cs-accordion-header .cs-accordion-arrow { transform: rotate(90deg); }
  .cs-accordion-count { color: var(--text-muted); font-weight: 400; font-size: 10px; }
  .cs-accordion-body { display: none; padding: 0 8px 4px 20px; }
  .cs-accordion.open > .cs-accordion-body { display: block; }

  /* URL omnibox — Chrome style */
  .url-bar { position: relative; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .url-omni {
    display: flex; align-items: center; gap: 8px;
    background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--border); border-radius: 20px;
    padding: 0 12px; height: 32px; transition: border-color 0.15s;
  }
  .url-omni:focus-within { border-color: var(--accent); }
  .url-omni .url-icon {
    flex-shrink: 0; width: 14px; height: 14px; color: var(--text-muted); display: flex; align-items: center;
  }
  .url-omni .url-icon svg { width: 14px; height: 14px; fill: currentColor; }
  .url-omni input {
    flex: 1; border: none; outline: none; background: transparent;
    font: 12px/1 monospace; color: var(--text); min-width: 0;
  }
  .url-omni input::placeholder { color: var(--text-muted); opacity: 0.6; }
  .url-dropdown {
    display: none; position: absolute; left: 12px; right: 12px; top: calc(100% - 2px);
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 0 0 8px 8px; max-height: 280px; overflow-y: auto;
    z-index: 10; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .url-dropdown.visible { display: block; }
  .url-dropdown-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px; font: 12px/1.4 monospace; color: var(--text);
    cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: background 0.06s;
  }
  .url-dropdown-item:hover, .url-dropdown-item.active {
    background: var(--highlight-bg);
  }
  .url-dropdown-item .url-item-icon {
    flex-shrink: 0; width: 14px; height: 14px; color: var(--text-muted); display: flex; align-items: center;
  }
  .url-dropdown-item .url-item-icon svg { width: 14px; height: 14px; fill: currentColor; }
  .url-dropdown-item .match { color: var(--accent); font-weight: 500; }
`;

/**
 * InspectorSidebarProvider — renders element details, DOM path,
 * component hierarchy, computed styles, and a DOM tree explorer
 * inside a VSCode sidebar webview.
 */
export class InspectorSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "domInspector.inspectorSidebar";

  private view: vscode.WebviewView | undefined;
  private currentElement: ElementData | undefined;
  private domTreeRoots: ChildSummary[] = [];
  private readonly callbacks: SidebarCallbacks;
  private readonly readyCallbacks: Array<() => void> = [];

  constructor(callbacks: SidebarCallbacks) {
    this.callbacks = callbacks;
  }

  /* ------------------------------------------------------------------ */
  /*  WebviewViewProvider                                                */
  /* ------------------------------------------------------------------ */

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();

    webviewView.webview.onDidReceiveMessage((msg: { type: string; selector?: string; url?: string; [k: string]: unknown }) => {
      if (msg.type === "node_clicked" && msg.selector) {
        this.callbacks.onNodeClicked(msg.selector);
      } else if (msg.type === "request_children" && msg.selector) {
        this.callbacks.onRequestChildren(msg.selector);
      } else if (msg.type === "open_url") {
        vscode.commands.executeCommand("domInspector.openUrl");
      } else if (msg.type === "open_url_direct" && msg.url) {
        if (this.callbacks.onOpenUrl) {
          this.callbacks.onOpenUrl(msg.url);
        }
      } else if (msg.type === "start_inspect") {
        vscode.commands.executeCommand("domInspector.inspectElement");
      } else if (msg.type === "stop_inspect") {
        // Stop inspection handled by the browser panel
      } else if (msg.type === "force_state") {
        if (this.callbacks.onForceState) {
          this.callbacks.onForceState(msg.selector as string, msg.state as string, msg.enabled as boolean);
        }
      } else if (msg.type === "set_style") {
        if (this.callbacks.onSetStyle) {
          this.callbacks.onSetStyle(msg.selector as string, msg.property as string, msg.value as string);
        }
      } else if (msg.type === "toggle_style") {
        if (this.callbacks.onToggleStyle) {
          this.callbacks.onToggleStyle(msg.selector as string, msg.property as string, msg.enabled as boolean);
        }
      } else if (msg.type === "copy_ai_prompt") {
        if (typeof msg.prompt === "string") {
          vscode.env.clipboard.writeText(msg.prompt);
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    // Fire ready callbacks
    for (const cb of this.readyCallbacks) cb();
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                        */
  /* ------------------------------------------------------------------ */

  /** Render full element details in the sidebar. */
  updateElement(data: ElementData): void {
    this.currentElement = data;
    this.postMessage({ type: "update_element", data });
  }

  /** Render / refresh the DOM tree with the given root children. */
  updateDOMTree(children: ChildSummary[]): void {
    this.domTreeRoots = children;
    this.postMessage({ type: "update_dom_tree", children });
  }

  /** Deliver loaded children for a specific parent node (lazy expand). */
  childrenLoaded(selector: string, children: ChildSummary[]): void {
    this.postMessage({ type: "children_loaded", selector, children });
  }

  /** Update the full tree from <html> root. */
  updateFullTree(tree: FullTreeNode): void {
    this.postMessage({ type: "update_full_tree", tree });
  }

  /** Expand the tree to reveal and highlight a specific node. */
  expandToNode(selector: string): void {
    this.postMessage({ type: "expand_to_node", selector });
  }

  /** Lightweight hover preview — updates the element summary without full detail. */
  updateHoverPreview(data: HoverData): void {
    this.postMessage({ type: "update_hover_preview", data });
  }

  /** Send a debug log message to the sidebar panel. */
  log(message: string): void {
    this.postMessage({ type: "debug_log", message });
  }

  /** Show or hide the empty state based on browser panel status. */
  setBrowserOpen(open: boolean): void {
    this.postMessage({ type: "browser_state", open });
  }

  /** Update the URL history in the sidebar autocomplete. */
  updateUrlHistory(history: string[]): void {
    this.postMessage({ type: "url_history", history });
  }

  /** Register a callback for when the sidebar webview is ready. */
  onReady(callback: () => void): void {
    this.readyCallbacks.push(callback);
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>${SIDEBAR_STYLE}</style>
</head>
<body>
  <div class="url-bar" id="url-bar">
    <div class="url-omni">
      <span class="url-icon"><svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2.04 8.5h2.97c.04.9.18 1.74.4 2.5H3.07A5.97 5.97 0 0 1 2.04 8.5zm0-1h2.97c.04-.9.18-1.74.4-2.5H3.07A5.97 5.97 0 0 0 2.04 7.5zM8 14c-.55 0-1.25-.85-1.6-2.5h3.2C9.25 13.15 8.55 14 8 14zm-1.73-3.5c-.2-.76-.33-1.6-.37-2.5h4.2c-.04.9-.17 1.74-.37 2.5H6.27zM8 2c.55 0 1.25.85 1.6 2.5H6.4C6.75 2.85 7.45 2 8 2zm1.73 3.5c.2.76.33 1.6.37 2.5H5.9c.04-.9.17-1.74.37-2.5h3.46zm2.2-1h-2.34c-.22-.76-.5-1.42-.84-1.93A6.01 6.01 0 0 1 12.93 5.5zm-5.68-1.93c-.34.51-.62 1.17-.84 1.93H3.07A6.01 6.01 0 0 1 7.25 2.57zM3.07 11h2.34c.22.76.5 1.42.84 1.93A6.01 6.01 0 0 1 3.07 11zm5.68 1.93c.34-.51.62-1.17.84-1.93h2.34a6.01 6.01 0 0 1-3.18 1.93zm4.21-2.93h-2.37c.22-.76.36-1.6.4-2.5h2.97a5.97 5.97 0 0 1-1 2.5zm.4-3.5h-2.97c-.04-.9-.18-1.74-.4-2.5h2.37a5.97 5.97 0 0 1 1 2.5z"/></svg></span>
      <input type="text" id="url-field" placeholder="Enter URL or search history" autocomplete="off" spellcheck="false" />
    </div>
    <div class="url-dropdown" id="url-dropdown"></div>
  </div>
  <div id="empty" class="empty-state">
    Enter a URL above to start inspecting.
  </div>
  <div id="content" style="display:none">
    <div class="devtools-bar" id="devtools-bar">
      <button class="dt-inspect-btn" id="dt-inspect" title="Inspect element (⌘⇧I)">
        <svg viewBox="0 0 16 16"><path d="M1 1v14h14V1H1zm1 1h12v12H2V2zm2 2v2h1V5h1V4H4zm5 0v1h1v1h1V4H9zM7 7v2h2V7H7zm-3 3v2h2v-1H5v-1H4zm6 0v1h-1v1h2v-2h-1z"/></svg>
      </button>
      <button class="dt-tab active" data-tab="tab-elements">Elements</button>
      <button class="dt-tab" data-tab="tab-styles">Styles</button>
      <button class="dt-tab" data-tab="tab-computed">Computed</button>
      <button class="dt-tab" data-tab="tab-console">Console</button>
    </div>

    <div class="dt-panel active" id="tab-elements">
      <div class="section">
        <input type="text" class="dom-search" placeholder="Search DOM…" />
      </div>
      <div id="dom-tree"></div>
    </div>

    <div class="dt-panel" id="tab-styles">
      <div class="section" id="active-styles"></div>
    </div>

    <div class="dt-panel" id="tab-computed">
      <div class="section" id="computed-box-model"></div>
      <div class="section" id="computed-styles"></div>
    </div>

    <div class="dt-panel" id="tab-console">
      ${renderDebugLog()}
    </div>
  </div>
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const MAX_CHILDREN = ${MAX_CHILDREN_PER_NODE};

  const $ = (id) => document.getElementById(id) || document.createElement('div');
  const emptyEl = $("empty");
  const contentEl = $("content");

  /* ---- URL omnibox with autocomplete ---- */
  const HISTORY_ICON = '<svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 0 11zM8.5 4H7v4.5l3.15 1.89.5-.84L8.5 8V4z"/></svg>';
  let urlHistory = [];
  let dropdownIdx = -1;
  const urlField = $("url-field");
  const urlDropdown = $("url-dropdown");

  function submitUrl() {
    const url = urlField.value.trim();
    if (!url) return;
    urlDropdown.classList.remove("visible");
    dropdownIdx = -1;
    vscode.postMessage({ type: "open_url_direct", url: url });
  }

  urlField.addEventListener("keydown", (e) => {
    const items = urlDropdown.querySelectorAll(".url-dropdown-item");
    if (e.key === "Enter") {
      e.preventDefault();
      if (dropdownIdx >= 0 && items[dropdownIdx]) {
        urlField.value = items[dropdownIdx].dataset.url;
      }
      urlDropdown.classList.remove("visible");
      dropdownIdx = -1;
      submitUrl();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) {
        dropdownIdx = Math.min(dropdownIdx + 1, items.length - 1);
        updateActive(items);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (dropdownIdx > 0) {
        dropdownIdx--;
        updateActive(items);
      }
    } else if (e.key === "Escape") {
      urlDropdown.classList.remove("visible");
      dropdownIdx = -1;
    }
  });

  urlField.addEventListener("input", () => {
    filterDropdown(urlField.value.trim().toLowerCase());
  });

  urlField.addEventListener("focus", () => {
    // Show last 10 on focus, like Chrome
    showRecent();
  });

  urlField.addEventListener("click", () => {
    if (!urlDropdown.classList.contains("visible")) showRecent();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".url-bar")) {
      urlDropdown.classList.remove("visible");
      dropdownIdx = -1;
    }
  });

  function showRecent() {
    const val = urlField.value.trim().toLowerCase();
    if (val) { filterDropdown(val); return; }
    if (!urlHistory.length) { urlDropdown.classList.remove("visible"); return; }
    dropdownIdx = -1;
    const recent = urlHistory.slice(0, 10);
    renderDropdown(recent, "");
  }

  function filterDropdown(query) {
    if (!query) { showRecent(); return; }
    const filtered = urlHistory.filter(u => u.toLowerCase().includes(query)).slice(0, 10);
    if (!filtered.length) { urlDropdown.classList.remove("visible"); return; }
    dropdownIdx = -1;
    renderDropdown(filtered, query);
  }

  function renderDropdown(items, query) {
    urlDropdown.innerHTML = items.map(u => {
      let display = esc(u);
      if (query) {
        const idx = u.toLowerCase().indexOf(query);
        if (idx >= 0) {
          display = esc(u.slice(0, idx)) + '<span class="match">' + esc(u.slice(idx, idx + query.length)) + '</span>' + esc(u.slice(idx + query.length));
        }
      }
      return '<div class="url-dropdown-item" data-url="' + esc(u) + '">' +
        '<span class="url-item-icon">' + HISTORY_ICON + '</span>' +
        '<span>' + display + '</span></div>';
    }).join("");
    urlDropdown.classList.add("visible");

    urlDropdown.querySelectorAll(".url-dropdown-item").forEach(item => {
      item.addEventListener("click", () => {
        urlField.value = item.dataset.url;
        urlDropdown.classList.remove("visible");
        dropdownIdx = -1;
        submitUrl();
      });
    });
  }

  function updateActive(items) {
    items.forEach((it, i) => it.classList.toggle("active", i === dropdownIdx));
    if (items[dropdownIdx]) {
      items[dropdownIdx].scrollIntoView({ block: "nearest" });
    }
  }

  /* ---- DevTools tab switching ---- */
  document.querySelectorAll(".dt-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".dt-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".dt-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = $(tab.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });

  /* ---- Inspect button in tab bar ---- */
  const dtInspect = $("dt-inspect");
  dtInspect.addEventListener("click", () => {
    dtInspect.classList.toggle("active");
    vscode.postMessage({ type: dtInspect.classList.contains("active") ? "start_inspect" : "stop_inspect" });
  });

  /* ---- State ---- */
  let treeData = {};
  let highlightedSel = null;
  let fullTreeLoaded = false;

  /* ---- Helpers ---- */
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function nodeLabel(tag, id, classNames, extra) {
    let h = '<span class="t-tag">' + esc(tag) + '</span>';
    if (id) h += '<span class="t-id">#' + esc(id) + '</span>';
    if (classNames && classNames.length) {
      h += classNames.map(c => '<span class="t-class">.' + esc(c) + '</span>').join("");
    }
    if (extra) h += ' ' + extra;
    return h;
  }

  function isColorValue(v) { return v && (v.startsWith('rgb') || v.startsWith('#')); }
  function colorSwatch(v) {
    if (!isColorValue(v)) return '';
    return '<span class="color-swatch" style="background:' + esc(v) + '"></span>';
  }

  /* ---- HTML syntax highlighter ---- */
  function highlightHtml(raw) {
    return esc(raw)
      .replace(/&lt;(\\/?)([a-zA-Z][a-zA-Z0-9-]*)/g, '<span class="hl-punct">&lt;$1</span><span class="hl-tag">$2</span>')
      .replace(/&gt;/g, '<span class="hl-punct">&gt;</span>')
      .replace(/\\s([a-zA-Z][a-zA-Z0-9-]*)=/g, ' <span class="hl-attr">$1</span>=')
      .replace(/=&quot;([^&]*)&quot;/g, '=<span class="hl-punct">&quot;</span><span class="hl-val">$1</span><span class="hl-punct">&quot;</span>');
  }

  /* ---- Per-panel render functions ---- */

  function renderElementPanel(data) {
    emptyEl.style.display = "none";
    contentEl.style.display = "block";

    let html = '<span class="el-tag">&lt;' + esc(data.tag) + '&gt;</span>';
    if (data.id) html += ' <span class="el-id">#' + esc(data.id) + '</span>';
    if (data.classNames && data.classNames.length) {
      html += ' ' + data.classNames.map(c => '<span class="el-class">.' + esc(c) + '</span>').join(" ");
    }
    if (data.boxModel && data.boxModel.content) {
      const c = data.boxModel.content;
      html += '<div class="dims">';
      html += '<span class="dim-label">W</span> <span class="dim-val">' + Math.round(c.width) + 'px</span>';
      html += '<span class="dim-label">H</span> <span class="dim-val">' + Math.round(c.height) + 'px</span>';
      html += '<span class="dim-label">X</span> <span class="dim-val">' + Math.round(c.x) + '</span>';
      html += '<span class="dim-label">Y</span> <span class="dim-val">' + Math.round(c.y) + '</span>';
      html += '</div>';
    }
    if (data.attrs && Object.keys(data.attrs).length) {
      html += '<div class="attr-row">';
      for (const [k, v] of Object.entries(data.attrs)) {
        if (k === 'class' || k === 'id' || k === 'style') continue;
        html += '<span class="attr"><span class="attr-key">' + esc(k) + '</span>=<span class="attr-val">"' + esc(String(v).slice(0, 60)) + '"</span></span> ';
      }
      html += '</div>';
    }
    if (data.text && data.text.trim()) {
      html += '<div class="text-preview">"' + esc(data.text.slice(0, 150)) + '"</div>';
    }
    if (data.xpath) {
      html += '<div class="el-path-row"><span class="el-path-label">XPath</span><span class="el-path-value">' + esc(data.xpath) + '</span></div>';
    }
    if (data.cssSelectorPath) {
      html += '<div class="el-path-row"><span class="el-path-label">CSS Path</span><span class="el-path-value">' + esc(data.cssSelectorPath) + '</span></div>';
    }
    $("el-summary").innerHTML = html;
  }

  function renderDOMPathSection(domPath) {
    if (domPath && domPath.length) {
      $("dom-path").innerHTML = '<div class="dom-path">' +
        domPath.map(function(seg) {
          var parts = seg.match(/^([a-z0-9-]+)(#[^.]*)?(\\..*)?$/i) || [seg, seg];
          var h = '<span class="dp-seg">' + esc(parts[1] || seg);
          if (parts[2]) h += '<span class="dp-id">' + esc(parts[2]) + '</span>';
          if (parts[3]) h += '<span class="dp-cls">' + esc(parts[3]) + '</span>';
          return h + '</span>';
        }).join('<span class="dp-sep"> \\u203a </span>') +
        '</div>';
    } else {
      $("dom-path").innerHTML = '<span style="color:var(--text-muted)">\\u2014</span>';
    }
  }

  function renderComponentPanel(componentInfo) {
    if (componentInfo && componentInfo.componentPath && componentInfo.componentPath.length) {
      var ci = componentInfo;
      var ch = '';
      if (ci.framework) {
        ch += '<span class="comp-badge">' + esc(ci.framework) + '</span> ';
      }
      ch += '<div class="comp-chain">';
      ci.componentPath.forEach(function(name, i) {
        ch += '<div class="comp-node" style="--cdepth:' + i + '"><span class="comp-name">' + esc(name) + '</span></div>';
      });
      ch += '</div>';
      if (ci.sourceFile) {
        ch += '<div class="comp-meta">' + esc(ci.sourceFile) + (ci.sourceLine ? ':' + ci.sourceLine : '') + '</div>';
      }
      $("comp-hierarchy").innerHTML = ch;
    } else {
      $("comp-hierarchy").innerHTML = '';
    }
  }

  function renderStylesPanel(computedStyles) {
    // Legacy — no longer used for Styles tab
  }

  /* ---- Active Styles Tab ---- */
  let currentActiveStyles = [];
  let currentElementSelector = '';
  let currentElementData = null;
  let forcedStates = { active: false, focus: false, hover: false };

  function renderForceStateBar() {
    var el = $("force-state-bar");
    if (!el) return;
    var h = '<span class="fs-label">Force state:</span>';
    ['hover', 'active', 'focus'].forEach(function(state) {
      h += '<label><input type="checkbox" class="fs-cb" data-state="' + state + '"' + (forcedStates[state] ? ' checked' : '') + ' /> :' + state + '</label>';
    });
    el.innerHTML = h;
    el.querySelectorAll('.fs-cb').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var st = cb.dataset.state;
        forcedStates[st] = cb.checked;
        vscode.postMessage({ type: 'force_state', selector: currentElementSelector, state: st, enabled: cb.checked });
      });
    });
  }

  /* ---- CSS Property Metadata Registry ---- */
  var CSS_UNITS = ['px','rem','em','%','vh','vw','vmin','vmax','ch','ex','cm','mm','in','pt','pc'];
  var KEYWORD_PROPS = {
    display:['block','inline','inline-block','flex','grid','inline-flex','inline-grid','table','inline-table','table-row','table-cell','table-column','table-column-group','table-row-group','table-header-group','table-footer-group','list-item','contents','none'],
    position:['static','relative','absolute','fixed','sticky'],
    visibility:['visible','hidden','collapse'],
    overflow:['visible','hidden','scroll','auto','clip'],
    'overflow-x':['visible','hidden','scroll','auto','clip'],
    'overflow-y':['visible','hidden','scroll','auto','clip'],
    'float':['left','right','none','inline-start','inline-end'],
    clear:['none','left','right','both','inline-start','inline-end'],
    'box-sizing':['content-box','border-box'],
    direction:['ltr','rtl'],
    'unicode-bidi':['normal','embed','bidi-override','isolate','isolate-override','plaintext'],
    'white-space':['normal','nowrap','pre','pre-wrap','pre-line','break-spaces'],
    'word-break':['normal','break-all','keep-all','break-word'],
    'overflow-wrap':['normal','break-word','anywhere'],
    'text-align':['left','right','center','justify','start','end','match-parent'],
    'text-transform':['none','capitalize','uppercase','lowercase','full-width','full-size-kana'],
    'text-decoration-style':['solid','double','dotted','dashed','wavy'],
    'text-decoration-line':['none','underline','overline','line-through'],
    'text-rendering':['auto','optimizeSpeed','optimizeLegibility','geometricPrecision'],
    'font-style':['normal','italic','oblique'],
    'font-variant':['normal','small-caps'],
    'font-stretch':['ultra-condensed','extra-condensed','condensed','semi-condensed','normal','semi-expanded','expanded','extra-expanded','ultra-expanded'],
    'font-weight':['normal','bold','bolder','lighter'],
    'list-style-type':['disc','circle','square','decimal','decimal-leading-zero','lower-roman','upper-roman','lower-alpha','upper-alpha','none'],
    'list-style-position':['inside','outside'],
    'object-fit':['fill','contain','cover','none','scale-down'],
    'object-position':['left','center','right','top','bottom'],
    'background-repeat':['repeat','repeat-x','repeat-y','no-repeat','space','round'],
    'background-size':['auto','cover','contain'],
    'background-attachment':['scroll','fixed','local'],
    'background-clip':['border-box','padding-box','content-box','text'],
    'background-origin':['border-box','padding-box','content-box'],
    cursor:['auto','default','none','context-menu','help','pointer','progress','wait','cell','crosshair','text','vertical-text','alias','copy','move','no-drop','not-allowed','grab','grabbing','zoom-in','zoom-out'],
    'pointer-events':['auto','none'],
    'user-select':['auto','text','none','contain','all'],
    resize:['none','both','horizontal','vertical','block','inline'],
    'flex-direction':['row','row-reverse','column','column-reverse'],
    'flex-wrap':['nowrap','wrap','wrap-reverse'],
    'justify-content':['flex-start','flex-end','center','space-between','space-around','space-evenly','start','end','left','right'],
    'align-items':['stretch','flex-start','flex-end','center','baseline','start','end'],
    'align-self':['auto','stretch','flex-start','flex-end','center','baseline','start','end'],
    'align-content':['stretch','flex-start','flex-end','center','space-between','space-around','space-evenly'],
    'grid-auto-flow':['row','column','dense','row dense','column dense'],
    'table-layout':['auto','fixed'],
    'border-style':['none','hidden','dotted','dashed','solid','double','groove','ridge','inset','outset'],
    'outline-style':['none','auto','dotted','dashed','solid','double','groove','ridge','inset','outset'],
    'animation-direction':['normal','reverse','alternate','alternate-reverse'],
    'animation-fill-mode':['none','forwards','backwards','both'],
    'animation-play-state':['running','paused'],
    'transition-property':['none','all'],
  };
  var SIZE_PROPS = ['width','height','min-width','max-width','min-height','max-height','margin','margin-top','margin-right','margin-bottom','margin-left','padding','padding-top','padding-right','padding-bottom','padding-left','top','right','bottom','left','font-size','border-width','border-radius','gap','row-gap','column-gap'];
  var COLOR_PROPS = ['color','background-color','border-color','border-top-color','border-right-color','border-bottom-color','border-left-color','outline-color','text-decoration-color','fill','stroke','caret-color','accent-color','column-rule-color'];

  var ALL_CSS_PROPS = (function(){
    var s = getComputedStyle(document.documentElement);
    var set = {};
    for (var i = 0; i < s.length; i++) { var p = s[i]; if (p.charAt(0) !== '-') set[p] = 1; }
    return Object.keys(set).sort();
  })();

  var acPopup = null, acItems = [], acIdx = -1, acTarget = null;
  function acShow(inp) {
    var q = inp.value.toLowerCase();
    var matches = q ? ALL_CSS_PROPS.filter(function(p){return p.indexOf(q) !== -1;}).slice(0,20) : ALL_CSS_PROPS.slice(0,20);
    if (!matches.length) { acHide(); return; }
    if (!acPopup) { acPopup = document.createElement('div'); acPopup.className = 'ac-popup'; document.body.appendChild(acPopup); }
    acItems = matches; acIdx = 0; acTarget = inp;
    var h = ''; matches.forEach(function(m,i){ h += '<div class="ac-item' + (i===0?' active':'') + '" data-i="'+i+'">' + m + '</div>'; });
    acPopup.innerHTML = h;
    var r = inp.getBoundingClientRect();
    acPopup.style.left = r.left + 'px'; acPopup.style.top = (r.bottom+1) + 'px'; acPopup.style.minWidth = r.width + 'px'; acPopup.style.display = 'block';
    acPopup.querySelectorAll('.ac-item').forEach(function(el){
      el.addEventListener('mousedown', function(e){ e.preventDefault(); acPick(+el.dataset.i); });
    });
  }
  function acHide() { if(acPopup) acPopup.style.display='none'; acIdx=-1; acTarget=null; }
  function acPick(i) { if(!acTarget||!acItems[i]) return; acTarget.value=acItems[i]; acHide(); var next=acTarget.closest('.as-add-row').querySelector('.as-add-val'); if(next) next.focus(); }
  function acMove(d) { if(!acItems.length) return; acIdx=Math.max(0,Math.min(acItems.length-1,acIdx+d)); acPopup.querySelectorAll('.ac-item').forEach(function(el,i){ el.classList.toggle('active',i===acIdx); }); var act=acPopup.querySelector('.active'); if(act) act.scrollIntoView({block:'nearest'}); }
  document.addEventListener('click', function(e){ if(acPopup && !acPopup.contains(e.target)) acHide(); });

  function getEditorType(prop) {
    if (COLOR_PROPS.indexOf(prop) !== -1) return 'color';
    if (KEYWORD_PROPS[prop]) return 'keyword';
    if (SIZE_PROPS.indexOf(prop) !== -1) return 'size';
    return 'autocomplete';
  }

  function parseSize(val) {
    var m = (val || '').match(/^(-?[\\d.]+)\\s*([a-z%]+)?$/i);
    if (m) return { num: m[1], unit: m[2] || 'px' };
    return { num: '', unit: 'px' };
  }

  function rgbToHex(rgb) {
    var m = rgb.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    if (!m) return rgb.charAt(0) === '#' ? rgb : '#000000';
    return '#' + ((1<<24)+(+m[1]<<16)+(+m[2]<<8)+ +m[3]).toString(16).slice(1);
  }

  function emitStyle(prop, val) {
    vscode.postMessage({ type: 'set_style', selector: currentElementSelector, property: prop, value: val });
  }

  function renderActiveStyles(rules) {
    currentActiveStyles = rules || [];
    var el = $("active-styles");
    if (!el) return;
    if (!currentActiveStyles.length) { el.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:11px">No active styles</div>'; return; }
    var h = '';
    currentActiveStyles.forEach(function(rule, ri) {
      h += '<div class="as-rule">';
      h += '<div class="as-selector">' + esc(rule.selector) + ' {</div>';
      rule.properties.forEach(function(p, pi) {
        var key = ri + '-' + pi;
        var dis = p.enabled ? '' : ' disabled';
        h += '<div class="as-row' + dis + '" data-ri="' + ri + '" data-pi="' + pi + '">';
        h += '<input type="checkbox" class="as-cb" data-key="' + key + '"' + (p.enabled ? ' checked' : '') + ' />';
        h += '<span class="as-prop">' + esc(p.property) + ':</span>';
        h += '<div class="as-val-wrap">' + buildEditor(p, key) + '</div>';
        h += '</div>';
      });
      // Add property row inside rule
      h += '<div class="as-add-row" data-ri="' + ri + '">';
      h += '<input type="text" class="as-add-input as-add-prop" placeholder="property" data-ri="' + ri + '" />';
      h += '<input type="text" class="as-add-input as-add-val" placeholder="value" data-ri="' + ri + '" />';
      h += '</div>';
      h += '<div class="as-selector">}</div>';
      h += '</div>';
    });
    el.innerHTML = h;
    wireActiveStyleEvents(el);
  }

  function buildEditor(p, key) {
    var type = getEditorType(p.property);
    var h = '';
    if (type === 'color') {
      h += '<input type="color" class="as-color-input" data-key="' + key + '" value="' + esc(rgbToHex(p.value)) + '" />';
      h += '<input type="text" class="as-text as-text-color" data-key="' + key + '" value="' + esc(p.value) + '" />';
    } else if (type === 'keyword') {
      var vals = KEYWORD_PROPS[p.property];
      h += '<select class="as-select" data-key="' + key + '">';
      var found = false;
      vals.forEach(function(v) { var sel = v === p.value ? ' selected' : ''; if (v === p.value) found = true; h += '<option value="' + esc(v) + '"' + sel + '>' + esc(v) + '</option>'; });
      if (!found) h += '<option value="' + esc(p.value) + '" selected>' + esc(p.value) + '</option>';
      h += '</select>';
    } else if (type === 'size') {
      h += '<input type="text" class="as-text" data-key="' + key + '" value="' + esc(p.value) + '" />';
    } else {
      h += '<input type="text" class="as-text" data-key="' + key + '" value="' + esc(p.value) + '" />';
    }
    return h;
  }

  function getProp(key) {
    var parts = key.split('-'); var ri = +parts[0], pi = +parts[1];
    var rule = currentActiveStyles[ri]; if (!rule) return null;
    return rule.properties[pi] || null;
  }

  function wireActiveStyleEvents(el) {
    el.querySelectorAll('.as-cb').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var p = getProp(cb.dataset.key); if (!p) return;
        p.enabled = cb.checked;
        cb.closest('.as-row').classList.toggle('disabled', !cb.checked);
        vscode.postMessage({ type: 'toggle_style', selector: currentElementSelector, property: p.property, enabled: cb.checked });
      });
    });
    el.querySelectorAll('.as-select').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var p = getProp(sel.dataset.key); if (!p) return;
        p.value = sel.value; emitStyle(p.property, sel.value);
      });
    });
    el.querySelectorAll('.as-color-input').forEach(function(ci) {
      ci.addEventListener('input', function() {
        var p = getProp(ci.dataset.key); if (!p) return;
        p.value = ci.value; emitStyle(p.property, ci.value);
        var txt = el.querySelector('.as-text-color[data-key="' + ci.dataset.key + '"]');
        if (txt) txt.value = ci.value;
      });
    });
    el.querySelectorAll('.as-text-color').forEach(function(txt) {
      var commit = function() {
        var p = getProp(txt.dataset.key); if (!p) return;
        p.value = txt.value; emitStyle(p.property, txt.value);
        var ci = el.querySelector('.as-color-input[data-key="' + txt.dataset.key + '"]');
        if (ci) { try { ci.value = rgbToHex(txt.value); } catch(e){} }
      };
      txt.addEventListener('change', commit);
      txt.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); txt.blur(); commit(); } });
    });
    el.querySelectorAll('.as-text:not(.as-text-color)').forEach(function(inp) {
      inp.addEventListener('change', function() {
        var p = getProp(inp.dataset.key); if (!p) return;
        p.value = inp.value; emitStyle(p.property, inp.value);
      });
      inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    // Autocomplete for add-property inputs
    el.querySelectorAll('.as-add-prop').forEach(function(inp) {
      inp.addEventListener('input', function(){ acShow(inp); });
      inp.addEventListener('focus', function(){ acShow(inp); });
      inp.addEventListener('blur', function(){ setTimeout(acHide, 150); });
      inp.addEventListener('keydown', function(e) {
        if(acPopup && acPopup.style.display==='block' && acItems.length) {
          if(e.key==='ArrowDown'){ e.preventDefault(); acMove(1); return; }
          if(e.key==='ArrowUp'){ e.preventDefault(); acMove(-1); return; }
          if(e.key==='Enter'||e.key==='Tab'){ if(acIdx>=0){ e.preventDefault(); acPick(acIdx); return; } }
          if(e.key==='Escape'){ acHide(); return; }
        }
      });
    });
    // Add property inside rule
    el.querySelectorAll('.as-add-val').forEach(function(addVal) {
      addVal.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter') return;
        var ri = +addVal.dataset.ri;
        var propInput = el.querySelector('.as-add-prop[data-ri="' + ri + '"]');
        var prop = propInput.value.trim(), val = addVal.value.trim();
        if (!prop || !val) return;
        emitStyle(prop, val);
        var rule = currentActiveStyles[ri];
        if (rule) { rule.properties.push({ property: prop, value: val, enabled: true, editable: true }); }
        renderActiveStyles(currentActiveStyles);
      });
    });
  }

  function buildAIPrompt(prop, newValue, action) {
    var d = currentElementData || {};
    var lines = [];
    lines.push('CSS Edit Request');
    lines.push('');
    lines.push('Element: ' + (d.cssSelectorPath || d.selector || 'unknown'));
    if (d.xpath) lines.push('XPath: ' + d.xpath);
    lines.push('Property: ' + prop.property);
    lines.push('Previous value: ' + prop.value);
    if (action === 'disable') {
      lines.push('Action: Remove or comment out this declaration');
    } else {
      lines.push('New value: ' + newValue);
    }
    lines.push('');
    lines.push('Instructions:');
    lines.push('- Modify only the ' + prop.property + ' declaration');
    lines.push('- Preserve formatting and surrounding declarations');
    lines.push('- Maintain valid CSS');
    lines.push('- Do not change unrelated selectors or properties');
    lines.push('- Respect project conventions');
    return lines.join('\\n');
  }

  function renderHTMLPanel(outerSnippet) {
    if (outerSnippet) {
      var highlighted = highlightHtml(outerSnippet);
      $("html-section").innerHTML =
        '<button class="code-copy" id="copy-html">Copy</button>' +
        '<pre class="code-editor">' + highlighted + '</pre>';
      $("copy-html").onclick = function() {
        navigator.clipboard.writeText(outerSnippet).then(function() {
          $("copy-html").textContent = "Copied";
          setTimeout(function() { $("copy-html").textContent = "Copy"; }, 1500);
        });
      };
    } else {
      $("html-section").innerHTML = '';
    }
  }

  /* ---- DOM Tree ---- */
  function renderTreeSection(children) {
    treeData = {};
    const container = $("dom-tree");
    container.innerHTML = "";
    renderNodes(container, children, 0);
  }

  function renderNodes(container, children, depth) {
    const limit = Math.min(children.length, MAX_CHILDREN);
    for (let i = 0; i < limit; i++) {
      const child = children[i];
      if (!treeData[child.selectorPath]) {
        treeData[child.selectorPath] = { node: child, children: null, expanded: false };
      }
      container.appendChild(createTreeRow(child, depth));
    }
    if (children.length > MAX_CHILDREN) {
      const more = document.createElement("div");
      more.className = "show-more";
      more.style.setProperty("--depth", depth);
      more.textContent = "\\u2026 " + (children.length - MAX_CHILDREN) + " more nodes";
      container.appendChild(more);
    }
  }

  function createTreeRow(child, depth) {
    const row = document.createElement("div");
    row.className = "tree-node";
    row.style.setProperty("--depth", depth);
    row.dataset.selector = child.selectorPath;

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = child.childCount > 0 ? "▸" : " ";
    row.appendChild(toggle);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.innerHTML = nodeLabel(child.tag, child.id, child.classNames,
      child.childCount > 0 ? '<span class="t-count">(' + child.childCount + ')</span>' : '');
    row.appendChild(label);

    label.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (child.childCount === 0) return;
      const entry = treeData[child.selectorPath];
      if (!entry) return;
      if (entry.expanded) {
        collapseNode(row, child.selectorPath);
      } else {
        expandNode(row, child, depth);
      }
    });

    return row;
  }

  function expandNode(row, child, depth) {
    const entry = treeData[child.selectorPath];
    if (!entry) return;
    entry.expanded = true;
    row.querySelector(".tree-toggle").textContent = "▾";

    if (entry.children) {
      const frag = document.createDocumentFragment();
      renderNodes(frag, entry.children, depth + 1);
      row.after(frag);
    } else {
      vscode.postMessage({ type: "request_children", selector: child.selectorPath });
    }
  }

  function collapseNode(row, selectorPath) {
    const entry = treeData[selectorPath];
    if (!entry) return;
    entry.expanded = false;
    row.querySelector(".tree-toggle").textContent = "▸";
    removeChildRows(row);
  }

  function removeChildRows(parentRow) {
    const parentDepth = parseInt(parentRow.style.getPropertyValue("--depth") || "0", 10);
    let next = parentRow.nextElementSibling;
    while (next) {
      const d = parseInt(next.style.getPropertyValue("--depth") || "0", 10);
      if (d <= parentDepth && !next.classList.contains("show-more")) break;
      const toRemove = next;
      next = next.nextElementSibling;
      toRemove.remove();
    }
  }

  function highlightNode(selectorPath) {
    document.querySelectorAll(".tree-node.highlighted").forEach(n => n.classList.remove("highlighted"));
    highlightedSel = selectorPath;
    const row = document.querySelector('.tree-node[data-selector="' + CSS.escape(selectorPath) + '"]');
    if (row) {
      row.classList.add("highlighted");
      row.scrollIntoView({ block: "nearest" });
    }
  }

  function appendDebugLog(message) {
    const logEl = $("debug-log");
    if (logEl) {
      const line = document.createElement("div");
      line.style.borderBottom = "1px solid var(--border)";
      line.style.padding = "2px 0";
      const ts = new Date().toLocaleTimeString("en", {hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"});
      line.textContent = ts + " " + (message || "");
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  /* ---- Full tree rendering (Task 4.1) ---- */
  function renderFullTree(tree) {
    if (!tree) return;
    fullTreeLoaded = true;
    emptyEl.style.display = "none";
    contentEl.style.display = "block";

    // Recursively merge entire tree into treeData
    function mergeNode(node) {
      treeData[node.selectorPath] = { node: node, children: node.children.length > 0 ? node.children : null, expanded: false };
      for (var i = 0; i < node.children.length; i++) {
        mergeNode(node.children[i]);
      }
    }
    treeData = {};
    mergeNode(tree);

    // Clear and render — auto-expand first 2 levels (html + head/body)
    var container = $("dom-tree");
    container.innerHTML = "";

    function renderRecursive(node, depth, autoExpandDepth) {
      var row = createTreeRow(node, depth);
      container.appendChild(row);
      var entry = treeData[node.selectorPath];
      if (node.children.length > 0 && depth < autoExpandDepth) {
        entry.expanded = true;
        row.querySelector(".tree-toggle").textContent = "\\u25be";
        for (var i = 0; i < node.children.length; i++) {
          renderRecursive(node.children[i], depth + 1, autoExpandDepth);
        }
      }
    }
    renderRecursive(tree, 0, 2);
  }

  /* ---- Expand path to node (Task 4.2) ---- */
  let pendingExpandPath = null;
  let pendingExpandResolve = null;

  function expandPathToNode(selectorPath) {
    if (!selectorPath) return;
    // The cssSelectorPath includes 'html > ...' but tree selectorPaths
    // from buildSelectorPath() exclude the html root.
    // Build the list of tree selectorPaths to expand.
    var parts = selectorPath.split(" > ");
    var segments = [];
    // First segment is 'html' — the root node in our tree
    segments.push(parts[0]); // 'html'
    // Remaining segments use buildSelectorPath format (without html prefix)
    for (var i = 1; i < parts.length; i++) {
      segments.push(parts.slice(1, i + 1).join(" > "));
    }
    expandSegments(segments, 0);
  }

  function expandSegments(segments, idx) {
    if (idx >= segments.length) {
      // All ancestors expanded, highlight the target
      highlightNode(segments[segments.length - 1]);
      return;
    }
    const seg = segments[idx];
    const entry = treeData[seg];
    if (!entry) {
      // Node not in treeData yet, highlight what we can
      highlightNode(segments[segments.length - 1]);
      return;
    }
    if (entry.expanded) {
      // Already expanded, move to next
      expandSegments(segments, idx + 1);
      return;
    }
    // Need to expand this node
    const row = document.querySelector('.tree-node[data-selector="' + CSS.escape(seg) + '"]');
    if (!row) {
      expandSegments(segments, idx + 1);
      return;
    }
    if (entry.children) {
      // Children already loaded, just expand
      entry.expanded = true;
      row.querySelector(".tree-toggle").textContent = "\\u25be";
      const depth = parseInt(row.style.getPropertyValue("--depth") || "0", 10);
      const frag = document.createDocumentFragment();
      renderNodes(frag, entry.children, depth + 1);
      row.after(frag);
      expandSegments(segments, idx + 1);
    } else if (entry.node.childCount > 0) {
      // Need to request children, set up pending expand
      pendingExpandPath = { segments: segments, nextIdx: idx + 1, parentSelector: seg };
      entry.expanded = true;
      row.querySelector(".tree-toggle").textContent = "\\u25be";
      vscode.postMessage({ type: "request_children", selector: seg });
    } else {
      expandSegments(segments, idx + 1);
    }
  }

  /* ---- All computed styles rendering (Task 7.2, 7.3) ---- */
  let allComputedStylesData = {};
  let nonDefaultStylesData = {};
  let showAllStyles = false;

  const csCategories = [
    { name: 'Typography', props: ['font-family','font-size','font-weight','font-style','line-height','text-align','text-decoration','text-transform','text-indent','letter-spacing','word-spacing'] },
    { name: 'Box Model', props: ['margin','margin-top','margin-right','margin-bottom','margin-left','padding','padding-top','padding-right','padding-bottom','padding-left','border-width','border-style','border-color','border-radius','width','height','min-width','max-width','box-sizing'] },
    { name: 'Layout & Positioning', props: ['display','visibility','position','top','right','bottom','left','z-index','flex-direction','justify-content','align-items','gap','grid-template-columns','float','clear'] },
    { name: 'Colors & Backgrounds', props: ['color','opacity','background-color','background-image','background-repeat','background-size','background-position'] },
    { name: 'Visual Effects', props: ['box-shadow','text-shadow','filter','backdrop-filter','rotate','scale','translate','skew'] },
    { name: 'Transitions & Animations', props: ['transition-property','transition-duration','transition-timing-function','animation-name','animation-duration','animation-iteration-count'] },
    { name: 'Generated Content & Lists', props: ['list-style-type','list-style-image','list-style-position','content','quotes','counter-reset','counter-increment'] },
    { name: 'Specialized', props: ['cursor','outline','appearance','user-select','table-layout','border-collapse','caption-side','empty-cells','column-count','column-gap','column-rule'] },
  ];
  const csCategoryLookup = {};
  csCategories.forEach(function(cat) { cat.props.forEach(function(p) { csCategoryLookup[p] = cat.name; }); });

  function isColorValueFull(v) {
    return v && (v.startsWith('rgb') || v.startsWith('rgba') || v.startsWith('#') || v.startsWith('hsl'));
  }

  function colorSwatchFull(v) {
    if (!isColorValueFull(v)) return '';
    return '<span class="color-swatch" style="background:' + esc(v) + '"></span>';
  }

  function renderStyleRow(k, v) {
    return '<span class="style-key">' + esc(k) + '</span><span class="style-val">' + colorSwatchFull(v) + esc(v) + '</span>';
  }

  function renderCategorizedStyles(styles, filterText) {
    if (!styles) return '';
    var filter = (filterText || '').toLowerCase();
    // Filter out vendor-prefixed and build per-category buckets
    var buckets = {};
    csCategories.forEach(function(cat) { buckets[cat.name] = []; });
    var uncategorized = [];
    var keys = Object.keys(styles).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.charAt(0) === '-') continue;
      var v = styles[k];
      if (filter && !k.toLowerCase().includes(filter) && !v.toLowerCase().includes(filter)) continue;
      var cat = csCategoryLookup[k];
      if (cat) { buckets[cat].push(k); } else { uncategorized.push(k); }
    }
    var html = '';
    csCategories.forEach(function(cat) {
      var items = buckets[cat.name];
      if (!items.length) return;
      var open = filter ? ' open' : '';
      html += '<div class="cs-accordion' + open + '">';
      html += '<div class="cs-accordion-header" onclick="this.parentElement.classList.toggle(&#39;open&#39;)"><span class="cs-accordion-arrow">&#9654;</span>' + esc(cat.name) + ' <span class="cs-accordion-count">(' + items.length + ')</span></div>';
      html += '<div class="cs-accordion-body"><div class="all-styles-grid">';
      for (var j = 0; j < items.length; j++) { html += renderStyleRow(items[j], styles[items[j]]); }
      html += '</div></div></div>';
    });
    if (uncategorized.length) {
      var open = filter ? ' open' : '';
      html += '<div class="cs-accordion' + open + '">';
      html += '<div class="cs-accordion-header" onclick="this.parentElement.classList.toggle(&#39;open&#39;)"><span class="cs-accordion-arrow">&#9654;</span>Other <span class="cs-accordion-count">(' + uncategorized.length + ')</span></div>';
      html += '<div class="cs-accordion-body"><div class="all-styles-grid">';
      for (var j = 0; j < uncategorized.length; j++) { html += renderStyleRow(uncategorized[j], styles[uncategorized[j]]); }
      html += '</div></div></div>';
    }
    return html;
  }

  function renderComputedTab(boxModel, allStyles) {
    // Box model in computed tab
    const bmEl = $("computed-box-model");
    if (bmEl) {
      if (boxModel) {
        const c = boxModel.content, p = boxModel.padding, b = boxModel.border, m = boxModel.margin;
        const w = Math.round(c.width), h = Math.round(c.height);
        bmEl.innerHTML =
          '<div class="box-model"><div class="box-model-diagram">' +
            '<div class="bm-layer bm-margin"><span class="bm-label">margin</span>' +
              '<div class="bm-vals"><span>' + m.left + '</span><span>' + m.right + '</span></div>' +
              '<div class="bm-h"><span class="bm-vals-v"><span>' + m.top + '</span></span>' +
              '<div class="bm-layer bm-border"><span class="bm-label">border</span>' +
                '<div class="bm-vals"><span>' + b.left + '</span><span>' + b.right + '</span></div>' +
                '<div class="bm-h"><span class="bm-vals-v"><span>' + b.top + '</span></span>' +
                '<div class="bm-layer bm-padding"><span class="bm-label">padding</span>' +
                  '<div class="bm-vals"><span>' + p.left + '</span><span>' + p.right + '</span></div>' +
                  '<div class="bm-h"><span class="bm-vals-v"><span>' + p.top + '</span></span>' +
                  '<div class="bm-layer bm-content">' +
                    '<span class="bm-content-size">' + w + ' \\u00d7 ' + h + '</span>' +
                  '</div>' +
                  '<span class="bm-vals-v"><span>' + p.bottom + '</span></span></div>' +
                '</div>' +
                '<span class="bm-vals-v"><span>' + b.bottom + '</span></span></div>' +
              '</div>' +
              '<span class="bm-vals-v"><span>' + m.bottom + '</span></span></div>' +
            '</div>' +
          '</div></div>';
      } else {
        bmEl.innerHTML = '';
      }
    }
    // All computed styles with filter
    var stylesObj = allStyles || {};
    allComputedStylesData = stylesObj.all || stylesObj;
    nonDefaultStylesData = stylesObj.nonDefault || allComputedStylesData;
    const csEl = $("computed-styles");
    if (csEl) {
      renderComputedStylesList(csEl);
    }
  }

  function activeStylesData() { return showAllStyles ? allComputedStylesData : nonDefaultStylesData; }

  function renderComputedStylesList(csEl) {
    let html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
    html += '<input type="text" class="computed-filter-input" id="computed-filter" placeholder="Filter styles\u2026" style="flex:1" />';
    html += '<label style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--text-muted);white-space:nowrap;cursor:pointer"><input type="checkbox" id="show-all-styles"' + (showAllStyles ? ' checked' : '') + ' /> Show all</label>';
    html += '</div>';
    html += '<div id="all-styles-list">' + renderCategorizedStyles(activeStylesData(), '') + '</div>';
    csEl.innerHTML = html;
    const filterInput = $("computed-filter");
    const showAllCb = $("show-all-styles");
    if (filterInput) {
      filterInput.addEventListener("input", function() {
        const listEl = $("all-styles-list");
        if (listEl) listEl.innerHTML = renderCategorizedStyles(activeStylesData(), filterInput.value);
      });
    }
    if (showAllCb) {
      showAllCb.addEventListener("change", function() {
        showAllStyles = showAllCb.checked;
        const listEl = $("all-styles-list");
        const fi = $("computed-filter");
        if (listEl) listEl.innerHTML = renderCategorizedStyles(activeStylesData(), fi ? fi.value : '');
      });
    }
  }

  /* ---- Incoming messages from extension host ---- */
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "update_element":
        currentElementData = msg.data;
        currentElementSelector = msg.data.cssSelectorPath || msg.data.selector || '';
        renderElementPanel(msg.data);
        renderComponentPanel(msg.data.componentInfo);
        renderHTMLPanel(msg.data.outerSnippet);
        renderActiveStyles(msg.data.activeStyles);
        renderComputedTab(msg.data.boxModel, msg.data.allComputedStyles);
        // Auto-expand tree to picked element (Task 4.3)
        if (msg.data.cssSelectorPath) {
          expandPathToNode(msg.data.cssSelectorPath);
        } else if (msg.data.selector) {
          highlightNode(msg.data.selector);
        }
        break;

      case "update_full_tree":
        renderFullTree(msg.tree);
        break;

      case "update_dom_tree":
        // Only use update_dom_tree if we don't have a full tree yet
        if (!fullTreeLoaded) {
          renderTreeSection(msg.children || []);
        }
        break;

      case "expand_to_node": {
        expandPathToNode(msg.selector);
        break;
      }

      case "update_hover_preview": {
        const d = msg.data;
        if (!d) break;
        emptyEl.style.display = "none";
        contentEl.style.display = "block";
        let hh = '<span class="el-tag">&lt;' + esc(d.tag) + '&gt;</span>';
        if (d.id) hh += ' <span class="el-id">#' + esc(d.id) + '</span>';
        if (d.classNames && d.classNames.length) {
          hh += ' ' + d.classNames.map(c => '<span class="el-class">.' + esc(c) + '</span>').join(" ");
        }
        hh += '<div class="dims">';
        hh += '<span class="dim-label">W</span> <span class="dim-val">' + Math.round(d.width) + 'px</span>';
        hh += '<span class="dim-label">H</span> <span class="dim-val">' + Math.round(d.height) + 'px</span>';
        hh += '</div>';
        $("el-summary").innerHTML = hh;
        break;
      }

      case "children_loaded": {
        const sel = msg.selector;
        const children = msg.children || [];
        const entry = treeData[sel];
        if (entry) entry.children = children;
        // Register children in treeData
        for (const child of children) {
          if (!treeData[child.selectorPath]) {
            treeData[child.selectorPath] = { node: child, children: null, expanded: false };
          }
        }
        const parentRow = document.querySelector('.tree-node[data-selector="' + CSS.escape(sel) + '"]');
        if (parentRow) {
          const parentDepth = parseInt(parentRow.style.getPropertyValue("--depth") || "0", 10);
          const frag = document.createDocumentFragment();
          renderNodes(frag, children, parentDepth + 1);
          parentRow.after(frag);
        }
        // Continue pending expand path if applicable (Task 4.2)
        if (pendingExpandPath && pendingExpandPath.parentSelector === sel) {
          const pending = pendingExpandPath;
          pendingExpandPath = null;
          expandSegments(pending.segments, pending.nextIdx);
        }
        break;
      }

      case "debug_log": {
        appendDebugLog(msg.message);
        break;
      }

      case "browser_state": {
        if (msg.open) {
          emptyEl.style.display = "none";
        } else {
          emptyEl.style.display = "";
          contentEl.style.display = "none";
        }
        break;
      }

      case "url_history": {
        urlHistory = msg.history || [];
        break;
      }
    }
  });
})();
</script>
</body>
</html>`;
  }
}
