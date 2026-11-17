import { lazy, Suspense, useState } from 'react'

import { AppSidebar, type ViewId } from '@/components/app-sidebar'
import { MobileFab } from '@/components/mobile-fab'
import { SseProvider } from '@/components/sse-provider'
import { EmployeesProvider } from '@/hooks/use-employees'
import { EmployeeStatusProvider } from '@/components/employee-status-provider'
import { FileViewerProvider } from '@/components/file-viewer'
import { ImageViewerProvider } from '@/components/image-viewer'
import { EmployeeDetailProvider } from '@/components/employee-detail'
import { SettingsProvider } from '@/components/settings-dialog'
import { RunDetailProvider } from '@/components/run-detail-provider'
import { DeepLink } from '@/components/deep-link'
import { Skeleton } from '@/components/ui/skeleton'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'

const KanbanView = lazy(() => import('@/views/KanbanView'))
const MeetingView = lazy(() => import('@/views/MeetingView'))
const PatrolView = lazy(() => import('@/views/PatrolView'))

function ViewFallback() {
  return (
    <div className="grid gap-3 p-4">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  )
}

function App() {
  const [view, setView] = useState<ViewId>('kanban')

  return (
    <SseProvider>
      <EmployeesProvider>
       <EmployeeStatusProvider>
       {/* 图片查看器在最外层：会话截图、待发附件、markdown 插图都点它开浮窗，
           浮窗本身 portal 到 body 且 z≥60（在 Radix 弹层之上，见 image-viewer.tsx） */}
       <ImageViewerProvider>
       <FileViewerProvider>
        <EmployeeDetailProvider>
         <SettingsProvider>
          <RunDetailProvider>
          <DeepLink />
          {/* 应用外壳：移动端进入聊天页时整体隐藏（display:none），聊天页作为真正的「页」独占视口，
              背后没有任何东西可透出（根治 iOS 键盘顶飞露出看板）。display:contents 保证平时不引入额外盒子、不扰乱布局。 */}
          <div className="ol-app-shell contents">
          <SidebarProvider>
          <AppSidebar view={view} onNavigate={setView} />
          {/* 移动端顶栏已移除，改用右下角可拖拽 logo 悬浮键（单手友好）；顶部留出刘海/状态栏安全区。
              pe-(--ol-dock-w)：给聊天停靠栏（第三栏）预留空间——这是「主内容让位收窄」而非「被浮窗盖住」
              的全部机制（未停靠时变量为 0px，不占位）。见 hooks/use-dock.ts。 */}
          <SidebarInset className="min-w-0 pe-(--ol-dock-w) pt-[env(safe-area-inset-top)]">
            <main className="min-h-0 flex-1 overflow-auto">
              <Suspense fallback={<ViewFallback />}>
                {view === 'kanban' && <KanbanView />}
                {view === 'meeting' && <MeetingView />}
                {view === 'patrol' && <PatrolView />}
              </Suspense>
            </main>
          </SidebarInset>
          <MobileFab />
          </SidebarProvider>
          </div>
          </RunDetailProvider>
         </SettingsProvider>
        </EmployeeDetailProvider>
       </FileViewerProvider>
       </ImageViewerProvider>
       </EmployeeStatusProvider>
      </EmployeesProvider>
    </SseProvider>
  )
}

export default App
