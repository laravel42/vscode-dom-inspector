import { describe, it, expect } from 'vitest';
import { InspectorSidebarProvider } from '../src/ui/sidebar';

/** A stand-in for vscode.WebviewView that records what the provider posts. */
function fakeView() {
  const posted: Array<{ type: string; [k: string]: unknown }> = [];
  let receive: (msg: { type: string }) => void = () => {};
  const view = {
    webview: {
      options: {},
      html: '',
      postMessage: (m: { type: string }) => { posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (cb: (msg: { type: string }) => void) => { receive = cb; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return { view, posted, send: (msg: { type: string }) => receive(msg) };
}

function resolve(provider: InspectorSidebarProvider, v: ReturnType<typeof fakeView>) {
  provider.resolveWebviewView(v.view as never, {} as never, {} as never);
}

describe('sidebar session persistence', () => {
  it('replays the latest state into a re-created view, in dependency order', () => {
    const provider = new InspectorSidebarProvider({ onRequestChildren() {} }, 'v1');
    const first = fakeView();
    resolve(provider, first);

    provider.setAttachAvailable(true);
    provider.log('opening http://localhost:5173');
    provider.setBrowserOpen(true);
    provider.updateFullTree({ tag: 'html', id: null, classNames: [], childCount: 0, selectorPath: 'html', children: [] });
    provider.updateElement({ tag: 'span', selector: 'span' } as never, 'src/App.jsx');
    provider.updateElement({ tag: 'h1', selector: 'h1' } as never, 'src/App.jsx');   // only the latest is kept
    provider.updateHoverPreview({ tag: 'div' } as never);                              // transient: not replayed
    provider.setInspecting(true);

    // VS Code throws the webview away; a new one loads and says it's ready.
    const second = fakeView();
    resolve(provider, second);
    expect(second.posted).toEqual([]);
    second.send({ type: 'sidebar_ready' });

    expect(second.posted.map((m) => m.type)).toEqual([
      'attach_available', 'update_full_tree', 'update_element', 'browser_state', 'inspect_state',
    ]);
    expect((second.posted.find((m) => m.type === 'update_element')!.data as { tag: string }).tag).toBe('h1');
    expect(second.posted.find((m) => m.type === 'inspect_state')!.active).toBe(true);
  });

  it('sends log lines to the logger, not to the webview', () => {
    const lines: string[] = [];
    const provider = new InspectorSidebarProvider({ onRequestChildren() {} }, 'v1', (l) => lines.push(l));
    const view = fakeView();
    resolve(provider, view);
    provider.log('bridge connected');
    expect(lines).toEqual(['bridge connected']);
    expect(view.posted).toEqual([]);
  });
});
