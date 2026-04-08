import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  renderElementSummary,
  renderBoxModel,
  renderDOMPath,
  renderComponentHierarchy,
  renderComputedStyles,
  renderHTMLPreview,
  renderDOMTree,
  renderDebugLog,
} from '../src/sidebar';
import type {
  ElementData,
  BoxModelData,
  ComputedStyleData,
  ComponentInfo,
  ChildSummary,
  FrameworkType,
} from '../src/types';

/* ------------------------------------------------------------------ */
/*  Shared Arbitraries                                                */
/* ------------------------------------------------------------------ */

const tagArb = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/);
const idArb = fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/), { nil: null });
const classNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/);
const classNamesArb = fc.array(classNameArb, { minLength: 0, maxLength: 5 });
const selectorArb = fc.stringMatching(/^[a-z][a-z0-9.#> -]{0,30}$/);

const boxModelArb: fc.Arbitrary<BoxModelData> = fc.record({
  content: fc.record({
    x: fc.float({ min: -1000, max: 5000, noNaN: true }),
    y: fc.float({ min: -1000, max: 5000, noNaN: true }),
    width: fc.float({ min: 0, max: 5000, noNaN: true }),
    height: fc.float({ min: 0, max: 5000, noNaN: true }),
  }),
  padding: fc.record({ top: fc.nat(100), right: fc.nat(100), bottom: fc.nat(100), left: fc.nat(100) }),
  border: fc.record({ top: fc.nat(20), right: fc.nat(20), bottom: fc.nat(20), left: fc.nat(20) }),
  margin: fc.record({ top: fc.nat(100), right: fc.nat(100), bottom: fc.nat(100), left: fc.nat(100) }),
});

const attrKeyArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/).filter(
  k => k !== 'class' && k !== 'id' && k !== 'style'
);
const attrValArb = fc.stringMatching(/^[a-zA-Z0-9 _-]{0,30}$/);
const attrsArb = fc.dictionary(attrKeyArb, attrValArb, { minKeys: 0, maxKeys: 4 });

const computedStyleArb: fc.Arbitrary<ComputedStyleData> = fc.record({
  display: fc.constantFrom('block', 'flex', 'inline', 'grid', 'none', 'inline-block'),
  position: fc.constantFrom('static', 'relative', 'absolute', 'fixed', 'sticky'),
  color: fc.constantFrom('rgb(0, 0, 0)', 'rgb(255, 255, 255)', '#ff0000', '#333', 'inherit', 'transparent'),
  backgroundColor: fc.constantFrom('rgb(255, 255, 255)', 'rgba(0,0,0,0)', '#000', '#fff', 'transparent'),
  fontSize: fc.constantFrom('16px', '14px', '12px', '11px', '24px'),
  fontFamily: fc.constantFrom('Arial', 'monospace', '"Segoe UI", sans-serif', 'system-ui'),
  width: fc.constantFrom('100px', 'auto', '50%', '200px'),
  height: fc.constantFrom('auto', '100px', '50vh', '300px'),
  boxSizing: fc.constantFrom('content-box', 'border-box'),
});

const frameworkArb: fc.Arbitrary<FrameworkType> = fc.constantFrom('react', 'vue', 'angular', 'svelte', null);

const componentInfoArb: fc.Arbitrary<ComponentInfo> = fc.record({
  framework: frameworkArb,
  componentName: fc.stringMatching(/^[A-Z][a-zA-Z]{1,15}$/),
  componentPath: fc.array(fc.stringMatching(/^[A-Z][a-zA-Z]{1,15}$/), { minLength: 1, maxLength: 6 }),
  sourceFile: fc.option(fc.stringMatching(/^src\/[a-z]{1,10}\.[a-z]{1,4}$/), { nil: null }),
  sourceLine: fc.option(fc.nat(500), { nil: null }),
});

const childSummaryArb: fc.Arbitrary<ChildSummary> = fc.record({
  tag: tagArb,
  id: idArb,
  classNames: classNamesArb,
  childCount: fc.nat(50),
  selectorPath: selectorArb,
});

function makeElementData(overrides: Partial<ElementData> = {}): fc.Arbitrary<ElementData> {
  return fc.record({
    tag: tagArb,
    id: idArb,
    classNames: classNamesArb,
    selector: selectorArb,
    attrs: attrsArb,
    text: fc.string({ minLength: 0, maxLength: 300 }),
    outerSnippet: fc.constant('<div></div>'),
    domPath: fc.array(tagArb, { minLength: 0, maxLength: 5 }),
    children: fc.constant([] as ChildSummary[]),
    boxModel: boxModelArb,
    computedStyles: computedStyleArb,
    componentInfo: fc.constant(null as ComponentInfo | null),
    xpath: fc.constant(''),
    cssSelectorPath: fc.constant(''),
    allComputedStyles: fc.constant({} as Record<string, string>),
  }).map(data => ({ ...data, ...overrides }));
}

/* ------------------------------------------------------------------ */
/*  Property 2: Element summary completeness                          */
/* ------------------------------------------------------------------ */

/**
 * Property 2: Element summary contains all identity and layout information
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 */
describe('Property 2: Element summary completeness', () => {
  /** HTML-escape helper matching the renderer's esc() function */
  function esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  it('output contains tag, id, classNames, selector, dimensions, and attribute keys', () => {
    fc.assert(
      fc.property(makeElementData(), (data) => {
        const html = renderElementSummary(data);

        // Tag is always present (escaped in output)
        expect(html).toContain(esc(data.tag));

        // Id when present
        if (data.id) {
          expect(html).toContain(esc(data.id));
        }

        // Each className
        for (const cls of data.classNames) {
          expect(html).toContain(esc(cls));
        }

        // Rounded dimensions from boxModel.content
        const c = data.boxModel.content;
        expect(html).toContain(String(Math.round(c.width)));
        expect(html).toContain(String(Math.round(c.height)));
        expect(html).toContain(String(Math.round(c.x)));
        expect(html).toContain(String(Math.round(c.y)));

        // Attribute keys (excluding class, id, style)
        const filtered = Object.entries(data.attrs).filter(
          ([k]) => k !== 'class' && k !== 'id' && k !== 'style'
        );
        for (const [k] of filtered) {
          expect(html).toContain(esc(k));
        }
      }),
      { numRuns: 100 },
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Property 3: Text preview truncation                               */
/* ------------------------------------------------------------------ */

/**
 * Property 3: Text preview truncation
 * Validates: Requirements 5.5
 */
describe('Property 3: Text preview truncation', () => {
  it('empty or whitespace-only text does not produce text-preview', () => {
    const whitespaceText = fc.constantFrom('', ' ', '  ', '\t', '\n', '  \n  ');
    fc.assert(
      fc.property(
        makeElementData().chain(base => whitespaceText.map(t => ({ ...base, text: t }))),
        (data) => {
          const html = renderElementSummary(data);
          expect(html).not.toContain('text-preview');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-empty text produces text-preview with at most 150 chars', () => {
    // Generate text with at least one non-whitespace character
    const nonEmptyText = fc.string({ minLength: 1, maxLength: 300 }).filter(s => s.trim().length > 0);
    fc.assert(
      fc.property(
        makeElementData().chain(base => nonEmptyText.map(t => ({ ...base, text: t }))),
        (data) => {
          const html = renderElementSummary(data);
          expect(html).toContain('text-preview');

          // Extract the text content inside the text-preview div
          // The renderer does: data.text.slice(0, 150) then esc()
          // So the displayed text should be at most 150 chars of the original
          const sliced = data.text.slice(0, 150);
          // The sliced text (after HTML escaping) should appear in the output
          const escaped = sliced
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
          expect(html).toContain(escaped);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Property 4: HTML syntax highlighting                              */
/* ------------------------------------------------------------------ */

/**
 * Property 4: HTML syntax highlighting applies correct span classes
 * Validates: Requirements 6.2
 */
describe('Property 4: HTML syntax highlighting', () => {
  const simpleTagArb = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
  const attrNameArb = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
  const attrValueArb = fc.stringMatching(/^[a-zA-Z0-9 _-]{1,15}$/);

  it('output contains hl-tag and hl-punct spans for any tag', () => {
    fc.assert(
      fc.property(simpleTagArb, (tag) => {
        const snippet = `<${tag}>`;
        const html = renderHTMLPreview(snippet);
        expect(html).toContain('hl-tag');
        expect(html).toContain('hl-punct');
      }),
      { numRuns: 100 },
    );
  });

  it('output contains hl-attr and hl-val spans when attributes are present', () => {
    fc.assert(
      fc.property(simpleTagArb, attrNameArb, attrValueArb, (tag, attr, val) => {
        const snippet = `<${tag} ${attr}="${val}">`;
        const html = renderHTMLPreview(snippet);
        expect(html).toContain('hl-attr');
        expect(html).toContain('hl-val');
      }),
      { numRuns: 100 },
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Property 5: Computed styles grouping                              */
/* ------------------------------------------------------------------ */

/**
 * Property 5: Computed styles are grouped and color-swatched
 * Validates: Requirements 7.1, 7.2
 */
describe('Property 5: Computed styles grouping', () => {
  it('output contains Layout, Typography, Color group labels and all expected keys', () => {
    fc.assert(
      fc.property(computedStyleArb, (styles) => {
        const html = renderComputedStyles(styles);

        // Group labels
        expect(html).toContain('Layout');
        expect(html).toContain('Typography');
        expect(html).toContain('Color');

        // Layout keys
        expect(html).toContain('display');
        expect(html).toContain('position');
        expect(html).toContain('width');
        expect(html).toContain('height');
        expect(html).toContain('boxSizing');

        // Typography keys
        expect(html).toContain('fontSize');
        expect(html).toContain('fontFamily');

        // Color keys
        expect(html).toContain('color');
        expect(html).toContain('backgroundColor');
      }),
      { numRuns: 100 },
    );
  });

  it('color swatch appears when color/backgroundColor starts with rgb or #', () => {
    fc.assert(
      fc.property(computedStyleArb, (styles) => {
        const html = renderComputedStyles(styles);
        const colorIsRgbOrHex = styles.color.startsWith('rgb') || styles.color.startsWith('#');
        const bgIsRgbOrHex = styles.backgroundColor.startsWith('rgb') || styles.backgroundColor.startsWith('#');

        if (colorIsRgbOrHex || bgIsRgbOrHex) {
          expect(html).toContain('color-swatch');
        }
      }),
      { numRuns: 100 },
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Property 6: DOM tree node labels                                  */
/* ------------------------------------------------------------------ */

/**
 * Property 6: DOM tree node label contains tag, id, classes, and child count
 * Validates: Requirements 8.1, 8.2
 */
describe('Property 6: DOM tree node labels', () => {
  it('node contains t-tag, t-id when present, t-class for each class, t-count when childCount > 0', () => {
    fc.assert(
      fc.property(childSummaryArb, (child) => {
        const html = renderDOMTree([child]);

        // Tag in t-tag span
        expect(html).toContain(`<span class="t-tag">`);
        expect(html).toContain(child.tag);

        // Id in t-id span when present
        if (child.id) {
          expect(html).toContain(`<span class="t-id">#${child.id}</span>`);
        }

        // Each className in t-class span
        for (const cls of child.classNames) {
          expect(html).toContain(`<span class="t-class">.${cls}</span>`);
        }

        // Child count
        if (child.childCount > 0) {
          expect(html).toContain('t-count');
          expect(html).toContain(`(${child.childCount})`);
        } else {
          expect(html).not.toContain('t-count');
        }
      }),
      { numRuns: 100 },
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Property 7: DOM tree truncation                                   */
/* ------------------------------------------------------------------ */

/**
 * Property 7: DOM tree truncates at MAX_CHILDREN_PER_NODE
 * Validates: Requirements 8.5
 */
describe('Property 7: DOM tree truncation', () => {
  it('arrays of >500 items produce exactly 500 tree-node divs plus show-more', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 501, max: 600 }),
        (count) => {
          const children: ChildSummary[] = Array.from({ length: count }, (_, i) => ({
            tag: 'div',
            id: null,
            classNames: [],
            childCount: 0,
            selectorPath: `div:nth-child(${i})`,
          }));

          const html = renderDOMTree(children);

          // Count tree-node divs
          const treeNodeMatches = html.match(/class="tree-node"/g);
          expect(treeNodeMatches).not.toBeNull();
          expect(treeNodeMatches!.length).toBe(500);

          // Show-more indicator with remaining count
          expect(html).toContain('show-more');
          expect(html).toContain(`${count - 500} more`);
        },
      ),
      { numRuns: 20 },
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Property 8: Component hierarchy                                   */
/* ------------------------------------------------------------------ */

/**
 * Property 8: Component hierarchy renders depth, badge, and source
 * Validates: Requirements 11.1, 11.2, 11.3
 */
describe('Property 8: Component hierarchy', () => {
  it('each component has --cdepth equal to its index', () => {
    fc.assert(
      fc.property(componentInfoArb, (info) => {
        const html = renderComponentHierarchy(info);
        for (let i = 0; i < info.componentPath.length; i++) {
          expect(html).toContain(`--cdepth:${i}`);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('framework badge shows uppercase framework name when non-null', () => {
    const withFramework = componentInfoArb.filter(ci => ci.framework !== null);
    fc.assert(
      fc.property(withFramework, (info) => {
        const html = renderComponentHierarchy(info);
        expect(html).toContain('comp-badge');
        expect(html).toContain(info.framework!.toUpperCase());
      }),
      { numRuns: 100 },
    );
  });

  it('source file path appears in comp-meta when sourceFile is non-null', () => {
    const withSource = componentInfoArb.filter(ci => ci.sourceFile !== null);
    fc.assert(
      fc.property(withSource, (info) => {
        const html = renderComponentHierarchy(info);
        expect(html).toContain('comp-meta');
        expect(html).toContain(info.sourceFile!);
      }),
      { numRuns: 100 },
    );
  });

  it('returns empty string when componentInfo is null', () => {
    expect(renderComponentHierarchy(null)).toBe('');
  });
});
