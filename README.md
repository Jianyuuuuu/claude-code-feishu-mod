# feishu-mod

Chat with Claude Code from Feishu / Lark. Direct messages sent to your bot are submitted as a turn in the Claude Code session running on your machine, and the answer is posted back as a reply to the original message.

It is a Claude Code mod (a function-hooks plugin) built on [lark-cli](https://github.com/larksuite/cli).

## Install

In a Claude Code terminal session:

```
/plugin install feishu-mod --marketplace Jianyuuuuu/claude-code-feishu-mod
```

Answer `y` to `Add marketplace?`, then pick a scope (user is the default).

## Set up the Feishu bot

1. Install lark-cli: `npm i -g @larksuite/cli`
2. Create a dedicated app and save it as the `claude-code` profile (it prints a sign-in link and QR code):

   ```
   lark-cli config init --new --name claude-code
   ```

3. In the Feishu / Lark developer console:
   - enable the **Bot** capability;
   - under event subscriptions, choose **long connection (WebSocket)** and add `im.message.receive_v1`;
   - grant the scopes `im:message`, `im:message.p2p_msg:readonly`, `im:message:send_as_bot` and `im:message.reactions:write_only`;
   - publish a version whose availability includes you.

> Use a dedicated app. When several long-connection clients subscribe to the same app, each event is delivered to only one of them at random.

## Usage

| Command | What it does |
| --- | --- |
| `/feishu on` | Start receiving Feishu messages in this session (the status line shows `飞书 ● 在线`) |
| `/feishu off` | Stop |
| `/feishu status` | Connection state, allowed users, and the last unknown sender |
| `/feishu allow last` | Allow the most recent unknown sender (or pass an `ou_…` open_id) |
| `/feishu deny ou_xxx` | Remove a user from the allow list |

First run: `/feishu on`, send the bot a direct message, run `/feishu allow last`, then message it again.

## How it works

- The session runs `lark-cli --profile claude-code event consume im.message.receive_v1 --as bot` in the background, reading NDJSON events line by line. If the process exits, it reconnects after 5 seconds.
- Messages from allowed users are de-duplicated by `message_id`, get an `OnIt` reaction, and are submitted with `$.prompt.submit`. If the session is busy, they wait in the queue.
- On `turn.complete`, the final answer is sent with `lark-cli im +messages-reply --markdown` as a reply to the original message. Long answers are split into chunks, each with an idempotency key. A `DONE` reaction follows once the reply is sent.
- No message is handled while the allow list is empty. The bridge is off by default in every session, so that several open sessions don't all answer the same message.

## Limitations

- The Claude Code session must stay open; replies come from that session.
- Only the text of a message is relayed. Images and files appear as placeholders.
- Replies are written in Simplified Chinese by default, set by the reply guide in `hooks/lib.ts`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
