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
  import {
    workflowRunStatusClass,
    workflowRunStatusKey,
    workflowStepStatusClass,
    workflowStepStatusKey,
    workflowStepKindKey,
  } from '../lib/run-status.ts'
  import { issues } from '../lib/stores.ts'
  import { go, wfReturn } from '../lib/view.ts'
  import RunLog from './RunLog.svelte'
  import WorkDirTree from './WorkDirTree.svelte'

  export let runId: string
  /**
   * 主从形态（编排任务列表右栏）时隐藏**自带返回按钮**：列表就在左边，返回交给
   * MainArea 的 back-to-list（72rem 断点下列表隐藏、它才出现）。'workflows' 视图
   * 整页形态不传（返回按钮照常显示）。
   */
  export let embedded = false

  let run: WorkflowRun | null = null
  let error = ''
  let busy = false

  /** 当前步骤 = 最后一个还没 done 的（running / waiting-human / pending）。 */
  $: currentStep = (run?.steps ?? []).find((s) => s.status !== 'done') ?? null
  /**
   * 日志区看哪条 run 的日志。
   *
   * ★ 2026-11 使用者问"为什么提示还没开始跑"：编排**已经跑完**（全 done）时
   *   `currentStep` 为空、按旧逻辑 `activeRunId` 落成 null → 日志区显示「还没开始跑」
   *   ——完全误导。修法：当前步骤没有 runId（gate 等在确认 / pending 未提交 / 全
   *   done）时，回退到**最后一个有 runId 的步骤**——日志区永远显示"最近的那次
   *   组跑"，只有整条 run 一步都没提交过才显示空态。
   */
  $: activeRunId = (() => {
    const steps = run?.steps ?? []
    if (steps.length === 0) return null
    const current = steps.find((s) => s.status !== 'done')
    if (current && current.runIds.length > 0) return current.runIds[current.runIds.length - 1]!
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i]!
      if (st.runIds.length > 0) return st.runIds[st.runIds.length - 1]!
    }
    return null
  })()
  /** 这条运行对应的任务（标题展示用）。 */
  $: issue = $issues.find((i) => i.id === run?.issueId) ?? null

  /**
   * ★ 每步的「最后输出」（2026-11 使用者："中间应该显示每个 Agent 的最后输出，
   *   方便看到流程的运行"）。步骤的 runIds 里取最后一个 runId，拉 `GET
   *   /api/runs/:id` 的 `result.summary`（terminal 事件的最终产出）。
   *   用 plain object 替换触发渲染（Svelte 5 legacy，Map 不触发）。
   */
  let outputs: Record<string, string> = {}
  /** 点击步骤卡头展开它的完整过程日志（RunLog）。 */
  let expandedSeq: number | null = null

  /** ★ 2026-11 每个 Agent 一个显示：loop 步骤拆成「写作员 → 审查员」每轮两行。
   *   审查 run 没有挂在执行 run 上的字段，靠 subject（type:'run' + id=执行 run）
   *   从全量 runs 列表反查（与 daemon 同一条规矩）。列表只拉一次缓存；审查意见
   *   取审查 run 的 messages 最后一条 text（与输出流同一规则），没取到就每轮重试
   *   （审查 run 可能还在跑）。 */
  let reviewRunIds: Record<string, string> = {}
  let reviewOutputs: Record<string, string> = {}

  function lastRunId(st: WorkflowStep): string | null {
    return st.runIds.length > 0 ? st.runIds[st.runIds.length - 1]! : null
  }
  function stepOutput(st: WorkflowStep): string | null {
    const rid = lastRunId(st)
    return rid && outputs[rid] ? outputs[rid]! : null
  }
  function toggleStep(seq: number): void {
    expandedSeq = expandedSeq === seq ? null : seq
  }

  /** 按执行 runId 反查它的审查 run（没有则 null）。列表只拉一次。 */
  let runsList: Array<{ runId: string; kind: string; subject: { type: string; id: string } }> | null =
    null
  async function findReviewRun(execRunId: string): Promise<string | null> {
    if (reviewRunIds[execRunId] !== undefined) return reviewRunIds[execRunId] ?? null
    if (!runsList) {
      const page = await api<{
        runs: Array<{ runId: string; kind: string; subject: { type: string; id: string } }>
      }>('/api/runs')
      runsList = page.runs ?? []
    }
    const review = runsList.find(
      (r) => r.kind === 'review' && r.subject.type === 'run' && r.subject.id === execRunId,
    )
    reviewRunIds = { ...reviewRunIds, [execRunId]: review?.runId ?? '' }
    return review?.runId ?? null
  }

  async function refresh(): Promise<void> {
    try {
      const out = await api<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}`)
      run = out.run
      error = ''
      // 步骤输出：只取没缓存过的 runId（轮询 2s 一次，避免重复拉同一 run）
      for (const st of run.steps) {
        const rid = lastRunId(st)
        if (!rid || outputs[rid]) continue
        void (async () => {
          try {
            // ★ 用 messages 的最后一条 text——与任务详情页同一条规矩（run 对象的
            //   result 永远 null：executor 的 #finish 只把 result 发 SSE，不落库）
            const d = await api<{ messages: Array<{ type: string; content: string }> }>(
              `/api/runs/${rid}/messages`,
            )
            const texts = (d.messages ?? []).filter(
              (m) => m.type === 'text' && m.content.trim() !== '',
            )
            const last = texts.length > 0 ? texts[texts.length - 1]!.content : ''
            if (last) outputs = { ...outputs, [rid]: last }
          } catch {
            // 单步取数失败不阻塞整体刷新
          }
        })()
      }
      // loop 步骤：每轮执行 run 反查审查 run，再取审查意见正文
      for (const st of run.steps) {
        if (st.kind !== 'loop') continue
        for (const rid of st.runIds) {
          void (async () => {
            try {
              const reviewId = await findReviewRun(rid)
              if (!reviewId || reviewOutputs[reviewId]) return
              const d = await api<{ messages: Array<{ type: string; content: string }> }>(
                `/api/runs/${reviewId}/messages`,
              )
              const texts = (d.messages ?? []).filter(
                (m) => m.type === 'text' && m.content.trim() !== '',
              )
              const last = texts.length > 0 ? texts[texts.length - 1]!.content : ''
              if (last) reviewOutputs = { ...reviewOutputs, [reviewId]: last }
            } catch {
              // 单步取数失败不阻塞整体刷新
            }
          })()
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  /** gate 否决时人的意见（必填——打回理由，附加给 agent 重写）。 */
  let gateFeedback = ''
  let timer: ReturnType<typeof setInterval> | null = null
  onMount(() => {
    void refresh()
    // 执行画面"中途可看"：2s 轮询一次（run 状态 + 步骤链 + gate 挂起都要及时）
    timer = setInterval(() => void refresh(), 2000)
    return () => {
      if (timer) clearInterval(timer)
    }
  })

  /** gate 否决（带意见）：POST reject —— 引擎打回重跑（意见进下一轮任务）。 */
  async function rejectGate(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await api<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback: gateFeedback }),
      })
      gateFeedback = ''
      await refresh()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

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

</script>

<div class="wf-run-layout" class:embedded>
  <div class="detail-head">
    <div class="detail-sub">
      {#if !embedded}
        <button type="button" class="btn btn--ghost" onclick={() => go($wfReturn)}>
          {$t($wfReturn === 'workflows' ? 'workflows.runBack' : 'workflowruns.runBack')}
        </button>
      {/if}
      <h2>{issue?.title ?? runId.slice(0, 8)}</h2>
      <p class="hint">
        {#if run}
          <span class="badge {workflowRunStatusClass(run.status)}">
            {$t(workflowRunStatusKey(run.status))}
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
    <div class="skeleton"></div>
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
                    <span class="badge {workflowStepStatusClass(st.status)}">{$t(workflowStepStatusKey(st.status))}</span>
                    <span class="faint">{$t(workflowStepKindKey(st.kind))}</span>
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

      <!-- ══════════ 中：步骤输出流（每步最后输出）+ gate 面板 ══════════ -->
      <section class="wf-run-log">
        {#if run.steps.length === 0}
          <p class="hint">{$t('workflows.noRunYet')}</p>
        {:else}
          <ol class="wf-outputs">
            {#each [...run.steps].sort((a, b) => a.seq - b.seq) as st (st.seq)}
              <li class="wf-out {st.status === 'running' ? 'on' : ''}">
                <button type="button" class="wf-out-head" onclick={() => toggleStep(st.seq)}>
                  <span class="badge {workflowStepStatusClass(st.status)}">{$t(workflowStepStatusKey(st.status))}</span>
                  <span class="wf-out-title">{st.label}</span>
                  <span class="wf-out-run mono faint">{lastRunId(st) ? lastRunId(st)!.slice(-8) : ''}</span>
                  <span class="wf-out-toggle">
                    {expandedSeq === st.seq ? $t('workflows.collapse') : $t('workflows.expand')}
                  </span>
                </button>

                {#if st.status === 'waiting-human' && st.gateText}
                  <!-- ★ 2026-11（统一模型）确认面板：gate 卡与 loop 把关 gate
                     （loop 步骤本身挂着 waiting-human）共用同一块——人等确认，
                     否决必填意见（打回理由，附加给重写轮）。 -->
                  <article class="notice wf-gate">
                    <strong>{$t('workflows.stepWaitingHuman')}</strong>
                    <p>"{st.gateText}"</p>
                    <label class="field">
                      <span class="fs-sm faint">{$t('workflows.gateFeedbackLabel')}</span>
                      <textarea rows="2" bind:value={gateFeedback}></textarea>
                    </label>
                    <div class="detail-actions">
                      <button type="button" class="btn btn--primary" disabled={busy} onclick={() => void control('confirm')}>
                        {$t('workflows.confirm')}
                      </button>
                      <button
                        type="button"
                        class="btn btn--danger"
                        disabled={busy || gateFeedback.trim() === ''}
                        title={gateFeedback.trim() === '' ? $t('workflows.gateFeedbackLabel') : ''}
                        onclick={() => void rejectGate()}
                      >
                        {$t('workflows.gateReject')}
                      </button>
                    </div>
                  </article>
                {/if}
                {#if st.kind === 'gate' && st.gateText && st.status !== 'waiting-human'}
                  <!-- gate 步骤没有 run，无输出——只显示等待文案 -->
                  <div class="wf-out-body">
                    <p class="wf-out-gate">"{st.gateText}"</p>
                  </div>
                {:else if st.kind === 'loop'}
                  <!-- ★ 2026-11 每个 Agent 一个显示：loop 按轮拆成「写作员产出」
                       与「审查员意见」两块——每个 Agent 的输出独立成框（默认限高，
                       太长内部滚动），不再压成一个「评审返工」卡 -->
                  <ol class="wf-loop-rounds">
                    {#each st.runIds as rid (rid)}
                      <li class="wf-round">
                        <div class="wf-round-tag">{$t('workflows.loopWriter')}</div>
                        <div class="wf-round-box">{outputs[rid] ?? $t('workflows.stepWorking')}</div>
                        {#if !st.gateText}
                          <!-- ★ 2026-11（统一模型）：只有 agent 把关（带审核者）才有
                             审查员行；gate 把关（人在 loop 卡内确认）没有审查员——
                             显示"（审查中…）"是误导。 -->
                          <div class="wf-round-tag">{$t('workflows.loopReviewer')}</div>
                          <div class="wf-round-box">
                            {#if reviewRunIds[rid]}
                              {reviewOutputs[reviewRunIds[rid]!] ?? $t('workflows.loopReviewing')}
                            {:else}
                              <span class="faint">{$t('workflows.loopReviewing')}</span>
                            {/if}
                          </div>
                        {/if}
                      </li>
                    {/each}
                  </ol>
                {:else}
                  <div class="wf-out-body">
                    <p class="wf-out-text">
                      {stepOutput(st) ??
                        (st.status === 'running' || st.status === 'pending'
                          ? (st.kind === 'parallel' ? $t('workflows.parallelRunning') : $t('workflows.stepWorking'))
                          : $t('workflows.noOutput'))}
                    </p>
                  </div>
                {/if}

                {#if expandedSeq === st.seq && lastRunId(st)}
                  <div class="wf-out-log">
                    <RunLog runId={lastRunId(st)!} fill />
                  </div>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </section>

      <!-- ══════════ 右：工作目录树（按任务设定，各步同一目录） ══════════ -->
      <aside class="wf-workdir">
        <h4>{$t('workflows.workDirTitle')}</h4>
        {#if activeRunId}
          <WorkDirTree base={`/api/runs/${activeRunId}`} reloadKey={activeRunId} />
        {:else if run?.status === 'running' && currentStep?.kind === 'parallel'}
          <p class="hint">{$t('workflows.parallelRunning')}</p>
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
  /* ★ 主从形态（编排任务列表右栏，2026-11 使用者拍板"列表不该消失"）：右栏
     ~850px 放三栏，侧栏按 16-22rem 会把日志压到 ~150px——收窄侧栏到 11-14rem，
     日志回到 ~406px。整页形态（'workflows' 视图）不 embedded，保持 16-22rem。 */
  .embedded .wf-run-main {
    /* 11-13rem（minmax 在 fr 网格里优先取 max）：右栏窄容器里把宽度让给日志栏——
       2026-11 使用者："窗口太小了，只有一行"（原 11-14rem 时日志 ~406px） */
    grid-template-columns: minmax(11rem, 13rem) minmax(0, 1fr) minmax(11rem, 13rem);
  }
  .wf-steps {
    overflow-y: auto;
    padding-right: var(--sp-2);
  }
  /* ★ 2026-11 步骤输出流：每步一张卡（状态 + label + 最后输出），点卡头展开
     过程日志（RunLog）。卡与卡之间留空，flow 一览式往下走。 */
  .wf-outputs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .wf-out {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .wf-out.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .wf-out-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    /* ★ 2026-11 白底白字：app.css 的全局 `button` 默认 `color: var(--on-accent)`
       （accent 上的白字）——这里把背景换成透明但没设字色，卡头就变成
       "白底白字"（亮色主题下 --surface 是白的，使用者报的正是这个）。
       显式拉回主题文字色。 */
    color: var(--text);
    background: none;
    border: 0;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .wf-out-head:hover {
    background: var(--surface-hover);
  }
  .wf-out-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .wf-out-run {
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
  .wf-out-toggle {
    font-size: var(--fs-sm);
    color: var(--accent);
  }
  .wf-out-body {
    padding: 4px 12px 10px;
  }
  /* ★ 2026-11 每个 Agent 的输出**独立成框** + 默认限高（太长内部滚动）——
     使用者："缺一个框把每个 Agent 的输出隔开，默认高度也要做限制，
     展开太多不利于阅读整体"。所有步骤的输出统一走这个限高。
     使用者第二版反馈：框边界太浅看不清 → 外层框用 --line-strong、输出框
     加 --surface-2 浅灰底；标签颜色统一（不要写作员/审查员分色）；不要
     轮号显示（多轮靠外层框分隔）。 */
  .wf-out-text,
  .wf-out-gate {
    border: 1px solid var(--line);
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 6px 10px;
    max-height: 9rem;
    overflow-y: auto;
  }
  .wf-loop-rounds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wf-round {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    padding: 8px 10px;
  }
  .wf-round-tag {
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
  .wf-round-box {
    border: 1px solid var(--line);
    background: var(--surface-2);
    border-radius: var(--radius);
    padding: 6px 10px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-dim);
    font-size: var(--fs-sm);
    line-height: 1.5;
    max-height: 9rem;
    overflow-y: auto;
  }
  .wf-out-text,
  .wf-out-gate {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-dim);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .wf-out-gate {
    color: var(--text);
    font-style: italic;
  }
  /* ★ 2026-11 展开区：RunLog 的 fill 是 flex 链的中间环（flex:1 撑满、内部
     .log 自己滚）——这里必须是 flex column 容器 + 固定高度，链才不断。
     之前是块级 + 定高，链断 → RunLog 高度=内容高度，日志少就收缩成一行
     （使用者报"日志显示框又变一行"）。 */
  .wf-out-log {
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    height: 320px;
    min-height: 0;
  }
  .wf-run-log {
    /* ★ 2026-11：RunLog 的 fill 是 flex 链（flex:1 撑满、内部 .log 自己滚）——
       这里不是 flex 容器时链就断了，RunLog 高度=内容高度，日志少就收缩成
       一行（使用者："只有一行，根本看不到内容"）。补上 flex column，
       gate 面板 + RunLog 一起排；内容超高时外层照旧滚。 */
    display: flex;
    flex-direction: column;
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
    color: var(--bad);
    font-size: var(--fs-sm);
    margin-left: var(--sp-2);
  }
  .wf-workdir {
    border-left: 1px solid var(--line);
    padding-left: var(--sp-4);
    overflow-y: auto;
  }
  .wf-workdir h4 {
    margin: 0 0 var(--sp-2);
  }
</style>
