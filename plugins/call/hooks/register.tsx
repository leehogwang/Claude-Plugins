import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chat, Chats } from '../types'

// /call lists the AI CLIs installed here and opens one in a side pane. Like see-parent, the pane is a
// chat: each message runs one non-interactive turn of that CLI (`claude -p`, `codex exec`, ...) in the
// folder this session works in, and the next message continues the same conversation by its id.
// Every CLI keeps its own chat and runs on its own, so you can start one, switch to another, and come back.

const PANE = 'call'
const CLIS = ['claude', 'codex', 'agy', 'opencode'] // ponytail: fixed list, add a CLI = one line here + one case in argv() and parse()
const SHOWN = 40 // the latest messages drawn

const state = atom({ plugin: 'call', key: 'chats' } as const, { found: [], active: '', hint: false, chats: {} } as Chats)
const blank: Chat = { sid: '', turns: [], reply: '', running: false, error: '' }

const patch = ($: EngineInterface, cli: string, f: (c: Chat) => Chat) =>
  update($, state, s => ({ ...s, chats: { ...s.chats, [cli]: f(s.chats[cli] ?? blank) } }))

const uuid = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16))

// The command for one turn. claude takes the id up front; the others tell it in their output (see parse).
function argv(cli: string, sid: string, text: string): string[] {
  // yolo: no approval prompts, since a turn here has nobody to answer them (a choice the owner made on purpose)
  switch (cli) {
    case 'claude': return sid ? ['claude', '-p', '--dangerously-skip-permissions', '--resume', sid, text] : ['claude', '-p', '--dangerously-skip-permissions', '--session-id', uuid(), text]
    case 'codex': return sid ? ['codex', 'exec', 'resume', '--dangerously-bypass-approvals-and-sandbox', '--json', sid, text] : ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--json', text]
    case 'opencode': return sid ? ['opencode', 'run', '--auto', '--format', 'json', '-s', sid, text] : ['opencode', 'run', '--auto', '--format', 'json', text]
    default: return sid ? ['agy', '-p', text, '--dangerously-skip-permissions', '--output-format', 'json', '--conversation', sid] : ['agy', '-p', text, '--dangerously-skip-permissions', '--output-format', 'json']
  }
}

// What to type in a terminal to carry on the same conversation there, with every feature of the CLI.
function resumeCmd(cli: string, sid: string) {
  return { claude: `claude --resume ${sid}`, codex: `codex resume ${sid}`, opencode: `opencode -s ${sid}`, agy: `agy --conversation ${sid}` }[cli] ?? ''
}

const json = (line: string): any => { try { return JSON.parse(line) } catch { return undefined } }

// The answer and the conversation id out of what a CLI printed so far (it may stop mid-line).
function parse(cli: string, out: string): { text: string; sid: string; error: string } {
  if (cli === 'claude') return { text: out.trim(), sid: '', error: '' }
  if (cli === 'agy') {
    const r = json(out.trim())
    return r ? { text: String(r.response ?? '').trim(), sid: r.conversation_id ?? '', error: r.status && r.status !== 'SUCCESS' ? String(r.status) : '' } : { text: '', sid: '', error: '' }
  }
  const texts: string[] = []
  let sid = ''
  for (const e of out.split('\n').map(json)) {
    if (!e) continue
    if (cli === 'codex') {
      sid = e.thread_id ?? sid
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') texts.push(e.item.text)
    } else {
      sid = e.sessionID ?? sid
      if (e.type === 'text') texts.push(e.part?.text ?? '')
    }
  }
  return { text: texts.join('\n\n').trim(), sid, error: '' }
}

async function find($: EngineInterface) {
  const hits = await Promise.all(CLIS.map(async c => ((await $.process.run(['which', c]).catch(() => ({ exitCode: 1 }))).exitCode === 0 ? c : '')))
  const found = hits.filter(Boolean)
  await update($, state, s => ({ ...s, found, active: found.includes(s.active) ? s.active : (found[0] ?? '') }))
  return found
}

async function send($: EngineInterface, text: string) {
  const s = await read($, state)
  const cli = s.active
  const chat = s.chats[cli] ?? blank
  if (!cli || !text.trim() || chat.running) return
  await patch($, cli, c => ({ ...c, running: true, error: '', reply: '', turns: [...c.turns, { who: 'user', text }] }))
  try {
    const cmd = argv(cli, chat.sid, text)
    const child = $.process.spawn({ argv: cmd })
    let out = ''
    let err = ''
    const pieces = child[Symbol.asyncIterator]()
    for (let step = await pieces.next(); ; step = await pieces.next()) {
      if (step.done) {
        if (step.value.code !== 0) throw new Error(err.trim().split('\n').slice(-3).join('\n') || `exited ${step.value.code}`)
        break
      }
      if (step.value.stream === 'stdout') {
        out += step.value.text
        const live = parse(cli, out).text
        await patch($, cli, c => ({ ...c, reply: live }))
      } else err += step.value.text
    }
    const done = parse(cli, out)
    if (done.error) throw new Error(done.error)
    const sid = cli === 'claude' ? (chat.sid || cmd[cmd.indexOf('--session-id') + 1] || '') : done.sid || chat.sid
    await patch($, cli, c => ({ ...c, sid, reply: '', turns: [...c.turns, { who: 'ai', text: done.text || '(no answer)' }] }))
  } catch (e) {
    await patch($, cli, c => ({ ...c, reply: '', error: String(e) }))
  } finally {
    await patch($, cli, c => ({ ...c, running: false }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'call', description: 'Pick an installed AI CLI (claude, codex, agy, opencode) and talk to it in a side pane (/call <name> opens it directly)' })
    return next(e)
  })

  on('command.run', { command: 'call' }, async ($, e) => {
    const found = await find($)
    if (!found.length) return { text: `No AI CLI found (looked for ${CLIS.join(', ')}).` }
    const want = e.args.trim()
    if (want && !found.includes(want)) return { text: `${want} is not installed here. Installed: ${found.join(', ')}.` }
    if (want) await update($, state, s => ({ ...s, active: want }))
    await $.ui.open({ id: PANE, title: 'Call' })
    return { text: `Call pane open. Installed: ${found.join(', ')}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const s = await read($, state)
    const cli = s.active
    const chat = s.chats[cli] ?? blank
    const turns = chat.turns.slice(-SHOWN)
    const mark = (c: string) => (s.chats[c]?.running ? ' ⟳' : '')
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {s.found.map(c => (
            <Button key={`tab-${c}`} label={c === cli ? `[${c}]${mark(c)}` : `${c}${mark(c)}`} plain dimColor={c !== cli} onPress={() => update($, state, v => ({ ...v, active: c, hint: false }))} />
          ))}
          {chat.sid && <Button key="terminal" label="터미널에서 열기" plain dimColor onPress={() => update($, state, v => ({ ...v, hint: !v.hint }))} />}
        </Box>
        {s.hint && chat.sid ? <Text color="yellow">{resumeCmd(cli, chat.sid)}</Text> : null}
        {!cli && <Text dimColor>/call 로 설치된 AI를 찾습니다.</Text>}
        {chat.turns.length > SHOWN && <Text dimColor>{`… ${chat.turns.length - SHOWN} earlier messages`}</Text>}
        {turns.map(t => (
          <Box flexDirection="row" marginTop={1}>
            <Box width={4} flexShrink={0}>
              <Text bold color={t.who === 'user' ? 'cyan' : 'green'}>{t.who === 'user' ? '나' : cli[0]!.toUpperCase()}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text>{t.text}</Text>
            </Box>
          </Box>
        ))}
        {chat.running && (
          <Box flexDirection="row" marginTop={1}>
            <Box width={4} flexShrink={0}>
              <Text bold color="green">{cli[0]!.toUpperCase()}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor>{chat.reply || `⟳ ${cli} 작업 중…`}</Text>
            </Box>
          </Box>
        )}
        {chat.error ? <Text color="red">{chat.error}</Text> : null}
        {cli && 'Input' in ui && (
          <Box marginTop={1}>
            <ui.Input key="ask" placeholder={chat.running ? `${cli}가 답하는 중…` : `${cli}에게 보내기 (Enter)`} submitLabel="보내기" onSubmit={(text: string) => send($, text)} />
          </Box>
        )}
      </Box>
    )
  })
}
