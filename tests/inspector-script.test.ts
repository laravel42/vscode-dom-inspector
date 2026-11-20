import { describe, it, expect } from 'vitest';
import * as vm from 'vm';
import { inspectorScript, inspectorScriptTag } from '../src/browser/proxy';
import { channelToken } from '../src/browser/page-channel';

/** Tests the script exactly as the proxy injects it into pages. */

const tag = inspectorScriptTag();
const body = (tag.match(/<script[^>]*>([\s\S]*)<\/script>/) || [])[1] || '';

/** Evaluate a top-level `var NAME = <expr>;` line from the script. */
function topLevelVar(name: string): unknown {
  const line = body.split('\n').find((l) => l.startsWith(`var ${name} = `));
  if (!line) throw new Error(`var ${name} not found in inspector.js`);
  return vm.runInNewContext(line.slice(`var ${name} = `.length).replace(/;\s*$/, ''));
}

describe('injected inspector script', () => {
  it('is syntactically valid JavaScript', () => {
    expect(body.length).toBeGreaterThan(1000);
    expect(() => new vm.Script(body)).not.toThrow();
  });

  it("carries this session's page-channel token", () => {
    expect(body).not.toContain('__DI_TOKEN__');
    expect(body).toContain(`var DI_TOKEN = '${channelToken()}';`);
  });
});

describe('stack frame parsing (React owner stacks)', () => {
  const FRAME_RE = topLevelVar('FRAME_RE') as RegExp;
  const LIB_URL_RE = topLevelVar('LIB_URL_RE') as RegExp;

  it('parses named and anonymous Chrome frames', () => {
    const m1 = '    at Nav (http://127.0.0.1:36419/src/App.jsx?t=17311:15:13)'.match(FRAME_RE)!;
    expect([m1[1], m1[2], m1[3], m1[4]]).toEqual(['Nav', 'http://127.0.0.1:36419/src/App.jsx?t=17311', '15', '13']);
    const m2 = '    at http://localhost:5173/src/components/Card.tsx:88:9'.match(FRAME_RE)!;
    expect(m2[1]).toBeUndefined();
    expect(m2[2]).toBe('http://localhost:5173/src/components/Card.tsx');
    expect([m2[3], m2[4]]).toEqual(['88', '9']);
    expect('    at Array.map (<anonymous>)'.match(FRAME_RE)).toBeNull();
  });

  it('treats React runtime and dependency frames as library code', () => {
    for (const url of [
      'http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1',
      'http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1',
      'http://localhost:5173/node_modules/lucide-react/dist/esm/Icon.js',
      'http://localhost:5173/@vite/client',
      'http://localhost:5173/@react-refresh',
    ]) expect(LIB_URL_RE.test(url)).toBe(true);
    for (const url of ['http://localhost:5173/src/App.jsx', 'http://127.0.0.1:4000/app/routes/index.tsx?t=1']) {
      expect(LIB_URL_RE.test(url)).toBe(false);
    }
  });

  it('builds attribute selectors with minimal, valid escaping', () => {
    const line = body.split('\n').find((l) => l.startsWith('function attrSel('))!;
    const ctx: { attrSel?: (el: unknown, a: string) => string | null } = {};
    vm.runInNewContext(line + '; this.attrSel = attrSel;', ctx);
    const el = (v: string | null) => ({ getAttribute: () => v });
    expect(ctx.attrSel!(el('#features'), 'href')).toBe('[href="#features"]');
    expect(ctx.attrSel!(el('say "hi"'), 'title')).toBe('[title="say \\"hi\\""]');
    expect(ctx.attrSel!(el('a\\b'), 'name')).toBe('[name="a\\\\b"]');
    expect(ctx.attrSel!(el('two\nlines'), 'title')).toBeNull();
    expect(ctx.attrSel!(el(''), 'title')).toBeNull();
    expect(ctx.attrSel!(el(null), 'title')).toBeNull();
  });

  it('flags build-hashed class names but keeps utility classes', () => {
    const HASHED = topLevelVar('HASHED_CLASS_RE') as RegExp;
    for (const c of ['css-1x2y3z', 'sc-bdfBwQ', '_button_1x2y3_1', 'Button_primary__a1b2c']) expect(HASHED.test(c)).toBe(true);
    for (const c of ['btn', 'btn-primary', 'hover:text-white', 'w-1/2', 'bg-[#0a0a0f]/80']) expect(HASHED.test(c)).toBe(false);
  });
});

describe('channel base', () => {
  it('is same-origin for proxied pages', () => {
    expect(body).toContain("var DI_CHANNEL = '' + '/__dom-inspector__/';");
  });

  it("points at the proxy for pages attached in Cursor's browser, and injects once per session", () => {
    const attached = inspectorScript('http://127.0.0.1:4242');
    expect(attached).toContain("var DI_CHANNEL = 'http://127.0.0.1:4242' + '/__dom-inspector__/';");
    expect(attached).not.toContain('__DI_BASE__');
    expect(attached).not.toContain('__DI_TOKEN__');
    expect(attached).toContain(`if (window.__domInspectorToken === '${channelToken()}') return;`);
    expect(() => new vm.Script(attached)).not.toThrow();
  });
});
