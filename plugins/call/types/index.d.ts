// `steps`: what the CLI did on the way to an answer (commands, files read or changed); `open`: the list is unfolded
export type Turn = { who: 'user' | 'ai'; text: string; steps?: string[]; open?: boolean }
// one conversation per CLI (`steps` are those of the turn running now, `unread` marks an answer that came while another tab was shown); `sid` is the id the CLI itself uses to continue it ('' before the first answer)
// `seen`: how many records of the Claude Code session this chat has been told about
// `failed`: a message that could not be sent (the Claude Code conversation could not be read), kept for the retry button; `snap`: the working-tree snapshot taken at this chat's last turn; `pending`: characters of conversation given since the AI last summarised it; `noted`: it has been asked to summarise
// `model`, `effort`: what the CLI is started with; '' is the CLI's own default
export type Chat = { sid: string; seen: number; model: string; effort: string; draft: string; turns: Turn[]; steps: string[]; running: boolean; unread: boolean; error: string; failed: string; snap: string; pending: number; noted: boolean }
// a choice in the model list; `efforts` is what that model allows when it differs from the CLI's own list (agy bakes the effort into the model id)
export type Model = { id: string; label: string; efforts: string[] }
// `flags`: files an agent is changing right now (path -> who: a CLI name, or "main" for the Claude Code session)
export type Chats = { flags: Record<string, string[]>; found: string[]; models: Record<string, Model[]>; active: string; hint: boolean; menu: boolean; confirm: boolean; chats: Record<string, Chat> }

declare module 'claude-code' {
  interface PluginState {
    call: { chats: Chats }
  }
}
