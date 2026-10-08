<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    agents,
    deleteGroup,
    groups,
    identity,
    loadGroups,
    loadError,
    loading,
    saveGroup,
    skills,
    updateAgent,
    type AgentGroupView,
  } from '../lib/stores.ts'
  import type { GroupCreateAgentDraft } from '../lib/api.ts'
  import MainArea from '../components/MainArea.svelte'
  import ListPane from '../components/ListPane.svelte'
  import ListRow from '../components/ListRow.svelte'
  import ActionPicker from '../components/ActionPicker.svelte'
  import MemberSlotForm from '../components/MemberSlotForm.svelte'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { t, tx } from '../lib/i18n.ts'

  /**
   * 智能体组视图（D70 增量添加；第二轮起支持工作流模式 + 私有成员）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 与「智能体」是两个页面（设计稿 §7.1）
   * ══════════════════════════════════════════════════════════════════
   *
   * · 智能体页 = **灵活性**：每个人的指令 / 角色 / 用哪个 CLI / 由谁审它；
   * · 组页    = **方便性**：一条「执行 → 审核 → 行动 → 返工」整链的默认配置，
   *   新建任务时一下选走。
   *
   * ══════════════════════════════════════════════════════════════════
   * 工作流模式的成员（第二轮）
   * ══════════════════════════════════════════════════════════════════
   *
   * 每个槽（执行者 / 审核者）两种来源：
   *   · 选已有的（全局智能体）；
   *   · 新建私有（归属这个组的智能体：不进全局列表、不能被别的组引用、随组删）。
   * 私有成员用内联小表单（表单收敛：名字 + 指令/审核标准 + runtime + 可选技能），
   * 保存时交给 daemon 的 `createAgents` 一次建好；已存在的私有成员在这里编辑
   * （PATCH `/api/agents/:id`）。
   *
   * ⚠️ 形态仍是 1 执行 + 1 审核（`checkGroupShape` 在写入前拒其它形态），这里
   *    不给"多选"的选项，别让人白试一次。
   *
   * ⚠️ 老 daemon（没有 `agent-groups-workflow` 能力）：`ownerGroupId` 会被静默
   *    忽略、把私有建成全局的——所以「新建私有」只在能力标志在的时候给出来。
   */

  /** 当前点开查看的组。null = 还没选（右栏占位）。 */
  let selectedId: string | null = null
  let creating = false
  /** 页面级动作失败（保存 / 删除失败要看得见，不能只写 console）。 */
  let actionError = ''

  $: selected = $groups.find((g) => g.id === selectedId) ?? null

  /** 栏头带的搜索（与任务/智能体同款）：只过滤组名。 */
  let filter = ''
  $: visibleGroups = $groups.filter((g) => {
    if (!filter.trim()) return true
    return g.name.toLowerCase().includes(filter.trim().toLowerCase())
  })

  // ══════════════ 成员槽（全局选 / 私有建） ══════════════

  /** 第二轮：daemon 支持工作流模式（私有成员）才给「新建私有」。 */
  $: workflowSupported = ($identity?.capabilities ?? []).includes('agent-groups-workflow')

  interface PrivateDraft {
    /** 已存在的私有 agent id；`null` = 还没建的新草稿。 */
    id: string | null
    name: string
    instructions: string
    /** 审核标准**正文**（平台侧 ReviewStandard 只有 body——name 早已删掉）。 */
    standard: string
    runtimeKey: string
    skillIds: string[]
  }

  interface MemberSlot {
    source: 'global' | 'private'
    /** source === 'global' 时选中的全局 agent id。 */
    globalId: string
    /** source === 'private' 时的私有草稿 / 编辑中的私有成员。 */
    privateDraft: PrivateDraft
  }

  function emptyPrivateDraft(runtimeKey: string): PrivateDraft {
    return { id: null, name: '', instructions: '', standard: '', runtimeKey, skillIds: [] }
  }

  let execSlot: MemberSlot = { source: 'global', globalId: '', privateDraft: emptyPrivateDraft('claude') }
  let revSlot: MemberSlot = { source: 'global', globalId: '', privateDraft: emptyPrivateDraft('claude') }

  const slotOf = (which: 'exec' | 'rev'): MemberSlot => (which === 'exec' ? execSlot : revSlot)
  function setSlot(which: 'exec' | 'rev', next: MemberSlot): void {
    if (which === 'exec') execSlot = next
    else revSlot = next
  }
  function setSource(which: 'exec' | 'rev', source: 'global' | 'private'): void {
    const slot = slotOf(which)
    // ★ 已有私有成员不能切回「选已有的」：这轮组里没有"移除成员"（删组才一起
    //   删私有），切走它等于静默丢弃一个归属本组的智能体。
    if (source === 'global' && slot.source === 'private' && slot.privateDraft.id) {
      actionError = tx('groups.privateCannotSwitchBack')
      return
    }
    setSlot(which, { ...slot, source, globalId: slot.globalId, privateDraft: slot.privateDraft })
  }
  function patchPrivate(which: 'exec' | 'rev', patch: Partial<PrivateDraft>): void {
    const slot = slotOf(which)
    setSlot(which, { ...slot, privateDraft: { ...slot.privateDraft, ...patch } })
  }

  // ══════════════ 表单草稿 ══════════════
  let draftId: string | null = null
  let draftName = ''
  let draftActions: string[] = []
  let draftParams: Record<string, Record<string, unknown>> = {}
  let draftDebug: string[] = []
  let draftRework = 0
  /**
   * 「行动权限」那段默认**收起来**（多数组不配动作，展开的 ActionPicker 是噪音）。
   * 展开与否用同款小按钮让使用者选：不配动作（收）/ 配动作（展）。
   */
  let actionsOpen = false
  let draftError = ''

  /**
   * 返工次数选项（2026-09 拍板）：0 / 5 / 10 / 20 / 50 / 100 / 无限。
   *
   * ⚠️ `-1` 是 UI 里"无限"的哨兵值——`<select>` 只能绑数值，`null` 会被
   *    Svelte 序列化成字符串 "null"；到协议边界（`saveGroup`）才转成 `null`
   *    （协议里 `null` = 无限返工，见 `AgentGroup.maxReworks`）。
   */
  const REWORK_CHOICES = [0, 5, 10, 20, 50, 100, -1] as const

  /** 执行者候选：全局池里 role === 'executor'。 */
  $: executorOptions = $agents.filter((a) => a.role === 'executor')
  /** 审核者候选：全局池里 role === 'reviewer'，且 ≠ 当前全局执行者（INV-1）。 */
  $: reviewerOptions = $agents.filter(
    (a) => a.role === 'reviewer' && a.id !== (execSlot.source === 'global' ? execSlot.globalId : ''),
  )
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? ['claude']

  /** 一个私有草稿在保存时会不会被当成"新成员"（id 为 null 才走 createAgents）。 */
  function isNewDraft(slot: MemberSlot): boolean {
    return slot.source === 'private' && slot.privateDraft.id === null
  }

  function openCreate(): void {
    creating = true
    selectedId = null
    draftId = null
    draftName = ''
    // ★ 新建默认**不预选**：两个槽都停在「选一个」占位，让使用者明确地选
    //   （预选第一个容易"没注意就建了一个用错人的组"）。
    execSlot = { source: 'global', globalId: '', privateDraft: emptyPrivateDraft(runtimeOptions[0] ?? 'claude') }
    revSlot = { source: 'global', globalId: '', privateDraft: emptyPrivateDraft(runtimeOptions[0] ?? 'claude') }
    draftActions = []
    draftParams = {}
    draftDebug = []
    draftRework = 0
    // 新建默认**收起**行动权限（大多数组不需要自定义动作）。
    actionsOpen = false
    draftError = ''
    actionError = ''
  }

  function openExisting(id: string): void {
    creating = false
    selectedId = id
    const g = $groups.find((x) => x.id === id)
    if (!g) return
    draftId = g.id
    draftName = g.name
    const fill = (which: 'exec' | 'rev', role: 'executor' | 'reviewer'): void => {
      // ★ 成员从组的 `memberAgents` 里找（第二轮起）：私有成员不在全局 `$agents`。
      const member = g.memberAgents.find((m) => m.role === role)
      if (!member) {
        // 成员被删：槽留空（保存时会被"需要成员"拦住，把话说在前头）
        setSlot(which, { source: 'global', globalId: '', privateDraft: emptyPrivateDraft(runtimeOptions[0] ?? 'claude') })
        return
      }
      // 私有成员（ownerGroupId === 这个组）→ 进私有槽，可编辑；
      // 全局成员 → 全局槽。
      if (member.ownerGroupId === g.id) {
        setSlot(which, {
          source: 'private',
          globalId: '',
          privateDraft: {
            id: member.id,
            name: member.name,
            instructions: member.instructions,
            standard: member.reviewStandard?.body ?? '',
            runtimeKey: member.runtimeKey,
            skillIds: [...member.skillIds],
          },
        })
      } else {
        setSlot(which, { source: 'global', globalId: member.id, privateDraft: emptyPrivateDraft(runtimeOptions[0] ?? 'claude') })
      }
    }
    fill('exec', 'executor')
    fill('rev', 'reviewer')
    draftActions = [...g.allowedActions]
    draftParams = structuredClone(g.actionParams)
    draftDebug = [...g.debugActions]
    draftRework = g.maxReworks === null ? -1 : g.maxReworks
    // ★ 编辑时：组里**本来就有**动作（或参数/调试）⇒ 直接展开，别让使用者以为
    //   配置丢了；没有 ⇒ 保持收起（与新建同款默认）。
    actionsOpen = g.allowedActions.length > 0 || Object.keys(g.actionParams).length > 0 || g.debugActions.length > 0
    draftError = ''
    actionError = ''
  }

  function refresh(): void {
    void loadGroups()
  }

  /** 私有槽的校验（保存前）：审核者必须有审核标准——否则它拿不到审核任务。 */
  function privateSlotError(which: 'exec' | 'rev', role: 'executor' | 'reviewer'): string {
    const slot = slotOf(which)
    if (slot.source !== 'private') return ''
    if (slot.privateDraft.name.trim() === '') return tx('groups.needMembers')
    if (role === 'reviewer' && slot.privateDraft.standard.trim() === '') {
      return tx('groups.privateReviewerNeedsStandard')
    }
    return ''
  }

  async function save(): Promise<void> {
    draftError = ''
    const name = draftName.trim()
    if (!name) {
      draftError = tx('groups.needName')
      return
    }
    // 两个槽都要有确定成员；私有槽还要过它自己的校验。
    if (!execSlot.globalId && !isNewDraft(execSlot)) {
      draftError = tx('groups.needMembers')
      return
    }
    if (!revSlot.globalId && !isNewDraft(revSlot)) {
      draftError = tx('groups.needMembers')
      return
    }
    for (const [which, role] of [
      ['exec', 'executor'],
      ['rev', 'reviewer'],
    ] as const) {
      const err = privateSlotError(which, role)
      if (err) {
        draftError = err
        return
      }
    }
    // 调试动作必须 ⊆ 允许的动作（服务端会拒，这里先说明白）。
    const notAllowed = draftDebug.filter((a) => !draftActions.includes(a))
    if (notAllowed.length > 0) {
      draftError = tx('groups.debugNotAllowed', { actions: notAllowed.join('、') })
      return
    }
    try {
      // 1) 编辑已有的私有成员：改 agent 本体（归属不可改，走 PATCH /api/agents/:id）。
      for (const slot of [execSlot, revSlot]) {
        if (slot.source === 'private' && slot.privateDraft.id) {
          await updateAgent(slot.privateDraft.id, {
            name: slot.privateDraft.name.trim(),
            instructions: slot.privateDraft.instructions,
            reviewStandard: slot.privateDraft.standard.trim() ? { body: slot.privateDraft.standard.trim() } : null,
            runtimeKey: slot.privateDraft.runtimeKey,
            skillIds: slot.privateDraft.skillIds,
          })
        }
      }
      // 2) 组保存：members = 全局槽 + 已有私有成员；createAgents = 新私有草稿。
      const members: string[] = []
      const createAgents: GroupCreateAgentDraft[] = []
      for (const [slot, role] of [
        [execSlot, 'executor'],
        [revSlot, 'reviewer'],
      ] as const) {
        if (slot.source === 'global') {
          if (slot.globalId) members.push(slot.globalId)
        } else if (slot.privateDraft.id) {
          members.push(slot.privateDraft.id)
        } else {
          createAgents.push({
            name: slot.privateDraft.name.trim(),
            role,
            instructions: slot.privateDraft.instructions,
            reviewStandard: slot.privateDraft.standard.trim() ? { body: slot.privateDraft.standard.trim() } : null,
            runtimeKey: slot.privateDraft.runtimeKey,
            skillIds: slot.privateDraft.skillIds,
          })
        }
      }
      const saved = await saveGroup({
        // `exactOptionalPropertyTypes`：新建（没 id）时整个键不出现。
        ...(draftId ? { id: draftId } : {}),
        name,
        members,
        ...(createAgents.length > 0 ? { createAgents } : {}),
        allowedActions: draftActions,
        actionParams: draftParams,
        debugActions: draftDebug,
        // UI 哨兵 `-1`（无限）→ 协议 `null`；其余原样。
        maxReworks: draftRework === -1 ? null : draftRework,
        // ★ 组**默认启用**，界面不给开关（使用者拍板）：无论新建还是编辑，都
        //   存成启用——编辑时也顺带把老数据里停用的组重新启用（没有界面能再把它
        //   关掉，留一个"界面救不回来"的状态才是坑）。
        enabled: true,
      })
      actionError = ''
      // 保存成功后留在原地（继续看/改），列表跟着 `loadGroups` 刷新。
      if (saved) {
        selectedId = saved.id
        creating = false
      } else if (draftId) {
        selectedId = draftId
      }
    } catch (err) {
      draftError = err instanceof Error ? err.message : String(err)
    }
  }

  /** 删组前的确认：把「会一起删 N 个私有智能体」讲在前头（使用者拍板"提示后一起删"）。 */
  function confirmMessage(g: AgentGroupView): string {
    const privateCount = g.memberAgents.filter((m) => m.ownerGroupId === g.id).length
    const base = tx('groups.confirmDeleteBody', { name: g.name })
    return privateCount > 0 ? `${base} ${tx('groups.confirmDeletePrivate', { n: privateCount })}` : base
  }

  async function remove(): Promise<void> {
    if (!draftId) return
    const g = $groups.find((x) => x.id === draftId)
    if (
      !(await askConfirm({
        title: tx('groups.confirmDeleteTitle'),
        message: g ? confirmMessage(g) : '',
        confirmLabel: tx('groups.deleteConfirm'),
      }))
    ) {
      return
    }
    try {
      await deleteGroup(draftId)
      selectedId = null
      creating = false
      actionError = ''
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }

  $: setPageActions('groups', [
    {
      id: 'new',
      label: $t('groups.newTitle'),
      kind: 'primary',
      icon: 'plus',
      disabled: creating,
      onActivate: openCreate,
    },
    {
      id: 'refresh',
      label: $t('common.refresh'),
      kind: 'secondary',
      icon: 'refresh',
      onActivate: refresh,
    },
  ])
  onDestroy(() => clearPageActions('groups'))
</script>

<div class="split-layout" class:with-detail={selected !== null || creating}>
  <!-- ══════════════════ 左栏：组清单 ══════════════════ -->
  <ListPane
    countLabel={$t('groups.listCount', { count: visibleGroups.length })}
    searchPlaceholder={$t('groups.search')}
    filter={filter}
    onFilter={(v) => (filter = v)}
    loading={($loading['groups'] && $groups.length === 0) ?? false}
    loadError={$loadError['groups'] ?? null}
    empty={$groups.length === 0}
    emptyTitle={$t('groups.emptyTitle')}
    emptyHint={$t('groups.emptyHint')}
    emptyFiltered={visibleGroups.length === 0}
    emptyFilteredTitle={$t('groups.emptyFiltered')}
    emptyFilteredHint={$t('groups.emptyFilteredHint')}
  >
    {#snippet loadingSkeleton()}
      <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
      <div class="skeleton" style="width:60%"></div>
    {/snippet}
    {#snippet rows()}
      <ul class="group-list">
        {#each visibleGroups as g (g.id)}
          {@const exec = g.memberAgents.find((a) => a.role === 'executor')}
          {@const rev = g.memberAgents.find((a) => a.role === 'reviewer')}
          <ListRow
            rowClass="group-row"
            active={g.id === selectedId}
            onclick={() => openExisting(g.id)}
          >
            {#snippet children()}
              <span class="group-line">
                <strong>{g.name}</strong>
                {#if !g.enabled}
                  <span class="badge bad">{$t('groups.disabledBadge')}</span>
                {/if}
              </span>
              <span class="group-notes faint small">
                <span class="group-notes-trunc">
                  {exec ? $t('groups.chainExecutor', { name: exec.name }) : $t('groups.memberMissing')}
                  <span class="arrow">→</span>
                  {rev ? rev.name : $t('groups.memberMissing')}
                  {#if rev?.ownerGroupId === g.id}
                    <span class="badge">{$t('groups.privateBadge')}</span>
                  {/if}
                </span>
                <span class="group-notes-meta">
                  {$t('groups.actionCount', { count: g.allowedActions.length })}
                  {g.maxReworks === null
                    ? $t('groups.reworkUnlimitedMeta')
                    : $t('groups.reworkMeta', { n: g.maxReworks })}
                </span>
              </span>
            {/snippet}
          </ListRow>
        {/each}
      </ul>
    {/snippet}
  </ListPane>

  <!-- ══════════════════ 右栏：选中的那个组 / 新建的表单 ══════════════════ -->
  <MainArea empty={!creating && selected === null}>
    {#snippet emptyContent()}
      <div class="empty">
        <strong>{$t('groups.pickOneTitle')}</strong>
        <p>{$t('groups.pickOneHint')}</p>
        <p>{$t('groups.pickOneHow')}</p>
      </div>
    {/snippet}
    {#snippet body()}
      {#if creating || selected}
        <form
          class="group-form"
          onsubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {#if actionError}
            <div class="notice bad">{actionError}</div>
          {/if}

          <!--
            ★ 组的模式（2026-10）：从静态 chip 改成与智能体「执行 / 审核」同款的
            选择按钮——使用者要求「选择方式类似于智能体选执行和审核一样」。
            目前唯一合法值就是「工作流」（`GroupMode` 枚举只有这一个），所以这颗
            按钮**常亮**；未来模式往枚举里加值时，这里多出按钮，mode 才进草稿。
          -->
          {#if workflowSupported}
            <div class="mode-line">
              <span class="mode-label">{$t('groups.modeLabel')}</span>
              <div class="mode-picker">
                <button type="button" class="role-card active">
                  <strong>{$t('groups.modeWorkflow')}</strong>
                  <span>{$t('groups.modeWorkflowHint')}</span>
                </button>
              </div>
            </div>
          {/if}

          <div class="name-line">
            <label>
              {$t('groups.nameLabel')}
              <input bind:value={draftName} placeholder={$t('groups.namePlaceholder')} required autocomplete="off" />
            </label>
          </div>

          <!-- ★ ① 执行：谁来做这件事（工作流的第一步） -->
          <div class="stage-head">
            <span class="stage-no">1</span>
            <strong class="stage-name">{$t('groups.stageExec')}</strong>
            <span class="stage-desc">{$t('groups.stageExecDesc')}</span>
          </div>

          <!-- ★ 形态是 1+1，所以就是两个槽；多成员是多执行者/多审核者的扩展（设计稿 §10）。
               每个槽两种来源：选已有的 / 新建私有（只在 daemon 支持时给）。 -->
          <MemberSlotForm
            label={$t('groups.executorLabel')}
            hint={$t('groups.executorHint')}
            member={execSlot}
            options={executorOptions}
            workflowSupported={workflowSupported}
            isReviewer={false}
            onSetSource={(s) => setSource('exec', s)}
            onGlobalPick={(id) => {
              // 执行者一换，审核者的全局候选跟着变（排除新执行者，INV-1）
              execSlot = { ...execSlot, globalId: id }
              if (revSlot.source === 'global' && !reviewerOptions.some((a) => a.id === revSlot.globalId)) {
                revSlot = { ...revSlot, globalId: reviewerOptions[0]?.id ?? '' }
              }
            }}
            onPatchPrivate={(p) => patchPrivate('exec', p)}
            runtimeOptions={runtimeOptions}
            skillsList={$skills}
            noSkillsText={$t('groups.privateNoSkills')}
            skillsLabel={$t('groups.privateSkillsLabel')}
            nameLabel={$t('groups.privateNameLabel')}
            runtimeLabel={$t('groups.privateRuntimeLabel')}
            instructionsLabel={$t('groups.privateInstructionsLabel')}
          />

          <!-- ★ ② 审核：谁把关；下面的「返工」跟着这一步走（不过就重做几次） -->
          <div class="stage-head">
            <span class="stage-no">2</span>
            <strong class="stage-name">{$t('groups.stageReview')}</strong>
            <span class="stage-desc">{$t('groups.stageReviewDesc')}</span>
          </div>

          <MemberSlotForm
            label={$t('groups.reviewerLabel')}
            hint={$t('groups.reviewerHint')}
            member={revSlot}
            options={reviewerOptions}
            workflowSupported={workflowSupported}
            isReviewer={true}
            onSetSource={(s) => setSource('rev', s)}
            onGlobalPick={(id) => (revSlot = { ...revSlot, globalId: id })}
            onPatchPrivate={(p) => patchPrivate('rev', p)}
            runtimeOptions={runtimeOptions}
            skillsList={$skills}
            noSkillsText={$t('groups.privateNoSkills')}
            skillsLabel={$t('groups.privateSkillsLabel')}
            nameLabel={$t('groups.privateNameLabel')}
            runtimeLabel={$t('groups.privateRuntimeLabel')}
            instructionsLabel={$t('groups.privateInstructionsLabel')}
            standardBodyLabel={$t('groups.privateStandardBodyLabel')}
          />

          <label>
            {$t('groups.reworkLabel')}
            <select bind:value={draftRework}>
              {#each REWORK_CHOICES as n (n)}
                <option value={n}>
                  {n === 0
                    ? $t('groups.reworkZero')
                    : n === -1
                      ? $t('groups.reworkUnlimited')
                      : $t('groups.reworkTimes', { n })}
                </option>
              {/each}
            </select>
            <span class="hint">{$t('groups.reworkHint')}</span>
          </label>

          <!-- ★ 组**默认启用**，没有"启用/停用"开关（使用者拍板）。daemon 在省略
               `enabled` 时默认 true；界面固定存启用。列表里"已停用"角标只会在
               老数据/接口造成的停用组上出现。 -->

          <!-- ★ ③ 行动：判完可以触发哪些动作（工作流的最后一步） -->
          <div class="stage-head">
            <span class="stage-no">3</span>
            <strong class="stage-name">{$t('groups.stageAct')}</strong>
            <span class="stage-desc">{$t('groups.stageActDesc')}</span>
          </div>

          <!-- ★ 组的「行动权限」：新建任务选了组之后，这就是那一栏的默认；
               与智能体页共用同一个 `ActionPicker`（同一套"动作来自已装包"的判据）。
               ⚠️ **默认收起**：多数组不配自定义动作，整段 ActionPicker 是噪音。
               展开与否用同款小按钮选——「不配动作」会清空已勾选（那是明说"这组
               默认不动作"），「配动作」才把选择器打开。 -->
          <div class="picker-wrap">
            <div class="slot-head">
              <span class="field-label">{$t('groups.actionsLabel')}</span>
              <div class="slot-source-toggle">
                <button
                  type="button"
                  class:active={!actionsOpen}
                  onclick={() => {
                    actionsOpen = false
                    draftActions = []
                    draftParams = {}
                    draftDebug = []
                  }}
                >
                  {$t('groups.actionsCollapsed')}
                </button>
                <button type="button" class:active={actionsOpen} onclick={() => (actionsOpen = true)}>
                  {$t('groups.actionsExpanded')}
                </button>
              </div>
            </div>
            {#if actionsOpen}
              <ActionPicker
                variant="agent"
                value={draftActions}
                onchange={(next) => {
                  draftActions = next
                  // 调试动作必须是白名单子集：把被摘掉的动作从调试里一起清掉。
                  draftDebug = draftDebug.filter((a) => next.includes(a))
                }}
                params={draftParams}
                onparams={(next) => (draftParams = next)}
                debug={draftDebug}
                ondebug={(next) => (draftDebug = next)}
              />
            {:else}
              <span class="hint">{$t('groups.actionsCollapsedHint')}</span>
            {/if}
          </div>

          {#if draftError}
            <div class="notice bad">{draftError}</div>
          {/if}

          <div class="form-actions">
            <button type="submit" class="primary">
              {draftId ? $t('groups.saveButton') : $t('groups.createButton')}
            </button>
            {#if draftId}
              <button type="button" class="ghost danger" onclick={() => void remove()}>
                {$t('groups.deleteButton')}
              </button>
            {/if}
            <button type="button" class="ghost" onclick={() => { creating = false; selectedId = null }}>
              {$t('common.cancel')}
            </button>
          </div>
        </form>
      {/if}
    {/snippet}
  </MainArea>
</div>

<style>
  .group-list {
    list-style: none;
    margin: 0 0 var(--sp-5);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .group-line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .group-line strong {
    font-weight: 600;
  }

  .group-notes {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
  }

  .group-notes-trunc {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-notes-meta {
    flex-shrink: 0;
  }

  .arrow {
    margin: 0 0.25em;
    opacity: 0.6;
  }

  .group-form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    /* ★ 宽度**拉通**：右栏是 `minmax(0,1fr)`，表单不再被 46rem 钉死，
       成员卡横贯整个右栏（窗口窄时自然收缩，不会溢出）。 */
    width: 100%;
    max-width: none;
  }

  .name-line {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-3);
  }

  .name-line label {
    flex: 1;
  }

  /* ── 模式（2026-10）：与智能体「执行/审核」同款的大按钮选择器 ── */

  .mode-line {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .mode-label {
    font-size: 0.9em;
    color: var(--text-faint);
  }

  /* 与智能体「执行/审核」同款的大按钮（结构、配色逐条对齐 `AgentDetail.svelte`
     的 `.role-card`）；目前只有一种模式，一颗按钮占满整行，未来多了自然分列。 */
  .mode-picker {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--sp-2);
  }

  .role-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    text-align: left;
    padding: var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
    cursor: default;
  }

  .role-card strong {
    color: var(--text);
    font-size: var(--fs-md);
  }

  .role-card span {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  .role-card.active {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .role-card.active strong {
    color: var(--accent);
  }

  /* ── 阶段头（2026-10）：①执行 / ②审核 / ③行动，把链的顺序钉进配置区 ── */

  .stage-head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    margin-top: var(--sp-1);
  }

  /* 编号徽章：accent-dim 底 + 白字（暗色主题下也看得清，与分段控件同款配色） */
  .stage-no {
    flex: none;
    align-self: center;
    min-width: 1.4rem;
    height: 1.4rem;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent-dim);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--fs-xs);
    font-weight: 700;
  }

  .stage-name {
    font-size: var(--fs-sm);
    font-weight: 700;
    color: var(--text);
  }

  .stage-desc {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  /**
   * 「组的行动权限」：与上面的成员卡（执行者 / 审核者）同款外框——
   * 使用者 2026-10 反馈"缺少一个类似上面审核者的外框"，补上同一套
   * `padding + border + radius`，整张表单看起来就是一个一个的框。
   */
  .picker-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--radius, 8px);
  }

  /* ── 「行动权限」的收起/展开二选一（2026-10：与顶栏「列表 / 看板」同款分段轨，
        与成员槽「选已有的/新建私有」、任务「智能体/智能体组」同一套样式） ── */
  .slot-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  .slot-source-toggle {
    display: flex;
    align-items: center;
    height: 1.9rem;
    box-sizing: border-box;
    padding: 0 var(--sp-1);
    gap: 2px;
    background: var(--line);
    border-radius: var(--radius);
  }

  .slot-source-toggle button {
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

  .slot-source-toggle button:hover:not(:disabled) {
    background: var(--surface);
    color: var(--text);
  }

  .slot-source-toggle button.active {
    /* ⚠️ 背景用 `--accent-dim` 而不是 `--accent`：暗色主题下 `--accent` 是**浅蓝**
       （#5aa9f5），白字配它看不见；`--accent-dim` 两种主题下都是深蓝，白字才读得
       出来（与顶栏激活按钮同一套惯例）。 */
    background: var(--accent-dim, #2f6fed);
    color: #fff;
  }

  .form-actions {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }
</style>
