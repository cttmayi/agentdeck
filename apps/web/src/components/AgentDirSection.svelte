<script lang="ts">
  /**
   * **「目录」一节**（2026-11，D248）——智能体新建页与编辑页共用的一份。
   *
   * 来历：D245 先给编排内建智能体的编辑页做了"默认收起的一节目录树"
   * （使用者："可以作为某种高级默认隐藏目录显示，而不是有一个打开目录的按钮"）。
   * 接着使用者要求把**新建与编辑统一化**：「主要差异是智能体的名字和打开目录，
   * 原则还是一样，不可用的部分置灰」——于是这一节在两页都在：
   *   · 编辑页：`base` 是真实目录（`/api/fs/agent:<id>` 或 `/api/fs/wf-agent:<wid>/<aid>`），
   *     展开即可看文件、点文件名进 `FileViewer` 的原文面改、保存写回磁盘；
   *   · 新建页：实体还不存在 ⇒ `base=null` + `disabled`，整节**置灰不展开**
   *     （不删——删了会让两页结构不一样，见 `ui-style.md` §2.4「不可用置灰不删」）。
   *
   * ⚠️ 位置照 §2.4：整行宽的辅助块只能放在主内容**之后**（表单卡片尾部），
   *   不能抢在"名字 / CLI / 指令"前面。
   */
  import WorkDirTree from './WorkDirTree.svelte'
  import { t } from '../lib/i18n.ts'

  /** 目录的接口前缀（`/api/fs/<scope>`）。`null` = 还没有目录（新建页）。 */
  export let base: string | null = null
  /** 置灰：标题还在、点不开（新建页用）。 */
  export let disabled = false
  /** 标题文案（缺省「目录」）。 */
  export let title = ''
  /** 说明文案（缺省那句通用的）。 */
  export let hint = ''

  let open = false
  let count = 0

  $: shownTitle = title === '' ? $t('agents.dirTitle') : title
  $: shownHint = disabled ? $t('agents.dirAfterCreate') : hint === '' ? $t('agents.dirHint') : hint
</script>

<div class="fold-section" data-agent-dir data-dir-disabled={disabled}>
  <button
    type="button"
    class="fold-head"
    aria-expanded={open && !disabled}
    aria-disabled={disabled}
    disabled={disabled}
    title={disabled ? $t('agents.dirAfterCreate') : ''}
    onclick={() => {
      if (disabled) return
      open = !open
    }}
  >
    <span class="chevron" aria-hidden="true">{open && !disabled ? '▾' : '▸'}</span>
    <span class="fold-title">{shownTitle}</span>
    <span class="fold-summary" data-dir-summary>{shownHint}</span>
  </button>
  {#if open && !disabled && base}
    <div class="fold-body">
      <WorkDirTree {base} reloadKey={`${base}/${open}`} bind:count />
    </div>
  {/if}
</div>

<style>
  /* 置灰：标题照样在、字变淡、指针是"不能点"——与 `button:disabled` 的既有观感一致
     （`.btn` 基类那条 `opacity: .45` 不覆盖 `.fold-head`，所以这里只补颜色）。 */
  .fold-head:disabled {
    cursor: not-allowed;
  }

  .fold-head:disabled .fold-title,
  .fold-head:disabled .fold-summary,
  .fold-head:disabled .chevron {
    color: var(--text-faint);
  }
</style>
