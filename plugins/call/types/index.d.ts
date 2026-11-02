// `steps`: what the CLI did on the way to an answer (commands, files read or changed); `open`: the list is unfolded
export type Turn = { who: 'user' | 'ai'; text: string; steps?: string[]; open?: boolean }
// one conversation per CLI (`steps` are those of the turn running now, `unread` marks an answer that came while another tab was shown); `sid` is the id the CLI itself uses to continue it ('' before the first answer)
// `seen`: how many records of the Claude Code session this chat has been told about
// `model`, `effort`: what the CLI is started with; '' is the CLI's own default
export type Chat = { sid: string; seen: number; model: string; effort: string; draft: string; turns: Turn[]; steps: string[]; running: boolean; unread: boolean; error: string }
// a choice in the model list; `efforts` is what that model allows when it differs from the CLI's own list (agy bakes the effort into the model id)
export type Model = { id: string; label: string; efforts: string[] }
// `flags`: files an agent is changing right now (path -> who: a CLI name, or "main" for the Claude Code session)
export type Chats = { flags: Record<string, string[]>; found: string[]; models: Record<string, Model[]>; active: string; hint: boolean; menu: boolean; chats: Record<string, Chat> }

declare module 'claude-code' {
  interface PluginState {
    call: { chats: Chats }
  }
}
