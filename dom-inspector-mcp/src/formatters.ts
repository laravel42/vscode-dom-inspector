import { StoredSelection } from "./types.js";

const OUTER_HTML_DISPLAY_LIMIT = 1500;

/**
 * Format the stored selection as a concise markdown document
 * suitable for AI model consumption.
 */
export function formatSelectionAsMarkdown(sel: StoredSelection): string {
  const n = sel.node;
  const lines: string[] = [];

  lines.push("## Selected DOM Node");
  lines.push("");

  // Identity
  lines.push(`- **Page:** ${n.url}`);
  if (n.title) lines.push(`- **Title:** ${n.title}`);
  lines.push(`- **Tag:** \`<${n.tagName}>\``);
  if (n.id) lines.push(`- **ID:** \`${n.id}\``);
  if (n.classes.length > 0) lines.push(`- **Classes:** \`${n.classes.join(" ")}\``);

  // Content
  if (n.text) lines.push(`- **Text:** "${n.text}"`);

  // Accessibility
  if (n.role) lines.push(`- **Role:** ${n.role}`);
  if (n.ariaLabel) lines.push(`- **aria-label:** ${n.ariaLabel}`);

  // Selectors
  if (n.selector) lines.push(`- **Selector:** \`${n.selector}\``);
  if (n.xpath) lines.push(`- **XPath:** \`${n.xpath}\``);

  // Nearby context
  if (n.nearbyContext) {
    lines.push(`- **Nearby context:** ${n.nearbyContext}`);
  }

  // Attributes
  const attrEntries = Object.entries(n.attributes);
  if (attrEntries.length > 0) {
    lines.push("");
    lines.push("### Attributes");
    lines.push("");
    for (const [key, value] of attrEntries) {
      lines.push(`- \`${key}\`: \`${value}\``);
    }
  }

  // outerHTML
  if (n.outerHTML) {
    const truncated = n.outerHTML.slice(0, OUTER_HTML_DISPLAY_LIMIT);
    const suffix = n.outerHTML.length > OUTER_HTML_DISPLAY_LIMIT ? "\n<!-- truncated -->" : "";
    lines.push("");
    lines.push("### HTML");
    lines.push("");
    lines.push("```html");
    lines.push(truncated + suffix);
    lines.push("```");
  }

  // Timestamp
  lines.push("");
  lines.push(`_Selected at ${sel.selectedAt}_`);

  return lines.join("\n");
}

/**
 * Markdown message when no node is selected.
 */
export function formatNoSelection(): string {
  return [
    "## No DOM Node Selected",
    "",
    "No element is currently selected in the DOM Inspector.",
    "",
    "To select an element:",
    "1. Open the DOM Inspector browser panel",
    "2. Click the inspect button (🔍)",
    "3. Click an element on the page",
    "",
    "The selected element will then be available here.",
  ].join("\n");
}

/**
 * Build the analysis prompt that wraps the selected node context.
 */
export function formatAnalysisPrompt(sel: StoredSelection): string {
  const context = formatSelectionAsMarkdown(sel);

  return [
    "Analyze the following DOM element that was selected in a browser inspector.",
    "",
    context,
    "",
    "Please provide:",
    "",
    "1. **Purpose:** What does this element likely do in the UI?",
    "2. **Accessibility:** Are there any accessibility concerns? (missing ARIA attributes, contrast, keyboard navigation, semantic HTML)",
    "3. **Playwright locator:** Suggest a stable Playwright locator strategy for this element, preferring role-based or test-id selectors.",
    "4. **Cypress locator:** Suggest a stable Cypress selector strategy.",
    "5. **Fragile patterns:** Identify any fragile selector patterns (deeply nested positional selectors, auto-generated class names, etc.)",
    "6. **Improvements:** Suggest improvements to the markup or attributes that would improve testability and accessibility.",
  ].join("\n");
}

/**
 * Analysis prompt when no node is selected.
 */
export function formatNoSelectionPrompt(): string {
  return [
    "No DOM element is currently selected.",
    "",
    "To analyze an element:",
    "1. Open the DOM Inspector browser panel",
    "2. Click the inspect button (🔍)",
    "3. Click an element on the page",
    "4. Then try again",
  ].join("\n");
}

/**
 * Build the apply-styles prompt from recorded style changes.
 */
export function formatApplyStylesPrompt(sel: StoredSelection): string {
  const context = formatSelectionAsMarkdown(sel);
  const changes = sel.styleChanges;

  if (changes.length === 0) {
    return [
      "No style changes have been made to the selected element.",
      "",
      context,
      "",
      "Use the DOM Inspector Styles panel to modify CSS properties on the element,",
      "then use [DOM] Apply styles to generate the source code changes.",
    ].join("\n");
  }

  const changeList = changes
    .map((c) => `- \`${c.property}\`: \`${c.oldValue || "(none)"}\` → \`${c.newValue}\``)
    .join("\n");

  return [
    "Apply the following CSS style changes to the source code for this element.",
    "",
    context,
    "",
    "### Style Changes",
    "",
    changeList,
    "",
    "Instructions:",
    "- Find the source file and the CSS/Tailwind classes or inline styles for this element.",
    "- Apply each style change to the source code.",
    "- If the project uses Tailwind, convert CSS properties to the appropriate Tailwind utility classes.",
    "- If the project uses CSS modules or styled-components, update the relevant style definition.",
    "- Preserve existing formatting and conventions.",
    "- Only modify the styles listed above.",
  ].join("\n");
}

/**
 * Build the remove-node prompt.
 */
export function formatRemoveNodePrompt(sel: StoredSelection): string {
  const context = formatSelectionAsMarkdown(sel);

  return [
    "Remove the following DOM element from the source code.",
    "",
    context,
    "",
    "Instructions:",
    "- Find the source file containing this element.",
    "- Remove the element and its children from the JSX/HTML.",
    "- Clean up any unused imports, variables, or styles that were only used by this element.",
    "- Preserve surrounding structure and formatting.",
    "- If removing this element would break layout, note what adjustments may be needed.",
  ].join("\n");
}
