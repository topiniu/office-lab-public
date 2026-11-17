import { createRoot } from 'react-dom/client'
import { CaretDownIcon } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { statusTone } from '@/lib/status'
import { cn } from '@/lib/utils'
import { stages, tasks } from './fixtures'
import './demo.css'

function Demo() {
  return (
    <main className="mx-auto max-w-5xl px-4 pt-10 pb-12 sm:px-8 sm:pt-16">
      <header className="mb-8 border-b pb-7">
        <p className="font-medium text-sm">Office Lab / 公开演示</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">研发协作看板</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          展开任务，查看从需求到发布的交接记录。下方均为虚构示例，页面不会连接执行引擎或提交操作。
        </p>
      </header>
      <section aria-labelledby="task-heading">
        <h2 id="task-heading" className="mb-3 text-sm font-semibold">示例任务</h2>
        <div className="grid gap-3">
          {tasks.map((task) => (
            <details key={task.id} className="group rounded-lg border bg-card" open={task.id === 'DEMO-01' || undefined}>
              <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-4 py-3 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <CaretDownIcon aria-hidden className="size-4 shrink-0 -rotate-90 group-open:rotate-0" />
                <span className="text-xs font-medium tabular-nums text-muted-foreground">{task.id}</span>
                <span className="order-last w-full ps-7 font-semibold sm:order-none sm:w-auto sm:flex-1 sm:ps-0">{task.title}</span>
                <Badge variant="outline" data-demo-status={task.status} className={cn('ms-auto px-2 text-xs', statusTone(task.status))}>
                  {task.status}
                </Badge>
              </summary>
              <div className="border-t p-4 sm:p-6">
                <p className="mb-4 text-sm leading-6">{task.goal}</p>
                <ol aria-label="工作阶段" className="mb-6 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  {stages.map((stage, i) => (
                    <li key={stage} aria-current={stage === task.stage ? 'step' : undefined}
                      className={cn(
                        'rounded-md border px-3 py-2',
                        stage === task.stage ? 'border-ring font-semibold' : 'text-muted-foreground',
                      )}>
                      <span className="me-2 tabular-nums">0{i + 1}</span>{stage}
                      {stage === task.stage && <span className="sr-only">（当前阶段）</span>}
                    </li>
                  ))}
                </ol>
                <h3 className="mb-1 text-sm font-semibold">交接记录</h3>
                <ol className="divide-y">
                  {task.handoffs.map(({ stage, artifact, detail }) => (
                    <li key={stage} className="grid gap-1 py-3 text-sm sm:grid-cols-[9rem_1fr] sm:gap-4">
                      <span className="font-medium">{stage} · {artifact}</span>
                      <span className="leading-6 text-muted-foreground">{detail}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 border-t pt-4 text-sm leading-6"><strong>下一步：</strong>{task.next}</p>
              </div>
            </details>
          ))}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Demo />)
