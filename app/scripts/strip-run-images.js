#!/usr/bin/env node
// 一次性迁移：把已存下的 runs/<id>.jsonl 里工具结果内嵌的 base64 图就地换成占位符 [图片]。
// 缘起：截图/读图类工具把 base64 塞进 tool_result 喂模型看，前端根本不渲染（只取非 image 的 .text），
// 却完整落库 + 每次冷开走 SSE 全量重推 → 单条会话 8MB+、加载卡（尤其过隧道）。见复盘 §3.36 / CHANGELOG。
// 只删「display 用的这份 jsonl 副本」；SDK 给模型 resume 用的 transcript 不在此、一个字节不动。
//
// 用法：node app/scripts/strip-run-images.js [runsDir]   （默认 ../runs，或读 OFFICE_LAB_RUNS_DIR）
//   --dry   只报告能省多少、不写盘
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const dirArg = argv.find(a => !a.startsWith('--'))
const RUNS_DIR = dirArg
  ? path.resolve(dirArg)
  : (process.env.OFFICE_LAB_RUNS_DIR ? path.resolve(process.env.OFFICE_LAB_RUNS_DIR) : path.join(__dirname, '..', 'runs'))

// 只处理 run 事件文件 <14位时间戳>-<6位hex>.jsonl，跳过 conversations.jsonl / wecom-intake.jsonl 等
const RUN_FILE = /^\d{14}-[0-9a-f]{6}\.jsonl$/

// 活跃会话（running / 有后台任务）正在被引擎 append，read→rename 之间的追加会丢 → 跳过它们（只清历史 done 会话）。
// 服务可在跑：本迁移只碰非活跃文件，且用临时文件+原子改名，不与冷开 SSE 读冲突。
function liveRunIds() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, 'index.json'), 'utf8'))
    return new Set(Object.entries(reg).filter(([, r]) => r && (r.status === 'running' || r.bgTasks)).map(([id]) => `${id}.jsonl`))
  } catch { return new Set() }
}

// 与引擎 stripToolResultImages 同口径：tool_result.content 里的 image block → [图片]
function stripLine(obj) {
  if (!obj || obj.type !== 'user') return false
  const content = obj.message && obj.message.content
  if (!Array.isArray(content)) return false
  let hit = false
  for (const block of content) {
    if (!block || block.type !== 'tool_result' || !Array.isArray(block.content)) continue
    block.content = block.content.map(b => {
      if (b && b.type === 'image') { hit = true; return { type: 'text', text: '[图片]' } }
      return b
    })
  }
  return hit
}

function processFile(file) {
  const abs = path.join(RUNS_DIR, file)
  const before = fs.statSync(abs).size
  const lines = fs.readFileSync(abs, 'utf8').split('\n')
  let changed = 0
  const out = lines.map(line => {
    if (!line.trim()) return line
    let obj
    try { obj = JSON.parse(line) } catch { return line }   // 坏行原样保留
    if (stripLine(obj)) { changed++; return JSON.stringify(obj) }
    return line
  })
  if (!changed) return { file, changed: 0, before, after: before }
  const text = out.join('\n')
  const after = Buffer.byteLength(text, 'utf8')
  if (!dry) {
    const tmp = abs + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')   // 临时文件 + 原子改名，避免半写损坏
    fs.renameSync(tmp, abs)
  }
  return { file, changed, before, after }
}

function main() {
  if (!fs.existsSync(RUNS_DIR)) { console.error('runs 目录不存在：', RUNS_DIR); process.exit(1) }
  const live = liveRunIds()
  const files = fs.readdirSync(RUNS_DIR).filter(f => RUN_FILE.test(f) && !live.has(f))
  const mb = n => (n / 1024 / 1024).toFixed(2) + 'MB'
  let totBefore = 0, totAfter = 0, touched = 0
  console.log(`${dry ? '[dry-run] ' : ''}扫描 ${files.length} 个 run 文件 @ ${RUNS_DIR}${live.size ? `（跳过 ${live.size} 个活跃会话）` : ''}\n`)
  for (const f of files) {
    const r = processFile(f)
    totBefore += r.before; totAfter += r.after
    if (r.changed) {
      touched++
      console.log(`  ${f}  ${mb(r.before)} → ${mb(r.after)}  (剥离 ${r.changed} 处图片, 省 ${mb(r.before - r.after)})`)
    }
  }
  console.log(`\n${dry ? '[dry-run] 预计' : '完成'}：${touched}/${files.length} 个文件含内嵌图；总计 ${mb(totBefore)} → ${mb(totAfter)}，省 ${mb(totBefore - totAfter)}`)
  if (dry) console.log('（--dry 未写盘；去掉 --dry 实际执行）')
}

main()
