import { query } from '@anthropic-ai/claude-agent-sdk'
const PROMPT = '不要用任何工具。请在心里穷举所有三位质数中各位数字之和等于 13 的数，逐个验证其质性，然后只回答一行：总共几个。'
async function probe(label, opts) {
  let think = 0, out = 0, txt = ''
  const q = query({ prompt: PROMPT, options: {
    model: 'opus', allowedTools: [], settingSources: [], permissionMode: 'bypassPermissions',
    systemPrompt: '你是一个只做心算的助手，绝不调用工具。', includePartialMessages: false, ...opts } })
  for await (const m of q) {
    if (m.type === 'assistant') for (const c of (m.message?.content || [])) {
      if (c.type === 'thinking') think = Math.max(think, (c.signature || '').length)
      if (c.type === 'text') txt += c.text || ''
      out = Math.max(out, m.message?.usage?.output_tokens || 0)
    }
    if (m.type === 'result') out = Math.max(out, m.usage?.output_tokens || 0)
  }
  console.log(`${label.padEnd(28)} thinkingSig=${String(think).padStart(7)}  output_tokens=${String(out).padStart(6)}  answer=${JSON.stringify(txt.slice(0,40))}`)
  return { think, out }
}
const a = await probe('budgetTokens=1024', { thinking: { type: 'enabled', budgetTokens: 1024 } })
const b = await probe('budgetTokens=16000', { thinking: { type: 'enabled', budgetTokens: 16000 } })
console.log('\n判定：', a.think > 0 && b.think > a.think * 2 ? '✅ budgetTokens 真的在控思考量（小预算显著更短）' : '⚠️ 两次思考量相近 —— budgetTokens 可能被当成 on/off，需另想办法')
