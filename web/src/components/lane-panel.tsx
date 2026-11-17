// 侧栏「运行环境」面板：主检出 + 每条并行需求的工作区（lane = worktree + 端口槽位）。
//
// 为什么在侧栏常驻（取代原来那块三红灯 / 定格晨检验收单，老板 2026-09-28：「那块没用，删掉」）：
// 多需求并行后，「8000 上现在跑的是哪一版」「Temu 那套旁路起着没有」「后端是不是改完还没重编」这些
// 问题以前只能翻员工记忆或者自己 netstat——迷糊按红线 10 不做环境预检，更是无从知道。数据面 = GET /api/lanes
// （引擎 app/lanes.js，与 GG Bond 的 lane_* 工具同一个 manager，老板与员工看到/操作的是同一份事实）。
//
// 布局（老板 2026-09-28 第二轮）：每条只占两行——名字（别名 / 主检出按分支取名 / id）+ 一行「前端链接 · 后端汇总」。
// 前端要点击跳转所以直接摆出来；后端三个服务收成一个汇总点，分支 / 提交 / 档案 / 时间 / 各服务端口一律进悬浮卡；
// 悬浮卡顶部就是员工头像，鼠标移进去直接点＝在这个环境开会话。「…」菜单只留对环境本身的操作。
import { useEffect, useMemo, useState } from 'react'
import {
  GitBranchIcon,
  PlusIcon,
  DotsThreeIcon,
  CircleNotchIcon,
  ArrowsClockwiseIcon,
  StopCircleIcon,
  PencilSimpleIcon,
  TrashIcon,
  WarningIcon,
  FileTextIcon,
  FolderSimpleIcon,
  CopyIcon,
} from '@phosphor-icons/react'
import { toast } from 'sonner'

import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { EmployeeAvatar } from '@/components/employee-avatar'
import { useRunDetail } from '@/components/run-detail-provider'
import { useFileViewer } from '@/components/file-viewer'
import { useSseEvent } from '@/components/sse-provider'
import { useEmployees } from '@/hooks/use-employees'
import { usePoll } from '@/hooks/use-poll'
import { apiGet, apiPost, ApiError } from '@/lib/api'
import { relTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Lane, LanesResponse, TaskFile } from '@/lib/types'

// 与 app/lanes.js 的 REPOS / SERVICES 对齐（2026-10-08 加独立站工程：iwo = auxiliary-api + 跨境管理中台，fe-cc = 组件中心）。
// 前端行只摆「能点开的入口」：独立站工程的入口是中台（登录 + 菜单），组件中心是被中台加载的子应用、单独打开没有登录态，放进后端汇总里一起看。
const REPO_ORDER = ['backend', 'fe-supplier', 'fe-cj', 'iwo', 'fe-cc'] as const
const REPO_LABEL: Record<string, string> = { backend: '后端', 'fe-supplier': 'GYS 前端', 'fe-cj': '供应商前端', iwo: '独立站工程', 'fe-cc': '组件中心' }
const SVC_LABEL: Record<string, string> = { 'fe-supplier': 'GYS', 'fe-cj': '供应商', service: 'service', web: 'web', 'gys-web': 'gys-web', kjglzt: '中台', cba: 'auxiliary-api', cc: '组件中心' }
const FE_SVCS = ['fe-supplier', 'fe-cj', 'kjglzt']
const BE_SVCS = ['service', 'web', 'gys-web', 'cba', 'cc']

function errText(e: unknown) {
  const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null
  return body?.error || (e as Error).message
}

// 「该起的」= 默认 targets ∪ 实际在跑的：不起 web 的工作区不因 web 没起而显示「部分在跑」
function shownServices(l: Lane) {
  return Object.keys(l.services || {}).filter((k) => (l.expected || []).includes(k) || l.services[k].alive)
}
// 一条环境的整体健康：操作中 > 陈旧 > 全在跑 / 部分在跑 / 全停
function health(l: Lane) {
  const svcs = shownServices(l).map((k) => l.services[k])
  const alive = svcs.filter((s) => s.alive).length
  if (l.op) return { tone: 'busy', text: `${l.op.action === 'up' ? '重编重启' : '停止'}中：${l.op.targets.join(', ')}` }
  if (l.backend?.stale) return { tone: 'warn', text: `后端已陈旧：构建于 ${l.backend.builtSha}，当前 HEAD ${l.backend.headSha}` }
  if (!svcs.length) return { tone: 'idle', text: '没有可起的服务' }
  if (alive === 0) return { tone: 'idle', text: '服务全停' }
  if (alive < svcs.length) return { tone: 'part', text: `${alive}/${svcs.length} 个服务在跑` }
  return { tone: 'ok', text: '服务全在跑' }
}
const TONE_CLASS: Record<string, string> = {
  ok: 'text-emerald-500',
  part: 'text-sky-500',
  warn: 'text-amber-500',
  busy: 'text-amber-500',
  idle: 'text-muted-foreground',
}
const dot = (alive: boolean) => (alive ? 'text-emerald-500' : 'text-muted-foreground/50')

// 与 app/lanes.js suggestLaneId 同口径（这里只做预览；留空提交时以引擎生成的为准，撞名序号也由引擎补）
function previewLaneId(feature: string, branch: string, version: string) {
  const strip = (s: string) => s.replace(/^(feature|hotfix|bugfix|chore)\//, '').replace(/-lab$/, '').replace(/^v?\d+(\.\d+)+[-_]?/i, '')
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/, '')
  let base = slug(feature) || slug(strip(branch))
  if (base.length < 2) base = 'wt' + (version ? '-' + slug(version.replace(/\./g, '-')) : '')
  return base === 'main' ? 'wt-main' : base
}

export function LanePanel() {
  const [fast, setFast] = useState(false)
  const { data, refresh } = usePoll<LanesResponse>('/api/lanes', fast ? 3000 : 10000)
  useSseEvent('lanes-changed', () => refresh())
  const lanes = data?.lanes || []
  // 有操作在跑时加密轮询，跑完回落（操作本身在引擎侧是 detached 的，前端只负责看）
  const anyOp = lanes.some((l) => l.op)
  useEffect(() => setFast(anyOp), [anyOp])

  const [editing, setEditing] = useState<Lane | 'new' | null>(null)
  const [removing, setRemoving] = useState<Lane | null>(null)
  // 独立 clone 形态下工作区根没有这些仓 → 主检出也是空的，整块不占位
  if (data && lanes.length === 1 && !Object.keys(lanes[0].repos || {}).length) return null

  return (
    <SidebarGroup>
      <SidebarGroupLabel>运行环境</SidebarGroupLabel>
      <SidebarGroupAction title="新建工作区（开 worktree + 分配端口槽位）" onClick={() => setEditing('new')}>
        <PlusIcon />
        <span className="sr-only">新建工作区</span>
      </SidebarGroupAction>
      <SidebarMenu className="gap-1">
        {!data && (
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <CircleNotchIcon className="animate-spin" />
              <span>读取中…</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {lanes.map((l) => (
          <LaneItem key={l.id} lane={l} onChanged={refresh} onEdit={() => setEditing(l)} onRemove={() => setRemoving(l)} />
        ))}
      </SidebarMenu>
      <LaneDialog lane={editing} lanes={lanes} onClose={() => setEditing(null)} onDone={refresh} />
      <LaneRemoveDialog lane={removing} onClose={() => setRemoving(null)} onDone={refresh} />
    </SidebarGroup>
  )
}

function LaneItem({ lane, onChanged, onEdit, onRemove }: { lane: Lane; onChanged: () => void; onEdit: () => void; onRemove: () => void }) {
  const { state, setOpen: setSidebarOpen, isMobile } = useSidebar()
  const [cardOpen, setCardOpen] = useState(false)
  const h = health(lane)
  const shown = shownServices(lane)
  const feKeys = Object.keys(lane.services || {}).filter((s) => FE_SVCS.includes(s))
  const beShown = shown.filter((s) => BE_SVCS.includes(s))
  const beAlive = beShown.filter((s) => lane.services[s].alive).length

  const act = async (action: 'up' | 'down', targets?: string[]) => {
    try {
      await apiPost(`/api/lanes/${lane.id}/${action}`, { targets })
      toast.success(`${lane.name}：已${action === 'up' ? '开始重编重启' : '开始停止'}`, {
        description: `${(targets?.length ? targets : ['默认']).join(', ')}（分钟级，状态点会跟着变）`,
      })
      onChanged()
    } catch (e) {
      toast.error('操作失败', { description: errText(e) })
    }
  }

  return (
    <SidebarMenuItem>
      {/* 整条（名字行 + 服务行）都是悬浮卡的触发区：hover 出卡，卡顶就是员工头像，移进去点即开会话。
          点名字＝切换卡片（触屏没有 hover；折叠成图标轨时则先展开侧栏）。 */}
      <HoverCard open={cardOpen} onOpenChange={setCardOpen} openDelay={150} closeDelay={200}>
        <HoverCardTrigger asChild>
          <div className="min-w-0">
            <SidebarMenuButton
              data-testid={`lane-item-${lane.id}`}
              onClick={() => (state === 'collapsed' && !isMobile ? setSidebarOpen(true) : setCardOpen((o) => !o))}
            >
              {lane.op ? (
                <CircleNotchIcon className={cn('animate-spin', TONE_CLASS.busy)} />
              ) : (
                <GitBranchIcon weight={h.tone === 'idle' ? 'regular' : 'fill'} className={TONE_CLASS[h.tone]} />
              )}
              <span className="truncate">{lane.name}</span>
              {lane.backend?.stale && <WarningIcon className="size-3.5 shrink-0 text-amber-500" />}
            </SidebarMenuButton>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 ps-8 pe-2 pb-1 text-[11px] leading-5 text-muted-foreground group-data-[collapsible=icon]:hidden">
              {feKeys.map((s) => {
                const v = lane.services[s]
                return v.alive ? (
                  <a
                    key={s}
                    href={`http://localhost:${v.port}`}
                    target="_blank"
                    rel="noreferrer"
                    className="tabular-nums hover:text-foreground hover:underline"
                    title={`打开 http://localhost:${v.port}`}
                    data-testid={`lane-fe-${lane.id}-${s}`}
                  >
                    <span className={cn('me-0.5', dot(true))}>●</span>
                    {SVC_LABEL[s]}:{v.port}
                  </a>
                ) : (
                  <span key={s} className="tabular-nums" title="未起">
                    <span className={cn('me-0.5', dot(false))}>○</span>
                    {SVC_LABEL[s]}:{v.port}
                  </span>
                )
              })}
              {beShown.length > 0 && (
                <span className="tabular-nums" title="悬停看各服务端口与构建新鲜度">
                  <span className={cn('me-0.5', beAlive === beShown.length ? dot(true) : beAlive ? 'text-sky-500' : dot(false))}>
                    {beAlive ? '●' : '○'}
                  </span>
                  后端 {beAlive}/{beShown.length}
                  {lane.backend?.stale && <span className="ms-1 text-amber-500">陈旧</span>}
                </span>
              )}
              {lane.op && <span className="text-amber-500">⏳ 处理中</span>}
              {!lane.op && lane.lastOp?.status === 'failed' && <span className="text-destructive">✗ 上次操作失败</span>}
            </div>
          </div>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" sideOffset={10} className="w-80 bg-popover p-0 shadow-lg before:hidden" data-testid={`lane-card-${lane.id}`}>
          <LaneCard lane={lane} onPicked={() => setCardOpen(false)} />
        </HoverCardContent>
      </HoverCard>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction data-testid={`lane-menu-${lane.id}`} title="环境操作">
            <DotsThreeIcon />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-52">
          <DropdownMenuLabel className="text-xs">
            {lane.name}
            {lane.slot ? <span className="ms-1 font-normal text-muted-foreground">槽位 {lane.slot}</span> : null}
          </DropdownMenuLabel>
          <DropdownMenuItem disabled={!!lane.op} onClick={() => act('up')}>
            <ArrowsClockwiseIcon />
            重编重启（默认服务）
          </DropdownMenuItem>
          {beShown.length > 0 && (
            <DropdownMenuItem disabled={!!lane.op} onClick={() => act('up', beShown)}>
              <ArrowsClockwiseIcon />
              只重编重启后端
            </DropdownMenuItem>
          )}
          {feKeys.length > 0 && (
            <DropdownMenuItem disabled={!!lane.op} onClick={() => act('up', feKeys)}>
              <ArrowsClockwiseIcon />
              只重启前端
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!!lane.op} onClick={() => act('down')}>
            <StopCircleIcon />
            停掉全部服务
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onEdit}>
            <PencilSimpleIcon />
            {lane.main ? '改别名' : '编辑（别名 / 档案绑定）'}
          </DropdownMenuItem>
          {!lane.main && (
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <TrashIcon />
              收掉工作区…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

// 仓库在磁盘上的目录：整段可选中 + 一键复制（去资源管理器 / 终端里 cd 用）
function RepoPath({ path }: { path: string }) {
  const p = path.replace(/\\/g, '/')
  return (
    <div className="flex min-w-0 items-start gap-1 text-[11px] text-muted-foreground" data-testid="lane-repo-path">
      <FolderSimpleIcon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 font-mono break-all select-all" title={path}>{path}</span>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-accent-foreground"
        title="复制目录"
        aria-label="复制目录"
        onClick={() => {
          navigator.clipboard?.writeText(path).then(() => toast.success('已复制目录', { description: p })).catch(() => toast.error('复制失败，可以直接选中文字复制'))
        }}
      >
        <CopyIcon className="size-3.5" />
      </button>
    </div>
  )
}

// 悬浮卡：顶部员工头像（点＝在这个环境开会话），下面是后端各服务 / 代码（分支·提交·未提交）/ 档案 / 时间。
function LaneCard({ lane, onPicked }: { lane: Lane; onPicked: () => void }) {
  const { newChat } = useRunDetail()
  const { openFile } = useFileViewer()
  const { employees } = useEmployees()
  const staff = Object.entries(employees).filter(([k]) => k !== 'chaorenq')
  const working = new Set(lane.liveRuns.map((r) => r.employee))
  const beKeys = Object.keys(lane.services || {}).filter((s) => BE_SVCS.includes(s))
  const failed = !lane.op && lane.lastOp?.status === 'failed' ? lane.lastOp : null
  const lastOp = lane.op || lane.lastOp

  return (
    <div className="grid gap-0 text-xs">
      <div className="grid gap-0.5 border-b px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium" title={lane.name}>{lane.name}</span>
        <span className="text-[11px] text-muted-foreground">
          {lane.main ? '主检出' : `id ${lane.id}`}
          {lane.slot ? ` · 槽位 ${lane.slot}` : ''}
          {lane.version ? ` · ${lane.version}` : ''}
        </span>
      </div>

      <div className="border-b px-3 py-2">
        <div className="mb-1.5 text-[11px] text-muted-foreground">在这个环境里对话</div>
        <div className="flex flex-wrap gap-1.5">
          {staff.map(([k, e]) => (
            <button
              key={k}
              type="button"
              title={`和 ${e.displayName} 在「${lane.name}」里开会话${working.has(k) ? '（他正在这里干活）' : ''}`}
              data-testid={`lane-chat-${lane.id}-${k}`}
              onClick={() => {
                newChat(k, lane.taskFile || undefined, lane.id)
                onPicked()
              }}
              className={cn(
                'relative rounded-full ring-offset-1 ring-offset-popover transition hover:scale-110 hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                working.has(k) && 'ring-2 ring-emerald-500',
              )}
            >
              <EmployeeAvatar employee={e} fallback={k} className="size-8" />
            </button>
          ))}
        </div>
      </div>

      {beKeys.length > 0 && (
        <div className="grid gap-1 border-b px-3 py-2">
          <div className="text-[11px] text-muted-foreground">后端服务</div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
            {beKeys.map((s) => (
              <span key={s} className={cn(!lane.services[s].alive && !(lane.expected || []).includes(s) && 'opacity-50')}>
                <span className={cn('me-0.5', dot(lane.services[s].alive))}>{lane.services[s].alive ? '●' : '○'}</span>
                {SVC_LABEL[s] || s}:{lane.services[s].port}
              </span>
            ))}
          </div>
          {lane.backend && (
            <div className={cn(lane.backend.stale ? 'text-amber-500' : 'text-muted-foreground')}>
              {lane.backend.stale
                ? `⚠ 陈旧：构建于 ${lane.backend.builtSha}，HEAD 已是 ${lane.backend.headSha}——需重编重启`
                : lane.backend.unknown
                  ? '在跑，但不是在这里重编起的（不确定是哪个提交）'
                  : lane.backend.builtSha
                    ? `新鲜：构建于 ${lane.backend.builtSha}`
                    : '尚未在这里重编过'}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-1.5 border-b px-3 py-2">
        <div className="text-[11px] text-muted-foreground">代码</div>
        {REPO_ORDER.filter((k) => lane.repos[k]).map((k) => {
          const r = lane.repos[k]
          return (
            <div key={k} className="grid min-w-0 gap-0.5" title={String(r.path).replace(/\\/g, '/')}>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-medium">{REPO_LABEL[k]}</span>
                {r.exists === false ? (
                  <span className="text-destructive">工作树不存在</span>
                ) : (
                  <>
                    <span className="min-w-0 truncate font-mono text-[11px]">{r.branch}</span>
                    {!!r.dirty && (
                      <span className="shrink-0 text-amber-500" title="已跟踪文件有改动还没提交">
                        未提交 {r.dirty}
                      </span>
                    )}
                    {!!r.ahead && <span className="shrink-0 text-sky-500">未推 {r.ahead}</span>}
                    {!r.dirty && !r.ahead && r.upstream && <span className="shrink-0 text-emerald-500">已同步</span>}
                    {!!r.untracked && (
                      <span
                        className="shrink-0 text-muted-foreground"
                        title={[
                          '未被 git 跟踪的文件（不算未提交，多是残留）：',
                          ...(r.untrackedList || []),
                          ...(r.untracked > (r.untrackedList || []).length ? ['…'] : []),
                        ].join('\n')}
                      >
                        未跟踪 {r.untracked}
                      </span>
                    )}
                  </>
                )}
              </div>
              {/* 磁盘目录直接摆出来（2026-09-30 老板：「运行环境怎么没展示在磁盘的目录」——原先只藏在悬停 title 里） */}
              {r.path && <RepoPath path={String(r.path)} />}
              {r.head && (
                <div className="min-w-0 truncate text-[11px] text-muted-foreground">
                  <span className="font-mono">{r.head}</span>
                  {r.commitAt ? ` · ${relTime(r.commitAt)}` : ''}
                  {r.subject ? ` · ${r.subject}` : ''}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="grid gap-1 px-3 py-2 text-[11px] text-muted-foreground">
        {lane.taskFile ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 text-start text-foreground hover:underline"
            onClick={() => {
              openFile(lane.taskFile!)
              onPicked()
            }}
            title={lane.taskFile}
          >
            <FileTextIcon className="size-3.5 shrink-0" />
            <span className="truncate">{lane.taskFile.replace(/^.*\//, '').replace(/\.md$/, '')}</span>
          </button>
        ) : (
          <span>{lane.main ? '主检出不绑定任务档案' : '未绑定任务档案（「…」→ 编辑 可绑）'}</span>
        )}
        {lane.createdAt && <span>创建于 {relTime(lane.createdAt)}</span>}
        {lastOp && (
          <span>
            最近操作：{lastOp.action === 'up' ? '重编重启' : '停止'} {lastOp.targets.join(', ')} ·{' '}
            {lastOp.status === 'running' ? '进行中' : lastOp.status === 'done' ? '成功' : '失败'} · {relTime(lastOp.finishedAt || lastOp.startedAt)}
          </span>
        )}
        {failed && (
          <pre className="max-h-28 overflow-auto rounded bg-destructive/10 p-1.5 text-[10px] whitespace-pre-wrap text-destructive">
            {failed.parts
              .filter((p) => p.exitCode !== '0')
              .map((p) => `${p.group}（exit ${p.exitCode}）\n${p.tail}`)
              .join('\n\n')}
          </pre>
        )}
      </div>
    </div>
  )
}

// 新建 / 编辑。新建 = 开 worktree（同步，可能几十秒）；编辑只改登记（别名 / 版本 / 档案绑定），不动树与进程；主检出只能改别名。
function LaneDialog({ lane, lanes, onClose, onDone }: { lane: Lane | 'new' | null; lanes: Lane[]; onClose: () => void; onDone: () => void }) {
  const isNew = lane === 'new'
  const editing = lane && lane !== 'new' ? lane : null
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [version, setVersion] = useState('')
  const [feature, setFeature] = useState('')
  const [branch, setBranch] = useState('')
  const [repos, setRepos] = useState<string[]>(['backend', 'fe-supplier'])
  const [taskFile, setTaskFile] = useState('')
  const [slot, setSlot] = useState('auto')
  const [tasks, setTasks] = useState<TaskFile[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!lane) return
    setBusy(false)
    if (editing) {
      setTitle(editing.title || '')
      setVersion(editing.version || '')
      setTaskFile(editing.taskFile || '')
    } else {
      setId(''); setTitle(''); setVersion(''); setFeature(''); setBranch(''); setTaskFile(''); setSlot('auto')
      setRepos(['backend', 'fe-supplier'])
    }
    if (!editing?.main) apiGet<TaskFile[]>('/api/tasks?slim=1').then(setTasks).catch(() => setTasks([]))
  }, [lane]) // eslint-disable-line react-hooks/exhaustive-deps

  // 选档案时顺手把别名/版本带出来（frontmatter 里就有），少敲两个字段
  const pickTask = (f: string) => {
    setTaskFile(f === '__none' ? '' : f)
    const t = tasks?.find((x) => x.file === f)
    if (t && isNew) {
      if (!title && t.frontmatter.task) setTitle(String(t.frontmatter.task))
      if (!version && t.frontmatter.version) setVersion(String(t.frontmatter.version))
    }
  }
  const previewBranch = branch.trim() || (version.trim() && feature.trim() ? `feature/${version.trim()}-${feature.trim().replace(/\s+/g, '-')}-lab` : '')
  const autoId = useMemo(() => {
    const base = previewLaneId(feature.trim(), branch.trim(), version.trim())
    const taken = new Set(lanes.map((l) => l.id))
    let v = base
    for (let n = 2; taken.has(v); n++) v = `${base}-${n}`
    return v
  }, [feature, branch, version, lanes])
  const taskOptions = useMemo(() => (tasks || []).slice(0, 80), [tasks])

  const submit = async () => {
    setBusy(true)
    try {
      if (editing) {
        await apiPost(`/api/lanes/${editing.id}/update`, editing.main ? { title } : { title, version, taskFile })
        toast.success('已更新')
      } else {
        const r = await apiPost<{ lane: { id: string; slot: number }; log: string[] }>('/api/lanes', {
          id: id.trim() || undefined, title, version, feature, branch: branch.trim() || undefined, repos, taskFile: taskFile || undefined,
          slot: slot === 'auto' ? undefined : Number(slot),
        })
        toast.success(`工作区 ${r.lane.id} 已就绪（槽位 ${r.lane.slot}）`, { description: r.log.join('\n') })
      }
      onDone()
      onClose()
    } catch (e) {
      toast.error(editing ? '更新失败' : '建工作区失败', { description: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!lane} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="lane-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? (editing.main ? '主检出 · 改别名' : `编辑工作区 ${editing.id}`) : '新建工作区'}</DialogTitle>
          <DialogDescription>
            {editing
              ? editing.main
                ? '不填则按主检出当前分支取名（如 0.1.3-通知管理）。'
                : '只改登记信息；绑定任务档案后，该档案的派工 / 交接会自动进这个工作区。'
              : '按所选仓在 .worktrees/<id>-* 开 git worktree（分支已在别处检出则直接认领），前端复用主检出的 node_modules，并分配一组不冲突的端口。'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {!editing?.main && (
            <div className="grid gap-1.5">
              <Label>任务档案（可选）</Label>
              <Select value={taskFile || '__none'} onValueChange={pickTask}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tasks === null ? '读取中…' : '不绑定'} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="__none">不绑定</SelectItem>
                  {taskOptions.map((t) => (
                    <SelectItem key={t.file} value={t.file}>
                      {t.frontmatter.version ? `${t.frontmatter.version} ` : ''}
                      {String(t.frontmatter.task || t.file.replace(/^.*\//, '').replace(/\.md$/, ''))}
                    </SelectItem>
                  ))}
                  {taskFile && !taskOptions.some((t) => t.file === taskFile) && <SelectItem value={taskFile}>{taskFile}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className={cn('grid gap-3', !editing?.main && 'grid-cols-2')}>
            <div className="grid gap-1.5">
              <Label htmlFor="lane-title">别名</Label>
              <Input id="lane-title" placeholder={editing?.main ? editing.name : '侧栏上显示的名字'} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            {!editing?.main && (
              <div className="grid gap-1.5">
                <Label htmlFor="lane-version">版本号</Label>
                <Input id="lane-version" placeholder="如 v0.1.0" value={version} onChange={(e) => setVersion(e.target.value)} />
              </div>
            )}
          </div>
          {isNew && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="lane-feature">功能短名</Label>
                  <Input id="lane-feature" placeholder="进分支名，如 temu-batch" value={feature} onChange={(e) => setFeature(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="lane-branch">或直接给分支名</Label>
                  <Input id="lane-branch" placeholder="已有分支就填它" value={branch} onChange={(e) => setBranch(e.target.value)} />
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                分支：<span className="font-mono">{previewBranch || '（填版本号 + 功能短名，或直接给分支名）'}</span>
                <span className="ms-1">· 前后端同名；新分支从 origin/release 切</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="lane-id">工作区 id（可留空）</Label>
                  <Input id="lane-id" placeholder={`自动：${autoId}`} value={id} onChange={(e) => setId(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label>端口槽位</Label>
                  <Select value={slot} onValueChange={setSlot}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动（取空闲的）</SelectItem>
                      {[1, 2, 3].map((k) => (
                        <SelectItem key={k} value={String(k)}>
                          槽位 {k}（前端 {8000 + 2 * k} / gys-web {8042 + 10000 * k}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>涉及仓库</Label>
                <div className="flex flex-wrap gap-4">
                  {REPO_ORDER.map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={repos.includes(k)}
                        onCheckedChange={(c) => setRepos((rs) => (c ? [...rs, k] : rs.filter((x) => x !== k)))}
                      />
                      {REPO_LABEL[k]}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || (isNew && (!repos.length || !previewBranch))}>
            {busy && <CircleNotchIcon className="animate-spin" />}
            {editing ? '保存' : busy ? '开工作树中…' : '建工作区'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LaneRemoveDialog({ lane, onClose, onDone }: { lane: Lane | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const go = async (keepWorktrees: boolean) => {
    if (!lane) return
    setBusy(true)
    try {
      const r = await apiPost<{ log: string[] }>(`/api/lanes/${lane.id}/remove`, { keepWorktrees })
      toast.success(`已收掉工作区 ${lane.name}`, { description: r.log.join('\n') })
      onDone()
      onClose()
    } catch (e) {
      toast.error('收工作区失败', { description: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={!!lane} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>收掉工作区 {lane?.name}？</AlertDialogTitle>
          <AlertDialogDescription>
            需先停掉它的服务。「收掉」会检查每棵工作树没有未提交改动、提交都已推到远端，再移除工作树（分支永远保留）；
            检查不过会拒绝并说明原因。「只从看板移除」不动工作树与分支。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button variant="outline" disabled={busy} onClick={() => go(true)}>
            只从看板移除
          </Button>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault()
              go(false)
            }}
          >
            收掉（移除工作树）
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
