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
    runStatusKey,
    workflowRunStatusClass,
    workflowRunStatusKey,
    workflowStepStatusClass,
    workflowStepStatusKey,
    workflowStepKindKey,
  } from '../lib/run-status.ts'
  import { agents, issues } from '../lib/stores.ts'
  import { go } from '../lib/view.ts'
  import { buildCards, needsFetch } from '../lib/workflow-cards.ts'
  import CardNode from './workflow/CardNode.svelte'
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
   * 卡片树：每个步骤一棵（`buildCards` 是纯函数，有单测）。
   *
   * ⚠️ 视图**不再持有任何展开状态**——每张卡的展开/日志开关都在卡片自己里
   *   （`components/workflow/*Card.svelte`），视图只回答"有哪些卡"。
   *   上一版把状态放在这里的字典里，于是"点上面的卡、下面的卡跟着变"
   *   （使用者："把上面『把关循环』展开，下面多的卡片就不见了"）。
   */
  $: treeCards = (run?.steps ?? [])
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((st) =>
      buildCards(st, {
        // ⚠️ `buildCards` 会读 `st.rounds`（引擎记下的轮次结构，D134）——直接透传整个 step
        statusOf: (rid) => execStatuses[rid],
        outputOf: (rid) => outputs[rid],
        nameOf: (rid) => agentNameOfRun(rid),
        text: {
          stepWorking: $t('workflows.stepWorking'),
          noOutput: $t('workflows.noOutput'),
          loopReviewing: $t('workflows.loopReviewing'),
          stepWaitingHuman: $t('workflows.stepWaitingHuman'),
          roundTitle: (n) => $t('workflows.loopRound', { n: String(n) }),
          execMeta: (n) => $t('workflows.loopExecMeta', { n: String(n) }),
          guardMeta: (n) => $t('workflows.loopGuardMeta', { n: String(n) }),
          stageMeta: (i, total) => $t('workflows.stageMeta', { i: String(i), n: String(total) }),
          execLabel: $t('workflows.loopExecLabel'),
          guardLabel: $t('workflows.loopGuardLabel'),
        },
      }),
    )

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

  let timer: ReturnType<typeof setInterval> | null = null
  onMount(() => {
    void refresh()
    // 执行画面"中途可看"：2s 轮询一次（run 状态 + 步骤链 + gate 挂起都要及时）
    timer = setInterval(() => void refresh(), 2000)
    return () => {
      if (timer) clearInterval(timer)
    }
  })

  /**
   * gate 否决（带意见）：POST reject —— 引擎打回重跑（意见进下一轮任务）。
   *
   * ⚠️ 意见**由 GateCard 自己收**（组件局部状态），这里只负责发请求：
   *   卡片各管各的状态之后，视图手上没有"当前那句话"这种东西了。
   */
  async function rejectGate(feedback: string): Promise<void> {
    if (busy) return
    busy = true
    try {
      await api<{ run: WorkflowRun }>(`/api/workflow-runs/${runId}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
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
          <!--
            ★ 卡片树（2026-11 使用者："卡片模块化……也要支持卡片嵌套"）：
              · 这里只负责**按数据画树**（`treeCards`，纯函数 `buildCards` 拼好的）；
              · 每张卡的展开/收起、日志开关都在**卡片自己**里
                （`components/workflow/{Container,Run,Gate}Card.svelte`）。
            ⚠️ key 用节点自带的稳定 id（`step:seq` / `round:seq:i` / `run:<runId>`）——
              用下标会让卡片每 2 秒重建、展开状态每轮被重置。
          -->
          <div class="wf-outputs">
            {#each treeCards as card (card.key)}
              <CardNode
                node={card}
                gateBusy={busy}
                onconfirmGate={() => void control('confirm')}
                onrejectGate={(feedback) => void rejectGate(feedback)}
              />
            {/each}
          </div>
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
  /* 卡片本身的样子与状态在 `components/workflow/*Card.svelte`（各管各的）；
     这里只管"一串卡片之间的间距"。 */
  .wf-outputs {
    display: flex;
    flex-direction: column;
    gap: 8px;
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
