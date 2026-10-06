// Feishu interactive cards, as plain JSON. Pure: the tests build and read them.

export type Card = Record<string, unknown>

export type AskQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  options?: ReadonlyArray<{ label: string; description?: string }>
}

const text = (content: string) => ({ tag: 'plain_text', content })

function card1(title: string, template: string, markdown: string, actions?: Card[]): Card {
  const elements: Card[] = [{ tag: 'markdown', content: markdown }]
  if (actions?.length) elements.push({ tag: 'action', actions })
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: text(title), template },
    elements,
  }
}

const button = (label: string, type: string, value: Record<string, string>): Card => ({
  tag: 'button',
  text: text(label),
  type,
  value,
})

export type ApprovalChoice = 'once' | 'session' | 'deny'

export function approvalCard(rid: string, tool: string, summary: string, reason?: string): Card {
  // Answerable here or at the computer, whichever comes first.
  const v = (choice: ApprovalChoice) => ({ rid, kind: 'approval', choice })
  return card1(
    `需要授权：${tool}`,
    'orange',
    [summary, reason ? `\n<font color='grey'>${reason}</font>` : ''].join(''),
    [
      button('✅ 允许一次', 'primary', v('once')),
      button('✅ 本会话不再询问', 'default', v('session')),
      button('❌ 拒绝', 'danger', v('deny')),
    ],
  )
}

export function resolvedCard(title: string, template: 'green' | 'red' | 'grey', markdown: string): Card {
  return card1(title, template, markdown)
}

/** One form for up to four questions: a select (or multi-select) and an "other" box each. */
export function questionCard(rid: string, questions: readonly AskQuestion[]): Card {
  const elements: Card[] = []
  questions.forEach((q, i) => {
    const opts = (q.options ?? []).map((o, j) => ({ text: text(o.label), value: String(j) }))
    const notes = (q.options ?? [])
      .filter(o => o.description)
      .map(o => `- **${o.label}**：${o.description}`)
      .join('\n')
    elements.push({ tag: 'markdown', content: `**${q.header ? `[${q.header}] ` : ''}${q.question}**${notes ? `\n${notes}` : ''}` })
    if (opts.length) {
      elements.push({
        tag: q.multiSelect ? 'multi_select_static' : 'select_static',
        name: `q${i}`,
        placeholder: text(q.multiSelect ? '可多选' : '请选择'),
        options: opts,
        required: false,
        width: 'fill',
      })
    }
    elements.push({
      tag: 'input',
      name: `q${i}_other`,
      placeholder: text(opts.length ? '或者直接写你的回答（可留空）' : '你的回答'),
      required: false,
      width: 'fill',
    })
  })
  elements.push({
    tag: 'button',
    name: 'submit',
    text: text('提交'),
    type: 'primary_filled',
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value: { rid, kind: 'question' } }],
  })
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: { title: text('Claude 想问你'), template: 'blue' },
    body: { elements: [{ tag: 'form', name: 'ask', elements }] },
  }
}

/** Maps a form submission back to AskUserQuestion's answers (question -> label(s)). */
export function answersFromForm(
  questions: readonly AskQuestion[],
  form: Record<string, unknown>,
): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((q, i) => {
    const labels = (q.options ?? []).map(o => o.label)
    const raw = form[`q${i}`]
    const picked = (Array.isArray(raw) ? raw : raw === undefined || raw === '' ? [] : [raw])
      .map(v => labels[Number(v)])
      .filter((l): l is string => typeof l === 'string')
    const other = typeof form[`q${i}_other`] === 'string' ? (form[`q${i}_other`] as string).trim() : ''
    const all = other ? [...picked, other] : picked
    if (all.length) answers[q.question] = all.join(', ')
  })
  return answers
}

export function answersMarkdown(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([q, a]) => `- ${q}\n  **${a}**`)
  return lines.length ? lines.join('\n') : '（未作答）'
}

export type ConfigRowView = {
  key: string
  label: string
  kind: 'boolean' | 'choice' | 'text' | 'number'
  value: boolean | string | number | readonly string[]
  options?: readonly string[]
  isLocked: boolean
}

const show = (v: ConfigRowView['value']): string => (Array.isArray(v) ? v.join(', ') : String(v))

/** A settings card: toggles as buttons, choices as selects; the rest read-only. `view` redraws it. */
export function configCard(view: string, title: string, rows: readonly ConfigRowView[], note?: string): Card {
  const elements: Card[] = []
  if (note) elements.push({ tag: 'markdown', content: note })
  for (const row of rows) {
    const editable = !row.isLocked && (row.kind === 'boolean' || (row.kind === 'choice' && (row.options?.length ?? 0) > 0))
    elements.push({ tag: 'markdown', content: `**${row.label}**：${show(row.value)}${row.isLocked ? '（已锁定）' : ''}` })
    if (!editable) continue
    if (row.kind === 'boolean') {
      const next = row.value === true ? 'false' : 'true'
      elements.push({
        tag: 'action',
        actions: [button(row.value === true ? '关闭' : '开启', row.value === true ? 'default' : 'primary', { kind: 'config', view, key: row.key, set: next })],
      })
    } else {
      elements.push({
        tag: 'action',
        actions: [{
          tag: 'select_static',
          placeholder: text(`选择 ${row.label}`),
          initial_option: typeof row.value === 'string' ? row.value : undefined,
          options: (row.options ?? []).slice(0, 50).map(o => ({ text: text(o), value: o })),
          value: { kind: 'config', view, key: row.key },
        }],
      })
    }
  }
  if (!rows.length) elements.push({ tag: 'markdown', content: '没有可以在飞书里修改的设置。' })
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: text(title), template: 'blue' },
    elements,
  }
}

export type StatusView = {
  title: string
  subtitle?: string
  costUsd?: number
  contextPercent?: number
  contextText: string
  model?: string
  limits: ReadonlyArray<{ name: string; percent: number; reset?: string }>
  footnote?: string
}

const tone = (p: number) => (p >= 80 ? 'red' : p >= 50 ? 'orange' : 'green')
const md = (content: string, align: 'left' | 'center' | 'right' = 'left'): Card => ({ tag: 'markdown', content, text_align: align })
const column = (elements: Card[], weight = 1): Card => ({ tag: 'column', width: 'weighted', weight, vertical_align: 'center', elements })

/** "claude-opus-5-5" -> "Opus 5.5"; anything else as given. */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${(m[1] ?? '').charAt(0).toUpperCase()}${(m[1] ?? '').slice(1)} ${m[2]}.${m[3]}` : id
}

/** /status, /cost, /usage as a small card: one line each, percentages colored. */
export function statusCard(v: StatusView): Card {
  const pct = (p: number) => `<font color='${tone(p)}'>**${Math.round(p)}%**</font>`
  const lines: string[] = []
  const head: string[] = []
  if (v.costUsd !== undefined) head.push(`花费 **$${v.costUsd.toFixed(2)}**`)
  head.push(`上下文 ${v.contextPercent === undefined ? v.contextText : pct(v.contextPercent)}`)
  lines.push(head.join('　'))
  for (const l of v.limits) lines.push(`${l.name} ${pct(l.percent)}${l.reset ? `　<font color='grey'>${l.reset}</font>` : ''}`)
  if (v.footnote) lines.push(`<font color='grey'>${v.footnote}</font>`)
  const title = [v.title, v.model ? prettyModel(v.model) : ''].filter(Boolean).join(' · ')
  return {
    config: { wide_screen_mode: true },
    header: { title: text(title), template: 'blue' },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}
