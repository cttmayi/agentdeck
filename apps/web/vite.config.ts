import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/**
 * Vite 配置。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条约束决定了这里的形状
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 产物必须能被 daemon 当**普通静态文件**发出去。**
 *    构建输出到 `dist/`，daemon 那边只认这个目录——它不知道 Svelte 的存在，
 *    也不需要知道。这样"谁来托管 UI"这件事没有变（仍是 daemon + 同源）。
 *
 * **② 构建产物必须**没有 CDN 依赖**。** 页面跑在 127.0.0.1 上，用户可能
 *    完全离线。所以 `base: './'` 用相对路径，且不引任何外部资源。
 *
 * 开发模式下 Vite 起在 5173，把 `/api` 代理到 daemon 的 4517——**浏览器看到的
 * 仍是同源**，所以开发时与生产时走的是同一套同源假设，不会出现"开发能跑、
 * 上线 CORS 炸"的情况。
 */
const DAEMON_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:4517'

export default defineConfig({
  plugins: [svelte()],
  // 相对路径：产物要能在任意前缀下被 daemon 托管
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 目标是本机浏览器，不需要为老浏览器降级——产物小一点更好
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: DAEMON_URL,
        changeOrigin: false,
        // SSE 必须关掉缓冲，否则实时日志会攒着不动
        ws: false,
      },
    },
  },
})
