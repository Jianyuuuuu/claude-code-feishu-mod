import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FeishuArmed, FeishuMirrored, FeishuModStatus, FeishuPendingCard } from '../types'
import {
  answersFromForm,
  answersMarkdown,
  approvalCard,
  configCard,
  questionCard,
  statusCard,
  resolvedCard,
  type ApprovalChoice,
  type AskQuestion,
  type Card,
  type ConfigRowView,
} from './cards'
import {
  buildPrompt,
  chunkReply,
  describeToolInput,
  findResources,
  formatUsage,
  LIMIT_NAMES,
  localTime,
  tokens,
  isChatId,
  isMessageId,
  isOpenId,
  localImages,
  markerOf,
  MEDIA_TYPES,
  parseEvent,
  parseObject,
  parseSlash,
  REPLY_GUIDE,
  safeName,
  sentMessageId,
  splitLines,
  type FeishuMessage,
} from './lib'

const PLUGIN = 'feishu-mod'
const PROFILE = 'claude-code'
const LARK = 'lark-cli'
const ALLOW_KEY = 'allow'
const LAST_KEY = 'lastUnknownSender'
const HOME_KEY = 'homeChat'
const DOWNLOADS = '/tmp/feishu-mod'
/** How long a card waits for a click, in short slices so a local answer stops the wait. */
const CARD_WAIT_S = 1800
const CARD_SLICE_S = 30

const isOn = atom({ plugin: 'feishu-mod', key: 'isOn' } as const, false)
const status = atom({ plugin: 'feishu-mod', key: 'status' } as const, 'off' as FeishuModStatus)
const turns = atom({ plugin: 'feishu-mod', key: 'turns' } as const, {} as Record<string, string>)
const said = atom({ plugin: 'feishu-mod', key: 'said' } as const, {} as Record<string, string[]>)
const seen = atom({ plugin: 'feishu-mod', key: 'seen' } as const, [] as string[])
const mirrored = atom({ plugin: 'feishu-mod', key: 'mirrored' } as const, [] as FeishuMirrored[])
const armed = atom({ plugin: 'feishu-mod', key: 'armed' } as const, null as FeishuArmed | null)
const pending = atom({ plugin: 'feishu-mod', key: 'pending' } as const, {} as Record<string, FeishuPendingCard>)
const typing = atom({ plugin: 'feishu-mod', key: 'typing' } as const, {} as Record<string, string>)
const model = atom({ plugin: 'feishu-mod', key: 'model' } as const, '')

type $ = EngineInterface

// The running consumers of this module load; a reload drops them with the module.
const consumers = new Set<AsyncGenerator<unknown, unknown>>()
let loopId = 0
const warnedSenders = new Set<string>()

const STATUS_TEXT: Record<FeishuModStatus, string | undefined> = {
  off: undefined,
  starting: '飞书 ⋯ 连接中',
  listening: '飞书 ● 在线',
  error: '飞书 ✕ 断开，重连中',
}

const DEBUG_LOG = `${DOWNLOADS}/debug.log`
const CLICKS = `${DOWNLOADS}/clicks`

/** To Claude Code's debug log, and to /tmp/feishu-mod/debug.log for when no --debug is on. */
function debug($: $, text: string): void {
  $.ui.log(`${PLUGIN}: ${text}`, { to: 'debug' })
  void $.process.run(['sh', '-c', 'mkdir -p "$1" && cat >> "$2"', 'sh', DOWNLOADS, DEBUG_LOG], {
    stdin: `${new Date().toISOString()} ${text}\n`,
  }).catch(() => undefined)
}
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

async function setStatus($: $, next: FeishuModStatus): Promise<void> {
  await update($, status, () => next)
  $.ui.status(STATUS_TEXT[next])
}

/** Users and chat from settings (`pluginConfigs`), which outlive the store when the plugin is reinstalled. */
let configAllow: string[] = []
let configHome: string | null = null

async function allowList($: $): Promise<string[]> {
  const value = await $.store.get(ALLOW_KEY)
  const stored = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  return [...new Set([...configAllow, ...stored])]
}

async function homeChat($: $): Promise<string | null> {
  const value = await $.store.get(HOME_KEY)
  return typeof value === 'string' && isChatId(value) ? value : configHome
}

/** The bridge routes to Feishu only while it is on and knows where to send. */
async function remoteChat($: $): Promise<string | null> {
  return (await read($, isOn)) ? homeChat($) : null
}

// ── lark-cli ────────────────────────────────────────────────────────────────

function lark($: $, args: string[], init: { cwd?: string; timeoutMs?: number } = {}) {
  return $.process.run([LARK, '--profile', PROFILE, ...args], { timeoutMs: 60_000, ...init })
}

async function react($: $, messageId: string, emoji: string): Promise<string | null> {
  const res = await lark($, [
    'api', 'POST', `/open-apis/im/v1/messages/${messageId}/reactions`, '--as', 'bot',
    '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } }),
  ]).catch(() => undefined)
  if (res && res.exitCode !== 0) debug($, `reaction failed: ${res.stderr || res.stdout}`)
  return res ? (/"reaction_id"\s*:\s*"([^"]+)"/.exec(res.stdout)?.[1] ?? null) : null
}

/** Hermes' processing badge: Typing while working, removed on reply, CrossMark on failure. */
async function startWorking($: $, messageId: string): Promise<void> {
  const id = await react($, messageId, 'Typing')
  if (id) await update($, typing, map => ({ ...map, [messageId]: id }))
}

async function stopWorking($: $, messageId: string, isFailed: boolean): Promise<void> {
  const id = (await read($, typing))[messageId]
  if (id) {
    await update($, typing, map => {
      const { [messageId]: _, ...rest } = map
      return rest
    })
    await lark($, ['api', 'DELETE', `/open-apis/im/v1/messages/${messageId}/reactions/${id}`, '--as', 'bot']).catch(() => undefined)
  }
  if (isFailed) await react($, messageId, 'CrossMark')
}

async function reply($: $, messageId: string, text: string): Promise<boolean> {
  for (const [i, piece] of chunkReply(text).entries()) {
    const res = await lark($, [
      'im', '+messages-reply', '--as', 'bot', '--message-id', messageId,
      '--markdown', piece, '--idempotency-key', `${messageId}-${i}`.slice(0, 50),
    ])
    if (res.exitCode !== 0) {
      $.ui.toast(`飞书回复失败：${(res.stderr || res.stdout).slice(0, 300)}`)
      return false
    }
  }
  return true
}

async function replyImage($: $, messageId: string, path: string): Promise<void> {
  const cut = path.lastIndexOf('/')
  const res = await lark($, ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--image', path.slice(cut + 1)], {
    cwd: path.slice(0, cut) || '/',
  })
  if (res.exitCode !== 0) debug($, `image reply failed: ${res.stderr || res.stdout}`)
}

async function sendMarkdown($: $, chatId: string, text: string): Promise<string | null> {
  const res = await lark($, ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--markdown', text])
  if (res.exitCode !== 0) debug($, `send failed: ${res.stderr || res.stdout}`)
  return sentMessageId(res.stdout)
}

async function sendCard($: $, chatId: string, card: Card): Promise<string | null> {
  const res = await lark($, [
    'im', '+messages-send', '--as', 'bot', '--chat-id', chatId,
    '--msg-type', 'interactive', '--content', JSON.stringify(card),
  ])
  if (res.exitCode !== 0) $.ui.toast(`飞书卡片发送失败：${(res.stderr || res.stdout).slice(0, 300)}`)
  return sentMessageId(res.stdout)
}

async function patchCard($: $, messageId: string, card: Card): Promise<void> {
  const res = await lark($, [
    'api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--as', 'bot',
    '--data', JSON.stringify({ content: JSON.stringify(card) }),
  ]).catch(() => undefined)
  if (res && res.exitCode !== 0) debug($, `card update failed: ${res.stderr || res.stdout}`)
}

/**
 * Waits for a click on the card tagged `id` by an allowed user. Feishu lets one
 * consumer hold card.action.trigger, so the standing listener writes each click
 * to CLICKS/<id>.json and this waits for that file in a shell `$.process.run`,
 * which costs the calling hook none of its own time budget.
 */
async function waitCardAction($: $, id: string, seconds: number): Promise<Record<string, unknown> | null> {
  const deadline = (await $.clock.now()) + seconds * 1000
  const file = `${CLICKS}/${id}.json`
  for (;;) {
    // The card was settled at the computer, or the bridge went off: stop waiting.
    if (!(await read($, pending))[id] || !(await read($, isOn))) return null
    const left = Math.floor((deadline - (await $.clock.now())) / 1000)
    if (left < 2) return null
    const slice = Math.min(left, CARD_SLICE_S)
    const res = await $.process.run(
      ['sh', '-c', 'i=0; while [ "$i" -lt "$2" ]; do if [ -f "$1" ]; then cat "$1"; rm -f "$1"; exit 0; fi; sleep 1; i=$((i+1)); done', 'sh', file, String(slice)],
      { timeoutMs: slice * 1000 + 15_000 },
    ).catch(err => {
      debug($, `card wait failed: ${String(err)}`)
      return null
    })
    if (!res || res.exitCode !== 0) return null
    const ev = parseObject(res.stdout.trim())
    if (!ev) continue
    if ((await allowList($)).includes(String(ev.operator_id ?? ''))) return ev
    debug($, `ignored a card click by ${String(ev.operator_id)}`)
  }
}

/** Every card click arrives here: settings act at once, the rest go to their waiter. */
async function handleCardClick($: $, ev: Record<string, unknown>): Promise<void> {
  const value = parseObject(String(ev.action_value ?? '')) ?? {}
  debug($, `card click kind=${String(value.kind)} by ${String(ev.operator_id)}`)
  if (value.kind === 'config') return handleConfigClick($, ev)
  const id = typeof value.rid === 'string' && /^[0-9a-f]{16}$/.test(value.rid) ? value.rid : null
  if (!id || !(await read($, pending))[id]) return
  await $.process.run(['sh', '-c', 'mkdir -p "$1" && cat > "$2.tmp" && mv "$2.tmp" "$2"', 'sh', CLICKS, `${CLICKS}/${id}.json`], {
    stdin: JSON.stringify(ev),
  })
}

async function forget($: $, id: string): Promise<FeishuPendingCard | undefined> {
  const card = (await read($, pending))[id]
  await update($, pending, map => {
    const { [id]: _, ...rest } = map
    return rest
  })
  return card
}

// ── inbound ─────────────────────────────────────────────────────────────────

async function downloadResources($: $, m: FeishuMessage): Promise<string[]> {
  if (!MEDIA_TYPES.has(m.messageType)) return []
  const raw = await lark($, ['api', 'GET', `/open-apis/im/v1/messages/${m.messageId}`, '--as', 'bot'])
  const data = parseObject(raw.stdout)?.data as { items?: Array<{ body?: { content?: string } }> } | undefined
  const body = parseObject(data?.items?.[0]?.body?.content ?? '')
  const resources = findResources(body).slice(0, 10)
  if (!resources.length) return []
  const dir = `${DOWNLOADS}/${m.messageId}`
  await $.process.run(['mkdir', '-p', dir])
  for (const r of resources) {
    const res = await lark($, [
      'im', '+messages-resources-download', '--as', 'bot', '--message-id', m.messageId,
      '--file-key', r.key, '--type', r.type, '--output', `${dir}/${safeName(r)}`,
    ], { timeoutMs: 120_000 })
    if (res.exitCode !== 0 && r.type === 'image') {
      debug($, `download ${r.key} as image failed, retrying as file`)
      await lark($, [
        'im', '+messages-resources-download', '--as', 'bot', '--message-id', m.messageId,
        '--file-key', r.key, '--type', 'file', '--output', `${dir}/${safeName(r)}`,
      ], { timeoutMs: 120_000 })
    } else if (res.exitCode !== 0) debug($, `download ${r.key} failed: ${res.stderr || res.stdout}`)
  }
  const listed = await $.process.run(['ls', '-1', dir])
  return listed.stdout.split('\n').map(f => f.trim()).filter(Boolean).map(f => `${dir}/${f}`)
}

/** Commands that open a panel at the computer: answered here from the session's own figures. */
/** The machine's offset from UTC in minutes, from `date +%z` (the module's own clock may run in UTC). */
async function localOffset($: $): Promise<number> {
  const out = (await $.process.run(['date', '+%z']).catch(() => null))?.stdout.trim() ?? ''
  const m = /^([+-])(\d{2})(\d{2})$/.exec(out)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}

/** /status, /cost and /usage as a card (text when the card is refused), from the session's own figures. */
async function sendUsage($: $, m: FeishuMessage, full: boolean): Promise<void> {
  const u = await $.session.usage()
  const now = await $.clock.now()
  const offset = await localOffset($)
  const cwd = full ? await $.session.cwd() : undefined
  const home = cwd ? /^\/(?:Users|home)\/[^/]+/.exec(cwd)?.[0] : undefined
  const version = full ? (await $.session.version()).version : undefined
  const usedModel = (await read($, model)) || undefined
  const pct = u.context.percent ?? (u.context.tokens !== undefined ? (u.context.tokens / u.context.window) * 100 : undefined)
  const card = statusCard({
    title: full && version ? `Claude Code ${version}` : 'Claude Code',
    costUsd: u.cost?.usd,
    contextPercent: pct,
    contextText: `${tokens(u.context.tokens)} / ${tokens(u.context.window)}`,
    model: usedModel,
    limits: u.rateLimits.map(r => ({
      name: LIMIT_NAMES[r.kind] ?? r.kind,
      percent: r.percentUsed,
      reset: r.resetsAt ? `${localTime(r.resetsAt, offset)} 重置` : undefined,
    })),
    footnote: cwd ? (home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd) : undefined,
  })
  if (await sendCard($, m.chatId, card)) return
  await reply($, m.messageId, formatUsage({ version, cwd, home, model: usedModel, costUsd: u.cost?.usd, context: u.context, rateLimits: u.rateLimits }, now, offset, full))
}

const USAGE_COMMANDS = new Set(['cost', 'usage', 'context', 'stats'])
/** Panels that only make sense at the computer: not run from Feishu at all. */
const LOCAL_ONLY = new Set([
  'resume', 'mcp', 'agents', 'plugin', 'plugins', 'permissions', 'hooks', 'memory', 'login', 'logout',
  'theme', 'ide', 'rewind', 'tasks', 'bashes', 'export', 'terminal-setup', 'vim', 'keybindings',
  'privacy-settings', 'output-style', 'statusline', 'add-dir', 'install-github-app', 'feedback', 'upgrade',
])

async function configRows($: $, command: string): Promise<ConfigRowView[]> {
  const rows = (await $.config.list()).map(r => ({
    key: r.key, label: r.label, kind: r.kind, value: r.value, options: r.options, isLocked: r.isLocked,
  }))
  if (command === 'model') return rows.filter(r => r.key === 'model')
  return rows.filter(r => r.kind === 'boolean' || r.kind === 'choice').slice(0, 40)
}

const configTitle = (view: string) => (view === 'model' ? '模型' : '设置')

/** /config and /model as a card; its clicks are handled by the standing listener, so it never expires. */
async function configSession($: $, m: FeishuMessage, command: string): Promise<void> {
  const rows = await configRows($, command)
  if (command === 'model' && !rows.length) {
    await reply($, m.messageId, '这里读不到模型设置，请在电脑上用 /model 切换。')
    return
  }
  await sendCard($, m.chatId, configCard(command, configTitle(command), rows, '点按钮或下拉框，立即生效。'))
}

/** One click on any settings card: set the row, then redraw that card. */
async function handleConfigClick($: $, ev: Record<string, unknown>): Promise<void> {
  if (!(await allowList($)).includes(String(ev.operator_id ?? ''))) return
  const value = parseObject(String(ev.action_value ?? '')) ?? {}
  const view = value.view === 'model' ? 'model' : 'config'
  const key = typeof value.key === 'string' ? value.key : ''
  const raw = typeof value.set === 'string' ? value.set : String(ev.option ?? '')
  const row = (await configRows($, view)).find(r => r.key === key)
  let note = ''
  if (row && raw) {
    const res = await $.config.set({ key, value: row.kind === 'boolean' ? raw === 'true' : raw })
    note = res.deny ? `没改成：${res.deny}` : `已把 **${row.label}** 设为 ${String(res.value)}`
    $.ui.toast(`飞书：${note.replace(/\*\*/g, '')}`)
  }
  const cardId = String(ev.message_id ?? '')
  if (isMessageId(cardId)) await patchCard($, cardId, configCard(view, configTitle(view), await configRows($, view), note))
}

async function helpText($: $): Promise<string> {
  const list = await $.command.list()
  return list.slice(0, 80).map(c => `/${c.name} — ${c.description.slice(0, 60)}`).join('\n')
}
const COMMAND_WAIT_MS = 30_000

async function runSlash($: $, m: FeishuMessage, command: string, args: string): Promise<void> {
  if (command === 'feishu') {
    await reply($, m.messageId, await feishuCommand($, args))
    return
  }
  if (USAGE_COMMANDS.has(command)) {
    await sendUsage($, m, false)
    return
  }
  if (command === 'config' || command === 'model') return configSession($, m, command)
  if (command === 'status') return sendUsage($, m, true)
  if (command === 'help') return void (await reply($, m.messageId, await helpText($)))
  if (LOCAL_ONLY.has(command)) {
    await reply($, m.messageId, `/${command} 是电脑上的交互界面，需要在电脑上操作。`)
    return
  }
  await startWorking($, m.messageId)
  // A command that starts a turn (a skill, a prompt command) answers there.
  await update($, armed, () => ({ messageId: m.messageId, until: Date.now() + 60_000 }))
  try {
    const ran = $.command.run({ command, args }).then(r => (r.text ?? '').trim())
    const out = await Promise.race([ran, $.clock.sleep(COMMAND_WAIT_MS).then(() => null)])
    if (out === null) {
      void ran.catch(() => undefined)
      await update($, armed, a => (a?.messageId === m.messageId ? null : a))
      await reply($, m.messageId, `/${command} 在电脑上打开了交互界面，飞书里显示不了，请到电脑上查看（按 Esc 关闭）。`)
      await stopWorking($, m.messageId, false)
      return
    }
    if (out) await reply($, m.messageId, '```\n' + out.slice(0, 6000) + '\n```')
    // A turn the command started took the armed message and answers it; otherwise we are done.
    const startedTurn = Object.values(await read($, turns)).includes(m.messageId)
    if (!startedTurn) {
      await update($, armed, a => (a?.messageId === m.messageId ? null : a))
      if (!out) await reply($, m.messageId, `/${command} 已执行。`)
      await stopWorking($, m.messageId, false)
    }
  } catch (err) {
    await update($, armed, () => null)
    await reply($, m.messageId, `/${command} 执行失败：${String(err).slice(0, 500)}`)
    await stopWorking($, m.messageId, true)
  }
}

async function handle($: $, m: FeishuMessage): Promise<void> {
  debug($, `event ${m.messageId} from ${m.senderId} (${m.chatType}/${m.messageType})`)
  if (m.senderType && m.senderType !== 'user') return
  if ((await read($, seen)).includes(m.messageId)) return
  await update($, seen, list => [...list, m.messageId].slice(-200))

  if (!(await allowList($)).includes(m.senderId)) {
    await $.store.set(LAST_KEY, m.senderId)
    if (!warnedSenders.has(m.senderId)) {
      warnedSenders.add(m.senderId)
      $.ui.toast(`飞书：未授权的发送者 ${m.senderId}。确认是你本人后运行 /feishu allow last`)
    }
    return
  }
  if (m.chatType === 'p2p' && isChatId(m.chatId)) await $.store.set(HOME_KEY, m.chatId)

  const slash = m.messageType === 'text' ? parseSlash(m.content) : null
  if (slash) {
    void runSlash($, m, slash.command, slash.args).catch(err => debug($, `slash: ${String(err)}`))
    return
  }

  await startWorking($, m.messageId)
  const files = await downloadResources($, m).catch(err => {
    debug($, `download: ${String(err)}`)
    return [] as string[]
  })
  if (!m.content.trim() && !files.length) return stopWorking($, m.messageId, false)
  await $.prompt.submit({ text: buildPrompt(m, files), asUser: true })
}

/** Keeps one `lark-cli event consume` running while the bridge is on, line by line. */
async function runStream(
  $: $,
  id: number,
  args: string[],
  onLine: (line: string) => Promise<void>,
  isPrimary: boolean,
): Promise<void> {
  while (id === loopId && (await read($, isOn))) {
    if (isPrimary) await setStatus($, 'starting')
    let buffer = ''
    try {
      // An unbounded consume exits when stdin closes; a timeout makes it ignore that.
      const stream = $.process.spawn({ argv: [LARK, '--profile', PROFILE, 'event', 'consume', ...args, '--as', 'bot', '--timeout', '720h'] })
      consumers.add(stream)
      try {
        for await (const chunk of stream) {
          if (id !== loopId) break
          if (isPrimary && (await read($, status)) !== 'listening') await setStatus($, 'listening')
          if (chunk.stream === 'stderr') {
            debug($, chunk.text.trim())
            continue
          }
          const { lines, rest } = splitLines(buffer, chunk.text)
          buffer = rest
          for (const line of lines) await onLine(line).catch(err => debug($, String(err)))
        }
      } finally {
        consumers.delete(stream)
      }
    } catch (err) {
      debug($, `consumer ${args[0]} failed: ${String(err)}`)
    }
    if (id !== loopId || !(await read($, isOn))) break
    if (isPrimary) await setStatus($, 'error')
    await $.clock.sleep(5000)
  }
}

async function runConsumer($: $): Promise<void> {
  const id = ++loopId
  await Promise.all([
    runStream($, id, ['im.message.receive_v1'], async line => {
      const message = parseEvent(line)
      if (message) await handle($, message)
    }, true),
    runStream($, id, ['card.action.trigger'], async line => {
      const ev = parseObject(line)
      if (ev) await handleCardClick($, ev)
    }, false),
  ])
}

async function stopConsumer($: $): Promise<void> {
  loopId++
  const running = [...consumers]
  consumers.clear()
  await Promise.all(running.map(s => s.return(undefined).catch(() => undefined)))
  await setStatus($, 'off')
}

// ── /feishu ─────────────────────────────────────────────────────────────────

async function feishuCommand($: $, argText: string): Promise<string> {
  const [verb = 'status', arg = ''] = argText.trim().split(/\s+/)
  switch (verb) {
    case 'on': {
      if (await read($, isOn)) return '飞书桥接已经开着。'
      await update($, isOn, () => true)
      void runConsumer($).catch(() => undefined)
      const allowed = await allowList($)
      return allowed.length
        ? `飞书桥接已开启（profile ${PROFILE}），授权用户 ${allowed.length} 个。`
        : `飞书桥接已开启（profile ${PROFILE}）。还没有授权用户：先给机器人发一条消息，再运行 /feishu allow last。`
    }
    case 'off':
      await update($, isOn, () => false)
      await stopConsumer($)
      return '飞书桥接已关闭。'
    case 'allow':
    case 'deny': {
      const last = await $.store.get(LAST_KEY)
      const target = arg === 'last' && typeof last === 'string' ? last : arg
      if (!isOpenId(target)) return '需要一个 open_id（ou_xxx），或用 last 表示最近一个未授权的发送者。'
      const list = await allowList($)
      const nextList = verb === 'allow' ? [...new Set([...list, target])] : list.filter(x => x !== target)
      await $.store.set(ALLOW_KEY, nextList)
      if (verb === 'deny' && configAllow.includes(target))
        return `${target} 写在设置的 allowedUsers 里，仍然有效；要移除请改 settings.json 的 pluginConfigs。`
      return `${verb === 'allow' ? '已授权' : '已移除'} ${target}。当前授权：${nextList.join(', ') || '无'}`
    }
    default:
      return [
        `状态：${await read($, status)}（profile ${PROFILE}）`,
        `授权用户：${(await allowList($)).join(', ') || '无'}`,
        `飞书会话：${(await homeChat($)) ?? '未知（先在飞书私聊机器人一次）'}`,
        `等待中的飞书卡片：${Object.keys(await read($, pending)).length}`,
        `最近未授权的发送者：${String((await $.store.get(LAST_KEY)) ?? '无')}`,
      ].join('\n')
  }
}

// ── hooks ───────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  configAllow = String(options.allowedUsers ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(isOpenId)
  const home = String(options.homeChat ?? '').trim()
  configHome = isChatId(home) ? home : null
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

  on('command.run', { command: 'feishu' }, async ($, e) => ({ text: await feishuCommand($, e.args) }))

  on('prompt.submit', async ($, e, next) => {
    // Our own submissions carry the reply rules as context the person never sees.
    if (e.origin?.kind === 'plugin' && e.origin.name === PLUGIN && markerOf(e.text)) {
      return next({ ...e, context: [...(e.context ?? []), REPLY_GUIDE] })
    }
    // A prompt typed at the computer is mirrored to Feishu, and its answer follows it there.
    const chat = e.origin?.kind === 'composer' ? await remoteChat($) : null
    if (chat && e.text.trim()) {
      const messageId = await sendMarkdown($, chat, `💻 **电脑端**\n${e.text.slice(0, 3000)}`)
      if (messageId && e.turnId) {
        const turnId = e.turnId
        await update($, turns, map => (map[turnId] ? map : { ...map, [turnId]: messageId }))
      } else if (messageId) {
        await update($, mirrored, list => [...list, { text: e.text, messageId }].slice(-20))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    let messageId = markerOf(e.text)
    if (!messageId) {
      const queue = await read($, mirrored)
      const hit = queue.find(q => q.text === e.text || e.text.startsWith(q.text))
      if (hit) {
        messageId = hit.messageId
        await update($, mirrored, list => list.filter(q => q !== hit && q.messageId !== hit.messageId))
      }
    }
    if (!messageId) {
      const pending = await read($, armed)
      if (pending && pending.until > Date.now()) messageId = pending.messageId
      if (pending) await update($, armed, () => null)
    }
    if (messageId) {
      const id = messageId
      await update($, turns, map => ({ ...map, [e.turnId]: id }))
    }
    return next(e)
  })

  // turn.complete's answer is only the last message; the text written between
  // tool calls is collected here, step by step, so Feishu gets all of it.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const text = result.answer.trim()
    if (e.agentId || !text) return result
    if (!(await read($, turns))[e.turnId]) return result
    await update($, said, map => ({ ...map, [e.turnId]: [...(map[e.turnId] ?? []), text] }))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const used = e.usage?.model
    if (used) await update($, model, () => used)
    const messageId = (await read($, turns))[e.turnId]
    if (!messageId) return result
    const parts = [...((await read($, said))[e.turnId] ?? [])]
    await update($, turns, map => {
      const { [e.turnId]: _, ...rest } = map
      return rest
    })
    await update($, said, map => {
      const { [e.turnId]: _, ...rest } = map
      return rest
    })

    const final = e.answer.trim()
    if (final && parts[parts.length - 1] !== final) parts.push(final)
    const body = parts.join('\n\n')
    const note =
      e.reason === 'answer' ? ''
      : e.reason === 'aborted' ? '（这一轮在电脑上被中断了）'
      : e.reason === 'refusal' ? '（这一轮被模型拒绝了）'
      : '（这一轮因 API 错误中断）'
    const text = [body, note].filter(Boolean).join('\n\n') || '（本轮没有文字回答）'
    const ok = await reply($, messageId, text)
    if (e.reason === 'answer') {
      for (const path of localImages(body)) {
        const st = await $.fs.stat(path).catch(() => null)
        if (st) await replyImage($, messageId, path)
      }
    }
    await stopWorking($, messageId, !ok || e.reason !== 'answer')
    return result
  })

  // A permission ask (AskUserQuestion included) goes to Feishu while the dialog
  // stays up at the computer: whichever answers first settles it.
  on('classic.PermissionRequest', async ($, e, next) => {
    const chat = await remoteChat($)
    if (!chat) return next(e)
    const input = (typeof e.tool_input === 'object' && e.tool_input !== null ? e.tool_input : {}) as Record<string, unknown>
    const isQuestion = e.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)
    const questions = (isQuestion ? input.questions : []) as AskQuestion[]
    const summary = isQuestion ? '' : describeToolInput(e.tool_name, input)

    const id = rid()
    await update($, pending, map => ({ ...map, [id]: { cardId: '', tool: e.tool_name } }))
    const click = waitCardAction($, id, CARD_WAIT_S)
    const cardId = await sendCard($, chat, isQuestion ? questionCard(id, questions) : approvalCard(id, e.tool_name, summary))
    if (!cardId) {
      await forget($, id)
      return next(e)
    }
    await update($, pending, map => (map[id] ? { ...map, [id]: { cardId, tool: e.tool_name } } : map))

    const ev = await click
    if (!(await forget($, id)) || !ev) {
      // Settled at the computer (its card is updated there), or timed out.
      if (ev === null && (await read($, isOn))) {
        await patchCard($, cardId, resolvedCard('已超时', 'grey', '回到电脑上处理。'))
      }
      return next(e)
    }

    if (isQuestion) {
      const answers = answersFromForm(questions, parseObject(String(ev.form_value ?? '')) ?? {})
      await patchCard($, cardId, resolvedCard('已回答', 'green', answersMarkdown(answers)))
      $.ui.toast('飞书：已回答问题')
      return { decision: { behavior: 'allow' as const, updatedInput: { ...input, answers } } }
    }

    const choice = (parseObject(String(ev.action_value ?? ''))?.choice ?? 'deny') as ApprovalChoice
    const label = choice === 'once' ? '已允许一次' : choice === 'session' ? '本会话不再询问' : '已拒绝'
    await patchCard($, cardId, resolvedCard(`${label}：${e.tool_name}`, choice === 'deny' ? 'red' : 'green', summary))
    $.ui.toast(`飞书：${label} ${e.tool_name}`)
    if (choice === 'deny') return { decision: { behavior: 'deny' as const, message: '用户在飞书上拒绝了这次操作。' } }
    if (choice === 'once') return { decision: { behavior: 'allow' as const } }
    const rules = (e.permission_suggestions ?? []).filter(u => u.type === 'addRules')
    const updatedPermissions = rules.length
      ? rules.map(u => ({ ...u, destination: 'session' as const }))
      : [{ type: 'addRules' as const, rules: [{ toolName: e.tool_name }], behavior: 'allow' as const, destination: 'session' as const }]
    return { decision: { behavior: 'allow' as const, updatedPermissions } }
  }).catch(($, e, next) => next(e))

  // Once a tool call settles, any of its cards still waiting were answered at the computer.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const waiting = Object.entries(await read($, pending)).filter(([, card]) => card.tool === e.tool && card.cardId)
    for (const [id, card] of waiting) {
      await forget($, id)
      await patchCard($, card.cardId, resolvedCard(`已在电脑上处理：${e.tool}`, 'grey', '这张卡片不再需要操作。'))
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the session: keep listening.
    if (e.reason !== 'clear') await stopConsumer($)
    return next(e)
  })
}
