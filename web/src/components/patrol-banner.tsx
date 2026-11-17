import { useEffect, useRef, useState } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { EmployeeAvatar } from '@/components/employee-avatar'
import { useSseEvent } from '@/components/sse-provider'
import { useEmployees } from '@/hooks/use-employees'
import { apiPost } from '@/lib/api'
import { EASE, gsap, reducedMotion, useGSAP } from '@/lib/motion'
import type { SseEvent } from '@/lib/types'

/* ---------- 小呆呆接管倒计时横幅（巡视宽限窗）----------
   引擎在会话空停时延后派巡视、期间广播 patrol-pending{deadline, graceSec}；老板点「取消接管」或直接回话 →
   patrol-cancelled；走完窗口真派 → patrol-detected / patrol-escalate。

   两条数据口径（沿用旧 UI app.js:1778 的取舍，别改）：
   ① **只按引擎 deadline 渲染、自己不计时** —— 多端看到的秒数一致，刷新/切窗口也不会各算一套。
   ② **到点不自动收横幅** —— 停在 0s 等引擎的 patrol-detected 来收尾，因为「派没派出去」只有引擎说得准。

   呈现口径（老板 2026-08-21 定）：**无底色、无边框**——横幅本身透明，只有小呆呆的头和他的话气泡浮在会话面上，
   越"无框"越沉浸；**有倒计时就不要进度条**，同一件事别用两种控件说。
   构图：`overflow-hidden` 的根把头的下半截掉，读作他从输入框后面探进来（而不是"贴了张头像"）。

   动画（GSAP，语汇取自 lib/motion.ts）：探头 → 气泡从他嘴边弹出 → 待机呼吸+歪头 → 末 3s 催促（复用呼吸循环
   调速，不新建 tween）→ 两种收尾各一套人物动作。为什么用 GSAP 而不是 @keyframes：见 lib/motion.ts 与复盘 §3.91。

   ★ 两个踩过的坑，别退回去：
   ① 位移一律用 **fromTo** 而不是 from。`from()` 的终值靠"读当前值"，在 React 里初始化时机与 immediateRender
      一撞就会把终值读错——原先按钮那条 `.from(btn,{autoAlpha:0})` 就永远停在起始态（opacity:0）不见了。
   ② 秒数由**一个 gsap.ticker 回调**从 deadline 现算，不用自走的 tween —— tween 会被 gsap 的 lagSmoothing 在
      标签页隐藏期间"抹平"，切回来就和真实剩余时间脱节（违反口径①）。顺带好处：倒计时期间零 React 重渲染。 */

type Phase = 'off' | 'counting' | 'cancelled' | 'taken'

const URGENT_MS = 3000 // 末 3s 转催促态

export function PatrolBanner({ runId, graceUntil }: { runId: string; graceUntil?: number | null }) {
  const { employees } = useEmployees()
  const emp = employees.chaorenq
  const name = emp?.displayName ?? '巡视员' // 旧 UI 的 patrolName()：文案走花名册，别把「小呆呆」写死在这

  const [phase, setPhase] = useState<Phase>('off')
  const [deadline, setDeadline] = useState(0)
  const [finalText, setFinalText] = useState('')
  const demo = useRef(false) // dev 演示态：只跑动画，不打引擎接口

  const rootRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const leadRef = useRef<HTMLSpanElement>(null)
  const secRef = useRef<HTMLElement>(null)
  const tailRef = useRef<HTMLSpanElement>(null)

  // 收尾只从倒计时态进（避免没露过面就播退场、或两个终态互相盖）
  function finish(next: Phase, text: string) {
    setPhase((p) => {
      if (p !== 'counting') return p
      setFinalText(text)
      return next
    })
  }

  useSseEvent('patrol-pending', (ev: SseEvent) => {
    if (ev.runId !== runId || typeof ev.deadline !== 'number') return
    setDeadline(ev.deadline)
    setPhase('counting')
  })
  useSseEvent('patrol-cancelled', (ev: SseEvent) => {
    if (ev.runId !== runId) return
    // reason 分两种口径（对齐旧 UI finishPatrolBanner('reply'|'cancelled')）：老板直接回话 vs 点了取消
    finish('cancelled', String(ev.reason) === 'user-reply' ? '你已经接手了，这条我不碰～' : '好嘞，这条交给你！')
  })
  useSseEvent(['patrol-detected', 'patrol-escalate'], (ev: SseEvent) => {
    if (ev.runId !== runId) return
    finish('taken', '那我接手看看…')
  })

  // 补渲染：宽限窗内新开/切换聊天卡时错过了 patrol-pending 那一发 SSE，就据 run.patrolGraceUntil 把横幅补起来
  // （旧 UI 的 syncPatrolBanner，app.js:1829）。
  useEffect(() => {
    const until = Number(graceUntil) || 0
    if (phase !== 'off' || until <= Date.now()) return
    setDeadline(until)
    setPhase('counting')
  }, [graceUntil, phase])

  // dev 专用演示旁路：真实宽限窗只有几秒、还得先让员工空停才触发，逐帧调动画不现实。
  // 开 ?patrolDemo=<秒> 即假开一次倒计时（生产构建里整段被 tree-shake 掉）。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const sec = Number(new URLSearchParams(window.location.search).get('patrolDemo'))
    if (!sec || sec <= 0) return
    demo.current = true
    setDeadline(Date.now() + sec * 1000)
    setPhase('counting')
  }, [])

  useGSAP(
    () => {
      if (phase === 'off') return
      const root = rootRef.current
      const head = headRef.current
      const bubble = bubbleRef.current
      if (!root || !head || !bubble) return
      const still = reducedMotion() // 「减少动态效果」：只给终态，不做位移
      gsap.set(head, { transformOrigin: 'center bottom' }) // 歪头以「脖子」为轴，不是绕中心转
      gsap.set(bubble, { transformOrigin: 'left bottom' }) // 气泡从他嘴边长出来

      // ---- 倒计时态：入场 + 呼吸 + ticker ----
      if (phase === 'counting') {
        let breathe: gsap.core.Tween | null = null
        if (!still) {
          const tl = gsap.timeline()
          tl.from(root, { height: 0, duration: 0.3, ease: EASE.settle })
            .fromTo(
              head,
              { yPercent: 130, rotation: -16 },
              { yPercent: 0, rotation: 0, duration: 0.55, ease: EASE.pop },
              0.05,
            )
            .fromTo(
              bubble,
              { scale: 0.5, autoAlpha: 0 },
              { scale: 1, autoAlpha: 1, duration: 0.42, ease: EASE.bounceIn },
              0.26,
            )
          // 取消钮（X）长在气泡上、是它的子节点，跟着气泡一起弹进来，不用单独补一条 tween。
          // 待机呼吸 + 微歪头：这一条是「活的」的关键，静止的头像只是张图。
          breathe = gsap.to(head, {
            y: -3,
            rotation: 3.5,
            duration: 1.15,
            yoyo: true,
            repeat: -1,
            ease: EASE.breathe,
            delay: 0.7,
          })
        }

        let lastSec = -1
        let urgent = false
        let ended = false
        const tick = () => {
          const leftMs = Math.max(0, deadline - Date.now())
          // 演示态到点自动收尾，替引擎的 patrol-detected 走一遍「已接管」那套动作（真实态下这里什么都不做，
          // 停在 0s 等引擎 —— 见上方口径②）。
          if (import.meta.env.DEV && demo.current && leftMs <= 0 && !ended) {
            ended = true
            finish('taken', '那我接手看看…')
            return
          }
          const sec = Math.ceil(leftMs / 1000)
          if (sec !== lastSec) {
            lastSec = sec
            if (secRef.current) {
              secRef.current.textContent = String(sec)
              if (!still) gsap.fromTo(secRef.current, { scale: 1.5 }, { scale: 1, duration: 0.3, ease: EASE.pop })
            }
          }
          if (!urgent && leftMs <= URGENT_MS) {
            urgent = true
            root.dataset.urgent = 'true' // 催促配色（琥珀 → destructive）交给 Tailwind data 变体
            if (leadRef.current) leadRef.current.textContent = '我马上就来啦，还剩 '
            if (tailRef.current) tailRef.current.textContent = 's'
            if (!still) {
              breathe?.timeScale(2.3) // 复用已有循环调速 —— @keyframes 做不到这件事
              gsap.to(bubble, { x: 2.5, duration: 0.06, repeat: 7, yoyo: true }) // 气泡急了抖两下
            }
          }
        }
        tick()
        gsap.ticker.add(tick)
        return () => gsap.ticker.remove(tick)
      }

      // ---- 收尾两态：播完卸载 ----
      if (still) {
        gsap.delayedCall(1.2, () => setPhase('off')) // 静态也留 1.2s 让人读到收尾文案
        return
      }
      const tl = gsap.timeline({ onComplete: () => setPhase('off') })
      tl.fromTo(bubble, { scale: 0.7, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.32, ease: EASE.bounceIn })
      if (phase === 'cancelled') {
        // 「好嘞」——点个头，然后缩回输入框后面，条子收起
        tl.to(head, { rotation: 13, duration: 0.17, yoyo: true, repeat: 1, ease: EASE.settle }, 0)
          .to(bubble, { scale: 0.62, autoAlpha: 0, duration: 0.26 }, 0.95)
          .to(head, { yPercent: 130, rotation: -8, duration: 0.36, ease: 'power2.in' }, 1.05)
          .to(root, { height: 0, duration: 0.28, ease: EASE.settle }, 1.28)
      } else {
        // 「那我接手看看」——整个翻进来，再连头带气泡走进会话里
        tl.to(head, { yPercent: -14, scale: 1.08, duration: 0.42, ease: EASE.pop }, 0)
          .to([head, bubble], { x: 46, autoAlpha: 0, duration: 0.42, ease: 'power2.in', stagger: 0.06 }, 1.1)
          .to(root, { height: 0, duration: 0.3, ease: EASE.settle }, 1.4)
      }
    },
    { dependencies: [phase, deadline], scope: rootRef, revertOnUpdate: true },
  )

  if (phase === 'off') return null
  const counting = phase === 'counting'
  const initialSec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))

  return (
    <div
      ref={rootRef}
      // 无底色无边框（沉浸）；overflow-hidden 是构图的一半：头的下半被这条底边吃掉，
      // 而这条底边正好压在输入框的上边线上 —— 读作他从输入框后面探进来。
      className="group/pb relative overflow-hidden"
    >
      <div className="flex items-end gap-2.5 px-3 pt-2">
        <div ref={headRef} className="-mb-4 shrink-0">
          <EmployeeAvatar
            employee={emp}
            fallback={name}
            className="size-12 ring-2 ring-amber-500/50 group-data-[urgent=true]/pb:ring-destructive/60"
          />
        </div>

        <div
          ref={bubbleRef}
          className="relative mb-2 min-w-0 flex-1 rounded-xl rounded-bl-sm border bg-card py-1.5 pe-4 ps-2.5 text-sm shadow-xs group-data-[urgent=true]/pb:border-destructive/50"
        >
          {/* 指向小呆呆的小尾巴（旋转 45° 的方块，只露左下两条边） */}
          <span className="absolute -start-1 bottom-2.5 size-2 rotate-45 border-b border-s bg-card group-data-[urgent=true]/pb:border-destructive/50" />
          {counting && (
            // 取消钮就挂在气泡右上角（老板 2026-08-21 定）——比另起一颗按钮更像"把这句话关掉"。
            // icon-only 必须给 aria-label + data-testid，否则 E2E 无语义可定位（见仓库根 CLAUDE.md「前端 E2E 可达性规范」）。
            <Button
              size="icon-xs"
              variant="ghost"
              className="absolute -top-1.5 -end-1.5 rounded-full border bg-card text-muted-foreground shadow-xs hover:bg-card hover:text-foreground"
              aria-label="取消接管"
              title="取消接管"
              data-testid="patrol-cancel-btn"
              onClick={() => {
                // 乐观收尾（引擎的 patrol-cancelled 回来也幂等 —— finish 只从 counting 进）
                finish('cancelled', '好嘞，这条交给你！')
                if (demo.current) return
                apiPost(`/api/runs/${runId}/patrol-cancel`).catch((e) =>
                  toast.error('取消失败', { description: (e as Error).message }),
                )
              }}
            >
              <XIcon weight="bold" />
            </Button>
          )}
          {counting ? (
            <span className="leading-snug">
              <span ref={leadRef}>{name}将在 </span>
              <b
                ref={secRef}
                className="inline-block tabular-nums text-amber-600 group-data-[urgent=true]/pb:text-destructive dark:text-amber-500"
              >
                {initialSec}
              </b>
              <span ref={tailRef}>s 后来接管这条会话</span>
            </span>
          ) : (
            <span className="leading-snug">{finalText}</span>
          )}
        </div>
      </div>
    </div>
  )
}
