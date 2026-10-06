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
