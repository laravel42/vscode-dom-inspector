import { z } from "zod";

// --- Field length caps ---
const MAX_TEXT = 500;
const MAX_OUTER_HTML = 2000;
const MAX_NEARBY_CONTEXT = 1000;

// --- Zod schema with normalization ---
export const SelectedDomNodeSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional().default(""),
  tagName: z.string().min(1),
  id: z.string().optional().default(""),
  classes: z.array(z.string()).optional().default([]),
  text: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.slice(0, MAX_TEXT)),
  role: z.string().optional().default(""),
  ariaLabel: z.string().optional().default(""),
  selector: z.string().optional().default(""),
  xpath: z.string().optional().default(""),
  attributes: z.record(z.string(), z.string()).optional().default({}),
  outerHTML: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.slice(0, MAX_OUTER_HTML)),
  nearbyContext: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.slice(0, MAX_NEARBY_CONTEXT)),
});

export type SelectedDomNode = z.infer<typeof SelectedDomNodeSchema>;

// Style change record
export const StyleChangeSchema = z.object({
  selector: z.string(),
  property: z.string(),
  oldValue: z.string().optional().default(""),
  newValue: z.string(),
});

export type StyleChange = z.infer<typeof StyleChangeSchema>;

// State wrapper with timestamp
export interface StoredSelection {
  node: SelectedDomNode;
  selectedAt: string; // ISO 8601
  styleChanges: StyleChange[];
}
