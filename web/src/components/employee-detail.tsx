import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { EmployeeAvatar } from '@/components/employee-avatar'
import { Markdown } from '@/components/markdown'
import { DispatchDialog } from '@/components/dispatch-dialog'
import { useFileViewer } from '@/components/file-viewer'
import { useRunDetail } from '@/components/run-detail-provider'
import { useEmployees } from '@/hooks/use-employees'
import { usePoll } from '@/hooks/use-poll'
import { employeeThreads, mostRecentRun, runSummary, runTitle } from '@/lib/run-threads'
import { isLive, runLabel, runVariant, statusVariant } from '@/lib/status'
import { relTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { apiGet, apiPost } from '@/lib/api'
import type { Run, TaskFile } from '@/lib/types'

const PERM_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

type Detail = {
  key: string
  profile: any
  defaultModel: string
  description: string
  permissionMode: string
  roleMd: string
  memoryMd: string
  lessonCount: number
  agentMd: string
  templates: { file: string; title: string }[]
}

type Ctx = { open: (key: string) => void }
const EmployeeDetailContext = createContext<Ctx>({ open: () => {} })
export function useEmployeeDetail() {
  return useContext(EmployeeDetailContext)
}

export function EmployeeDetailProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState<string | null>(null)
  const openDetail = useCallback((k: string) => {
    setKey(k)
    setOpen(true)
  }, [])
  return (
    <EmployeeDetailContext.Provider value={{ open: openDetail }}>
      {children}
      <EmployeeDetailDialog keyId={key} open={open} onOpenChange={setOpen} />
    </EmployeeDetailContext.Provider>
  )
}

function EmployeeDetailDialog({
  keyId,
  open,
  onOpenChange,
}: {
  keyId: string | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { employees } = useEmployees()
  const { openFile } = useFileViewer()
  const { open: openRun, openChat, newConsult } = useRunDetail()
  const { data: runs } = usePoll<Run[]>('/api/runs', 15000)
  // slim=1：这里只看 owner/标题/条数，用不到 coverage.rows（详见 KanbanView 同款注释）
  const { data: tasks } = usePoll<TaskFile[]>('/api/tasks?slim=1', 15000)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [perm, setPerm] = useState('')
  const [iconUrl, setIconUrl] = useState('')
  const [tab, setTab] = useState('runs')

  useEffect(() => {
    if (!open || !keyId) return
    setDetail(null)
    setTab('runs')
    apiGet<Detail>(`/api/employees/${keyId}/detail`)
      .then((d) => {
        setDetail(d)
        setPerm(d.permissionMode)
        setIconUrl(d.profile?.iconUrl || '')
      })
      .catch((e) => toast.error('加载失败', { description: (e as Error).message }))
  }, [open, keyId])

  async function saveConfig(next: { permissionMode?: string; iconUrl?: string }) {
    try {
      await apiPost(`/api/employees/${keyId}/config`, next)
      toast.success('已保存')
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    }
  }

  const emp = keyId ? employees[keyId] : undefined
  const myRuns = keyId ? employeeThreads(runs, keyId) : []
  // 履历统计只算正式会话——只读咨询窗（老板旁开的问话窗）不是"派工"，算进来会稀释派工次数/成功率；
  // 但会话列表里仍保留它们（带「只读」标），便于回看问过什么。
  const workRuns = myRuns.filter((r) => !r.consult)
  const liveCount = workRuns.filter(isLive).length
  // 履历统计（对齐旧 UI）：派工次数 / 成功率(done 占比) / 最近活跃(纯按时间、忽略置顶)
  const total = workRuns.length
  const done = workRuns.filter((r) => r.status === 'done').length
  const successRate = total ? `${Math.round((done / total) * 100)}%` : '—'
  const lastActive = keyId ? relTime(mostRecentRun(runs, keyId)?.startedAt) : '—'
  // 在办事项：该员工作为版本负责人(owner)的任务档案（可靠信号；不复刻看板逐条 guessNext）
  const owned = keyId ? (tasks ?? []).filter((t) => t.frontmatter.owner === keyId) : []
  // 交接链：该员工参与的 threadRootId → 该链上跨员工的全部 run（按时间正序），只留有交接的
  const chains = [...new Set(myRuns.map((r) => r.threadRootId).filter(Boolean))]
    .map((root) => ({
      root,
      runs: (runs ?? [])
        .filter((r) => r.threadRootId === root)
        .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '')),
    }))
    .filter((c) => c.runs.length > 1)

  // 可用标签页（有数据才渲染），triggers 与 contents 由同一数组驱动
  const tabDefs = [
    { v: 'runs', label: `运行 ${total}`, show: true },
    { v: 'inflight', label: '在办', show: true },
    { v: 'chains', label: `交接 ${chains.length}`, show: chains.length > 0 },
    { v: 'role', label: '职责', show: true },
    { v: 'lessons', label: `教训 ${detail?.lessonCount ?? 0}`, show: true },
    { v: 'templates', label: '模板', show: (detail?.templates?.length ?? 0) > 0 },
    { v: 'agent', label: 'Agent', show: true },
  ].filter((t) => t.show)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[640px] max-h-[85svh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        {!detail ? (
          <>
            <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b p-4 pe-12">
              <Skeleton className="size-12 rounded-full" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <div className="grid gap-3 border-b p-4 sm:w-64 sm:border-e sm:border-b-0">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
              <div className="flex-1 p-4">
                <Skeleton className="h-full w-full" />
              </div>
            </div>
          </>
        ) : (
          <>
            {/* 头部（跨两栏） */}
            <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b p-4 pe-12">
              <EmployeeAvatar employee={emp} fallback={detail.key} className="size-12" />
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-1.5 text-base">
                  {emp?.displayName ?? detail.key}
                  {emp?.emoji && <span className="text-sm">{emp.emoji}</span>}
                </DialogTitle>
                <DialogDescription>
                  {emp?.title} · {detail.defaultModel.replace('claude-', '')}
                </DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" onClick={() => openChat(detail.key)}>
                  开聊
                </Button>
                {/* 只读咨询窗：他正忙时也能开（零写能力、不占他的活） */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => newConsult(detail.key)}
                  title="只读咨询：能读码/查 git/看日志，不能改文件或重启服务；他正式会话照旧跑"
                >
                  只读咨询
                </Button>
                <DispatchDialog
                  defaultEmployee={detail.key}
                  trigger={
                    <Button size="sm" variant="outline">
                      派工
                    </Button>
                  }
                />
              </div>
            </DialogHeader>

            {/* 主体两栏：左固定(身份/统计/配置) + 右滚动(标签页内容) */}
            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              {/* 左栏 */}
              <div className="shrink-0 space-y-4 overflow-y-auto border-b p-4 sm:w-64 sm:border-e sm:border-b-0">
                {detail.description && (
                  <p className="text-xs/relaxed text-muted-foreground">{detail.description}</p>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <StatTile value={String(total)} label="派工次数" />
                  <StatTile value={successRate} label="成功率" />
                  <StatTile value={lastActive} label="最近活跃" />
                  <StatTile value={String(detail.lessonCount)} label="教训沉淀" />
                </div>
                {liveCount > 0 && (
                  <Badge className="w-full justify-center">当前在跑 {liveCount}</Badge>
                )}

                {keyId === 'chaorenq' && <PatrolConfig />}

                <div className="grid gap-1.5">
                  <Label className="text-xs">权限模式</Label>
                  <Select
                    value={perm}
                    onValueChange={(v) => {
                      setPerm(v)
                      saveConfig({ permissionMode: v })
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERM_MODES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    下次派工生效；已在跑的会话保持原模式到收工。
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-xs">推送图标 URL</Label>
                  <div className="flex items-center gap-2">
                    <IconPreview src={iconUrl || emp?.avatar} />
                    <Input
                      value={iconUrl}
                      onChange={(e) => setIconUrl(e.target.value)}
                      placeholder="https://…"
                      spellCheck={false}
                      className="min-w-0 flex-1"
                    />
                    <Button variant="outline" size="sm" onClick={() => saveConfig({ iconUrl })}>
                      保存
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Bark 通知图标由手机端下载显示，需<b className="font-medium">公网可访问的 HTTPS 直链</b>；
                    留空回退推送设置里的 iconBase ＋ 本地头像。
                  </p>
                </div>
              </div>

              {/* 右栏 */}
              <Tabs
                value={tab}
                onValueChange={setTab}
                className="flex min-h-0 flex-1 flex-col gap-3 p-4"
              >
                <TabsList className="w-full justify-start overflow-x-auto">
                  {tabDefs.map((t) => (
                    <TabsTrigger key={t.v} value={t.v}>
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                <ScrollArea className="-mx-1 min-h-0 flex-1 px-1">
                  <TabsContent value="runs">
                    {myRuns.length === 0 ? (
                      <Empty>还没有派过工</Empty>
                    ) : (
                      <div className="grid gap-1.5">
                        {myRuns.slice(0, 12).map((r) => (
                          <button
                            key={r.id}
                            onClick={() => openRun(r.id)}
                            className="grid gap-0.5 rounded-md border p-2 text-start hover:border-primary/50"
                          >
                            <div className="flex items-center gap-2 text-xs">
                              <Badge variant={runVariant(r.status)} className="shrink-0">
                                {runLabel(r.status)}
                              </Badge>
                              <span className="ms-auto text-muted-foreground">{relTime(r.startedAt)}</span>
                            </div>
                            <span className="truncate text-sm">{runTitle(r, 60) || '（空会话）'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="inflight">
                    {owned.length === 0 ? (
                      <Empty>暂无在办事项</Empty>
                    ) : (
                      <div className="grid gap-1.5">
                        {owned.map((t) => (
                          <button
                            key={t.file}
                            onClick={() => openFile(t.file)}
                            className="grid gap-0.5 rounded-md border p-2 text-start hover:border-primary/50"
                          >
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {t.frontmatter.task || t.file}
                              </span>
                              {t.frontmatter.status && (
                                <Badge
                                  variant={statusVariant(t.frontmatter.status)}
                                  className="ms-auto shrink-0"
                                >
                                  {t.frontmatter.status}
                                </Badge>
                              )}
                            </div>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {t.entries.length} 条 · {t.frontmatter.version || ''}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  {chains.length > 0 && (
                    <TabsContent value="chains">
                      <div className="grid gap-2">
                        {chains.slice(0, 8).map((c) => (
                          <div
                            key={c.root}
                            className="flex flex-wrap items-center gap-1 rounded-md border p-2"
                          >
                            {c.runs.map((r, i) => (
                              <span key={r.id} className="flex items-center gap-1">
                                {i > 0 && <span className="text-muted-foreground">→</span>}
                                <button
                                  onClick={() => openRun(r.id)}
                                  className={cn(
                                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent',
                                    r.employee === keyId && 'bg-primary/10',
                                  )}
                                  title={runSummary(r, 60)}
                                >
                                  <EmployeeAvatar
                                    employee={employees[r.employee]}
                                    fallback={r.employee}
                                    className="size-4"
                                  />
                                  {employees[r.employee]?.displayName ?? r.employee}
                                </button>
                              </span>
                            ))}
                          </div>
                        ))}
                      </div>
                    </TabsContent>
                  )}

                  <TabsContent value="role">
                    <Markdown>{detail.roleMd || '（空）'}</Markdown>
                  </TabsContent>

                  <TabsContent value="lessons">
                    <Markdown>{detail.memoryMd || '暂无教训沉淀'}</Markdown>
                  </TabsContent>

                  {detail.templates?.length > 0 && (
                    <TabsContent value="templates">
                      <div className="grid gap-1.5">
                        {detail.templates.map((t) => (
                          <button
                            key={t.file}
                            onClick={() => openFile(t.file)}
                            className="rounded-md border px-2 py-1.5 text-start text-sm hover:border-primary/50"
                          >
                            {t.title}
                          </button>
                        ))}
                      </div>
                    </TabsContent>
                  )}

                  <TabsContent value="agent">
                    <Markdown>{detail.agentMd || '无'}</Markdown>
                  </TabsContent>
                </ScrollArea>
              </Tabs>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="grid gap-0.5 rounded-md border bg-muted/20 p-2 text-center">
      <span className="truncate text-sm font-semibold">{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

// 推送头像预览：加载失败(私链/内网/404)时降级为占位，避免破图
function IconPreview({ src }: { src?: string }) {
  const [bad, setBad] = useState(false)
  useEffect(() => setBad(false), [src])
  if (!src || bad) {
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/40 text-[10px] text-muted-foreground">
        无
      </span>
    )
  }
  return (
    <img
      src={src}
      alt="通知头像预览"
      onError={() => setBad(true)}
      className="size-8 shrink-0 rounded-md border object-cover"
    />
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
}

// 巡视员配置编辑器（仅 chaorenq）——对齐旧 UI savePatrolConfig
function PatrolConfig() {
  const [cfg, setCfg] = useState<any>(null)
  useEffect(() => {
    apiGet('/api/chain-config').then(setCfg).catch(() => {})
  }, [])
  if (!cfg) return null
  const set = (patch: any) => setCfg((c: any) => ({ ...c, ...patch }))
  async function save() {
    try {
      await apiPost('/api/chain-config', cfg)
      toast.success('巡检配置已保存')
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    }
  }
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="text-sm font-medium">巡检配置</div>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>启用空停巡查</span>
        <Switch checked={!!cfg.patrolEnabled} onCheckedChange={(v) => set({ patrolEnabled: v })} />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <div className="grid gap-1">
          <Label className="text-xs">扫描间隔(分)</Label>
          <Input type="number" value={cfg.patrolSweepMin ?? 1} onChange={(e) => set({ patrolSweepMin: Number(e.target.value) })} />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">宽限(秒)</Label>
          <Input type="number" value={cfg.patrolGraceSec ?? 16} onChange={(e) => set({ patrolGraceSec: Number(e.target.value) })} />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">续跑上限</Label>
          <Input type="number" value={cfg.patrolMax ?? 1} onChange={(e) => set({ patrolMax: Number(e.target.value) })} />
        </div>
      </div>
      <Button size="sm" className="justify-self-start" onClick={save}>保存巡检配置</Button>
    </div>
  )
}
