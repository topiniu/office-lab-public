import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// 后端静态资源（头像/上传件）与 API 一并代理到既有引擎（4800）。dev 与 preview 都要用，且 preview
// **不继承** server.* 的任何配置，必须各写一份。
// 目标可用 `OFFICE_LAB_API_TARGET` 覆盖（默认仍是 4800，生产行为一字不变）：
// 验证新端点时要起隔离引擎（临时 RUNS_DIR + 备用端口，见 test/ops 纪律），而这里写死 4800 会让
// 浏览器实测打到生产引擎上、看到的是旧代码——「症状像旧代码时先怀疑打错了实例」那条教训的前端版。
const API_TARGET = process.env.OFFICE_LAB_API_TARGET || 'http://127.0.0.1:4800'
// xfwd：把真实客户端 IP 写进 `x-forwarded-for` 转给引擎。**不是可选项**——4700 是代理，引擎看到的
// remoteAddress 永远是 127.0.0.1，隧道外的手机与本机浏览器在它眼里一模一样。`/api/reveal`（在宿主机
// 上开文件管理器 / 写剪贴板）靠这个头才能只放行本机；没有它那条鉴权等于全放。见 app/reveal.js。
const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true, xfwd: true },
  '/avatars': { target: API_TARGET, changeOrigin: true, xfwd: true },
  '/uploads': { target: API_TARGET, changeOrigin: true, xfwd: true },
}

// office-lab 新 UI（shadcn/Radix）——独立前端，/api 代理到既有引擎 server.js
//
// 端口分工（2026-08-19 改，见复盘 §3.83）：**4700 = `vite preview`（服务 web/dist 构建产物）**，
// 隧道（localhost → localhost:4700）与「打开控制台」都走它；本地要 HMR 时手动 `pnpm dev` → 4701。
// 病根：4700 原来跑的是 dev server，远程每开一次页要经隧道拉几百个未打包 ES module + 一条 HMR websocket，
// 慢得没法用。preview 服务的是一个 JS + 一个 CSS（自带 gzip/br + ETag），dist 由 `pnpm build:watch` 保持常新。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, './src'),
    },
  },
  server: {
    // 本地 HMR 专用端口（4700 让给 preview，两者不再互抢）
    port: 4701,
    // 端口被占就**报错退出**，绝不静默换端口。踩过：改配置触发 dev 热重启 → 新端口被占 → 它悄悄漂到 4702，
    // 而隧道与托盘双击都写死 4700，结果「服务在跑但谁都访问不到」，排查时还以为是隧道坏了。
    strictPort: true,
    // 绑所有网卡（含 IPv4 127.0.0.1 / 局域网 / Tailscale），与后端 server.js 一致；
    // 否则默认只绑 localhost→::1，IP 访问不到。
    host: true,
    // 反代/自定义域名访问放行：Vite 默认只放 IP/localhost，非 IP 域名（如 localhost）会被
    // 主机检查（防 DNS rebinding）拦截。内网工作台经自有反代访问，这里放行域名（true=全放；或改成白名单）。
    allowedHosts: true,
    proxy,
  },
  preview: {
    // 隧道与日常访问入口（托盘双击/悬浮窗也指这里）——同理必须 strictPort：漂了就等于全员打不开
    port: 4700,
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy,
  },
})
