import { SelectedDomNode, StyleChange, StoredSelection } from "./types.js";
export declare function setCurrentSelection(node: SelectedDomNode): StoredSelection;
export declare function getCurrentSelection(): StoredSelection | null;
export declare function clearCurrentSelection(): void;
export declare function addStyleChange(change: StyleChange): void;
export declare function getStyleChanges(): StyleChange[];
