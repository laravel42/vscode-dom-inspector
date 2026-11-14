import * as vscode from "vscode";
import { BridgeMessage } from "../types";

/**
 * BridgeChannel — typed message relay between the webview panel and the
 * extension host. Forwards BridgeMessage objects bidirectionally and
 * monitors inspector liveness via a heartbeat mechanism.
 */
export class BridgeChannel {
  private readonly panel: vscode.WebviewPanel;
  private readonly messageCallbacks: Array<(msg: BridgeMessage) => void> = [];
  private readonly connectionLostCallbacks: Array<() => void> = [];
  private readonly connectionRestoredCallbacks: Array<() => void> = [];

  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;
  private disposed = false;

  private static readonly HEARTBEAT_TIMEOUT_MS = 5_000;

  private readonly disposable: vscode.Disposable;

  constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;

    this.disposable = panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (this.disposed) return;
      const msg = raw as BridgeMessage;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;

      if (msg.type === "inspector_ready") {
        this.handleInspectorReady();
      }

      for (const cb of this.messageCallbacks) {
        cb(msg);
      }
    });

    panel.onDidDispose(() => {
      this.dispose();
    });
  }

  /** Send a typed message to the webview (and ultimately the page). */
  sendToPage(msg: BridgeMessage): void {
    if (this.disposed) return;
    this.panel.webview.postMessage(msg);
  }

  /** Register a callback for every incoming BridgeMessage. */
  onMessage(callback: (msg: BridgeMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  /** Register a callback fired when the inspector connection is lost. */
  onConnectionLost(callback: () => void): void {
    this.connectionLostCallbacks.push(callback);
  }

  /** Register a callback fired when the inspector connection is restored. */
  onConnectionRestored(callback: () => void): void {
    this.connectionRestoredCallbacks.push(callback);
  }

  /** Whether the inspector is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Clean up timers and listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHeartbeatTimer();
    this.disposable.dispose();
  }

  // ── Heartbeat internals ──────────────────────────────────────────────

  private handleInspectorReady(): void {
    const wasDisconnected = !this.connected;
    this.connected = true;
    this.resetHeartbeatTimer();

    if (wasDisconnected && this.connectionRestoredCallbacks.length > 0) {
      for (const cb of this.connectionRestoredCallbacks) {
        cb();
      }
    }
  }

  private resetHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      this.onHeartbeatTimeout();
    }, BridgeChannel.HEARTBEAT_TIMEOUT_MS);
  }

  private onHeartbeatTimeout(): void {
    if (this.disposed || !this.connected) return;
    this.connected = false;
    for (const cb of this.connectionLostCallbacks) {
      cb();
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

/**
 * HTML of DOM Inspector's own browser panel: a toolbar (reload, URL, inspect)
 * over an iframe showing the proxied page, plus the relay that forwards
 * BridgeMessages between the page and the extension host.
 */
export function panelHtml(proxyUrl: string, originalUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #0d1117; }
    body { display: flex; flex-direction: column; height: 100vh; }
    .toolbar {
      display: flex; align-items: center; gap: 4px; padding: 6px 8px;
      background: #161b22; border-bottom: 1px solid #30363d; flex-shrink: 0;
    }
    .toolbar input {
      flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 4px;
      color: #e6edf3; padding: 6px 10px; font: 13px/1 system-ui; outline: none;
      min-width: 0;
    }
    .toolbar input:focus { border-color: #58a6ff; }
    .tb {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      background: #21262d; border: 1px solid #30363d; border-radius: 6px;
      color: #e6edf3; cursor: pointer; font-size: 16px;
      flex-shrink: 0; transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .tb:hover { background: #30363d; }
    .tb.inspecting {
      background: #0d4429; border-color: #3fb950; color: #3fb950;
      animation: pulse 1.5s infinite;
    }
    .tb svg { width: 18px; height: 18px; fill: currentColor; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
    iframe { flex: 1; width: 100%; border: none; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="tb" id="reload" title="Reload page">
      <svg viewBox="0 0 16 16"><path d="M13.5 2a.5.5 0 0 0-.5.5V5H10a.5.5 0 0 0 0 1h3.5a.5.5 0 0 0 .5-.5V2.5a.5.5 0 0 0-.5-.5zM8 3a5 5 0 0 0-4.55 2.93.5.5 0 1 0 .91.42A4 4 0 1 1 4 9.52a.5.5 0 1 0-.71.71A5 5 0 1 0 8 3z"/></svg>
    </button>
    <input id="url" type="text" value="${originalUrl}" readonly>
    <button class="tb" id="inspect" title="Inspect element (⌘⇧I)">
      <svg viewBox="0 0 16 16"><path d="M1 1v14h14V1H1zm1 1h12v12H2V2zm2 2v2h1V5h1V4H4zm5 0v1h1v1h1V4H9zM7 7v2h2V7H7zm-3 3v2h2v-1H5v-1H4zm6 0v1h-1v1h2v-2h-1z"/></svg>
    </button>
  </div>
  <iframe id="frame" name="dom-inspector-panel" src="${proxyUrl}"></iframe>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById('frame');
      const inspectBtn = document.getElementById('inspect');

      // ---- Typed BridgeChannel relay ----
      // All BridgeMessage types that flow Extension Host → Inspector Script (page)
      const TO_PAGE_TYPES = [
        'start_inspector', 'stop_inspector',
        'get_children', 'get_full_tree', 'inspect_node',
        'set_style', 'toggle_style', 'ai_targets'
      ];
      // All BridgeMessage types that flow Inspector Script (page) → Extension Host
      const TO_HOST_TYPES = [
        'element_hovered', 'element_picked', 'element_pick_cancelled',
        'children_response', 'framework_detected', 'inspector_ready', 'full_tree_response',
        'send_to_ai'
      ];

      let isInspecting = false;

      function setInspecting(active) {
        isInspecting = active;
        inspectBtn.classList.toggle('inspecting', active);
      }

      // ---- Messages from Extension Host → forward to iframe (page) ----
      window.addEventListener('message', function(ev) {
        const msg = ev.data;
        if (!msg || typeof msg.type !== 'string') return;
        console.log('[webview] message received:', msg.type, 'from origin:', ev.origin);

        // If it's a message type destined for the page, relay to iframe
        if (TO_PAGE_TYPES.indexOf(msg.type) !== -1) {
          if (msg.type === 'start_inspector') setInspecting(true);
          if (msg.type === 'stop_inspector') setInspecting(false);
          try { frame.contentWindow.postMessage(msg, '*'); } catch(e) {}
          return;
        }

        // If it's a message type from the page (via iframe postMessage), relay to extension host
        if (TO_HOST_TYPES.indexOf(msg.type) !== -1) {
          if (msg.type === 'element_picked' || msg.type === 'element_pick_cancelled' || msg.type === 'send_to_ai') {
            setInspecting(false);
          }
          vscode.postMessage(msg);
          return;
        }
      });

      // ---- Toolbar buttons ----
      document.getElementById('reload').onclick = function() { frame.src = frame.src; };

      inspectBtn.onclick = function() {
        console.log('[webview] inspect button clicked, isInspecting:', isInspecting);
        if (isInspecting) {
          try { frame.contentWindow.postMessage({ type: 'stop_inspector' }, '*'); } catch(e) { console.error('[webview] postMessage failed:', e); }
          vscode.postMessage({ type: 'stop_inspector' });
          setInspecting(false);
        } else {
          try { frame.contentWindow.postMessage({ type: 'start_inspector' }, '*'); } catch(e) { console.error('[webview] postMessage failed:', e); }
          vscode.postMessage({ type: 'start_inspector' });
          setInspecting(true);
        }
      };
    })();
  </script>
</body>
</html>`;
}
