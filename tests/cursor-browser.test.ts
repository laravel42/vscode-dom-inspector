import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
  cursorBrowserAvailable, currentCursorTab, injectIntoCursorTab, detachFromCursorTab, pickTab, isInspectableUrl,
} from '../src/browser/cursor-browser';

/**
 * Attaching to the page open in Cursor's browser, with Cursor's internal
 * cursor.browserView.* commands replaced by a recording fake.
 */

type Call = { cmd: string; args: unknown[] };

function fakeCursor(handlers: Record<string, (...args: any[]) => unknown>) {
  const calls: Call[] = [];
  vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (cmd: string, ...args: unknown[]) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected command ${cmd}`);
    return h(...args);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('choosing the tab', () => {
  it('prefers the visible tab, then the last used, then any', () => {
    expect(pickTab({ tabs: ['a', 'b'], activeTab: 'b', lastInteractedTab: 'a' })).toBe('b');
    expect(pickTab({ tabs: ['a', 'b'], lastInteractedTab: 'a' })).toBe('a');
    expect(pickTab({ tabs: ['a', 'b'] })).toBe('a');
    expect(pickTab({ tabs: [], activeTab: 'gone' })).toBeUndefined();
  });

  it('only inspects web pages', () => {
    expect(isInspectableUrl('http://localhost:5173/x')).toBe(true);
    expect(isInspectableUrl('https://example.test')).toBe(true);
    expect(isInspectableUrl('about:blank')).toBe(false);
    expect(isInspectableUrl('data:text/plain,hi')).toBe(false);
  });

  it('reads the URL of the chosen tab', async () => {
    fakeCursor({
      'cursor.browserView.listTabs': () => ({ tabs: ['v1', 'v2'], activeTab: 'v2' }),
      'cursor.browserView.getURL': (viewId: string) => (viewId === 'v2' ? 'http://localhost:5173/dash' : 'about:blank'),
    });
    expect(await currentCursorTab()).toEqual({ viewId: 'v2', url: 'http://localhost:5173/dash' });
  });

  it('returns nothing when no tab is open', async () => {
    fakeCursor({ 'cursor.browserView.listTabs': () => ({ tabs: [] }) });
    expect(await currentCursorTab()).toBeUndefined();
  });

  it('detects the API from the command list', async () => {
    vi.spyOn(vscode.commands, 'getCommands').mockResolvedValue([
      'cursor.browserView.listTabs', 'cursor.browserView.getURL', 'cursor.browserView.executeJavaScript', 'cursor.browserView.sendCDPCommand',
    ]);
    expect(await cursorBrowserAvailable()).toBe(true);
    vi.spyOn(vscode.commands, 'getCommands').mockResolvedValue(['workbench.action.openBrowserEditor']);
    expect(await cursorBrowserAvailable()).toBe(false);
  });
});

describe('injecting the inspector', () => {
  const SCRIPT = '(function(){ /* inspector */ })();';

  function cursor(runningToken: string | null) {
    const js: string[] = [];
    const cdp: Array<[string, unknown]> = [];
    const calls = fakeCursor({
      'cursor.browserView.sendCDPCommand': (method: string, params: unknown) => { cdp.push([method, params]); return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: '7' } : {}; },
      'cursor.browserView.executeJavaScript': (code: string) => { js.push(code); return code.includes('__domInspectorToken ||') ? runningToken : undefined; },
    });
    return { calls, js, cdp };
  }

  it('registers the script for future loads and runs it now in a fresh page', async () => {
    const { calls, js, cdp } = cursor(null);
    const injection = await injectIntoCursorTab('v2', SCRIPT, 'tok');
    expect(injection).toEqual({ viewId: 'v2', scriptId: '7' });
    expect(cdp.map(([m]) => m)).toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument']);
    expect(cdp[1][1]).toEqual({ source: SCRIPT });
    expect(js[1]).toContain(SCRIPT);
    expect(calls.every((c) => c.args.includes('v2'))).toBe(true);   // always the chosen tab
  });

  it('does nothing more when this session already runs in the page', async () => {
    const { js } = cursor('tok');
    await injectIntoCursorTab('v2', SCRIPT, 'tok');
    expect(js).toHaveLength(1);   // only the check
  });

  it("reloads a page still running an older session's inspector", async () => {
    const { js } = cursor('old');
    await injectIntoCursorTab('v2', SCRIPT, 'tok');
    expect(js[1]).toContain('location.reload()');
    expect(js.some((c) => c.includes(SCRIPT))).toBe(false);
  });

  it('removes the on-load script when detaching', async () => {
    const { cdp } = cursor(null);
    await detachFromCursorTab({ viewId: 'v2', scriptId: '7' });
    expect(cdp).toEqual([['Page.removeScriptToEvaluateOnNewDocument', { identifier: '7' }]]);
  });
});
