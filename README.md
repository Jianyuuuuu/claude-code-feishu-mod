# feishu-mod

Chat with Claude Code from Feishu / Lark. Messages you send the bot become turns in the Claude Code session running on your machine, and each answer comes back as a reply in Feishu. Permission prompts and questions show up as interactive cards you can answer from your phone.

This is a Claude Code mod (a function-hooks plugin) built on [lark-cli](https://github.com/larksuite/cli).

## Features

- **Two-way chat.** Direct messages become prompts, and the answer is posted as a reply. While the bridge is on, prompts you type at the computer are mirrored to Feishu (`💻 电脑端`), and their answers are posted there as well.
- **Images and files.** Images, files and images inside rich-text posts are downloaded to `/tmp/feishu-mod/<message_id>/`, and Claude reads them from there. If an answer mentions a local image by its absolute path, that image is sent back.
- **Permission cards.** When Claude needs approval, the local dialog opens as usual and a Feishu card is sent at the same time, with **Allow once / Don't ask again this session / Deny**. You can answer in either place. The first answer wins, and the other side is updated.
- **Question forms.** `AskUserQuestion` (single choice, multiple choice, or free text) is sent as a Feishu form card at the same time as the local dialog.
- **Slash commands from Feishu.** Send `/compact`, `/doctor`, a skill name, and so on. Commands that would open a panel at the computer are adapted for Feishu instead:
  - `/config` and `/model` open a live settings card. Toggles become buttons and choices become selects; each click applies immediately and the card redraws.
  - `/cost`, `/usage`, `/context`, `/stats`, `/status` and `/help` are answered as text.
  - Panels that only work at the computer (`/resume`, `/mcp`, `/login`, `/theme`, …) are not run; Feishu is told to use the computer.
- **Status badges.** Incoming messages get a `Typing` reaction while Claude works on them. It is removed when the reply is sent, and `CrossMark` marks a failure.

## Install

In a Claude Code terminal session:

```
/plugin install feishu-mod --marketplace Jianyuuuuu/claude-code-feishu-mod
```

Answer `y` to `Add marketplace?`, then pick a scope (user is the default).

## Set up the Feishu bot

1. Install lark-cli: `npm i -g @larksuite/cli`
2. Create a dedicated app and save it as the `claude-code` profile. The command prints a sign-in link and a QR code:

   ```
   lark-cli config init --new --name claude-code
   ```

3. In the Feishu / Lark developer console:
   - enable the **Bot** capability;
   - **Events**: under event configuration, choose **long connection** and add `im.message.receive_v1`;
   - **Callbacks**: under callback configuration (a separate tab), choose **long connection** and add **card action** (`card.action.trigger`). Without it, card buttons do nothing;
   - **Scopes**: `im:message`, `im:message:readonly`, `im:message.p2p_msg:readonly`, `im:message:send_as_bot`, `im:message.reactions:write_only`;
   - publish a version whose availability includes you.

   To check the setup: `lark-cli --profile claude-code event consume card.action.trigger --as bot --dry-run` should report every precondition as `ok`.

> Use a dedicated app. When several long-connection clients subscribe to the same app, each event is delivered to only one of them at random.

## Usage

| Command | What it does |
| --- | --- |
| `/feishu on` | Start the bridge in this session (the status line shows `飞书 ● 在线`) |
| `/feishu off` | Stop it |
| `/feishu status` | Connection, allowed users, the Feishu chat in use, cards waiting |
| `/feishu allow last` | Allow the most recent unknown sender (or pass an `ou_…` open_id) |
| `/feishu deny ou_xxx` | Remove a user from the allow list |

First run: `/feishu on`, send the bot a direct message, run `/feishu allow last`, then message it again. Your last direct chat with the bot becomes the chat that cards and mirrored prompts go to.

To keep the allow list across reinstalls and new sessions, set it in `~/.claude/settings.json` (or `/config`):

```json
"pluginConfigs": {
  "feishu-mod@jianyuuuuu": {
    "options": { "allowedUsers": "ou_xxx,ou_yyy", "homeChat": "oc_xxx" }
  }
}
```

`allowedUsers` adds to the users allowed with `/feishu allow`; `homeChat` is used until a direct message sets the chat.

## How it works

- `lark-cli … event consume im.message.receive_v1` runs in the background and streams NDJSON events. If it exits, it reconnects after 5 seconds.
- Messages from allowed users are de-duplicated by `message_id` and submitted with `$.prompt.submit`. While the session is busy they queue.
- A marker in the prompt (`[飞书消息 om_…]`) ties each turn to its message. On `turn.complete`, the answer is sent with `im +messages-reply --markdown`, split into chunks with idempotency keys.
- Approvals and questions use the `classic.PermissionRequest` hook, which runs while the local dialog is open. The hook sends a card and waits for a matching `card.action.trigger` in 60-second slices. The answer comes back as the hook's decision (`updatedPermissions` with `destination: session` for "don't ask again", or `updatedInput.answers` for questions). If the call is settled at the computer first, a `tool.call` hook marks the card as handled there.
- Only clicks from allowed users count. No message is handled while the allow list is empty. The bridge is off by default in every session, so several open sessions don't all answer the same message.

## Limitations

- The Claude Code session must stay open; replies come from that session.
- Any other command that opens an interactive panel opens it at the computer. After 30 seconds without output, Feishu is told to look there.
- Cards go to the last direct chat with the bot. Group chats are relayed, but they are not used for cards.
- Replies default to Simplified Chinese; the reply guide in `hooks/lib.ts` sets this.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
