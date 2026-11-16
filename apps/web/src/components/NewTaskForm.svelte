<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, newRunId, type Issue } from '../lib/api.ts'
  import { agents, effectiveDefaultAgentId, loadIssues, loadRuns } from '../lib/stores.ts'
  import { executorCandidates } from '../lib/newtask-chain.ts'
  import PromptField from './PromptField.svelte'
  import { splitRequest } from '../lib/request-text.ts'
  import { createDirty } from '../lib/create-draft.ts'
  import { go, selectedIssueId, showToast } from '../lib/view.ts'
  import { t, tx } from '../lib/i18n.ts'
  import DirPicker from './DirPicker.svelte'

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
   *   · **交给谁**——一个执行者。
   *
   * ⚠️ 2026-11（S3）：这里原来还有「智能体组」那一档（选组 ⇒ 提交 `groupId`，
   *   审核者 / 动作 / 返工由 daemon 按组展开；选个人 ⇒ 什么都不带）。**组退场**
   *   ⇒ 只剩"选一个人"。于是这一页真的只问两件事了。
   *
   *   选中的执行者仍然显示一行摘要（谁来做），推导走 `lib/newtask-chain.ts`
   *   （纯函数、有单测）——**推导不在这一页里写第二遍**。
   */

  let title = ''
  let workDir = ''
  /** 「浏览…」那颗按钮开的目录选择框（分批第 229 批；与输入框共享一个值）。 */
  let dirPickerOpen = false
  /** 交给谁：一个执行者。 */
  let agentId = ''
  let busy = false
  let error = ''

  /** 执行者候选：`role === 'executor'`（审核者不接任务）。 */
  $: executorAgents = executorCandidates($agents)
  // 没选过执行者时，初值 = 生效中的默认（没有就用列表第一个）。
  $: if (!agentId && executorAgents.length > 0) {
    agentId = $effectiveDefaultAgentId ?? executorAgents[0]!.id
  }
  $: executor = executorAgents.find((a) => a.id === agentId) ?? null
  /** 摘要要显示的执行者名字；`null` = 还没选好（没有执行者）。 */
  $: executorName = executor?.name ?? null

  /*
   * ⚠️ 2026-11（D125）：这里原来还有一整块「谁审」的推导——`groupReviewerId`、
   *   `groupChainDefaults`、`resolveNewTaskChain(...)` 与 `reviewerSummary`
   *   （谁审 / 人没了 / 选了单个智能体就不会被审）。
   *
   *   **审核 run 退场** ⇒ 新建任务不再有"谁审"这一栏：派出去的每一条 run 都只是
   *   执行。要有人把关，就在**编排**里再派一条普通 run 去把关。
   */

  // 2026-11 控件化：autosize（3→15 行）搬进 PromptField（`autosize` prop），
  // 这里只留行数常量与 Ctrl/Cmd+Enter 提交。
  const TITLE_ROWS = 3
  const TITLE_MAX_ROWS = 15

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
      agentId !== ($effectiveDefaultAgentId ?? executorAgents[0]?.id ?? ''),
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

    const agent = executor
    if (!agent) {
      error = tx('newtask.noAgents')
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
          /*
           * ⚠️ 2026-11（S3）：这里原来在组模式下带 `groupId`（审核者 / 动作 / 返工
           *   由 daemon 按组展开）。组退场 ⇒ 什么都不带，只按 `agentRef` 派活。
           */
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
      <PromptField
        bind:value={title}
        label={$t('newtask.titleLabel')}
        rows={TITLE_ROWS}
        autosize={{ min: TITLE_ROWS, max: TITLE_MAX_ROWS }}
        required
        autocomplete="off"
        placeholder={$t('newtask.titlePlaceholder')}
        onkeydown={onTitleKeydown}
      />
      <span class="hint">{$t('newtask.titleSplitHint')}</span>
    </label>
  </div>

  <!-- ══════════════════ 交给谁 ══════════════════ -->
  <section class="pick-card">
    <span class="card-title">{$t('newtask.pickTitle')}</span>

    <!--
      ⚠️ 2026-11（S3）：这里原来是一个「智能体 / 智能体组」互斥切换 + 选组下拉。
      **组退场** ⇒ 只剩"选一个执行者"。
    -->
    {#if true}
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

    简化版的契约：选了**谁**，这一栏就说**那一次会怎么走**——全部来自长期配置，
    界面上没有可改的项。

    ⚠️ 2026-11：这一栏原来有四行（执行者 / 审核者 / 允许的动作 / 返工）。动作
    （D123）、返工（D124）、审核（D125）与组（S3）先后退场之后，**只剩执行者**。

    ⚠️ 推导全在 `lib/newtask-chain.ts` 里（纯函数、有单测），这一页只读结果。
  -->
  {#if executorName}
    <section class="summary-card">
      <span class="summary-title">{$t('newtask.summaryTitleAgent')}</span>
      <dl class="summary-grid">
        <dt>{$t('newtask.summaryExecutor')}</dt>
        <dd>{executorName}</dd>

        <!-- ⚠️ 2026-11（D125）：这里原来是「审核者」那一行（谁审 / 人没了 /
             选单个智能体就不会被审）。审核 run 退场 ⇒ 不再有"谁审"，整行删。 -->

        <!-- ⚠️ 2026-11（D124）：这里原来是「返工：不返工 / N 次 / 无限」那一行。
             返工退场 ⇒ 任务不再有返工预算，整段删掉。 -->
      </dl>
    </section>
  {/if}

  <!-- 高级：工作目录。默认**不需要填**（D27）——收起来，不该出现在必经之路上。 -->
  <details class="form-advanced">
    <summary class="hint" style="cursor:pointer">{$t('newtask.advancedSummary')}</summary>
    <label for="newtask-workdir" style="margin-top:var(--sp-3)">
      {$t('newtask.workDirLabel')}
    </label>
    <!--
      ★ 分批第 229 批：和「新对话」那张表单同一个控件（`DirPicker`）。
      这个格子藏在「高级」里，平时不出现——但**一旦要用**，它恰恰是最容易填错的一个：
      "接进你的仓库"要求一条绝对路径。手打仍然是退路（按钮旁边的输入框没被动过）。
    -->
    <div class="workdir-row">
      <!-- `id` + 上面 label 的 `for`：分批第 229 批把它拆出 label 之后 a11y 报了一条
           "label 没关联控件"。有 `for` 之后 `aria-label` 就不需要了（重复命名反而更乱）。 -->
      <input
        id="newtask-workdir"
        bind:value={workDir}
        placeholder={$t('newtask.workDirPlaceholder')}
        autocomplete="off"
        spellcheck="false"
      />
      <button
        type="button"
        class="btn btn--ghost"
        data-newtask-workdir-browse
        onclick={() => (dirPickerOpen = true)}
      >{$t('dirs.browse')}</button>
    </div>
    <DirPicker bind:open={dirPickerOpen} bind:value={workDir} />
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
          <!-- ⚠️ 2026-11（D125）：这里原来还有「由某某审 / 不自动审核」（审核 run
               退场）。 -->
          {#if false}
            <span class="foot-sep">·</span>
          {/if}
          <!-- ⚠️ 2026-11（D123）：这里原来还有 `{$t('newtask.footActions', …)}`——
               动作能力退场，摘要与底栏都不再提"动作"。 -->
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
  /* ★ select 文字**显式**设成正文色——不然部分浏览器把禁用占位 option
     渲染成浅色（白字），看不清选没选。 */
  .pick-card select {
    color: var(--text);
  }
  .pick-card select option[value=''][disabled] {
    color: var(--text-faint);
  }

  /* ⚠️ 2026-11（S3）：这里原来是「智能体 / 智能体组」二选一的分段轨（`.source-toggle`）。
     组退场 ⇒ 这一页只剩"选一个执行者"，没有可切换的两档。 */
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
