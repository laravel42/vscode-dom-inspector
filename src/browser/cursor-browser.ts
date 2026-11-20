import * as vscode from "vscode";

/**
 * Pages already open in Cursor's own browser tab, inspected in place: no URL
 * to type and no proxy in front of the page.
 *
 * Cursor exposes its browser through workbench commands (the ones its agent
 * tools use). They are internal and undocumented, so everything here checks
 * that they exist and fails with a clear message otherwise.
 *
 *   cursor.browserView.listTabs()                         → { tabs, activeTab, lastInteractedTab }
 *   cursor.browserView.getURL(viewId?)                    → string
 *   cursor.browserView.executeJavaScript(code, viewId?)   → result
 *   cursor.browserView.sendCDPCommand(method, params, viewId?)
 *
 * Tabs opened by Cursor's agent belong to it and aren't listed; tabs the user
 * opened are.
 */

const CMD = {
  listTabs: "cursor.browserView.listTabs",
  getURL: "cursor.browserView.getURL",
  executeJavaScript: "cursor.browserView.executeJavaScript",
  sendCDPCommand: "cursor.browserView.sendCDPCommand",
} as const;

export interface CursorTab {
  viewId: string;
  url: string;
}

interface TabList {
  tabs?: string[];
  activeTab?: string;
  lastInteractedTab?: string;
}

/** Whether this editor has Cursor's browser API (all the commands we use). */
export async function cursorBrowserAvailable(): Promise<boolean> {
  const commands = new Set(await vscode.commands.getCommands(true));
  return Object.values(CMD).every((c) => commands.has(c));
}

/**
 * The page the user is looking at in Cursor's browser: the active tab, else the
 * last one used, else any. Undefined when no tab is open.
 */
export async function currentCursorTab(): Promise<CursorTab | undefined> {
  const list = (await vscode.commands.executeCommand<TabList>(CMD.listTabs, {})) ?? {};
  const tabs = Array.isArray(list.tabs) ? list.tabs : [];
  const viewId = pickTab(list, tabs);
  if (!viewId) return undefined;
  const url = await vscode.commands.executeCommand<string>(CMD.getURL, viewId);
  return typeof url === "string" && url ? { viewId, url } : undefined;
}

/** Preference order: the visible tab, then the last one used, then any. */
export function pickTab(list: TabList, tabs: string[] = list.tabs ?? []): string | undefined {
  if (list.activeTab && tabs.includes(list.activeTab)) return list.activeTab;
  if (list.lastInteractedTab && tabs.includes(list.lastInteractedTab)) return list.lastInteractedTab;
  return tabs[0];
}

/** Whether the URL is a web page we can inspect (not about:, data:, chrome:…). */
export function isInspectableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export interface Injection {
  viewId: string;
  /** CDP id of the on-new-document script, to remove it on detach. */
  scriptId?: string;
}

/**
 * Inject the inspector into a Cursor browser tab, now and on every page it
 * loads later (reloads, navigation), via CDP Page.addScriptToEvaluateOnNewDocument.
 * `token` is the session token baked into `script`: a page still running an
 * older session's inspector is reloaded so the new one replaces it cleanly.
 */
export async function injectIntoCursorTab(viewId: string, script: string, token: string): Promise<Injection> {
  const cdp = (method: string, params: object = {}) =>
    vscode.commands.executeCommand<{ identifier?: string }>(CMD.sendCDPCommand, method, params, viewId);
  const js = <T>(code: string) => vscode.commands.executeCommand<T>(CMD.executeJavaScript, code, viewId);

  await cdp("Page.enable");
  const added = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: script });

  const running = await js<string | null>("(function(){ return window.__domInspectorToken || null; })()");
  if (running && running !== token) {
    // An inspector from an earlier session is still in the page; reload so only
    // the new one (registered above for new documents) runs.
    await js("location.reload(); void 0");
  } else if (!running) {
    await js(script + "\n;void 0");
  }
  return { viewId, scriptId: added?.identifier };
}

/** Stop injecting into future page loads of the tab (best effort). */
export async function detachFromCursorTab(injection: Injection): Promise<void> {
  if (!injection.scriptId) return;
  try {
    await vscode.commands.executeCommand(CMD.sendCDPCommand, "Page.removeScriptToEvaluateOnNewDocument",
      { identifier: injection.scriptId }, injection.viewId);
  } catch { /* the tab may be gone */ }
}
