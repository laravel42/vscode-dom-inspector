import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ElementData, SourceLocation } from '../types';
import { originalPositionFor, sourcePathCandidates } from './stack-source';

/**
 * SourceMapper resolves a DOM element to its originating source file and line
 * using a prioritized strategy chain. Stops on first successful match.
 *
 * Strategy order:
 *   0. Stack      — React 19 owner stack (served-module position) + source map
 *   1. Source Map — componentInfo.sourceFile + sourceLine (React ≤18, Svelte)
 *   2. Framework  — the component's file (by name) or its declaration inside another file
 *   3. DOM Attr   — data-component, data-source, data-file, data-testid
 *   4. Grep       — search by class string, id, attributes, text…
 *
 * Within a file, the line is chosen by scoring every `<tag …>` opening block
 * against the element (exact class string, id, attributes, text).
 */
export class SourceMapper {
  private static readonly STRATEGY_TIMEOUT_MS = 3000;

  private static readonly FRAMEWORK_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.svelte'];

  private static readonly GREP_INCLUDE = [
    '*.tsx', '*.jsx', '*.vue', '*.svelte', '*.astro', '*.html', '*.erb', '*.hbs',
    '*.ejs', '*.pug', '*.blade.php', '*.twig', '*.njk', '*.mustache',
  ];

  /** Files that can declare components (for "function Nav()" inside App.jsx). */
  private static readonly DECLARATION_INCLUDE = [
    '*.tsx', '*.jsx', '*.ts', '*.js', '*.mjs', '*.vue', '*.svelte',
  ];

  private static readonly GREP_EXCLUDE_DIRS = [
    'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
    'out', '.output', 'coverage', '.cache', '.turbo', 'vendor', '.dom-inspector',
  ];

  private static readonly SOURCE_ATTRS = [
    'data-component', 'data-source', 'data-file', 'data-testid',
  ];

  /** Attributes whose literal values tend to appear verbatim in templates. */
  private static readonly MATCH_ATTRS = [
    'data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id', 'name', 'aria-label',
    'role', 'for', 'href', 'src', 'alt', 'placeholder', 'title', 'type', 'action',
  ];

  async resolve(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const strategies: Array<() => Promise<SourceLocation | null>> = [
      () => this.tryStack(elementData, workspaceRoot),
      () => this.trySourceMap(elementData, workspaceRoot),
      () => this.tryFrameworkHook(elementData, workspaceRoot),
      () => this.tryDOMAttribute(elementData, workspaceRoot),
      () => this.tryGrepFallback(elementData, workspaceRoot),
    ];

    for (const strategy of strategies) {
      const result = await this.withTimeout(strategy(), SourceMapper.STRATEGY_TIMEOUT_MS);
      if (result) {
        return result;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Strategy 0 — Stack (React 19 owner stacks + served-module source maps)
  // ---------------------------------------------------------------------------

  private async tryStack(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const info = elementData.componentInfo;
    if (!info?.stackUrl || !info.stackLine) {
      return null;
    }
    const pos = await originalPositionFor(info.stackUrl, info.stackLine, info.stackColumn ?? 1);
    if (!pos) {
      return null;
    }
    for (const candidate of sourcePathCandidates(pos.source)) {
      const resolved = this.resolveFilePath(candidate, workspaceRoot);
      if (resolved) {
        return {
          filePath: path.relative(workspaceRoot, resolved),
          line: pos.line,
          column: pos.column,
          strategy: 'stack',
        };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Strategy 1 — Source Map (framework debug source: React ≤18, Svelte)
  // ---------------------------------------------------------------------------

  private async trySourceMap(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const info = elementData.componentInfo;
    if (!info?.sourceFile || !info.sourceLine) {
      return null;
    }

    const resolved = this.resolveFilePath(info.sourceFile, workspaceRoot);
    if (!resolved) {
      return null;
    }

    // React's _debugSource points to where the JSX is *used* (e.g. <Hero /> in App.jsx),
    // not where the component is *defined* (Hero.jsx). If the component has a dedicated
    // definition file, prefer that over the usage site.
    if (info.componentName) {
      const sourceBaseName = path.basename(resolved, path.extname(resolved));
      if (sourceBaseName !== info.componentName) {
        const best = this.bestFileForComponent(info.componentName, elementData, workspaceRoot);
        if (best) {
          return { filePath: path.relative(workspaceRoot, best.file), line: best.line, strategy: 'sourcemap' };
        }
      }
    }

    return {
      filePath: path.relative(workspaceRoot, resolved),
      line: info.sourceLine,
      strategy: 'sourcemap',
    };
  }

  // ---------------------------------------------------------------------------
  // Strategy 2 — Framework (component file by name, or its declaration)
  // ---------------------------------------------------------------------------

  private async tryFrameworkHook(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const name = elementData.componentInfo?.componentName;
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
      return null;
    }

    const byFile = this.bestFileForComponent(name, elementData, workspaceRoot);
    if (byFile) {
      return { filePath: path.relative(workspaceRoot, byFile.file), line: byFile.line, strategy: 'framework' };
    }

    // Component declared inside another file, e.g. `function Nav()` in App.jsx.
    const decl = this.findComponentDeclaration(name, workspaceRoot);
    if (decl) {
      const lines = this.readLines(decl.file);
      const end = this.declarationEnd(lines, decl.line);
      const hit = lines ? this.bestLineInLines(lines, elementData, decl.line, end) : null;
      return {
        filePath: path.relative(workspaceRoot, decl.file),
        line: hit ? hit.line : decl.line,
        strategy: 'framework',
      };
    }

    return null;
  }

  /** Among files named `<Name>.{tsx,jsx,vue,svelte}`, pick the one that best contains the element. */
  private bestFileForComponent(
    name: string,
    elementData: ElementData,
    workspaceRoot: string,
  ): { file: string; line: number } | null {
    const files: string[] = [];
    for (const ext of SourceMapper.FRAMEWORK_EXTENSIONS) {
      files.push(...this.findFilesRecursive(workspaceRoot, `${name}${ext}`, 20));
    }
    if (files.length === 0) return null;

    let best: { file: string; line: number; score: number } | null = null;
    for (const file of files) {
      const lines = this.readLines(file);
      const hit = lines ? this.bestLineInLines(lines, elementData) : null;
      const score = (hit?.score ?? 0) + this.pathPreference(path.relative(workspaceRoot, file));
      if (!best || score > best.score) best = { file, line: hit?.line ?? 1, score };
    }
    return best ? { file: best.file, line: best.line } : null;
  }

  private findComponentDeclaration(
    name: string,
    workspaceRoot: string,
  ): { file: string; line: number } | null {
    const includes = SourceMapper.DECLARATION_INCLUDE.map((p) => `--include='${p}'`).join(' ');
    const excludes = SourceMapper.GREP_EXCLUDE_DIRS.map((d) => `--exclude-dir='${d}'`).join(' ');
    const pattern = `(function|class|const|let|var)[[:space:]]+${name}([^A-Za-z0-9_$]|$)`;
    let out = '';
    try {
      out = execSync(`grep -rnE ${includes} ${excludes} -m 5 -- ${this.shellQuote(pattern)} .`, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        timeout: SourceMapper.STRATEGY_TIMEOUT_MS,
      });
    } catch {
      return null;
    }

    let best: { file: string; line: number; score: number } | null = null;
    for (const match of out.split('\n')) {
      const m = match.match(/^\.\/(.+?):(\d+):(.*)/);
      if (!m) continue;
      const [, file, lineStr, content] = m;
      // Must look like a declaration, not `const x = Name(...)`
      if (!new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function\\*?|class|const|let|var)\\s+${name}\\b`).test(content)) continue;
      const score = this.pathPreference(file) + (/\.(tsx|jsx|vue|svelte)$/.test(file) ? 5 : 0);
      if (!best || score > best.score) best = { file, line: parseInt(lineStr, 10), score };
    }
    return best ? { file: path.join(workspaceRoot, best.file), line: best.line } : null;
  }

  /** Last line of a top-level declaration: the line before the next top-level declaration. */
  private declarationEnd(lines: string[] | null, startLine: number): number {
    if (!lines) return startLine;
    for (let i = startLine; i < lines.length; i++) {
      if (/^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var)\s+[A-Za-z_$]/.test(lines[i])) {
        return i; // 1-based index of the previous line == i
      }
    }
    return lines.length;
  }

  // ---------------------------------------------------------------------------
  // Strategy 3 — DOM Attribute
  // ---------------------------------------------------------------------------

  private async tryDOMAttribute(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const attrs = elementData.attrs;
    if (!attrs) {
      return null;
    }

    for (const attr of SourceMapper.SOURCE_ATTRS) {
      const value = attrs[attr];
      if (!value) {
        continue;
      }

      const { filePart, linePart } = this.parseFileHint(value);

      const resolved = this.resolveFilePath(filePart, workspaceRoot);
      if (resolved) {
        return {
          filePath: path.relative(workspaceRoot, resolved),
          line: linePart ?? 1,
          strategy: 'attribute',
        };
      }

      for (const ext of SourceMapper.FRAMEWORK_EXTENSIONS) {
        const filename = `${filePart}${ext}`;
        const found = this.findFileRecursive(workspaceRoot, filename);
        if (found) {
          return {
            filePath: path.relative(workspaceRoot, found),
            line: linePart ?? 1,
            strategy: 'attribute',
          };
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Strategy 4 — Grep Fallback
  // ---------------------------------------------------------------------------

  private async tryGrepFallback(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const searchTerms = this.buildSearchTerms(elementData);

    for (const term of searchTerms) {
      const result = this.grepForTerm(term, workspaceRoot, elementData);
      if (result) {
        return result;
      }
    }

    return null;
  }

  private buildSearchTerms(elementData: ElementData): string[] {
    const terms: string[] = [];
    const tag = elementData.tag;
    const attrs = elementData.attrs || {};

    // 1. id — most specific
    if (elementData.id) {
      terms.push(`id="${elementData.id}"`);
      terms.push(`id='${elementData.id}'`);
      terms.push(`"${elementData.id}"`);
    }

    // 2. The exact class attribute: static className strings (Tailwind!) appear verbatim.
    const classAttr = (attrs.class || '').trim().replace(/\s+/g, ' ');
    if (classAttr.length > 3 && classAttr.length < 300 && classAttr.includes(' ')) {
      terms.push(classAttr);
    }

    // 3. Identifying attributes (data-testid, name, aria-label, role…)
    for (const attr of ['data-testid', 'data-id', 'data-cy', 'data-test', 'name', 'aria-label', 'role', 'for', 'htmlFor']) {
      const val = attrs[attr];
      if (val && val.length > 1 && val.length < 80) {
        terms.push(`${attr}="${val}"`);
        terms.push(`${attr}='${val}'`);
        // JSX uses camelCase
        if (attr === 'for') terms.push(`htmlFor="${val}"`);
      }
    }

    // 4. href/src for links and images — very specific
    if (attrs.href && attrs.href.length > 1 && attrs.href.length < 120 && !attrs.href.startsWith('http')) {
      terms.push(`href="${attrs.href}"`);
    }
    if (attrs.src && attrs.src.length > 1 && attrs.src.length < 120 && !attrs.src.startsWith('http')) {
      terms.push(`src="${attrs.src}"`);
    }
    if (attrs.placeholder) {
      terms.push(attrs.placeholder);
    }
    if (attrs.alt && attrs.alt.length > 3) {
      terms.push(attrs.alt);
    }

    // 5. Class names — try all non-trivial ones, longest first (more specific)
    if (elementData.classNames && elementData.classNames.length > 0) {
      const sorted = [...elementData.classNames]
        .filter(c => c.length > 3 && !this.isTrivialClass(c))
        .sort((a, b) => b.length - a.length);

      for (const cls of sorted.slice(0, 5)) {
        terms.push(`"${cls}"`);
        terms.push(`'${cls}'`);
      }

      if (sorted.length >= 2) {
        const combined = sorted.slice(0, 3).join(' ');
        if (combined.length < 80) {
          terms.push(combined);
        }
      }
    }

    // 6. Tag + type for form elements
    if (attrs.type && ['submit', 'checkbox', 'radio', 'password', 'email', 'tel', 'search', 'file', 'range', 'date', 'number'].includes(attrs.type)) {
      terms.push(`type="${attrs.type}"`);
    }

    // 7. Text content — short, unique strings
    const text = this.firstTextLine(elementData);
    if (text) {
      terms.push(text);
    }

    // 8. Tag name for non-generic elements
    if (tag && !['div', 'span', 'p', 'a', 'li', 'ul', 'ol', 'section', 'article', 'main', 'header', 'footer', 'nav', 'svg', 'path', 'g'].includes(tag)) {
      terms.push(`<${tag}`);
    }

    return terms;
  }

  /** Returns true for utility/layout classes unlikely to appear in source. */
  private isTrivialClass(cls: string): boolean {
    // Tailwind-style single-purpose utilities
    if (/^-?[a-z]{1,3}-\[/.test(cls)) return true; // arbitrary values like w-[200px]
    if (/^(xs|sm|md|lg|xl|2xl):/.test(cls)) return true; // responsive prefixes
    if (/^(hover|focus|active|group-hover|dark):/.test(cls)) return true; // state prefixes
    // Common utility prefixes that are generated/not in source as identifiers
    return /^(flex|grid|p[xytblr]?-|m[xytblr]?-|w-|h-|min-|max-|text-[a-z]{2,4}$|bg-|border$|rounded|gap-|items-|justify-|self-|place-|overflow-|relative$|absolute$|fixed$|sticky$|static$|hidden$|block$|inline$|inline-block$|inline-flex$|sr-only$|not-sr-only$|col-span|row-span|space-[xy]-|divide-|ring-|shadow$|opacity-|transition$|duration-|ease-|delay-|animate-|origin-|scale-|rotate-|translate-|skew-|transform$|cursor-|select-|resize-|appearance-|outline-|pointer-events-|float-|clear-|object-|order-|z-|font-[a-z]+$|leading-|tracking-|whitespace-|break-|truncate$|decoration-|underline$|overline$|line-through$|no-underline$)/.test(cls);
  }

  private grepForTerm(
    term: string,
    workspaceRoot: string,
    elementData: ElementData,
  ): SourceLocation | null {
    try {
      const includes = SourceMapper.GREP_INCLUDE.map((p) => `--include='${p}'`).join(' ');
      const excludes = SourceMapper.GREP_EXCLUDE_DIRS.map((d) => `--exclude-dir='${d}'`).join(' ');

      const cmd = `grep -rn ${includes} ${excludes} -m 10 -F -- ${this.shellQuote(term)} .`;

      const out = execSync(cmd, {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        timeout: SourceMapper.STRATEGY_TIMEOUT_MS,
      }).trim();

      const matches = out.split('\n').filter(Boolean);
      if (matches.length === 0 || matches.length > 50) return null;

      // Score each match
      const scored: Array<{ file: string; line: number; score: number }> = [];
      for (const match of matches) {
        const m = match.match(/^\.\/(.+?):(\d+):(.*)/);
        if (!m) continue;
        const file = m[1];
        const line = parseInt(m[2], 10);
        const content = m[3];

        // Skip minified, dist, compiled files
        if (/\.(min\.|bundle\.)/.test(file)) continue;
        if (/^(dist|build|\.next|out)\//.test(file)) continue;

        let score = this.pathPreference(file);
        // Prefer markup lines
        if (/<[a-zA-Z]|className|class=|htmlFor|placeholder|href=|src=/.test(content)) score += 10;
        // Prefer JSX/TSX/Vue/Svelte files
        if (/\.(tsx|jsx|vue|svelte)$/.test(file)) score += 5;
        // Penalize import/require lines — these reference the component, not define it
        if (/^\s*(import\s|const\s.*=\s*require|export\s.*from\s)/.test(content)) score -= 20;
        // Penalize JSX component usage like <Navbar /> or <Navbar> — prefer the definition file
        if (/^\s*<[A-Z][a-zA-Z]*[\s/>]/.test(content.trim())) score -= 15;
        // Boost component definition lines (function/const/class declarations)
        if (/^\s*(export\s+)?(default\s+)?(function|const|class|let|var)\s+/.test(content) && !/from\s/.test(content)) score += 8;

        scored.push({ file, line, score });
      }

      scored.sort((a, b) => b.score - a.score);
      if (scored.length === 0) return null;

      const best = scored[0];
      const bestLines = this.readLines(path.join(workspaceRoot, best.file));
      const bestContent = bestLines?.[best.line - 1] ?? '';

      // If the best match is a JSX component usage like <Navbar /> or an import,
      // try to resolve to the component's definition instead.
      const jsxMatch = bestContent.match(/^\s*<([A-Z][a-zA-Z0-9]*)[\s/>]/);
      const importMatch = !jsxMatch ? bestContent.match(/^\s*import\s+(\w+)\s+from\s/) : null;
      const compName = jsxMatch?.[1] || importMatch?.[1];
      if (compName) {
        const def = this.bestFileForComponent(compName, elementData, workspaceRoot);
        if (def && path.relative(workspaceRoot, def.file) !== best.file) {
          return { filePath: path.relative(workspaceRoot, def.file), line: def.line, strategy: 'grep' };
        }
      }

      // Refine within the winning file: several grep hits (e.g. three links sharing
      // the same classes) are disambiguated by scoring each opening tag.
      const sameFileHits = scored.filter((s) => s.file === best.file).map((s) => s.line);
      if (bestLines && sameFileHits.length > 1) {
        const refined = this.bestLineInLines(bestLines, elementData);
        if (refined) {
          return { filePath: best.file, line: refined.line, strategy: 'grep' };
        }
      }
      // A single hit on a continuation line of a multi-line opening tag → move to the `<tag` line.
      const anchored = bestLines ? this.openingTagLineFor(bestLines, best.line, elementData.tag) : best.line;
      return { filePath: best.file, line: anchored, strategy: 'grep' };
    } catch {
      // grep returns non-zero when no matches found, or on timeout
    }

    return null;
  }

  /** Shell-quote a string for use in grep arguments. */
  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  // ---------------------------------------------------------------------------
  // Line scoring
  // ---------------------------------------------------------------------------

  /**
   * Search inside a file for the best matching line using element hints.
   * Returns 1 when nothing matches.
   */
  findLineInFile(filePath: string, elementData: ElementData, fromLine = 1, toLine = Infinity): number {
    const lines = this.readLines(filePath);
    if (!lines) return 1;
    return this.bestLineInLines(lines, elementData, fromLine, toLine)?.line ?? Math.max(1, fromLine);
  }

  /**
   * Score every opening `<tag …>` block for the element's tag within
   * [fromLine, toLine] and return the best. Falls back to the first line that
   * contains one of the element's distinctive needles.
   */
  bestLineInLines(
    lines: string[],
    elementData: ElementData,
    fromLine = 1,
    toLine = Infinity,
  ): { line: number; score: number } | null {
    const start = Math.max(0, fromLine - 1);
    const end = Math.min(lines.length, toLine === Infinity ? lines.length : toLine);
    const tag = (elementData.tag || '').toLowerCase();
    const attrs = elementData.attrs || {};
    const classAttr = (attrs.class || '').trim().replace(/\s+/g, ' ');
    const classes = (elementData.classNames || []).filter((c) => c.length > 2 && !/^dom-inspector-/.test(c));
    const text = this.firstTextLine(elementData);
    const attrValues = SourceMapper.MATCH_ATTRS
      .map((a) => attrs[a])
      .filter((v): v is string => !!v && v.length > 1 && v.length < 160 && !/^https?:/.test(v));

    if (tag) {
      // An element rendered *inside* a child component (an icon's <svg>, a library <button>)
      // was written in the owner as <ChildComponent …/>. The component path tells us:
      // [App, Nav, Download] with owner Nav → the element came from <Download>.
      const ci = elementData.componentInfo;
      let childComponent: string | null = null;
      if (ci?.componentName && ci.componentPath?.length) {
        const k = ci.componentPath.lastIndexOf(ci.componentName);
        if (k >= 0 && k < ci.componentPath.length - 1) childComponent = ci.componentPath[k + 1];
      }
      const hostRe = new RegExp(`<${tag.replace(/[^a-z0-9-]/g, '')}(?=[\\s/>]|$)`, 'i');
      const componentRe = /<([A-Z][\w$]*(?:\.[\w$]+)*|[a-z][\w$]*\.[\w$.]+)(?=[\s/>]|$)/;

      const scoreCandidates = (openRe: RegExp, kind: 'host' | 'component') => {
        const scored: Array<{ line: number; score: number }> = [];
        for (let i = start; i < end; i++) {
          const m = lines[i].match(openRe);
          if (!m) continue;
          // The opening tag block: until the first line that closes it (≤ 12 lines).
          let j = i;
          while (j < end - 1 && j - i < 12 && !this.closesOpeningTag(lines[j], j === i ? (m.index ?? 0) : 0)) j++;
          const block = lines.slice(i, j + 1).join('\n');
          const after = lines.slice(j, Math.min(end, j + 4)).join('\n');
          const normalizedBlock = block.replace(/\s+/g, ' ');
          const hasClassAttr = /\b(className|class|:class)\s*=/.test(block);

          let score = 1;
          if (elementData.id && (block.includes(`"${elementData.id}"`) || block.includes(`'${elementData.id}'`))) score += 100;
          if (classAttr.length > 3 && normalizedBlock.includes(classAttr)) score += 60;
          else if (classes.length) {
            let classHits = 0;
            for (const c of classes) if (new RegExp(`(^|[\\s"'\`{])${c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=[\\s"'\`}]|$)`).test(block)) classHits++;
            score += Math.round(30 * classHits / classes.length);
            if (!hasClassAttr) score -= 10;
          } else if (hasClassAttr) {
            score -= 20; // the element has no class, this tag sets one
          }
          for (const v of attrValues) if (block.includes(v)) score += 20;
          if (text && (block.includes(text) || after.includes(text))) score += 15;
          if (kind === 'component' && childComponent && m[1] === childComponent) score += 40;
          scored.push({ line: i + 1, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored;
      };

      const pick = (scored: Array<{ line: number; score: number }>) => {
        if (!scored.length) return null;
        const [first, second] = scored;
        // Accept a clear winner, or the only candidate.
        if (!second || first.score > second.score) return first.score > 0 || !second ? first : null;
        return first.score > 1 ? first : null;
      };

      const passes: Array<[RegExp, 'host' | 'component']> = childComponent
        ? [[componentRe, 'component'], [hostRe, 'host']]
        : [[hostRe, 'host'], [componentRe, 'component']];
      for (const [re, kind] of passes) {
        const scored = scoreCandidates(re, kind);
        // Only fall through to component tags when the host tag doesn't appear at all.
        if (kind === 'host' && scored.length) return pick(scored) ?? this.needleFallback(lines, elementData, start, end, tag, classAttr, classes, attrValues, text);
        const hit = pick(scored);
        if (hit) return hit;
      }
    }

    return this.needleFallback(lines, elementData, start, end, tag, classAttr, classes, attrValues, text);
  }

  private needleFallback(
    lines: string[], elementData: ElementData, start: number, end: number, tag: string,
    classAttr: string, classes: string[], attrValues: string[], text: string | null,
  ): { line: number; score: number } | null {

    // Fallback: first non-import line containing a distinctive needle.
    const needles: string[] = [];
    if (elementData.id) needles.push(`"${elementData.id}"`, `'${elementData.id}'`);
    if (classAttr.length > 3) needles.push(classAttr);
    needles.push(...attrValues);
    needles.push(...classes.filter((c) => !this.isTrivialClass(c)).sort((a, b) => b.length - a.length).slice(0, 5));
    if (text) needles.push(text);
    for (const needle of needles) {
      for (let i = start; i < end; i++) {
        if (lines[i].includes(needle) && !/^\s*(import\s|const\s.*=\s*require|export\s.*from\s)/.test(lines[i])) {
          return { line: this.openingTagLineFor(lines, i + 1, tag), score: 1 };
        }
      }
    }
    return null;
  }

  /** Does this line end the opening tag that starts at `fromCol`? (a `>` outside quotes/braces) */
  private closesOpeningTag(line: string, fromCol: number): boolean {
    let depth = 0;
    let quote: string | null = null;
    for (let k = fromCol; k < line.length; k++) {
      const ch = line[k];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === '>' && depth === 0 && line[k - 1] !== '=') return true;
    }
    return false;
  }

  /** If `line` is inside a multi-line opening tag, return the line where `<tag` starts. */
  private openingTagLineFor(lines: string[], line: number, tag: string): number {
    const idx = line - 1;
    if (!tag || idx < 0 || idx >= lines.length) return line;
    const openRe = new RegExp(`<${tag.replace(/[^a-z0-9-]/gi, '')}(?=[\\s/>]|$)`, 'i');
    if (openRe.test(lines[idx])) return line;
    for (let i = idx - 1; i >= Math.max(0, idx - 8); i--) {
      if (/>\s*$/.test(lines[i]) && !openRe.test(lines[i])) break;
      if (openRe.test(lines[i])) return i + 1;
    }
    return line;
  }

  private firstTextLine(elementData: ElementData): string | null {
    if (!elementData.text) return null;
    const trimmed = elementData.text.trim().split('\n')[0].trim();
    return trimmed.length > 2 && trimmed.length < 60 ? trimmed : null;
  }

  /** Path-based preference: app code over tests/config, shallow over deep. */
  private pathPreference(file: string): number {
    let score = 0;
    if (file.startsWith('src/') || file.includes('/src/')) score += 3;
    score += Math.max(0, 10 - file.split('/').length);
    if (/\.(test|spec|stories)\.[jt]sx?$/.test(file)) score -= 10;
    if (/\.(config|setup)\.[jt]sx?$/.test(file)) score -= 5;
    return score;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private withTimeout<T>(
    promise: Promise<T | null>,
    ms: number,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
  }

  private readLines(filePath: string): string[] | null {
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n');
    } catch {
      return null;
    }
  }

  private resolveFilePath(
    filePath: string,
    workspaceRoot: string,
  ): string | null {
    if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
      if (filePath.startsWith(workspaceRoot)) {
        return filePath;
      }
    }

    // Try direct resolution from workspace root
    const resolved = path.resolve(workspaceRoot, filePath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }

    // Try stripping leading slash and resolving (Vite dev server paths like /src/...)
    const stripped = filePath.replace(/^\/+/, '');
    if (stripped !== filePath) {
      const strippedResolved = path.resolve(workspaceRoot, stripped);
      if (fs.existsSync(strippedResolved) && fs.statSync(strippedResolved).isFile()) {
        return strippedResolved;
      }
    }

    // Try resolving inside subdirectories that contain package.json
    // (handles monorepos / multi-project workspaces)
    try {
      const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const subDir = path.join(workspaceRoot, entry.name);
        if (fs.existsSync(path.join(subDir, 'package.json'))) {
          const candidate = path.resolve(subDir, stripped || filePath);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        }
      }
    } catch {
      // Permission errors
    }

    // An absolute path outside the workspace that exists is still useful.
    if (path.isAbsolute(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return filePath;
    }

    return null;
  }

  private parseFileHint(value: string): { filePart: string; linePart: number | null } {
    const match = value.match(/^(.+):(\d+)$/);
    if (match) {
      return { filePart: match[1], linePart: parseInt(match[2], 10) };
    }
    return { filePart: value, linePart: null };
  }

  private findFileRecursive(dir: string, filename: string): string | null {
    return this.findFilesRecursive(dir, filename, 1)[0] ?? null;
  }

  private findFilesRecursive(dir: string, filename: string, limit: number, out: string[] = []): string[] {
    if (out.length >= limit) return out;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (out.length >= limit) break;
        if (SourceMapper.GREP_EXCLUDE_DIRS.includes(entry.name)) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === filename) {
          out.push(fullPath);
        } else if (entry.isDirectory()) {
          this.findFilesRecursive(fullPath, filename, limit, out);
        }
      }
    } catch {
      // Permission errors, etc.
    }
    return out;
  }
}
