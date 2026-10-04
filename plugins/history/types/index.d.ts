// A Haiku summary of a session, kept until its transcript changes.
// `records`: how far into the transcript it reaches; the next update starts there.
export type Summary = { mtime: number; records?: number; text: string; tokens?: { in: number; out: number } }

declare module 'claude-code' {
  interface PluginState {
    history: { summary: Summary; busy: boolean; error: string }
  }
}
