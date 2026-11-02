export type Turn = { who: 'user' | 'ai'; text: string }
// one conversation per CLI; `sid` is the id the CLI itself uses to continue it ('' before the first answer)
export type Chat = { sid: string; turns: Turn[]; reply: string; running: boolean; error: string }
export type Chats = { found: string[]; active: string; hint: boolean; chats: Record<string, Chat> }

declare module 'claude-code' {
  interface PluginState {
    call: { chats: Chats }
  }
}
