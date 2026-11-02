import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chat, Chats, Model } from '../types'

// /call lists the AI CLIs installed here and opens one in a side pane. Like see-parent, the pane is a
// chat: each message runs one non-interactive turn of that CLI (`claude -p`, `codex exec`, ...) in the
// folder this session works in, and the next message continues the same conversation by its id.
// Every CLI keeps its own chat and runs on its own, so you can start one, switch to another, and come back.

const PANE = 'call'
const CLIS = ['claude', 'codex', 'agy', 'opencode'] // ponytail: fixed list, add a CLI = one line here + one case in argv() and parse()
const SHOWN = 40 // the latest messages drawn

const state = atom({ plugin: 'call', key: 'chats' } as const, { flags: {}, found: [], models: {}, active: '', hint: false, menu: false, chats: {} } as Chats)
const blank: Chat = { sid: '', seen: 0, model: '', effort: '', draft: '', turns: [], steps: [], running: false, unread: false, error: '' }

const patch = ($: EngineInterface, cli: string, f: (c: Chat) => Chat) =>
  update($, state, s => ({ ...s, chats: { ...s.chats, [cli]: f(s.chats[cli] ?? blank) } }))

const uuid = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16))

const EFFORTS: Record<string, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
  opencode: ['minimal', 'high', 'max'], // opencode calls it a model "variant"
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
}

// --model and the effort flag, which each CLI spells its own way ('' leaves the CLI's default).
// agy has no separate effort for a chosen model: its model ids end in -low/-medium/-high, so the two are joined here.
function opts(cli: string, model: string, effort: string, allowed: string[]): string[] {
  if (cli === 'agy' && model) return ['--model', `${model}-${effort || (allowed.includes('medium') ? 'medium' : allowed[0] ?? 'medium')}`]
  const m = model ? [cli === 'codex' || cli === 'opencode' ? '-m' : '--model', model] : []
  const e = !effort ? [] : cli === 'codex' ? ['-c', `model_reasoning_effort="${effort}"`] : cli === 'opencode' ? ['--variant', effort] : ['--effort', effort]
  return [...m, ...e]
}

// the efforts to offer: the chosen model's own (agy), else the CLI's
const effortsFor = (cli: string, models: Model[], model: string) => models.find(m => m.id === model)?.efforts.length ? models.find(m => m.id === model)!.efforts : EFFORTS[cli] ?? []

// The command for one turn. claude takes the id up front; the others tell it in their output (see parse).
function argv(cli: string, sid: string, text: string, o: string[]): string[] {
  // yolo: no approval prompts, since a turn here has nobody to answer them (a choice the owner made on purpose)
  switch (cli) {
    case 'claude': return sid ? ['claude', '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', ...o, '--resume', sid, text] : ['claude', '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', ...o, '--session-id', uuid(), text]
    case 'codex': return sid ? ['codex', 'exec', 'resume', '--dangerously-bypass-approvals-and-sandbox', ...o, '--json', sid, text] : ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', ...o, '--json', text]
    case 'opencode': return sid ? ['opencode', 'run', '--auto', ...o, '--format', 'json', '-s', sid, text] : ['opencode', 'run', '--auto', ...o, '--format', 'json', text]
    default: return sid ? ['agy', '-p', text, '--dangerously-skip-permissions', ...o, '--output-format', 'stream-json', '--conversation', sid] : ['agy', '-p', text, '--dangerously-skip-permissions', ...o, '--output-format', 'stream-json']
  }
}

// The models a CLI offers, asked once and kept. agy lists one row per effort ("gemini-3.8-flash-low", "-medium", ...):
// those are folded into one model whose efforts are the suffixes.
async function modelsOf($: EngineInterface, cli: string): Promise<Model[]> {
  const known = (await read($, state)).models[cli]
  if (known) return known
  let list: Model[] = []
  const plain = (ids: string[]) => ids.map(id => ({ id, label: id, efforts: [] }))
  if (cli === 'claude') list = plain(['opus', 'sonnet', 'haiku'])
  else {
    const r = await $.process.run(cli === 'codex' ? ['codex', 'debug', 'models'] : [cli, 'models'], { timeoutMs: 60_000 }).catch(() => undefined)
    if (r?.exitCode === 0) {
      if (cli === 'codex') list = plain(((json(r.stdout)?.models ?? []) as { slug: string; visibility?: string }[]).filter(m => m.visibility === 'list').map(m => m.slug))
      else if (cli === 'opencode') list = plain(r.stdout.split('\n').map(l => l.trim()).filter(l => l && !l.includes(' ')))
      else
        for (const line of r.stdout.split('\n')) {
          const [id = '', label = id] = line.split('\t').map(x => x.trim())
          const tail = /-(low|medium|high|xhigh|max)$/.exec(id)
          if (!id || id.includes(' ') || !tail) continue
          const base = id.slice(0, -tail[0].length)
          const found = list.find(m => m.id === base)
          if (found) found.efforts.push(tail[1]!)
          else list.push({ id: base, label: label.replace(/\s*\([^)]*\)\s*$/, ''), efforts: [tail[1]!] })
        }
      for (const m of list) m.efforts.sort((a, b) => EFFORTS.agy!.indexOf(a) - EFFORTS.agy!.indexOf(b))
    }
  }
  await update($, state, s => ({ ...s, models: { ...s.models, [cli]: list } }))
  return list
}

// What to type in a terminal to carry on the same conversation there, with every feature of the CLI.
function resumeCmd(cli: string, sid: string) {
  return { claude: `claude --resume ${sid}`, codex: `codex resume ${sid}`, opencode: `opencode -s ${sid}`, agy: `agy --conversation ${sid}` }[cli] ?? ''
}

// effort runs from light red to a deeper (not dark) red
const RED = ['#ffb4b4', '#ff6e6e', '#e5484d']
function ramp(stops: string[], t: number) {
  const p = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(p))
  const [a, b] = [stops[i]!, stops[i + 1]!].map(h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)))
  return '#' + a!.map((v, k) => Math.round(v + (b![k]! - v) * (p - i)).toString(16).padStart(2, '0')).join('')
}

const json = (line: string): any => { try { return JSON.parse(line) } catch { return undefined } }

// Flags on the files agents are changing, set as their steps stream in and lifted when their turn ends, so
// that the pane shows who is on which file, warns when two are on the same one, and the Claude Code session
// itself is kept off a flagged file. An agent's own write cannot be stopped from here (it is another process).
const TOUCHES = /edit|write|replace|patch|create|apply/i // tool names that change a file
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const pathOf = (o: any): string => String(o?.file_path ?? o?.filePath ?? o?.notebook_path ?? o?.TargetFile ?? o?.target_file ?? o?.Path ?? o?.path ?? '')

const hold = ($: EngineInterface, who: string, files: string[]) =>
  update($, state, s => {
    const flags = { ...s.flags }
    for (const f of files) if (!flags[f]?.includes(who)) flags[f] = [...(flags[f] ?? []), who]
    return { ...s, flags }
  })

const free = ($: EngineInterface, who: string) =>
  update($, state, s => {
    const flags: Record<string, string[]> = {}
    for (const [f, w] of Object.entries(s.flags)) if (w.some(x => x !== who)) flags[f] = w.filter(x => x !== who)
    return { ...s, flags }
  })

const short = (p: string) => p.split('/').slice(-2).join('/')

// The pane is narrower than a terminal, so a wide table wraps into a mess. Tables that do not fit (markdown pipes, or box
// drawing like ┌─┬─┐) are turned into a list: one item per row, one sub-item per column.
let columns = 60 // the pane's width, as the last render saw it
const wide = (t: string) => [...t.replace(/\*\*|`/g, '')].reduce((w, c) => w + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0)
const listOf = (head: string[], rows: string[][]) =>
  rows.map(r => [`- **${r[0] || '·'}**`, ...r.slice(1).map((c, i) => (c && c !== '-' ? `  - ${head[i + 1] || '·'}: ${c}` : '')).filter(Boolean)].join('\n')).join('\n')
// a pane opens at its top; once it has drawn, go to the end where the latest message and the input are
const atBottom = ($: { ui: { scroll: (a: { in: string; to: "end" }) => unknown } }) => {
  for (const ms of [400, 1500]) setTimeout(() => { try { void Promise.resolve($.ui.scroll({ in: PANE, to: 'end' })).catch(() => {}) } catch {} }, ms)
}

// Math in an answer ($...$ and $$...$$ LaTeX) can't be drawn in a terminal: it becomes plain Unicode (\frac{1}{3} -> 1/3, \times -> ×).
const TEX: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', infty: '∞', sum: '∑', prod: '∏', in: '∈', ldots: '…', cdots: '…', sim: '∼',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω', tau: 'τ', eta: 'η', Delta: 'Δ', Sigma: 'Σ',
}
function tex(m: string): string {
  const wrap = (x: string) => (/^[\w.]+$/.test(x) ? x : `(${x})`)
  for (let prev = ''; prev !== m; ) {
    prev = m
    m = m.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${wrap(a)}/${wrap(b)}`).replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a) => `√${wrap(a)}`).replace(/\\(?:mathbf|mathrm|mathit|text|textbf|operatorname|boldsymbol|mathcal)\s*\{([^{}]*)\}/g, '$1')
  }
  return m
    .replace(/\\(left|right|big|Big)\b\s*/g, '')
    .replace(/\\([A-Za-z]+)/g, (all, w: string) => TEX[w] ?? w)
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\^\{?(\d)\}?/g, (_, d: string) => SUP[+d]!)
    .replace(/[_^]\{([^{}]*)\}/g, (all, a: string) => (all[0] === '_' ? `_${a}` : `^${a}`))
    .replace(/[{}]/g, '')
}
function texAll(text: string): string {
  // leave code alone: split on fences and inline code, convert only the rest
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => tex(m))
    .replace(/\$(?!\s)([^$\n]*?[\\_^{=<>][^$\n]*?)(?<!\s)\$/g, (_, m) => tex(m))
    .replace(/\*\*([^*\n]*?[^\p{L}\p{N}*\s])\*\*(?=[\p{L}\p{N}])/gu, '**$1** ')).join('')
}

function fitTables(text: string, cols: number): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    if (/^\s*\|/.test(lines[i]!) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) { // markdown table
      let j = i + 2
      while (j < lines.length && /^\s*\|/.test(lines[j]!)) j++
      const [head, ...rows] = [row(lines[i]!), ...lines.slice(i + 2, j).map(row)]
      const w = head!.map((_, c) => Math.max(...[head!, ...rows].map(r => wide(r[c] ?? '')))).reduce((a, b) => a + b + 3, 1)
      out.push(...(w <= cols ? lines.slice(i, j) : listOf(head!, rows).split('\n')))
      i = j
    } else if (/^\s*[┌├└│]/.test(lines[i]!)) { // box drawing: records split by ├ lines, cells by │
      let j = i
      while (j < lines.length && /^\s*[┌├└│]/.test(lines[j]!)) j++
      const block = lines.slice(i, j)
      if (Math.max(...block.map(l => wide(l.trimEnd()))) <= cols) out.push(...block)
      else {
        const recs: string[][] = []
        for (const l of block) {
          if (/^\s*[┌├└]/.test(l)) { recs.push([]); continue }
          const cells = l.trim().replace(/^│|│$/g, '').split('│').map(c => c.trim())
          const cur = (recs.at(-1) ?? recs[recs.push([]) - 1]!)
          cells.forEach((c, k) => (cur[k] = [cur[k], c].filter(Boolean).join(' ')))
        }
        const full = recs.filter(r => r.length)
        out.push(...(full.length > 1 ? listOf(full[0]!, full.slice(1)) : listOf([], full)).split('\n')) // a lone record has no header
      }
      i = j
    } else out.push(lines[i++]!)
  }
  return out.join('\n')
}

// what every message to an agent starts with: ask before changing anything, and keep off files others hold
const rules = () => RULES + `Your answer is drawn in a pane about ${columns} columns wide: do not draw tables with box characters (┌│├); keep a markdown table to a few short columns, or use a list. `
const RULES = 'Ground rules from the user: before you change code or files, run a command that changes something, or do anything hard to undo, say what you plan to do and wait for the user\'s go-ahead: end your turn with that question, the next message is the answer. Reading, searching and explaining need no permission. '
const heldBy = (flags: Record<string, string[]>, me: string) => Object.keys(flags).filter(f => flags[f]!.some(w => w !== me))

// one line for a tool call: its command, file or pattern
const brief = (input: unknown) => {
  const o = (input ?? {}) as Record<string, unknown>
  const v = o.command ?? o.CommandLine ?? o.file_path ?? o.Path ?? o.path ?? o.filePath ?? o.pattern ?? o.query ?? o.url ?? Object.values(o).find(x => typeof x === 'string')
  return String(v ?? '').replace(/\s+/g, ' ').slice(0, 100)
}
const tool = (name: string, input: unknown) => `${name}: ${brief(input)}`.replace(/: $/, '')

// What a CLI printed so far (it may stop mid-line), as the answer, its conversation id, an error, and the steps
// on the way (tool calls, and the remarks between them). Each CLI streams its own JSON lines; the answer is the last text.
function parse(cli: string, out: string): { text: string; sid: string; error: string; steps: string[]; files: string[] } {
  const files = new Set<string>() // the files its tool calls change
  const items: { step?: string; text?: string }[] = []
  let sid = ''
  let final = ''
  let error = ''
  const calls = new Set<number>()
  const parts = new Map<number, string>() // agy: the words of each step, in pieces
  for (const e of out.split('\n').map(json)) {
    if (!e) continue
    if (cli === 'claude') {
      sid = e.session_id ?? sid
      if (e.type === 'assistant') for (const b of e.message?.content ?? []) b.type === 'tool_use' ? (items.push({ step: tool(b.name, b.input) }), TOUCHES.test(b.name) && files.add(pathOf(b.input))) : b.type === 'text' && items.push({ text: b.text })
      if (e.type === 'result') [final, error] = [e.result ?? '', e.is_error ? String(e.result) : '']
    } else if (cli === 'codex') {
      sid = e.thread_id ?? sid
      const it = e.item
      if (e.type === 'item.started' && it?.type === 'command_execution') items.push({ step: '$ ' + String(it.command).replace(/^\/bin\/\w+ -lc /, '').replace(/^'(.*)'$/s, '$1').slice(0, 100) })
      else if (e.type === 'item.started' && it?.type === 'mcp_tool_call') items.push({ step: `${it.server}.${it.tool}` })
      else if (e.type === 'item.completed' && it?.type === 'file_change') {
        items.push({ step: 'edit ' + (it.changes ?? []).map((c: { path: string }) => c.path).join(', ').slice(0, 100) })
        for (const c of it.changes ?? []) files.add(c.path)
      }
      else if (e.type === 'item.completed' && it?.type === 'agent_message') items.push({ text: it.text })
      if (e.type === 'turn.failed' || e.type === 'error') error = e.error?.message ?? e.message ?? 'failed'
    } else if (cli === 'opencode') {
      sid = e.sessionID ?? sid
      if (e.type === 'tool_use' && e.part?.state?.status !== 'pending') (items.push({ step: tool(e.part.tool, e.part.state?.input) }), TOUCHES.test(e.part.tool) && files.add(pathOf(e.part.state?.input)))
      else if (e.type === 'text') items.push({ text: e.part?.text ?? '' })
      else if (e.type === 'error') error = e.error?.data?.message ?? e.error?.message ?? 'failed'
    } else {
      const u = e.step_update
      sid = e.conversation_id ?? u?.conversation_id ?? e.result?.conversation_id ?? sid
      if (u?.step_type === 'tool' && u.state === 'ACTIVE' && !calls.has(u.step_index)) {
        calls.add(u.step_index)
        items.push({ step: tool(u.tool_name, u.tool_info?.parameters) })
        if (TOUCHES.test(u.tool_name)) files.add(pathOf(u.tool_info?.parameters))
      } else if (u?.step_type === 'agent_response' && u.text_delta) {
        parts.set(u.step_index, (parts.get(u.step_index) ?? '') + u.text_delta)
        if (u.state === 'DONE') items.push({ text: parts.get(u.step_index)!.trim() })
      }
      if (e.event === 'result') [final, error] = [e.result?.response ?? '', e.result?.status && e.result.status !== 'SUCCESS' ? String(e.result.status) : '']
    }
  }
  const texts = items.filter(i => i.text?.trim())
  const text = (final || texts.at(-1)?.text || '').trim()
  const last = final ? undefined : texts.at(-1) // the remarks before the answer are steps too
  const steps = items.filter(i => i !== last).map(i => i.step ?? '· ' + i.text!.trim().split('\n')[0]!.slice(0, 100)).filter(x => x.trim() !== '·')
  files.delete('')
  return { text, sid, error, steps, files: [...files] }
}

// The chats of this session are kept, so that a session left and entered again finds them (and the ids that
// continue each CLI's own conversation) where they were.
async function keep($: EngineInterface) {
  const s = await read($, state)
  const chats = Object.fromEntries(Object.entries(s.chats).map(([k, c]) => [k, { ...c, running: false, steps: [], draft: '' }]))
  await $.store.set(`chats:${await $.session.id()}`, { active: s.active, chats })
}

async function find($: EngineInterface) {
  const hits = await Promise.all(CLIS.map(async c => ((await $.process.run(['which', c]).catch(() => ({ exitCode: 1 }))).exitCode === 0 ? c : '')))
  const found = hits.filter(Boolean)
  await update($, state, s => ({ ...s, found, active: found.includes(s.active) ? s.active : (found[0] ?? '') }))
  return found
}

// /model and /effort typed in the pane: show the choices, or set one for this CLI's chat ("default" clears it)
async function setting($: EngineInterface, cli: string, what: string, value: string) {
  const say = (t: string) => patch($, cli, c => ({ ...c, error: '', turns: [...c.turns, { who: 'user', text: `/${what}${value ? ` ${value}` : ''}` }, { who: 'ai', text: t }] }))
  const models = await modelsOf($, cli)
  const chat = (await read($, state)).chats[cli] ?? blank
  const names = what === 'model' ? models.map(m => (m.label === m.id ? m.id : `${m.label} (${m.id})`)) : effortsFor(cli, models, chat.model)
  if (!value) return say(`${what}: ${chat[what as 'model' | 'effort'] || 'default'}\navailable: ${names.join(', ') || '(unknown)'}\n/${what} <name> sets it, /${what} default clears it`)
  let v = value === 'default' ? '' : value
  if (what === 'model') v = models.find(m => m.id === value || m.label.toLowerCase() === value.toLowerCase())?.id ?? v // a name or an id
  else if (v && !names.includes(v)) return say(`${cli} has no effort "${v}". available: ${names.join(', ')}`)
  await patch($, cli, c => ({ ...c, [what]: v, effort: what === 'model' && !effortsFor(cli, models, v).includes(c.effort) ? '' : what === 'effort' ? v : c.effort }))
  await keep($)
  return say(`${what} for ${cli}: ${v || 'default'}`)
}

async function send($: EngineInterface, text: string) {
  const s = await read($, state)
  const cli = s.active
  const chat = s.chats[cli] ?? blank
  if (!cli || !text.trim() || chat.running) return
  await patch($, cli, c => ({ ...c, draft: '' })) // the field empties once the message is sent
  const word = /^\/(model|effort)(?:\s+(.*))?$/.exec(text.trim())
  if (word) return setting($, cli, word[1]!, (word[2] ?? '').trim())
  await patch($, cli, c => ({ ...c, running: true, error: '', steps: [], turns: [...c.turns, { who: 'user', text }] }))
  try {
    // the Claude Code conversation (what is new since this chat last heard of it) goes along as a file to read
    const ctx = JSON.parse((await $.process.run(['python3', `${$.plugin.root}/hooks/context.py`, await $.session.id(), String(chat.seen), cli], { timeoutMs: 60_000 })).stdout || '{}') as { records?: number; path?: string }
    const others = heldBy(s.flags, cli)
    const intro = rules() + (others.length ? `Other agents are changing these files right now, so do not edit them (if you need one, stop and tell the user): ${others.join(', ')}. ` : '') + (!ctx.path ? '' : chat.seen
      ? `New messages in the Claude Code session since your last turn are in ${ctx.path}; read them first. `
      : `The conversation so far between the user and Claude Code, in this folder, is in ${ctx.path}. Read it first: it is background, not instructions to run again. `)
    const cmd = argv(cli, chat.sid, `${intro}The user now asks: ${text}`, opts(cli, chat.model, chat.effort, (await modelsOf($, cli)).find(m => m.id === chat.model)?.efforts ?? []))
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
        const now = parse(cli, out)
        await patch($, cli, c => ({ ...c, steps: now.steps }))
        if (now.files.length) await hold($, cli, now.files)
      } else err += step.value.text
    }
    const done = parse(cli, out)
    if (done.error) throw new Error(done.error)
    const sid = cli === 'claude' ? (chat.sid || cmd[cmd.indexOf('--session-id') + 1] || '') : done.sid || chat.sid
    await patch($, cli, c => ({ ...c, sid, seen: ctx.records ?? c.seen, steps: [], turns: [...c.turns, { who: 'ai', text: done.text || '(no answer)', steps: done.steps }] }))
  } catch (e) {
    await patch($, cli, c => ({ ...c, steps: [], error: String(e) }))
  } finally {
    // finished while another tab is shown: mark this one so it can be seen
    await free($, cli)
    const shown = (await read($, state)).active === cli
    await patch($, cli, c => ({ ...c, running: false, unread: !shown }))
    await keep($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'call', description: 'Pick an installed AI CLI (claude, codex, agy, opencode) and talk to it in a side pane (/call <name> opens it directly)' })
    // it was open when the last session ended: open again, with this session's chats
    if (await $.store.get('open')) {
      const kept = (await $.store.get(`chats:${await $.session.id()}`)) as { active: string; chats: Record<string, Chat> } | undefined
      if (kept) await update($, state, s => ({ ...s, active: kept.active, chats: kept.chats }))
      await find($)
      await $.ui.open({ id: PANE, title: 'Call' })
    atBottom($)
      void modelsOf($, (await read($, state)).active)
    }
    return next(e)
  })

  // closed by hand (or by a plugin): not open again next time; an unload at exit does not count
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await $.store.set('open', false)
    return next(e)
  })

  // the Claude Code session keeps off a file an agent here holds, and flags the files it changes itself
  on('tool.call', async ($, e, next) => {
    const file = EDIT_TOOLS.has(e.tool) ? pathOf(e) : ''
    if (file) {
      const owners = ((await read($, state)).flags[file] ?? []).filter(w => w !== 'main')
      if (owners.length) return { deny: `${file} is being changed by ${owners.join(', ')} in the /call pane right now. Wait until they are done, or ask the user.` }
      await hold($, 'main', [file])
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await free($, 'main')
    return next(e)
  })

  on('command.run', { command: 'call' }, async ($, e) => {
    const found = await find($)
    if (!found.length) return { text: `No AI CLI found (looked for ${CLIS.join(', ')}).` }
    const want = e.args.trim()
    if (want && !found.includes(want)) return { text: `${want} is not installed here. Installed: ${found.join(', ')}.` }
    if (want) await update($, state, s => ({ ...s, active: want }))
    await patch($, (await read($, state)).active, c => ({ ...c, unread: false }))
    await $.ui.open({ id: PANE, title: 'Call' })
    atBottom($)
    await $.store.set('open', true)
    void modelsOf($, (await read($, state)).active) // for the model list
    return { text: `Call pane open. Installed: ${found.join(', ')}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    columns = e.props.bodyColumns
    const { Box, Button, Markdown, Text } = ui
    const s = await read($, state)
    const cli = s.active
    const chat = s.chats[cli] ?? blank
    const turns = chat.turns.slice(-SHOWN)
    const mark = (c: string) => (s.chats[c]?.running ? ' ⟳' : '')
    return (
      <Box flexDirection="column" minHeight={e.props.scroll?.bodyRows}>
        <Box flexDirection="row" columnGap={1}>
          {s.found.map(c => {
            const new_ = c !== cli && s.chats[c]?.unread // an answer came in while another tab was shown: yellow
            const label = `${c === cli ? `[${c}]` : c}${mark(c)}`
            return (
              <Button key={`tab-${c}`} label={new_ ? undefined : label} plain dimColor={c !== cli && !new_} onPress={() => { void modelsOf($, c); return update($, state, v => ({ ...v, active: c, hint: false, menu: false, chats: { ...v.chats, [c]: { ...(v.chats[c] ?? blank), unread: false } } })) }}>
                {new_ ? <Text backgroundColor="yellow" color="black">{label}</Text> : undefined}
              </Button>
            )
          })}
          {chat.sid && <Button key="terminal" label="Open in terminal" plain dimColor onPress={() => update($, state, v => ({ ...v, hint: !v.hint }))} />}
          <Box flexGrow={1} />
          <Button key="to-end" label="▼" plain dimColor onPress={() => $.ui.scroll({ in: PANE, to: 'end' })} />
        </Box>
        {Object.entries(s.flags).slice(0, 8).map(([p, who]) => (
          <Text color={who.length > 1 ? 'red' : 'yellow'}>{who.length > 1 ? `⚠ ${short(p)}  ${who.join(' + ')} are changing it at once` : `✎ ${short(p)}  ${who[0]}`}</Text>
        ))}
        {s.hint && chat.sid ? <Text color="yellow">{resumeCmd(cli, chat.sid)}</Text> : null}
        {!cli && <Text dimColor>Run /call to find the installed AIs.</Text>}
        {chat.turns.length > SHOWN && <Text dimColor>{`… ${chat.turns.length - SHOWN} earlier messages`}</Text>}
        {turns.map((t, k) => {
          const at = chat.turns.length - turns.length + k
          return (
            <Box flexDirection="row" marginTop={1} backgroundColor={t.who === 'user' ? '#3a3a3a' : undefined}>
              <Box width={4} flexShrink={0}>
                <Text bold color={t.who === 'user' ? 'cyan' : 'green'}>{t.who === 'user' ? 'You' : cli[0]!.toUpperCase()}</Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                {t.steps?.length ? (
                  <Button key={`steps-${at}`} label={`${t.open ? '▾' : '▸'} ${t.steps.length} step${t.steps.length > 1 ? 's' : ''}`} plain dimColor onPress={() => patch($, cli, c => ({ ...c, turns: c.turns.map((x, i) => (i === at ? { ...x, open: !x.open } : x)) }))} />
                ) : null}
                {t.open && t.steps?.map(x => <Text dimColor>{`  ${x}`}</Text>)}
                {t.who === 'ai' ? <Markdown text={fitTables(texAll(t.text), columns - 6)} /> : <Text>{t.text}</Text>}
              </Box>
            </Box>
          )
        })}
        {chat.running && (
          <Box flexDirection="row" marginTop={1}>
            <Box width={4} flexShrink={0}>
              <Text bold color="green">{cli[0]!.toUpperCase()}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {chat.steps.slice(-10).map(x => <Text dimColor>{`  ${x}`}</Text>)}
              <Text dimColor>{`⟳ ${cli} is working…`}</Text>
            </Box>
          </Box>
        )}
        {chat.error ? <Text color="red">{chat.error}</Text> : null}
        <Box flexGrow={1} />{/* a short chat leaves the room here, so the controls and the input stay at the bottom */}
        {cli && (() => {
          const models = s.models[cli] ?? []
          const levels = effortsFor(cli, models, chat.model)
          const lv = Math.max(0, levels.indexOf(chat.effort || 'medium')) // none chosen yet: shown on medium (the CLI's own default is used until one is picked)
          const color = ramp(RED, levels.length > 1 ? lv / (levels.length - 1) : 0)
          const step = (d: number) => patch($, cli, c => ({ ...c, effort: levels[Math.max(0, Math.min(levels.length - 1, lv + d))] ?? c.effort })).then(() => keep($))
          return (
            <Box flexDirection="column">
              {s.menu ? (
                <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                  {[{ id: '', label: 'default' }, ...models].map(m => (
                    <Button
                      key={`m:${m.id}`}
                      label={`${m.id === chat.model ? '●' : '○'} ${m.label}`}
                      plain
                      dimColor={m.id !== chat.model}
                      onPress={() => update($, state, v => ({ ...v, menu: false })).then(() => patch($, cli, c => ({ ...c, model: m.id, effort: effortsFor(cli, models, m.id).includes(c.effort) ? c.effort : '' }))).then(() => keep($))}
                    />
                  ))}
                </Box>
              ) : (
              <Box flexDirection="row" columnGap={1}>
                <Box flexGrow={1} />
                <Button key="model" label={`${models.find(m => m.id === chat.model)?.label ?? (chat.model || 'default')} ▴`} plain onPress={() => update($, state, v => ({ ...v, menu: !v.menu }))} />
                <Button key="effort-prev" label="◀" plain dimColor={lv <= 0} onPress={() => step(-1)} />
                <Box width={7} flexShrink={0} justifyContent="center">
                  <Text bold color={color}>{levels[lv] ?? ''}</Text>
                </Box>
                <Button key="effort-next" label="▶" plain dimColor={lv >= levels.length - 1} onPress={() => step(1)} />
                <Button key="clear" label="clear" plain dimColor onPress={() => patch($, cli, c => ({ ...blank, model: c.model, effort: c.effort })).then(() => keep($))} />
              </Box>
              )}
            </Box>
          )
        })()}
        <Box flexDirection="row" backgroundColor="#3a3a3a">
          {cli && 'Input' in ui && (
            <Box flexGrow={1} flexShrink={1}>
              <ui.Input key="ask" autoFocus rows={2} value={chat.draft} onInput={(v: string) => patch($, cli, c => ({ ...c, draft: v }))} placeholder={chat.running ? `${cli} is answering…` : `Send to ${cli} (Enter)`} submitLabel="send" onSubmit={(text: string) => { void send($, text) }} />
            </Box>
          )}
          <Button key="to-start" label="▲" plain dimColor onPress={() => $.ui.scroll({ in: PANE, to: 'start' })} />
        </Box>
      </Box>
    )
  })
}
