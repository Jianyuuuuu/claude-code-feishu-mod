export type FeishuModStatus = 'off' | 'starting' | 'listening' | 'error'

/** A prompt typed at the computer, mirrored to Feishu and waiting for its turn. */
export type FeishuMirrored = { text: string; messageId: string }

/** A card waiting for a click: the sent card's message_id ('' while sending) and its tool. */
export type FeishuPendingCard = { cardId: string; tool: string }

/** A Feishu slash command's message, answered by the next turn it starts. */
export type FeishuArmed = { messageId: string; until: number }

declare module 'claude-code' {
  interface PluginState {
    'feishu-mod': {
      /** Whether the bridge should be consuming events in this session. */
      isOn: boolean
      status: FeishuModStatus
      /** turnId -> the Feishu message_id the turn's answer replies to. */
      turns: Record<string, string>
      /** turnId -> the visible text of each step so far, for a turn bound to Feishu. */
      said: Record<string, string[]>
      /** Recently handled message_ids, newest last. */
      seen: string[]
      mirrored: FeishuMirrored[]
      armed: FeishuArmed | null
      /** rid -> a card waiting for a click. */
      pending: Record<string, FeishuPendingCard>
      /** message_id -> the reaction_id of its Typing badge. */
      typing: Record<string, string>
      /** The model the last main-loop turn ran on. */
      model: string
    }
  }
}
