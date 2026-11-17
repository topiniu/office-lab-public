import * as React from "react"

const MOBILE_BREAKPOINT = 768

// 稳健的移动端判定：不只看视口宽度（会被 iPadOS「桌面版 UA」、代理/内嵌 WebView 的异常宽度、
// 页面缩放骗过），而是「窄屏 或 粗指针触屏设备 或 移动 UA」任一成立即判为移动端。
// - 粗指针触屏（pointer:coarse + maxTouchPoints>0）能识别报成桌面宽度/UA 的平板与大屏手机；
// - 移动 UA 兜底常规手机；iPadOS 桌面模式 UA 伪装成 Macintosh，由粗指针触屏那条兜住。
export function detectMobile(): boolean {
  if (typeof window === "undefined") return false
  const narrow = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
  const coarse = window.matchMedia("(pointer: coarse)").matches
  const touch = (navigator.maxTouchPoints || 0) > 0
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(
    navigator.userAgent,
  )
  return narrow || uaMobile || (coarse && touch)
}

export function useIsMobile() {
  // 同步初始化（读 window），避免首帧误判成桌面再闪一下切回移动端。
  const [isMobile, setIsMobile] = React.useState<boolean>(() => detectMobile())

  React.useEffect(() => {
    const update = () => setIsMobile(detectMobile())
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    mql.addEventListener("change", update)
    window.addEventListener("resize", update)
    window.addEventListener("orientationchange", update)
    update()
    return () => {
      mql.removeEventListener("change", update)
      window.removeEventListener("resize", update)
      window.removeEventListener("orientationchange", update)
    }
  }, [])

  return isMobile
}
