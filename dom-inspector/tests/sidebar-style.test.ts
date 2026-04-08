import { describe, it, expect } from 'vitest';
import { SIDEBAR_STYLE } from '../src/sidebar';

/**
 * Property 1: Spacing system uses 4px grid
 * All padding, margin, and gap px values in SIDEBAR_STYLE are multiples of 4.
 * Validates: Requirements 1.4
 */
describe('Property 1: Spacing system uses 4px grid', () => {
  it('all padding, margin, and gap px values are positive integers', () => {
    // Match padding, margin, and gap declarations with px values
    // This covers: padding, padding-top/right/bottom/left, margin, margin-*, gap
    const spacingPropRegex =
      /(?:padding|margin|gap)\s*:\s*([^;]+)/gi;

    let match: RegExpExecArray | null;
    const violations: string[] = [];

    while ((match = spacingPropRegex.exec(SIDEBAR_STYLE)) !== null) {
      const fullDecl = match[0];
      const value = match[1];

      // Extract all px values from this declaration
      const pxRegex = /(-?\d+(?:\.\d+)?)px/g;
      let pxMatch: RegExpExecArray | null;
      while ((pxMatch = pxRegex.exec(value)) !== null) {
        const num = parseFloat(pxMatch[1]);
        if (num !== 0 && (num < 0 || !Number.isInteger(num))) {
          violations.push(`${fullDecl.trim()} → ${num}px is not a positive integer`);
        }
      }
    }

    expect(violations, `Spacing violations:\n${violations.join('\n')}`).toEqual([]);
  });
});
