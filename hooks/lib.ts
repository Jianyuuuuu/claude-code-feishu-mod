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

const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,64}$/
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,64}$/
const MARKER = /\[飞书消息 (om_[A-Za-z0-9_-]{1,64})\]/

export const isMessageId = (id: string): boolean => MESSAGE_ID.test(id)
export const isOpenId = (id: string): boolean => OPEN_ID.test(id)

/** Splits streamed stdout into complete lines, keeping the unfinished tail. */
export function splitLines(buffer: string, text: string): { lines: string[]; rest: string } {
  const parts = (buffer + text).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map(line => line.trim()).filter(Boolean), rest }
}

/** One NDJSON line of `lark-cli event consume im.message.receive_v1`, or null. */
export function parseEvent(line: string): FeishuMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
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

/** The prompt the session reads; the marker lets turn.start find the message again. */
export function buildPrompt(m: FeishuMessage): string {
  const where = m.chatType === 'p2p' ? '私聊' : '群聊'
  return `[飞书消息 ${m.messageId}] (${where})\n${m.content}`
}

export function markerOf(text: string): string | null {
  return MARKER.exec(text)?.[1] ?? null
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

export const REPLY_GUIDE = [
  '这条消息来自飞书机器人，你本轮的最终回答会被自动作为飞书回复发回给对方。',
  '用简体中文，结论先行，简短；可以用简单的 Markdown（加粗、列表、代码块），不要用表格。',
  '不要在回答里自己调用 lark-cli 发送回复，桥接会处理。',
].join('\n')
