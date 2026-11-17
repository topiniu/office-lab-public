import { apiPost } from './api'

export type Upload = {
  path: string
  url: string
  name: string
  kind: 'image' | 'file'
  mime: string
}

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export async function uploadFile(file: File): Promise<Upload> {
  const data = await fileToDataURL(file)
  return apiPost<Upload>('/api/upload', { data, name: file.name })
}

// 附件 → 消息标记：图片走 〖截图〗path｜name〖/截图〗（引擎/员工识别，逐张 Read）；
// 其它文件附路径行。返回拼接进 message 的文本片段。
export function attachmentMarker(u: Upload): string {
  if (u.kind === 'image') return `〖截图〗${u.path}｜${u.name}〖/截图〗`
  return `[附件] ${u.name}：${u.path}`
}

// 本机文件（目前仅企微图片缓存）→ 由本机服务代读拷进 uploads/（浏览器读不了 file://）
export async function uploadLocalPath(path: string): Promise<Upload> {
  return apiPost<Upload>('/api/upload-local', { path })
}
