import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import type { Duplex } from "stream";
import { channelToken, handleChannelRequest, resetPageChannel } from "./page-channel";
import { webviewAsset } from "../webview/assets";

/**
 * Local reverse proxy in front of the inspected dev server. HTML responses get
 * the inspector injected; framing headers (X-Frame-Options, CSP) are removed;
 * redirects stay on the proxy; WebSocket upgrades (HMR) are tunnelled.
 * Requests under /__dom-inspector__/ go to the page channel instead.
 */

let server: http.Server | undefined;
let currentTarget: string = "";
let proxyPort = 0;

/** The `<script>` tag injected into pages: inspector.js with this session's token. */
export function inspectorScriptTag(): string {
  return "\n<script data-dom-inspector>\n" + webviewAsset("inspector.js").replace("__DI_TOKEN__", channelToken()) + "</script>";
}

export function startProxy(targetUrl: string): Promise<number> {
  currentTarget = targetUrl;

  if (server) {
    return Promise.resolve(proxyPort);
  }

  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (handleChannelRequest(req, res)) return;
      let target: URL;
      try {
        target = new URL(req.url || "/", currentTarget);
      } catch {
        res.writeHead(400);
        res.end("Bad request: invalid URL");
        return;
      }

      const mod = target.protocol === "https:" ? https : http;

      // Ask upstream not to compress so we can reliably read HTML for injection
      const fwdHeaders = { ...req.headers, host: target.host, "accept-encoding": "identity" };

      const proxyReq = mod.request(target.href, {
        method: req.method,
        headers: fwdHeaders,
      }, (proxyRes) => {
        const statusCode = proxyRes.statusCode || 200;

        // Rewrite redirects so the browser stays on the proxy
        if (statusCode >= 300 && statusCode < 400 && proxyRes.headers.location) {
          try {
            const loc = new URL(proxyRes.headers.location, target.href);
            // Rewrite to a proxy-relative path so the iframe doesn't escape
            const rewritten = loc.pathname + loc.search + loc.hash;
            const redirHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers, location: rewritten };
            delete redirHeaders["x-frame-options"];
            delete redirHeaders["content-security-policy"];
            delete redirHeaders["content-security-policy-report-only"];
            res.writeHead(statusCode, redirHeaders);
            res.end();
          } catch {
            // Malformed Location — forward as-is
            res.writeHead(statusCode, proxyRes.headers);
            res.end();
          }
          return;
        }

        const contentType = proxyRes.headers["content-type"] || "";
        const isHtml = contentType.includes("text/html");

        // Remove security headers that block framing
        const headers = { ...proxyRes.headers };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];

        if (isHtml) {
          // Determine if we need to decompress
          const encoding = (proxyRes.headers["content-encoding"] || "").toLowerCase();
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          res.writeHead(statusCode, headers);

          let decompressed: NodeJS.ReadableStream = proxyRes;
          if (encoding === "gzip" || encoding === "x-gzip") {
            decompressed = proxyRes.pipe(zlib.createGunzip());
          } else if (encoding === "br") {
            decompressed = proxyRes.pipe(zlib.createBrotliDecompress());
          } else if (encoding === "deflate") {
            decompressed = proxyRes.pipe(zlib.createInflate());
          }

          const chunks: Buffer[] = [];
          decompressed.on("data", (c: Buffer | string) => {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          });
          decompressed.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            // Inject before </body> or at end
            // Use a replacer function to avoid $' special replacement patterns in INSPECTOR_SCRIPT
            const hasBody = /<\/body>/i.test(body);
            if (hasBody) {
              res.end(body.replace(/<\/body>/i, () => inspectorScriptTag() + "</body>"));
            } else {
              res.end(body + inspectorScriptTag());
            }
          });
          decompressed.on("error", () => {
            // Decompression failed — send whatever we have
            res.end(chunks.length > 0 ? Buffer.concat(chunks) : "");
          });
        } else {
          res.writeHead(statusCode, headers);
          proxyRes.pipe(res);
        }
      });

      proxyReq.on("error", (e) => {
        if (!res.headersSent) {
          res.writeHead(502);
        }
        res.end(`Proxy error: ${e.message}`);
      });

      req.pipe(proxyReq);
    });

    // Dev servers push HMR updates over a WebSocket opened against the page's
    // origin — which is this proxy — so upgrades must be tunnelled to the target.
    server.on("upgrade", proxyUpgrade);

    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      proxyPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve(proxyPort);
    });

    server.on("error", reject);
  });
}

/**
 * Tunnel a WebSocket (or any HTTP Upgrade) request to the current target.
 * Replays the handshake upstream, relays the upstream's response, and then
 * pipes raw bytes in both directions.
 */
function proxyUpgrade(req: http.IncomingMessage, clientSocket: Duplex, clientHead: Buffer): void {
  let target: URL;
  try {
    target = new URL(req.url || "/", currentTarget);
  } catch {
    clientSocket.destroy();
    return;
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
  // The page's origin is the proxy; present the target's origin instead so dev
  // servers that validate Origin on WebSocket handshakes accept the connection.
  if (headers.origin === `http://127.0.0.1:${proxyPort}`) {
    headers.origin = target.origin;
  }

  const mod = target.protocol === "https:" ? https : http;
  const upstreamReq = mod.request(target.href, { method: req.method, headers });

  const writeHead = (res: http.IncomingMessage) => {
    let head = `HTTP/1.1 ${res.statusCode} ${res.statusMessage || ""}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      head += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    }
    clientSocket.write(head + "\r\n");
  };

  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    writeHead(upstreamRes);
    if (upstreamHead.length) clientSocket.write(upstreamHead);
    if (clientHead.length) upstreamSocket.write(clientHead);
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.pipe(clientSocket).pipe(upstreamSocket);
  });

  // Upstream refused the upgrade (e.g. 400 bad token / 403 origin): relay it.
  upstreamReq.on("response", (upstreamRes) => {
    writeHead(upstreamRes);
    upstreamRes.pipe(clientSocket);
  });

  upstreamReq.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamReq.destroy());
  upstreamReq.end();
}

export function stopProxy() {
  resetPageChannel();
  if (server) { server.close(); server = undefined; proxyPort = 0; }
}
