import { expect, test } from 'claude-code/testing'

const TRANSCRIPT = { cwd: '/w/proj', turns: [{ who: 'user', text: '모델 구조 그려줘' }, { who: 'claude', text: '패널에 그렸습니다' }] }

test('after /fork the original opens in a pane, and the input runs a turn there', async ($, on) => {
  let turns = TRANSCRIPT.turns
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify({ ...TRANSCRIPT, turns }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const spawned: { argv: readonly string[]; cwd?: string }[] = []
  on('process.spawn', async function* (_$: unknown, e: unknown) {
    spawned.push(e as never)
    yield { stream: 'stdout', text: '원본에서 ' }
    yield { stream: 'stdout', text: '답합니다' }
    turns = [...turns, { who: 'user', text: '색 바꿔줘' }, { who: 'claude', text: '바꿨습니다' }]
    return { value: { code: 0, signal: null } } as never
  } as never)
  on('ui.open', () => ({ value: {} as never }))
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ source: 'startup', session_id: 'orig-1234' } as never)
  await $.classic.SessionStart({ source: 'fork', session_id: 'fork-5678' } as never)
  const ui = await $.ui.mount({ plugin: 'fork-origin', surface: 'terminal', component: 'Pane', props: { bodyColumns: 80 } as never, requestId: 'fork-origin', viewport: { columns: 100, rows: 40 } })
  expect(await ui.find({ type: 'Text', text: /패널에 그렸습니다/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /orig-123/ })).toBeDefined()

  await ui.input({ key: 'ask', text: '색 바꿔줘' })
  expect(spawned[0]!.argv).toEqual(['claude', '-p', '--resume', 'orig-1234', '색 바꿔줘'])
  expect(spawned[0]!.cwd).toBe('/w/proj')
  expect(await ui.find({ type: 'Text', text: /^바꿨습니다/ })).toBeDefined()
})

test('/origin without a fork says how to open one', async $ => {
  expect((await $.command.run({ command: 'origin', args: '' } as never)).text).toContain('/origin <session id>')
})
