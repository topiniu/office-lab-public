import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { ErrorBoundary } from '@/components/error-boundary'
import App from './App.tsx'

// 移动端聊天页把地址改写成 /chat（作为真正的页、支持系统返回）。若用户在 /chat 直接刷新，
// 没有会话上下文，回到根路径即可（保留 ?run=/?file= 等深链查询，交给 DeepLink 消费）。
if (window.location.pathname !== '/') {
  window.history.replaceState(null, '', '/' + window.location.search + window.location.hash)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider storageKey="office-lab-theme">
      <TooltipProvider delayDuration={300}>
        <ErrorBoundary
          fallback={(err, reset) => (
            <div className="grid min-h-svh place-items-center p-6 text-center">
              <div className="max-w-md">
                <h1 className="text-lg font-semibold">界面出错了</h1>
                <p className="mt-1 text-sm text-muted-foreground break-words">{err.message}</p>
                <button onClick={reset} className="mt-3 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
                  重试
                </button>
              </div>
            </div>
          )}
        >
          <App />
        </ErrorBoundary>
        <Toaster position="top-center" richColors />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
