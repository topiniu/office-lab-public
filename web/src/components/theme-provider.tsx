import { ThemeProvider as NextThemesProvider } from "next-themes"
import type { ComponentProps } from "react"

// 暗色模式：next-themes 以 class 策略在 <html> 上切 .dark，与 shadcn 的
// `@custom-variant dark (&:is(.dark *))` 完全对齐。默认跟随系统。
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
