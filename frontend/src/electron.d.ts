interface FloatingTerminalApi {
  create(opts?: { shell?: string; cwd?: string }): Promise<{ id: string; shell: string }>;
  write(id: string, data: string): void;
  kill(id: string): void;
  resize(id: string, cols: number, rows: number): void;
  onData(callback: (id: string, data: string) => void): () => void;
  onExit(callback: (id: string, code: number, error?: string) => void): () => void;
}

interface MarkdownFileApi {
  open(): Promise<{ path: string; name: string; content: string } | null>;
  save(filePath: string | null, content: string): Promise<{ path: string; name: string } | null>;
}

interface Window {
  electronAPI?: { platform: string };
  floatingTerminal?: FloatingTerminalApi;
  markdownFile?: MarkdownFileApi;
}
