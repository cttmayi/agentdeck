<script lang="ts">
  /**
   * 把编辑器模块里的状态**推给 legacy 的 `CrystallizeView`**（分批第 155 批）。
   *
   * 为什么需要这么一个"什么也不画"的组件：`CrystallizeView` 是 legacy（`export let`），
   * 实测它的 `$:` 跟踪不到 `.svelte.ts` 模块里的信号（症状：结论条一直画 "○ …"、树空、
   * slug 输入框不出现）。跨模块要让它重渲染，只能由**别人**（runes 组件）在信号变化时
   * 调一次回调，父组件里的普通赋值才会 `$$invalidate`。
   *
   * 为什么不能就用 `CrystallizeDraftEditor` 兼任：编辑器现在渲染在**右栏**（由
   * `views/Crystallize.svelte` 并列渲染），它拿不到 `CrystallizeView` 的回调
   *（兄弟组件之间没有通道），挂一个隐藏的编辑器实例又会重复渲染整棵树。
   * 所以拆出一个只做推送的小组件，父组件静态地渲染它一次。
   */
  import { editor, paneWide } from '../lib/crystallize-editor.svelte.ts'

  let {
    onstate,
  }: {
    onstate: (s: {
      artifacts: typeof editor.artifacts
      fileRows: Array<{ rel: string; change: '' | 'A' | 'M' | 'D'; bytes: number }>
      fileCount: number
      totalBytes: number
      diff: typeof editor.diff
      diffAgainst: typeof editor.diffAgainst
      diffLoading: boolean
      dirty: boolean
      savingDraft: boolean
      /** ★ 分批第 168 批：右栏是否"真列"（否则编辑器要回到中间那条消息里）。 */
      paneWide: boolean
    }) => void
  } = $props()

  $effect(() => {
    onstate({
      artifacts: editor.artifacts,
      fileRows: editor.fileRows,
      fileCount: editor.fileCount,
      totalBytes: editor.totalBytes,
      diff: editor.diff,
      diffAgainst: editor.diffAgainst,
      diffLoading: editor.diffLoading,
      dirty: editor.dirty,
      savingDraft: editor.savingDraft,
      paneWide: paneWide.value,
    })
  })
</script>
