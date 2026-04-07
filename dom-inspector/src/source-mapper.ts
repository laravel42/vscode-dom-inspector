import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ElementData, SourceLocation } from './types';

/**
 * SourceMapper resolves a DOM element to its originating source file and line
 * using a prioritized strategy chain. Stops on first successful match.
 *
 * Strategy order:
 *   1. Source Map — componentInfo.sourceFile + sourceLine
 *   2. Framework Hook — search by ComponentName filename convention
 *   3. DOM Attribute — data-component, data-source, data-file, data-testid
 *   4. Grep Fallback — search by id, class names, text content, tag+attrs
 */
export class SourceMapper {
  private static readonly STRATEGY_TIMEOUT_MS = 3000;

  private static readonly FRAMEWORK_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.svelte'];

  private static readonly GREP_INCLUDE = [
    '*.tsx', '*.jsx', '*.vue', '*.svelte', '*.astro', '*.html', '*.erb', '*.hbs',
    '*.ejs', '*.pug', '*.blade.php', '*.twig', '*.njk', '*.mustache',
  ];

  private static readonly GREP_EXCLUDE_DIRS = [
    'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
    'out', '.output', 'coverage', '.cache', '.turbo', 'vendor',
  ];

  private static readonly SOURCE_ATTRS = [
    'data-component', 'data-source', 'data-file', 'data-testid',
  ];

  async resolve(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const strategies: Array<() => Promise<SourceLocation | null>> = [
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
  // Strategy 1 — Source Map
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

    return {
      filePath: path.relative(workspaceRoot, resolved),
      line: info.sourceLine,
      strategy: 'sourcemap',
    };
  }

  // ---------------------------------------------------------------------------
  // Strategy 2 — Framework Hook (filename convention)
  // ---------------------------------------------------------------------------

  private async tryFrameworkHook(
    elementData: ElementData,
    workspaceRoot: string,
  ): Promise<SourceLocation | null> {
    const info = elementData.componentInfo;
    if (!info?.componentName) {
      return null;
    }

    const name = info.componentName;

    for (const ext of SourceMapper.FRAMEWORK_EXTENSIONS) {
      const filename = `${name}${ext}`;
      const found = this.findFileRecursive(workspaceRoot, filename);
      if (found) {
        const relPath = path.relative(workspaceRoot, found);
        const line = this.findLineInFile(found, elementData);
        return {
          filePath: relPath,
          line,
          strategy: 'framework',
        };
      }
    }

    return null;
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
      const result = this.grepForTerm(term, workspaceRoot);
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

    // 2. Identifying attributes (data-testid, name, aria-label, role, href, src)
    for (const attr of ['data-testid', 'data-id', 'data-cy', 'data-test', 'name', 'aria-label', 'role', 'for', 'htmlFor']) {
      const val = attrs[attr];
      if (val && val.length > 1 && val.length < 80) {
        terms.push(`${attr}="${val}"`);
        terms.push(`${attr}='${val}'`);
        // JSX uses camelCase
        if (attr === 'for') terms.push(`htmlFor="${val}"`);
      }
    }

    // 3. href/src for links and images — very specific
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

    // 4. Class names — try all non-trivial ones, longest first (more specific)
    if (elementData.classNames && elementData.classNames.length > 0) {
      const sorted = [...elementData.classNames]
        .filter(c => c.length > 3 && !this.isTrivialClass(c))
        .sort((a, b) => b.length - a.length);

      for (const cls of sorted.slice(0, 5)) {
        terms.push(`"${cls}"`);
        terms.push(`'${cls}'`);
      }

      // Also try the full className string for exact matches in HTML class="..."
      if (sorted.length >= 2) {
        const combined = sorted.slice(0, 3).join(' ');
        if (combined.length < 80) {
          terms.push(combined);
        }
      }
    }

    // 5. Tag + type for form elements
    if (attrs.type && ['submit', 'checkbox', 'radio', 'password', 'email', 'tel', 'search', 'file', 'range', 'date', 'number'].includes(attrs.type)) {
      terms.push(`type="${attrs.type}"`);
    }

    // 6. Text content — short, unique strings
    if (elementData.text) {
      const trimmed = elementData.text.trim().split('\n')[0].trim();
      if (trimmed.length > 2 && trimmed.length < 60) {
        terms.push(trimmed);
      }
    }

    // 7. Tag name for non-generic elements
    if (tag && !['div', 'span', 'p', 'a', 'li', 'ul', 'ol', 'section', 'article', 'main', 'header', 'footer', 'nav'].includes(tag)) {
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
  ): SourceLocation | null {
    try {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);

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

        let score = 0;
        // Prefer markup lines
        if (/<[a-zA-Z]|className|class=|htmlFor|placeholder|href=|src=/.test(content)) score += 10;
        // Prefer JSX/TSX/Vue/Svelte files
        if (/\.(tsx|jsx|vue|svelte)$/.test(file)) score += 5;
        // Prefer src/ directory
        if (file.startsWith('src/') || file.includes('/src/')) score += 3;
        // Prefer shorter file paths (closer to root = more likely app code)
        score += Math.max(0, 10 - file.split('/').length);
        // Penalize test files
        if (/\.(test|spec|stories)\.[jt]sx?$/.test(file)) score -= 10;
        // Penalize config files
        if (/\.(config|setup)\.[jt]sx?$/.test(file)) score -= 5;

        scored.push({ file, line, score });
      }

      scored.sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        return {
          filePath: scored[0].file,
          line: scored[0].line,
          strategy: 'grep',
        };
      }
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

  private resolveFilePath(
    filePath: string,
    workspaceRoot: string,
  ): string | null {
    if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
      if (filePath.startsWith(workspaceRoot)) {
        return filePath;
      }
    }

    const resolved = path.resolve(workspaceRoot, filePath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }

    return null;
  }

  /**
   * Search inside a file for the best matching line using element hints.
   */
  findLineInFile(filePath: string, elementData: ElementData): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      const isMarkupLine = (line: string) =>
        /^\s*<|<[a-zA-Z]|className|class=|htmlFor|href=|src=|type=|placeholder=|value=|onChange|onClick/.test(line);

      const needles: Array<{ text: string; markupOnly: boolean }> = [];

      if (elementData.id) {
        needles.push({ text: `id="${elementData.id}"`, markupOnly: true });
        needles.push({ text: `id='${elementData.id}'`, markupOnly: true });
        needles.push({ text: elementData.id, markupOnly: true });
      }

      const attrs = elementData.attrs || {};
      for (const attr of ['data-testid', 'data-id', 'name', 'aria-label', 'placeholder', 'alt']) {
        if (attrs[attr] && attrs[attr].length > 1) {
          needles.push({ text: attrs[attr], markupOnly: true });
        }
      }
      if (attrs.href && !attrs.href.startsWith('http')) {
        needles.push({ text: attrs.href, markupOnly: true });
      }

      // Class names — longest first
      if (elementData.classNames) {
        const sorted = [...elementData.classNames]
          .filter(c => c.length > 3 && !this.isTrivialClass(c))
          .sort((a, b) => b.length - a.length);
        for (const cls of sorted.slice(0, 5)) {
          needles.push({ text: cls, markupOnly: true });
        }
      }

      // Tag for non-generic elements
      if (elementData.tag && !['div', 'span'].includes(elementData.tag)) {
        needles.push({ text: `<${elementData.tag}`, markupOnly: true });
      }

      // Text content
      if (elementData.text) {
        const trimmed = elementData.text.trim().split('\n')[0].trim();
        if (trimmed.length > 2 && trimmed.length < 60) {
          needles.push({ text: trimmed, markupOnly: false });
        }
      }

      for (const needle of needles) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(needle.text)) {
            if (!needle.markupOnly || isMarkupLine(lines[i])) {
              return i + 1;
            }
          }
        }
      }
    } catch {
      // File read error
    }
    return 1;
  }

  private parseFileHint(value: string): { filePart: string; linePart: number | null } {
    const match = value.match(/^(.+):(\d+)$/);
    if (match) {
      return { filePart: match[1], linePart: parseInt(match[2], 10) };
    }
    return { filePart: value, linePart: null };
  }

  private findFileRecursive(dir: string, filename: string): string | null {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SourceMapper.GREP_EXCLUDE_DIRS.includes(entry.name)) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === filename) {
          return fullPath;
        }
        if (entry.isDirectory()) {
          const found = this.findFileRecursive(fullPath, filename);
          if (found) {
            return found;
          }
        }
      }
    } catch {
      // Permission errors, etc.
    }
    return null;
  }
}
