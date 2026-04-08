import { z } from "zod";
export declare const SelectedDomNodeSchema: z.ZodObject<{
    url: z.ZodString;
    title: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    tagName: z.ZodString;
    id: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    classes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    text: z.ZodEffects<z.ZodDefault<z.ZodOptional<z.ZodString>>, string, string | undefined>;
    role: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    ariaLabel: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    selector: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    xpath: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    attributes: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
    outerHTML: z.ZodEffects<z.ZodDefault<z.ZodOptional<z.ZodString>>, string, string | undefined>;
    nearbyContext: z.ZodEffects<z.ZodDefault<z.ZodOptional<z.ZodString>>, string, string | undefined>;
}, "strip", z.ZodTypeAny, {
    url: string;
    title: string;
    tagName: string;
    id: string;
    classes: string[];
    text: string;
    role: string;
    ariaLabel: string;
    selector: string;
    xpath: string;
    attributes: Record<string, string>;
    outerHTML: string;
    nearbyContext: string;
}, {
    url: string;
    tagName: string;
    title?: string | undefined;
    id?: string | undefined;
    classes?: string[] | undefined;
    text?: string | undefined;
    role?: string | undefined;
    ariaLabel?: string | undefined;
    selector?: string | undefined;
    xpath?: string | undefined;
    attributes?: Record<string, string> | undefined;
    outerHTML?: string | undefined;
    nearbyContext?: string | undefined;
}>;
export type SelectedDomNode = z.infer<typeof SelectedDomNodeSchema>;
export declare const StyleChangeSchema: z.ZodObject<{
    selector: z.ZodString;
    property: z.ZodString;
    oldValue: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    newValue: z.ZodString;
}, "strip", z.ZodTypeAny, {
    selector: string;
    property: string;
    oldValue: string;
    newValue: string;
}, {
    selector: string;
    property: string;
    newValue: string;
    oldValue?: string | undefined;
}>;
export type StyleChange = z.infer<typeof StyleChangeSchema>;
export interface StoredSelection {
    node: SelectedDomNode;
    selectedAt: string;
    styleChanges: StyleChange[];
}
