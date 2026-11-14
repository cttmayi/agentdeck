<script lang="ts">
  /**
   * 编排运行画面（`#/workflows/run/<runId>`，2026-11 使用者立项）。
   *
   * 布局 = 任务页 v2 形态（使用者拍板："运行画面保留 v2 形态"）：
   *   左 = 步骤链（pending→running→done，gate 挂起等确认）；
   *   中 = 当前步骤的 RunLog + gate 确认面板；
   *   右 = 工作目录树（`WorkDirTree`，base 用当前步骤的 runId——工作目录按任务
   *        设定，各步同一目录；使用者拍板："执行时一定要能预览工作目录"）。
   *
   * 数据 = 轮询 `GET /api/workflow-runs/:id`（执行画面要"中途可看"；run 状态
   * 在 daemon 内存 + 文件，SSE 不为编排专门开一路，轮询是这一期最稳的取数）。
   *
   * ⚠️ Svelte 5 legacy 模式：不引 runes（与 Tasks.svelte 同款约束）。
   */
  import { onMount } from 'svelte'
  import { t } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import { api, type WorkflowRun, type WorkflowStep } from '../lib/api.ts'
  import { issues } from '../lib/stores.ts'
  import { go } from '../lib/view.ts'
  import RunLog from './RunLog.svelte'
  import WorkDirTree from './WorkDirTree.svelte'

  export let runId: string

  let run: WorkflowRun | null = null
  let error = ''
  let busy = false

  /** 当前步骤 = 最后一个还没 done 的（running / waiting-human / pending）。 */
  $: currentStep = (run?.steps ?? []).find((s) => s.status !== 'done') ?? null
  /** 当前步骤里最近一次组跑的 runId（RunLog 问它要日志；没跑过 = 空）。 */
  $: activeRunId =
    currentStep && currentStep.runIds.length > 0
      ? currentStep.runIds[currentStep.runIds.length - 1]!
      : null
  /** 这条运行对应的任务（标题展示用）。 */
  $: issue = $issues.find((i) => i.id === run?.issueId) ?? null

  async function refresh(): Promise<void> {
    try {
      const out = await api<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}`)
      run = out.run
      error = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  onMount(() => {
    void refresh()
    // 执行画面"中途可看"：2s 轮询一次（run 状态 + 步骤链 + gate 挂起都要及时）
    timer = setInterval(() => void refresh(), 2000)
    return () => {
      if (timer) clearInterval(timer)
    }
  })

  async function control(action: 'pause' | 'resume' | 'confirm' | 'retry-step'): Promise<void> {
    if (busy) return
    busy = true
    try {
      await api<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}/${action}`, { method: 'POST' })
      await refresh()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function runStatusKey(s: WorkflowRun['status']): WebTextId {
    const map: Record<string, WebTextId> = {
      queued: 'workflows.runStatusQueued',
      running: 'workflows.runStatusRunning',
      paused: 'workflows.runStatusPaused',
      'waiting-human': 'workflows.runStatusWaitingHuman',
      done: 'workflows.runStatusDone',
      failed: 'workflows.runStatusFailed',
    }
    return map[s] ?? 'workflows.runStatusQueued'
  }

  function statusKey(s: WorkflowStep['status']): WebTextId {
    const map: Record<string, WebTextId> = {
      pending: 'workflows.stepPending',
      running: 'workflows.stepRunning',
      done: 'workflows.stepDone',
      failed: 'workflows.stepFailed',
      'waiting-human': 'workflows.stepWaitingHuman',
      skipped: 'workflows.stepPending',
    }
    return map[s] ?? 'workflows.stepPending'
  }

  function statusClass(s: WorkflowStep['status']): string {
    return s === 'done' ? 'done' : s === 'failed' ? 'failed' : s === 'waiting-human' ? 'warn' : ''
  }

  function kindLabel(k: WorkflowStep['kind']): WebTextId {
    const map: Record<string, WebTextId> = {
      flow: 'workflows.stepKindFlow',
      parallel: 'workflows.stepKindParallel',
      aggregate: 'workflows.stepKindAggregate',
      loop: 'workflows.stepKindLoop',
      route: 'workflows.stepKindRoute',
      gate: 'workflows.stepKindGate',
    }
    return map[k] ?? 'workflows.stepKindFlow'
  }
</script>

<div class="wf-run-layout">
  <div class="detail-head">
    <div class="detail-sub">
      <button type="button" class="btn btn--ghost" onclick={() => go('workflows')}>
        {$t('workflows.runBack')}
      </button>
      <h2>{issue?.title ?? runId.slice(0, 8)}</h2>
      <p class="hint">
        {#if run}
          <span class="badge {run.status === 'done' ? 'done' : run.status === 'failed' ? 'failed' : run.status === 'waiting-human' ? 'warn' : ''}">
            {$t(runStatusKey(run.status))}
          </span>
          {#if run.error}
            <span class="wf-error">{$t('workflows.runStatusFailed')}: {run.error}</span>
          {/if}
        {/if}
      </p>
    </div>
    <div class="detail-actions">
      {#if run?.status === 'running'}
        <button type="button" class="btn btn--secondary" disabled={busy} onclick={() => void control('pause')}>
          {$t('workflows.pause')}
        </button>
      {:else if run?.status === 'paused'}
        <button type="button" class="btn btn--primary" disabled={busy} onclick={() => void control('resume')}>
          {$t('workflows.resume')}
        </button>
      {:else if run?.status === 'failed'}
        <button type="button" class="btn btn--primary" disabled={busy} onclick={() => void control('retry-step')}>
          {$t('workflows.retryStep')}
        </button>
      {/if}
    </div>
  </div>

  {#if error && !run}
    <div class="notice bad">{error}</div>
  {:else if !run}
    <div class="skeleton" style="height:3rem"></div>
  {:else}
    <div class="wf-run-main">
      <!-- ══════════ 左：步骤链 ══════════ -->
      <aside class="wf-steps">
        <h4>{$t('workflows.stepsTitle')}</h4>
        {#if run.steps.length === 0}
          <p class="hint">{$t('workflows.noRunYet')}</p>
        {:else}
          <ol class="wf-step-list">
            {#each run.steps as st (st.seq)}
              <li class="wf-step {st.status === 'running' ? 'on' : ''}">
                <span class="wf-step-seq mono">{st.seq}</span>
                <span class="wf-step-main">
                  <span class="wf-step-label">
                    <span class="badge {statusClass(st.status)}">{$t(statusKey(st.status))}</span>
                    <span class="faint">{$t(kindLabel(st.kind))}</span>
                  </span>
                  <span class="wf-step-text">{st.label}</span>
                  {#if st.gateText}
                    <span class="wf-step-gate">"{st.gateText}"</span>
                  {/if}
                </span>
              </li>
            {/each}
          </ol>
        {/if}
      </aside>

      <!-- ══════════ 中：日志 + gate 面板 ══════════ -->
      <section class="wf-run-log">
        {#if run.status === 'waiting-human' && currentStep?.kind === 'gate' && currentStep.gateText}
          <article class="notice wf-gate">
            <strong>{$t('workflows.stepWaitingHuman')}</strong>
            <p>"{currentStep.gateText}"</p>
            <div class="detail-actions">
              <button type="button" class="btn btn--primary" disabled={busy} onclick={() => void control('confirm')}>
                {$t('workflows.confirm')}
              </button>
            </div>
          </article>
        {/if}

        {#if activeRunId}
          <RunLog runId={activeRunId} fill />
        {:else}
          <p class="hint">{$t('workflows.noRunYet')}</p>
        {/if}
      </section>

      <!-- ══════════ 右：工作目录树（按任务设定，各步同一目录） ══════════ -->
      <aside class="result-files">
        <h4>{$t('workflows.workDirTitle')}</h4>
        {#if activeRunId}
          <WorkDirTree base={`/api/runs/${activeRunId}`} reloadKey={activeRunId} />
        {:else}
          <p class="hint">{$t('workflows.noRunYet')}</p>
        {/if}
      </aside>
    </div>
  {/if}
</div>

<style>
  .wf-run-layout {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .wf-run-main {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) 1fr minmax(16rem, 22rem);
    gap: var(--sp-3);
    overflow: hidden;
    padding: var(--sp-3) var(--sp-4);
  }
  .wf-steps {
    overflow-y: auto;
    padding-right: var(--sp-2);
  }
  .wf-run-log {
    overflow-y: auto;
  }
  .wf-step-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: 0;
    padding: 0;
  }
  .wf-step {
    display: flex;
    gap: var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .wf-step.on {
    border-color: var(--accent);
  }
  .wf-step-seq {
    color: var(--text-faint);
    font-size: var(--fs-sm);
  }
  .wf-step-main {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }
  .wf-step-label {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }
  .wf-step-text {
    font-weight: 600;
  }
  .wf-step-gate {
    color: var(--text-faint);
    font-size: var(--fs-sm);
  }
  .wf-gate {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .wf-error {
    color: var(--danger);
    font-size: var(--fs-sm);
    margin-left: var(--sp-2);
  }
</style>
