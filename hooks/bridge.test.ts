import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { answersFromForm, questionCard } from './cards'
import { buildPrompt, chunkReply, findResources, localImages, markerOf, parseEvent, parseSlash, splitLines } from './lib'

const typed = (args: string) => ({
  command: 'feishu',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})
const tick = () =>
  new Promise(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => r(undefined), 5))
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await tick()
}

const event = (over: Record<string, string> = {}) =>
  JSON.stringify({
    type: 'im.message.receive_v1',
    message_id: 'om_abc123',
    chat_id: 'oc_chat1',
    chat_type: 'p2p',
    sender_id: 'ou_owner',
    sender_type: 'user',
    message_type: 'text',
    content: '帮我看下磁盘空间',
    ...over,
  })

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** The engine beneath the plugin: lark-cli and the other $ calls, recorded. */
function harness(on: On, lines: string[], answerCard?: (argv: string[]) => string) {
  const runs: string[][] = []
  const submitted: string[] = []
  const commands: string[] = []
  on('process.spawn', async function* () {
    for (const line of lines) yield { stream: 'stdout' as const, text: line + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv.includes('card.action.trigger')) {
      const jq = argv[argv.indexOf('--jq') + 1] ?? ''
      const rid = /"([0-9a-f]{16})"/.exec(jq)?.[1] ?? ''
      await until(() => runs.some(r => r.includes('interactive')))
      return ok(answerCard ? answerCard([rid]) : '')
    }
    if (argv.includes('+messages-send')) return ok('{"ok":true,"data":{"message_id":"om_sent1"}}')
    if (argv.includes('GET')) {
      return ok(JSON.stringify({ data: { items: [{ body: { content: JSON.stringify({ image_key: 'img_v3_aaa' }) } }] } }))
    }
    if (argv[0] === 'ls') return ok('img_v3_aaa.png\n')
    return ok('{"ok":true}')
  })
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  on('command.run', async (_$, e) => {
    commands.push(`${e.command} ${e.args}`.trim())
    return { text: e.command === 'doctor' ? 'All good' : '' }
  })
  on('tool.check', async () => ({ decision: 'ask' as const, reason: 'needs approval' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  mock.store(on, { allow: ['ou_owner'], homeChat: 'oc_chat1' })
  mock.clock(on)
  return { runs, submitted, commands }
}

const complete = (turnId: string, answer: string) =>
  ({ answer, durationMs: 10, isAborted: false, turnId, reason: 'answer' }) as const

describe('lib', () => {
  test('parses an event line and round-trips the marker', () => {
    const m = parseEvent(event())
    expect(m?.messageId).toBe('om_abc123')
    expect(markerOf(buildPrompt(m!))).toBe('om_abc123')
    expect(parseEvent('not json')).toBe(null)
    expect(parseEvent(JSON.stringify({ message_id: '--evil' }))).toBe(null)
  })

  test('splits streamed chunks into whole lines', () => {
    const a = splitLines('', '{"a":1}\n{"b"')
    expect(a.lines).toEqual(['{"a":1}'])
    expect(splitLines(a.rest, ':2}\n').lines).toEqual(['{"b":2}'])
  })

  test('chunks long replies under the limit', () => {
    const pieces = chunkReply(('段落'.repeat(500) + '\n\n').repeat(10), 3500)
    expect(pieces.length > 1).toBe(true)
    for (const p of pieces) expect(p.length <= 3500).toBe(true)
  })

  test('slash commands, resources and local images', () => {
    expect(parseSlash('/cost')).toEqual({ command: 'cost', args: '' })
    expect(parseSlash('/feishu allow last')).toEqual({ command: 'feishu', args: 'allow last' })
    expect(parseSlash('看看 /tmp')).toBe(null)
    const post = { content: [[{ tag: 'img', image_key: 'img_1' }, { tag: 'text', text: 'hi' }]], f: { file_key: 'file_2', file_name: 'a.pdf' } }
    expect(findResources(post)).toEqual([
      { key: 'img_1', type: 'image' },
      { key: 'file_2', type: 'file', name: 'a.pdf' },
    ])
    expect(localImages('见 /tmp/out/chart.png 和 `/tmp/out/chart.png`')).toEqual(['/tmp/out/chart.png'])
  })

  test('form answers map back to labels', () => {
    const qs = [
      { question: '用哪个库？', multiSelect: false, options: [{ label: 'dayjs' }, { label: 'luxon' }] },
      { question: '要哪些功能？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
    ]
    expect(answersFromForm(qs, { q0: '1', q1: ['0', '2'], q1_other: 'D' })).toEqual({
      '用哪个库？': 'luxon',
      '要哪些功能？': 'A, C, D',
    })
    const card = JSON.stringify(questionCard('r1', qs))
    expect(card).toContain('multi_select_static')
    expect(card).toContain('"form_action_type":"submit"')
  })
})

describe('bridge', () => {
  test('a Feishu message becomes a prompt, and the turn answer is replied', async ($, on) => {
    const h = harness(on, [event()])
    await $.command.run(typed('on'))
    await until(() => h.submitted.length > 0)
    expect(h.submitted[0]).toContain('[飞书消息 om_abc123]')

    await $.turn.start({ text: h.submitted[0] ?? '', turnId: 't1' })
    await $.turn.complete(complete('t1', '磁盘还剩 120G。'))
    const replyCall = h.runs.find(argv => argv.includes('+messages-reply'))
    expect(replyCall).toContain('om_abc123')
    expect(replyCall).toContain('磁盘还剩 120G。')
    await $.command.run(typed('off'))
  })

  test('an image is downloaded and its path handed to the session', async ($, on) => {
    const h = harness(on, [event({ message_type: 'image', content: '[Image: img_v3_aaa]' })])
    await $.command.run(typed('on'))
    await until(() => h.submitted.length > 0)
    expect(h.runs.some(r => r.includes('+messages-resources-download') && r.includes('img_v3_aaa'))).toBe(true)
    expect(h.submitted[0]).toContain('/tmp/feishu-mod/om_abc123/img_v3_aaa.png')
    await $.command.run(typed('off'))
  })

  test('a slash command from Feishu runs and its output is replied', async ($, on) => {
    const h = harness(on, [event({ content: '/doctor' })])
    await $.command.run(typed('on'))
    await until(() => h.runs.some(r => r.includes('+messages-reply')))
    expect(h.commands).toContain('doctor')
    expect(h.runs.find(r => r.includes('+messages-reply'))?.join(' ')).toContain('All good')
    await $.command.run(typed('off'))
  })

  test('/cost is answered from the session usage, without opening a panel', async ($, on) => {
    const h = harness(on, [event({ content: '/cost' })])
    on('session.usage', async () => ({
      value: { startedAt: 0, context: { tokens: 42000, window: 200000, percent: 21 }, rateLimits: [], cost: { usd: 1.5 } },
    }))
    await $.command.run(typed('on'))
    await until(() => h.runs.some(r => r.includes('+messages-reply')))
    expect(h.commands.length).toBe(0)
    expect(h.runs.find(r => r.includes('+messages-reply'))?.join(' ')).toContain('$1.50')
    await $.command.run(typed('off'))
  })

  test('a prompt typed at the computer is mirrored and answered in Feishu', async ($, on) => {
    const h = harness(on, [])
    await $.command.run(typed('on'))
    await $.prompt.submit({ text: '电脑上问的问题', wait: false, origin: { kind: 'composer' } })
    const sent = h.runs.find(r => r.includes('+messages-send'))
    expect(sent?.join(' ')).toContain('电脑上问的问题')

    await $.turn.start({ text: '电脑上问的问题', turnId: 't2' })
    await $.turn.complete(complete('t2', '电脑上的回答'))
    const replyCall = h.runs.find(r => r.includes('+messages-reply'))
    expect(replyCall).toContain('om_sent1')
    expect(replyCall).toContain('电脑上的回答')
    await $.command.run(typed('off'))
  })

  test('a permission ask is settled by a Feishu card click', async ($, on) => {
    const h = harness(on, [], ([rid]) =>
      JSON.stringify({ operator_id: 'ou_owner', action_value: JSON.stringify({ rid, kind: 'approval', choice: 'once' }) }),
    )
    await $.command.run(typed('on'))
    const res = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    expect(res.decision?.behavior).toBe('allow')
    expect(h.runs.some(r => r.includes('interactive') && r.join(' ').includes('rm -rf build'))).toBe(true)
    expect(h.runs.some(r => r.includes('PATCH'))).toBe(true)
    await $.command.run(typed('off'))
  })

  test('"no more asking" adds a session rule', async ($, on) => {
    harness(on, [], ([rid]) =>
      JSON.stringify({ operator_id: 'ou_owner', action_value: JSON.stringify({ rid, kind: 'approval', choice: 'session' }) }),
    )
    await $.command.run(typed('on'))
    const res = await $.classic.PermissionRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })
    const d = res.decision
    expect(d?.behavior).toBe('allow')
    expect(JSON.stringify(d)).toContain('"destination":"session"')
    await $.command.run(typed('off'))
  })

  test('a click by someone not allowed does not count', async ($, on) => {
    let calls = 0
    harness(on, [], ([rid]) => {
      calls++
      const who = calls === 1 ? 'ou_stranger' : 'ou_owner'
      return JSON.stringify({ operator_id: who, action_value: JSON.stringify({ rid, kind: 'approval', choice: 'deny' }) })
    })
    await $.command.run(typed('on'))
    const res = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(calls).toBe(2)
    expect(res.decision?.behavior).toBe('deny')
    await $.command.run(typed('off'))
  })

  test('AskUserQuestion is answered from a Feishu form', async ($, on) => {
    harness(on, [], ([rid]) =>
      JSON.stringify({
        operator_id: 'ou_owner',
        action_value: JSON.stringify({ rid, kind: 'question' }),
        form_value: JSON.stringify({ q0: '1' }),
      }),
    )
    await $.command.run(typed('on'))
    const questions = [{ question: '用哪个库？', header: '库', multiSelect: false, options: [{ label: 'dayjs' }, { label: 'luxon' }] }]
    const res = await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions } })
    const d = res.decision
    expect(d?.behavior).toBe('allow')
    expect(JSON.stringify(d)).toContain('"用哪个库？":"luxon"')
    await $.command.run(typed('off'))
  })

  test('without the bridge on, permission asks stay local', async ($, on) => {
    const h = harness(on, [])
    on('classic.PermissionRequest', async () => ({}))
    const res = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(res.decision).toBe(undefined)
    expect(h.runs.length).toBe(0)
  })
})
