export type FeishuBridgeStatus = 'off' | 'starting' | 'listening' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'feishu-mod': {
      /** Whether the bridge should be consuming events in this session. */
      isOn: boolean
      status: FeishuBridgeStatus
      /** turnId -> Feishu message_id the turn answers. */
      turns: Record<string, string>
      /** Recently handled message_ids, newest last. */
      seen: string[]
    }
  }
}
