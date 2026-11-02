import { expect, mock, test } from 'claude-code/testing'

const OUT: Record<string, string[]> = {
  codex: ['{"type":"thread.started","thread_id":"cx-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"codex says hi"}}\n'],
  opencode: ['{"type":"text","sessionID":"ses_1","part":{"text":"oc says hi"}}\n'],
  agy: ['{"conversation_id":"ag-1","status":"SUCCESS","response":"agy says hi\\n"}'],
  claude: ['claude says hi'],
}

test('/call finds the installed CLIs; each message runs one turn, the next continues the same conversation', async ($, on) => {
  mock.store(on)
  on('ui.open', () => ({ value: {} as never }))
  on('process.run', (_$: unknown, e: unknown) => {
    const name = (e as { argv: string[] }).argv[1]!
    return { value: { exitCode: name === 'opencode' ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const spawned: string[][] = []
  on('process.spawn', async function* (_$: unknown, e: unknown) {
    const argv = (e as { argv: string[] }).argv
    spawned.push([...argv])
    for (const text of OUT[argv[0]!]!) yield { stream: 'stdout', text }
    return { value: { code: 0, signal: null } } as never
  } as never)

  expect((await $.command.run({ command: 'call', args: 'opencode' } as never)).text).toContain('not installed')
  expect((await $.command.run({ command: 'call', args: 'codex' } as never)).text).toContain('claude, codex, agy')
  const ui = await $.ui.mount({ plugin: 'call', surface: 'terminal', component: 'Pane', props: { bodyColumns: 80 } as never, requestId: 'call', viewport: { columns: 100, rows: 40 } })

  await ui.input({ key: 'ask', text: '안녕' })
  expect(spawned[0]).toEqual(['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--json', '안녕'])
  expect(await ui.find({ type: 'Text', text: /codex says hi/ })).toBeDefined()
  await ui.input({ key: 'ask', text: '또' })
  expect(spawned[1]).toEqual(['codex', 'exec', 'resume', '--dangerously-bypass-approvals-and-sandbox', '--json', 'cx-1', '또'])

  await ui.press({ key: 'tab-agy' })
  await ui.input({ key: 'ask', text: 'q' })
  await ui.input({ key: 'ask', text: 'q2' })
  expect(spawned[2]).toEqual(['agy', '-p', 'q', '--dangerously-skip-permissions', '--output-format', 'json'])
  expect(spawned[3]).toEqual(['agy', '-p', 'q2', '--dangerously-skip-permissions', '--output-format', 'json', '--conversation', 'ag-1'])
  expect(await ui.find({ type: 'Text', text: /agy says hi/ })).toBeDefined()

  await ui.press({ key: 'tab-claude' })
  await ui.input({ key: 'ask', text: 'c' })
  await ui.input({ key: 'ask', text: 'c2' })
  expect(spawned[4]!.slice(0, 4)).toEqual(['claude', '-p', '--dangerously-skip-permissions', '--session-id'])
  expect(spawned[5]!.slice(0, 4)).toEqual(['claude', '-p', '--dangerously-skip-permissions', '--resume'])
  expect(spawned[5]![4]).toBe(spawned[4]![4])
})
