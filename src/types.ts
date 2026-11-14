/**
 * Shared types and interfaces for the DOM Inspector feature.
 *
 * These types are used across the injected page modules, bridge layer,
 * and extension host services.
 */

// ---------------------------------------------------------------------------
// Framework
// ---------------------------------------------------------------------------

export type FrameworkType = 'react' | 'vue' | 'angular' | 'svelte' | null;

// ---------------------------------------------------------------------------
// Box Model & Computed Styles
// ---------------------------------------------------------------------------

export interface BoxModelData {
  content: { x: number; y: number; width: number; height: number };
  padding: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface ComputedStyleData {
  display: string;
  position: string;
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontFamily: string;
  width: string;
  height: string;
  boxSizing: string;
}

// ---------------------------------------------------------------------------
// Component & Source Information
// ---------------------------------------------------------------------------

export interface ComponentInfo {
  framework: FrameworkType;
  componentName: string;
  componentPath: string[];     // Ancestor chain, e.g. ['App', 'Layout', 'Header', 'NavButton']
  sourceFile: string | null;   // Original path from framework debug info (React ≤18 _debugSource, Svelte, Vue __file)
  sourceLine: number | null;
  // Where the element's JSX was created, as a location in the *served* module
  // (React 19 owner stacks). Mapped back to source by the extension host.
  stackUrl?: string | null;
  stackLine?: number | null;
  stackColumn?: number | null;
}

export interface ComponentPathEntry {
  name: string;
  sourceFile: string | null;
}


export interface SourceLocation {
  filePath: string;          // Workspace-relative path
  line: number;              // 1-based line number
  column?: number;           // 1-based column (when available from source maps)
  strategy: 'stack' | 'sourcemap' | 'framework' | 'attribute' | 'grep';
}

// ---------------------------------------------------------------------------
// Active CSS Styles
// ---------------------------------------------------------------------------

export interface ActiveStyleProperty {
  property: string;
  value: string;
  enabled: boolean;
  editable: boolean;
}

export interface ActiveStyleRule {
  selector: string;
  properties: ActiveStyleProperty[];
}

// ---------------------------------------------------------------------------
// DOM Element Data
// ---------------------------------------------------------------------------

export interface ChildSummary {
  tag: string;
  id: string | null;
  classNames: string[];
  childCount: number;
  selectorPath: string;        // Unique path for later retrieval
}

export interface HoverData {
  tag: string;
  id: string | null;
  classNames: string[];
  width: number;
  height: number;
  boxModel: BoxModelData;
}

export interface ElementData {
  // Identity
  selector: string;
  tag: string;
  id: string | null;
  classNames: string[];
  attrs: Record<string, string>;

  // Content
  text: string;                    // First 200 chars of textContent
  outerSnippet: string;            // First 500 chars of outerHTML

  // Structure
  domPath: string[];               // e.g. ['html', 'body', 'div#app', 'main', 'section.hero']
  children: ChildSummary[];        // Direct children summaries

  // Layout
  boxModel: BoxModelData;
  computedStyles: ComputedStyleData;

  // Paths
  xpath: string;
  cssSelectorPath: string;

  // All computed styles
  allComputedStyles: { all: Record<string, string>; nonDefault: Record<string, string> } | Record<string, string>;

  // Framework
  componentInfo: ComponentInfo | null;

  // Active CSS styles (matching rule blocks)
  activeStyles?: ActiveStyleRule[];
}

// ---------------------------------------------------------------------------
// Full DOM Tree
// ---------------------------------------------------------------------------

export interface FullTreeNode {
  tag: string;
  id: string | null;
  classNames: string[];
  childCount: number;
  selectorPath: string;
  children: FullTreeNode[];
}

// ---------------------------------------------------------------------------
// Bridge Messages
// ---------------------------------------------------------------------------

export type BridgeMessage =
  // Extension Host → Inspector Script
  | { type: 'start_inspector' }
  | { type: 'stop_inspector' }
  | { type: 'get_children'; selector: string }
  | { type: 'get_full_tree' }
  | { type: 'inspect_node'; selector: string }
  | { type: 'set_style'; selector: string; property: string; value: string }
  | { type: 'toggle_style'; selector: string; property: string; enabled: boolean }
  | { type: 'ai_targets'; primary: string }          // label of the current AI target, for the context menu
  // Inspector Script → Extension Host
  | { type: 'element_hovered'; data: HoverData }
  | { type: 'element_picked'; data: ElementData }
  | { type: 'element_pick_cancelled' }
  | { type: 'children_response'; selector: string; children: ChildSummary[] }
  | { type: 'framework_detected'; framework: FrameworkType }
  | { type: 'inspector_ready' }
  | { type: 'full_tree_response'; tree: FullTreeNode }
  // right-click menu: send to the current AI target, pick another one, or copy as Markdown
  | { type: 'send_to_ai'; data: ElementData; target: 'primary' | 'pick' | 'clipboard' };
