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
  import { agents, issues } from '../lib/stores.ts'
  import { go } from '../lib/view.ts'
  import {
    isRunTerminal,
    logExpanded,
    loopRounds,
    needsFetch,
    runCardBody,
    stepSummaryRunId,
  } from '../lib/workflow-cards.ts'
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

  /**
   * ★ 2026-11 每个 Agent 一个显示：loop 步骤按轮拆成「执行者 → 把关者」两行。
   *
   * ⚠️ 2026-11（S5，D125 收尾）：这里原来要靠 `subject`（type:'run' + id=执行 run）
   *   从全量 runs 列表**反查**那条审核 run——因为审核 run 当时**故意不进
   *   `step.runIds`**（它挂在被审 run 的调查链上）。
   *
   *   现在把关者就是**一次普通执行 run**，而且**记进 `step.runIds`**（顺带修掉了
   *   "把关那一步在运行画面上没有 run"）。于是这里的规则退化成最朴素的一条：
   *   **loop 的 runIds 是成对的**——`[执行1, 把关1, 执行2, 把关2, …]`（引擎在
   *   `while (attempt <= maxRounds)` 里先执行再把关）。不再有任何反查。
   */
  /**
   * 每个 run 的**状态**（`GET /api/runs/:id` 的 `status`）。
   *
   * ⚠️ 2026-11（使用者："loop 的审核 agent 显示不出来"那一次）：这张表的取值规则
   *   改过——原来只给"步骤里最后一个 runId"取，而且**取过就短路**，于是它是
   *   **死快照**：执行 run 在"它还最新"的那几拍被取成 `running`，把关 run 一提交它
   *   就不再刷新 ⇒ 而把关者那一行的条件是"执行 run 已 `completed`" ⇒ **永不成立**
   *   ⇒ 审核 agent 那一行永远不出现。
   *   现在：**按 run 取数、非终态继续刷**（判据见 `lib/workflow-cards.ts`）。
   */
  let execStatuses: Record<string, string> = {}
  /**
   * 每个 run 是哪个人跑的（`GET /api/runs/:id` 的 `agentId`）。
   *
   * ⚠️ 2026-11（S5）：loop 卡那两行的标题原来是**写死的**「写作员 / 审查员」——
   *   那两个词是当年"执行者 / 审核者"两角色的别名，而**角色已经退场**。现在按
   *   这条 run 真正的 agent 名字显示（取不到就退回通用说法，不编一个名字）。
   */
  let runAgentIds: Record<string, string> = {}

  function lastRunId(st: WorkflowStep): string | null {
    return st.runIds.length > 0 ? st.runIds[st.runIds.length - 1]! : null
  }

  /**
   * 一个步骤里**要画几个 agent 卡片**：loop 按轮（执行 / 把关）拆，并行/汇总
   * 每个子 run 一张，其它步骤就是它自己那一条 run。
   *
   * ⚠️ 使用者的要求（2026-11）："Agent 已启动在卡片中显示出来……不要 Agent 之间
   *   有依赖关系"。所以这里只回答"有哪些 run"，**不**回答"哪个能显示"——
   *   显示不显示由每条 run 自己的状态与产出决定（`runCardBody`），兄弟之间互不影响。
   */
  function agentRows(
    st: WorkflowStep,
  ): Array<{ runId: string; role: 'exec' | 'guard' | 'sub'; round: number }> {
    if (st.kind === 'loop') {
      return loopRounds(st.runIds).flatMap((r, i) => {
        const rows: Array<{ runId: string; role: 'exec' | 'guard' | 'sub'; round: number }> = [
          { runId: r.exec, role: 'exec', round: i },
        ]
        // 把关 run 一提交就上卡片——**不**等执行 run 的状态（那是跨 agent 的依赖）
        if (r.guard !== null) rows.push({ runId: r.guard, role: 'guard', round: i })
        return rows
      })
    }
    // ⚠️ `parallel` **每个分支各自一步**（引擎在分支里 nextStep），所以这里通常只有一条；
    //    留着这个分支是为了"一条步骤里挤了多条 run"的其它情形（历史数据）也能分开显示。
    if (st.kind === 'parallel' && st.runIds.length > 1) {
      return st.runIds.map((runId) => ({ runId, role: 'sub' as const, round: 0 }))
    }
    const rid = lastRunId(st)
    return rid === null ? [] : [{ runId: rid, role: 'sub', round: 0 }]
  }

  /** 一条 run 的卡片正文：原文 / 「（正在跑…）」/「（还没有产出）」。 */
  function runBody(runId: string, role: 'exec' | 'guard' | 'sub'): string {
    const kind = runCardBody(execStatuses[runId], outputs[runId])
    if (kind === 'text') return outputs[runId]!
    if (kind === 'running') {
      return role === 'guard' ? $t('workflows.loopReviewing') : $t('workflows.stepWorking')
    }
    return $t('workflows.noOutput')
  }

  /** 一条 run 的卡片标题：真 agent 名字；取不到就按角色退回通用说法（不编名字）。 */
  function runTitle(runId: string, role: 'exec' | 'guard' | 'sub'): string {
    const name = agentNameOfRun(runId)
    if (name !== null) return name
    if (role === 'guard') return $t('workflows.loopGuardLabel')
    if (role === 'exec') return $t('workflows.loopExecLabel')
    return runId.slice(-8)
  }
  function toggleStep(seq: number): void {
    expandedSeq = expandedSeq === seq ? null : seq
  }
  /**
   * 卡片标题上的「最后结果」摘要（使用者 2026-11：结果放标题上）。
   *
   * ⚠️ 取的是「**往下交的那份产出**」，不是"最后一条 run"：
   *   · loop 的 `runIds` 是 `[执行1, 把关1, 执行2, 把关2, …]`，最后一条是**把关者**
   *     ⇒ 用它会让卡头显示"通过 / 不通过"这种意见，而不是被交下去的产物。
   *     使用者原话："loop 如果成功，就应该显示写作者的输出。"
   *   · gate 没有 run ⇒ 显示等确认的那句文案。
   *   判据收在 `lib/workflow-cards.ts#stepSummaryRunId`（有单测）。
   */
  function resultSummary(st: WorkflowStep): string {
    if (st.kind === 'gate') return `"${st.gateText ?? ''}"`
    const rid = stepSummaryRunId(st)
    if (rid === null) return $t('workflows.stepWorking')
    const out = outputs[rid]
    if (out === undefined || out.trim() === '') {
      return isRunTerminal(execStatuses[rid]) ? $t('workflows.noOutput') : $t('workflows.stepWorking')
    }
    const first = (out.split('\n')[0] ?? '').trim()
    return first.length > 72 ? `${first.slice(0, 72)}…` : first
  }

  /**
   * 日志展开状态：**每条 run 一个**（使用者："并行多个 Agent 的时候，我可以分开查看其日志"）。
   *
   * `undefined` = 人没动过 ⇒ 按默认（**正在跑的那条自动展开**，跑完自动收起）。
   * 人点过之后一直是那个状态：2s 轮询刷新不会把它收回去。
   */
  let openLogs: Record<string, boolean> = {}
  function isLogOpen(runId: string): boolean {
    return logExpanded(openLogs[runId], execStatuses[runId])
  }
  function toggleRunLog(runId: string): void {
    openLogs = { ...openLogs, [runId]: !isLogOpen(runId) }
  }
  /** 展开态：手动展开（expandedSeq）优先；默认运行中/等确认自动展开，执行完收起。 */
  function isExpanded(st: WorkflowStep): boolean {
    if (expandedSeq === st.seq) return true
    return expandedSeq === null && (st.status === 'running' || st.status === 'waiting-human')
  }

  /** 某个 run 是哪个 agent 跑的（找不到就 null——调用方退回通用说法）。 */
  function agentNameOfRun(rid: string | null): string | null {
    if (rid === null) return null
    const id = runAgentIds[rid]
    if (id === undefined) return null
    return $agents.find((a) => a.id === id)?.name ?? null
  }

  async function refresh(): Promise<void> {
    try {
      const out = await api<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}`)
      run = out.run
      error = ''
      /**
       * 每个 run 的状态 + 产出：**按 run 取**，判据在 `lib/workflow-cards.ts#needsFetch`。
       *
       * 使用者 2026-11 定的模型："Agent 已启动在卡片中显示出来，一直接受文字消息
       * 并显示，直到最后结束。不要 Agent 之间有依赖关系。" 落到实处就是这三条：
       *
       *   · **取所有 runId**（不是只有最后一个）——loop 的 `[执行1, 把关1, 执行2, …]`
       *     每一步都要有数，否则前面几轮的卡片永远是空的；
       *   · **非终态就继续刷**——文字是一直长出来的，取一次就停等于把实时显示变成快照；
       *   · **终态且已有产出就不再拉**（跑完的产出不会变），只在"终态但还没有产出"时补一次。
       *
       * ⚠️ 两条取数**必须一起做**：只看产出判"要不要取数"是老 bug 的一半
       *   （产出缓存住之后状态就再也不加载，把关者那一行永远等不到 `completed`）。
       */
      const seen = new Set<string>()
      for (const st of run.steps) {
        for (const rid of st.runIds) {
          if (seen.has(rid)) continue
          seen.add(rid)
          if (!needsFetch(execStatuses[rid], outputs[rid] !== undefined)) continue
          void (async () => {
            try {
              // ⚠️ GET /api/runs/<id> 返回 run 对象**本身**（不是 { run } 包装）
              const d = await api<{ status: string; agentId?: string }>(`/api/runs/${rid}`)
              execStatuses = { ...execStatuses, [rid]: d.status }
              if (typeof d.agentId === 'string') {
                runAgentIds = { ...runAgentIds, [rid]: d.agentId }
              }
              // ★ 用 messages 的最后一条 text——与任务详情页同一条规矩（run 对象的
              //   result 永远 null：executor 的 #finish 只把 result 发 SSE，不落库）
              const m = await api<{ messages: Array<{ type: string; content: string }> }>(
                `/api/runs/${rid}/messages`,
              )
              const texts = (m.messages ?? []).filter(
                (x) => x.type === 'text' && x.content.trim() !== '',
              )
              const last = texts.length > 0 ? texts[texts.length - 1]!.content : ''
              if (last) outputs = { ...outputs, [rid]: last }
            } catch {
              // 单条 run 取数失败不阻塞整体刷新（下一拍会重试——非终态仍在 needsFetch 里）
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
      <!--
        ⚠️ 2026-11（D132）：这里原来按 `wfReturn` 决定回哪儿（定义页 or「编排任务」页）。
        那一页删掉之后，整页形态只剩"从编排定义页进来"这一种 ⇒ 返回恒回「编排」页；
        embedded 形态（任务页里）本来就不画返回按钮。
      -->
      {#if !embedded}
        <button type="button" class="btn btn--ghost" onclick={() => go('workflows')}>
          {$t('workflows.runBack')}
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
                  <!--
                    ★ 2026-11 使用者："比如执行 LOOP，当前的卡片就看不出来是 LOOP"。
                    卡头原来只有**状态**（完成 / 进行中），看不出这一步是哪种原语。
                    加一个**类型**小标签：与状态徽标刻意长得不一样（状态彩色带圆点、
                    类型灰框无圆点），否则会被读成"把关循环是一种状态"。
                  -->
                  <span class="wf-out-kind">{$t(workflowStepKindKey(st.kind))}</span>
                  <span class="wf-out-title">
                    {st.label}
                    <span class="wf-out-result">— {resultSummary(st)}</span>
                  </span>
                  <span class="wf-out-run mono faint">{lastRunId(st) ? lastRunId(st)!.slice(-8) : ''}</span>
                  <span class="wf-out-toggle">
                    {isExpanded(st) ? '▾ ' + $t('workflows.collapse') : '▸ ' + $t('workflows.expand')}
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
                {#if !isExpanded(st)}
                  <!-- 收起态：正文不显示（标题已带最后结果） -->
                {:else if st.kind === 'gate' && st.gateText && st.status !== 'waiting-human'}
                  <!-- gate 步骤没有 run，无输出——只显示等待文案 -->
                  <div class="wf-out-body">
                    <p class="wf-out-gate">"{st.gateText}"</p>
                  </div>
                {:else}
                  <!--
                    ══ 每个 run 一张卡片（2026-11 使用者定稿）══
                    "Agent 已启动在卡片中显示出来，一直接受文字消息并显示，直到最后结束。
                     不要 Agent 之间有依赖关系，这样就不存在相互影响。"

                    所以这里**不再有跨 run 的条件**（原来 loop 的把关者行要等"执行 run
                    已 completed"，那是 Agent 之间的依赖，也正是审核 agent 一直显示不出来
                    的那一半原因）：

                      · 画哪些行 —— `agentRows(st)`：loop 按轮拆（执行 / 把关），并行与汇总
                        每个子 run 一行，其它步骤就它自己那一条；
                      · 每行画什么 —— `runBody(runId, role)`：**只看这条 run 自己**的
                        状态与产出（有文字画文字；非终态还没吐字画「（正在跑…）」；
                        终态且确实没有才画「（还没有产出）」）；
                      · 名字 —— 这条 run 真正的 agent 名字，取不到按角色退回通用说法。
                  -->
                  {#if agentRows(st).length === 0}
                    <!-- gate 这类"没有 run"的步骤：正文就是那句等确认的文案（不画空列表） -->
                    <div class="wf-out-body">
                      <p class="wf-out-gate">"{st.gateText ?? ''}"</p>
                    </div>
                  {:else}
                  <ol class="wf-loop-rounds">
                    {#each agentRows(st) as row (row.runId)}
                      <li class="wf-round">
                        <div class="wf-round-head">
                          <div class="wf-round-tag">
                            <!-- 这是**这条 run** 的状态（不是步骤的）——用 run 那一族词条 -->
                            <span class="badge {workflowRunStatusClass(execStatuses[row.runId] ?? '')}">
                              {$t(workflowRunStatusKey(execStatuses[row.runId] ?? 'queued'))}
                            </span>
                            <span class="wf-round-name">{runTitle(row.runId, row.role)}</span>
                            {#if row.role === 'guard'}
                              <span class="faint">{$t('workflows.loopGuardMeta', { n: String(row.round + 1) })}</span>
                            {:else if row.role === 'exec'}
                              <span class="faint">{$t('workflows.loopExecMeta', { n: String(row.round + 1) })}</span>
                            {/if}
                          </div>
                          <!--
                            ★ 2026-11 使用者："卡片内部右上角有一个按钮来决定是否要展开日志……
                              这样并行多个 Agent 的时候，我可以分开查看其日志。"
                            每颗按钮只管**这一条 run**（`toggleRunLog(row.runId)`），
                            展开状态也按 run 存（`openLogs`）——两个 Agent 互不影响。
                          -->
                          <button
                            type="button"
                            class="btn btn--ghost btn--sm"
                            onclick={() => toggleRunLog(row.runId)}
                          >
                            {isLogOpen(row.runId) ? '▾ ' : '▸ '}{$t('workflows.log')}
                          </button>
                        </div>
                        <div class="wf-round-box">{runBody(row.runId, row.role)}</div>
                        {#if isLogOpen(row.runId)}
                          <!-- 只有**展开了**才挂 RunLog：没展开就不发那一路 SSE -->
                          <div class="wf-round-log">
                            <RunLog runId={row.runId} fill />
                          </div>
                        {/if}
                      </li>
                    {/each}
                  </ol>
                  {/if}
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
  .wf-out-result {
    color: var(--text-faint);
    font-weight: 400;
  }

  .wf-out-run {
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
  /* 步骤**类型**标签：灰框、无圆点——与彩色带点的状态徽标分开两种信息 */
  .wf-out-kind {
    flex: 0 0 auto;
    font-size: var(--fs-2xs);
    color: var(--text-dim);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 0 var(--sp-1) 0;
    font-size: var(--fs-2xs);
    white-space: nowrap;
  }
  .wf-round-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .wf-round-log {
    margin-top: 4px;
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
