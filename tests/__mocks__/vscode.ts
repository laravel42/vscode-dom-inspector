// Minimal vscode mock for tests. Tests replace commands.* with vi.spyOn as needed.
export const commands = {
  executeCommand: (..._args: unknown[]): Promise<unknown> => Promise.resolve(),
  getCommands: (_filterInternal?: boolean): Promise<string[]> => Promise.resolve([]),
};
export const Uri = {
  parse: (s: string) => ({ toString: () => s }),
};
