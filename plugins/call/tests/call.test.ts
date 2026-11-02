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
  on('ui.open', () => ({ value: {} as never }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.call', () => ({ result: 'ok' }) as never) // what the tool itself would answer
  const state = { records: 7 }
  on('process.run', (_$: unknown, e: unknown) => {
    const argv = (e as { argv: string[] }).argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'python3') return ok(JSON.stringify({ records: state.records, path: argv[4] === 'claude' && argv[3] !== '0' ? '' : `/ctx/${argv[4]}-${argv[3]}.md` }))
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
  return { spawned, gates, holds, state }
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
  expect(spawned[0]!.slice(0, 5)).toEqual(['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--json', expect.stringContaining('/ctx/codex-0.md')])
  expect(spawned[0]!.at(-1)).toContain('The user now asks: 안녕')
  expect(await ui.find({ type: 'Markdown', text: /codex says hi/ })).toBeDefined() // the answer is drawn as markdown
  expect(JSON.stringify(await ui.find({ type: 'Input' } as never))).toContain('"value":""') // the field is empty again after sending

  state.records = 9 // Claude Code went on meanwhile: the next message brings what is new
  await ui.input({ key: 'ask', text: '또' })
  expect(spawned[1]!.slice(0, 5)).toEqual(['codex', 'exec', 'resume', '--dangerously-bypass-approvals-and-sandbox', '--json'])
  expect(spawned[1]).toContain('cx-1')
  expect(spawned[1]!.at(-1)).toContain('New messages')
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
  expect(await ui.find({ type: 'Button', label: /▸ 작업 3단계/ } as never)).toBeDefined() // the remark and the command
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
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).toContain('⟳')
  await ui.press({ key: 'tab-codex' })
  await ui.input({ key: 'ask', text: 'fast one' }) // codex is asked meanwhile and answers
  expect(spawned.map(a => a[0])).toEqual(['agy', 'codex'])
  expect(await ui.find({ type: 'Markdown', text: /codex says hi/ })).toBeDefined()
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).not.toContain('yellow')

  release() // agy finishes while codex is the one shown
  await slow
  await tick(150)
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).toContain('yellow')
  await ui.press({ key: 'tab-agy' })
  expect(await ui.find({ type: 'Markdown', text: /agy says hi/ })).toBeDefined()
  expect(await dump(ui, { type: 'Button', key: 'tab-agy' })).not.toContain('yellow')
})

test('model, effort: typed in the pane, picked from the list, dragged on the slider', async ($, on) => {
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
  await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'slider-effort' }) // default low medium high: x=1 is low
  await ui.input({ key: 'ask', text: 'e' })
  const last = spawned.at(-1)!
  expect(last).not.toContain('--effort') // agy joins model and effort in its one id
  expect(last[last.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low')

  await ui.pointer({ type: 'move', x: 3, y: 0, button: 'left', in: 'slider-effort' }) // dragging
  expect(await ui.find({ type: 'Text', text: /^high$/ })).toBeDefined()
  await ui.pointer({ type: 'move', x: 0, y: 0, in: 'slider-effort' }) // no button down: only hovering
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
