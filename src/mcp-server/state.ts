import { SelectedDomNode, StyleChange, StoredSelection } from "./types.js";

let currentSelection: StoredSelection | null = null;

export function setCurrentSelection(node: SelectedDomNode): StoredSelection {
  const stored: StoredSelection = {
    node,
    selectedAt: new Date().toISOString(),
    styleChanges: [],
  };
  currentSelection = stored;
  return stored;
}

export function getCurrentSelection(): StoredSelection | null {
  return currentSelection;
}

export function clearCurrentSelection(): void {
  currentSelection = null;
}

export function addStyleChange(change: StyleChange): void {
  if (currentSelection) {
    currentSelection.styleChanges.push(change);
  }
}

export function getStyleChanges(): StyleChange[] {
  return currentSelection?.styleChanges ?? [];
}
