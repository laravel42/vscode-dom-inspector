import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  AI_TARGET_IDS,
  AUTO_PRIORITY,
  TARGET_LABELS,
  availableTargets,
  isTargetAvailable,
  resolvePrimaryTarget,
  substituteArgs,
  type AiEnvironment,
} from '../src/ai/targets';

const env = (appName: string, extensions: string[] = [], customCommand = ''): AiEnvironment => ({
  appName,
  hasExtension: (id) => extensions.map((e) => e.toLowerCase()).includes(id.toLowerCase()),
  customCommand,
});

describe('target availability', () => {
  it('detects built-in chats from the host editor', () => {
    expect(availableTargets(env('Cursor'))).toEqual(['cursor', 'clipboard']);
    expect(availableTargets(env('Kiro'))).toEqual(['kiro', 'clipboard']);
    expect(availableTargets(env('Visual Studio Code'))).toEqual(['clipboard']);
    expect(availableTargets(env('Visual Studio Code', ['GitHub.copilot-chat']))).toEqual(['copilot', 'clipboard']);
  });

  it('detects agent extensions by id (case-insensitive) and orders them by priority', () => {
    const e = env('Cursor', ['anthropic.claude-code', 'saoudrizwan.claude-dev', 'RooVeterinaryInc.roo-cline', 'continue.continue']);
    expect(availableTargets(e)).toEqual(['claude-code', 'cline', 'roo-code', 'continue', 'cursor', 'clipboard']);
  });

  it('custom is available only when a command is configured', () => {
    expect(isTargetAvailable('custom', env('X'))).toBe(false);
    expect(isTargetAvailable('custom', env('X', [], 'my.ai.addFile'))).toBe(true);
    expect(availableTargets(env('Cursor', [], 'my.ai.addFile'))[0]).toBe('custom');
  });

  it('clipboard is always available and every target has a label', () => {
    for (const id of AI_TARGET_IDS) expect(TARGET_LABELS[id]).toBeTruthy();
    expect(new Set(AUTO_PRIORITY)).toEqual(new Set(AI_TARGET_IDS));
    fc.assert(fc.property(fc.string(), fc.array(fc.string()), (app, exts) => {
      expect(availableTargets(env(app, exts))).toContain('clipboard');
    }));
  });
});

describe('resolvePrimaryTarget', () => {
  const available = ['claude-code', 'cursor', 'clipboard'] as const;
  it('an explicit setting wins', () => {
    expect(resolvePrimaryTarget('cline', [...available], 'cursor')).toBe('cline');
    expect(resolvePrimaryTarget('clipboard', [...available])).toBe('clipboard');
  });
  it('auto uses the last choice when still available, else the first available', () => {
    expect(resolvePrimaryTarget('auto', [...available], 'cursor')).toBe('cursor');
    expect(resolvePrimaryTarget('auto', [...available], 'roo-code')).toBe('claude-code');
    expect(resolvePrimaryTarget('auto', [...available])).toBe('claude-code');
    expect(resolvePrimaryTarget('auto', [])).toBe('clipboard');
  });
  it('ignores unknown setting values', () => {
    expect(resolvePrimaryTarget('chatgpt-9000', [...available])).toBe('claude-code');
  });
});

describe('substituteArgs', () => {
  const file = { scheme: 'file', fsPath: '/w/.dom-inspector/e.md' };
  const values = { file, path: '/w/.dom-inspector/e.md', relativePath: '.dom-inspector/e.md', markdown: '# md', prompt: 'Do it' };

  it('passes ${file} through as the Uri object', () => {
    expect(substituteArgs(['${file}'], values)).toEqual([file]);
    expect((substituteArgs(['${file}'], values) as unknown[])[0]).toBe(file);
  });

  it('interpolates string placeholders, recursively', () => {
    expect(substituteArgs({ query: '${prompt}: see @${relativePath}', files: ['${path}'], n: 3 }, values))
      .toEqual({ query: 'Do it: see @.dom-inspector/e.md', files: ['/w/.dom-inspector/e.md'], n: 3 });
    expect(substituteArgs('${markdown}', values)).toBe('# md');
  });

  it('leaves unknown placeholders and non-strings untouched', () => {
    expect(substituteArgs(['${nope}', true, null, 7], values)).toEqual(['${nope}', true, null, 7]);
  });
});
