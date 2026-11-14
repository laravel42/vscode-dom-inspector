import type express from "express";
import { getCurrentSelection } from "./state.js";
import type { StoredSelection } from "./types.js";

/**
 * Several AI clients can each start their own copy of this server (Claude Code,
 * Cursor, Kiro, Cline…). Only one can own the HTTP port the editor extension
 * posts to. The first instance becomes the *leader* and holds the selection;
 * later instances become *followers* and read it from the leader over HTTP.
 * If the leader exits, the next follower that needs the selection takes over
 * the port. Nothing is ever killed.
 */

export const BRIDGE_NAME = "dom-inspector-bridge";

type Mode = "leader" | "follower" | "unavailable";
let mode: Mode = "unavailable";
let port = 3100;
let app: express.Express | null = null;

function tryListen(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!app) { resolve(false); return; }
    const server = app.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(true));
    server.once("error", () => resolve(false));
  });
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Is the program on our port another DOM Inspector bridge (any version)? */
async function isDomInspectorBridge(): Promise<boolean> {
  try {
    const health = await getJson("/health");
    if (health?.name === BRIDGE_NAME) return true;
  } catch { /* older bridges have no /health */ }
  try {
    const sel = await getJson("/selection");
    return sel?.ok === true && "selection" in sel;
  } catch {
    return false;
  }
}

export async function startBridge(expressApp: express.Express, httpPort: number): Promise<Mode> {
  app = expressApp;
  port = httpPort;
  if (await tryListen()) {
    mode = "leader";
    console.error(`[http] DOM Inspector bridge listening on http://127.0.0.1:${port}`);
  } else if (await isDomInspectorBridge()) {
    mode = "follower";
    console.error(`[http] Another DOM Inspector bridge owns port ${port}; reading the selection from it`);
  } else {
    mode = "unavailable";
    console.error(`[http] Port ${port} is used by another program. Set DOM_INSPECTOR_PORT (and the extension's domInspector.mcp.port) to a free port.`);
  }
  return mode;
}

export function bridgeMode(): Mode {
  return mode;
}

/** The current selection, wherever it lives. */
export async function readSelection(): Promise<StoredSelection | null> {
  if (mode !== "follower") return getCurrentSelection();
  try {
    const json = await getJson("/selection");
    return (json?.selection ?? null) as StoredSelection | null;
  } catch {
    // The leader went away: take over the port. State starts empty until the next pick.
    if (await tryListen()) {
      mode = "leader";
      console.error(`[http] Previous bridge is gone; now listening on http://127.0.0.1:${port}`);
    }
    return getCurrentSelection();
  }
}
