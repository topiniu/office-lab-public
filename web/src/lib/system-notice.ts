// 系统唤起消息（【系统·…】开头，引擎代发给员工的批次结果/异常通知）的结构化解析。
// 这类消息的正文是写给 AI 看的操作指令（工具名、SOP 条款、红线提醒），原样铺给人看就是一屏长文；
// 前端把它拆成「标题 + 关键数字 + 逐项结果 + 下一步」渲染成卡片，原文只进折叠区。
// 只做展示层解析——模型实际收到的消息不动；解析失败一律回退到通用卡（标题 + 首句）。
// 文本格式的唯一事实源：app/e2e-batch.js buildWakePrompt / server.js finishE2eBatch。

export type E2eCase = {
  ok: boolean
  label: string
  session?: string
  status?: string
  failure?: string   // 首个失败一行
  error?: string     // 提交/执行异常
  calibration?: boolean  // RED 校准件：故意带错误预期跑，红=护栏有效（ok 表示判定符合预期）
  verdict?: string       // 如期红 / 意外通过 / 无效红
}

export type SystemNotice =
  | {
      kind: 'e2e-batch'
      title: string
      batchId: string
      total: number
      concurrency: number
      minutes: string
      green: number
      red: number
      cases: E2eCase[]
      scanCount: number   // 需要做「页面一眼巡检」的绿件数
      calTotal: number    // RED 校准件数（不计入 green/red）
      calOk: number       // 其中如期红
      calLegacy: boolean  // 旧消息：只知红/绿、不知失败类型，「如期」无从判定
    }
  | { kind: 'generic'; title: string; summary: string }

const SYS_HEAD = /^\s*【系统·([^】]+)】\s*/
const E2E_HEAD = /批次\s*(\S+?)：(\d+)\s*个用例文件，并发\s*(\d+)，墙钟\s*([\d.]+)min。绿\s*(\d+)\s*\/\s*红\s*(\d+)/
const CAL_HEAD = /RED 校准\s*(\d+)：如期红\s*(\d+)/

export function parseSystemNotice(text: string): SystemNotice | null {
  const src = String(text || '').trim()
  const m = src.match(SYS_HEAD)
  if (!m) return null
  const title = m[1].trim()
  const rest = src.slice(m[0].length)
  const h = rest.match(E2E_HEAD)
  if (/E2E 批次已全部结束/.test(title) && h) {
    const cases: E2eCase[] = []
    let section: 'ok' | 'red' | 'cal' | '' = ''
    for (const raw of rest.split('\n')) {
      const line = raw.replace(/\s+$/, '')
      if (/^✅/.test(line.trim())) { section = 'ok'; continue }
      if (/^❌/.test(line.trim())) { section = 'red'; continue }
      if (/^🎯/.test(line.trim())) { section = 'cal'; continue }
      if (/^👁|^下一步/.test(line.trim())) { section = ''; continue }
      if (!section) continue
      const item = line.match(/^ {2}· (.+)$/)
      if (item) {
        const [label, ...kv] = item[1].split('　')
        const field = (k: string) => kv.map((s) => s.match(new RegExp(`^${k}=(.*)$`))?.[1]).find(Boolean)
        const session = field('session')
        if (section === 'cal') {
          const verdict = field('verdict') || ''
          cases.push({ ok: verdict === '如期红', calibration: true, verdict, label: label.trim(), session: session && session !== '?' ? session : undefined })
          continue
        }
        cases.push({
          ok: section === 'ok',
          label: label.trim(),
          session: session && session !== '?' ? session : undefined,
          status: field('status'),
        })
        continue
      }
      const last = cases[cases.length - 1]
      if (!last || last.ok) continue
      const fail = line.match(/^\s+首个失败：(.+)$/)
      if (fail) last.failure = fail[1].trim()
      const err = line.match(/^\s+提交\/执行异常：(.+)$/)
      if (err) last.error = err[1].trim()
      const why = line.match(/^\s+原因：(.+)$/)
      if (why) last.failure = why[1].trim()
    }
    // 2026-10-27 前的旧消息没有 🎯 段：RED 件混在 ✅/❌ 里——按文件名归组、重算计数，让历史回放也不再显示成一片失败
    let green = +h[5]
    let red = +h[6]
    let calTotal = +(rest.match(CAL_HEAD)?.[1] || 0)
    let calOk = +(rest.match(CAL_HEAD)?.[2] || 0)
    if (!rest.match(CAL_HEAD)) {
      for (const c of cases) {
        if (!/-RED\.json(\(|$)/i.test(c.label)) continue
        c.calibration = true
        c.verdict = c.ok ? '意外通过' : '红（旧消息未判类型）'
        c.ok = !c.ok
        c.failure = undefined
      }
      const cal = cases.filter((c) => c.calibration)
      if (cal.length) {
        calTotal = cal.length
        calOk = cal.filter((c) => c.ok).length
        green = cases.filter((c) => !c.calibration && c.ok).length
        red = cases.filter((c) => !c.calibration && !c.ok).length
      }
    }
    return {
      kind: 'e2e-batch',
      title: 'E2E 批次已结束',
      batchId: h[1],
      total: +h[2],
      concurrency: +h[3],
      minutes: h[4],
      green,
      red,
      cases,
      scanCount: (rest.match(/^\s+· page_scan\(/gm) || []).length,
      calTotal,
      calOk,
      calLegacy: !rest.match(CAL_HEAD) && calTotal > 0,
    }
  }
  // 通用：标题 + 首句（到第一个句号/换行），去 md 强调符
  const first = rest.split('\n').find((l) => l.trim()) || ''
  const sentence = first.split(/(?<=。)/)[0].replace(/\*\*|`/g, '').trim()
  return { kind: 'generic', title, summary: sentence.length > 90 ? sentence.slice(0, 90) + '…' : sentence }
}
