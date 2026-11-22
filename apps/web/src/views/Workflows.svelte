<script lang="ts">
  /**
   * 编排（2026-11，使用者立项）——定义页：
   * 左栏 = 编排定义列表；右栏 = 新建/编辑（模板骨架 → 代码可改）+「运行」发起
   * （任务描述 + 工作目录）+ 该编排的历史（点历史进运行画面）。
   *
   * ⚠️ 运行画面（`$workflowRun` 非空）是**另一个组件**（`WorkflowRunView`），
   *   这里是"定义 + 历史"那一半（使用者拍板：编排页只管定义+历史）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 2026-11（D133）：按「页面基本规范」重排这一页
   * ══════════════════════════════════════════════════════════════════
   *
   * 改之前这一页是**自己一套**，与其它页每一处都对不上：
   *
   *   · 左栏栏头写着大标题 + 说明 + 一颗「新建」按钮 —— 而规范是
   *     **栏头带只有计数 + 搜索**（D61~D66，`ListPane`），**主操作在顶栏**
   *     （`page-actions`；Crystallize 那句"主操作放顶栏"是明规则，定时任务页
   *     还因为这条被使用者点名改过一次）；
   *   · 右栏手写 `detail-head` / `detail-body` —— 规范是 `MainArea`（窄屏返回按钮、
   *     空态、滚动容器都在它里面）；
   *   · 删除用 `window.confirm` —— 规范是平台自己的居中对话框（`askConfirm`）；
   *   · 「发起运行」手写 `.drawer-backdrop` + `.modal` —— 规范是 `Modal` 组件
   *     （Esc / 遮罩 / 关闭按钮只实现一次）；
   *   · `.with-detail` **恒写**：窄屏下左栏被藏起来、右栏还空着 ⇒ 一进这一页
   *     就只剩一片空白，而且没有出口（没有返回按钮）。
   *
   * 现在这一页与任务 / 智能体 / 沉淀 / 定时任务同款：`ListPane` + `MainArea` +
   * 顶栏动作 + 居中对话框 + 窄屏返回。
   *
   * ⚠️ Svelte 5 legacy 模式：本文件不引 runes（`$state` 一用整文件切 runes 模式，
   *   而 legacy 的 `$:` 与 runes 混用会被编译器拒——Tasks.svelte 同款约束）。
   */
  import { onDestroy, onMount } from 'svelte'
  import { paneResize } from '../lib/pane-resize.ts'
  import { t, tx } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import { api, type Workflow, type WorkflowRun, type WorkflowTemplate } from '../lib/api.ts'
  import {
    agents,
    workflows,
    workflowRuns,
    loading,
    loadError,
    loadIssues,
    loadWorkflows,
    loadWorkflowRuns,
  } from '../lib/stores.ts'
  import { pickChatAgentIntent, wfAgent, wfAgentReturn, workflowRun, toast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { Modal } from '@agentdeck/ui/components'
  import ListPane from '../components/ListPane.svelte'
  import ListRow from '../components/ListRow.svelte'
  import CodeEditor from '../components/CodeEditor.svelte'
  import MainArea from '../components/MainArea.svelte'
  import DirPicker from '../components/DirPicker.svelte'
  import WorkflowRunView from '../components/WorkflowRunView.svelte'
  import WorkflowAgents from '../components/WorkflowAgents.svelte'
  import WorkflowAgentEditor from '../components/WorkflowAgentEditor.svelte'
  import { relativeTime } from '../lib/time.ts'

  /**
   * 右栏此刻是"新建"还是"某条编排的编辑"。
   *
   * ⚠️ 与任务页/智能体页的 `creating` 同一套语义：**它不是视图**，是右栏的状态
   *   （`VIEWS` 里没有 `workflows/new`）。窄屏的"有没有详情"也按它算（`detailOpen`）。
   */
  let creating = false
  let formName = ''
  let formCode = ''
  let formTemplateKey: string | null = null
  let formError = ''
  let busy = false

  // ── 发起运行（居中对话框，不是右栏的一块）──
  let runOpen = false
  let runPrompt = ''
  let runWorkDir = ''
  let runDirPickerOpen = false
  let runError = ''
  let runBusy = false

  // 模板清单（「从模板」入口的数据源）
  let templates: WorkflowTemplate[] = []
  onMount(async () => {
    try {
      templates = (await api<{ items: WorkflowTemplate[] }>('/api/workflows/templates')).items ?? []
    } catch {
      // 拿不到模板不炸：新建时留空代码手写即可
    }
  })

  let selectedId: string | null = null
  /**
   * 从内建智能体编辑页返回时，要回到**同一条**编排（D237）：读一次性意图并清掉。
   * 放在 `$:` 里而不是 `onMount`：编辑页刚关掉那一刻列表已经在了，选中就直接生效。
   */
  $: if ($wfAgentReturn !== null) {
    const want = $wfAgentReturn
    wfAgentReturn.set(null)
    const hit = $workflows.find((w) => w.id === want) ?? null
    if (hit) selectOne(hit)
  }
  /** 搜索词（与任务 / 智能体 / 聊天同一套：栏头带里的那个框）。 */
  let filter = ''

  $: selected = $workflows.find((w) => w.id === selectedId) ?? null
  $: visible = filter.trim() === ''
    ? $workflows
    : $workflows.filter((w) => w.name.toLowerCase().includes(filter.trim().toLowerCase()))
  /**
   * 右栏是否有东西（窄屏据此决定"列表让位"）。
   *
   * ⚠️ 这就是改之前那个 bug：原来 `.with-detail` 恒写，窄屏一进来列表就被藏掉、
   *   而右栏什么都没有 ⇒ 整页空白、也没有返回按钮。
   */
  $: detailOpen = creating || selected !== null

  /**
   * 顶栏动作（与聊天 / 任务 / 智能体 / 沉淀 / 定时任务同一格、同一款）。
   *
   * ★ 主操作**只能在顶栏**：栏头带只有"计数 + 搜索"（D61~D66）。这一页原来把
   *   「新建」摆在左栏栏头里，与全站其它页都对不上（定时任务页因为同一条被点名过）。
   * ★ 标签读 `$t(...)` 放在 `$:` 里 ⇒ 切语言时自动重新登记（`setPageActions` 是整体覆盖）。
   */
  $: setPageActions('workflows', [
    {
      id: 'new',
      label: $t('workflows.new'),
      kind: 'primary',
      icon: 'plus',
      // 表单已经开着时禁点（与智能体页 / 定时任务页同款）
      disabled: creating,
      onActivate: startCreate,
    },
    {
      id: 'ai',
      label: $t('workflows.aiDraftAction'),
      kind: 'ghost',
      onActivate: startAiDraft,
    },
    {
      id: 'refresh',
      label: $t('common.refresh'),
      kind: 'ghost',
      icon: 'refresh',
      onActivate: () => void refresh(),
    },
  ])
  onDestroy(() => clearPageActions('workflows'))

  function refresh(): Promise<void> {
    return Promise.all([loadWorkflows(), loadWorkflowRuns()]).then(() => {})
  }

  /**
   * 「AI 生成…」：跳到聊天页开一个新对话，执行者选中**编排生成者**（D135）。
   *
   * ⚠️ 为什么不在这里弹一个"你想做什么"的框：生成是**聊出来的**（要来回问几次），
   *   所以入口把用户送到聊天页，让生成者按它自己的套路问——与"智能体生成者"同一形态。
   *   聊天页那边靠一次性意图 `pickChatAgentIntent` 预选执行者，并在 `onMount` 时
   *   直接进起草态（否则有历史对话的机器上会落在旧对话上，像"点了没反应"）。
   */
  function startAiDraft(): void {
    /*
     * ⚠️ 顺序要紧：**先**置意图、**再**改 hash。反过来写通常也能work，但那是靠
     *   "hashchange 异步派发"这个平台细节——真被同步派发时聊天页的 `onMount` 会读到
     *   空意图，表现为"点了没反应"（代码看起来两行都对，最难查的一类）。
     */
    pickChatAgentIntent.set('workflow-maker')
    location.hash = '#/chat'
  }

  /** 选一条：进编辑（与"选中即编辑"同一条：没有查看态）。 */
  function selectOne(w: Workflow): void {
    creating = false
    selectedId = w.id
    formName = w.name
    formCode = w.code
    formTemplateKey = w.templateKey
    formError = ''
    runOpen = false
  }

  /**
   * 打开内建智能体的编辑页（D237）：**切地址**，不是组件开关——刷新还在、能分享。
   * `agentId === 'new'` 表示新建。
   */
  function editAgent(workflowId: string, agentId: string): void {
    location.hash = `#/workflows/agents/${workflowId}/${agentId}`
  }

  /**
   * 从编辑页回来：地址回 `#/workflows`，并把"回到哪条编排"记成一次性意图。
   *
   * ⚠️ 顺序要紧：先置意图再改 hash——`syncRoute` 会把 `$wfAgent` 清掉，
   *   而编排详情重新挂载时靠这个意图决定"选中哪一条"（否则回到列表第一条，
   *   使用者会以为"我刚配的那条不见了"）。
   */
  function leaveAgentEditor(): void {
    wfAgentReturn.set(selectedId ?? $wfAgent?.workflowId ?? null)
    location.hash = '#/workflows'
  }

  /** 左栏的「新建」：右栏切成空白表单（主操作在顶栏，这里由它调）。 */
  function startCreate(): void {
    creating = true
    selectedId = null
    formName = ''
    formCode = ''
    formTemplateKey = null
    formError = ''
    runOpen = false
  }

  /** 窄屏返回（`MainArea` 的 `.back-to-list`）：右栏收掉，回到列表。 */
  /**
   * ★ D251（使用者："刚才请你整理的『新建 / 编辑』，请全面按智能体的方式修正一遍"）：
   **草稿有没有改动**——与智能体编辑页同一条规矩：没改动时「保存」置灰
   （点了也不会有事发生，那是假按钮）。新建态还要名字与代码都非空。
   */
  $: wfDirty = creating
    ? formName.trim() !== '' && formCode.trim() !== ''
    : selected !== null && (formName !== selected.name || formCode !== selected.code)

  function closeDetail(): void {
    creating = false
    selectedId = null
    formError = ''
    runOpen = false
  }

  function pickTemplate(tpl: WorkflowTemplate): void {
    formTemplateKey = tpl.key
    formCode = tpl.code
    formError = ''
  }

  async function save(): Promise<void> {
    if (busy) return
    formError = ''
    const name = formName.trim()
    if (name === '') {
      formError = tx('workflows.nameRequired')
      return
    }
    if (formCode.trim() === '') {
      formError = tx('workflows.codeRequired')
      return
    }
    busy = true
    try {
      if (creating) {
        const out = await api<{ workflow: Workflow }>('/api/workflows', {
          method: 'POST',
          body: JSON.stringify({ name, code: formCode, templateKey: formTemplateKey }),
        })
        // 存完立刻转成编辑态（与任务页"提交后选中新任务"同一条：界面跟着数据走）
        creating = false
        selectedId = out.workflow.id
      } else if (selectedId) {
        await api<{ workflow: Workflow }>(`/api/workflows/${selectedId}`, {
          method: 'PUT',
          body: JSON.stringify({ name, code: formCode }),
        })
      }
      await loadWorkflows()
      toast.set(tx('workflows.saved'))
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function remove(): Promise<void> {
    if (busy || !selectedId) return
    // ★ 平台自己的居中对话框，不是 `window.confirm`：全站只有这一种确认框
    //   （原生对话框在窄屏/触屏上样子完全不同，而且无法带"删了会怎样"的一句说明）。
    const ok = await askConfirm({
      title: tx('workflows.delete'),
      message: tx('workflows.confirmDelete'),
      confirmLabel: tx('workflows.delete'),
    })
    if (!ok) return
    busy = true
    try {
      await api(`/api/workflows/${selectedId}`, { method: 'DELETE' })
      await loadWorkflows()
      closeDetail()
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function startRun(): Promise<void> {
    if (runBusy || !selectedId) return
    runError = ''
    runBusy = true
    try {
      // ★ 运行用**已保存的代码**（daemon 按 workflowId 读库）——编辑器里有未保存的
      //   改动（formCode !== selected.code）先保存再运行。2026-11 使用者实操踩过：
      //   把模板默认节点「组A」改成自己的组名后没点「保存」直接点「运行」，跑的是
      //   旧代码、报「组A 不存在」——界面看起来"运行没按我写的来"。
      if (selected && formCode !== selected.code) {
        await save()
        if (formError !== '' || !selectedId) {
          // 保存失败（名字/代码为空等）：错误显示在运行对话框里（右栏那条 error
          // 被对话框盖住看不见，这里带过来）
          runError = formError
          return
        }
      }
      const out = await api<{ run: WorkflowRun }>(`/api/workflows/${selectedId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: runPrompt,
          workDir: runWorkDir.trim() === '' ? null : runWorkDir.trim(),
        }),
      })
      runOpen = false
      runPrompt = ''
      runWorkDir = ''
      // 编排任务会进「任务」列表（徽标 + 步骤进度）——发起后立即重拉，界面跟着数据走。
      await Promise.all([loadWorkflowRuns(), loadIssues()])
      // 跳运行画面（子路由：`#/workflows/run/<runId>`）；返回按钮回定义页
      location.hash = `#/workflows/run/${out.run.id}`
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err)
    } finally {
      runBusy = false
    }
  }

  function sourceKey(w: Workflow): WebTextId {
    return w.source === 'template'
      ? 'workflows.sourceTemplate'
      : w.source === 'ai'
        ? 'workflows.sourceAi'
        : 'workflows.sourceManual'
  }
</script>

{#if $wfAgent}
  <!--
    ★ D237：内建智能体的编辑页。它是**地址**（`#/workflows/agents/<编排id>/<id|new>`），
    与运行画面同构：切走还能回来、刷新还在、能分享。
  -->
  <WorkflowAgentEditor
    workflowId={$wfAgent.workflowId}
    agentId={$wfAgent.agentId}
    ondone={leaveAgentEditor}
  />
{:else if $workflowRun}
  <WorkflowRunView runId={$workflowRun.runId} />
{:else}
  <div
    class="split-layout"
    class:with-detail={detailOpen}
    data-list-key="workflows"
    data-list-label={$t('shell.resizeList')}
    use:paneResize
  >
    <!-- ══════════ 左栏：编排定义列表（标准控件 ListPane：计数 + 搜索 + 五态）══════════ -->
    <ListPane
      countLabel={$t('workflows.listCount', { count: visible.length })}
      searchPlaceholder={$t('workflows.search')}
      {filter}
      onFilter={(v) => (filter = v)}
      loading={($loading['workflows'] && $workflows.length === 0) ?? false}
      loadError={$loadError['workflows'] ?? null}
      empty={$workflows.length === 0}
      emptyTitle={$t('workflows.empty')}
      emptyHint={$t('workflows.emptyHint')}
      emptyFiltered={$workflows.length > 0 && visible.length === 0}
      emptyFilteredTitle={$t('workflows.emptyFiltered')}
      emptyFilteredHint={$t('workflows.emptyFilteredHint')}
    >
      {#snippet rows()}
        <ul class="list-stack">
          {#each visible as w (w.id)}
            <ListRow rowClass="wf-row" active={w.id === selectedId} onclick={() => selectOne(w)}>
              {#snippet children()}
                <span class="wf-title ellipsis" title={w.name}>{w.name}</span>
                <span class="list-row-sub wf-sub">
                  <span class="badge">{$t(sourceKey(w))}</span>
                  <span class="faint"
                    >{$t('workflows.updated', { time: relativeTime(w.updatedAt, Date.now()) })}</span
                  >
                </span>
              {/snippet}
            </ListRow>
          {/each}
        </ul>
      {/snippet}
    </ListPane>

    <!-- ══════════ 右栏：编辑器 / 历史（标准控件 MainArea：栏头 + 窄屏返回 + 空态）══════════ -->
    <MainArea
      empty={!detailOpen}
      emptyTitle={$t('workflows.pickHint')}
      emptyHint={$t('workflows.pickHintHint')}
      backLabel={detailOpen ? $t('workflows.backToList') : undefined}
      onBack={closeDetail}
      title={creating ? $t('workflows.createTitle') : selected?.name ?? ''}
      bodyClass="detail-scroll"
    >
      {#snippet sub()}
        {#if selected && !creating}
          <span class="badge">{$t(sourceKey(selected))}</span>
          <span class="faint"
            >{$t('workflows.updated', { time: relativeTime(selected.updatedAt, Date.now()) })}</span
          >
        {:else if creating}
          <span class="faint">{$t('workflows.templatesLabel')}</span>
        {/if}
      {/snippet}

      {#snippet actions()}
        <!--
          ★ D251：**与智能体编辑页同一条排布与判据**（§2.6：主操作 → 普通动作 → 次操作 → 危险）：
            · 「保存」在最前，且**没改动时置灰**（新建态还要求名字与代码都非空）；
            · 「取消」是次操作（回列表，丢掉草稿）；
            · 「运行 / 删除」只对**已存在**的编排画出来（新建态没有可跑可删的东西）。
          原来这里是"运行 / 删除 / 保存"，既没有取消、保存也恒可用——同一个"新建/编辑"
          动作族里两套规矩，正是这次要收掉的那类分叉。
        -->
        <button
          type="button"
          class="btn btn--primary"
          disabled={busy || !wfDirty}
          title={wfDirty ? '' : $t('workflows.saveNothing')}
          onclick={() => void save()}
        >
          {$t('workflows.save')}
        </button>
        {#if !creating && selected}
          <button type="button" class="btn btn--secondary" onclick={() => (runOpen = true)}>
            {$t('workflows.run')}
          </button>
        {/if}
        <button type="button" class="btn btn--ghost" onclick={closeDetail}>
          {$t('common.cancel')}
        </button>
        {#if !creating && selected}
          <button
            type="button"
            class="btn btn--danger"
            disabled={busy}
            onclick={() => void remove()}
          >
            {$t('workflows.delete')}
          </button>
        {/if}
      {/snippet}

      {#snippet body()}
        {#if creating}
          <!--
            从模板起步：模板 → 名字 → 代码。
            ★ 2026-11 使用者："这些都是简单编排，并没有实际用途，建议给实际有用的编排"
              ⇒ 模板改成**真实场景**（周报流水线 / 写完自动复查 / 并行调研 / 批量改造 /
              发布前检查），每张卡带一句"它做什么"，点一下就把代码填进下面的编辑器。
          -->
          <div class="wf-tpl-row">
            {#each templates as tpl (tpl.key)}
              <button
                type="button"
                class="wf-tpl {formTemplateKey === tpl.key ? 'active' : ''}"
                onclick={() => pickTemplate(tpl)}
              >
                <span class="wf-tpl-name">{tpl.name}</span>
                <span class="wf-tpl-summary">{$t(`workflows.template.${tpl.key}` as never)}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if detailOpen}
          <!--
            ★ D250：「名字」这一格**编辑态也要有**。它原来包在 `{#if creating}` 里
            （只有新建时能填），于是编排**建成之后改不了名**：`formName` 从库里载入、
            `save()` 也会把它发出去，可界面上根本没有输入点——一个"数据在、界面没有"的
            典型缺陷（这类东西在本仓库是明令禁止的，见 CLAUDE.md 硬约束第 5 条）。
            现在它和「代码」一样两态都在：新建时在模板行下面，编辑时在代码上面。
          -->
          <div class="field">
            <label for="wf-name">{$t('workflows.nameLabel')}</label>
            <input
              id="wf-name"
              type="text"
              bind:value={formName}
              placeholder={$t('workflows.namePlaceholder')}
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label for="wf-code">{$t('workflows.codeLabel')}</label>
            <!-- ★ 2026-11 使用者："编排代码的显示需要有代码高亮等专业编辑" ⇒ CodeEditor
                 （语法高亮 + 行号 + Tab 缩进；零依赖，见组件顶部说明） -->
            <CodeEditor
              id="wf-code"
              bind:value={formCode}
              rows={creating ? 12 : 16}
              placeholder={$t('workflows.codePlaceholder')}
              ariaLabel={$t('workflows.codeLabel')}
            />
          </div>
          {#if formError}
            <div class="notice bad">{formError}</div>
          {/if}

          <!--
            ★ D237：本编排的内建智能体（列表 + 入口）。点「新建 / 编辑」跳到编辑页
            （地址 `#/workflows/agents/<编排id>/<id|new>`）——编辑要整栏放指令与技能，
            所以它是**一页**，不是就地展开。这一节回答的是另一个问题：
            "这条编排里有哪几个人、代码里能写谁"。
          -->
          {#if selected && !creating}
            <WorkflowAgents
              workflowId={selected.id}
              agents={selected.inlineAgents ?? []}
              globalNames={new Set($agents.map((a) => a.name))}
              onedit={(agentId) => editAgent(selected.id, agentId)}
            />
          {/if}

          <!--
            ⚠️ 2026-11 使用者："去掉『运行历史』的显示"
              这一段原来是"该编排跑过的运行"列表。删掉的理由：编排的每一次运行**都是
              一条任务**，在「任务」页里按编排分组列着、点开就是同一个运行画面——
              同一批数据在编排页再列一遍，只会让人分不清该看哪儿（与 D132 删「编排任务」
              页同一条理由）。运行状态在任务页看，这里只管定义。
          -->
        {/if}
      {/snippet}
    </MainArea>
  </div>

  <!-- ══════════ 发起运行（平台居中对话框；Esc / 遮罩 / 关闭按钮由组件负责）══════════ -->
  <Modal
    open={runOpen && selected !== null}
    title={$t('workflows.runFormTitle')}
    subtitle={selected?.name ?? ''}
    closeLabel={$t('common.close')}
    onclose={() => (runOpen = false)}
  >
    <div class="field">
      <label for="wf-run-prompt">{$t('workflows.promptLabel')}</label>
      <textarea
        id="wf-run-prompt"
        rows="4"
        bind:value={runPrompt}
        placeholder={$t('workflows.promptPlaceholder')}
      ></textarea>
      <p class="hint fs-sm">{@html $t('workflows.promptHint')}</p>
    </div>
    <div class="field">
      <label for="wf-run-workdir">{$t('workflows.workDirLabel')}</label>
      <!-- 与「新建任务」「定时任务」同一个控件（.field-row + 浏览… + DirPicker）：
           输入框始终留着（手打永远可用），选择框是"看见目录里有什么"的入口。 -->
      <div class="field-row">
        <input
          id="wf-run-workdir"
          type="text"
          bind:value={runWorkDir}
          placeholder={$t('workflows.workDirAuto')}
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="btn btn--ghost" onclick={() => (runDirPickerOpen = true)}>
          {$t('dirs.browse')}
        </button>
      </div>
      <DirPicker bind:open={runDirPickerOpen} bind:value={runWorkDir} />
    </div>
    {#if runError}
      <div class="notice bad">{runError}</div>
    {/if}
    <svelte:fragment slot="foot">
      <button type="button" class="btn btn--secondary" onclick={() => (runOpen = false)}>
        {$t('common.cancel')}
      </button>
      <button type="button" class="btn btn--primary" disabled={runBusy} onclick={() => void startRun()}>
        {$t('workflows.startRun')}
      </button>
    </svelte:fragment>
  </Modal>
{/if}

<style>
  /* 列表行两行结构（311/312 批纪律，与 .sched-title/.sched-sub 同款）：
     第一行标题（单行省略五件套）、第二行辅助信息（显式字色/字号 + 单行省略）——
     不写 color/font-size 就会从行里继承，两页的辅助信息颜色不一致。 */
  .wf-title {
  /* D190：截断四行收进全局 `.ellipsis`（markup 里已经带上） */
    display: block;
    font-weight: 600;
  }
  /* ⚠️ 2026-11（D142）：`.wf-sub` 的声明删了——统一走 app.css 的 `.list-row-sub`
     （基线对齐）。原来这里是 `align-items: center`，而这一行开头就是一枚「来源」徽标。 */
  /* ⚠️ 与定时任务页 `.sched-sub > *` 同一条教训（那一页量到过：长 cron 人话把行
     撑宽、省略号不生效）：flex 子项默认 `min-width: auto` 不收缩，子项里那段
     "更新于 x 分钟前"变长时会把整行顶出去。子项可收缩，截断才真的发生。 */
  .wf-sub > * {
    min-width: 0;
  }
  /* 模板卡：名字 + 一句话说明（使用者："给实际有用的编排"——那就要让人一眼看出它做什么） */
  .wf-tpl-row {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: var(--sp-2);
    margin-bottom: var(--sp-3);
  }
  .wf-tpl {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .wf-tpl:hover {
    background: var(--surface-hover);
  }
  .wf-tpl.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .wf-tpl-name {
    font-weight: 600;
    font-size: var(--fs-base);
  }
  .wf-tpl-summary {
    color: var(--text-faint);
    font-size: var(--fs-xs);
  }
</style>
