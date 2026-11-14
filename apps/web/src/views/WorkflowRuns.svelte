<script lang="ts">
  /**
   * 编排任务（2026-11，使用者拍板"侧栏应该有一编排任务页"）——全部编排运行的
   * 列表视图：
   * 左栏 = 所有编排运行（按 updatedAt 倒排），行 = 状态徽标 + 编排名 + 步骤进度 + 时间；
   * 右栏 = 空态提示；点一条进运行画面（`#/workflows/run/<runId>`，子路由）。
   *
   * ⚠️ 与 `Workflows.svelte` 的分工：定义页（「编排」）留"定义 + 该编排的历史"，
   *   这里是从侧栏直达的**全部运行**——同一批数据（`workflowRuns` store）两个读法。
   *
   * ⚠️ Svelte 5 legacy 模式：不引 runes（与 Tasks.svelte 同款约束）。
   */
  import { onMount } from 'svelte'
  import { t } from '../lib/i18n.ts'
  import {
    workflows,
    workflowRuns,
    loadWorkflowRuns,
    loadWorkflows,
  } from '../lib/stores.ts'
  import { wfReturn, workflowRun } from '../lib/view.ts'
  import WorkflowRunView from '../components/WorkflowRunView.svelte'
  import MainArea from '../components/MainArea.svelte'
  import {
    workflowRunStatusClass,
    workflowRunStatusKey,
  } from '../lib/run-status.ts'
  import ListRow from '../components/ListRow.svelte'
  import { relativeTime } from '../lib/time.ts'
  import { listGrip } from '../lib/list-grip.ts'

  onMount(() => {
    // 切进这页重拉一次（运行画面里可能刚发起/刚结束一条——界面跟着数据走）
    void Promise.all([loadWorkflowRuns(), loadWorkflows()])
  })

  $: runs = [...$workflowRuns].sort((a, b) => b.updatedAt - a.updatedAt)

  function workflowName(id: string): string {
    return $workflows.find((w) => w.id === id)?.name ?? id.slice(0, 8)
  }

  function openRun(runId: string): void {
    // ★ 2026-11 使用者拍板：点一条**不跳去「编排」视图**——`#/workflow-runs/<id>`
    //   子路由，本视图主区直接画运行画面（返回按钮回列表：wfReturn 是
    //   WorkflowRunView「返回」的去处）。
    wfReturn.set('workflow-runs')
    location.hash = `#/workflow-runs/${runId}`
  }
</script>

<div
  class="split-layout"
  class:with-detail={$workflowRun !== null}
  data-list-key="workflow-runs"
  data-list-label={$t('shell.resizeList')}
  use:listGrip
>
  <!-- ══════════ 左栏：编排运行列表（恒在——2026-11 使用者拍板"列表不该消失"，
       点一条只在右栏换运行画面，任务页同款主从） ══════════ -->
  <section class="pane list-pane">
    <header class="pane-head">
      <div>
        <h2>{$t('workflowruns.listTitle')}</h2>
        <p class="hint">{$t('workflowruns.navHint')}</p>
      </div>
    </header>

    <div class="pane-body">
      {#if runs.length === 0}
        <div class="empty">
          <strong>{$t('workflowruns.empty')}</strong>
        </div>
      {:else}
        <ul class="list-stack">
          {#each runs as r (r.id)}
            <ListRow rowClass="wf-run-row" onclick={() => openRun(r.id)}>
              {#snippet children()}
                <span class="wf-title">
                  <span class="badge {workflowRunStatusClass(r.status)}">{$t(workflowRunStatusKey(r.status))}</span>
                  <span>{workflowName(r.workflowId)}</span>
                </span>
                <span class="wf-sub">
                  <span class="faint">{relativeTime(r.updatedAt, Date.now())}</span>
                  <span class="faint">{$t('workflows.stepsHint')} {r.steps.filter((s) => s.status !== 'pending').length}/{r.steps.length}</span>
                </span>
              {/snippet}
            </ListRow>
          {/each}
        </ul>
      {/if}
    </div>
  </section>

  <!-- ══════════ 右栏：选中运行 → 运行画面（列表在左，不消失）；
       没选中 → 「点一条看运行画面」空态（任务页同款主从） ══════════ -->
  <MainArea
    empty={$workflowRun === null}
    emptyTitle={$t('workflowruns.pickHint')}
    backLabel={$workflowRun !== null ? $t('workflowruns.runBack') : undefined}
    onBack={() => (location.hash = '#/workflow-runs')}
  >
    {#snippet body()}
      {#if $workflowRun}
        <WorkflowRunView runId={$workflowRun.runId} embedded />
      {/if}
    {/snippet}
  </MainArea>
</div>

<style>
  /* 编排任务列表行 = 徽标 + 标题 + 进度，内容比任务页简单——默认列表窄一档
     （13-16rem），把宽度让给右栏运行画面（2026-11 使用者："窗口太小了"）。
     listGrip 拖过之后以 localStorage 为准（inline 优先于这里）。 */
  .split-layout {
    --list-w: minmax(13rem, 16rem);
  }

  /* 与 Workflows.svelte 历史行同款两行结构（311/312 批纪律）：
     第一行标题（单行省略五件套）、第二行辅助信息（显式字色/字号 + 单行省略）。
     两处是同一个"运行列表行"的形状，样式必须一致——这里复制是跨组件必然
     （Svelte scoped 样式跨组件拿不到），值逐项与 Workflows.svelte 相同。 */
  .wf-title {
    display: block;
    max-width: 100%;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wf-title .badge {
    margin-right: var(--sp-2);
  }
  .wf-sub {
    display: flex;
    gap: 0.6rem;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    overflow: hidden;
    white-space: nowrap;
  }
</style>
