import * as http from "http";
import * as https from "https";

/**
 * Maps a position in a *served* JS module (as seen in a browser stack frame,
 * e.g. React 19's `fiber._debugStack`) back to the original source position
 * using the module's source map. Dependency-free: fetches the module, reads its
 * `sourceMappingURL` (inline data: URI or external file), decodes the VLQ
 * mappings, and looks up the original line/column.
 */

interface RawSourceMap {
  version?: number;
  sources?: string[];
  sourceRoot?: string;
  mappings?: string;
  sections?: Array<{ offset: { line: number; column: number }; map: RawSourceMap }>;
}

/** [generatedColumn, sourceIndex, originalLine, originalColumn], all 0-based. */
export type Segment = [number, number, number, number];

export interface OriginalPosition {
  /** Source as listed in the map, resolved against sourceRoot and the map URL. */
  source: string;
  /** The raw `sources[]` entry. */
  rawSource: string;
  line: number;    // 1-based
  column: number;  // 1-based
}

const FETCH_TIMEOUT_MS = 2500;
const MAX_BYTES = 20 * 1024 * 1024;
const CACHE_SIZE = 40;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** Decode a source map `mappings` string into per-generated-line segments. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let genCol = 0, srcIdx = 0, origLine = 0, origCol = 0;
  const values: number[] = [];

  const flush = () => {
    if (values.length >= 1) genCol += values[0];
    if (values.length >= 4) {
      srcIdx += values[1];
      origLine += values[2];
      origCol += values[3];
      line.push([genCol, srcIdx, origLine, origCol]);
    }
    values.length = 0;
  };

  let i = 0;
  const n = mappings.length;
  while (i < n) {
    const ch = mappings.charCodeAt(i);
    if (ch === 59 /* ; */) { flush(); lines.push(line); line = []; genCol = 0; i++; continue; }
    if (ch === 44 /* , */) { flush(); i++; continue; }
    let result = 0, shift = 0, digit: number;
    do {
      const c = i < n ? mappings.charCodeAt(i) : -1;
      digit = c >= 0 && c < 128 ? B64_INDEX[c] : -1;
      i++;
      if (digit < 0) throw new Error("invalid VLQ in source map");
      result += (digit & 31) * 2 ** shift;
      shift += 5;
    } while (digit & 32);
    values.push(result % 2 === 1 ? -Math.floor(result / 2) : Math.floor(result / 2));
  }
  flush();
  lines.push(line);
  for (const l of lines) l.sort((a, b) => a[0] - b[0]);
  return lines;
}

/** Find the segment covering (line, column), both 1-based in the generated file. */
export function lookupSegment(lines: Segment[][], line: number, column: number): Segment | null {
  const segs = lines[line - 1];
  if (!segs || segs.length === 0) return null;
  const col0 = column - 1;
  let best: Segment | null = null;
  for (const s of segs) {
    if (s[0] <= col0) best = s; else break;
  }
  return best ?? segs[0];
}

function joinSource(source: string, sourceRoot: string | undefined, mapUrl: string): string {
  let s = source;
  if (sourceRoot && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith("/")) {
    s = sourceRoot.replace(/\/?$/, "/") + s;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("/")) return s;
  try {
    return new URL(s, mapUrl).href;
  } catch {
    return s;
  }
}

/** Resolve a position against a (possibly indexed) raw map. */
export function originalPositionInMap(raw: RawSourceMap, mapUrl: string, line: number, column: number,
  decodedCache?: WeakMap<RawSourceMap, Segment[][]>): OriginalPosition | null {
  if (raw.sections && raw.sections.length) {
    let chosen: (typeof raw.sections)[number] | null = null;
    for (const s of raw.sections) {
      const o = s.offset;
      if (o.line < line - 1 || (o.line === line - 1 && o.column <= column - 1)) chosen = s; else break;
    }
    if (!chosen) return null;
    const relLine = line - chosen.offset.line;
    const relCol = relLine === 1 ? column - chosen.offset.column : column;
    return originalPositionInMap(chosen.map, mapUrl, relLine, relCol, decodedCache);
  }
  if (!raw.mappings || !raw.sources) return null;
  let decoded = decodedCache?.get(raw);
  if (!decoded) {
    decoded = decodeMappings(raw.mappings);
    decodedCache?.set(raw, decoded);
  }
  const seg = lookupSegment(decoded, line, column);
  if (!seg) return null;
  const rawSource = raw.sources[seg[1]];
  if (rawSource == null) return null;
  return {
    source: joinSource(rawSource, raw.sourceRoot, mapUrl),
    rawSource,
    line: seg[2] + 1,
    column: seg[3] + 1,
  };
}

/** Extract the last `sourceMappingURL` reference from JS code. */
export function findSourceMappingUrl(code: string): string | null {
  const re = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g;
  let m: RegExpExecArray | null, last: string | null = null;
  while ((m = re.exec(code))) last = m[1];
  return last;
}

export function parseDataUri(uri: string): string | null {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) return null;
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  return /;base64$/i.test(meta) ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
}

function fetchText(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(url); } catch { resolve(null); return; }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!mod) { resolve(null); return; }
    const req = mod.get(u, { timeout: FETCH_TIMEOUT_MS, headers: { accept: "*/*" } }, (res) => {
      if ((res.statusCode ?? 0) >= 400) { res.resume(); resolve(null); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

interface LoadedMap { raw: RawSourceMap; mapUrl: string }

const mapCache = new Map<string, Promise<LoadedMap | null>>();
const decodedCache = new WeakMap<RawSourceMap, Segment[][]>();

async function loadMap(moduleUrl: string): Promise<LoadedMap | null> {
  const code = await fetchText(moduleUrl);
  if (!code) return null;
  const ref = findSourceMappingUrl(code);
  if (!ref) return null;
  let json: string | null;
  let mapUrl = moduleUrl;
  if (ref.startsWith("data:")) {
    json = parseDataUri(ref);
  } else {
    try { mapUrl = new URL(ref, moduleUrl).href; } catch { return null; }
    json = await fetchText(mapUrl);
  }
  if (!json) return null;
  try {
    return { raw: JSON.parse(json) as RawSourceMap, mapUrl };
  } catch {
    return null;
  }
}

/**
 * Original source position for a location in a served module.
 * `line`/`column` are 1-based, as printed in browser stack traces.
 */
export async function originalPositionFor(moduleUrl: string, line: number, column: number): Promise<OriginalPosition | null> {
  let p = mapCache.get(moduleUrl);
  if (!p) {
    p = loadMap(moduleUrl);
    mapCache.set(moduleUrl, p);
    if (mapCache.size > CACHE_SIZE) mapCache.delete(mapCache.keys().next().value as string);
  }
  const loaded = await p;
  if (!loaded) { mapCache.delete(moduleUrl); return null; }
  try {
    return originalPositionInMap(loaded.raw, loaded.mapUrl, line, column, decodedCache);
  } catch {
    return null;
  }
}

/**
 * Candidate filesystem/workspace paths for a resolved source, most specific
 * first: absolute file paths, Vite `/@fs/` paths, then URL pathnames (which
 * the caller resolves against the workspace).
 */
export function sourcePathCandidates(source: string): string[] {
  const out: string[] = [];
  const push = (s: string) => { if (s && !out.includes(s)) out.push(s); };
  if (source.startsWith("file://")) {
    try { push(decodeURIComponent(new URL(source).pathname)); } catch { /* ignore */ }
    return out;
  }
  if (/^webpack:\/\//.test(source)) {
    // webpack://<namespace>/./src/App.tsx
    push(source.replace(/^webpack:\/\/[^/]*\//, "").replace(/^\.\//, ""));
    return out;
  }
  if (/^https?:\/\//.test(source)) {
    try {
      const pathname = decodeURIComponent(new URL(source).pathname);
      if (pathname.startsWith("/@fs/")) push(pathname.slice(4));
      push(pathname);
    } catch { /* ignore */ }
    return out;
  }
  push(source);
  return out;
}

/** For tests. */
export function clearSourceMapCache(): void {
  mapCache.clear();
}
