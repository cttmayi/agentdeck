import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

/**
 * 远端管理页的 Vite 配置。
 *
 * 与 `apps/web` 那条路**同形**（产物是普通静态文件、无 CDN 依赖、相对路径），
 * 差别只有一个：开发模式代理到 **4518**（远端服务）而不是 4517。
 *
 * ⚠️ `base: './'` 是必须的：产物由远端服务当普通静态文件发出去，而页面挂在哪
 *    个前缀下由服务决定（现在是 `/`，但相对路径让改动不牵连构建产物）。
 */
const REMOTE_URL = process.env['REMOTE_URL'] ?? 'http://127.0.0.1:4518'

export default defineConfig({
  plugins: [svelte()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5174,
    proxy: { '/api': { target: REMOTE_URL, changeOrigin: false } },
  },
})
