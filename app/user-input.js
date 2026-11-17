// Pending feedback belongs to the current turn, not to the next prompt queue.
export function waitForRunInput(run, { signal, changed = () => {} } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('反馈请求已中断'))
  if (run._userInput) return Promise.reject(new Error('已有反馈请求等待回答'))
  return new Promise((resolve, reject) => {
    const finish = (error, text) => {
      if (run._userInput !== entry) return
      delete run._userInput
      signal?.removeEventListener('abort', abort)
      run._lastActivity = Date.now()
      changed(false)
      error ? reject(error) : resolve(text)
    }
    const abort = () => finish(new Error('反馈请求已中断'))
    const entry = { answer: text => finish(null, text), cancel: () => abort() }
    run._userInput = entry
    signal?.addEventListener('abort', abort, { once: true })
    changed(true)
  })
}

export function answerRunInput(run, text) {
  if (!run._userInput || !String(text || '').trim()) return false
  run._userInput.answer(String(text).trim())
  return true
}

// Conservative: only explicit imperatives acquire a signoff obligation. A
// question about a design, status or possible change must not authorize edits.
export function explicitWorkRequest(text) {
  const t = String(text || '').trim()
  if (/[?？]|(?:吗|么|是否|能否|可否|有没有|会不会|对不对|怎么样|为什么|如何)/.test(t)) return false
  if (/^(?:先|暂时)?(?:别|不要|不用|停止|暂停|只讨论|只解释|只分析)/.test(t)) return false
  return /^(?:(?:请|麻烦)\s*)?(?:(?:你|帮我|给我)\s*)?(?:修改|改一下|改吧|修复|实现|优化|调整|解决|开发|执行|开工|继续(?:做|改|修|实现|执行|推进)|接着(?:做|改|修|实现|执行|推进))/.test(t)
}

// Compatibility for old threads whose model still emits a plain instruction.
// Only an explicit quoted reply token is promoted; never infer a user decision
// from general advice, code examples, or a question about a possible change.
export function feedbackText(text, id) {
  const t = String(text || '')
  if (/```|【等你拍板】/.test(t)) return t
  const match = t.match(/^请[^\n]*?(?:后|完成)[^\n]*?回复[“「"]([^”」"\n]{1,40})[”」"]/)
  if (!match) return t
  return '```olcard\n' + JSON.stringify({ type: 'gate', id: `feedback-${id}`, title: '需要你的操作', question: t,
    options: [{ label: match[1], reply: match[1] }] }) + '\n```\n\n【等你拍板】' + t.replace(/\s+/g, ' ')
}

export const WORK_CONTINUITY_MANDATE = `
## 【执行与反馈】
- 聊天是沟通渠道，不代表禁止开工。用户已要求修改、修复、实现、优化时，直接执行职责内的工作，完成实现、验证和交付；不要只解释原因、列建议、承诺下一步后结束，也不要反复问是否继续。
- 纯咨询、询问现状或讨论是否合理时，先回答；没有修改授权就不自行扩大范围。已有明确授权持续有效，用户追问不会自动撤销未完成任务；发布、真实提交、破坏性操作仍遵守原有红线。
- 真需要用户提供材料、选择或亲手操作才能继续时，必须使用反馈工具或 OL 动作卡；不能只在进度文字里说“请操作后回复”。无固定选项也必须独占一行写【等你拍板】具体事项，让界面生成输入卡。职责内可自行完成的工作不能包装成请示。
- 已授权的执行轮必须用【下一棒】、【交回】或【等你拍板】明确收尾；仍有未完成的职责内工作时继续做。只有全部完成或确实无需动作时才能写【等你拍板】无。
`
