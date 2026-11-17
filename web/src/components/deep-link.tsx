import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useRunDetail } from '@/components/run-detail-provider'
import { useFileViewer } from '@/components/file-viewer'

// 启动时消费 ?run=<id> / ?file=<path> / ?theme=light|dark|system 深链。
export function DeepLink() {
  const { open: openRun } = useRunDetail()
  const { openFile } = useFileViewer()
  const { setTheme } = useTheme()
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const theme = q.get('theme')
    const run = q.get('run')
    const file = q.get('file')
    if (theme && ['light', 'dark', 'system'].includes(theme)) setTheme(theme)
    if (run) openRun(run)
    if (file) openFile(file)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
