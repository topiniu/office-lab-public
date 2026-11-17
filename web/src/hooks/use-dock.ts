// 聊天停靠栏（主页面右侧的独立第三栏）的宽度持久化与 CSS 变量写入。
//
// 停靠**不换 portal 容器**——卡片始终 portal 到 body、组件树位置不变（换 container 会让 React
// 把子树卸载重挂，已加载的 transcript 与输入框草稿全丢）。第三栏的效果靠两件事凑出来：
//   ① 停靠中的卡改成 `fixed inset-y-0 end-0` + 固定宽度（贴在窗口右侧）；
//   ② 把该宽度写进全局 `--ol-dock-w`，外壳 SidebarInset 用 `pe-(--ol-dock-w)` 预留出这块空间。
// 于是主内容真的收窄、零重叠，视觉与交互上就是第三栏，而组件状态一点不丢。
// 取舍详见复盘 docs/tech/前端-看板与消息卡片.md §3.92。

const KEY = 'ol-chat-dock'

/** 停靠栏宽度下限（与 floating-card 的 MIN_W 一致，太窄聊天没法读） */
export const DOCK_MIN_W = 340
/** 停靠后主内容至少要剩这么宽，否则第三栏就把主页面挤没了 */
const MAIN_MIN_W = 320
export const DOCK_DEFAULT_W = 460

export type DockState = { on: boolean; w: number }

export function clampDockW(w: number): number {
  // 上限要按**主内容区**算，不是按整窗算：可用宽 = 视口 − 左侧栏占位。
  // 踩过：用 window.innerWidth − 320 当上限，忘了侧栏那 256px，拖到极限时主内容只剩 49px。
  // 基准取 SidebarInset 的左边界（它是流内的 flex-1，左边界只由侧栏宽决定，与停靠栏宽无关，所以稳定）；
  // 用 clientWidth 而非 innerWidth，排掉滚动条那十几像素。
  const inset = document.querySelector('[data-slot="sidebar-inset"]')
  const mainStartX = inset ? inset.getBoundingClientRect().left : 0
  const avail = document.documentElement.clientWidth - mainStartX
  // 可用宽本身就不够时（上限已低于下限）以下限为准——宁可挤主内容，也不给一条读不了的窄栏
  const max = Math.max(DOCK_MIN_W, avail - MAIN_MIN_W)
  return Math.min(max, Math.max(DOCK_MIN_W, Math.round(w)))
}

export function loadDock(): DockState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (raw && typeof raw.w === 'number') return { on: !!raw.on, w: raw.w }
  } catch {
    /* ignore */
  }
  return { on: false, w: DOCK_DEFAULT_W }
}

export function saveDock(s: DockState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

/** 写外壳预留宽度。拖宽时逐帧调用（直写 DOM、不触发 React 重渲染）。 */
export function applyDockVar(px: number) {
  document.documentElement.style.setProperty('--ol-dock-w', `${Math.max(0, px)}px`)
}
