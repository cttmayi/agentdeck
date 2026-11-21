<script lang="ts">
  import type { Snippet } from 'svelte'
  import { t } from '../lib/i18n.ts'

  /**
   * **设置面板的外壳**（分批第 296 批）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么抽成一份
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者先要求"聊天设置、智能体设置都改成和沉淀设置一样，放在主区"，随后补了一句
   * "风格同步，最好在一定程度的共代码"。三处（聊天 / 智能体 / 沉淀）本来已经用同一套
   * `.drawer-section` 分段样式了，**只有外壳是各写一遍的**：三份 `.main-panel` +
   * 三份栏头 + 三份返回按钮。那种重复的代价很具体：上一次改按钮顺序时只改了一处
   * （三个设置页的头部因此长得不一样，而这不是任何判据量得到的）。
   *
   * 所以把外壳收成这一份：**头部（返回 + 标题 + 副题）/ 正文 / 栏脚（可选）**。
   * 分段与字段仍由各处自己写（业务不同），只保证骨架同一套。
   *
   * ⚠️ 返回按钮**必须一直可见**（`.panel-back`，全局样式）：主区面板把右栏**换掉了**，
   *   列表回不去才是真正的问题——不能复用只在窄屏出现的 `.back-to-list`。
   * ⚠️ `data-settings-panel` 与 `data-settings-back` 是**探针契约**（`settings.*` 那一组
   *   判据按它们定位面板与返回），改名字要一起改探针。
   */
  let {
    title,
    subtitle = '',
    onback,
    body,
    foot,
    /** 无障碍标签（缺省用标题）。 */
    ariaLabel,
  }: {
    title: string
    subtitle?: string
    onback: () => void
    body: Snippet
    foot?: Snippet
    ariaLabel?: string
  } = $props()
</script>

<section class="main-panel" data-settings-panel aria-label={ariaLabel ?? title}>
  <header class="main-panel-head">
    <button type="button" class="btn btn--ghost btn--sm panel-back" data-settings-back onclick={onback}
      >{$t('common.backPanel')}</button
    >
    <h2>{title}</h2>
    {#if subtitle !== ''}
      <span class="faint fs-xs">{subtitle}</span>
    {/if}
  </header>
  <div class="main-panel-body detail-scroll settings-body">
    {@render body()}
  </div>
  {#if foot}
    <div class="main-panel-foot">
      {@render foot()}
    </div>
  {/if}
</section>

<style>
  /**
   * ⚠️ 这里原来写死 `padding: var(--sp-4)`（16 四周），那是 D183 之前的旧值。
   * D183 定了**面板级内距 = 头 16/24/12、体 16/24、脚 12/24**，而 `.main-panel-body`
   * 本来就按令牌给了正确值 ⇒ 这行覆盖等于把四处面板（三个设置 + 新建智能体）的
   * 左右内距私自收窄到 16。D214 删掉它，让它们继承令牌。
   */

  .settings-body :global(p) {
    margin: 0 0 var(--sp-2);
  }
</style>
