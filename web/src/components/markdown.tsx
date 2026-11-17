import { memo, useRef, useState, useEffect, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

import { useIsMobile } from '@/hooks/use-mobile'
import { useImageViewer } from '@/components/image-viewer'
import { cn } from '@/lib/utils'

// Markdown 渲染器。零额外依赖（不引 typography 插件），全部走 tailwind 工具类 + 语义 token。
//
// 2026-09-09 重做（老板：「我们的 markdown 阅读器不够美观，而且移动端兼容好像不太好」）。
// 实测（390px 视口，真实任务档案）先量出一个比"不美观"严重得多的 bug：
//
//   ★ 窄屏上 7 列的「需求条目登记表」被**压成一字一行**——`REQ-0338` 竖着排成 R/E/Q/-/0/3/3/8，
//     单行高 109px、首列宽 **30px**。根因是两条样式叠加：
//       ① `table { width: 100% }`（旧 `w-full`）→ 表格被钉死在容器宽，绝不溢出；
//       ② 外层的 `[overflow-wrap:anywhere]` **被单元格继承**（实测 cell 的 computed 值就是 anywhere）
//          → 列可以缩到一个字符宽还"合法"。
//     于是外层 `overflow-auto` 永远不触发（表格从不超出容器），表格选择**自我压碎**而不是横向滚动。
//     `anywhere` 本是为正文里的长标识符/路径加的（复盘 §3.88），进到表格里就变成了灾难。
//
// 三条口径（改这个文件前先读）：
//   · **表格**：容器横滑 + `w-max min-w-full`（允许比容器宽），单元格 `overflow-wrap: break-word`
//     （按词/CJK 断，不逐字断）。**窄屏且列数≥3 时改「卡片模式」**——每行一张卡、`列名: 值` 纵向排。
//     判据：本仓文档的表格（登记表/覆盖矩阵/facet 表/待确认）都是"一行一个实体"，天然适合卡片；
//     而 7 列 × 长文本的表格即便能横滑，在 390px 上也没法读。
//   · **标题**：h1–h6 **六级全部显式定义**。旧版只定义到 h3（h3 还和正文同为 14px），h4/h5/h6 落到
//     Tailwind preflight 的 reset 上 → 渲染成普通段落、**层级完全消失**（而本仓模板大量用 `####`）。
//   · **`>` 引用不再整块灰化**：这些文档用 `>` 承载最重要的口径（「★诚实铁律」「为什么这么设计」），
//     旧版 `text-muted-foreground` 把最该看的段落变成最灰的段落。改成左强调条 + 轻底色 + 正常前景色。
const CODE_INLINE =
  'rounded border border-border/60 bg-muted/70 px-1 py-px font-mono text-[0.85em] [overflow-wrap:anywhere]'

// 正文里的图：尺寸不变（markdown 里的图多是有意排版的插图，不该被砍成方块缩略图），
// 但点一下同样落进可拖拽浮窗看大图（与聊天截图同一个查看器，行为一致）。
function MdImg(p: React.ComponentProps<'img'>) {
  const { openImage } = useImageViewer()
  const src = typeof p.src === 'string' ? p.src : ''
  return (
    <img
      {...p}
      loading="lazy"
      title={p.title || (src ? '点击查看大图' : undefined)}
      onClick={src ? () => openImage(src, String(p.alt || '')) : undefined}
      className={cn('my-2 max-w-full rounded-md border', src && 'cursor-zoom-in')}
    />
  )
}

// 表格卡片模式（窄屏）：一行一张卡。列名取表头，空值整行省略（表里大量空格子，
// 逐个渲染成「列名: —」会把卡片撑成噪音）。
function TableCards({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="my-3 space-y-2">
      {rows.map((cells, i) => {
        const filled = cells.map((v, j) => ({ k: head[j] ?? '', v })).filter((x) => x.v && !/^[-—–]+$/.test(x.v))
        if (!filled.length) return null
        // 第一格通常是主键（#/facet ID/条目号）→ 提为卡片标题
        const [first, ...rest] = filled
        return (
          <div key={i} className="rounded-md border bg-card/40 p-2.5">
            <div className="mb-1.5 flex flex-wrap items-baseline gap-1.5">
              {first.k && <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{first.k}</span>}
              <span className="font-medium [overflow-wrap:anywhere]">{first.v}</span>
            </div>
            <dl className="space-y-1">
              {rest.map((x, j) => (
                // ⚠ `min-w-0` + `anywhere` 两样都要，缺一个就溢出（本组件第一版就栽了，实测 dd 被顶到 1532px）：
                //   · grid 项默认 `min-width:auto` ⇒ `1fr` 轨道最小宽 = 内容的 min-content；
                //   · 而 `overflow-wrap:break-word` **不改 min-content**（只有 `anywhere` 改）——
                //     于是「Tier B 已实施(F45绑定即时补建/F48·F53saveItems结构守卫)」这种长串把轨道顶宽。
                // 这里是**数据格**不是正文，逐字断可以接受；正文/表格单元格仍用 break-word（不逐字断）。
                <div key={j} className="grid min-w-0 grid-cols-[minmax(3.5rem,auto)_1fr] gap-x-2">
                  <dt className="text-[11px] leading-relaxed text-muted-foreground">{x.k || '—'}</dt>
                  <dd className="min-w-0 text-xs leading-relaxed [overflow-wrap:anywhere]">{x.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )
      })}
    </div>
  )
}

// 可横滑表格：滚动到底/到头时隐藏对应侧的渐隐遮罩。
// 为什么要遮罩：窄屏上「这张表还能往右滑」没有任何视觉线索，用户只会以为内容被裁了（旧版就是如此）。
function ScrollTable({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ left: false, right: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const more = el.scrollWidth - el.clientWidth
      setEdge({ left: el.scrollLeft > 4, right: more > 4 && el.scrollLeft < more - 4 })
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', update); ro.disconnect() }
  }, [])
  return (
    <div className="relative my-3">
      <div ref={ref} className="overflow-x-auto rounded-md border">
        {children}
      </div>
      {edge.left && <div className="pointer-events-none absolute inset-y-0 start-0 w-6 rounded-s-md bg-gradient-to-r from-background to-transparent" />}
      {edge.right && <div className="pointer-events-none absolute inset-y-0 end-0 w-6 rounded-e-md bg-gradient-to-l from-background to-transparent" />}
    </div>
  )
}

// 从 **hast node**（react-markdown v10 传给自定义组件的 `node` prop）里抽表头与数据行。
// ⚠ 刻意不解析 React children：**我给 thead/tr/th 都提供了自定义组件，于是那些元素的 `type`
// 是我的组件函数、不是字符串 'thead'**——第一版按 `type === 'thead'` 判，结果 head 恒为空、
// 卡片里每行的列名全渲染成「—」（实测截图坐实）。hast 节点带真实 `tagName`，不受组件替换影响。
type HastNode = { type?: string; tagName?: string; value?: string; children?: HastNode[] }
function readTable(node: HastNode | undefined): { head: string[]; rows: string[][] } | null {
  if (!node?.children) return null
  const text = (n: HastNode): string =>
    n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(text).join('')
  const trs: { head: boolean; cells: string[] }[] = []
  for (const sec of node.children) {
    if (sec.tagName !== 'thead' && sec.tagName !== 'tbody') continue
    for (const tr of sec.children ?? []) {
      if (tr.tagName !== 'tr') continue
      const cells = (tr.children ?? [])
        .filter((c) => c.tagName === 'th' || c.tagName === 'td')
        .map((c) => text(c).trim())
      if (cells.length) trs.push({ head: sec.tagName === 'thead', cells })
    }
  }
  const head = trs.find((t) => t.head)?.cells ?? []
  const rows = trs.filter((t) => !t.head).map((t) => t.cells)
  return head.length || rows.length ? { head, rows } : null
}

// ★ 表格是唯一需要知道"当前是不是窄屏"的元素，所以 `useIsMobile()` 下沉到这里，
// **不放在 `Markdown` 上**：`Markdown` 是按**每条聊天消息**渲染的，而 `useIsMobile` 每个实例挂
// 3 个监听器（matchMedia change / resize / orientationchange）——几百条消息的会话就是几百个监听器，
// 一次窗口缩放触发几百次 setState。绝大多数消息里没有表格，这样下沉后它们零成本。
// 也刻意不走「两份 DOM 各显一套 + md: 隐藏」：覆盖矩阵有 101 行，双份渲染在这个仓库是明确否决过的
// 做法（看板头像那次，见 CHANGELOG 2026-09-08）。
function MdTable({ children, node, ...rest }: React.ComponentProps<'table'> & { node?: unknown }) {
  const mobile = useIsMobile()
  const parsed = mobile ? readTable(node as HastNode | undefined) : null
  if (parsed && (parsed.head.length >= 3 || (parsed.rows[0]?.length ?? 0) >= 3)) {
    return <TableCards head={parsed.head} rows={parsed.rows} />
  }
  return (
    <ScrollTable>
      {/* w-max + min-w-full：内容窄时占满容器、内容宽时**允许超出**并由容器横滑
          （旧版 w-full 把表格钉死在容器宽，列被压到一字一行、且永远不触发横滑） */}
      <table className="w-max min-w-full border-collapse text-[13px]" {...rest}>{children}</table>
    </ScrollTable>
  )
}

function makeComponents(): Components {
  return {
    // 六级标题全部显式定义：字号阶梯拉开，h2 带顶部分隔线（长文档的分段锚点）。
    // scroll-mt-4 为将来支持 #锚点跳转留位（跳过去时标题不贴在滚动容器顶边）。
    h1: (p) => <h1 className="mt-5 mb-2.5 scroll-mt-4 text-[19px] font-semibold leading-tight first:mt-0" {...p} />,
    h2: (p) => <h2 className="mt-6 mb-2.5 scroll-mt-4 border-t pt-4 text-[17px] font-semibold leading-tight first:mt-0 first:border-t-0 first:pt-0" {...p} />,
    h3: (p) => <h3 className="mt-4 mb-1.5 scroll-mt-4 text-[15px] font-semibold leading-snug" {...p} />,
    h4: (p) => <h4 className="mt-3.5 mb-1 scroll-mt-4 text-[13.5px] font-semibold text-foreground/90" {...p} />,
    h5: (p) => <h5 className="mt-3 mb-1 scroll-mt-4 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground" {...p} />,
    h6: (p) => <h6 className="mt-3 mb-1 scroll-mt-4 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground" {...p} />,

    // 中文正文行高要比英文松：1.5 在 CJK 下会糊成一片。这里 1.75。
    p: (p) => <p className="my-2.5 leading-[1.75]" {...p} />,
    strong: (p) => <strong className="font-semibold text-foreground" {...p} />,
    em: (p) => <em className="italic" {...p} />,
    del: (p) => <del className="text-muted-foreground line-through" {...p} />,

    // 列表：任务列表（`- [ ]`，本仓模板「流程状态」大量使用）去掉 bullet，
    // 否则每行是「• ☐ 文本」两个符号叠着。GFM 会给 li 加 class="task-list-item"。
    ul: (p) => <ul className="my-2.5 ms-5 list-disc space-y-1.5 [&_ul]:my-1 [&_ul]:ms-4 [&>li.task-list-item]:ms-[-1.15rem] [&>li.task-list-item]:list-none" {...p} />,
    ol: (p) => <ol className="my-2.5 ms-5 list-decimal space-y-1.5 [&_ol]:my-1 [&_ol]:ms-4" {...p} />,
    li: (p) => <li className="leading-[1.7] [&>p]:my-0" {...p} />,
    input: (p) => (
      // 只可能是任务列表的复选框（GFM 不产出别的 input）。disabled 是 GFM 的默认行为，保留——
      // 勾选状态的真相在档案文本里，不该能在阅读器里点着改（会造成"改了但没落盘"的错觉）。
      <input className="me-1.5 size-3.5 translate-y-[2px] accent-primary" {...p} />
    ),

    a: (p) => (
      <a className="text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary" target="_blank" rel="noreferrer" {...p} />
    ),

    // `>` 引用：这些文档用它承载最重要的口径，所以**不灰化**，改成左强调条 + 轻底色。
    blockquote: (p) => (
      <blockquote className="my-3 rounded-e-md border-s-2 border-primary/50 bg-primary/[0.04] py-2 pe-2.5 ps-3 text-foreground/90 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0" {...p} />
    ),

    code: (p) => <code className={CODE_INLINE} {...p} />,
    pre: (p) => (
      // white-space:pre 不换行 → 必须自己横滑（外层 min-w-0 保证它不去顶宽容器，见下方注释）
      <pre className="my-3 overflow-x-auto rounded-md border bg-muted/60 p-3 text-[12px] leading-relaxed [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[12px]" {...p} />
    ),

    img: (p) => <MdImg {...p} />,
    hr: () => <hr className="my-5 border-border" />,

    // ★ 表格：窄屏且列数≥3 → 卡片模式；否则可横滑表格（判定与渲染在 MdTable 里，见其注释）
    table: MdTable,
    thead: (p) => <thead className="bg-muted/60" {...p} />,
    tr: (p) => <tr className="border-b last:border-b-0 even:bg-muted/20" {...p} />,
    th: (p) => (
      <th className="whitespace-nowrap border-e px-2.5 py-1.5 text-start font-medium last:border-e-0" {...p} />
    ),
    td: (p) => (
      // break-word 而不是 anywhere：按词/CJK 边界断，不逐字断（逐字断正是旧版把 REQ-0338 拆成竖排的原因）；
      // max-w 防某一列独吞宽度（覆盖矩阵的「证据」列能有几百字符）。
      <td className="max-w-[min(60vw,30rem)] border-e px-2.5 py-1.5 align-top [overflow-wrap:break-word] last:border-e-0" {...p} />
    ),
  }
}

// 模块级常量：components 对象只建一次。放进组件里（哪怕 useMemo）也会让每个 Markdown 实例各持一份，
// 而聊天视图里 Markdown 实例是按消息条数计的。
const components = makeComponents()

// memo：大文档（任务档案可达 200KB+）解析很贵，避免父层每次后台 SSE/轮询重渲染时重新 parse。
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    // overflow-wrap:anywhere 比 break-words(break-word) 更强：会缩小盒子的 min-content 宽度，
    // 让长 token 真正换行、不把整列撑宽后被 overflow-x-hidden 裁断（break-word 不改 min-content，故裁断）。
    // ⚠ 它会**被子元素继承**——表格单元格必须显式改回 break-word，否则列会被允许缩到一个字符宽
    // （2026-09-09 实测：390px 下 7 列登记表首列 30px、REQ-0338 竖排、行高 109px）。
    // ★ min-w-0 必不可少：本 div 常常直接作为 flex/grid 项（气泡里、OLContent 的消息列里）。
    // grid/flex 项默认 min-width:auto ⇒ 轨道最小宽 = 项的 min-content，而 overflow-wrap 管不到
    // ```代码块```（<pre> 是 white-space:pre、不换行）——于是一段长命令就把整条轨道顶到内容宽
    // （实测窄窗 413px 容器被顶成 570px），外层 overflow-x-hidden 再把超出部分**直接裁掉**：
    // 正文右侧被切、代码卡溢出、且无处横滑。加 min-w-0 后轨道收回容器宽，<pre> 自己 overflow-auto
    // 在卡内横向滚动。（2026-08-20 老板窄窗截图，复盘 §3.88）
    <div className={cn('min-w-0 text-sm [overflow-wrap:anywhere]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
})
