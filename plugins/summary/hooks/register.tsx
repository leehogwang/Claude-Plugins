import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Summary } from '../types'

const PANE = 'summary'
const summary = atom({ plugin: 'summary', key: 'summary' } as const, { mtime: 0, text: '' } as Summary)
const busy = atom({ plugin: 'summary', key: 'busy' } as const, false)
const error = atom({ plugin: 'summary', key: 'error' } as const, '')

// label colours: goal and now stand out, what is open warns
const LABEL: Record<string, string> = {
  목표: 'magenta', Goal: 'magenta', '한 일': 'green', Done: 'green', 결정: 'blue', Decisions: 'blue',
  지금: 'yellow', Now: 'yellow', '기억할 것': 'cyan', Remember: 'cyan', '남은 일': 'red', Open: 'red', '할 일': '#ff9e64', Todo: '#ff9e64', 파일: 'gray', Files: 'gray',
}

const WIDE = 12 // the label column
const colorOf = (label: string, k: number) =>
  Object.entries(LABEL).find(([name]) => label.includes(name))?.[1] ?? (k % 2 ? 'yellow' : 'cyan')

// "목표: …" starts an entry; a line without a label continues the one before
function entries(text: string) {
  const NAME = '[^:：*·\\n]{1,24}?'
  const out: { label: string; lines: string[] }[] = []
  const lines = text
    // one long line with " · Label: " between entries: an entry per line
    .replace(new RegExp(`\\s+·\\s+(?=\\**${NAME}\\**\\s*[:：])`, 'g'), '\n')
    // "1. a 2. b" inside an entry: items per line
    .replace(/\s+(?=\d{1,2}\.\s)/g, '\n')
    .split('\n')
  for (const raw of lines) {
    if (!raw.trim()) continue
    const m = new RegExp(`^\\s*[-*•]?\\s*\\**(${NAME})\\**\\s*[:：]\\s*(.*)$`).exec(raw)
    const isItem = /^\s*([-*•]|\d{1,2}\.)\s/.test(raw)
    if (m && !isItem) {
      const label = m[1]!.split('/')[0]!.trim() // "목표/Goal" → "목표"
      out.push({ label, lines: m[2] ? [m[2]] : [] })
    } else {
      const line = raw.replace(/^\s*([-*•]|\d{1,2}\.)\s*/, '• ').trim()
      if (out.length) out.at(-1)!.lines.push(line)
      else out.push({ label: '', lines: [line] })
    }
  }
  return out
}

const SYSTEM = `You keep a running summary of a Claude Code session for the person having it, so they see where it stands and what they would otherwise forget.
You get the conversation (or the current summary plus the part of the conversation that came after it). Answer with the complete, updated summary only.

Write in the language the USER lines are mostly in, labels included (Korean conversation: Korean labels). Put each entry on its own line: the label, a colon, then text; list items go on the following lines, each starting with "- ". Use these entries, in this order, leaving out any that has nothing:
- Goal (목표): what they set out to do, and how it changed
- Done (한 일): every distinct thing that got done, in order, one item each
- Decisions (결정): every choice made and why
- Now (지금): what is in progress or was last asked
- Open (남은 일): what is unfinished or broken
- Todo (할 일): every approach, fix or idea that either side proposed ("we could…", "원하시면…", "이렇게 할까요?") and that was never built and never turned down, one item each, saying who proposed it; drop one once it is built or declined
- Remember (기억할 것): what they will need later and could forget: settings or files changed and where, commands made and how to use them, steps needed for something to take effect (a restart, a reload), how a thing works when it was explained
  Also keep every answer to a question the user asked about how something behaves ("does X run by itself?", "is Y only on command?", "does Z apply to this project too?") as "question → answer", even when nothing was changed and it was only said in chat: those answers are exactly what they forget, and they decide how they use what was built
- Files (파일): the files touched

Example of the shape (Korean conversation):
목표: 모델 구조를 패널에 그리는 mod
한 일:
- **입력별 줄** 레이아웃
- 스크롤바 추가
할 일:
- 분석 결과 캐시 (Claude 제안)

Do not drop anything from the current summary that is still true; correct what the new part changed. Lines "ran in their terminal" and "its output" are the person's own commands and what they printed: when one finishes something listed under Open, Todo or Now (it ran and printed no error), move it to Done and take it off the others; when it failed, say it failed and keep it open.
Mark the few key terms of each line (names, commands, paths, numbers) with **bold** or \`code\`.
Highlight with ==double equals== a SHORT phrase (3 to 12 words, never a whole line or sentence, never a command or path) in each entry that has something the person must not miss: a decision that changes how they work, the answer to a question they asked ("does X run by itself?"), a step still needed before something works (a restart), a risk or something broken. Aim for 3 to 6 highlights in the whole summary, drop a highlight once its point is settled, and never put one inside \`code\` or **bold**. Example: 남은 일: - agy-bridge ==아직 제거 안 됨==, 아래 명령을 직접 실행
Use only what the transcript shows; do not invent.`

// The summary so far, brought up to date: only the part of the conversation since it was made goes to
// Haiku (a long part in chunks, each folded into the summary in turn). Nothing changed: no call at all.
async function summarize($: EngineInterface) {
  await update($, busy, () => true)
  await update($, error, () => '')
  try {
    const id = await $.session.id()
    const key = `summary:v10:${id}`
    const kept = (await $.store.get(key)) as Summary | undefined
    const r = await $.process.run(['python3', `${$.plugin.root}/hooks/extract.py`, id, String(kept?.records ?? 0)], { timeoutMs: 60_000 })
    if (r.exitCode !== 0) {
      if (r.stderr.includes('no transcript')) throw new Error('Nothing to summarize yet: this session has no conversation saved.')
      throw new Error(r.stderr.trim().split('\n').slice(-3).join('\n'))
    }
    const cut = r.stdout.indexOf('\n')
    const head = JSON.parse(cut < 0 ? r.stdout : r.stdout.slice(0, cut)) as { mtime: number; records: number; chunks: number }
    const chunks = head.chunks ? r.stdout.slice(cut + 1).split('\f') : []
    let text = kept?.text ?? ''
    const tokens = { in: 0, out: 0 }
    for (const chunk of chunks) {
      const prompt = text ? `CURRENT SUMMARY:\n${text}\n\nTHE CONVERSATION SINCE:\n${chunk}` : `THE CONVERSATION:\n${chunk}`
      const reply = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 4000 })
      if (!reply.isAnswered) throw new Error(`Haiku gave no summary (${reply.reason})`)
      const u = reply.usage
      tokens.in += u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      tokens.out += u.output_tokens
      text = reply.text.trim()
    }
    const made: Summary = { mtime: head.mtime, records: head.records, text, tokens: chunks.length ? tokens : { in: 0, out: 0 } }
    await $.store.set(key, made)
    await update($, summary, () => made)
  } catch (err) {
    await update($, error, () => String(err))
  } finally {
    await update($, busy, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'summary', description: 'Summarize this session so far (one Haiku call; none if nothing changed)' })
    // it was open when the last session ended: open again, with the summary kept for this session
    if (await $.store.get('open')) {
      const kept = (await $.store.get(`summary:v10:${await $.session.id()}`)) as Summary | undefined
      if (kept) await update($, summary, () => kept)
      await $.ui.open({ id: PANE, title: 'This session' })
    }
    return next(e)
  })

  // closed by hand (or by a plugin): not open again next time; an unload at exit does not count
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await $.store.set('open', false)
    return next(e)
  })

  on('command.run', { command: 'summary' }, async $ => {
    await $.ui.open({ id: PANE, title: 'This session' })
    await $.store.set('open', true)
    void summarize($) // in the background: the command returns at once, the pane fills in when Haiku is done
    return { text: 'Summarizing in the Summary pane…' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, summary)
    const failed = await read($, error)
    return (
      <Box flexDirection="column">
        {(await read($, busy)) && <Text dimColor>⟳ Haiku is reading this session…</Text>}
        {failed ? <Text color="red">{failed}</Text> : null}
        {entries(s.text).map(({ label, lines }, k) => (
          // the label in a fixed column; the text wraps (and continues) in the column beside it
          <Box flexDirection="row" marginBottom={1}>
            <Box width={WIDE} flexShrink={0}>
              {label && <Text bold color={colorOf(label, k)}>{label}</Text>}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {lines.map(line => (
                <Text>
                  {line.split(/(==[^=]+==|\*\*[^*]+\*\*|`[^`]+`)/).map(part =>
                    part.startsWith('==') && part.endsWith('==') && part.length > 4 ? (
                      <Text backgroundColor="#ff79c6" color="black">{part.slice(2, -2)}</Text>
                    ) : part.startsWith('**') && part.endsWith('**') ? (
                      <Text bold color="yellow">{part.slice(2, -2)}</Text>
                    ) : part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
                      <Text color="yellow">{part.slice(1, -1)}</Text>
                    ) : (
                      <Text>{part}</Text>
                    ),
                  )}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
        {s.mtime > 0 && (
          <Text dimColor>
            {`as of ${new Date(s.mtime).toLocaleString()}`}
            {s.tokens?.in ? ` · this update: Haiku ${s.tokens.in.toLocaleString()} in / ${s.tokens.out.toLocaleString()} out tokens` : ' · up to date, no call'}
            {' · /summary again to refresh'}
          </Text>
        )}
      </Box>
    )
  })
}
