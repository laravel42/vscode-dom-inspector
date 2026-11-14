import * as vscode from "vscode";
import * as path from "path";
import type { SourceLocation } from "../types";
import type { SourceSnippet } from "../ai/context";

/** The folder source lookups run in: the first workspace folder. */
export function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || "/";
}

/** Source lines for the element: from its opening tag to the matching close (≤ 80 lines). */
export async function readSourceSnippet(cwd: string, source: SourceLocation): Promise<SourceSnippet> {
  const base: SourceSnippet = {
    filePath: source.filePath,
    startLine: source.line,
    endLine: source.line,
    strategy: source.strategy,
    code: "",
  };
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(cwd, source.filePath)));
    const start = Math.min(Math.max(0, source.line - 1), doc.lineCount - 1);
    const end = Math.min(findClosingTagLine(doc, start), start + 79);
    const lines: string[] = [];
    for (let i = start; i <= end; i++) lines.push(doc.lineAt(i).text);
    return { ...base, startLine: start + 1, endLine: end + 1, code: lines.join("\n") };
  } catch {
    return base;
  }
}

/** Open a file in column two, select the element (opening tag → matching close) and flash it. */
export async function openSourceFile(
  filePathOrAbsolute: string,
  line: number,
): Promise<void> {
  try {
    const absPath = path.isAbsolute(filePathOrAbsolute)
      ? filePathOrAbsolute
      : path.resolve(workspaceRoot(), filePathOrAbsolute);

    const fileUri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const lineIdx = Math.max(0, line - 1);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Two,
      preserveFocus: false,
    });

    // Find the closing tag to select the full element range
    const endLine = findClosingTagLine(doc, lineIdx);

    const startPos = new vscode.Position(lineIdx, 0);
    const endLineText = doc.lineAt(endLine).text;
    const endPos = new vscode.Position(endLine, endLineText.length);
    const range = new vscode.Range(startPos, endPos);

    editor.selection = new vscode.Selection(startPos, endPos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(88, 166, 255, 0.15)",
      border: "1px solid rgba(88, 166, 255, 0.4)",
      isWholeLine: true,
    });
    editor.setDecorations(decoration, [range]);
    setTimeout(() => decoration.dispose(), 10000);
  } catch {
    // File may not exist or be unreadable
  }
}

/**
 * Starting from a line with an opening tag, find the line with the matching
 * closing tag by tracking bracket depth. Handles self-closing tags, JSX
 * fragments, and multi-line elements.
 */
export function findClosingTagLine(doc: vscode.TextDocument, startLine: number): number {
  const startText = doc.lineAt(startLine).text;

  // Self-closing tag on the same line: <input ... /> or <br />
  if (/\/>\s*$/.test(startText)) {
    return startLine;
  }

  // Extract the tag name from the opening line
  const tagMatch = startText.match(/<([a-zA-Z][a-zA-Z0-9.]*)/);
  if (!tagMatch) {
    return startLine;
  }

  const tagName = tagMatch[1];
  const maxScan = Math.min(doc.lineCount, startLine + 200);

  // First check: is this a self-closing tag split across lines?
  // Scan forward for /> before any closing tag
  for (let i = startLine + 1; i < maxScan; i++) {
    const line = doc.lineAt(i).text;
    if (/\/>\s*$/.test(line)) {
      return i;
    }
    // If we hit a closing tag or a new opening tag at the same indent, stop
    if (new RegExp(`</${escapeRegex(tagName)}\\s*>`).test(line)) {
      break;
    }
    // If we hit > without /, this tag's opening is done — look for closing tag
    if (/[^/]>\s*$/.test(line) || /^[^<]*>\s*$/.test(line)) {
      break;
    }
  }

  // Paired tag: track depth to find matching close
  let depth = 0;
  for (let i = startLine; i < maxScan; i++) {
    const lineText = doc.lineAt(i).text;

    const opens = lineText.match(new RegExp(`<${escapeRegex(tagName)}[\\s>/]`, 'g')) || [];
    const selfCloses = lineText.match(new RegExp(`<${escapeRegex(tagName)}[^>]*/\\s*>`, 'g')) || [];
    const closes = lineText.match(new RegExp(`</${escapeRegex(tagName)}\\s*>`, 'g')) || [];

    depth += opens.length - selfCloses.length - closes.length;

    if (depth <= 0 && i >= startLine) {
      return i;
    }
  }

  return startLine;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
}
