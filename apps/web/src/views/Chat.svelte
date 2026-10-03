<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import ListPane from '../components/ListPane.svelte'
  import MainArea from '../components/MainArea.svelte'
  import ListRow from '../components/ListRow.svelte'
  import RunLog from '../components/RunLog.svelte'
  import WorkDirTree from '../components/WorkDirTree.svelte'
  import { api, type Agent, type ChatTurnView, type Conversation } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import {
    applyChoice,
    chatFilesState,
    executorChoices,
    isTurnRunning,
    skillsHeldBackByDaemon,
    type DraftPick,
  } from '../lib/chat.ts'
  import { showToast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { absoluteTime, relativeTime } from '../lib/time.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import {
    activeConversationId,
    agents,
    chatDetail,
    chatLiveRunId,
    conversations,
    deleteConversation,
    effectiveDefaultAgentId,
    identity,
    loadConversations,
    loadError,
    loading,
    openConversation,
    renameConversation,
    sendChatTurn,
    skills,
    startConversation,
  } from '../lib/stores.ts'

  /**
   * 聊天 —— 闭环的**旁路**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这个页面里没有、也不会有"动作"
   * ══════════════════════════════════════════════════════════════════
   *
   * 产品的脊柱是「派活 → 审核 → 判决 → 才动手」，而**判决是动作唯一的门槛**。
   * 聊天不产出判决（报告摄取只认 issue/report/run，聊天那一轮的 subject 是
   * conversation），所以这里触发不了任何登记过的动作——这不是"我们没做"，
   * 是这条路上没有那个门。
   *
   * ⚠️ 2026-10 按要求**去掉了"派发任务"**（原来有两个按钮：「把整个对话派出去」与
   *   每轮次上的「用这个去派活」，它们把内容预填进「新建任务」）。
   *   所以现在这一页与本闭环**完全不相通**：想动手就去「新建任务」写，
   *   聊天这边不提供那条路（要带内容过去，自己复制粘贴——不再有隐藏的预填）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 一轮对话 = 一条 run
   * ══════════════════════════════════════════════════════════════════
   *
   * 所以这里所有"正在跑"的能力都是白拿的：流式（复用 `RunLog` 的 SSE，
   * 与任务详情页同一个组件）、停止（`POST /api/runs/:id/cancel`）、
   * 刷新之后还在跑（状态在服务端那条 run 上，不在这个页面里）。
   *
   * 正在跑的那一轮显示**实时日志**，跑完了才变成一段 Markdown——与任务详情页
   * 同一套：跑的时候你会想看见它到底在干什么，跑完了你只想知道它说了什么。
   */

  // ── 本地状态 ──
  /** 正在"起一个新对话"（还没说第一句话，所以服务端还没有这条对话）。 */
  let drafting = false
  /**
   * 栏头带的搜索（D63）：与任务/智能体同款。只过滤**标题**——对话没有别的
   * 可搜的正文（轮数/相对时间是元信息，不是检索词）。
   */
  let chatFilter = ''
  $: visibleConversations = $conversations.filter((c) => {
    if (!chatFilter.trim()) return true
    return c.title.trim().toLowerCase().includes(chatFilter.trim().toLowerCase())
  })
  /**
   * 下拉里当前选的那一项，值是 `agent:<id>` / `skill:<id>`。
   *
   * ⚠️ 存"选了什么"而不是"选了谁"：选项里有两类东西（执行者、以及每一条 skill），
   *    而使用者点的那一项目前必须原样留在框里——直接把 agentId 绑上去的话，选完
   *    skill 之后框里会跳成某个执行者的名字，看起来像点错了。
   */
  let draftChoice = ''
  /**
   * 这一项**实际**意味着什么：绑谁 + 额外带哪条 skill。
   *
   * 由 `applyChoice` 算（纯函数、有测试），界面不写第二份判断。
   */
  let draftPick: DraftPick = { agentId: '', skillId: '' }
  // ── 右栏底部那一栏「工作目录的文件」──
  /** 默认**收起**：头部那一行常驻并写出条数，值不值得点开由使用者判断。 */
  let filesOpen = false
  /** 手动「刷新」与"一轮跑完"都靠它触发重取（它进 reloadKey）。 */
  let filesTick = 0
  /** 顶层有几项——由 `WorkDirTree` 报上来（列表住在它那里）。 */
  let filesCount = 0
  let input = ''
  let sending = false
  /**
   * 刚发出去、服务端还没确认的那一句。
   *
   * ⚠️ **全仓唯一一处乐观更新**（别处一律"先请求再重取"）。理由是这个界面
   *    的性质：输入框会在发送那一刻清空，如果屏幕上什么都不出现，那一瞬间
   *    使用者面对的是一个空聊天框——他无法区分"发出去了"和"刚才那句没了"。
   *    代价是它可能与服务端回来的那一轮短暂并存，所以取回数据后**必须**清掉。
   */
  let pendingText = ''
  let errorText = ''
  let renaming = false
  let renameValue = ''
  /**
   * 「新对话」界面上的工作目录设定（2026-10 起只在建对话时设一次；
   * 详情页只读）。空字符串 = 平台自动分配。
   */
  let draftWorkDir = ''

  /**
   * 执行者名字（对话只存 id）。
   *
   * ⚠️ `$:` 先算成一张表，而**不是**在模板里调一个读 store 的函数：模板里的
   *    函数只跟踪表达式里看得见的标识符，函数体里读的 store 它看不见——
   *    表现是"agent 改了名，这一页不动"，而且没有任何报错。
   */
  $: agentNames = new Map($agents.map((a) => [a.id as string, a.name]))

  $: detail = $chatDetail
  $: activeTurns = detail?.turns ?? []
  $: activeConversation = detail?.conversation ?? null
  $: liveTurn = activeTurns.find((turn) => turn.runId === $chatLiveRunId) ?? null
  $: runningTurn =
    activeTurns.find((turn) => isTurnRunning(turn)) ?? null
  $: executors = $agents.filter((agent) => agent.role === 'executor')
  /**
   * 下拉的全部选项：执行者 + **每一条装着的 skill**。
   *
   * ★ 传的是**全部 agent**、不是上面那个 `executors`：那条"只有执行者能被选来
   *   聊天"的规则在 `executorChoices` 里，由 `chat.test.ts` 钉住——放两处就迟早
   *   只对一处。
   */
  /**
   * ★ 这个 daemon 认不认 `Conversation.skillIds`。
   *
   * 没有它时**没人挂的 skill 不给选项**：那种 skill 只能由对话自己带着，而旧
   * daemon 会静默忽略那个字段——界面却会写着"将使用它 + 这条 skill"。宁可少给
   * 一个选项，也不能给一个兑现不了的承诺（与「换人审 / 不审」「人工裁决」同一规矩）。
   */
  $: skillsCarrySupported = ($identity?.capabilities ?? []).includes('conversation-skills')
  $: draftChoices = executorChoices(
    $agents,
    $skills,
    $effectiveDefaultAgentId ?? null,
    skillsCarrySupported,
  )
  /** 被这个旧 daemon 挡住、因此没进选项的那些 skill（页面上要点名说出来）。 */
  $: heldBackSkills = skillsHeldBackByDaemon($agents, $skills, skillsCarrySupported)
  $: agentChoices = draftChoices.filter((c) => c.kind === 'agent')
  $: skillChoices = draftChoices.filter((c) => c.kind === 'skill')
  $: draftOption = draftChoices.find((c) => c.value === draftChoice) ?? null
  /** 选中的 skill（没有就 null）。 */
  $: draftSkill = draftOption?.kind === 'skill' ? draftOption.skill : null
  /** 它有没有主人：有 ⇒ 这次是在跟"挂着它的那个执行者"说话。 */
  $: draftSkillOwned = draftOption?.kind === 'skill' && draftOption.agentId !== ''
  /**
   * 选了什么就要把"这到底意味着什么"说出来。
   *
   * 不显示的话，使用者以为选的只是能力包，而实际上执行者也可能被一起换了——
   * 这种"没告诉他的替换"是这一页最能骗人的地方。
   */
  $: activeSkillSlugs = ((activeConversation?.skillIds ?? []) as string[])
    .map((id) => $skills.find((s) => s.id === id)?.slug)
    .filter((slug): slug is string => typeof slug === 'string')
  $: agentOfActive = $agents.find((a) => a.id === activeConversation?.agentId) ?? null
  /**
   * 那个 daemon 认不认「对话的工作目录」那条接口。
   *
   * 不认时**不让它去撞 404**，而是直接说明原因（重启之后就有）——理由见
   * `chat.ts` 里 `chatFilesState` 的注释：任务页那次实测把失败画成了骨架屏，
   * "取不到"与"还在加载"长得一模一样。
   */
  $: conversationFilesSupported = ($identity?.capabilities ?? []).includes('conversation-files')
  $: filesState = chatFilesState({
    drafting,
    conversationId: activeConversation?.id ?? null,
    capability: conversationFilesSupported,
  })
  /**
   * 什么时候重取那一栏。
   *
   * 三样东西任一变了就重取：换了对话、改了它的工作目录、**一轮跑完**（`filesTick`）。
   * ⚠️ 跑的过程中**不自动轮询**：消息流已经在给实时日志（那回答"它在干什么"），
   *    这一栏回答的是"现在有什么"；让它自己抖动起来，两个都会变得不可信。
   *    跑的时候按钮照旧可点，旁边写明了为什么值得点。
   */
  $: filesReloadKey = [
    activeConversation?.id ?? '',
    activeConversation?.workDir ?? '',
    String(filesTick),
  ].join('\u0000')
  $: canSend = input.trim() !== '' && !sending && runningTurn === null
  /** 相对时间的「现在」——每次响应式更新重算一遍（列表刷新时跟着走）。 */
  $: now = Date.now()
  $: actualWorkDir = detail?.workDir ?? null
  /** 右栏有没有"可以说话的地方"：草稿态（还没说第一句）也算。 */
  $: activeOrDrafting = drafting || activeConversation !== null

  onMount(() => {
    void (async () => {
      if ($conversations.length === 0) await loadConversations()
      const current = $activeConversationId
      if (current && $conversations.some((c) => c.id === current)) {
        await openConversation(current)
      } else if ($conversations.length > 0) {
        await openConversation($conversations[0]!.id)
      } else {
        startDrafting()
      }
    })()
  })

  function startDrafting(): void {
    drafting = true
    errorText = ''
    input = ''
    pendingText = ''
    draftWorkDir = ''
    const first = $effectiveDefaultAgentId ?? executors[0]?.id ?? ''
    draftChoice = first === '' ? '' : `agent:${first}`
    draftPick = { agentId: first, skillId: '' }
  }

  /**
   * 顶栏那一排动作（机制见 `lib/page-actions.ts`）。
   *
   * ★ 「新对话」是**整页的主线动作**（它不是"左栏的新对话"，而是这一页唯一一个
   *   开始新事情的方式），所以它上了顶栏；正在起草时它**不该再出现**——那一刻
   *   右侧已经在填新对话了，再给一个「新对话」只会让人以为要点第二下。
   *   这一点靠"登记时决定要不要放进去"表达（每次登记都是整体覆盖）。
   *
   * ⚠️ 卸载时收回来（登记里存的是抓着这一页状态的闭包）。
   */
  $: setPageActions('chat', drafting ? [] : [
    {
      id: 'new',
      label: $t('chat.newConversation'),
      kind: 'primary',
      icon: 'plus',
      onActivate: startDrafting,
    },
  ])
  onDestroy(() => clearPageActions('chat'))

  /**
   * 换了下拉里那一项。
   *
   * 判断全在 `applyChoice` 里（纯函数、有测试）；这里只负责把结果落到状态上。
   * ⚠️ 特意用 `onchange` 而不是 `bind:value`：`applyChoice` 需要**上一次的**
   *    pick 才能做到"选了一条没主的 skill 时不动你已经选好的执行者"，而
   *    `bind:value` 会把新值先写进去、旧值就没了。
   */
  function onDraftChoice(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value
    draftChoice = value
    draftPick = applyChoice(value, draftChoices, draftPick, $effectiveDefaultAgentId ?? null)
  }

  async function refresh(): Promise<void> {
    if ($activeConversationId) {
      await openConversation($activeConversationId)
      await loadConversations()
    }
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (text === '' || sending) return
    errorText = ''

    if (drafting) {
      if (draftPick.agentId === '') {
        errorText = $t('chat.noExecutor')
        return
      }
      sending = true
      try {
        const out = await startConversation({
          agentId: draftPick.agentId,
          text,
          skillIds: draftPick.skillId === '' ? [] : [draftPick.skillId],
          // 空 = 平台自动分配：**不传** `workDir`（`exactOptionalPropertyTypes`
          // 下显式传 undefined 是非法的；省略才是"没设"）。
          ...(draftWorkDir.trim() === '' ? {} : { workDir: draftWorkDir.trim() }),
        })
        drafting = false
        input = ''
        chatLiveRunId.set(out.runId)
        if (out.runId === null) errorText = out.turn.error ?? ''
      } catch (err) {
        errorText = err instanceof Error ? err.message : String(err)
      } finally {
        sending = false
      }
      return
    }

    const id = $activeConversationId
    if (!id) return
    sending = true
    input = ''
    // 乐观插入：这一句立刻出现在屏幕上（见 `pendingText` 的说明）。
    pendingText = text
    try {
      const out = await sendChatTurn(id, text)
      chatLiveRunId.set(out.runId)
      if (out.runId === null) {
        errorText = out.turn.error ?? $t('chat.turnFailed')
      }
      await refresh()
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
      // 失败时**把那句话还给输入框**：它是使用者打的字，而屏幕上那条占位
      // 马上会被清掉——不还回去的话，他得重新打一遍。
      input = text
      await refresh()
    } finally {
      pendingText = ''
      sending = false
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // ★ Enter 发送 / Shift+Enter 换行 —— 与「新建任务」的「要做什么」**正好相反**
    //   （那边 Enter 换行）。聊天是回合制的输入框，这里是通行惯例；两处的差别
    //   都写在各自的输入框下面，靠位置猜是不负责任的。
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  async function stop(runId: string): Promise<void> {
    try {
      await api(`/api/runs/${runId}/cancel`, { method: 'POST' })
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
    }
    chatLiveRunId.set(null)
    await refresh()
  }

  function renderedFor(turn: ChatTurnView): string {
    if (!turn.output) return ''
    return renderMarkdown(turn.output, {
      resolveAsset: (href: string) =>
        /^https?:/i.test(href) ? href : `/api/runs/${turn.runId}/file?path=${encodeURIComponent(href)}`,
    })
  }

  async function saveTitle(): Promise<void> {
    const id = $activeConversationId
    const title = renameValue.trim()
    renaming = false
    if (!id || title === '' || title === activeConversation?.title) return
    try {
      await renameConversation(id, title)
      // ★ 保存成功要有反馈：其它每一处保存（智能体详情、新建智能体、工作区设置）
      //   都弹一句，这里原来**什么都不说**——而"改了名之后界面还是旧名字"
      //   （列表刷新慢一拍）看起来就是没保存上。
      showToast($t('chat.renamed'))
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
    }
  }

  async function remove(id: string): Promise<void> {
    if (!id) return
    // ★ 平台自己的确认框（居中），不是 `window.confirm`——理由见 `lib/confirm.ts`
    if (
      !(await askConfirm({
        title: $t('chat.delete'),
        message: $t('chat.deleteConfirm'),
        confirmLabel: $t('chat.deleteConfirmYes'),
        danger: true,
      }))
    )
      return
    try {
      await deleteConversation(id)
      showToast($t('chat.deleted'))
      // 删的是当前正在看的对话：落到列表第一个，或直接开始新对话
      if (id === $activeConversationId) {
        if ($conversations.length > 0) await openConversation($conversations[0]!.id)
        else startDrafting()
      }
    } catch (err) {
      errorText = err instanceof Error ? err.message : String(err)
    }
  }

  async function select(id: string): Promise<void> {
    if (id === $activeConversationId && !drafting) return
    drafting = false
    pendingText = ''
    errorText = ''
    chatLiveRunId.set(null)
    await openConversation(id)
  }

</script>

<div class="split-layout">
  <!-- ══════════ 左：对话列表（D66：栏头带 + 五态壳在 ListPane 里）══════════ -->
  <ListPane
    countLabel={$t('chat.listCount', { count: visibleConversations.length })}
    searchPlaceholder={$t('chat.search')}
    filter={chatFilter}
    onFilter={(v) => (chatFilter = v)}
    loading={($loading.conversations && $conversations.length === 0) ?? false}
    loadError={$loadError.conversations ?? null}
    empty={$conversations.length === 0}
    emptyTitle={$t('chat.empty')}
    emptyHint={$t('chat.emptyHint')}
    emptyFiltered={visibleConversations.length === 0}
    emptyFilteredTitle={$t('chat.emptyFiltered')}
    emptyFilteredHint={$t('chat.emptyFilteredHint')}
  >
    {#snippet rows()}
      <ul class="conv-list">
        {#each visibleConversations as conversation (conversation.id)}
          <ListRow
            rowClass="conv-row"
            active={!drafting && conversation.id === $activeConversationId}
            onclick={() => void select(conversation.id)}
          >
            {#snippet children()}
              <!-- ★ `title` 必须有：这一格是单行省略的，没有它标题一长就**永远看不全**
                 （任务列表、技能/工具的名称列都有） -->
              <span class="conv-title" title={conversation.title}>{conversation.title}</span>
              <!-- ★ 「N 轮 · 最近 X 分钟前」：轮数说明它有多重，相对时间说明
                   它有多旧——两者一起才是「这一条还值不值得点开」的答案。
                   ⚠️ 这句用的是 `chat.summary`，它**一直存在却没人用**：原本就
                   打算显示，只是没接上（`relativeTime` 同样是死导入）。
                   准确时间在 `title` 里（列表只需要量级）。 -->
              <span
                class="conv-sub faint small"
                title={conversation.lastTurnAt === null
                  ? $t('chat.neverUsed')
                  : absoluteTime(conversation.lastTurnAt)}
              >
                {agentNames.get(conversation.agentId) ?? '—'} ·
                {conversation.turnCount === 0 || conversation.lastTurnAt === null
                  ? $t('chat.neverUsed')
                  : $t('chat.summary', {
                      turns: conversation.turnCount,
                      when: relativeTime(conversation.lastTurnAt, now),
                    })}
              </span>
            {/snippet}
            {#snippet action()}
              <button
                type="button"
                class="list-row-action"
                title={$t('chat.delete')}
                aria-label={$t('chat.delete')}
                onclick={() => void remove(conversation.id)}
              >
                ×
              </button>
            {/snippet}
          </ListRow>
        {/each}
      </ul>
    {/snippet}
  </ListPane>

  <!-- ══════════ 右：消息流 ══════════ -->
    <!-- ★ 右主区（D69.15）：壳 / 栏头 / 空态统一在 MainArea。
         聊天三态：草稿（简单栏头+表单）/ 没选中（空态）/ 对话（chat-head 改名形态
         + 工作目录 + 消息流 + 文件树 + 输入条）。栏头与输入条都是**特殊情况**：
         · 栏头走 head snippet（改名输入要替换 h2、pane-actions 是兄弟元素，塞不进
           结构化 back/title/sub/actions）；
         · 输入条在草稿与对话**两支都在**（D46/D58 的教训：新对话选完执行者必须
           能说第一句话），走 foot snippet 且在空态不渲染。 -->
    <MainArea
      empty={!drafting && activeConversation === null}
      emptyTitle={$t('chat.noSelection')}
      bodyClass={activeConversation !== null ? 'chat-stream' : ''}
    >
      {#snippet head()}
        {#if drafting}
          <div class="pane-head">
            <h2>{$t('chat.newConversation')}</h2>
          </div>
        {:else if activeConversation !== null}
      <div class="pane-head chat-head">
        <div class="chat-head-main">
          {#if renaming}
            <input
              class="rename-input"
              bind:value={renameValue}
              autocomplete="off"
              aria-label={$t('chat.rename')}
              onkeydown={(e) => {
                if (e.key === 'Enter') void saveTitle()
                if (e.key === 'Escape') renaming = false
              }}
            />
            <button onclick={() => void saveTitle()}>{$t('chat.renameSave')}</button>
            <button class="ghost" onclick={() => (renaming = false)}>{$t('chat.renameCancel')}</button>
          {:else}
            <h2>{activeConversation.title}</h2>
            <button
              class="ghost"
              onclick={() => {
                renameValue = activeConversation.title
                renaming = true
              }}>{$t('chat.rename')}</button
            >
          {/if}
          <span class="detail-sub">
            {agentOfActive?.name ?? '—'} ·
            {activeConversation.turnCount === 0
              ? $t('chat.neverUsed')
              : $t('chat.turnCount', { count: activeConversation.turnCount })}{#if activeSkillSlugs.length > 0}
              · {activeSkillSlugs.join(' + ')}{/if}
          </span>
        </div>
        <div class="pane-actions">
          <button class="danger" onclick={() => void remove($activeConversationId ?? '')}>
            {$t('chat.delete')}
          </button>
        </div>
      </div>

      <!--
        工作目录**只读**（2026-10）：它只在「新对话」界面上设定，对话开始后不再
        能改——改目录等于把"这次对话在哪个目录里干的活"变成不确定的，而回看时
        列出的文件、路径都指着旧目录。这里只回答"这个对话的目录是哪个"。
      -->
      <div class="chat-dir">
        <span class="faint small">{$t('chat.workDirLabel')}</span>
        <code class="mono small">{actualWorkDir ?? $t('chat.notRunYet')}</code>
      </div>
      <p class="chat-dir-hint faint small">{$t('chat.workDirWarning')}</p>
        {/if}
      {/snippet}
      {#snippet body()}
        {#if drafting}
        <label for="chat-agent">{$t('chat.agentLabel')}</label>
        <select id="chat-agent" value={draftChoice} onchange={onDraftChoice}>
          <optgroup label={$t('chat.agentGroup')}>
            {#each agentChoices as choice (choice.value)}
              <option value={choice.value}>{agentNames.get(choice.agentId) ?? '—'}</option>
            {/each}
          </optgroup>
          {#if skillChoices.length > 0}
            <optgroup label={$t('chat.skillGroup')}>
              {#each skillChoices as choice (choice.value)}
                <option value={choice.value}>
                  {choice.agentId === ''
                    ? $t('chat.skillOptionSelf', { skill: choice.skill?.slug ?? '' })
                    : $t('chat.skillOptionOwned', {
                        skill: choice.skill?.slug ?? '',
                        agent: agentNames.get(choice.agentId) ?? '—',
                      })}
                </option>
              {/each}
            </optgroup>
          {/if}
        </select>
        {#if executors.length === 0}
          <p class="notice warn">{$t('chat.noExecutor')}</p>
        {/if}
        {#if heldBackSkills.length > 0}
          <p class="hint" data-skills-need-restart>
            {$t('chat.skillsNeedRestart', {
              skills: heldBackSkills.map((s) => s.slug).join(', '),
            })}
          </p>
        {/if}
        <p class="hint">{$t('chat.agentHint')}</p>
        <!--
          工作目录（2026-10 起**只在这里设**）：建对话时定一次，之后详情页只读。
          留空 = 平台自动分配（`conversation.workDir = null`）；填了 = 接进你的
          仓库。风险披露在下面那行，不藏。
        -->
        <label for="chat-draft-workdir" class="draft-workdir-label">
          {$t('chat.draftWorkDirLabel')}
        </label>
        <input
          id="chat-draft-workdir"
          class="draft-workdir-input"
          bind:value={draftWorkDir}
          placeholder={$t('chat.workDirAuto')}
          autocomplete="off"
          spellcheck="false"
        />
        <p class="hint">{$t('chat.workDirAutoHint')}</p>
        <p class="hint">{$t('chat.workDirWarning')}</p>
        {#if draftSkill !== null}
          <p class="hint" data-skill-owner>
            {draftSkillOwned
              ? $t('chat.skillOwner', {
                  agent: agentNames.get(draftPick.agentId) ?? '—',
                  skill: draftSkill.slug,
                })
              : $t('chat.skillSelfCarried', {
                  agent: agentNames.get(draftPick.agentId) ?? '—',
                  skill: draftSkill.slug,
                })}
          </p>
        {/if}
        {#if errorText !== ''}
          <p class="notice bad">{errorText}</p>
        {/if}
        {:else if activeConversation !== null}
        {#if $loadError.chatDetail}
          <p class="notice bad">{$loadError.chatDetail}</p>
        {/if}
        {#each activeTurns as turn (turn.id)}
          <article class="turn">
            <div class="who faint small">{$t('chat.you')}</div>
            <div class="bubble user">{turn.userText}</div>

            {#if turn.error !== null}
              <p class="notice warn">
                <strong>{$t('chat.turnFailed')}</strong>
                — {turn.error}
              </p>
            {/if}

            {#if turn.runId !== null}
              {#if isTurnRunning(turn)}
                <div class="who faint small">
                  {agentOfActive?.name ?? '—'} · {$t('chat.running')}
                  <button class="ghost stop" onclick={() => void stop(turn.runId!)}>
                    {$t('chat.stop')}
                  </button>
                </div>
                <RunLog
                  runId={turn.runId}
                  onterminal={() => {
                    // 一轮跑完顺手把目录那一栏重取一次：它这一轮多半写了点什么
                    filesTick += 1
                    void refresh()
                  }}
                />
              {:else}
                <div class="who faint small">
                  {agentOfActive?.name ?? '—'}
                  {#if turn.toolCount > 0}· {$t('chat.toolsUsed', { count: turn.toolCount })}{/if}
                  {#if turn.durationMs !== null}
                    · {$t('chat.duration', { seconds: Math.round(turn.durationMs / 1000) })}
                  {/if}
                </div>
                {#if turn.output}
                  <article class="bubble agent markdown">{@html renderedFor(turn)}</article>
                {:else if turn.status !== null && turn.status !== 'completed'}
                  <!-- ★ 状态走词表（`term.runStatus.*`），**不摊协议英文值**：
                       原来这里直接显示 `failed` / `cancelled`，中文界面上
                       是一串英文。与任务详情的执行记录徽标同一套词条。 -->
                  <p class="notice bad">
                    {$t(`term.runStatus.${turn.status}` as WebTextId)}
                  </p>
                {:else}
                  <p class="faint small">{$t('chat.noOutput')}</p>
                {/if}
              {/if}
            {/if}
          </article>
        {/each}

        {#if pendingText !== ''}
          <article class="turn">
            <div class="who faint small">{$t('chat.you')}</div>
            <div class="bubble user pending">{pendingText}</div>
            <p class="faint small">{$t('chat.sending')}</p>
          </article>
        {/if}
        {/if}
      {/snippet}
      {#snippet foot()}
        {#if activeConversation !== null && filesState !== 'hidden'}
        <section class="chat-files" data-chat-files>
          <div class="chat-files-head">
            <button
              type="button"
              class="ghost"
              aria-expanded={filesOpen}
              onclick={() => (filesOpen = !filesOpen)}
            >
              <span class="twisty">{filesOpen ? '▾' : '▸'}</span>
              {$t('files.heading')}
              {#if filesCount > 0}
                <span class="faint small">{$t('chat.filesCount', { count: filesCount })}</span>
              {/if}
            </button>
            {#if filesOpen && filesState === 'ready'}
              <button type="button" class="ghost" onclick={() => (filesTick += 1)}>
                {$t('chat.filesRefresh')}
              </button>
              {#if runningTurn !== null}
                <span class="faint small">{$t('chat.filesRunningHint')}</span>
              {/if}
            {/if}
          </div>
          {#if filesState === 'unsupported'}
            {#if filesOpen}
              <p class="hint" data-files-need-restart>{$t('chat.filesNeedRestart')}</p>
            {/if}
          {:else}
            <!--
              ★ 树**一直挂着**（收起时只是藏起来），不随展开才挂载：
                头部那一行要写出「N 项」，而条数只有树自己知道。收起时不显示、
                但仍然取一次顶层——这一次请求换来的是"值不值得点开"这个判断，
                而它正是默认收起这一档最需要的信息。
              ⚠️ 用 `hidden` 而不是 `{#if}`：`{#if}` 会把它卸载掉，条数跟着没了。
            -->
            <div hidden={!filesOpen}>
              <WorkDirTree
                base={`/api/conversations/${activeConversation?.id ?? ''}`}
                reloadKey={filesReloadKey}
                bind:count={filesCount}
              />
              <p class="hint">{$t('chat.filesNotAnAction')}</p>
            </div>
          {/if}
        </section>
        {/if}
        {#if drafting || activeConversation !== null}
      <div class="pane-foot chat-composer">
        {#if errorText !== ''}
          <p class="notice bad">{errorText}</p>
        {/if}
        <textarea
          bind:value={input}
          rows="3"
          placeholder={$t('chat.placeholder')}
          onkeydown={onKeydown}
          disabled={runningTurn !== null}
        ></textarea>
        <div class="composer-row">
          <span class="faint small">
            {#if runningTurn !== null}
              {$t('chat.running')}
            {:else}
              {$t('chat.enterHint')}
            {/if}
          </span>
          <button
            disabled={!canSend}
            title={canSend ? undefined : $t('chat.sendNotReady')}
            onclick={() => void send()}
          >{$t('chat.send')}</button>
        </div>
      </div>
        {/if}
      {/snippet}
    </MainArea>
</div>

<style>
  .chat-files {
    border-top: 1px solid var(--line);
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
  }

  .chat-files-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .chat-files-head .ghost {
    padding: var(--sp-1) var(--sp-2);
  }

  /* 展开箭头定宽：不定宽时，标题会随着 ▸/▾ 的宽度差左右抖 */
  .chat-files .twisty {
    display: inline-block;
    width: 0.75rem;
    color: var(--text-faint);
  }

  /*
    ★ 2026-10（紧凑性）：原来 `.list-pane` 有 `max-width: 22rem`，而 `.split-layout`
      的 grid 第一列是 `minmax(20rem, 26rem)`——宽窗口下列是 416px，列表栏却只
      画到 352px，右侧空出一整条 64px 的 grid 列（实测左栏右缘 592、右栏左缘 656）。
      选中框因此看起来"宽度不够"。去掉 max-width，让列表栏占满自己的列（与
      Agents/Tasks 同一档 416px）。
  */
  .conv-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  /* ★ 整行可点 + 右侧独立删除按钮（与「智能体」那栏的 `.agent-row` 同形）。
       按钮里套按钮是非法结构，所以容器是 `li`，里面放主按钮 + 兄弟删除按钮。 */
  /* ★ 选中框画在**容器 `li`** 上（背景 + `--accent` 描边），与任务页
     `.task-row` / 智能体页 `.agent-row` 完全同形：三项列表的"当前选中"长得
     一模一样，连"框把右边的删除按钮一起圈进去"这一点都一致。
     ⚠️ 描边色原来写在里面的按钮上、用的是 `--line-strong`（灰）——那是**唯一**
     一处这样写的，于是聊天栏的选中框与另外两栏不一样（颜色不同、范围也不同）。 */
  /* 删除按钮：默认几乎不可见，hover 才露出危险色——扫列表时不该被一排 × 吵到 */
  .conv-title {
    /* D65：标题与任务/智能体同一档（`--fs-base` 继承 + 600）——原来 fs-sm/常规，
       三页标题字号字重各不一样（实测 13/400、14/600、14/700）。 */
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conv-sub {
    display: block;
  }

  .chat-head {
    align-items: flex-start;
    gap: var(--sp-2);
  }

  .chat-head-main {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }

  .rename-input {
    min-width: 14rem;
  }

  /* D69.15.2 栏头标题对齐：默认的 ghost 按钮（垂直 padding 8px×2，高 38px）和
     input（自带内边距，高 ~31px）在 baseline 对齐里是**行里最高的**，把 h2 往下
     顶（实测标题 top 75 vs 任务/智能体的 68——"Title 高度不一样"的第二个出处）。
     压到与标题同高（竖 padding 归零、input 字号对齐 fs-lg），行高=标题高，标题
     回到栏头顶部 16px 那一档。 */
  .chat-head-main .ghost {
    padding-top: 0;
    padding-bottom: 0;
  }
  .rename-input {
    padding-top: 0;
    padding-bottom: 0;
    font-size: var(--fs-lg);
  }

  .chat-dir {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    padding: 0 var(--sp-4);
    margin-top: var(--sp-1);
  }

  .chat-dir-hint {
    margin: var(--sp-1) var(--sp-4) 0;
  }

  /* 「新对话」界面上的工作目录设定：与上面那个执行者选择器同一节奏 */
  .draft-workdir-label {
    margin-top: var(--sp-3);
  }

  /* D69.15：`.chat-stream` 打在 MainArea 渲染的 pane-body 上（bodyClass），
     scoped 样式跨不过组件边界——:global 才能命中（与 Tasks 的 log-mode 同一处理） */
  :global(.chat-stream) {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    overflow-y: auto;
  }

  .turn {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }

  .who {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  /**
   * ⚠️ 圆角用令牌（8px），不用那种 100px 的"胶囊"：
   *    气泡动辄好几行，大圆角在多行文本上会变成两条夸张的弧线，
   *    看起来像渲染坏了（项目里已经因为同一个原因改过一次 chips）。
   */
  .bubble {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
    line-height: var(--lh-base);
    white-space: pre-wrap;
    word-break: break-word;
    min-width: 0;
  }

  .bubble.user {
    background: var(--surface-2);
    align-self: flex-end;
    max-width: 85%;
  }

  .bubble.agent {
    background: var(--surface);
  }

  .bubble.pending {
    opacity: 0.6;
  }

  /* Markdown 气泡里不要 pre-wrap——块级元素自己管换行，留着会多出一堆空行 */
  .bubble.markdown {
    white-space: normal;
  }

  .bubble.markdown :global(p) {
    margin: 0 0 var(--sp-2);
  }

  .bubble.markdown :global(p:last-child) {
    margin-bottom: 0;
  }

  .bubble.markdown :global(pre) {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    overflow-x: auto;
  }

  .stop {
    margin-left: auto;
  }

  .chat-composer {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .chat-composer textarea {
    width: 100%;
    resize: vertical;
    max-height: calc(15lh + 1.6rem);
  }

  .composer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }
</style>
