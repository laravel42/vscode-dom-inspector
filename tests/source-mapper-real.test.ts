import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceMapper } from '../src/source/source-mapper';
import type { ElementData } from '../src/types';

/** Exercises the real SourceMapper against a small fixture project on disk. */

const APP = `import { Eye } from "lucide-react";

function Nav() {
  return (
    <nav className="fixed top-0 left-0">
      <div className="flex items-center gap-8 text-sm">
        <a href="#features" className="hover:text-white transition-colors">Features</a>
        <a href="#how" className="hover:text-white transition-colors">How it works</a>
        <a
          href="#install"
          className="px-4 py-2 bg-indigo-500 text-white rounded-lg"
        >
          Install
        </a>
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <main className="min-h-screen">
      <Nav />
      <p className="text-zinc-400">Hello</p>
    </main>
  );
}
`;

function el(partial: Partial<ElementData>): ElementData {
  return {
    selector: '', tag: 'div', id: null, classNames: [], attrs: {}, text: '', outerSnippet: '', domPath: [], children: [],
    boxModel: { content: { x: 0, y: 0, width: 0, height: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, border: { top: 0, right: 0, bottom: 0, left: 0 }, margin: { top: 0, right: 0, bottom: 0, left: 0 } },
    computedStyles: { display: '', position: '', color: '', backgroundColor: '', fontSize: '', fontFamily: '', width: '', height: '', boxSizing: '' },
    xpath: '', cssSelectorPath: '', allComputedStyles: {}, componentInfo: null,
    ...partial,
  };
}
const link = (cls: string, href: string, text: string) =>
  el({ tag: 'a', classNames: cls.split(' '), attrs: { class: cls, href }, text });

let root = '';
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/App.jsx'), APP);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('SourceMapper line scoring', () => {
  const mapper = new SourceMapper();
  const lines = APP.split('\n');

  it('tells apart elements that share the same className by their text', () => {
    expect(mapper.bestLineInLines(lines, link('hover:text-white transition-colors', '#features', 'Features'))?.line).toBe(7);
    expect(mapper.bestLineInLines(lines, link('hover:text-white transition-colors', '#how', 'How it works'))?.line).toBe(8);
  });

  it('returns the `<tag` line of a multi-line opening tag', () => {
    expect(mapper.bestLineInLines(lines, link('px-4 py-2 bg-indigo-500 text-white rounded-lg', '#install', 'Install'))?.line).toBe(9);
  });

  it('respects the line range', () => {
    const p = el({ tag: 'p', classNames: ['text-zinc-400'], attrs: { class: 'text-zinc-400' }, text: 'Hello' });
    expect(mapper.bestLineInLines(lines, p, 1, 18)).toBeNull();
    expect(mapper.bestLineInLines(lines, p, 20)?.line).toBe(24);
  });
});

describe('SourceMapper.resolve', () => {
  it('finds a component declared inside another file (framework strategy)', async () => {
    const mapper = new SourceMapper();
    const e = link('hover:text-white transition-colors', '#how', 'How it works');
    e.componentInfo = { framework: 'react', componentName: 'Nav', componentPath: ['App', 'Nav'], sourceFile: null, sourceLine: null };
    expect(await mapper.resolve(e, root)).toEqual({ filePath: 'src/App.jsx', line: 8, strategy: 'framework' });
  });

  it('finds Tailwind elements by their exact class string (grep strategy)', async () => {
    const mapper = new SourceMapper();
    const e = link('px-4 py-2 bg-indigo-500 text-white rounded-lg', '#install', 'Install');
    expect(await mapper.resolve(e, root)).toMatchObject({ filePath: 'src/App.jsx', line: 9 });
  });
});
