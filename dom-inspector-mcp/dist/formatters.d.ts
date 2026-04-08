import { StoredSelection } from "./types.js";
/**
 * Format the stored selection as a concise markdown document
 * suitable for AI model consumption.
 */
export declare function formatSelectionAsMarkdown(sel: StoredSelection): string;
/**
 * Markdown message when no node is selected.
 */
export declare function formatNoSelection(): string;
/**
 * Build the analysis prompt that wraps the selected node context.
 */
export declare function formatAnalysisPrompt(sel: StoredSelection): string;
/**
 * Analysis prompt when no node is selected.
 */
export declare function formatNoSelectionPrompt(): string;
/**
 * Build the apply-styles prompt from recorded style changes.
 */
export declare function formatApplyStylesPrompt(sel: StoredSelection): string;
/**
 * Build the remove-node prompt.
 */
export declare function formatRemoveNodePrompt(sel: StoredSelection): string;
