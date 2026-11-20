import * as fs from "fs";
import * as path from "path";
import { ActiveStyleRule, ElementData } from "../types";

/**
 * Provider-neutral element context: a Markdown snapshot of a picked element
 * (identity, DOM path, attributes, matched CSS, computed styles, HTML, and an
 * optional task). DOM Inspector doesn't read the project's source: finding the
 * code is left to the AI assistant. Snapshots are written to disk so any AI tool can read
 * them: via an @-mention, an attached file, MCP, or the clipboard
 * (see ai-targets.ts).
 */

/** Folder (inside the workspace) that holds element snapshots. */
export const SNAPSHOT_DIR = ".dom-inspector";
const MAX_SNAPSHOTS = 20;
const MAX_RULES = 30;
const MAX_COMPUTED = 60;
const MAX_HTML = 2000;

export interface ElementMarkdownOptions {
  pageUrl: string;
  pickedAt: string;      // ISO 8601
  /** What the AI should do with the element (Markdown). Omitted for plain "send". */
  task?: string;
}

/** Fenced code block whose fence is longer than any backtick run in the body. */
export function fence(lang: string, body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body.replace(/\n+$/, "")}\n${ticks}`;
}

/** `tag#id.class1.class2` */
export function elementLabel(el: Pick<ElementData, "tag" | "id" | "classNames">): string {
  let label = el.tag || "element";
  if (el.id) label += `#${el.id}`;
  for (const c of el.classNames || []) label += `.${c}`;
  return label;
}

function nonDefaultComputed(el: ElementData): Record<string, string> {
  const s = el.allComputedStyles as Record<string, unknown> | undefined;
  if (!s) return {};
  if (s.nonDefault && typeof s.nonDefault === "object") return s.nonDefault as Record<string, string>;
  if (s.all && typeof s.all === "object") return {};
  return s as Record<string, string>;
}

function rulesToCss(rules: ActiveStyleRule[]): string {
  return rules
    .slice(0, MAX_RULES)
    .map((r) => {
      const props = r.properties
        .map((p) => (p.enabled ? `  ${p.property}: ${p.value};` : `  /* ${p.property}: ${p.value}; (disabled) */`))
        .join("\n");
      return `${r.selector} {\n${props}\n}`;
    })
    .join("\n\n");
}

/** Build the Markdown snapshot an AI assistant receives. Pure: no I/O. */
export function buildElementMarkdown(el: ElementData, opts: ElementMarkdownOptions): string {
  const out: string[] = [];
  const label = elementLabel(el);

  out.push(`# DOM element \`<${label}>\``);
  out.push("");
  out.push(`Picked with DOM Inspector on ${opts.pageUrl} at ${opts.pickedAt}.`);
  out.push("This is a snapshot of the live element in the running app. To change it, find the code that renders it using the component, selectors, classes and text below.");

  if (opts.task && opts.task.trim()) {
    out.push("", "## Task", "", opts.task.trim());
  }

  // Identity
  out.push("", "## Element", "");
  out.push(`- **Tag:** \`<${el.tag}>\``);
  if (el.id) out.push(`- **ID:** \`${el.id}\``);
  if (el.classNames?.length) out.push(`- **Classes:** \`${el.classNames.join(" ")}\``);
  if (el.cssSelectorPath) out.push(`- **CSS path:** \`${el.cssSelectorPath}\``);
  else if (el.selector) out.push(`- **Selector:** \`${el.selector}\``);
  if (el.xpath) out.push(`- **XPath:** \`${el.xpath}\``);
  const ci = el.componentInfo;
  if (ci?.componentPath?.length) {
    out.push(`- **Component:** ${ci.componentPath.join(" > ")}${ci.framework ? ` (${ci.framework})` : ""}`);
  }
  const text = (el.text || "").replace(/\s+/g, " ").trim();
  if (text) out.push(`- **Text:** "${text.slice(0, 200)}"`);
  const c = el.boxModel?.content;
  if (c) out.push(`- **Size:** ${Math.round(c.width)} × ${Math.round(c.height)} px`);

  const attrs = Object.entries(el.attrs || {}).filter(([k]) => k !== "class" && k !== "id");
  if (attrs.length) {
    out.push("", "## Attributes", "");
    for (const [k, v] of attrs) out.push(`- \`${k}\`: \`${String(v).slice(0, 200)}\``);
  }

  // Styles
  const rules = el.activeStyles || [];
  if (rules.length) {
    out.push("", "## Matched CSS rules", "");
    out.push("In stylesheet order, with inline `element.style` first; no cascade/specificity resolution.", "");
    out.push(fence("css", rulesToCss(rules)));
    if (rules.length > MAX_RULES) out.push("", `_…and ${rules.length - MAX_RULES} more rules._`);
  }

  const computed = Object.entries(nonDefaultComputed(el)).filter(([k]) => !k.startsWith("-"));
  if (computed.length) {
    out.push("", "## Computed styles (values that differ from a plain element of the same tag)", "");
    out.push(fence("css", computed.slice(0, MAX_COMPUTED).map(([k, v]) => `${k}: ${v};`).join("\n")));
    if (computed.length > MAX_COMPUTED) out.push("", `_…and ${computed.length - MAX_COMPUTED} more._`);
  }

  // HTML
  if (el.outerSnippet) {
    const html = el.outerSnippet.slice(0, MAX_HTML);
    out.push("", "## HTML", "", fence("html", html + (el.outerSnippet.length > MAX_HTML ? "\n<!-- truncated -->" : "")));
  }

  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Snapshot files
// ---------------------------------------------------------------------------

function timestampForFile(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** File name safe for @-mentions in AI chat inputs (no `#`, `"` or spaces). */
export function snapshotFileName(tag: string, d: Date): string {
  const safeTag = (tag || "element").toLowerCase().replace(/[^a-z0-9-]/g, "") || "element";
  return `element-${timestampForFile(d)}-${safeTag}.md`;
}

/** Write a snapshot; keeps the newest MAX_SNAPSHOTS. Returns the file path. */
export function writeSnapshot(dir: string, fileName: string, markdown: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "# Created by DOM Inspector: element snapshots for AI assistants.\n*\n");
  }
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, markdown);

  try {
    const old = fs.readdirSync(dir).filter((f) => /^element-.*\.md$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - MAX_SNAPSHOTS))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    // pruning is best-effort
  }
  return file;
}
