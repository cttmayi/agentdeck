<script lang="ts">
  /**
   * RunCard —— **一条 run 一张卡**（一个 Agent 的一次执行）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这个组件自己管自己的日志开关
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者 2026-11："卡片内部右上角有一个按钮来决定是否要展开日志……这样并行多个
   * Agent 的时候，我可以分开查看其日志。"
   *
   * 所以展开状态**住在这个组件里**（`manual`），父组件既不知道也不管：
   * 它只决定"有哪些 run ⇒ 有哪些卡"。上一版把状态放在视图的一个字典里
   * （`openLogs[runId]`），于是"谁展开"由主流程说了算——两次修都没修干净。
   *
   * `manual === undefined` ⇒ 按默认：**正在跑的那条自动展开**，跑完自动收起
   * （判据 `lib/workflow-cards.ts#logExpanded`）。人点过一次之后一直是人的选择，
   * 2s 轮询不会把它收回去。
   *
   * ⚠️ 卡片实例由父组件的 `{#each … (node.key)}` 保活（key 用 runId）——用下标当 key
   *    会让卡片每轮重建、开关状态每 2 秒被重置。
   */
  import { t } from '../../lib/i18n.ts'
  import { cardState, readOpen, writeOpen } from '../../lib/card-state.ts'
  import type { CardNode } from '../../lib/workflow-cards.ts'
  import { logExpanded } from '../../lib/workflow-cards.ts'
  import { runStatusKey, workflowRunStatusClass } from '../../lib/run-status.ts'
  import RunLog from '../RunLog.svelte'

  /** 卡片树里的 `run` 节点（类型由 `lib/workflow-cards.ts` 的 `CardNode` 收口）。 */
  export let node: Extract<CardNode, { kind: 'run' }>

  /*
   * 展开状态：**按卡片 key 存在 `lib/card-state.ts`**，不是组件局部变量。
   *
   * ⚠️ 为什么不能是局部 `let`：父卡收起时子卡不渲染（`{#if open}`，收起时不挂
   *    `RunLog`、不占 SSE），组件实例会被销毁 ⇒ 局部状态跟着没了 ⇒ 再展开父卡时
   *   使用者刚点开的这条日志被悄悄关掉。按 key 存就没有这个问题。
   *
   * `$cardState` 参与依赖：别人改了会触发重算（自己改的那次也会）。
   */
  $: open = readOpen(node.key, logExpanded(undefined, node.status)) && $cardState >= 0

  function toggle(): void {
    writeOpen(node.key, !open)
  }
</script>

<div class="card card--run">
  <div class="card-head">
    <span class="card-line">
      <span class="badge {workflowRunStatusClass(node.status)}">{$t(runStatusKey(node.status))}</span>
      <span class="run-name">{node.name}</span>
      {#if node.meta}<span class="faint fs-xs">{node.meta}</span>{/if}
    </span>
    <button type="button" class="btn btn--ghost btn--sm" onclick={toggle}>
      {open ? '▾ ' : '▸ '}{$t('workflows.log')}
    </button>
  </div>
  <div class="card-body">
    <div class="run-text" class:streaming={node.streaming}>{node.text}</div>
    {#if open}
      <!-- 只有展开了才挂 RunLog：没展开就不开那一路 SSE -->
      <div class="run-log"><RunLog runId={node.runId} fill /></div>
    {/if}
  </div>
</div>

<style>
  .card {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
  }
  .card-line {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .run-name {
    font-weight: 600;
    color: var(--text-dim);
  }
  .card-body {
    padding: 0 var(--sp-3) var(--sp-2);
  }
  .run-text {
    border: 1px solid var(--line);
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: var(--sp-1) var(--sp-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-dim);
    font-size: var(--fs-sm);
    max-height: 9rem;
    overflow-y: auto;
  }
  /* 还在收：末尾一根光标（"正在写"这件事不用一句话去说） */
  .streaming::after {
    content: '▌';
    color: var(--accent);
    animation: blink 1s steps(2, start) infinite;
  }
  @keyframes blink {
    to {
      visibility: hidden;
    }
  }
  .run-log {
    margin-top: var(--sp-1);
  }
</style>
