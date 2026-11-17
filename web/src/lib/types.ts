// 与 app/server.js 契约对齐的类型。字段来源见 server.js 各 /api 处理器。

// ---- 员工 ----
export type Employee = {
  displayName: string
  title: string
  emoji: string
  avatar: string
  iconUrl?: string
  agentFile: string
  roleFile: string
  memoryFile: string
  permissionMode: string
}
export type EmployeeMap = Record<string, Employee>

// ---- 任务 / 看板 ----
export type TaskEntry = {
  no: string
  name: string
  source: string
  /** 登记表「进入日期」列；老档案可能没有这一列 → 空串 */
  enteredAt?: string
  status: string
  stage: string
}
export type PendingDecision = { item: string; status: string }
export type CoverageSummary = {
  denom: number
  byStatus: Record<string, number>
  passed: boolean
  redComplete: boolean
  hasDoc: boolean
}
export type CoverageRow = {
  facetId: string
  req: string
  level: string // P1/P2/P3
  kind: string // auto/human
  cls: string
  criterion: string
  status: string // HUMAN_INHERENT | COVERED_GREEN | BLOCKED_WITH_PROOF | UNCOVERED | SOURCE_ATTESTED
  greenOk?: boolean
  redOk?: boolean
  hasRed?: boolean
  unlisted?: boolean
  green?: Record<string, unknown>
}
export type Coverage = {
  summary: CoverageSummary | null
  rows?: CoverageRow[]
  reqRollup?: Record<string, unknown>
  reqTitles?: Record<string, string> // REQ 编号 → 需求条目内容（仅 /api/coverage 带，看板 slim 不带）
}
export type TaskFile = {
  file: string
  frontmatter: Record<string, unknown> & {
    task?: string
    status?: string
    version?: string
    updated?: string
    owner?: string
  }
  entries: TaskEntry[]
  pendingDecisions: PendingDecision[]
  nextSteps: string[]
  coverage: Coverage | null
}

// ---- 运行 ----
export type Run = {
  id: string
  engine?: string
  engineHandoverPending?: { from: string; to: string; at: string; error?: string }
  employee: string
  taskFile: string | null
  model: string | null
  instruction: string
  status: string // starting | running | done | error | ...
  sessionId: string | null
  chainDepth: number
  callerRunId: string | null
  threadRootId: string
  startedAt: string
  updatedAt: string
  entryNo?: string
  // 全时双态：co_drive(共驾) | guarded_run(守航)。引擎 /api/runs 一直有下发，前端此前没用上。
  // 现在聊天窗的快捷动作按它禁用「白天的活」——守航态会话已注入 guardedRunPreamble，
  // 把巡航这类白天指令塞进去，两套规则会当场打架（见 components/quick-actions.tsx 的 blockedWhy）。
  executionMode?: 'co_drive' | 'guarded_run'
  // instruction/result 在 /api/runs 列表里只发前 200 字（见 server.js runListView）——列表只用来做摘要与两行预览，
  // 全文在打开会话时由 SSE / history 给。resultTail = 收工汇报末 300 字，供 status.ts 认【等你拍板】标记。
  result?: string
  resultTail?: string
  activity?: string
  pinned?: boolean
  // 会话标题：引擎建会话时旁路自动起名（对齐 Claude Code，server.js generateRunTitle），SSE run-title 到达后换名；
  // titleManual=老板手动改过（POST /api/runs/:id/title），之后不再被自动命名覆盖。缺省时各处退回指令/摘要。
  title?: string
  titleManual?: boolean
  bgTasks?: unknown[]
  // 只读咨询窗：员工正忙时也能并发开的第二个窗口（零写能力、不进流水线）。
  // 它**不算员工在忙**——状态点/忙闲派生一律排除（见 lib/status.ts empRepRun、lib/run-threads.ts mostRecentRun）。
  consult?: boolean
  // 所属工作区（lane id；'main' 或缺省 = 主检出）。引擎据此注入【运行环境】并按工作区粒度过并发闸（server.js laneKeyOf）
  lane?: string
  // 巡视宽限窗的截止时刻（毫秒时间戳）。引擎权威、持久化（跨重启可复原，server.js:4575），
  // 列表投影 {...r} 本来就带着它。前端据此**补渲染**接管横幅——否则宽限窗内新开/切换聊天卡，
  // 因为错过了 patrol-pending 那一发 SSE 就什么都看不到（旧 UI 有 syncPatrolBanner，app.js:1829）。
  patrolGraceUntil?: number | null
}

// ---- 会话 ----
export type Conversation = {
  ts: string
  threadRootId: string
  fromKind: 'user' | 'employee' | 'wecom'
  from: string
  to: string
  toRunId?: string
  kind: 'dispatch' | 'chat' | 'call' | 'return' | 'cc' | 'blocked' | 'meeting'
  text: string
  depth: number
}

// ---- 通知 / 审批 ----
export type PendingPerm = {
  reqId: string
  runId: string
  employee: string
  employeeName: string
  toolName: string
  brief: string
  ageMs: number
}
export type Notifications = {
  seq: number
  pending: PendingPerm[]
  events: unknown[]
}

// ---- 健康 ----
export type Health = {
  ok: boolean
  pid: number
  host: string
  port: number
  version: string
  node: string
  startedAt: string
  uptimeSec: number
  runs: { running: number; live: number; total: number }
  pendingPerms: number
  memoryMB: { rss: number; heapUsed: number }
  ts: string
}

// ---- 会议 ----
export type Meeting = {
  id: string
  seq?: number
  topic: string
  focusVersion: string | null
  participants: string[]
  chair: string
  rounds: number
  status: 'running' | 'stopped' | 'interrupted' | 'done'
  speaking: string | null
  startedAt: string
  updatedAt: string
}

// ---- SSE 全局事件（/api/events，data-only，按 payload.type 区分）----
export type SseEvent = { type: string; _ts?: string } & Record<string, unknown>

// ---- 工作区（lane）：GET /api/lanes（server.js → app/lanes.js status()）----
export type LaneRepoState = {
  path: string
  branch: string
  head?: string
  commitAt?: string // HEAD 提交时间（ISO）
  subject?: string // HEAD 提交标题
  dirty?: number // 已跟踪文件的改动数（真·未提交）
  untracked?: number // 未跟踪文件数（常是残留垃圾，单独计、不算未提交）
  untrackedList?: string[]
  ahead?: number
  behind?: number
  upstream?: string
  exists?: boolean
  error?: string
  adopted?: boolean
}
export type LaneOp = {
  id: string
  lane: string
  action: 'up' | 'down'
  targets: string[]
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  by?: string
  parts: { group: string; exitCode: string | null; logFile: string; tail: string }[]
}
export type Lane = {
  id: string
  name: string // 展示名：别名 > 主检出按分支取名 | id
  title?: string
  createdAt?: string
  version?: string
  taskFile?: string
  slot: number
  main?: boolean
  repos: Record<string, LaneRepoState>
  ports: Record<string, number>
  services: Record<string, { port: number; alive: boolean }>
  expected: string[] // 该起的服务（默认 targets）；健康度只按它 + 实际在跑的算
  backend: { headSha: string; builtSha: string; stale: boolean; unknown: boolean } | null
  op: LaneOp | null
  lastOp: LaneOp | null
  liveRuns: { id: string; employee: string; status: string }[]
}
export type LanesResponse = {
  lanes: Lane[]
  repos: Record<string, { dir: string; label: string; suffix: string; app?: string }>
  services: Record<string, { repo: string; kind: 'fe' | 'be'; label: string; base: number; step: number }>
  workspaceMode: string
}
