import { expect, mock, test } from 'claude-code/testing'

const j = (...e: unknown[]) => e.map(x => JSON.stringify(x)).join('\n') + '\n'
const OUT: Record<string, string> = {
  codex: j(
    { type: 'thread.started', thread_id: 'cx-1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'I will look.' } },
    { type: 'item.started', item: { type: 'command_execution', command: "/bin/bash -lc 'ls | head -3'" } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/w/train.py', kind: 'update' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: '## codex says hi' } },
  ),
  agy: j(
    { event: 'init', conversation_id: 'ag-1' },
    { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'replace_file_content', tool_info: { parameters: { TargetFile: '/w/train.py' } } } },
    { event: 'result', result: { conversation_id: 'ag-1', status: 'SUCCESS', response: 'agy says hi\n' } },
  ),
  claude: j(
    { type: 'assistant', session_id: 's', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'result', result: 'claude says hi', is_error: false },
  ),
}

function world(on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.store(on)
  const opened: string[] = [] // the panes opened, by id
  on('ui.open', (_$: unknown, e: unknown) => {
    opened.push((e as { id: string }).id)
    return { value: {} as never }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.call', () => ({ result: 'ok' }) as never) // what the tool itself would answer
  on('session.start', (_$: unknown, e: unknown) => ({ cwd: (e as { cwd: string }).cwd }) as never) // core's part of entering a session
  on('command.register', () => ({ value: {} }) as never)
  const state = { records: 7, chars: 100, fail: false }
  on('process.run', (_$: unknown, e: unknown) => {
    const argv = (e as { argv: string[] }).argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'python3' && state.fail) return { value: { exitCode: 1, stdout: '', stderr: 'no transcript for session sess-1', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'python3') return ok(JSON.stringify({ records: state.records, path: argv[4] === 'claude' && argv[3] !== '0' ? '' : `/ctx/${argv[4]}-${argv[3]}.md`, diffs: `/ctx/${argv[4]}-${argv[3]}.diff.md`, chars: state.chars, notes: '/ctx/notes.md' }))
    if (argv[0] === 'agy' && argv[1] === 'models') {
      const rows = ['gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)', 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)', 'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)']
      return ok('Fetching available models...\n' + rows.join('\n'))
    }
    return { value: { exitCode: argv[1] === 'opencode' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const spawned: string[][] = []
  const gates: Record<string, Promise<void>> = {} // a CLI named here answers only once its promise is let go
  const holds: Record<string, Promise<void>> = {} // ...and one named here stays mid-turn after its output until released
  on('process.spawn', async function* (_$: unknown, e: unknown) {
    const argv = (e as { argv: string[] }).argv
    spawned.push([...argv])
    await gates[argv[0]!]
    yield { stream: 'stdout', text: OUT[argv[0]!]! }
    await holds[argv[0]!]
    return { value: { code: 0, signal: null } } as never
  } as never)
  return { spawned, gates, holds, state, opened }
}

const mount = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({ plugin: 'call', surface: 'terminal', component: 'Pane', props: { bodyColumns: 80 } as never, requestId: 'call', viewport: { columns: 100, rows: 40 } })
const dump = async (ui: Awaited<ReturnType<typeof mount>>, q: object) => JSON.stringify(await ui.find(q as never))
const prompt = (a: string[]) => a.find(x => x.includes('The user now asks')) ?? ''
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms))

test('/call finds the installed CLIs; each message runs one turn, the next continues the same conversation', async ($, on) => {
  const { spawned, state } = world(on)
  expect((await $.command.run({ command: 'call', args: 'opencode' } as never)).text).toContain('not installed')
  expect((await $.command.run({ command: 'call', args: 'codex' } as never)).text).toContain('claude, codex, agy')
  const ui = await mount($)

  await ui.input({ key: 'ask', text: '안녕' })
  expect(spawned[0]!.slice(0, 5)).toEqual(['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort="medium"'])
  expect(spawned[0]!.at(-1)).toContain('/ctx/codex-0.md')
  expect(spawned[0]!.at(-1)).toContain('The user now asks: 안녕')
  expect(await ui.find({ type: 'Markdown', text: /codex says hi/ })).toBeDefined() // the answer is drawn as markdown
  expect(JSON.stringify(await ui.find({ type: 'Input' } as never))).toContain('"value":""') // the field is empty again after sending

  state.records = 9 // Claude Code went on meanwhile: the next message brings what is new
  await ui.input({ key: 'ask', text: '또' })
  expect(spawned[1]!.slice(0, 5)).toEqual(['codex', 'exec', 'resume', '--dangerously-bypass-approvals-and-sandbox', '-c'])
  expect(spawned[1]).toContain('cx-1')
  expect(spawned[1]!.at(-1)).toContain('The new messages')
  expect(spawned[1]!.at(-1)).toContain('/ctx/codex-7.md')

  await ui.press({ key: 'tab-claude' })
  await ui.input({ key: 'ask', text: 'c' })
  expect(spawned[2]!.slice(0, 6)).toEqual(['claude', '-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'])
  expect(spawned[2]).toContain('--session-id')
})

test('the work on the way is shown, then folded into one line that unfolds', async ($, on) => {
  world(on)
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  await ui.input({ key: 'ask', text: 'go' })
  expect(await ui.find({ type: 'Button', label: /▸ 3 steps/ } as never)).toBeDefined() // the remark and the command
  expect(await ui.find({ type: 'Text', text: /\$ ls \| head -3/ })).toBeUndefined() // folded: the list is hidden
  await ui.press({ key: 'steps-1' })
  expect(await ui.find({ type: 'Text', text: /\$ ls \| head -3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· I will look/ })).toBeDefined()
  await ui.press({ key: 'steps-1' })
  expect(await ui.find({ type: 'Text', text: /\$ ls \| head -3/ })).toBeUndefined()
})

test('one CLI keeps working while another is asked; the one that finished unseen is marked yellow', async ($, on) => {
  const { spawned, gates } = world(on)
  let release!: () => void
  gates.agy = new Promise(r => (release = r))
  await $.command.run({ command: 'call', args: 'agy' } as never)
  const ui = await mount($)

  const slow = ui.input({ key: 'ask', text: 'slow one' }) // agy starts and does not finish yet
  await tick()
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).toContain('#1f4e8c')
  await ui.press({ key: 'tab-codex' })
  await ui.input({ key: 'ask', text: 'fast one' }) // codex is asked meanwhile and answers
  expect(spawned.map(a => a[0])).toEqual(['agy', 'codex'])
  expect(await ui.find({ type: 'Markdown', text: /codex says hi/ })).toBeDefined()
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).not.toContain('#e5c07b')

  release() // agy finishes while codex is the one shown
  await slow
  await tick(150)
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).toContain('#e5c07b')
  await ui.press({ key: 'tab-agy' })
  expect(await ui.find({ type: 'Markdown', text: /agy says hi/ })).toBeDefined()
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).not.toContain('#e5c07b')
})

test('model, effort: typed in the pane, picked from the list, stepped with the arrows', async ($, on) => {
  const { spawned } = world(on)
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  await ui.input({ key: 'ask', text: '/effort high' })
  await ui.input({ key: 'ask', text: '/model gpt-x' })
  await ui.input({ key: 'ask', text: '/effort nope' })
  expect(await ui.find({ type: 'Markdown', text: /has no effort "nope"/ })).toBeDefined()
  await ui.input({ key: 'ask', text: 'go' })
  expect(spawned[0]!.slice(0, 7)).toEqual(['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-x', '-c', 'model_reasoning_effort="high"'])

  await ui.press({ key: 'tab-agy' })
  await tick()
  await ui.press({ key: 'model' })
  await ui.press({ key: 'm:gemini-3.8-flash' }) // the three effort rows fold into one model
  await ui.press({ key: 'effort-prev' }) // unset shows as medium; one step back is low
  await ui.input({ key: 'ask', text: 'e' })
  const last = spawned.at(-1)!
  expect(last).not.toContain('--effort') // agy joins model and effort in its one id
  expect(last[last.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low')

  await ui.press({ key: 'effort-next' })
  await ui.press({ key: 'effort-next' })
  expect(await ui.find({ type: 'Text', text: /^high$/ })).toBeDefined()
  await ui.press({ key: 'effort-next' }) // already at the top: stays
  expect(await ui.find({ type: 'Text', text: /^high$/ })).toBeDefined()
  await ui.press({ key: 'model' })
  await ui.press({ key: 'm:gpt-oss-120b' }) // only medium exists for it: the chosen high is dropped
  await ui.input({ key: 'ask', text: 'f' })
  expect(spawned.at(-1)![spawned.at(-1)!.indexOf('--model') + 1]).toBe('gpt-oss-120b-medium')
})

test('files being changed are flagged, two on one file warn, the Claude Code session is kept off, flags lift when done', async ($, on) => {
  const { spawned, holds } = world(on)
  let letAgy!: () => void
  let letCodex!: () => void
  holds.agy = new Promise(r => (letAgy = r))
  holds.codex = new Promise(r => (letCodex = r))
  await $.command.run({ command: 'call', args: 'agy' } as never)
  const ui = await mount($)

  await ui.input({ key: 'ask', text: 'fix train' })
  await tick()
  expect(await ui.find({ type: 'Text', text: /✎ w\/train\.py\s+agy/ })).toBeDefined() // flagged while it works
  expect(prompt(spawned[0]!)).toContain('before you change code or files') // asks first by default
  expect(prompt(spawned[0]!)).not.toContain('Other agents are changing')

  await ui.press({ key: 'tab-codex' })
  await ui.input({ key: 'ask', text: 'also train' })
  await tick()
  expect(await ui.find({ type: 'Text', text: /⚠ w\/train\.py\s+agy \+ codex/ })).toBeDefined() // both on one file
  expect(prompt(spawned[1]!)).toContain('Other agents are changing these files right now') // codex was told when it started
  expect(prompt(spawned[1]!)).toContain('/w/train.py')

  const edit = await $.tool.call({ tool: 'Edit', file_path: '/w/train.py', old_string: 'a', new_string: 'b' } as never)
  expect(JSON.stringify(edit)).toContain('being changed by agy, codex') // Claude Code itself is refused
  const other = await $.tool.call({ tool: 'Edit', file_path: '/w/other.py', old_string: 'a', new_string: 'b' } as never)
  expect(JSON.stringify(other)).not.toContain('being changed by')

  letAgy()
  letCodex()
  await tick(200)
  expect(await ui.find({ type: 'Text', text: /train\.py\s+(agy|codex)/ })).toBeUndefined() // lifted with the turns
})

test('a table too wide for the pane becomes a list; a narrow one stays; the agent is told the width', async ($, on) => {
  const { spawned } = world(on)
  const answer = [
    '| 항목 | 최적 방법 | 이유가 아주 길게 적힌 칸 | 또 다른 아주 긴 설명이 들어간 칸 |', '|---|---|---|---|',
    '| N5k | RGB-D 부피 직접 회귀 | 사진과 깊이 정보로 양을 바로 추정할 수 있음 | 외부 지식 없이도 충분히 동작함 |',
    '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
    '┌──────────┬───────────────────────────────────────────────┬──────────────────────────────────────────────┐',
    '│ 122 처음 │ 3번 food_b (33.67), 4번 25-d (32.93~35.58)    │ 분해 + LLM 1인분 사전값 활용                 │',
    '└──────────┴───────────────────────────────────────────────┴──────────────────────────────────────────────┘',
  ].join('\n')
  const saved = OUT.codex
  OUT.codex = j({ type: 'thread.started', thread_id: 'cx-9' }, { type: 'item.completed', item: { type: 'agent_message', text: answer } })
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  await ui.input({ key: 'ask', text: 'table' })
  OUT.codex = saved
  const md = JSON.stringify(await ui.find({ type: 'Markdown', text: /N5k/ }))
  expect(md).toContain('- **N5k**') // the wide table is a list now
  expect(md).toContain('  - 최적 방법: RGB-D 부피 직접 회귀')
  expect(md).toContain('| a | b |') // the narrow one is left alone
  expect(md).not.toContain('┬') // and the box drawing is a list too, with its words kept
  expect(md).toContain('- **122 처음**')
  expect(prompt(spawned[0]!)).toContain('about 80 columns wide')
})

test('a pane that was open comes back with its chats when the session is entered again', async ($, on) => {
  const { spawned, opened } = world(on)
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  await ui.input({ key: 'ask', text: 'hello' })

  opened.length = 0
  await $.session.start({ source: 'resume', cwd: '/w' } as never) // the session is entered again
  expect(opened).toEqual(['call'])
  const back = ui
  expect(await back.find({ type: 'Markdown', text: /codex says hi/ })).toBeDefined() // its chat is there
  await back.input({ key: 'ask', text: 'again' })
  expect(spawned.at(-1)).toContain('cx-1') // and it goes on in the same conversation of the CLI

})

test('a button at the very top goes to the bottom, one at the very bottom goes to the top', async ($, on) => {
  world(on)
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  await ui.input({ key: 'ask', text: 'hi' })
  const tree = JSON.stringify(await ui.find({ type: 'Box' } as never)) // the whole pane, in drawing order
  const at = (key: string) => tree.indexOf(`"key":"${key}"`)
  expect(at('to-end')).toBeGreaterThan(-1)
  expect(at('to-end')).toBeLessThan(at('model')) // first, in the row of tabs
  expect(at('to-start')).toBeGreaterThan(at('ask')) // last, below the input
})

test('math with an exponent is drawn as plain text; the effort shown is the effort sent; the whole context goes, long ones to be summarised, diffs in full', async ($, on) => {
  const { spawned, state } = world(on)
  const saved = OUT.codex
  OUT.codex = j({ type: 'thread.started', thread_id: 'cx-7' }, { type: 'item.completed', item: { type: 'agent_message', text: 'so $x^2$, $a^{10}$, $e^{-x}$ and $x^{n+1}$ and $x^2 + y^2 = z^2$' } })
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  await ui.input({ key: 'ask', text: 'go' })
  OUT.codex = saved
  const md = JSON.stringify(await ui.find({ type: 'Markdown', text: /so / }))
  expect(md).toContain('x²')
  expect(md).toContain('a¹⁰')
  expect(md).not.toContain('$x')
  expect(spawned[0]!.join(' ')).toContain('model_reasoning_effort=\"medium\"') // unset: medium is shown, so medium is sent
  expect(prompt(spawned[0]!)).toContain('/ctx/codex-0.diff.md')
  expect(prompt(spawned[0]!)).toContain('never summarise')
  expect(prompt(spawned[0]!)).not.toContain('write your own short summary')
  state.chars = 70_000
  await ui.input({ key: 'ask', text: 'again' })
  expect(prompt(spawned[1]!)).toContain('write your own short summary')
  expect(prompt(spawned[1]!)).toContain('/ctx/notes.md')
  expect(prompt(spawned[1]!)).toContain('do not ask first') // the ask-first rule must not hold the notes back
})

test('a summary is asked for once the conversation given since the last one adds up, not only when one turn is big; a failed read says so and can be retried', async ($, on) => {
  const { spawned, state } = world(on)
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  state.chars = 20_000
  for (const t of ['one', 'two', 'three']) {
    await ui.input({ key: 'ask', text: t })
    expect(prompt(spawned.at(-1)!)).not.toContain('write your own short summary') // 20k, 40k, 60k
  }
  await ui.input({ key: 'ask', text: 'four' })
  expect(prompt(spawned.at(-1)!)).toContain('write your own short summary') // 80k given in all
  expect(prompt(spawned.at(-1)!)).not.toContain('(add to the notes')
  await ui.input({ key: 'ask', text: 'five' }) // summarised: counting starts again
  expect(prompt(spawned.at(-1)!)).not.toContain('write your own short summary')

  const n = spawned.length
  state.fail = true
  await ui.input({ key: 'ask', text: 'lost?' })
  expect(spawned.length).toBe(n) // nothing was sent without the context
  expect(await ui.find({ type: 'Text', text: /Could not read the Claude Code conversation/ })).toBeDefined()
  state.fail = false
  await ui.press({ key: 'retry' })
  expect(spawned.length).toBe(n + 1)
  expect(prompt(spawned.at(-1)!)).toContain('The user now asks: lost?')
})

test('clear while a CLI works stops it; pressed again it asks before it clears for good', async ($, on) => {
  const { holds } = world(on)
  await $.command.run({ command: 'call', args: 'codex' } as never)
  const ui = await mount($)
  let release = () => {}
  holds.codex = new Promise<void>(r => { release = r })
  void ui.input({ key: 'ask', text: 'long job' })
  await tick(300)
  await ui.press({ key: 'clear' }) // working: this stops it
  await tick(100)
  expect(await ui.find({ type: 'Markdown', text: /stopped/ })).toBeDefined()
  release()
  await ui.press({ key: 'clear' }) // idle: asks
  expect(await ui.find({ type: 'Text', text: /Clear this chat for good/ })).toBeDefined()
  await ui.press({ key: 'clear-no' })
  expect(await ui.find({ type: 'Markdown', text: /stopped/ })).toBeDefined() // kept
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear-yes' })
  expect(await ui.find({ type: 'Markdown', text: /stopped/ })).toBeUndefined() // gone
})
