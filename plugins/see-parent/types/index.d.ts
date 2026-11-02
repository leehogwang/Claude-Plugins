// The session shown in the pane, as hooks/transcript.py reads it.
export type Turn = { who: 'user' | 'claude'; text: string }
export type OriginSession = { id: string; cwd: string; turns: Turn[] }

declare module 'claude-code' {
  interface PluginState {
    'see-parent': { origin: OriginSession; reply: string; running: boolean; error: string; draft: string; hint: boolean }
  }
}
