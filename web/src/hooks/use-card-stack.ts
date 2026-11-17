import { useEffect, useState } from 'react'

// 浮动聊天卡的前后层序管理。
// 关键约束：卡片整体必须**低于 50**——Radix 的菜单/下拉/弹窗/tooltip 都固定 z-50 且 portal 到 body，
// 卡片里打开的下拉若被抬到 ≥50 就会被卡片自己盖住。故把所有卡限制在 [BASE, TOP] 这个「50 以下的窗口带」，
// 最近点按的卡移到队尾＝最高 z，其余顺次下降；超过带宽的老卡钳在 BASE（仍高于 topbar/sidebar 的 z≤20）。
const BASE = 40
const TOP = 49

let order: string[] = []
const subs = new Set<() => void>()
function notify() {
  subs.forEach((f) => f())
}

// 把某张卡抬到最前（队尾）。拖动/点按/聚焦卡片时调用。
export function raiseCard(id: string) {
  const i = order.indexOf(id)
  if (i === order.length - 1) return // 已在最前，免去无谓通知
  if (i >= 0) order.splice(i, 1)
  order.push(id)
  notify()
}

// 是否最前那张（Esc 在焦点不在任何卡里时只关它）
export function isTopCard(id: string): boolean {
  return order[order.length - 1] === id
}

function dropCard(id: string) {
  const i = order.indexOf(id)
  if (i >= 0) {
    order.splice(i, 1)
    notify()
  }
}

// 订阅层序、返回本卡当前 zIndex。进场即入队并通知全体重算，卸载即出队让其余卡补位。
export function useCardZ(id: string): number {
  const [, force] = useState(0)
  useEffect(() => {
    if (!order.includes(id)) order.push(id)
    const rerender = () => force((n) => n + 1)
    subs.add(rerender)
    notify()
    return () => {
      subs.delete(rerender)
      dropCard(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const idx = order.indexOf(id)
  const n = order.length
  // 队尾对齐 TOP，越靠前（越旧）每层 -1，不低于 BASE
  return idx < 0 ? TOP : Math.max(BASE, TOP - (n - 1 - idx))
}
