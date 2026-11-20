import * as vscode from 'vscode';

/**
 * Shows the component hierarchy of the selected element in the status bar,
 * e.g. `App > Header > Nav > Button`. Display only.
 */
export class ComponentBreadcrumb {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
  }

  /** Render the component path (component names, root first); hides when empty. */
  show(components: string[]): void {
    if (components.length === 0) {
      this.clear();
      return;
    }
    this.statusBarItem.text = `$(symbol-class) ${components.join(' > ')}`;
    this.statusBarItem.tooltip = 'Component path of the selected element';
    this.statusBarItem.show();
  }

  /** Hide the breadcrumb. */
  clear(): void {
    this.statusBarItem.hide();
  }

  /** Clean up all resources. */
  dispose(): void {
    this.clear();
    this.statusBarItem.dispose();
  }
}
