// 复制文本到剪贴板。navigator.clipboard 只在安全上下文（https / localhost）可用——经局域网 IP、Tailscale 用 http
// 打开时它是 undefined，所以退回到老办法：临时 textarea + execCommand('copy')。
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy command rejected')
  } finally {
    document.body.removeChild(ta)
  }
}
