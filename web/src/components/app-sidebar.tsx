import { useState, type ReactNode } from 'react'

import {
  KanbanIcon,
  UsersFourIcon,
  ShieldCheckIcon,
  GearSixIcon,
  SidebarSimpleIcon,
  MagnifyingGlassIcon,
  MoonStarsIcon,
  ListChecksIcon,
  type Icon,
} from '@phosphor-icons/react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { ModeToggle } from '@/components/mode-toggle'
import { useSseStatus } from '@/components/sse-provider'
import { useSettings } from '@/components/settings-dialog'
import { useEmployeeDetail } from '@/components/employee-detail'
import { useRunDetail } from '@/components/run-detail-provider'
import { EmployeeAvatar, EmployeeStatusBadge } from '@/components/employee-avatar'
import { PatrolCountdown, PatrolRadar, type PatrolPhase } from '@/components/patrol-radar'
import { GuardedLaunchDialog } from '@/components/guarded-launch-dialog'
import { AcceptanceDeskDialog } from '@/components/acceptance-cards'
import { LanePanel } from '@/components/lane-panel'
import { useEmployees } from '@/hooks/use-employees'
import { useEmployeeStatus } from '@/components/employee-status-provider'
import { usePoll } from '@/hooks/use-poll'
import { empState, EMP_STATE_LABEL } from '@/lib/status'
import { mostRecentRun, runSummary } from '@/lib/run-threads'
import type { Health } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// 「员工」「会话」两个导航已去掉（老板 2026-10-19）：员工就在侧栏下方的员工列表里，点头像即开会话；
// 会话之间的往来改由会话内的交棒胶囊直达（transcript HandoffRow），不再需要单独一页。
export type ViewId = 'kanban' | 'meeting' | 'patrol'

export const NAV: { id: ViewId; label: string; icon: Icon }[] = [
  { id: 'kanban', label: '任务', icon: KanbanIcon },
  { id: 'meeting', label: '会议室', icon: UsersFourIcon },
  { id: 'patrol', label: '巡检', icon: ShieldCheckIcon },
]

export function AppSidebar({
  view,
  onNavigate,
}: {
  view: ViewId
  onNavigate: (v: ViewId) => void
}) {
  const status = useSseStatus()
  const settings = useSettings()
  const { toggleSidebar, setOpenMobile } = useSidebar()
  const { data: health } = usePoll<Health>('/api/health', 10000)
  // 版本号唯一事实源是 app/package.json（server.js 启动时读进 VERSION，经 /api/health 下发）——
  // 前端不许再写死一份，否则又会出现「代码改了、界面还印着旧版本」的流水与事实脱节。
  const version = health?.version ? `v${String(health.version).replace(/^v/i, '')}` : ''
  const [guardedOpen, setGuardedOpen] = useState(false)
  const [deskOpen, setDeskOpen] = useState(false)
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* 折叠成图标轨时**去掉这层自己的 px-2**：外层 SidebarHeader 已有 p-2，两层叠加在 48px 的轨里
            只剩 16px，而 logo 是 size-8(32px) → 直接被裁掉大半（老板截图里那个缺角的 logo 就是它）。
            折叠态改为无横向内边距 + 居中，logo 收到 size-7，与下面那排 32px 图标按钮对齐。 */}
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <img
            src="/logo.png"
            alt="望子成龙小学"
            className="size-8 shrink-0 rounded-md object-cover group-data-[collapsible=icon]:size-7"
          />
          <div className="leading-tight group-data-[collapsible=icon]:hidden">
            <div className="text-sm font-semibold">望子成龙小学</div>
            <div className="text-xs text-muted-foreground">
              Office Lab
              {version && (
                <>
                  {' · '}
                  <em className="font-normal tabular-nums" title="引擎版本（app/package.json）">
                    {version}
                  </em>
                </>
              )}
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作区</SidebarGroupLabel>
          <SidebarMenu>
            {NAV.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={view === item.id}
                  onClick={() => {
                    onNavigate(item.id)
                    setOpenMobile(false)
                  }}
                  tooltip={item.label}
                >
                  <item.icon weight={view === item.id ? 'fill' : 'regular'} />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {/* 守航冷启动：全局入口，不依赖任务卡片——菲菲从 0 起草需求、整链守航到 RC_READY 待晨检。
            派工弹窗的「守航态」勾选仍留给「已有卡片/已有档案」的场景。 */}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              {/* 受控开关而非 DialogTrigger asChild：带 tooltip 的 SidebarMenuButton 返回的是 <Tooltip> 树，
                  Slot 克隆不到里面那个真实 button，点击会落空（见 ui/sidebar.tsx SidebarMenuButton）。 */}
              <SidebarMenuButton
                tooltip="守航开工（无人值守·菲菲从 0 起草）"
                onClick={() => setGuardedOpen(true)}
              >
                <MoonStarsIcon />
                <span>守航开工</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* 验收台（v0.11.0）：取代「读一大篇晨检包」——一个需求一张卡，早上几秒钟一张地做决定 */}
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="验收台（一个需求一张卡：做完没 / 长啥样 / 动了哪些老功能 / 要你拍的高危事项）"
                onClick={() => setDeskOpen(true)}
                data-testid="sidebar-acceptance-desk"
              >
                <ListChecksIcon />
                <span>验收台</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <GuardedLaunchDialog open={guardedOpen} onOpenChange={setGuardedOpen} />
        <AcceptanceDeskDialog open={deskOpen} onOpenChange={setDeskOpen} />
        {/* 工作区（lane）：多需求并行时每条需求的 worktree / 端口 / 运行态 + 一键开会话与起停。
            取代原「三红灯 + 定格晨检验收单」那块（老板 2026-09-28：没用，删掉）——晨检验收仍在任务卡「晨检验收」页签按需渲染。 */}
        <LanePanel />
        <EmployeeRail />
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center justify-between gap-2 px-2 py-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            <span
              className={cn(
                'size-2 rounded-full',
                status === 'open'
                  ? 'bg-emerald-500'
                  : status === 'connecting'
                    ? 'bg-amber-500'
                    : 'bg-destructive',
              )}
            />
            {status === 'open' ? '实时已连接' : status === 'connecting' ? '连接中…' : '连接断开'}
          </div>
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <Button variant="ghost" size="icon" onClick={() => settings.open()} aria-label="设置">
              <GearSixIcon className="size-5" />
            </Button>
            <ModeToggle />
            {/* 「折叠成图标轨」是桌面概念——移动端侧栏是抽屉，点它只会把抽屉关掉（等同点遮罩），
                在手机上摆一颗「看着像功能、实则只是关闭」的键纯属误导，直接不给。 */}
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex"
              onClick={toggleSidebar}
              aria-label="折叠 / 展开侧栏"
              title="折叠 / 展开侧栏"
            >
              <SidebarSimpleIcon className="size-5" />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}

function EmployeeRail() {
  const { employees } = useEmployees()
  const { open: openDetail } = useEmployeeDetail()
  const { openChat, newConsult } = useRunDetail()
  // state 用来区分折叠态：折叠后按钮**整个就是头像**，「点头像看详情」那条支线必须让路（见下方 onClick）
  const { setOpenMobile, state } = useSidebar() // 打开聊天/详情后收起移动端抽屉
  const collapsed = state === 'collapsed'
  // 状态数据来自全站常驻的 EmployeeStatusProvider（网页一加载就实时拉，不必先开抽屉）
  const { runs, pending, patrol, patrolBurst, patrolSweeping } = useEmployeeStatus()

  const keys = Object.keys(employees)
  if (!keys.length) return null

  // 折叠成图标轨时**不再整组隐藏**（老板反馈「员工要展示头像」）：轨里保留一列头像——
  // 这也是这条轨最该留的东西：谁在忙、谁等你拍板一眼扫到，点一下直接开聊。
  // 折叠态隐去名字/状态行/待办计数，只留头像 + 右下角状态徽标；名字与状态改走 tooltip。
  return (
    <SidebarGroup>
      <SidebarGroupLabel>员工</SidebarGroupLabel>
      {/* 折叠态把默认的 gap-px(1px) 拉到 gap-2(8px)：头像是实心圆、比线条图标"重"，1px 间距会连成
          一条"人墙"。展开态维持 gap-px 不动（那边行高本来就够、拉开反而散）。 */}
      <SidebarMenu className="group-data-[collapsible=icon]:gap-2">
        {keys.map((k) => {
          const e = employees[k]
          const q = pending?.[k]?.length ?? 0
          // 巡视员用巡查雷达，不走通用状态点。四态严格对齐引擎的真实动作（见 patrol-radar.tsx 注释）：
          //   打烊 / 巡逻倒计时（引擎静止）/ 巡逻中（刚跑完一轮 sweepIdleStops）/ 处置中（真派出去、他有在跑的 run）
          const isPatroller = k === 'chaorenq'
          const patrolOff = isPatroller && patrol?.enabled === false
          // 处置中：patrol-status 的 active、或 runs 里他自己在跑，或 SSE burst
          // （一次巡查的 active 窗口常常短于一个轮询周期，不补 burst 就永远看不到）。
          const patrolHandling =
            isPatroller &&
            !patrolOff &&
            (!!patrol?.active ||
              patrolBurst ||
              !!runs?.some(
                (r) => r.employee === k && (r.status === 'running' || r.status === 'starting'),
              ))
          const patrolSweep = isPatroller && !patrolOff && !patrolHandling ? patrolSweeping : null
          const patrolPhase: PatrolPhase = !isPatroller || patrolOff
            ? 'off'
            : patrolHandling
              ? 'handling'
              : patrolSweep
                ? 'sweeping'
                : 'countdown'
          // 处置中带上「在查谁」（checking 是引擎从巡视指令里解析出的被巡员工 key）
          const checkingName = patrol?.checking ? employees[patrol.checking]?.displayName : null
          const st = isPatroller ? null : empState(runs, k)
          const rep = st?.run ?? mostRecentRun(runs, k)
          // 徽标只在「处置中」亮（他真在干活）；巡逻中/倒计时不亮徽标——那两态由雷达表达，别把待命画成在忙
          const dotKind = patrolHandling ? ('patrol' as const) : st?.kind
          // 副标题＝当前状态的人话版；巡视员四态一一对应引擎动作，倒计时那档带秒级走字
          const patrolLabel: ReactNode = patrolOff ? (
            '打烊 · 暂不巡视'
          ) : patrolHandling ? (
            '处置中' + (checkingName ? ` · 在查${checkingName}` : '')
          ) : patrolSweep ? (
            `巡逻中 · 扫了 ${patrolSweep.scanned} 条${patrolSweep.spawned ? `，发现 ${patrolSweep.spawned} 处空停` : '，无异常'}`
          ) : (
            <PatrolCountdown nextSweepAt={patrol?.nextSweepAt || 0} />
          )
          const dotTitle = isPatroller
            ? typeof patrolLabel === 'string'
              ? patrolLabel
              : '巡逻倒计时'
            : st
              ? EMP_STATE_LABEL[st.kind]
              : '空闲'
          const subtitle: ReactNode =
            st?.kind === 'working'
              ? rep?.activity || '运行中'
              : st?.kind === 'working-bg'
                ? '后台运行中…'
                : st?.kind === 'question'
                  ? '等你拍板 · ' + runSummary(rep, 16)
                  : isPatroller
                    ? patrolLabel
                    : rep
                      ? runSummary(rep, 22)
                      : '空闲'
          return (
            <SidebarMenuItem key={k}>
              {/* 巡检雷达挂在 MenuItem（relative）而非 MenuButton：后者 overflow-hidden 会把「洗过面板」
                  的大波裁成行内弧线。位置对齐按钮内的头像（p-2 内边距 + size-9 头像，垂直居中）。 */}
              <PatrolRadar
                phase={patrolPhase}
                className="start-2 top-1/2 size-9 -translate-y-1/2 group-data-[collapsible=icon]:start-1/2 group-data-[collapsible=icon]:size-6 group-data-[collapsible=icon]:-translate-x-1/2"
              />
              <SidebarMenuButton
                onClick={() => {
                  openChat(k)
                  setOpenMobile(false)
                }}
                // 折叠态：p-0! 覆掉 SidebarMenuButton 的 `p-2!`（否则 32px 按钮里只剩 16px 放头像）；
                // overflow-visible 是给右下角状态徽标留的 —— 按钮默认 overflow-hidden，会把徽标切掉半个。
                className="h-auto py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:overflow-visible group-data-[collapsible=icon]:p-0!"
                // 折叠态的 tooltip 要顶上被隐去的那两行字，否则轨里只剩一排没名字的脸。
                // ⚠ 这个 tooltip **只在折叠态出现**（见 ui/sidebar.tsx：`hidden={state !== "collapsed"}`），
                //   所以措辞只能写折叠态成立的动作——原来那句「点头像看详情」在折叠态根本做不到，是句错指引。
                tooltip={`${e.displayName} · ${typeof subtitle === 'string' ? subtitle : dotTitle}${q > 0 ? `（待办 ${q}）` : ''} —— 点开聊（看详情请先展开侧栏）`}
              >
                {/* 展开态：行 = 开聊、头像 = 看详情（两个动作各占一块地）。
                    折叠态：按钮**整个就是头像**，没有"行"可点了 —— 这条 stopPropagation 会把
                    每一次点击都吞成「员工详情」（那个弹窗长得像设置页，老板反馈「点折叠的头像
                    打开的是设置、不是聊天窗」就是它）。所以折叠时**不挂这个 handler**，
                    点击直接落到按钮上去开聊；要看详情先展开侧栏。 */}
                <span
                  className="relative shrink-0"
                  onClick={
                    collapsed
                      ? undefined
                      : (ev) => {
                          ev.stopPropagation()
                          openDetail(k)
                          setOpenMobile(false)
                        }
                  }
                  title={collapsed ? undefined : '员工详情'}
                >
                  {/* 折叠态 24px：比按钮(32px)小一圈，四周留呼吸位。头像是实心圆、比线条图标"重"，
                      跟功能图标同尺寸会显得压迫，所以刻意比它们小。 */}
                  <EmployeeAvatar employee={e} className="size-9 group-data-[collapsible=icon]:size-6" />
                  {/* 徽标同步缩到 12px：14px 挂在 24px 头像上占掉一大半，会喧宾夺主看不清脸 */}
                  <EmployeeStatusBadge
                    kind={dotKind}
                    title={dotTitle}
                    className="absolute -end-0.5 -bottom-0.5 ring-sidebar group-data-[collapsible=icon]:size-3"
                  />
                </span>
                <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <span className="block truncate text-sm">{e.displayName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
                </span>
                {q > 0 && (
                  <Badge variant="secondary" className="ms-auto rounded-full px-1.5 text-[10px] group-data-[collapsible=icon]:hidden">
                    {q}
                  </Badge>
                )}
              </SidebarMenuButton>
              {/* 只读咨询窗：员工正忙也能开的第二个窗口（零写能力，不占他的活）。放右下角、避开待办计数徽标。 */}
              <SidebarMenuAction
                showOnHover
                className="top-auto bottom-1.5 end-1 text-muted-foreground"
                title={`找 ${e.displayName} 只读咨询（他在忙也能问，只读不改）`}
                aria-label={`找 ${e.displayName} 只读咨询`}
                onClick={(ev) => {
                  ev.stopPropagation()
                  newConsult(k)
                  setOpenMobile(false)
                }}
              >
                <MagnifyingGlassIcon />
              </SidebarMenuAction>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
