import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/**
 * 与 `apps/web/svelte.config.js` 同一套：`vitePreprocess` 让 `<script lang="ts">`
 * 被正确解析，`svelte-check` 才查得到模板里的类型（那是 `tsc` 的盲区——
 * `.svelte` 模板不在它的视野里）。
 */
export default {
  preprocess: vitePreprocess(),
}
