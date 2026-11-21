<script lang="ts">
  /**
   * ContainerCard —— **可以装子卡的卡**：编排的一步（StepCard）或把关循环的一轮（RoundCard）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它自己的展开状态，父组件不知道
   * ══════════════════════════════════════════════════════════════════
   *
   * `manual === undefined` ⇒ 按默认：**正在跑 / 等人确认的自动展开**，跑完自动收起
   * （判据 `lib/workflow-cards.ts#stepExpanded`）。人点过之后一直是人的选择。
   *
   * ⚠️ 使用者 2026-11 报过两次同一类怪现象（"下面多出来一张卡片"、"展开上面的下面就不见了"），
   *    根因都是**展开状态住在父组件的字典里**（`expandedSeq` / `openSteps`）——
   *    于是"该展开谁"由主流程一处判断，规则一多就互相踩。
   *    现在：每张容器卡自己记，父卡收起只是**不渲染子卡**（子卡组件不被销毁的场合，
   *    它们的 `manual` 还在），再展开就回到原样；两张兄弟卡之间**结构上不可能互相影响**。
   *
   * 子卡由 `CardNode.svelte` 递归渲染（`children` snippet 由父级传入）。
   */
  import type { Snippet } from 'svelte'
  import { t } from '../../lib/i18n.ts'
  import { cardState, readOpen, writeOpen } from '../../lib/card-state.ts'
  import { stepExpanded } from '../../lib/workflow-cards.ts'
  import {
    workflowStepKindKey,
    workflowStepStatusClass,
    workflowStepStatusKey,
  } from '../../lib/run-status.ts'

  /** 卡片 key（稳定 id；展开状态按它存，见 `lib/card-state.ts`）。 */
  export let cardKey: string
  /** `'step'` = 编排的一步；`'round'` = 把关循环的一轮（同一副骨架，只是标题来源不同）。 */
  export let variant: 'step' | 'round' = 'step'
  /** 容器状态（`WorkflowStep.status`）。 */
  export let status: string
  /** 标题：步骤的话是 `step.label`，轮的话是「第 N 轮」。 */
  export let title: string
  /** 步骤原型（只有 `variant === 'step'` 才显示那个灰框小标签）。 */
  export let stepKind: string | null = null
  /** 右侧那串短 runId（流水线最后一级那条）。 */
  export let runId: string | null = null
  /** 收起时那块**多行、可滚**的产出预览（空串 = 不画）。 */
  export let preview = ''
  /** 子卡（由上级递归渲染好传进来）。 */
  export let children: Snippet

  /*
   * 展开状态**按卡片 key 存**（`lib/card-state.ts`），不是组件局部变量：
   * 父卡收起时子卡不渲染、实例被销毁，局部状态会跟着丢——"我点开的这一层
   * 又自己收起来了"。按 key 存 ⇒ 收起/展开父卡不影响任何人。
   */
  $: open = readOpen(cardKey, stepExpanded(undefined, status)) && $cardState >= 0

  function toggle(): void {
    writeOpen(cardKey, !open)
  }
</script>

<div class="card" class:round={variant === 'round'}>
  <button type="button" class="card-head" onclick={toggle}>
    <span class="card-line">
      <span class="badge {workflowStepStatusClass(status)}">{$t(workflowStepStatusKey(status))}</span>
      {#if stepKind !== null}
        <span class="kind">{$t(workflowStepKindKey(stepKind))}</span>
      {/if}
      <span class="card-title ellipsis">{title}</span>
      {#if runId !== null}
        <span class="mono faint fs-xs">{runId.slice(-8)}</span>
      {/if}
    </span>
    <span class="card-toggle">
      {open ? '▾ ' + $t('workflows.collapse') : '▸ ' + $t('workflows.expand')}
    </span>
  </button>

  {#if !open && preview !== ''}
    <!--
      收起态：这块就是"往下交的那份产出"的**多行预览**——换行、超出**自己滚**
      （使用者 2026-11："需求多放几行"、"还是用滚动条，可以多看几行"、"点展开过程就隐藏这几行"）。
      ⚠️ 放在按钮**外面**：滚动区套在 `<button>` 里，滚轮与点击会互相打架。
    -->
    <div class="card-preview">{preview}</div>
  {/if}

  {#if open}
    <div class="card-body">
      <div class="card-children">{@render children()}</div>
    </div>
  {/if}
</div>

<style>
  .card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }
  /* 轮次卡再轻一档：它是"步骤里面的一层"，不该和步骤卡抢同等份量 */
  .card.round {
    border-color: var(--line-strong);
  }
  .card-head {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: none;
    border: 0;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .card-head:hover {
    background: var(--surface-hover);
  }
  .card-line {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .kind {
    flex: 0 0 auto;
    font-size: var(--fs-2xs);
    color: var(--text-dim);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 0 var(--sp-1);
    white-space: nowrap;
  }
  .card-title {
  /* D191：截断三条收进全局 `.ellipsis`（markup 已带） */
    min-width: 0;
    font-weight: 600;
  }
  .card-toggle {
    flex: 0 0 auto;
    color: var(--text-faint);
    font-size: var(--fs-xs);
    white-space: nowrap;
  }
  /* 收起态预览：多行 + 换行 + 自己滚（约 6 行） */
  .card-preview {
    margin: 0 var(--sp-3) var(--sp-2);
    padding: 2px var(--sp-2);
    border-left: 2px solid var(--line-strong);
    color: var(--text-faint);
    font-size: var(--fs-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: calc(1.5em * 6);
    overflow-y: auto;
  }
  .card-body {
    padding: 0 var(--sp-3) var(--sp-2);
  }
  /* 子卡区：左侧一条竖线 = "这些在这一卡里面"；嵌套时自然多缩进一层 */
  .card-children {
    border-left: 2px solid var(--line);
    margin-left: 2px;
    padding-left: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
</style>
