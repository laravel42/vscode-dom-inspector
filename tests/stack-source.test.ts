import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as http from 'http';
import {
  decodeMappings,
  lookupSegment,
  findSourceMappingUrl,
  parseDataUri,
  sourcePathCandidates,
  originalPositionFor,
  originalPositionInMap,
  clearSourceMapCache,
  type Segment,
} from '../src/source/stack-source';

// Minimal VLQ encoder (spec-compliant) to build test maps.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v > 0) d |= 32;
    out += B64[d];
  } while (v > 0);
  return out;
}
function encode(lines: Segment[][]): string {
  let src = 0, ol = 0, oc = 0;
  return lines.map((segs) => {
    let gc = 0;
    return segs.map(([g, s, l, c]) => {
      const r = vlq(g - gc) + vlq(s - src) + vlq(l - ol) + vlq(c - oc);
      gc = g; src = s; ol = l; oc = c;
      return r;
    }).join(',');
  }).join(';');
}

const segArb = fc.tuple(fc.nat(500), fc.nat(3), fc.nat(2000), fc.nat(200)) as fc.Arbitrary<Segment>;
const linesArb = fc.array(
  fc.array(segArb, { maxLength: 6 }).map((segs) => {
    // generated columns must be strictly increasing within a line
    const seen = new Set<number>();
    return segs.filter((s) => !seen.has(s[0]) && seen.add(s[0])).sort((a, b) => a[0] - b[0]);
  }),
  { maxLength: 20 },
);

describe('decodeMappings', () => {
  it('round-trips any encoded mappings', () => {
    fc.assert(fc.property(linesArb, (lines) => {
      const decoded = decodeMappings(encode(lines));
      // trailing empty lines may be dropped/added by ";" handling — compare the populated prefix
      for (let i = 0; i < lines.length; i++) expect(decoded[i] ?? []).toEqual(lines[i]);
    }));
  });

  it('rejects invalid characters', () => {
    expect(() => decodeMappings('AA!A')).toThrow();
  });
});

describe('lookupSegment', () => {
  const lines: Segment[][] = [[], [[0, 0, 10, 0], [8, 0, 11, 4], [20, 0, 12, 2]]];
  it('returns the segment covering the column (1-based input)', () => {
    expect(lookupSegment(lines, 2, 1)).toEqual([0, 0, 10, 0]);
    expect(lookupSegment(lines, 2, 9)).toEqual([8, 0, 11, 4]);
    expect(lookupSegment(lines, 2, 15)).toEqual([8, 0, 11, 4]);
    expect(lookupSegment(lines, 2, 99)).toEqual([20, 0, 12, 2]);
  });
  it('returns null for unmapped lines', () => {
    expect(lookupSegment(lines, 1, 1)).toBeNull();
    expect(lookupSegment(lines, 7, 1)).toBeNull();
  });
});

describe('source map references', () => {
  it('finds the last sourceMappingURL', () => {
    const code = 'a();\n//# sourceMappingURL=old.map\nb();\n//# sourceMappingURL=data:application/json;base64,e30=\n';
    expect(findSourceMappingUrl(code)).toBe('data:application/json;base64,e30=');
    expect(findSourceMappingUrl('no map here')).toBeNull();
  });
  it('decodes base64 and percent-encoded data URIs', () => {
    expect(parseDataUri('data:application/json;base64,' + Buffer.from('{"a":1}').toString('base64'))).toBe('{"a":1}');
    expect(parseDataUri('data:application/json,' + encodeURIComponent('{"b":2}'))).toBe('{"b":2}');
    expect(parseDataUri('https://x/y.map')).toBeNull();
  });
});

describe('sourcePathCandidates', () => {
  it('handles Vite URLs, /@fs paths, file URLs, webpack URLs and bare paths', () => {
    expect(sourcePathCandidates('http://127.0.0.1:5173/src/App.jsx')).toEqual(['/src/App.jsx']);
    expect(sourcePathCandidates('http://localhost:5173/@fs/home/me/lib/Button.tsx')).toEqual(['/home/me/lib/Button.tsx', '/@fs/home/me/lib/Button.tsx']);
    expect(sourcePathCandidates('file:///home/me/app/src/a%20b.tsx')).toEqual(['/home/me/app/src/a b.tsx']);
    expect(sourcePathCandidates('webpack://my-app/./src/page.tsx')).toEqual(['src/page.tsx']);
    expect(sourcePathCandidates('src/App.vue')).toEqual(['src/App.vue']);
  });
});

describe('originalPositionInMap', () => {
  it('resolves sources relative to the map URL and supports indexed maps', () => {
    const map = { version: 3, sources: ['App.jsx'], mappings: encode([[], [[4, 0, 41, 6]]]) };
    expect(originalPositionInMap(map, 'http://h/src/App.jsx?t=1', 2, 10)).toEqual({
      source: 'http://h/src/App.jsx', rawSource: 'App.jsx', line: 42, column: 7,
    });
    const indexed = { version: 3, sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], mappings: encode([[[0, 0, 0, 0]]]) } },
      { offset: { line: 10, column: 0 }, map: { version: 3, sources: ['b.ts'], mappings: encode([[[0, 0, 4, 0]]]) } },
    ] };
    expect(originalPositionInMap(indexed, 'http://h/chunk.js', 11, 1)?.source).toBe('http://h/b.ts');
    expect(originalPositionInMap(indexed, 'http://h/chunk.js', 11, 1)?.line).toBe(5);
  });
});

describe('originalPositionFor (served module + inline map)', () => {
  it('fetches the module, decodes its inline map and maps the position', async () => {
    clearSourceMapCache();
    const map = { version: 3, sources: ['App.jsx'], sourcesContent: ['x'], mappings: encode([[], [], [[2, 0, 9, 4]]]) };
    const code = 'import x;\nfoo();\n  jsxDEV("a");\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64') + '\n';
    const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/javascript'); res.end(code); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const pos = await originalPositionFor(`http://127.0.0.1:${port}/src/App.jsx?t=5`, 3, 3);
      expect(pos).toEqual({ source: `http://127.0.0.1:${port}/src/App.jsx`, rawSource: 'App.jsx', line: 10, column: 5 });
      expect(await originalPositionFor(`http://127.0.0.1:1/unreachable.js`, 1, 1)).toBeNull();
    } finally {
      server.close();
    }
  });
});
