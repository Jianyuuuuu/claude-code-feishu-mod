import { expect, mock, test } from 'claude-code/testing'

import { buildPrompt, chunkReply, markerOf, parseEvent, splitLines } from './lib'

const typed = (args: string) => ({
  command: 'feishu',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})
const tick = () => new Promise(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => r(undefined), 5))

const EVENT = JSON.stringify({
  type: 'im.message.receive_v1',
  message_id: 'om_abc123',
  chat_id: 'oc_chat1',
  chat_type: 'p2p',
  sender_id: 'ou_owner',
  sender_type: 'user',
  message_type: 'text',
  content: '帮我看下磁盘空间',
})

test('parses an event line and round-trips the marker', () => {
  const m = parseEvent(EVENT)
  expect(m?.messageId).toBe('om_abc123')
  expect(markerOf(buildPrompt(m!))).toBe('om_abc123')
  expect(parseEvent('not json')).toBe(null)
  expect(parseEvent(JSON.stringify({ message_id: '--evil' }))).toBe(null)
})

test('splits streamed chunks into whole lines', () => {
  const a = splitLines('', '{"a":1}\n{"b"')
  expect(a.lines).toEqual(['{"a":1}'])
  const b = splitLines(a.rest, ':2}\n')
  expect(b.lines).toEqual(['{"b":2}'])
})

test('chunks long replies under the limit', () => {
  const pieces = chunkReply(('段落'.repeat(500) + '\n\n').repeat(10), 3500)
  expect(pieces.length > 1).toBe(true)
  for (const p of pieces) expect(p.length <= 3500).toBe(true)
})

test('a Feishu message becomes a prompt, and the turn answer is replied', async ($, on) => {
  const runs: string[][] = []
  const submitted: string[] = []

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: EVENT + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '{"ok":true}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('command.run', async () => ({ text: '' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  mock.store(on, { allow: ['ou_owner'] })
  mock.clock(on)

  await $.command.run(typed('on'))
  for (let i = 0; i < 50 && submitted.length === 0; i++) await tick()

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('[飞书消息 om_abc123]')
  expect(submitted[0]).toContain('帮我看下磁盘空间')

  await $.turn.start({ text: submitted[0] ?? '', turnId: 't1' })
  await $.turn.complete({ answer: '磁盘还剩 120G。', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })

  const replyCall = runs.find(argv => argv.includes('+messages-reply'))
  expect(replyCall).toBeDefined()
  expect(replyCall).toContain('om_abc123')
  expect(replyCall).toContain('磁盘还剩 120G。')
  expect(replyCall!.slice(0, 3)).toEqual(['lark-cli', '--profile', 'claude-code'])

  await $.command.run(typed('off'))
})
