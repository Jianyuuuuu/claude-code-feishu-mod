// Pure helpers: no `$`, so the tests can call them directly.

export type FeishuMessage = {
  messageId: string
  chatId: string
  chatType: string
  senderId: string
  senderType: string
  messageType: string
  content: string
}

export type Resource = { key: string; type: 'image' | 'file'; name?: string }

const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,64}$/
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,64}$/
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,64}$/
const RESOURCE_KEY = /^(img|file)_[A-Za-z0-9_-]{1,128}$/
const MARKER = /\[飞书消息 (om_[A-Za-z0-9_-]{1,64})\]/

export const isMessageId = (id: string): boolean => MESSAGE_ID.test(id)
export const isOpenId = (id: string): boolean => OPEN_ID.test(id)
export const isChatId = (id: string): boolean => CHAT_ID.test(id)

/** Message types whose files are worth fetching. */
export const MEDIA_TYPES = new Set(['image', 'file', 'post', 'media', 'audio'])

/** Splits streamed stdout into complete lines, keeping the unfinished tail. */
export function splitLines(buffer: string, text: string): { lines: string[]; rest: string } {
  const parts = (buffer + text).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map(line => line.trim()).filter(Boolean), rest }
}

/** One NDJSON line of `lark-cli event consume im.message.receive_v1`, or null. */
export function parseEvent(line: string): FeishuMessage | null {
  const o = parseObject(line)
  if (!o) return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const messageId = str(o.message_id) || str(o.id)
  if (!isMessageId(messageId)) return null
  return {
    messageId,
    chatId: str(o.chat_id),
    chatType: str(o.chat_type),
    senderId: str(o.sender_id),
    senderType: str(o.sender_type),
    messageType: str(o.message_type),
    content: str(o.content),
  }
}

export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The prompt the session reads; the marker lets turn.start find the message again. */
export function buildPrompt(m: FeishuMessage, files: readonly string[] = []): string {
  const where = m.chatType === 'p2p' ? '私聊' : '群聊'
  const lines = [`[飞书消息 ${m.messageId}] (${where})`, m.content]
  if (files.length) {
    lines.push('', '附件已下载到本地（图片可以直接用 Read 查看）：', ...files.map(f => `- ${f}`))
  }
  return lines.join('\n')
}

export function markerOf(text: string): string | null {
  return MARKER.exec(text)?.[1] ?? null
}

/** `/name args` typed in Feishu, or null for an ordinary message. */
export function parseSlash(text: string): { command: string; args: string } | null {
  const m = /^\/([A-Za-z][\w:.-]{0,63})(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { command: m[1] ?? '', args: (m[2] ?? '').trim() } : null
}

/** Every image_key / file_key a raw message body holds, post bodies included. */
export function findResources(body: unknown): Resource[] {
  const out: Resource[] = []
  const seen = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (typeof v !== 'object' || v === null) return
    const o = v as Record<string, unknown>
    const image = o.image_key
    const file = o.file_key
    if (typeof file === 'string' && RESOURCE_KEY.test(file) && !seen.has(file)) {
      seen.add(file)
      out.push({ key: file, type: 'file', name: typeof o.file_name === 'string' ? o.file_name : undefined })
    } else if (typeof image === 'string' && RESOURCE_KEY.test(image) && !seen.has(image)) {
      seen.add(image)
      out.push({ key: image, type: 'image' })
    }
    Object.values(o).forEach(walk)
  }
  walk(body)
  return out
}

/** A file name safe to write under the download folder. */
export function safeName(r: Resource): string {
  const base = (r.name ?? r.key).replace(/[^\w.\-一-鿿]+/g, '_').replace(/^\.+/, '').slice(0, 120)
  return base || r.key
}

/** Absolute paths of local images an answer mentions, in order, without repeats. */
export function localImages(answer: string): string[] {
  const found = answer.match(/\/[^\s`'"()<>\[\]]+\.(?:png|jpe?g|gif|webp)\b/gi) ?? []
  return [...new Set(found)].filter(p => !p.includes('..')).slice(0, 5)
}

/** The message_id a lark-cli send or reply printed, if any. */
export function sentMessageId(stdout: string): string | null {
  return /"message_id"\s*:\s*"(om_[A-Za-z0-9_-]{1,64})"/.exec(stdout)?.[1] ?? null
}

/** Cuts a reply into pieces Feishu accepts, preferring paragraph then line breaks. */
export function chunkReply(text: string, max = 3500): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf('\n\n')
    if (cut < max / 2) cut = window.lastIndexOf('\n')
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/** A short, readable summary of a tool call for an approval card. */
export function describeToolInput(tool: string, input: unknown): string {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const clip = (s: string, n = 1500): string => (s.length > n ? `${s.slice(0, n)}…` : s)
  if (tool === 'Bash') {
    const desc = pick('description')
    return `${desc ? `${desc}\n` : ''}\`\`\`bash\n${clip(pick('command'))}\n\`\`\``
  }
  const path = pick('file_path') || pick('notebook_path') || pick('path')
  if (path) return `\`${path}\``
  const url = pick('url')
  if (url) return url
  return `\`\`\`json\n${clip(JSON.stringify(o, null, 2))}\n\`\`\``
}

export const REPLY_GUIDE = [
  '这条消息来自飞书机器人，你本轮的最终回答会被自动作为飞书回复发回给对方。',
  '用简体中文，结论先行，简短；可以用简单的 Markdown（加粗、列表、代码块），不要用表格。',
  '不要在回答里自己调用 lark-cli 发送回复，桥接会处理。要发图片给对方时，在回答里写出图片的本地绝对路径即可。',
].join('\n')

export type UsageView = {
  version?: string
  cwd?: string
  home?: string
  model?: string
  costUsd?: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: ReadonlyArray<{ kind: string; percentUsed: number; resetsAt?: string }>
}

export const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5 小时额度',
  seven_day: '7 天额度',
  seven_day_opus: '7 天额度（Opus）',
  seven_day_sonnet: '7 天额度（Sonnet）',
  spend_limit: '花费上限',
}

export const tokens = (n?: number): string =>
  n === undefined ? '?' : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n)

export function bar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/** "2 小时 59 分后" / "3 天 7 小时后", from now until `iso`. */
export function untilText(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return '即将'
  const min = Math.round(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d) return `${d} 天${h ? ` ${h} 小时` : ''}后`
  if (h) return `${h} 小时${m ? ` ${m} 分` : ''}后`
  return `${m} 分钟后`
}

/** Local wall time of `iso`, "10/7 02:10", in the given offset (minutes east of UTC). */
export function localTime(iso: string, offsetMin: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + offsetMin * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** The usage / status reply, as Feishu markdown. `full` adds version, directory and model. */
export function formatUsage(u: UsageView, now: number, offsetMin: number, full: boolean): string {
  const lines: string[] = []
  if (full && u.version) lines.push(`**Claude Code ${u.version}**`)
  if (full && u.cwd) lines.push(`📁 ${u.home && u.cwd.startsWith(u.home) ? `~${u.cwd.slice(u.home.length)}` : u.cwd}`)
  if (full && u.model) lines.push(`🧠 模型：${u.model}`)
  if (u.costUsd !== undefined) lines.push(`💰 本会话花费：**$${u.costUsd.toFixed(2)}**`)
  const pct = u.context.percent ?? (u.context.tokens !== undefined ? (u.context.tokens / u.context.window) * 100 : undefined)
  lines.push(`📊 上下文：${tokens(u.context.tokens)} / ${tokens(u.context.window)}${pct === undefined ? '' : `（${Math.round(pct)}%）`}`)
  if (pct !== undefined) lines.push(bar(pct))
  if (u.rateLimits.length) lines.push('')
  for (const r of u.rateLimits) {
    const name = LIMIT_NAMES[r.kind] ?? r.kind
    const warn = r.percentUsed >= 80 ? ' ⚠️' : ''
    const reset = r.resetsAt ? `，${untilText(r.resetsAt, now)}重置（${localTime(r.resetsAt, offsetMin)}）` : ''
    lines.push(`⏱ ${name}：已用 **${Math.round(r.percentUsed)}%**${warn}${reset}`)
    lines.push(bar(r.percentUsed))
  }
  return lines.join('\n')
}
