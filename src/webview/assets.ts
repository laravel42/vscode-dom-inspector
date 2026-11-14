import * as fs from "fs";
import * as path from "path";

/**
 * Browser-side code, kept as plain files next to this module:
 *
 *   inspector.js   injected into every proxied HTML page (overlay, picker,
 *                  extractor, framework detection, context menu, page channel)
 *   sidebar.html   the sidebar webview document, with {{style}} and {{script}}
 *   sidebar.css    its styles
 *   sidebar.js     its script
 *
 * They live in src/webview and are copied to out/webview by `pnpm compile`,
 * so this module finds them beside itself both from source (tests) and once
 * compiled.
 */
export type WebviewAsset = "inspector.js" | "sidebar.html" | "sidebar.css" | "sidebar.js";

const cache = new Map<WebviewAsset, string>();

export function webviewAsset(name: WebviewAsset): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = fs.readFileSync(path.join(__dirname, name), "utf8");
    cache.set(name, text);
  }
  return text;
}

/** Replace `{{key}}` placeholders. Plain split/join: values may contain `$`. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`{{${key}}}`).join(value);
  return out;
}
