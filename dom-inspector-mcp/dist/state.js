let currentSelection = null;
export function setCurrentSelection(node) {
    const stored = {
        node,
        selectedAt: new Date().toISOString(),
        styleChanges: [],
    };
    currentSelection = stored;
    return stored;
}
export function getCurrentSelection() {
    return currentSelection;
}
export function clearCurrentSelection() {
    currentSelection = null;
}
export function addStyleChange(change) {
    if (currentSelection) {
        currentSelection.styleChanges.push(change);
    }
}
export function getStyleChanges() {
    return currentSelection?.styleChanges ?? [];
}
//# sourceMappingURL=state.js.map