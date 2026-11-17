import { isEmptyGateItem } from './markers'
import type { Run } from './types'

// 需求条目生命周期 → 看板列（server.js ENTRY_STATUS_ENUM）。
export type KanbanColumn = { id: string; title: string; statuses: string[] }

export const KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'intake', title: '需求梳理', statuses: ['待梳理', '需求确认'] },
  { id: 'dev', title: '开发', statuses: ['待开发', '开发中', '已定稿', '已开发'] },
  {
    id: 'qa',
    title: '测试 / QA',
    statuses: ['待审', '待QA', 'QA中', '待测', '待预检', '待复验'],
  },
  { id: 'gate', title: '验收门禁', statuses: ['待人工', '待人工验收', '人工Pass', 'QA通过'] },
  { id: 'blocked', title: '阻塞 / 打回', statuses: ['阻塞', '打回'] },
  { id: 'done', title: '已完成', statuses: ['已上线', '已归档'] },
]

// 条目状态 → 「球在谁手里」（下一棒归属）。原样搬自旧 UI `app/public/app.js` 的 `ENTRY_STATUS.next`
// —— 那份键集是权威枚举，须与 `server.js ENTRY_STATUS_ENUM`、`文档格式规范.md` 状态枚举表三处一致。
// 新 UI 此前把这一列整个丢了，于是「这条现在卡在谁手里」在看板上无处可读（只能一条条点开档案），
// 窄屏第二行也因此只剩三样东西、右边空一大片。'manual' = 待老板、null = 已终结。
const ENTRY_NEXT: Record<string, string | null> = {
  待梳理: 'feifei',
  需求确认: 'ggbond',
  待开发: 'ggbond',
  开发中: 'ggbond',
  已定稿: 'ggbond',
  待审: 'ggbond',
  已开发: 'mihu',
  QA中: 'mihu',
  待QA: 'mihu',
  待测: 'mihu',
  待人工: 'manual',
  待预检: 'manual',
  待复验: 'manual',
  已跳过: 'manual',
  已隔离: 'manual',
  待人工验收: 'manual',
  打回: 'ggbond',
  阻塞: 'manual', // 旧 UI 是 'auto'（按 stage 文字猜）；看板一行放不下猜的过程，统一显「待老板」
  人工Pass: null,
  QA通过: null,
  已上线: null,
  已归档: null,
}

export type EntryBall =
  | { kind: 'done' }
  | { kind: 'boss' }
  | { kind: 'employee'; employee: string }
  | { kind: 'unknown' }

export function entryBall(status: string): EntryBall {
  const next = ENTRY_NEXT[status]
  if (next === null) return { kind: 'done' }
  if (next === 'manual') return { kind: 'boss' }
  if (next) return { kind: 'employee', employee: next }
  return { kind: 'unknown' } // 未收录的自造状态
}

const STATUS_TO_COLUMN = new Map<string, string>()
for (const col of KANBAN_COLUMNS) for (const s of col.statuses) STATUS_TO_COLUMN.set(s, col.id)

export function columnOf(status: string): string {
  return STATUS_TO_COLUMN.get(status) ?? 'dev'
}

// Badge 语义色 —— 复用 shadcn 内置 variant，保证明暗两套都稳。
export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

export function statusVariant(status: string): BadgeVariant {
  if (status === '阻塞' || status === '打回') return 'destructive'
  if (status === '已上线' || status === 'QA通过' || status === '人工Pass') return 'default'
  if (status === '已归档') return 'secondary'
  if (status.includes('中')) return 'default' // 开发中 / QA中
  return 'outline' // 各类「待…」
}

// 语义色调（对齐旧 UI：通过=绿 / 阻塞打回=红 / 进行中=琥珀 / 归档=灰 / 待=描边）
// 薰衣草为品牌主色、不用于状态，避免与「进行/通过」语义混淆。
export function statusTone(status: string): string {
  if (status === '阻塞' || status === '打回')
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  if (status === 'QA通过' || status === '人工Pass' || status === '已上线')
    return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
  if (status === '已归档') return 'border-transparent bg-muted text-muted-foreground'
  if (status.includes('中'))
    return 'border-amber-500/30 bg-amber-500/12 text-amber-600 dark:text-amber-400'
  return 'border-border bg-transparent text-muted-foreground' // 待…
}

// 运行状态 → 语义色 + 中文标签。
export function runVariant(status: string): BadgeVariant {
  if (status === 'error') return 'destructive'
  if (status === 'running' || status === 'starting') return 'default'
  if (status === 'done') return 'secondary'
  return 'outline'
}
export function runLabel(status: string): string {
  const m: Record<string, string> = {
    starting: '启动中',
    running: '运行中',
    done: '已完成',
    error: '出错',
  }
  return m[status] ?? status
}
export function isLive(r: Run): boolean {
  return r.status === 'running' || r.status === 'starting'
}

// ─────────── 员工在线态（对齐旧 UI empRepRun / runStatus / EMP_ST_ICONS）───────────
// 旧 UI 的员工状态点不是「在跑=绿 / 否则灰」这么粗：收工后还要区分
// 「等你拍板(question)」「出错(error)」「后台仍在跑(working-bg)」「已收工(done)」「被中断」。
export type EmpStateKind = 'working' | 'working-bg' | 'question' | 'error' | 'interrupted' | 'done'

function runActivityTs(r: Run): string {
  return r.updatedAt || r.startedAt || ''
}

// 员工「代表会话」：有在跑的取最近在跑那条，否则取最近活动那条（只看这一条，
// 避免老话题结尾命中「等你拍板」把员工永久顶成待拍板）。
export function empRepRun(runs: Run[] | undefined, employee: string): Run | undefined {
  // 排除只读咨询窗：它是老板旁开的问话窗，不代表员工在干活——算进来会把空闲员工显示成「工作中…」
  const mine = (runs ?? []).filter((r) => r.employee === employee && !r.consult)
  if (!mine.length) return undefined
  const active = mine.filter((r) => r.status === 'running' || r.status === 'starting')
  const pool = active.length ? active : mine
  return pool.reduce((a, b) => (runActivityTs(b) > runActivityTs(a) ? b : a))
}

export function runStateKind(r: Run): EmpStateKind | null {
  if (r.status === 'running' || r.status === 'starting') return 'working'
  if (r.status === 'error') return 'error'
  if (r.status === 'interrupted') return 'interrupted'
  if (r.status === 'done') {
    if (r.bgTasks && r.bgTasks.length) return 'working-bg'
    // 列表里的 result 只有前 200 字（server.js runListView 瘦身），尾段单独走 resultTail——标记在末行，必须认尾段
    const tail = (r.resultTail || r.result || '').slice(-500)
    // 机器可读标记优先：收工汇报末行【等你拍板】<事项> / 无。
    // 「无」的判定与会话里合成 gate 卡共用 isEmptyGateItem——否则一处认「无。」是空、另一处不认，
    // 就会出现「徽标已收工、气泡下面还挂着空拍板卡」。
    const marks = [...tail.matchAll(/【等你拍板】\s*(\S[^\n]*)/g)]
    if (marks.length) return isEmptyGateItem(marks[marks.length - 1][1]) ? 'done' : 'question'
    return /等你|待你|需要你|请.{0,6}(拍板|确认|回复)|吗？|？$/m.test(tail) ? 'question' : 'done'
  }
  return null
}

export function empState(
  runs: Run[] | undefined,
  employee: string,
): { kind: EmpStateKind; run: Run } | null {
  const run = empRepRun(runs, employee)
  if (!run) return null
  const kind = runStateKind(run)
  return kind ? { kind, run } : null
}

export const EMP_STATE_LABEL: Record<EmpStateKind, string> = {
  working: '工作中…',
  'working-bg': '本轮收工，后台任务仍在跑',
  question: '收工了，有事项等你拍板/回复',
  done: '已收工',
  error: '上次运行出错',
  interrupted: '上次运行被中断',
}

// 状态徽标：实心底色（不透明）+ 是否「在忙」(active → 徽标里放三点跳动动画)。
// 对齐旧 UI emp-badge：working=薰衣草 / 后台=蓝 / 等你拍板=琥珀 / 已收工=绿 / 出错=红 / 中断=灰。
// active（working / 后台在跑 / 巡查中，巡查中也算 working）→ 三点跳动；其余静态实心 + 图标。
export function empDotStyle(
  kind: EmpStateKind | 'patrol' | undefined,
): { color: string; active: boolean } {
  switch (kind) {
    case 'working':
      return { color: 'bg-primary', active: true }
    case 'working-bg':
      return { color: 'bg-sky-500', active: true }
    case 'patrol': // 巡查中＝巡视员正在干活，算 working
      return { color: 'bg-primary', active: true }
    case 'question':
      return { color: 'bg-amber-500', active: false }
    case 'error':
      return { color: 'bg-destructive', active: false }
    case 'done':
      return { color: 'bg-emerald-500', active: false }
    default:
      return { color: 'bg-slate-400', active: false }
  }
}
