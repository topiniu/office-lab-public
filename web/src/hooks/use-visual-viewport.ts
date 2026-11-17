import { useEffect, useState } from 'react'

// 视觉视口（visualViewport）尺寸：软键盘弹起时会收缩/上移，用它把移动端聊天全屏容器
// 精确贴合「可见区域」，键盘不再顶露底部内容、输入框始终在键盘之上（近原生 IM 体验）。
export function useVisualViewport() {
  const [vp, setVp] = useState(() => ({
    height: typeof window !== 'undefined' ? window.visualViewport?.height ?? window.innerHeight : 0,
    offsetTop: 0,
  }))
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setVp({ height: vv.height, offsetTop: vv.offsetTop })
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return vp
}
