import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FeishuBridgeStatus } from '../types'
import {
  buildPrompt,
  chunkReply,
  isOpenId,
  markerOf,
  parseEvent,
  REPLY_GUIDE,
  splitLines,
  type FeishuMessage,
} from './lib'

const PLUGIN = 'feishu-mod'
const PROFILE = 'claude-code'
const LARK = 'lark-cli'
const ALLOW_KEY = 'allow'
const LAST_KEY = 'lastUnknownSender'

const isOn = atom({ plugin: 'feishu-mod', key: 'isOn' } as const, false)
const status = atom({ plugin: 'feishu-mod', key: 'status' } as const, 'off' as FeishuBridgeStatus)
const turns = atom({ plugin: 'feishu-mod', key: 'turns' } as const, {} as Record<string, string>)
const seen = atom({ plugin: 'feishu-mod', key: 'seen' } as const, [] as string[])

type $ = EngineInterface

// The running consumer of this module load; a reload drops it with the module.
let consumer: AsyncGenerator<unknown, unknown> | undefined
let loopId = 0
const warnedSenders = new Set<string>()

const STATUS_TEXT: Record<FeishuBridgeStatus, string | undefined> = {
  off: undefined,
  starting: '飞书 ⋯ 连接中',
  listening: '飞书 ● 在线',
  error: '飞书 ✕ 断开，重连中',
}

async function setStatus($: $, next: FeishuBridgeStatus): Promise<void> {
  await update($, status, () => next)
  $.ui.status(STATUS_TEXT[next])
}

async function allowList($: $): Promise<string[]> {
  const value = await $.store.get(ALLOW_KEY)
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

async function lark($: $, args: string[]) {
  return $.process.run([LARK, '--profile', PROFILE, ...args], { timeoutMs: 60_000 })
}

async function react($: $, messageId: string, emoji: string): Promise<void> {
  const res = await lark($, [
    'api', 'POST', `/open-apis/im/v1/messages/${messageId}/reactions`,
    '--as', 'bot',
    '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } }),
  ]).catch(() => undefined)
  if (res && res.exitCode !== 0) $.ui.log(`${PLUGIN}: reaction failed: ${res.stderr || res.stdout}`, { to: 'debug' })
}

async function reply($: $, messageId: string, text: string): Promise<boolean> {
  const pieces = chunkReply(text)
  for (const [i, piece] of pieces.entries()) {
    const res = await lark($, [
      'im', '+messages-reply',
      '--as', 'bot',
      '--message-id', messageId,
      '--markdown', piece,
      '--idempotency-key', `${messageId}-${i}`.slice(0, 50),
    ])
    if (res.exitCode !== 0) {
      $.ui.toast(`飞书回复失败：${(res.stderr || res.stdout).slice(0, 300)}`)
      return false
    }
  }
  return true
}

async function handle($: $, m: FeishuMessage): Promise<void> {
  $.ui.log(`${PLUGIN}: event ${m.messageId} from ${m.senderId} (${m.chatType}/${m.messageType})`, { to: 'debug' })
  if (m.senderType && m.senderType !== 'user') return
  const already = (await read($, seen)).includes(m.messageId)
  if (already) return
  await update($, seen, list => [...list, m.messageId].slice(-200))

  const allowed = await allowList($)
  if (!allowed.includes(m.senderId)) {
    await $.store.set(LAST_KEY, m.senderId)
    if (!warnedSenders.has(m.senderId)) {
      warnedSenders.add(m.senderId)
      $.ui.toast(`飞书：未授权的发送者 ${m.senderId}。确认是你本人后运行 /feishu allow last`)
    }
    return
  }
  if (!m.content.trim()) return

  void react($, m.messageId, 'OnIt').catch(() => undefined)
  await $.prompt.submit({ text: buildPrompt(m), asUser: true })
}

async function runConsumer($: $): Promise<void> {
  const id = ++loopId
  while (id === loopId && (await read($, isOn))) {
    await setStatus($, 'starting')
    let buffer = ''
    try {
      // An unbounded consume exits when stdin closes; a timeout makes it ignore that.
      const stream = $.process.spawn({
        argv: [LARK, '--profile', PROFILE, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--timeout', '720h'],
      })
      consumer = stream
      for await (const chunk of stream) {
        if (id !== loopId) break
        if ((await read($, status)) !== 'listening') await setStatus($, 'listening')
        if (chunk.stream === 'stderr') {
          $.ui.log(`${PLUGIN}: ${chunk.text.trim()}`, { to: 'debug' })
          continue
        }
        const { lines, rest } = splitLines(buffer, chunk.text)
        buffer = rest
        for (const line of lines) {
          const message = parseEvent(line)
          if (message) await handle($, message).catch(err => $.ui.log(`${PLUGIN}: ${String(err)}`, { to: 'debug' }))
        }
      }
    } catch (err) {
      $.ui.log(`${PLUGIN}: consumer failed: ${String(err)}`, { to: 'debug' })
    }
    if (id !== loopId || !(await read($, isOn))) break
    await setStatus($, 'error')
    await $.clock.sleep(5000)
  }
}

async function stopConsumer($: $): Promise<void> {
  loopId++
  const running = consumer
  consumer = undefined
  await running?.return(undefined).catch(() => undefined)
  await setStatus($, 'off')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'feishu',
      description: '飞书桥接：on | off | status | allow <open_id|last> | deny <open_id>',
      argumentHint: 'on|off|status|allow <ou_…|last>|deny <ou_…>',
    })
    const started = await next(e)
    // A reload keeps $.state: resume a bridge that was on.
    if (await read($, isOn)) void runConsumer($).catch(() => undefined)
    return started
  })

  on('command.run', { command: 'feishu' }, async ($, e) => {
    const [verb = 'status', arg = ''] = e.args.trim().split(/\s+/)
    switch (verb) {
      case 'on': {
        if (await read($, isOn)) return { text: '飞书桥接已经开着。' }
        await update($, isOn, () => true)
        void runConsumer($).catch(() => undefined)
        const allowed = await allowList($)
        return {
          text: allowed.length
            ? `飞书桥接已开启（profile ${PROFILE}），授权用户 ${allowed.length} 个。`
            : `飞书桥接已开启（profile ${PROFILE}）。还没有授权用户：先给机器人发一条消息，按提示运行 /feishu allow。`,
        }
      }
      case 'off':
        await update($, isOn, () => false)
        await stopConsumer($)
        return { text: '飞书桥接已关闭。' }
      case 'allow':
      case 'deny': {
        const last = await $.store.get(LAST_KEY)
        const target = arg === 'last' && typeof last === 'string' ? last : arg
        if (!isOpenId(target)) return { text: '需要一个 open_id（ou_xxx），或用 last 表示最近一个未授权的发送者。' }
        const list = await allowList($)
        const nextList = verb === 'allow' ? [...new Set([...list, target])] : list.filter(x => x !== target)
        await $.store.set(ALLOW_KEY, nextList)
        return { text: `${verb === 'allow' ? '已授权' : '已移除'} ${target}。当前授权：${nextList.join(', ') || '无'}` }
      }
      default: {
        const allowed = await allowList($)
        return {
          text: [
            `状态：${await read($, status)}（profile ${PROFILE}）`,
            `授权用户：${allowed.join(', ') || '无'}`,
            `最近未授权的发送者：${String((await $.store.get(LAST_KEY)) ?? '无')}`,
          ].join('\n'),
        }
      }
    }
  })

  // Our own submissions carry the reply rules as context the person never sees.
  on('prompt.submit', ($, e, next) =>
    e.origin.kind === 'plugin' && e.origin.name === PLUGIN && markerOf(e.text)
      ? next({ ...e, context: [...(e.context ?? []), REPLY_GUIDE] })
      : next(e),
  )

  on('turn.start', async ($, e, next) => {
    const messageId = markerOf(e.text)
    if (messageId) await update($, turns, map => ({ ...map, [e.turnId]: messageId }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const messageId = (await read($, turns))[e.turnId]
    if (!messageId) return result
    await update($, turns, map => {
      const { [e.turnId]: _, ...rest } = map
      return rest
    })

    const text =
      e.reason === 'answer' ? e.answer.trim() || '（本轮没有文字回答）'
      : e.reason === 'aborted' ? '（这一轮在电脑上被中断了）'
      : e.reason === 'refusal' ? '（这一轮被模型拒绝了）'
      : '（这一轮因 API 错误中断）'
    const ok = await reply($, messageId, text)
    if (ok) void react($, messageId, 'DONE').catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the session: keep listening.
    if (e.reason !== 'clear') await stopConsumer($)
    return next(e)
  })
}
