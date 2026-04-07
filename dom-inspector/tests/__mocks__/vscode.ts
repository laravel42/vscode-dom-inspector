// Minimal vscode mock for testing sidebar renderer functions
export const commands = {
  executeCommand: () => Promise.resolve(),
};
export const Uri = {
  parse: (s: string) => ({ toString: () => s }),
};
