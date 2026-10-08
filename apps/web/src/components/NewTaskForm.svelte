<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, newRunId, type Issue } from '../lib/api.ts'
  import {
    agents,
    effectiveDefaultAgentId,
    groups,
    identity,
    loadIssues,
    loadRuns,
    tools,
  } from '../lib/stores.ts'
  import { groupExecutor, resolveNewTaskChain } from '../lib/newtask-chain.ts'
  import { splitRequest } from '../lib/request-text.ts'
  import { createDirty } from '../lib/create-draft.ts'
  import { go, selectedIssueId, showToast } from '../lib/view.ts'
  import { t, tx } from '../lib/i18n.ts'

  /**
   * 新建任务的那张表单（2026-10 简化版）。
   *
   * ⚠️ 它是「任务」页右栏里的一个状态，不再是独立一页。容器（右栏、可滚区、
   *    窄屏下"占满一栏 + 返回"）由 `views/Tasks.svelte` 提供；这一份只管表单本身。
   *
   * ══════════════════════════════════════════════════════════════════
   * 2026-10 简化（使用者拍板）：从「三步链」改成「直接指定」
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来的「执行 → 审核 → 行动」三步链 + 返工下拉 + 各类"只对这一次"的覆盖
   * （换人审 / 不审、动作白名单勾选、固定参数、任务级返工）**全部去掉**。
   * 现在这一页只问两件事：
   *
   *   · **要做什么**（一个多行框，第一行当标题）；
   *   · **交给谁**——一个智能体（执行者）或一个智能体组（互斥切换）。
   *
   * 选中之后显示一行**摘要**（执行者 / 审核者 / 允许的动作 / 返工），告诉使用者
   * 这次任务实际会怎么走。两档的后果**不一样**，这正是摘要要说的：
   *
   *   · 选**智能体组** ⇒ 提交 `groupId`，整条链由 daemon 按组的默认展开
   *     （审核者 / 动作 / 返工都是组的）——这是**唯一**会有人审的选法；
   *   · 选**单个智能体** ⇒ 提交 `agentRef`，一个覆盖字段都不带：这条任务
   *     **没有审核者**（2026-10：`Agent.reviewerAgentId` 撤掉之后，"选个人"
   *     这条路上已经没有"由谁来审它"可跟随了；组才是审核者的出处）。
   *
   * 摘要里的推导仍然走 `lib/newtask-chain.ts`（纯函数、有单测）——`choice` 恒为
   * **不点名**（没有其它档位了）。**推导不在这一页里写第二遍**。
   */
  type TaskSource = 'agent' | 'group'

  let title = ''
  let workDir = ''
  /** 交给谁：智能体 或 智能体组（互斥；只有存在启用的组时才给「组」这一档）。 */
  let source: TaskSource = 'agent'
  let agentId = ''
  let groupId = ''
  let busy = false
  let error = ''

  /** ★ 这个 daemon 认不认 `groupId`（组展开）。不认就不给「智能体组」那一档。 */
  $: groupSupported = ($identity?.capabilities ?? []).includes('agent-groups')
  /** 启用的组（停用 = 新建任务时不可选，见 `AgentGroup.enabled`）。 */
  $: enabledGroups = groupSupported ? $groups.filter((g) => g.enabled) : []
  $: groupTabVisible = groupSupported && enabledGroups.length > 0

  /** 执行者候选：全局池里 `role === 'executor'`（审核者不接任务）。 */
  $: executorAgents = $agents.filter((a) => a.role === 'executor')
  // 没选过执行者时，初值 = 生效中的默认（没有就用列表第一个）。
  $: if (!agentId && executorAgents.length > 0) {
    agentId = $effectiveDefaultAgentId ?? executorAgents[0]!.id
  }
  $: chosen = executorAgents.find((a) => a.id === agentId) ?? null

  $: chosenGroup = groupId ? ($groups.find((g) => g.id === groupId) ?? null) : null
  $: groupExec = chosenGroup ? groupExecutor(chosenGroup.memberAgents) : null
  /** 组的审核者：执行者之外的另一个成员（id 即使指向已删的人也要带出来——好报「人没了」）。 */
  $: groupReviewerId = chosenGroup
    ? (chosenGroup.memberAgents.find((m) => m.id !== groupExec?.id)?.id ?? '')
    : ''
  $: groupChainDefaults = chosenGroup
    ? {
        members: chosenGroup.memberAgents,
        reviewerId: groupReviewerId || null,
        allowedActions: chosenGroup.allowedActions,
        actionParams: chosenGroup.actionParams,
        maxReworks: chosenGroup.maxReworks,
      }
    : null

  /** 这次真正会去执行的那个（组模式 = 组的执行者）。 */
  $: executor = source === 'group' ? groupExec : chosen
  /** 摘要要显示的执行者名字；`null` = 还没选好（没选组 / 组坏了 / 没有执行者）。 */
  $: executorName = executor?.name ?? null

  /**
   * 链的推导：不再有"这一次的覆盖"，`choice` 恒为**不点名**——
   * 选组 ⇒ 组的审核者；选智能体 ⇒ **没有审核者**（2026-10：agent 上那条
   * 「由谁来审它」撤掉了，所以"选个人"这条路上谁也不审，摘要必须说出来）。
   * 摘要要显示的审核者 / 动作数就从这一条链取。
   */
  $: chain = resolveNewTaskChain({
    executor,
    choice: { mode: 'default' },
    agents: $agents,
    tools: $tools,
    group: source === 'group' ? groupChainDefaults : null,
  })

  /** 摘要：允许的动作数（含"配过、但当前解析不出定义"的——那也算这一次的配置）。 */
  $: actionCount = chain.actions.length + chain.unavailableActions.length

  type ReworkSummary = { kind: 'zero' } | { kind: 'times'; n: number } | { kind: 'unlimited' }
  /** 摘要：返工。组模式 = 组的默认；选智能体 = 不返工（daemon 对省略的默认 0）。 */
  let reworkSummary: ReworkSummary = { kind: 'zero' }
  $: reworkSummary =
    source === 'group' && chosenGroup
      ? chosenGroup.maxReworks === null
        ? { kind: 'unlimited' }
        : chosenGroup.maxReworks > 0
          ? { kind: 'times', n: chosenGroup.maxReworks }
          : { kind: 'zero' }
      : { kind: 'zero' }

  type ReviewerSummary =
    | { kind: 'name'; name: string }
    | { kind: 'gone' }
    /** ★ 选了单个智能体 ⇒ **这条任务不会被审**（必须画出来，见词条里的理由）。 */
    | { kind: 'no-group' }
    | { kind: 'none' }
  /**
   * 摘要：审核者这一行怎么显示（谁审 / 人没了 / 不会审 / 不画）。
   *
   * ⚠️ 2026-10：`not_configured` 这一档**从"不画"改成了"画出来"**。原来它是
   *    "执行者没配「由谁来审它」"（一种少见的配置缺失），不画那一行是合理的；
   *    现在它是**选单个智能体的必然结果**——不画的话，使用者看到的摘要与选组那条
   *    只差一行，而那一行恰恰是"你的产出不会有人看"。**没有任何地方会报错。**
   */
  let reviewerSummary: ReviewerSummary = { kind: 'none' }
  $: reviewerSummary = chain.reviewer
    ? { kind: 'name', name: chain.reviewer.name }
    : chain.notReviewing === 'dangling'
      ? { kind: 'gone' }
      : chain.notReviewing === 'not_configured'
        ? { kind: 'no-group' }
        : { kind: 'none' }

  /**
   * 「要做什么」那个框：**默认 3 行，写多了自己长高，到 15 行封顶**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么要长高，而不是给个固定高度
   * ══════════════════════════════════════════════════════════════════
   *
   * 这一页只有**一个**输入框，任务写长了（多段、带步骤、贴一段日志）是很正常
   * 的事。固定高度只有两种下场：给矮了——写第四行时就得在一个三行的小窗里滚动，
   * 看不到自己刚写的；给高了——空着的时候占掉小半屏。
   *
   * 所以：3 行起步，随输入长高，**15 行封顶**（再多就自己滚——一个框吃掉整屏
   * 会让"提交"又跑到屏幕外）。
   *
   * ⚠️ 高度由 JS 设成 `scrollHeight`，上限交给 CSS 的 `max-height`（`lh` 单位
   *    算的 15 行）——两处都算一遍行高，迟早对不上（字号一改就分叉）。
   *    超上限时 `scrollHeight > max-height`，于是 `overflow-y` 切成 `auto`。
   */
  const TITLE_ROWS = 3
  const TITLE_MAX_ROWS = 15

  function autoGrow(
    node: HTMLTextAreaElement,
    _dep: unknown,
  ): { update: () => void; destroy: () => void } {
    const fit = (): void => {
      node.style.height = 'auto'
      const cs = getComputedStyle(node)
      const line = Number.parseFloat(cs.lineHeight) || 20
      const chrome =
        Number.parseFloat(cs.paddingTop) +
        Number.parseFloat(cs.paddingBottom) +
        Number.parseFloat(cs.borderTopWidth) +
        Number.parseFloat(cs.borderBottomWidth)
      const max = line * TITLE_MAX_ROWS + chrome
      const want = node.scrollHeight
      node.style.height = `${Math.min(want, max)}px`
      node.style.overflowY = want > max ? 'auto' : 'hidden'
    }
    node.addEventListener('input', fit)
    fit()
    return {
      // 参数是 `title`：**清空表单、粘贴、程序化改值**都要重新量一次
      // （只监听 `input` 会漏掉这些——它们的症状是"框里字很多，但框还是三行高"）。
      update: fit,
      destroy: () => node.removeEventListener('input', fit),
    }
  }

  function onTitleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    ;(event.currentTarget as HTMLTextAreaElement).closest('form')?.requestSubmit()
  }

  /**
   * ★ 填过没有 —— 上报给外面（见 `lib/create-draft.ts` 里那段"为什么是 store"）。
   *
   * 判据是"手上有过东西"，不是"和默认值不一样"：默认值本身会变（智能体列表轮询
   * 刷新、默认智能体在别处被改），拿它们做基准的话，使用者**什么都没做**也会被
   * 判成"脏"，于是每次切页都白问一句。
   *
   * 简化版里"手上有过东西"= 写了任务 / 填了工作目录 / 切换过来源 / 换过选择。
   */
  $: createDirty.set(
    title.trim() !== '' ||
      workDir.trim() !== '' ||
      (source === 'group' ? groupId !== '' : agentId !== ($effectiveDefaultAgentId ?? executorAgents[0]?.id ?? '')),
  )

  // 离开这一栏（提交成功、或者被切走）时把标记放掉：它是**这一张表单**的状态，
  // 表单没了它还留着的话，下一次进来会一开始就"脏"。
  onDestroy(() => createDirty.set(false))

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = ''
    const trimmed = title.trim()
    if (!trimmed) return
    const { issueTitle, issueDescription } = splitRequest(trimmed)

    if (source === 'group' && !groupId) {
      error = tx('newtask.groupPickRequired')
      return
    }
    const agent = executor
    if (!agent) {
      error = source === 'group' ? tx('newtask.groupBroken') : tx('newtask.noAgents')
      return
    }

    busy = true
    try {
      const issue = await api<Issue>('/api/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: issueTitle,
          description: issueDescription,
          assignee: { type: 'agent', id: agent.id },
        }),
      })

      // 建完立刻派一次执行——"建任务"的意图本来就是"让 agent 去做"，
      // 再让使用者点一次"跑一次"是多余的一步。
      const runId = newRunId()
      await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
          // ★ **不传 skills** —— 让 daemon 按这个 agent 的配置解析。
          //   这里原来硬编码 `skills: []`，后果是一个 skill 也没注入、
          //   Claude 用回它自己的默认行为，而 run 状态还是 completed。
          //   "审核标准由 skill 决定"是这个产品的核心，那条路径等于把它关掉了。
          subject: { type: 'issue', id: issue.id },
          // ★ 全文进 prompt（**不切**）：执行者要看到使用者写的每一个字。
          //   切分只影响"记录里怎么存"，不影响"agent 看到什么"。
          prompt: trimmed,
          // 只有真的填了才带这个字段：空字符串与"没指定"是两件事
          ...(workDir.trim() ? { workDir: workDir.trim() } : {}),
          // ★★ 简化版（2026-10）：**一个覆盖字段都不带**——
          //   选组 ⇒ 只带 `groupId`，审核者 / 动作 / 返工由 daemon 按组展开；
          //   选智能体 ⇒ 什么都不带，全部跟随执行者的长期配置（省略 = 跟随）。
          //   ⚠️ 组模式下 `agentRef` 就是组的执行者（daemon 校验
          //     `group_executor_mismatch`，所以这里不用再锁一遍）。
          ...(source === 'group' && groupId ? { groupId } : {}),
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      title = ''
      await Promise.all([loadIssues(), loadRuns()])
      // 切到任务清单并选中它——跳过这一步的话，使用者提交后停在原地，
      // 不知道到底成没成
      selectedIssueId.set(issue.id)
      go('tasks')
      showToast(tx('newtask.createdToast'))
    } catch (err) {
      // 服务端校验的**原文**就这样显示出来——这一页**不重写**服务端的错误，
      // 也不翻译成自己的说法：判据分两处写就会分叉，而分叉的表现是
      // "页面放行、服务端拒绝"——使用者点了提交，界面上却什么都没说。
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<!--
  ⚠️ 这一页**主区里没有页头**（2026-09）：标题在顶栏，副标题按要求去掉。
-->

<!--
  ══════════════════════════════════════════════════════════════════
  `.form-frame`：右栏里的容器（内边距 + 提交栏吸底用的负边距基准）
  ══════════════════════════════════════════════════════════════════

  D58 之后这一页住在「任务」页右栏（`views/Tasks.svelte` 的 `.create-body`，
  它定义 `--create-pad-x`）。`.form-frame` 提供左右内边距；提交栏靠负边距
  拉满整栏宽并吸底（`position: sticky; bottom: 0`），负边距的量就是
  `--create-pad-x`——所以它必须与外面那层的内边距一致。

  ⚠️ 简化版（2026-10）表单只剩一列，不再需要原来的两列网格 / `@container`
  断点——那些排版规则随着「执行→审核→行动」三步一起删掉了。
-->
<div class="form-frame">
<form onsubmit={submit} class="newtask-form">
  <!--
    ══════════════════════════════════════════════════════════════════
    一个问题，不是一个标题 + 一段补充说明
    ══════════════════════════════════════════════════════════════════

    ★ 原来这里是两个字段：「要做什么」是一个**单行** `input`，「补充说明」是一个
      4 行 textarea。两件事都不对：

      ① 单行框装不下真正要说的东西。使用者一按回车就提交了（表单里 `input` 的
         回车就是提交），而他想换行；写得长一点只能横着滚，看不到全句。
      ② "标题 + 补充说明"这个二分**是平台的分法，不是使用者的**。他要说的是
         "帮我做这件事"，至于哪半句算标题是**记录格式**的事——把一个格式问题
         摆成两个输入框，等于让他先做一次分类，而分类错了没有任何提示。

    所以：**一个多行框**装下全部内容。派发时按第一行切出 `Issue.title`
    （任务清单要一行标题），全文进 `prompt`，剩下的行进 `Issue.description`
    （见 `submit()`）。切分是**平台的**责任，不再是使用者要回答的问题。

    ⚠️ 回车键：`textarea` 里回车是换行（不是提交）。提交仍然是那个按钮 +
       `Ctrl/Cmd+Enter`（见下面的 `onkeydown`）——这是"多行框"必须配的一件事。
  -->
  <div class="form-lead">
    <label>
      {$t('newtask.titleLabel')}
      <textarea
        bind:value={title}
        use:autoGrow={title}
        rows={TITLE_ROWS}
        required
        autocomplete="off"
        placeholder={$t('newtask.titlePlaceholder')}
        onkeydown={onTitleKeydown}
      ></textarea>
      <span class="hint">{$t('newtask.titleSplitHint')}</span>
    </label>
  </div>

  <!-- ══════════════════ 交给谁 ══════════════════ -->
  <section class="pick-card">
    <span class="card-title">{$t('newtask.pickTitle')}</span>

    <!--
      ★ 智能体 / 智能体组 互斥切换（只有存在**启用的组**、且 daemon 认 `groupId`
        时才给「组」这一档——旧 daemon 会静默忽略那个字段，给了就成"选了组、
        实际什么都没发生"，两边都不报错）。
    -->
    {#if groupTabVisible}
      <div class="source-toggle">
        <button
          type="button"
          class:active={source === 'agent'}
          onclick={() => (source = 'agent')}
        >
          {$t('newtask.sourceAgent')}
        </button>
        <button
          type="button"
          class:active={source === 'group'}
          onclick={() => (source = 'group')}
        >
          {$t('newtask.sourceGroup')}
        </button>
      </div>
    {/if}

    {#if source === 'group'}
      <label>
        {$t('newtask.groupLabel')}
        <select bind:value={groupId}>
          <!-- 占位不可选：进「组」这一档就必须选一个组（想回去就切回「智能体」）。 -->
          <option value="" disabled>{$t('newtask.groupPickPlaceholder')}</option>
          {#each enabledGroups as g (g.id)}
            <option value={g.id}>{g.name}</option>
          {/each}
        </select>
      </label>
      {#if groupId === ''}
        <p class="hint">{$t('newtask.groupPickRequired')}</p>
      {:else if chosenGroup && !groupExec}
        <p class="hint warn">{$t('newtask.groupBroken')}</p>
      {/if}
    {:else}
      <label>
        {$t('newtask.agentLabel')}
        {#if executorAgents.length === 0}
          <!-- 只有审核者时要说清楚为什么没人可选，而不是给一个空下拉 -->
          <select disabled><option>{$t('newtask.noExecutorOption')}</option></select>
          <span class="hint">
            {$t('newtask.createExecutorBefore')}<strong>{$t('newtask.executorStrong')}</strong>{$t('newtask.createExecutorAfter1')}
            {$t('newtask.createExecutorAfter2')}
          </span>
        {:else}
          <select bind:value={agentId}>
            {#each executorAgents as a (a.id)}
              <option value={a.id}>
                {a.name}{a.id === $effectiveDefaultAgentId ? $t('newtask.defaultSuffix') : ''}
              </option>
            {/each}
          </select>
          <span class="hint">
            {$t('newtask.defaultHint')}
          </span>
        {/if}
      </label>
    {/if}
  </section>

  <!--
    ══════════════════════════════════════════════════════════════════
    摘要（选中后显示，只读）：这次任务实际会怎么走
    ══════════════════════════════════════════════════════════════════

    简化版的契约：选了**谁**，这一栏就说**那一次会怎么走**——全部来自长期配置
    或组的默认，界面上没有可改的项。四行：执行者 / 审核者 / 允许的动作 / 返工。

    ★ 2026-10（使用者拍板「摘要变干净」）：**空行不画**——没有配审核者就不画
      「审核者」那行（否则每选一个没配审核的执行者都跳出一行"未配置"，看着像
      bug）；一个动作都没配就不画「允许的动作」那行。**选智能体不画「返工」行**
      （返工是组专属的设置——只有组能配返工次数，单智能体恒为不返工，画出来
      只是噪音）。只有真实存在的东西才占行。
      ⚠️ 唯独「人没了」(`gone`)必须画——那是有事要说的状态，不能藏。

    ★ 2026-10 标题：随选中对象走（智能体摘要 / 智能体组摘要），并加粗。

    ⚠️ 推导全在 `lib/newtask-chain.ts` 里（纯函数、有单测），这一页只读结果。
  -->
  {#if executorName}
    <section class="summary-card">
      <span class="summary-title">
        {$t(source === 'group' ? 'newtask.summaryTitleGroup' : 'newtask.summaryTitleAgent')}
      </span>
      <dl class="summary-grid">
        <dt>{$t('newtask.summaryExecutor')}</dt>
        <dd>{executorName}</dd>

        {#if reviewerSummary.kind !== 'none'}
          <dt>{$t('newtask.summaryReviewer')}</dt>
          <dd>
            {#if reviewerSummary.kind === 'name'}
              {reviewerSummary.name}
            {:else if reviewerSummary.kind === 'gone'}
              <span class="warn">{$t('newtask.summaryReviewerGone')}</span>
            {:else if reviewerSummary.kind === 'no-group'}
              <span class="warn">{$t('newtask.summaryReviewerAgentPath')}</span>
            {/if}
          </dd>
        {/if}

        {#if actionCount > 0}
          <dt>{$t('newtask.summaryActions')}</dt>
          <dd>{$t('newtask.summaryActionsValue', { n: actionCount })}</dd>
        {/if}

        {#if source === 'group'}
          <dt>{$t('newtask.summaryRework')}</dt>
          <dd>
            {#if reworkSummary.kind === 'unlimited'}
              {$t('newtask.summaryReworkUnlimited')}
            {:else if reworkSummary.kind === 'times'}
              {$t('newtask.summaryReworkTimes', { n: reworkSummary.n })}
            {:else}
              {$t('newtask.summaryReworkZero')}
            {/if}
          </dd>
        {/if}
      </dl>
    </section>
  {/if}

  <!-- 高级：工作目录。默认**不需要填**（D27）——收起来，不该出现在必经之路上。 -->
  <details class="form-advanced">
    <summary class="hint" style="cursor:pointer">{$t('newtask.advancedSummary')}</summary>
    <label style="margin-top:var(--sp-3)">
      {$t('newtask.workDirLabel')}
      <input bind:value={workDir} placeholder={$t('newtask.workDirPlaceholder')} />
    </label>
    <p class="hint">
      {$t('newtask.workDirHintBefore')}<strong>{$t('newtask.workDirHintStrong')}</strong>{$t('newtask.workDirHintAfter1')}
      {$t('newtask.workDirHintAfter2')}
      {$t('newtask.workDirHintAfter3')}
    </p>
  </details>

  <!--
    ══════════════════════════════════════════════════════════════════════
    提交栏：**吸底**
    ══════════════════════════════════════════════════════════════════════

    ★ 它跟着视口走：无论滚到哪，按钮都在。错误提示也搬进这一栏（提交失败必须
      在按钮旁边看得见——不然使用者点一下、没反应，再点一下）。

    ★ 右边那一行是"我即将提交的是什么"：交给谁、谁审、允许几个动作。滚下去看
      高级选项时，它是唯一还在的上下文。
  -->
  <div class="form-foot">
    {#if error}
      <div class="notice bad">{error}</div>
    {/if}
    <div class="foot-row">
      <button
        type="submit"
        disabled={busy || !title.trim() || !executorName}
        title={busy || !title.trim() || !executorName ? $t('newtask.submitNotReady') : undefined}
      >
        {busy ? $t('newtask.creating') : $t('newtask.createAndDispatch')}
      </button>
      {#if executorName}
        <span class="foot-summary">
          {$t('newtask.footExecutor', { name: executorName })}
          <span class="foot-sep">·</span>
          {#if chain.reviewer}
            {$t('newtask.footReviewer', { name: chain.reviewer.name })}
          {:else}
            {$t('newtask.footReviewerNone')}
          {/if}
          <span class="foot-sep">·</span>
          {$t('newtask.footActions', { n: actionCount })}
        </span>
      {/if}
    </div>
  </div>
</form>
</div>

<style>
  /* 右栏里的容器：左右内边距 = `--create-pad-x`（由外面 `.create-body` 定义）。
     简化版是一列到底，不再需要两列网格 / `@container` 断点。 */
  .form-frame {
    width: 100%;
    min-width: 0;
    padding: var(--sp-5) var(--create-pad-x, var(--sp-6));
  }

  /* 简化版：一列到底（标题 / 交给谁 / 摘要 / 高级 / 提交栏），宽度全部拉通。 */
  .newtask-form {
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  /* 「要做什么」：整行，一个框占满；3 行起、15 行封顶（见 `autoGrow()`）。 */
  .form-lead {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-4);
    align-items: start;
  }
  .form-lead > label {
    max-width: none;
    margin-bottom: 0;
  }
  .form-lead textarea {
    resize: none;
    max-height: calc(15lh + 1.6rem);
  }

  /* 卡片：交给谁 / 摘要（与组表单的成员卡同一套视觉） */
  .pick-card,
  .summary-card {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: 0;
    padding: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .pick-card label {
    max-width: 30rem;
  }
  /* ★ 占位「（选一个组）」的字色：select 文字**显式**设成正文色——不然部分
     浏览器把禁用占位 option 渲染成浅色（白字），看不清选没选（与组表单同款修法）。 */
  .pick-card select {
    color: var(--text);
  }
  .pick-card select option[value=''][disabled] {
    color: var(--text-faint);
  }

  /* 智能体 / 智能体组 分段切换（与成员卡的来源切换同款药丸） */
  /**
   * 智能体 / 智能体组 二选一（2026-10）：改成与顶栏「列表 / 看板」同款的分段轨
   * —— `var(--line)` 的轨 + 圆角矩形按钮，活动态 `--accent-dim` 实心底白字。
   * 原来是独立胶囊（`border-radius: 999px` + 细边框），使用者要求改样式。
   */
  .source-toggle {
    display: flex;
    align-items: center;
    /* ★ 轨道**贴内容**：`.pick-card` 是纵向 flex，块级子项默认被 `stretch` 拉满
       整卡宽度——实测灰轨横贯整张卡（使用者报"右侧被拉太长了"）。钉死内容宽，
       与顶栏 `page-actions`（flex 行里的内容宽轨道）同一个行为。 */
    width: fit-content;
    height: 1.9rem;
    box-sizing: border-box;
    padding: 0 var(--sp-1);
    gap: 2px;
    background: var(--line);
    border-radius: var(--radius);
  }
  .source-toggle button {
    height: 1.5rem;
    padding: 0 var(--sp-3);
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-dim);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .source-toggle button:hover:not(:disabled) {
    background: var(--surface);
    color: var(--text);
  }
  .source-toggle button.active {
    /* ⚠️ 背景用 `--accent-dim` 而不是 `--accent`：暗色主题下 `--accent` 是**浅蓝**
       （#5aa9f5），白字配它看不见；`--accent-dim` 两种主题下都是深蓝，白字才读得
       出来（与顶栏激活按钮同一套惯例）。 */
    background: var(--accent-dim, #2f6fed);
    color: #fff;
  }

  .card-title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-dim);
  }

  /* ★ 摘要标题（2026-10）：加粗（700）、正文色——使用者点名「要加粗」；
     与「交给谁」那个副标题（600 + 淡色）拉开层次。 */
  .summary-title {
    font-size: var(--fs-sm);
    font-weight: 700;
    color: var(--text);
  }

  /* 摘要：两列表（标签 | 值），对齐、只读 */
  .summary-grid {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--sp-1) var(--sp-3);
    margin: 0;
    align-items: baseline;
  }
  .summary-grid dt {
    font-size: var(--fs-sm);
    color: var(--text-dim);
    font-weight: 600;
  }
  .summary-grid dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* 高级选项 / 提交栏：整行 */
  .form-advanced {
    margin: var(--sp-2) 0;
  }

  /* 提交栏：**吸底**（沿用 D58 的原始规则：负边距拉满整栏 + 底色盖住滚过的内容）。
     负边距的量是 `--create-pad-x`——它由外面那层（`Tasks.svelte` 的 `.create-body`）
     定义，必须与 `.form-frame` 的内边距一致。 */
  .form-foot {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    position: sticky;
    bottom: 0;
    z-index: 2;
    margin: var(--sp-3) calc(var(--create-pad-x, var(--sp-6)) * -1) calc(var(--sp-5) * -1);
    padding: var(--sp-3) var(--create-pad-x, var(--sp-6));
    background: var(--bg);
    border-top: 1px solid var(--line);
  }
  .foot-row {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    flex-wrap: wrap;
  }
  .foot-summary {
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .foot-sep {
    margin: 0 var(--sp-1);
    opacity: 0.6;
  }
</style>
