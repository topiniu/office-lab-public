// 聊天输入框上方那排快捷短语（2026-10-07 老板提）：只显示本员工可见的，点一下直接把这段话发出去
// （同日老板改口：起初是贴进输入框，改为点即发）。走调用方的 send()，草稿建 run / 409 降级等动线都复用。
// 末尾一枚齿轮直达 设置 →「快捷短语」做增删改。一条都没有时只留一枚「快捷短语」入口，不占地方。
import { GearSixIcon, LightningIcon } from '@phosphor-icons/react'
import { useQuickPhrases } from '@/lib/quick-phrases'
import { useSettings } from '@/components/settings-dialog'
import { cn } from '@/lib/utils'

const CHIP =
  'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border bg-card px-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50'

export function QuickPhraseBar({
  employee,
  onSend,
  disabled,
  className,
}: {
  employee: string
  onSend: (text: string) => void | Promise<void>
  disabled?: boolean
  className?: string
}) {
  const phrases = useQuickPhrases(employee)
  const settings = useSettings()
  if (phrases == null) return null
  return (
    <div className={cn('no-scrollbar flex items-center gap-1.5 overflow-x-auto', className)}>
      {phrases.map((p) => (
        <button
          key={p.id}
          type="button"
          className={cn(CHIP, 'max-w-48')}
          title={`点击直接发送：${p.text}`}
          disabled={disabled}
          onClick={() => onSend(p.text)}
        >
          <span className="truncate">{p.label}</span>
        </button>
      ))}
      <button
        type="button"
        className={cn(CHIP, phrases.length && 'px-1.5')}
        onClick={() => settings.open('phrases')}
        aria-label="管理快捷短语"
        title="管理快捷短语"
      >
        {phrases.length ? (
          <GearSixIcon className="size-3.5" />
        ) : (
          <>
            <LightningIcon className="size-3.5" />
            快捷短语
          </>
        )}
      </button>
    </div>
  )
}
