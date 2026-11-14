import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildElementMarkdown,
  elementLabel,
  fence,
  languageForFile,
  snapshotFileName,
  writeSnapshot,
} from '../src/ai/context';
import type { ElementData } from '../src/types';

function makeElement(overrides: Partial<ElementData> = {}): ElementData {
  return {
    selector: 'button.btn',
    tag: 'button',
    id: 'save',
    classNames: ['btn', 'btn-primary'],
    attrs: { id: 'save', class: 'btn btn-primary', type: 'submit', 'aria-label': 'Save changes' },
    text: '  Save\n changes ',
    outerSnippet: '<button id="save" class="btn btn-primary" type="submit">Save changes</button>',
    domPath: ['html', 'body', 'div#root', 'button#save.btn.btn-primary'],
    children: [],
    boxModel: {
      content: { x: 10, y: 20, width: 120.4, height: 32.6 },
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      border: { top: 1, right: 1, bottom: 1, left: 1 },
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    computedStyles: {
      display: 'inline-block', position: 'static', color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(0, 0, 255)',
      fontSize: '14px', fontFamily: 'Inter', width: '120px', height: '32px', boxSizing: 'border-box',
    },
    xpath: '/html/body/div/button',
    cssSelectorPath: 'html > body > div#root > button#save',
    allComputedStyles: { all: { color: 'rgb(255, 255, 255)', display: 'inline-block' }, nonDefault: { color: 'rgb(255, 255, 255)', '-webkit-foo': 'x' } },
    componentInfo: { framework: 'react', componentName: 'SaveButton', componentPath: ['App', 'Toolbar', 'SaveButton'], sourceFile: null, sourceLine: null },
    activeStyles: [
      { selector: 'element.style', properties: [{ property: 'margin', value: '4px', enabled: true, editable: true }] },
      { selector: '.btn', properties: [
        { property: 'padding', value: '8px 16px', enabled: true, editable: true },
        { property: 'color', value: 'red', enabled: false, editable: true },
      ] },
    ],
    ...overrides,
  };
}

const opts = { pageUrl: 'http://localhost:5173/', pickedAt: '2026-11-09T10:00:00.000Z' };

describe('buildElementMarkdown', () => {
  it('includes identity, component path, source snippet, rules, computed styles and HTML', () => {
    const md = buildElementMarkdown(makeElement(), {
      ...opts,
      source: { filePath: 'src/SaveButton.tsx', startLine: 12, endLine: 14, strategy: 'framework', code: '<button\n  id="save"\n/>' },
    });
    expect(md).toContain('# DOM element `<button#save.btn.btn-primary>`');
    expect(md).toContain('http://localhost:5173/');
    expect(md).toContain('`src/SaveButton.tsx` lines 12-14 (resolved via framework');
    expect(md).toContain('```tsx\n<button\n  id="save"\n/>\n```');
    expect(md).toContain('- **CSS path:** `html > body > div#root > button#save`');
    expect(md).toContain('- **Component:** App > Toolbar > SaveButton (react)');
    expect(md).toContain('- **Text:** "Save changes"');
    expect(md).toContain('- **Size:** 120 × 33 px');
    expect(md).toContain('- `aria-label`: `Save changes`');
    expect(md).not.toContain('- `class`:');
    expect(md).toContain('element.style {\n  margin: 4px;\n}');
    expect(md).toContain('/* color: red; (disabled) */');
    expect(md).toContain('color: rgb(255, 255, 255);');
    expect(md).not.toContain('-webkit-foo');
    expect(md).toContain('```html\n<button id="save"');
  });

  it('puts the task right after the header when given', () => {
    const md = buildElementMarkdown(makeElement(), { ...opts, source: null, task: 'Remove this element from the source.' });
    expect(md).toMatch(/Picked with DOM Inspector[^\n]*\n[^\n]*\n\n## Task\n\nRemove this element from the source\.\n\n## Source/);
    expect(buildElementMarkdown(makeElement(), { ...opts, source: null })).not.toContain('## Task');
  });

  it('explains how to search when the source is not resolved', () => {
    const md = buildElementMarkdown(makeElement(), { ...opts, source: null });
    expect(md).toContain('Not resolved automatically');
  });

  it('omits empty sections', () => {
    const md = buildElementMarkdown(
      makeElement({ id: null, classNames: [], attrs: {}, activeStyles: [], allComputedStyles: { all: {}, nonDefault: {} }, outerSnippet: '', componentInfo: null, text: '' }),
      { ...opts, source: null },
    );
    expect(md).not.toContain('## Attributes');
    expect(md).not.toContain('## Matched CSS rules');
    expect(md).not.toContain('## Computed styles');
    expect(md).not.toContain('## HTML');
    expect(md).not.toContain('**Component:**');
  });

  it('never lets element content break out of its code fence', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (html) => {
        const md = buildElementMarkdown(makeElement({ outerSnippet: '<div>' + html + '</div>' }), { ...opts, source: null });
        const section = md.slice(md.indexOf('## HTML'));
        const open = section.match(/\n(`{3,})html\n/);
        expect(open).not.toBeNull();
        const ticks = open![1];
        const body = section.slice(section.indexOf(open![0]) + open![0].length);
        // The first line consisting solely of the fence closes the block, and it comes after all content.
        expect(body.trimEnd().endsWith(ticks)).toBe(true);
        expect(body.slice(0, -ticks.length - 1).includes('\n' + ticks + '\n')).toBe(false);
      }),
    );
  });
});

describe('fence', () => {
  it('uses a fence longer than any backtick run in the body', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (body) => {
        const out = fence('txt', body);
        const ticks = out.match(/^`+/)![0];
        const longestInBody = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
        expect(ticks.length).toBeGreaterThan(longestInBody);
        expect(ticks.length).toBeGreaterThanOrEqual(3);
        expect(out.endsWith('\n' + ticks)).toBe(true);
      }),
    );
  });
});

describe('elementLabel / languageForFile', () => {
  it('formats tag#id.classes', () => {
    expect(elementLabel({ tag: 'a', id: 'x', classNames: ['b', 'c'] })).toBe('a#x.b.c');
    expect(elementLabel({ tag: 'div', id: null, classNames: [] })).toBe('div');
  });
  it('maps template extensions to fence languages', () => {
    expect(languageForFile('src/App.jsx')).toBe('jsx');
    expect(languageForFile('a/B.VUE')).toBe('vue');
    expect(languageForFile('views/home.blade.php')).toBe('php');
    expect(languageForFile('README')).toBe('');
  });
});

describe('snapshot files', () => {
  it('file names are safe to @-mention (no # or ")', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.date({ min: new Date(2000, 0, 1), max: new Date(2099, 0, 1), noInvalidDate: true }), (tag, d) => {
        const name = snapshotFileName(tag, d);
        expect(name).toMatch(/^element-\d{8}-\d{6}-\d{3}-[a-z0-9-]+\.md$/);
        expect(name).not.toMatch(/[#"]/);
      }),
    );
  });

  it('writes a self-ignoring folder and keeps only the newest 20 snapshots', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dom-inspector-')), '.dom-inspector');
    try {
      for (let i = 0; i < 25; i++) {
        writeSnapshot(dir, `element-20261109-1000${String(i).padStart(2, '0')}-000-div.md`, `# ${i}\n`);
      }
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
      expect(files).toHaveLength(20);
      expect(files[0]).toBe('element-20261109-100005-000-div.md');
      expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('*');
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});
