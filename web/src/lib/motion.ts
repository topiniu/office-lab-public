import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

// ===== 全站动效底座（GSAP）=====
//
// 为什么引 GSAP 而不继续堆 @keyframes：CSS 动画能做「一个元素的一段循环」，做不了
// ①**多元素编排**（头探出→气泡弹出→按钮跟进，各段错开且可整体反放）、
// ②**运行时调速**（末 3s 把呼吸循环 timeScale(2.2) 催促，@keyframes 只能换一套 animation 重来）、
// ③**与真实时长同步**（进度条 duration = 引擎 deadline 的真实剩余毫秒，CSS 只能写死秒数）。
// 详见复盘 docs/tech/前端-看板与消息卡片.md §3.91。
//
// 三条约定，新增动画一律照办：
// ① **走 useGSAP + scope**（从本模块 import，别各处直接 import gsap）——它自动 revert 掉本次建的
//    tween/内联样式，杜绝「组件卸载了 tween 还在写已摘节点」。禁止在裸 useEffect 里建 tween 不清理。
// ② **只动 transform / opacity**（GSAP 的 x/y/xPercent/yPercent/scale/rotation/autoAlpha），
//    不动 width/height/top/left —— 前者走 GPU 合成，后者每帧 reflow。
//    唯一例外：整条横幅/面板的 height 展开收起（无 transform 替代，且只在入退场各跑一次）。
// ③ **每处动画都要有 reduced-motion 分支**（reducedMotion() 早退 → gsap.set 到终态）。
//    前庭功能障碍用户开了「减少动态效果」就该看到静态结果，而不是慢一点的动画。

// useGSAP 用前必须注册一次（放在这里 = 谁 import 本模块谁就已注册好，组件里不用再管）。
gsap.registerPlugin(useGSAP)

// 全站默认手感：对齐既有 CSS 的 .ol-msg-in（cubic-bezier(.22,1,.36,1) ≈ power3.out），
// 免得 GSAP 动的和 CSS 动的两种节奏并存、观感割裂。
gsap.defaults({ duration: 0.4, ease: 'power3.out' })

/** 统一缓动语汇 —— 各处别再自定 cubic-bezier，从这里取，语义一致好维护。 */
export const EASE = {
  /** 常规落位：快起慢收，最像"东西被放下" */
  settle: 'power3.out',
  /** 俏皮弹出：明显 overshoot，用于探头/图标冒出这类拟人动作 */
  pop: 'back.out(2)',
  /** 温和弹出：overshoot 收着点，用于气泡/弹层出现 */
  bounceIn: 'back.out(1.8)',
  /** 呼吸/摆动循环（配 yoyo + repeat: -1） */
  breathe: 'sine.inOut',
  /** 匀速：进度条、与真实时间线性对应的量 */
  linear: 'none',
} as const

/** 用户是否要求「减少动态效果」（系统偏好）。每处动画都该问一句，为真则直接给终态。 */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export { gsap, useGSAP }
