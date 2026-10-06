# feishu-bridge

在飞书 / Lark 里和 Claude Code 对话：给机器人发的私聊消息会作为一轮提问送进你电脑上正在运行的 Claude Code 会话，回答自动回复到原消息下。

A Claude Code mod (function-hooks plugin) that bridges a Feishu/Lark bot to your local Claude Code session using [lark-cli](https://github.com/larksuite/cli).

## 安装

在 Claude Code 终端会话里输入：

```
/plugin install feishu-bridge --marketplace Jianyuuuuu/claude-code-feishu-bridge
```

提示 `Add marketplace?` 时按 `y`，然后选择安装范围（默认 user）。

## 准备飞书机器人

1. 安装 lark-cli：`npm i -g @larksuite/cli`
2. 新建一个专用应用并存为 `claude-code` profile（会给出登录链接 / 二维码）：

   ```
   lark-cli config init --new --name claude-code
   ```

3. 在开放平台确认：开启机器人能力；事件订阅选「长连接」并添加 `im.message.receive_v1`；权限 `im:message`、`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message.reactions:write_only`；发布版本。

> 建议用一个专用应用。同一个 app 被多个长连接客户端订阅时，事件只会随机投递给其中一个。

## 使用

| 命令 | 作用 |
| --- | --- |
| `/feishu on` | 在当前会话开始接收飞书消息（状态栏显示「飞书 ● 在线」） |
| `/feishu off` | 停止 |
| `/feishu status` | 状态、授权用户、最近一个未授权发送者 |
| `/feishu allow last` | 授权最近一个未授权的发送者（也可写 `ou_xxx`） |
| `/feishu deny ou_xxx` | 移除授权 |

首次使用：`/feishu on` → 在飞书私聊机器人发一句 → `/feishu allow last` → 再发消息即可。

## 工作原理

- 会话里后台运行 `lark-cli --profile claude-code event consume im.message.receive_v1 --as bot`，逐行读取 NDJSON 事件，断线 5 秒后自动重连。
- 授权用户的消息按 `message_id` 去重，加 `OnIt` 表情，并以 `$.prompt.submit` 作为一轮提问提交（会话忙时自动排队）。
- `turn.complete` 时把最终回答通过 `lark-cli im +messages-reply --markdown` 回复原消息（超长自动分段、带幂等键），成功后加 `DONE` 表情。
- 白名单为空时不处理任何消息。每个会话默认关闭，需要手动 `/feishu on`，避免多个会话重复回复。

## 开发

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
