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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SafeOLCard } from '@/components/olcard'
import { QuickPhrasesPanel } from '@/components/quick-phrases-panel'
import { EngineSettings } from '@/components/engine-settings'
import { useEmployees } from '@/hooks/use-employees'
import { apiGet, apiPost } from '@/lib/api'
import { cn } from '@/lib/utils'

type Ctx = { open: (section?: SectionId) => void }
const SettingsContext = createContext<Ctx>({ open: () => {} })
export function useSettings() {
  return useContext(SettingsContext)
}

const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'engines', label: 'Agent 基座' },
  { id: 'phrases', label: '快捷短语' },
  { id: 'push', label: '手机推送' },
  { id: 'zhuzhu', label: '猪猪对接' },
  { id: 'wecom', label: '企微渠道' },
  { id: 'lark', label: '飞书需求表' },
  { id: 'mirror', label: '企微镜像' },
  { id: 'wecomdoc', label: '企微表格（降级）' },
  { id: 'cards', label: '消息卡片' },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SectionId>('general')
  const openDlg = useCallback((s?: SectionId) => {
    if (s) setSection(s)
    setOpen(true)
  }, [])
  return (
    <SettingsContext.Provider value={{ open: openDlg }}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[600px] max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b p-4">
            <DialogTitle>设置</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            {/* 窄屏是横向可划的分段条：no-scrollbar 去掉那条压在标签下方的系统滚动条（手指直接划就行，
                露一条灰杠只是噪声），并给足 40px 行高。 */}
            <nav className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/30 p-2 sm:w-44 sm:flex-col sm:overflow-y-auto sm:border-e sm:border-b-0">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={cn(
                    'h-10 shrink-0 rounded-md px-3 text-start text-sm transition-colors sm:h-auto sm:py-2',
                    section === s.id
                      ? 'bg-background font-medium text-foreground shadow-xs'
                      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </nav>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-5">
                {open && section === 'general' && <GeneralPanel />}
                {open && section === 'engines' && <EngineSettings />}
                {open && section === 'phrases' && <QuickPhrasesPanel />}
                {open && section === 'push' && <ConfigPanel key="push" path="/api/push-config" render={pushFields} testPath="/api/push-test" testLabel="发送测试推送" />}
                {open && section === 'zhuzhu' && <ZhuzhuPanel />}
                {open && section === 'wecom' && <WecomPanel />}
                {open && section === 'lark' && <LarkPanel />}
                {open && section === 'mirror' && <MirrorPanel />}
                {open && section === 'wecomdoc' && <WecomDocPanel />}
                {open && section === 'cards' && <CardsGallery />}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsContext.Provider>
  )
}

// ---- 复用表单原件 ----
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

const DERIVED = new Set([
  'botSecretSet', 'appSecretSet', 'webhookUrlSet', 'larkReady', 'credsReady',
  'credsFromEnv', 'configured', 'lastSyncAt', 'lastError', 'statusPending',
  'cliInstalled', 'fallbackReady', 'lastAuthStatus', 'lastCheckAt', 'degraded',
])
function stripDerived<T extends Record<string, any>>(cfg: T): T {
  const out = { ...cfg }
  for (const k of DERIVED) delete out[k]
  return out
}

// 通用 config 面板（load→edit→save 整对象）
function ConfigPanel({
  path,
  testPath,
  testLabel,
  render,
}: {
  path: string
  testPath?: string
  testLabel?: string
  render: (cfg: any, set: (patch: any) => void) => ReactNode
}) {
  const [cfg, setCfg] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    apiGet(path).then(setCfg).catch((e) => toast.error('加载失败', { description: (e as Error).message }))
  }, [path])
  if (!cfg) return <PanelSkeleton />
  const set = (patch: any) => setCfg((c: any) => ({ ...c, ...patch }))
  async function save() {
    setSaving(true)
    try {
      await apiPost(path, stripDerived(cfg))
      toast.success('已保存')
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="grid gap-3">
      {render(cfg, set)}
      <div className="flex gap-2">
        <Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
        {testPath && (
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const r = await apiPost<any>(testPath)
                // 服务端连通测试常返回 200 + {ok:false, message, snippet}
                if (r && r.ok === false) {
                  toast.error(r.message || '测试未通过', { description: r.snippet })
                } else {
                  toast.success(r?.message || '测试通过')
                }
              } catch (e) {
                toast.error('测试失败', { description: (e as Error).message })
              }
            }}
          >
            {testLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

function PanelSkeleton() {
  return <div className="h-40 animate-pulse rounded-md bg-muted" />
}

// ---- 各面板字段 ----
function pushFields(cfg: any, set: (p: any) => void) {
  return (
    <>
      <SwitchRow label="启用推送" checked={!!cfg.enabled} onChange={(v) => set({ enabled: v })} />
      <Row label="Bark URL">
        <Input value={cfg.barkUrl || ''} onChange={(e) => set({ barkUrl: e.target.value })} />
      </Row>
      <Row label="图标基址 iconBase">
        <Input value={cfg.iconBase || ''} onChange={(e) => set({ iconBase: e.target.value })} />
      </Row>
      <Row label="工作台基址 labBaseUrl">
        <Input value={cfg.labBaseUrl || ''} onChange={(e) => set({ labBaseUrl: e.target.value })} />
      </Row>
      <div className="grid grid-cols-3 gap-2">
        <SwitchRow label="完成" checked={!!cfg.on?.done} onChange={(v) => set({ on: { ...cfg.on, done: v } })} />
        <SwitchRow label="出错" checked={!!cfg.on?.error} onChange={(v) => set({ on: { ...cfg.on, error: v } })} />
        <SwitchRow label="中断" checked={!!cfg.on?.interrupted} onChange={(v) => set({ on: { ...cfg.on, interrupted: v } })} />
      </div>
      <SwitchRow label="AI 摘要" checked={!!cfg.aiSummary} onChange={(v) => set({ aiSummary: v })} />
      <SwitchRow label="审批也推送" checked={!!cfg.approvalPush} onChange={(v) => set({ approvalPush: v })} />
      <Row label="推送范围">
        <Select value={cfg.scope || 'all'} onValueChange={(v) => set({ scope: v })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部运行</SelectItem>
            <SelectItem value="dispatch">仅派工</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="提示音 sound" hint="Bark 铃声名，留空为默认">
        <Input value={cfg.sound || ''} onChange={(e) => set({ sound: e.target.value })} />
      </Row>
    </>
  )
}

function ZhuzhuPanel() {
  const { employees } = useEmployees()
  return (
    <ConfigPanel
      path="/api/zhuzhu-config"
      testPath="/api/zhuzhu-test"
      testLabel="连通测试"
      render={(cfg, set) => (
        <>
          <SwitchRow label="启用猪猪对接" checked={!!cfg.enabled} onChange={(v) => set({ enabled: v })} />
          <Row label="基地址 baseUrl" hint="别写死主机，以此设置为准">
            <Input value={cfg.baseUrl || ''} onChange={(e) => set({ baseUrl: e.target.value })} />
          </Row>
          <Row label="被测前端地址 targetBaseUrl" hint="不是猪猪的地址；环境指纹(Z-B)少了它直接 400，等于查不了「跑的是不是最新 bundle」">
            <Input
              placeholder="http://localhost:8000"
              value={cfg.targetBaseUrl || ''}
              onChange={(e) => set({ targetBaseUrl: e.target.value })}
            />
          </Row>
          <Row label="对接文档路径 docPath">
            <div className="flex gap-2">
              <Input value={cfg.docPath || ''} onChange={(e) => set({ docPath: e.target.value })} />
              <Button
                variant="outline"
                onClick={() => window.open((cfg.baseUrl || '') + (cfg.docPath || ''), '_blank')}
              >
                打开
              </Button>
            </div>
          </Row>
          <Row label="注入给哪些员工 injectFor">
            <div className="flex flex-wrap gap-3">
              {Object.keys(employees).map((k) => {
                const arr: string[] = cfg.injectFor || []
                const on = arr.includes(k)
                return (
                  <label key={k} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={on}
                      onCheckedChange={(c) =>
                        set({ injectFor: c ? [...arr, k] : arr.filter((x) => x !== k) })
                      }
                    />
                    {employees[k].displayName}
                  </label>
                )
              })}
            </div>
          </Row>
          {/* 猪猪 v1.5 起 App-run/MCP 从「绑 0.0.0.0 且无鉴权」改成「默认回环 + 写操作需 token」。
              只读不受影响；引擎对所有猪猪调用统一带上（有就带），免得 v1.5 上线那天写调用一起 401。
              存工作区配置文件而非环境变量：引擎是长驻托盘进程，环境变量要重启整棵会话树才生效。 */}
          <Row label="写操作 token" hint="猪猪 v1.5 起写操作需鉴权（只读不需要）；留空＝不带">
            <Input
              type="password"
              autoComplete="off"
              placeholder="v1.5 之前留空即可"
              value={cfg.writeToken || ''}
              onChange={(e) => set({ writeToken: e.target.value })}
            />
          </Row>
          <Row label="能力探活" hint="verify_evidence / report-card / preflight / 环境指纹 / ui-contract 现在通不通">
            <ZhuzhuCapabilityProbe />
          </Row>
          <Row label="备注 note">
            <Textarea value={cfg.note || ''} onChange={(e) => set({ note: e.target.value })} className="min-h-16" />
          </Row>
        </>
      )}
    />
  )
}

// 猪猪 v1.5 新能力探活：一次真调六个端点，把「哪些机器门是开的」摆出来。
// 为什么要这块 UI：这些能力缺位时，QA 结论只能记「未验证」而不是「通过」——但如果界面上看不见
// 哪些缺位，人就会默认「应该都通了」，于是「未验证」被当成「通过」，假绿又回来了。
function ZhuzhuCapabilityProbe() {
  const [rows, setRows] = useState<
    { key: string; label: string; z: string; available: boolean; why: string }[] | null
  >(null)
  const [busy, setBusy] = useState(false)
  const probe = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/zhuzhu-capabilities').then((x) => x.json())
      setRows(
        Object.entries(r.map || {}).map(([key, v]: [string, any]) => ({
          key,
          label: v.label,
          z: v.z,
          available: !!v.available,
          why: v.why || '',
        })),
      )
    } catch (e) {
      setRows([{ key: 'error', label: '探活失败', z: '—', available: false, why: String(e) }])
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={probe} disabled={busy}>
        {busy ? '探活中…' : '探活一次'}
      </Button>
      {rows && (
        <div className="space-y-1 text-xs">
          {rows.map((r) => (
            <div key={r.key} className="flex items-start gap-2">
              <span className={r.available ? 'text-emerald-500' : 'text-amber-500'}>
                {r.available ? '✅' : '❌'}
              </span>
              <span className="shrink-0 font-mono opacity-70">{r.z}</span>
              <span className="shrink-0">{r.label}</span>
              {!r.available && <span className="opacity-60">— {r.why}</span>}
            </div>
          ))}
          {rows.some((r) => !r.available) && (
            <div className="pt-1 opacity-70">
              缺位的能力对应的机器门**开不了**：凡依赖它们的结论一律记「未验证」，不记「通过」。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function WecomPanel() {
  const [secret, setSecret] = useState('')
  return (
    <ConfigPanel
      path="/api/wecom-config"
      testPath="/api/wecom-test"
      testLabel="测试"
      render={(cfg, set) => (
        <>
          <SwitchRow label="启用企微渠道" checked={!!cfg.enabled} onChange={(v) => set({ enabled: v })} />
          <Row label="Bot ID">
            <Input value={cfg.botId || ''} onChange={(e) => set({ botId: e.target.value })} />
          </Row>
          <Row label="Bot Secret" hint={cfg.botSecretSet ? '已设置（留空不改）' : '未设置'}>
            <Input
              type="password"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value)
                set({ botSecret: e.target.value })
              }}
              placeholder="••••••"
            />
          </Row>
          <Row label="RAG API URL">
            <Input value={cfg.ragApiUrl || ''} onChange={(e) => set({ ragApiUrl: e.target.value })} />
          </Row>
          <Row label="欢迎语">
            <Textarea value={cfg.welcome || ''} onChange={(e) => set({ welcome: e.target.value })} className="min-h-16" />
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="每日额度默认">
              <Input
                type="number"
                value={cfg.kbDailyQuotaDefault ?? 0}
                onChange={(e) => set({ kbDailyQuotaDefault: Number(e.target.value) })}
              />
            </Row>
            <SwitchRow label="仅白名单" checked={!!cfg.kbWhitelistOnly} onChange={(v) => set({ kbWhitelistOnly: v })} />
          </div>
          {cfg.users && Object.keys(cfg.users).length > 0 && (
            <Row label="白名单成员（额度可编辑）">
              <div className="grid gap-1">
                {Object.entries<any>(cfg.users).map(([uid, u]) => (
                  <div key={uid} className="flex items-center gap-2 rounded border px-2 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate">{u.name || uid}</span>
                    <span className="text-muted-foreground">额度</span>
                    <Input
                      type="number"
                      value={u.kbDailyQuota ?? 0}
                      onChange={(e) =>
                        set({ users: { ...cfg.users, [uid]: { ...u, kbDailyQuota: Number(e.target.value) } } })
                      }
                      className="h-7 w-20"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => {
                        const next = { ...cfg.users }
                        delete next[uid]
                        set({ users: next })
                      }}
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
            </Row>
          )}
          <WecomExtras cfg={cfg} set={set} />
        </>
      )}
    />
  )
}

// 企微：运行状态 + 连通测试 + 已对话用户（加入白名单）
function WecomExtras({ cfg, set }: { cfg: any; set: (p: any) => void }) {
  const [status, setStatus] = useState<any>(null)
  const [known, setKnown] = useState<any[] | null>(null)
  useEffect(() => {
    apiGet('/api/wecom-status').then(setStatus).catch(() => {})
  }, [])
  const inWhitelist = (uid: string) => !!cfg.users?.[uid]
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {status ? (
          <>
            <Badge variant={status.running ? 'default' : 'secondary'}>
              {status.running ? '运行中' : '未运行'}
            </Badge>
            {status.pid ? <span className="text-muted-foreground">pid {status.pid}</span> : null}
            {status.lastError && (
              <span className="truncate text-muted-foreground" title={status.lastError}>
                {String(status.lastError).slice(0, 40)}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">状态加载中…</span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ms-auto"
          onClick={async () => {
            try {
              const r = await apiPost<any>('/api/wecom-connect-test')
              if (r && r.ok === false) toast.error(r.message || '连通失败', { description: r.snippet })
              else toast.success(r?.message || '连通正常')
            } catch (e) {
              toast.error('连通测试失败', { description: (e as Error).message })
            }
          }}
        >
          测试连通
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              const r = await apiGet<any>('/api/wecom/known-users')
              setKnown(Array.isArray(r) ? r : r.users || [])
            } catch (e) {
              toast.error('拉取失败', { description: (e as Error).message })
            }
          }}
        >
          拉取已对话用户
        </Button>
      </div>
      {known && (
        <div className="grid gap-1">
          {known.length === 0 && <span className="text-xs text-muted-foreground">无</span>}
          {known.map((u: any) => {
            const uid = u.userid || u.id || String(u)
            const name = u.name || uid
            return (
              <div key={uid} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs">
                <span className="truncate">{name}</span>
                {inWhitelist(uid) ? (
                  <Badge variant="secondary">已在名单</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6"
                    onClick={() =>
                      set({ users: { ...(cfg.users || {}), [uid]: { name, kbDailyQuota: cfg.kbDailyQuotaDefault ?? 20 } } })
                    }
                  >
                    加入白名单
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function LarkPanel() {
  const [secret, setSecret] = useState('')
  const [fields, setFields] = useState<string[] | null>(null)
  return (
    <ConfigPanel
      path="/api/lark-config"
      render={(cfg, set) => (
        <>
          <Row label="App ID">
            <Input value={cfg.appId || ''} onChange={(e) => set({ appId: e.target.value })} />
          </Row>
          <Row label="App Secret" hint={cfg.appSecretSet ? '已设置（留空不改）' : '未设置'}>
            <Input
              type="password"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value)
                set({ appSecret: e.target.value })
              }}
              placeholder="••••••"
            />
          </Row>
          <Row label="App Token">
            <Input value={cfg.appToken || ''} onChange={(e) => set({ appToken: e.target.value })} />
          </Row>
          <Row label="Table ID">
            <Input value={cfg.tableId || ''} onChange={(e) => set({ tableId: e.target.value })} />
          </Row>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const r = await apiGet<any>('/api/lark/fields')
                  setFields(Array.isArray(r) ? r : r.fields || Object.keys(r || {}))
                } catch (e) {
                  toast.error('拉取字段失败', { description: (e as Error).message })
                }
              }}
            >
              检测表字段
            </Button>
            {fields && (
              <div className="mt-2 flex flex-wrap gap-1">
                {fields.map((f) => (
                  <Badge key={String(f)} variant="secondary" className="text-[11px]">{String(f)}</Badge>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    />
  )
}

// 企微智能表格（经官方 wecom-cli）。**当前降级未启用**：企微机器人能力按项分授权，只批到
// 「创建/编辑文档」，「搜索与获取文档内容」需领导审批 → 写得进读不出，当不了主表，主表仍是飞书。
// 读权限批下来后，把「作为主表」打开即全部生效（引擎侧 isPrimary）。
function WecomDocPanel() {
  const [hook, setHook] = useState('')
  const [fields, setFields] = useState<string[] | null>(null)
  const [testing, setTesting] = useState(false)
  return (
    <ConfigPanel
      path="/api/wecom-doc-config"
      render={(cfg, set) => (
        <>
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <strong>当前降级、未作为主表启用。</strong>企微机器人只获批「创建/编辑文档」，缺「搜索与获取文档内容」
            （需领导审批）→ 表<strong>写得进但读不出</strong>，因此需求表仍以<strong>飞书</strong>为准，企微同事看的是「企微镜像」那张。
            读权限批下来后打开下面的「作为主表」即全部生效。
          </p>
          {!cfg.cliInstalled && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
              未检测到 wecom-cli。先在终端跑 <code className="font-mono">npm install -g @wecom/cli</code>，再跑{' '}
              <code className="font-mono">wecom-cli auth init</code> 用企业微信扫码授权。
            </p>
          )}
          <SwitchRow label="启用企微表能力" checked={!!cfg.enabled} onChange={(v) => set({ enabled: v })} />
          <SwitchRow label="作为主表（需读权限已获批）" checked={!!cfg.isPrimary} onChange={(v) => set({ isPrimary: v })} />
          <Row label="表 docid" hint="s3_ 开头，取自表 URL 或建表返回。⚠ 企业模式下机器人只能读写自己创建的表">
            <Input value={cfg.docid || ''} onChange={(e) => set({ docid: e.target.value })} placeholder="s3_xxxxxx" />
          </Row>
          <Row label="子表名">
            <Input value={cfg.sheetTitle || ''} onChange={(e) => set({ sheetTitle: e.target.value })} placeholder="需求池" />
          </Row>
          <Row label="表链接（可选，仅展示用）">
            <Input value={cfg.docUrl || ''} onChange={(e) => set({ docUrl: e.target.value })} placeholder="https://doc.weixin.qq.com/smartsheet/..." />
          </Row>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={testing}
              onClick={async () => {
                setTesting(true)
                try {
                  const r = await apiPost<any>('/api/wecom-doc/test')
                  if (r.ok) toast.success('连通正常', { description: r.message })
                  else toast.error('未连通', { description: r.message })
                } catch (e) {
                  toast.error('测试失败', { description: (e as Error).message })
                } finally {
                  setTesting(false)
                }
              }}
            >
              {testing ? '测试中…' : '连通测试'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const r = await apiGet<any>('/api/wecom-doc/fields')
                  if (!r.ok) return toast.error('拉取字段失败', { description: r.message })
                  setFields((r.fields || []).map((f: any) => f.field_title || f.title).filter(Boolean))
                } catch (e) {
                  toast.error('拉取字段失败', { description: (e as Error).message })
                }
              }}
            >
              拉取字段
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const r = await apiPost<any>('/api/wecom-doc/sync-to-lark')
                  if (r.ok) toast.success('已同步到飞书副本', { description: `新增 ${r.added} / 更新 ${r.updated}${r.failed ? ` / 失败 ${r.failed}` : ''}` })
                  else toast.error('同步失败', { description: r.error })
                } catch (e) {
                  toast.error('同步失败', { description: (e as Error).message })
                }
              }}
            >
              同步到飞书副本
            </Button>
          </div>
          {cfg.lastAuthStatus && (
            <p className="text-xs text-muted-foreground">
              授权态：{cfg.lastAuthStatus === 'authorized' ? '已授权' : cfg.lastAuthStatus === 'missing' ? 'CLI 未安装' : '未授权'}
              {cfg.lastCheckAt ? ` · ${new Date(cfg.lastCheckAt).toLocaleString()}` : ''}
            </p>
          )}
          {cfg.lastError && <p className="text-xs text-destructive">上次错误：{cfg.lastError}</p>}
          {fields && (
            <div className="flex flex-wrap gap-1">
              {fields.map((f) => (
                <Badge key={String(f)} variant="secondary" className="text-[11px]">{String(f)}</Badge>
              ))}
            </div>
          )}

          <div className="mt-2 border-t pt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              写兜底（可选）：企业模式下若 CLI 写入被拒（851003），改走本表「接收外部数据」Webhook。留空则 CLI 写不进去时直接如实报错。
            </p>
            <Row label="Webhook URL" hint={cfg.webhookUrlSet ? '已设置（留空不改）' : '未设置'}>
              <Input
                type="password"
                value={hook}
                onChange={(e) => {
                  setHook(e.target.value)
                  set({ webhookUrl: e.target.value })
                }}
                placeholder="••••••"
              />
            </Row>
          </div>
        </>
      )}
    />
  )
}

function MirrorPanel() {
  const [hook, setHook] = useState('')
  return (
    <ConfigPanel
      path="/api/wecom-mirror-config"
      render={(cfg, set) => (
        <>
          <p className="rounded-md border border-muted bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            「飞书主表 → 企微」单向只读镜像，给没有飞书的企微同事看。<strong>当前仍是同事看需求的唯一渠道</strong>
            （企微表格能力因缺读权限已降级）。只有把「企微表格」设为主表后，这里的自动推送才会退场。
          </p>
          <SwitchRow label="启用企微镜像" checked={!!cfg.enabled} onChange={(v) => set({ enabled: v })} />
          <Row label="Webhook URL" hint={cfg.webhookUrlSet ? '已设置（留空不改）' : '未设置'}>
            <Input
              type="password"
              value={hook}
              onChange={(e) => {
                setHook(e.target.value)
                set({ webhookUrl: e.target.value })
              }}
              placeholder="••••••"
            />
          </Row>
          <Row label="同步间隔（分钟）">
            <Input type="number" value={cfg.syncMin ?? 3} onChange={(e) => set({ syncMin: Number(e.target.value) })} />
          </Row>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => apiPost('/api/wecom-mirror/sync').then(() => toast.success('已触发同步')).catch((e) => toast.error('失败', { description: (e as Error).message }))}>
              立即同步
            </Button>
            <Button variant="outline" size="sm" onClick={() => apiPost('/api/wecom-mirror/reset').then(() => toast.success('已重置')).catch((e) => toast.error('失败', { description: (e as Error).message }))}>
              重置
            </Button>
          </div>
        </>
      )}
    />
  )
}

function GeneralPanel() {
  const [cfg, setCfg] = useState<any>(null)
  const [maxDraft, setMaxDraft] = useState('')
  useEffect(() => {
    apiGet<any>('/api/chain-config')
      .then((c) => {
        setCfg(c)
        setMaxDraft(String(c?.bootResumeMax ?? 10))
      })
      .catch(() => {})
  }, [])
  // 只 POST 改动的字段（后端按字段增量合并）
  async function save(patch: Record<string, unknown>, okMsg: string) {
    setCfg((c: any) => ({ ...(c || {}), ...patch }))
    try {
      const r = await apiPost<{ config: any }>('/api/chain-config', patch)
      if (r?.config) setCfg(r.config)
      toast.success(okMsg)
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    }
  }
  function commitMax() {
    const n = Math.floor(Number(maxDraft))
    if (!Number.isFinite(n) || n < 0) {
      setMaxDraft(String(cfg?.bootResumeMax ?? 10))
      return
    }
    const v = Math.min(50, n)
    setMaxDraft(String(v))
    if (v !== cfg?.bootResumeMax) save({ bootResumeMax: v }, v === 0 ? '已关闭引擎重启后自动接回' : `自动接回上限改为 ${v} 次`)
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">主题在左下角切换（浅色 / 深色 / 跟随系统）。</p>
      {cfg && (
        <>
          <SwitchRow
            label="自动接棒（auto-chain）"
            checked={!!cfg.enabled}
            onChange={(v) => save({ enabled: v }, v ? '已开启自动接棒' : '已关闭自动接棒')}
          />
          <Row
            label="引擎重启后自动接回次数上限"
            hint="引擎崩溃或重启打断了员工会话时，自动接着原会话往下做。每条会话累计超过这个次数就不再接、留给你处理；填 0 表示不自动接回。"
          >
            <Input
              type="number"
              min={0}
              max={50}
              value={maxDraft}
              onChange={(e) => setMaxDraft(e.target.value)}
              onBlur={commitMax}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </Row>
          <SwitchRow
            label="自动接回指数退避（第 1 次立即，之后 30 秒 / 1 / 2 / 4 分钟…逐次翻倍，最长 30 分钟）"
            checked={cfg.bootResumeBackoff !== false}
            onChange={(v) => save({ bootResumeBackoff: v }, v ? '已开启指数退避' : '已关闭指数退避（每次立即接回）')}
          />
        </>
      )}
    </div>
  )
}

const DEMO_CARDS = [
  { type: 'link', eyebrow: '合并请求 · 波比', title: 'v5.13.1 → master', subtitle: '测试发布', meta: [{ k: '目标分支', v: 'master' }], links: [{ label: '前端 MR', url: '#', hint: '!123' }, { label: '后端 service MR', url: '#', hint: '!456' }] },
  { type: 'code', eyebrow: 'Release SQL · 波比', title: '建表 + 改表', lang: 'sql', filename: 'V20260721__x.sql', download: true, content: "ALTER TABLE t_sampling_task\n  ADD COLUMN pattern_review_status TINYINT DEFAULT 0;" },
  { type: 'code', eyebrow: '发布通知话术 · 波比', title: '整段复制转发给发布管理员', lang: 'text', content: '【示例项目5.21版本发布】\n后端：\nhttp://192.0.2.143:1180/backend/web-app/backend/merge_requests/284/diffs\n\n前端：\nhttp://192.0.2.143:1180/web/backend-center/web-app/merge_requests/2205/diffs' },
  { type: 'file', eyebrow: '转发附件 · 波比', title: '随发布通知转发的文件', files: [{ path: 'CHANGELOG.md', label: 'CHANGELOG（示例文件，可真点）', hint: '点名字预览' }, { path: 'docs/示例项目需求/06-v5.21/sql/V2609041100__v5.21_release.sql', label: 'release SQL', hint: '交 DBA 执行' }], note: '点「复制文件」后到企微直接 Ctrl+V；远程访问时前两个按钮不可用，请用下载' },
  { type: 'checklist', eyebrow: '部署清单 · 波比', title: '本次部署', items: [{ label: 'service', hint: '8040 · 直接改动', status: 'pending' }, { label: 'gys-web', hint: '8042 · 连带重发', status: 'pending' }, { label: 'web', hint: '8041 · 无改动', status: 'skip' }], note: '库模块先合再发依赖服务' },
  { type: 'table', eyebrow: '仓库枚举 · 波比', title: '领先 release 的提交数', columns: ['仓库', '领先数', '进范围'], rows: [['service', '4', '✅'], [{ v: 'service（污染?）', tone: 'danger' }, { v: '3402', tone: 'danger' }, { v: '⚠ 停下排查', tone: 'danger' }]] },
  { type: 'stepper', eyebrow: '猪猪 E2E · 迷糊老师', title: '执行进度', steps: [{ label: 'validate', status: 'ok' }, { label: 'headless', status: 'running' }, { label: 'App-run 终验', status: 'pending', hint: '等前置绿' }] },
  { type: 'fields', eyebrow: '权限变更 · 菲菲', title: '本版新增权限', groups: [{ 权限码: 'sampling:pattern:review', 业务名称: '打样版型审核', 面向菜单: '打样工作台/版型审核', 建议角色: '版型审核员' }] },
  { type: 'approval', eyebrow: '发布放行 · 波比', title: '请确认执行', items: [{ label: '合并前端 MR → master', hint: '!123' }, { label: '部署 service:8040', hint: '库先合' }], approve: { label: '批准执行', reply: '✅ 已批准' }, reject: { label: '暂缓', reply: '⛔ 暂缓' } },
  { type: 'decision', eyebrow: '待拍板 · 菲菲', title: 'REQ0109 归属', question: '版本已发测试，如何归属这条插单？', options: [{ label: '并入本版', desc: '需再发一轮测试' }, { label: '排下一版', desc: '节奏最稳', recommended: true }, { label: '独立 hotfix' }] },
  { type: 'multiselect', eyebrow: '多选 · 菲菲', title: '本版并入哪些插单？', question: '勾选要并入本版的插单：', submitLabel: '确认并入', options: [{ label: 'REQ-0216 缺陷打回', desc: 'bugfix', checked: true }, { label: 'REQ-0217 主看板两列', desc: '需再发测试' }, { label: 'REQ-0218 筛选调整' }] },
  { type: 'defect', eyebrow: '缺陷单 · 迷糊老师', title: '版型审核后状态未刷新', id: 'BUG-003', severity: 'P0', status: 'RED', desc: '复现：审核通过 → 不刷新 → 状态未变。', actions: [{ label: '指派 GG Bond', reply: '指派 #BUG-003 给 GG Bond' }, { label: '标记复测', reply: '#BUG-003 进复测' }] },
  { type: 'toggle', eyebrow: '封板 · 波比', title: '进入发布阶段，是否封板？', question: '封板后新插单默认排下一版本。', on: { label: '确认封板', reply: '确认封板' }, off: { label: '暂不', reply: '暂不封板' } },
  { type: 'gate', eyebrow: '等你拍板 · GG Bond', title: '人工预检是否通过', question: '过一眼 UI/UX，或在下面补充意见/贴图。', options: [{ label: '通过，交回归', reply: '预检通过，交迷糊回归' }, { label: '打回重改', reply: '预检打回，见说明' }], accept: ['text', 'image'] },
  { type: 'gallery', eyebrow: '测试证据 · 迷糊老师', title: '版型审核回归', images: [{ src: '/logo.png', caption: '审核通过后状态刷新' }] },
]
function CardsGallery() {
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">消息卡片（OLCards）类型预览：</p>
      {DEMO_CARDS.map((c, i) => (
        <SafeOLCard key={i} data={c as any} ctx={{}} />
      ))}
    </div>
  )
}
