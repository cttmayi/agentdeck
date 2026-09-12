import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/**
 * Svelte 配置。
 *
 * `vitePreprocess` 让 `<script lang="ts">` 里的 TypeScript 被正确解析——
 * 少了它，`svelte-check` 会报 "No Svelte configuration found"，而所有
 * 模板里的类型都查不出来。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须跑 svelte-check（不是可选项）
 * ══════════════════════════════════════════════════════════════════
 *
 * `tsc` **看不见 `.svelte` 模板**。所以从类型里删掉一个字段时，
 * 所有仍然引用它的模板**不会被报错**——它们只会在运行时炸。
 *
 * 这不是假设，是我实际踩到的：D28 把 `kindPatterns` / `isFallbackReviewer`
 * 从 Agent 上删掉后，`tsc` 全绿，而两处模板仍在读它们：
 *
 *   - 新建任务的 agent 下拉：`a.kindPatterns.includes('*')` 抛异常 ⇒
 *     **整个列表渲染不出来**（症状："找不到 Agent 了"）
 *   - 智能体详情：`agent.kindPatterns.length` 抛异常 ⇒
 *     **点进去什么都不显示**（症状："点 Agent 不能进入编辑界面"）
 *
 * 两个症状看起来毫不相干，根因是同一个，而**类型检查对此一言不发**。
 *
 * 所以 `pnpm run check` 现在必须跑 svelte-check —— 它查的正是 tsc 的盲区。
 */
export default {
  preprocess: vitePreprocess(),
}
