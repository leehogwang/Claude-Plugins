import { expect, mock, test } from 'claude-code/testing'

test('/history sends the whole conversation once, then only what came after', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'zzz' }))
  on('ui.open', () => ({ value: {} as never }))
  // the transcript grows: 10 records, then 15
  let records = 10
  const from: string[] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    from.push(argv[3]!)
    const start = Number(argv[3])
    const body = start >= records ? '' : start === 0 ? 'USER: 파이프라인 시각화\nCLAUDE: 가능합니다' : 'USER: 스크롤바 추가\nCLAUDE: 추가했습니다'
    const head = JSON.stringify({ mtime: records, records, chunks: body ? 1 : 0 })
    return { value: { exitCode: 0, stdout: `${head}\n${body}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const prompts: string[] = []
  on('model.complete', (_$, e) => {
    prompts.push((e as unknown as { prompt: string }).prompt)
    const text = prompts.length === 1 ? '목표: 시각화 mod\n한 일:\n- 패널\n할 일:\n- 분석 결과 캐시 (Claude 제안)' : '목표: 시각화 mod\n한 일:\n- 패널\n- 스크롤바'
    return { value: { isAnswered: true, text, usage: { input_tokens: 5000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never }
  })
  const ui = await $.ui.mount({ plugin: 'history', surface: 'terminal', component: 'Pane', props: { bodyColumns: 80 } as never, requestId: 'history', viewport: { columns: 100, rows: 40 } })
  const run = () => $.command.run({ command: 'history', args: '' } as never)

  await run()
  expect(from.at(-1)).toBe('0')
  expect(prompts[0]).toContain('THE CONVERSATION:\nUSER: 파이프라인 시각화')
  expect(await ui.find({ type: 'Text', text: /^• 패널/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^할 일/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^• 분석 결과 캐시/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Haiku 5,000 in \/ 300 out tokens/ })).toBeDefined()

  await run() // nothing new: no call
  expect(prompts.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /up to date, no call/ })).toBeDefined()

  records = 15
  await run() // only records 11-15 go, with the summary so far
  expect(from.at(-1)).toBe('10')
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('CURRENT SUMMARY:\n목표: 시각화 mod')
  expect(prompts[1]).not.toContain('파이프라인 시각화')
  expect(await ui.find({ type: 'Text', text: /^• 스크롤바/ })).toBeDefined()
})

test('a summary written on one line with " · " still reads as entries', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'one' }))
  on('ui.open', () => ({ value: {} as never }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"mtime": 1, "records": 1, "chunks": 1}\nUSER: x', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: '목표/Goal: mod 두 개 · 한 일/Done: 1. pipeline 삭제 2. history 추가 · 할 일/Todo: 파일 삭제 여부', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never,
  }))
  const ui = await $.ui.mount({ plugin: 'history', surface: 'terminal', component: 'Pane', props: { bodyColumns: 80 } as never, requestId: 'history', viewport: { columns: 100, rows: 40 } })
  await $.command.run({ command: 'history', args: '' } as never)
  expect(await ui.find({ type: 'Text', text: /^목표$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^한 일$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^• history 추가/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^할 일$/ })).toBeDefined()
})
