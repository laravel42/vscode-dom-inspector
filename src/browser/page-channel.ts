import type * as http from "http";
import { randomBytes } from "crypto";

/**
 * Page channel over HTTP, for browsers we don't own (VS Code's integrated
 * browser, Cursor's browser tab, Simple Browser, the system browser). The
 * proxy routes these requests here.
 *
 * The injected inspector talks to the extension on its own origin:
 *   GET  /__dom-inspector__/events?t=<token>&c=<client>   Server-Sent Events, extension → page
 *   POST /__dom-inspector__/message?t=<token>&c=<client>  JSON body, page → extension
 * The token is generated per proxy session and written into the injected
 * script, so other local pages can't drive or impersonate the inspector.
 */

export const CHANNEL_PREFIX = "/__dom-inspector__/";
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
let sessionToken = randomBytes(16).toString("hex");

type PageMessageListener = (msg: { type: string; [k: string]: unknown }, clientId: string) => void;
const sseClients = new Map<string, http.ServerResponse>();
const messageListeners: PageMessageListener[] = [];
const clientListeners: Array<(clients: string[]) => void> = [];
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

export function onPageMessage(listener: PageMessageListener): () => void {
  messageListeners.push(listener);
  return () => { const i = messageListeners.indexOf(listener); if (i >= 0) messageListeners.splice(i, 1); };
}

export function onPageClientsChanged(listener: (clients: string[]) => void): () => void {
  clientListeners.push(listener);
  return () => { const i = clientListeners.indexOf(listener); if (i >= 0) clientListeners.splice(i, 1); };
}

export function pageClients(): string[] {
  return [...sseClients.keys()];
}

/** Send a message to one connected page (or all of them). Returns how many received it. */
export function sendToPageClients(msg: unknown, clientId?: string): number {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  let n = 0;
  for (const [id, res] of sseClients) {
    if (clientId && id !== clientId) continue;
    try { res.write(data); n++; } catch { /* closed */ }
  }
  return n;
}

/** This session's token, written into the injected script. */
export function channelToken(): string {
  return sessionToken;
}

function notifyClients(): void {
  const ids = pageClients();
  for (const l of [...clientListeners]) { try { l(ids); } catch { /* ignore */ } }
}

/** Handle /__dom-inspector__/* requests. Returns true when handled. */
export function handleChannelRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!req.url || !req.url.startsWith(CHANNEL_PREFIX)) return false;
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname.slice(CHANNEL_PREFIX.length);
  const clientId = (url.searchParams.get("c") || "").slice(0, 64);
  if (url.searchParams.get("t") !== sessionToken || !/^[\w-]+$/.test(clientId)) {
    res.writeHead(403); res.end(); return true;
  }

  if (route === "events" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 1000\n\n");
    sseClients.get(clientId)?.end();
    sseClients.set(clientId, res);
    if (!keepAliveTimer) {
      keepAliveTimer = setInterval(() => { for (const r of sseClients.values()) { try { r.write(": keep-alive\n\n"); } catch { /* ignore */ } } }, 15000);
    }
    req.on("close", () => {
      if (sseClients.get(clientId) === res) { sseClients.delete(clientId); notifyClients(); }
    });
    notifyClients();
    return true;
  }

  if (route === "message" && req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_MESSAGE_BYTES) { res.writeHead(413); res.end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let msg: { type?: unknown } | null = null;
      try { msg = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { /* invalid */ }
      if (!msg || typeof msg.type !== "string") { res.writeHead(400); res.end(); return; }
      res.writeHead(204); res.end();
      for (const l of [...messageListeners]) { try { l(msg as { type: string }, clientId); } catch { /* ignore */ } }
    });
    return true;
  }

  res.writeHead(404); res.end();
  return true;
}

/** End every page connection and rotate the token (on proxy stop). */
export function resetPageChannel(): void {
  for (const res of sseClients.values()) { try { res.end(); } catch { /* ignore */ } }
  sseClients.clear();
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = undefined; }
  sessionToken = randomBytes(16).toString("hex");
  notifyClients();
}
