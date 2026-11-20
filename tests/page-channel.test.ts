import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import {
  onPageMessage, onPageClientsChanged, sendToPageClients, pageClients, CHANNEL_PREFIX,
} from '../src/browser/page-channel';
import { startProxy, stopProxy } from '../src/browser/proxy';
import { resolveBrowser } from '../src/browser/browsers';

/** The real proxy + HTTP page channel, against a tiny upstream server. */

let upstream: http.Server;
let proxyPort = 0;
let token = '';

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
}

function openSse(client: string, t = token): Promise<{ events: unknown[]; status: number; close: () => void; next: () => Promise<unknown> }> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    const waiters: Array<(v: unknown) => void> = [];
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path: `${CHANNEL_PREFIX}events?t=${t}&c=${client}` }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) { const v = JSON.parse(data); events.push(v); waiters.shift()?.(v); }
        }
      });
      resolve({ events, status: res.statusCode ?? 0, close: () => req.destroy(), next: () => new Promise((r) => waiters.push(r)) });
    });
  });
}

function post(body: unknown, client = 'c1', t = token): Promise<number> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: `${CHANNEL_PREFIX}message?t=${t}&c=${client}`, headers: { 'content-type': 'application/json' } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.end(data);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<html><body><h1>${req.url}</h1></body></html>`);
  });
  const up = await listen(upstream);
  proxyPort = await startProxy(`http://127.0.0.1:${up}/app`);
  const html = await (await fetch(`http://127.0.0.1:${proxyPort}/deep/path?x=1`)).text();
  token = (html.match(/var DI_TOKEN = '([0-9a-f]+)'/) || [])[1] || '';
});
afterAll(() => { stopProxy(); upstream.close(); });

describe('HTTP page channel', () => {
  it('injects a per-session token, not the placeholder, and proxies the path', async () => {
    const html = await (await fetch(`http://127.0.0.1:${proxyPort}/deep/path?x=1`)).text();
    expect(html).toContain('<h1>/deep/path?x=1</h1>');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(html).not.toContain('__DI_TOKEN__');
  });

  it('rejects requests without the token, and never forwards channel paths upstream', async () => {
    expect(await post({ type: 'inspector_ready' }, 'c1', 'wrong')).toBe(403);
    expect((await openSse('c1', 'wrong')).status).toBe(403);
    expect(await post({ type: 'inspector_ready' }, 'bad.client')).toBe(403);
    const r = await fetch(`http://127.0.0.1:${proxyPort}${CHANNEL_PREFIX}nope?t=${token}&c=c1`);
    expect(r.status).toBe(404);
  });

  it('delivers page → extension messages with the client id', async () => {
    const got: Array<[unknown, string]> = [];
    const off = onPageMessage((m, c) => got.push([m, c]));
    expect(await post({ type: 'element_picked', data: { tag: 'a' } }, 'tab-1')).toBe(204);
    expect(await post('not json' as unknown as object, 'tab-1')).toBe(400);
    off();
    expect(got).toEqual([[{ type: 'element_picked', data: { tag: 'a' } }, 'tab-1']]);
  });

  it('streams extension → page messages to one client or all, and tracks connections', async () => {
    const changes: string[][] = [];
    const off = onPageClientsChanged((c) => changes.push(c));
    const a = await openSse('tab-a');
    const b = await openSse('tab-b');
    await sleep(50);
    expect(pageClients().sort()).toEqual(['tab-a', 'tab-b']);

    const nextA = a.next();
    expect(sendToPageClients({ type: 'start_inspector' }, 'tab-a')).toBe(1);
    expect(await nextA).toEqual({ type: 'start_inspector' });
    expect(b.events).toEqual([]);

    expect(sendToPageClients({ type: 'ai_targets', primary: 'Cursor Chat' })).toBe(2);
    await sleep(50);
    expect(b.events).toEqual([{ type: 'ai_targets', primary: 'Cursor Chat' }]);

    a.close();
    await sleep(100);
    expect(pageClients()).toEqual(['tab-b']);
    b.close();
    await sleep(100);
    off();
    expect(changes[changes.length - 1]).toEqual([]);
  });
});

describe('resolveBrowser', () => {
  const has = (...ids: string[]) => (id: string) => ids.includes(id);
  it('auto prefers the editor\'s full browser, then the panel', () => {
    expect(resolveBrowser('auto', has('workbench.action.browser.open', 'simpleBrowser.api.open'))).toBe('integrated');
    expect(resolveBrowser('auto', has('workbench.action.openBrowserEditor', 'simpleBrowser.api.open'))).toBe('cursor');
    expect(resolveBrowser('auto', has('simpleBrowser.api.open'))).toBe('panel');
  });
  it('honours an explicit choice when it is available, else falls back to the panel', () => {
    expect(resolveBrowser('simple', has('simpleBrowser.api.open'))).toBe('simple');
    expect(resolveBrowser('integrated', has())).toBe('panel');
    expect(resolveBrowser('external', has())).toBe('external');
    expect(resolveBrowser('panel', has('workbench.action.browser.open'))).toBe('panel');
    expect(resolveBrowser('bogus', has())).toBe('panel');
  });
});

describe('cross-origin access (pages attached in Cursor\'s browser)', () => {
  it('answers CORS / private-network preflights without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${CHANNEL_PREFIX}message?t=whatever&c=x`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('still requires the token, and labels every response for CORS', async () => {
    const denied = await fetch(`http://127.0.0.1:${proxyPort}${CHANNEL_PREFIX}message?t=wrong&c=x`, { method: 'POST', body: '{"type":"x"}' });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBe('*');
    const ok = await fetch(`http://127.0.0.1:${proxyPort}${CHANNEL_PREFIX}message?t=${token}&c=cors`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: '{"type":"ping"}',
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
  });
});
