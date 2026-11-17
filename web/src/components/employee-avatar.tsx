import { CheckIcon, QuestionIcon, WarningIcon } from '@phosphor-icons/react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { empDotStyle, type EmpStateKind } from '@/lib/status'
import type { Employee } from '@/lib/types'
import { cn } from '@/lib/utils'

export function EmployeeAvatar({
  employee,
  fallback,
  className,
}: {
  employee?: Employee
  fallback?: string
  className?: string
}) {
  const label = employee?.emoji || fallback?.slice(0, 1) || '·'
  return (
    <Avatar className={cn('size-8', className)}>
      {employee?.avatar && <AvatarImage src={employee.avatar} alt={employee.displayName} />}
      <AvatarFallback className="text-sm">{label}</AvatarFallback>
    </Avatar>
  )
}

// 可复用的员工状态徽标（叠在头像右下角）：工作中/后台/巡查=三点跳动；已收工✓/等你拍板?/出错!/中断·。
// 定位与描边色由 className 传入（侧栏用 ring-sidebar、聊天头部用 ring-card）。
export function EmployeeStatusBadge({
  kind,
  title,
  className,
}: {
  kind?: EmpStateKind | 'patrol'
  title?: string
  className?: string
}) {
  if (!kind) return null
  const dot = empDotStyle(kind)
  return (
    <span
      title={title}
      // [&_svg]:size-2! —— 覆写 shadcn SidebarMenuButton 的 [&_svg]:size-4 后代选择器泄漏
      // （否则徽标里的 ✓/?/! 图标被强制放大到 16px、溢出 14px 徽标、看起来变大/重叠）。
      className={cn(
        'grid size-3.5 place-items-center rounded-full text-white ring-2 [&_svg]:size-2!',
        dot.color,
        className,
      )}
    >
      {dot.active ? (
        <span className="emp-dots">
          <i />
          <i />
          <i />
        </span>
      ) : kind === 'done' ? (
        <CheckIcon weight="bold" className="size-2" />
      ) : kind === 'question' ? (
        <QuestionIcon weight="bold" className="size-2" />
      ) : kind === 'error' ? (
        <WarningIcon weight="fill" className="size-2" />
      ) : (
        <span className="size-1.5 rounded-full bg-white/90" />
      )}
    </span>
  )
}
