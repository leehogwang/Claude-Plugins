import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const TRANSCRIPT = { cwd: '/w/proj', turns: [{ who: 'user', text: '모델 구조 그려줘' }, { who: 'claude', text: '패널에 그렸습니다' }] }

function world(on: On, turns: () => typeof TRANSCRIPT.turns) {
  mock.clock(on)
  on('session.id', () => ({ value: 'fork-5678' }))
  on('ui.open', () => ({ value: {} as never }))
  on('classic.SessionStart', () => ({}))
  const ran: string[] = []
  on('process.run', (_$: unknown, e: unknown) => {
    const script = (e as { argv: string[] }).argv[1]!
    ran.push(script)
    const stdout = script.endsWith('find_origin.py') ? 'orig-1234\n' : JSON.stringify({ ...TRANSCRIPT, turns: turns() })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return ran
}

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'see-parent', surface: 'terminal', component: 'Pane', props: { bodyColumns: 80 } as never, requestId: 'see-parent', viewport: { columns: 100, rows: 40 } })

test('a fork finds its original and shows it; with the original stopped, the input runs a turn in it', async ($, on) => {
  let turns = TRANSCRIPT.turns
  world(on, () => turns)
  on('session.send', () => ({ isDelivered: false, reason: 'not running' }) as never)
  const spawned: { argv: readonly string[]; cwd?: string }[] = []
  on('process.spawn', async function* (_$: unknown, e: unknown) {
    spawned.push(e as never)
    yield { stream: 'stdout', text: '바꿨' }
    turns = [...turns, { who: 'user', text: '색 바꿔줘' }, { who: 'claude', text: '바꿨습니다' }]
    return { value: { code: 0, signal: null } } as never
  } as never)

  await $.classic.SessionStart({ source: 'fork', session_id: 'fork-5678' } as never)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /패널에 그렸습니다/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /orig-123/ })).toBeDefined()

  await ui.input({ key: 'ask', text: '색 바꿔줘' })
  expect(spawned[0]!.argv).toEqual(['claude', '-p', '--resume', 'orig-1234', '색 바꿔줘'])
  expect(spawned[0]!.cwd).toBe('/w/proj')
  expect(await ui.find({ type: 'Text', text: /^바꿨습니다/ })).toBeDefined()
})

test('with the original running, the input goes to it as a message, nothing spawned', async ($, on) => {
  world(on, () => TRANSCRIPT.turns)
  const sent: unknown[] = []
  on('session.send', (_$: unknown, e: unknown) => {
    sent.push(e)
    return { isDelivered: true } as never
  })
  let spawned = 0
  on('process.spawn', async function* () {
    spawned++
    return { value: { code: 0, signal: null } } as never
  } as never)
  expect((await $.command.run({ command: 'parent', args: '' } as never)).text).toContain('orig-123')
  const ui = await mount($)
  await ui.input({ key: 'ask', text: '진행 상황 알려줘' })
  expect(sent).toEqual([expect.objectContaining({ to: 'orig-1234', text: '진행 상황 알려줘' })])
  expect(spawned).toBe(0)
})
