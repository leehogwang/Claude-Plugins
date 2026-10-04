import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OriginSession } from '../types'

// /fork starts this session as a copy of another, which keeps running. The original stays open
// here: its conversation, read again every few seconds, and an input that writes to it: a message
// to it while it runs, else a prompt run in it (`claude -p --resume`). Nothing runs until you write.

const PANE = 'fork-origin'
const SHOWN = 40 // the latest messages drawn
const origin = atom({ plugin: 'fork-origin', key: 'origin' } as const, { id: '', cwd: '', turns: [] } as OriginSession)
const reply = atom({ plugin: 'fork-origin', key: 'reply' } as const, '') // what the original is writing now
const running = atom({ plugin: 'fork-origin', key: 'running' } as const, false)
const error = atom({ plugin: 'fork-origin', key: 'error' } as const, '')
const hint = atom({ plugin: 'fork-origin', key: 'hint' } as const, false) // the resume command shown

let ticking: { cancel: () => void } | undefined // the pane's refresh

// The session this one was forked from: the fork copied its messages under the same uuids.
async function findOrigin($: EngineInterface) {
  const r = await $.process.run(['python3', `${$.plugin.root}/hooks/find_origin.py`, await $.session.id()], { timeoutMs: 60_000 })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

async function load($: EngineInterface, id: string) {
  const r = await $.process.run(['python3', `${$.plugin.root}/hooks/transcript.py`, id], { timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) ?? 'could not read the session')
  const { cwd, turns } = JSON.parse(r.stdout) as Omit<OriginSession, 'id'>
  await update($, origin, () => ({ id, cwd: cwd ?? '', turns }))
}

async function show($: EngineInterface, id: string) {
  await update($, error, () => '')
  await update($, reply, () => '')
  await $.ui.open({ id: PANE, title: 'Original session' })
  ticking?.cancel()
  ticking = $.clock.every(3000, async () => {
    const o = await read($, origin)
    if (o.id && !(await read($, running))) await load($, o.id).catch(() => undefined)
  })
  try {
    await load($, id)
  } catch (err) {
    await update($, error, () => String(err))
  }
}

// To the original: a message while it runs (it reads it as from another session), else one turn
// run in it as your prompt, its words streamed into the pane.
async function send($: EngineInterface, text: string) {
  const o = await read($, origin)
  if (!o.id || !text.trim() || (await read($, running))) return
  await update($, error, () => '')
  const sent = await $.session.send({ to: { sessionId: o.id }, text })
  if (sent.isDelivered) {
    await update($, reply, () => '')
    return
  }
  await update($, running, () => true)
  await update($, reply, () => '')
  await update($, origin, v => ({ ...v, turns: [...v.turns, { who: 'user' as const, text }] }))
  try {
    const child = $.process.spawn({ argv: ['claude', '-p', '--resume', o.id, text], cwd: o.cwd || undefined })
    let err = ''
    const pieces = child[Symbol.asyncIterator]()
    for (let step = await pieces.next(); ; step = await pieces.next()) {
      if (step.done) {
        if (step.value.code !== 0) throw new Error(err.trim().split('\n').slice(-3).join('\n') || `exited ${step.value.code}`)
        break
      }
      if (step.value.stream === 'stdout') await update($, reply, t => t + step.value.text)
      else err += step.value.text
    }
    await load($, o.id)
    await update($, reply, () => '')
  } catch (e) {
    await update($, error, () => String(e))
  } finally {
    await update($, running, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'origin', description: 'Open the session this one forked from (or /origin <session id>) and talk to it' })
    return next(e)
  })

  // a fork just started: its notice may not be in the transcript yet, so look again a few times
  on('classic.SessionStart', async ($, e, next) => {
    const started = await next(e)
    if (e.source === 'fork') {
      void (async () => {
        for (let tries = 0; tries < 5; tries++) {
          const id = await findOrigin($)
          if (id) return show($, id)
          await $.clock.sleep(1000)
        }
      })()
    }
    return started
  })

  on('command.run', { command: 'origin' }, async ($, e) => {
    const id = e.args.trim() || (await read($, origin)).id || (await findOrigin($))
    if (!id) return { text: 'This session is not a fork. /origin <session id> opens any session.' }
    await show($, id)
    const failed = await read($, error)
    return { text: failed || `Original session ${id.slice(0, 8)} is open in its pane.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const o = await read($, origin)
    const live = await read($, reply)
    const busy = await read($, running)
    const failed = await read($, error)
    const turns = o.turns.slice(-SHOWN)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold color="magenta">원본 세션</Text>
          <Text dimColor>{o.id ? o.id.slice(0, 8) : ''}</Text>
          <Button key="refresh" label="새로고침" plain dimColor onPress={() => o.id && load($, o.id)} />
          <Button key="terminal" label="터미널에서 열기" plain dimColor onPress={() => update($, hint, h => !h)} />
        </Box>
        {(await read($, hint)) && o.id ? <Text color="yellow">{`claude --resume ${o.id}`}</Text> : null}
        {o.turns.length > SHOWN && <Text dimColor>{`… ${o.turns.length - SHOWN} earlier messages`}</Text>}
        {turns.map(t => (
          <Box flexDirection="row" marginTop={1}>
            <Box width={4} flexShrink={0}>
              <Text bold color={t.who === 'user' ? 'cyan' : 'green'}>{t.who === 'user' ? '나' : 'C'}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text>{t.text}</Text>
            </Box>
          </Box>
        ))}
        {busy && (
          <Box flexDirection="row" marginTop={1}>
            <Box width={4} flexShrink={0}>
              <Text bold color="green">C</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor>{live || '⟳ 원본 세션이 작업 중…'}</Text>
            </Box>
          </Box>
        )}
        {failed ? <Text color="red">{failed}</Text> : null}
        {o.id && 'Input' in ui && (
          <Box marginTop={1}>
            <ui.Input key="ask" placeholder={busy ? '원본이 답하는 중…' : '원본 세션에게 보내기 (Enter)'} submitLabel="보내기" onSubmit={(text: string) => send($, text)} />
          </Box>
        )}
      </Box>
    )
  })
}
