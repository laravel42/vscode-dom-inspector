import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MCP_CLIENTS,
  applyMcpConfig,
  continueYaml,
  hostMcpClient,
  upsertCodexToml,
  upsertJsonConfig,
  type McpServerSpec,
} from '../src/ai/mcp-config';

const spec: McpServerSpec = { command: 'node', args: ['/ext/0.5.0/mcp-server/index.js'], env: { DOM_INSPECTOR_PORT: '3100' } };
const newer: McpServerSpec = { ...spec, args: ['/ext/0.6.0/mcp-server/index.js'] };

describe('upsertJsonConfig', () => {
  it('creates the mcpServers entry in an empty or missing file', () => {
    const r = upsertJsonConfig(null, 'mcpServers', spec);
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ mcpServers: { 'dom-inspector': spec } });
  });

  it('uses VS Code\'s "servers" shape with type stdio', () => {
    const r = upsertJsonConfig('{"servers":{"other":{"type":"http","url":"x"}}}', 'servers', spec);
    expect(JSON.parse(r.text)).toEqual({ servers: { other: { type: 'http', url: 'x' }, 'dom-inspector': { type: 'stdio', ...spec } } });
  });

  it('keeps other servers and the user\'s own fields; refreshes only command/args', () => {
    const existing = JSON.stringify({ mcpServers: { a: { command: 'x' }, 'dom-inspector': { command: 'node', args: ['/old.js'], env: { DOM_INSPECTOR_PORT: '4000' }, autoApprove: ['x'] } }, other: 1 });
    const r = upsertJsonConfig(existing, 'mcpServers', newer);
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text)).toEqual({
      mcpServers: { a: { command: 'x' }, 'dom-inspector': { command: 'node', args: newer.args, env: { DOM_INSPECTOR_PORT: '4000' }, autoApprove: ['x'] } },
      other: 1,
    });
  });

  it('reports unchanged when already up to date (no rewrite on every start)', () => {
    const first = upsertJsonConfig(null, 'mcpServers', spec, { disabled: false, autoApprove: [] });
    expect(upsertJsonConfig(first.text, 'mcpServers', spec, { disabled: false, autoApprove: [] }).changed).toBe(false);
  });

  it('refuses files it cannot parse (e.g. JSON with comments) instead of overwriting them', () => {
    expect(() => upsertJsonConfig('{ // my servers\n "servers": {} }', 'servers', spec)).toThrow();
    expect(() => upsertJsonConfig('[1,2]', 'mcpServers', spec)).toThrow();
  });
});

describe('continueYaml', () => {
  it('writes a Continue MCP block with quoted values', () => {
    expect(continueYaml({ ...spec, args: ['/a b/"x".js'] })).toBe([
      'name: DOM Inspector', 'version: 0.0.1', 'schema: v1', 'mcpServers:',
      '  - name: dom-inspector', '    command: "node"', '    args: ["/a b/\\"x\\".js"]',
      '    env:', '      DOM_INSPECTOR_PORT: "3100"', '',
    ].join('\n'));
  });
});

describe('upsertCodexToml', () => {
  const block = (s: McpServerSpec) => `[mcp_servers.dom-inspector]\ncommand = "node"\nargs = ["${s.args[0]}"]\nenv = { DOM_INSPECTOR_PORT = "3100" }`;

  it('appends to an empty or existing config', () => {
    expect(upsertCodexToml(null, spec).text).toBe(block(spec) + '\n');
    expect(upsertCodexToml('model = "o3"\n', spec).text).toBe('model = "o3"\n\n' + block(spec) + '\n');
  });

  it('replaces only our table, keeping the ones around it', () => {
    const existing = `model = "o3"\n\n${block(spec)}\n\n[mcp_servers.other]\ncommand = "x"\n`;
    const r = upsertCodexToml(existing, newer);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(`model = "o3"\n\n${block(newer)}\n\n[mcp_servers.other]\ncommand = "x"\n`);
    expect(upsertCodexToml(r.text, newer).changed).toBe(false);
  });
});

describe('hostMcpClient', () => {
  it('maps editor names to their MCP config', () => {
    expect(hostMcpClient('Kiro')).toBe('kiro');
    expect(hostMcpClient('Cursor')).toBe('cursor');
    expect(hostMcpClient('Visual Studio Code')).toBe('vscode');
    expect(hostMcpClient('Visual Studio Code - Insiders')).toBe('vscode');
    expect(hostMcpClient('VSCodium')).toBe('vscode');
    expect(hostMcpClient('Windsurf')).toBeNull();
  });
});

describe('applyMcpConfig', () => {
  it('writes every client format into a temp workspace/home and is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcfg-'));
    const paths = { workspace: path.join(root, 'ws'), home: path.join(root, 'home'), globalStorage: path.join(root, 'gs', 'l42.dom-inspector') };
    try {
      for (const client of MCP_CLIENTS) {
        const r = applyMcpConfig(client, spec, paths);
        expect(r.status, client.id).toBe('created');
        expect(fs.existsSync(r.file!)).toBe(true);
        expect(applyMcpConfig(client, spec, paths).status, client.id).toBe('unchanged');
      }
      expect(fs.existsSync(path.join(root, 'ws/.kiro/settings/mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'ws/.cursor/mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'ws/.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'gs/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'home/.codex/config.toml'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'ws/.kiro/settings/mcp.json'), 'utf8')).mcpServers['dom-inspector'])
        .toEqual({ ...spec, disabled: false, autoApprove: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips workspace clients without a folder and reports parse errors without writing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcfg-'));
    try {
      const cursor = MCP_CLIENTS.find((c) => c.id === 'cursor')!;
      expect(applyMcpConfig(cursor, spec, { home: root, globalStorage: root }).status).toBe('skipped');
      const vscodeClient = MCP_CLIENTS.find((c) => c.id === 'vscode')!;
      const file = path.join(root, '.vscode', 'mcp.json');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, '{ // comment\n}');
      const r = applyMcpConfig(vscodeClient, spec, { workspace: root, home: root, globalStorage: root });
      expect(r.status).toBe('error');
      expect(fs.readFileSync(file, 'utf8')).toBe('{ // comment\n}');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
