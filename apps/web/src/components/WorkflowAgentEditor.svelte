<script lang="ts">
  /**
   * **编排内建智能体的编辑页**（2026-11，D237）。
   *
   * 使用者拍板两条：
   *   ① "编辑的时候，可以类似设置那样，直接跳转过去，然后可以返回回来"——
   *     所以它是一页（地址 `#/workflows/agents/<编排id>/<智能体id|new>`），不是就地展开；
   *   ② "要和智能体的编辑页一致（只是入口是固定的，只能有编排）"——
   *     所以骨架照 `AgentDetail.svelte`：`detail-head`（返回 / 标题 / 副题 / 动作）+
   *     `card.agent-card.pair-field` 里那几格（入口 / 指令 / 技能），控件用同一批。
   *
   * 与智能体编辑页**故意不同**的两处（都是因为内建智能体没有那些字段，不能造假）：
   *   · 没有「用哪个 CLI」那一格——`WorkflowInlineAgent` 没有 `runtimeKey`（跑的时候
   *     跟工作区默认）；
   *   · 没有「记忆」那一格——记忆按智能体 id 存在库里，内建智能体不在库里。
   *   入口那一格**留着但锁死**（只有「编排」一项，勾着、不可改）——这正是使用者说的
   *   "入口是固定的"。
   *
   * ⚠️ Svelte 5 legacy 模式（与 Workflows.svelte 同款约束）：不引 runes。
   */
  import { onMount } from 'svelte'
  import { t, tx } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import {
    api,
    type Skill,
    type Workflow,
    type WorkflowInlineAgent,
  } from '../lib/api.ts'
  import { skills, workflows } from '../lib/stores.ts'
  import { toast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import PromptField from './PromptField.svelte'

  export let workflowId: string
  /** `'new'` = 新建；否则是内建智能体的 id。 */
  export let agentId: string
  /** 保存/删除之后怎么回去（由页面决定：切地址 + 记住"回到哪条编排"）。 */
  export let ondone: () => void = () => {}

  let wf: Workflow | null = null
  let loadError = ''
  let loading = true
  /** 正在编辑的那一条（新建时是 `null`）。 */
  let original: WorkflowInlineAgent | null = null

  let name = ''
  let instructions = ''
  let selectedSkills: string[] = []
  let busy = false
  let error = ''
  /** 它目录下的独有技能（**只读**：写入口与技能页同款，二期接）。 */
  let exclusiveSkills: Array<{ name: string; description?: string }> = []

  $: wf = $workflows.find((w) => w.id === workflowId) ?? null
  $: isNew = agentId === 'new'
  $: pickableSkills = $skills ?? []

  /** 有改动才给保存（与智能体编辑页的脏态判定同一个口径）。 */
  $: dirty =
    isNew
      ? name.trim() !== '' || instructions.trim() !== '' || selectedSkills.length > 0
      : original !== null &&
        (name.trim() !== original.name ||
          instructions !== (original.instructions ?? '') ||
          !sameSet(selectedSkills, original.skillIds ?? []))

  $: canSave = !busy && name.trim() !== '' && dirty

  function sameSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    const s = new Set(b)
    return a.every((x) => s.has(x))
  }

  async function load(): Promise<void> {
    loading = true
    loadError = ''
    try {
      if ($workflows.length === 0) {
        // 直接打开编辑页（新标签 / 刷新）时列表可能还没拉过
        const out = await api<{ items: Workflow[] }>('/api/workflows')
        workflows.set(out.items ?? [])
      }
      const found = $workflows.find((w) => w.id === workflowId)
      if (!found) {
        loadError = tx('workflows.agentsWorkflowMissing')
        return
      }
      if (isNew) {
        original = null
        name = ''
        instructions = ''
        selectedSkills = []
        return
      }
      const target = (found.inlineAgents ?? []).find((a) => a.id === agentId) ?? null
      if (!target) {
        loadError = tx('workflows.agentsMissing')
        return
      }
      original = target
      name = target.name
      instructions = target.instructions ?? ''
      selectedSkills = [...(target.skillIds ?? [])]
      // 独有技能只读：目录是 `workflows/<id>/agents/<名字>/skills/`
      const out = await api<{ skills: Array<{ name: string; description?: string }> }>(
        `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}/skills`,
      )
      exclusiveSkills = out.skills ?? []
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }
  onMount(() => void load())

  async function save(): Promise<void> {
    if (!canSave) return
    busy = true
    error = ''
    try {
      const body = {
        name: name.trim(),
        instructions,
        skillIds: selectedSkills,
      }
      if (isNew) {
        await api(`/api/workflows/${encodeURIComponent(workflowId)}/agents`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      } else {
        await api(
          `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        )
      }
      // 界面跟着数据走：重拉列表（编排页那一节的计数/名字来自它）
      const out = await api<{ items: Workflow[] }>('/api/workflows')
      workflows.set(out.items ?? [])
      toast.set(tx('workflows.agentsSaved'))
      ondone()
    } catch (err) {
      // 服务端的原话照给（比如本编排内重名那句）
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function remove(): Promise<void> {
    if (busy || isNew) return
    /*
     * 删除确认（D237 使用者拍板"按你推荐"）：**只点名，不拦**。
     * 代码里还引用着这个名字时，框里多说一句——那句是**扫出来的事实**（工作流代码
     * 里出现 `'<名字>'`），不是泛泛的提醒；扫不到就不说。
     */
    const referenced = (wf?.code ?? '').includes(`'${name}'`)
    const ok = await askConfirm({
      title: tx('workflows.agentsDelete'),
      message: referenced
        ? tx('workflows.agentsConfirmDeleteUsed', { name })
        : tx('workflows.agentsConfirmDelete', { name }),
      confirmLabel: tx('workflows.agentsDelete'),
      danger: true,
    })
    if (!ok) return
    busy = true
    error = ''
    try {
      await api(
        `/api/workflows/${encodeURIComponent(workflowId)}/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' },
      )
      const out = await api<{ items: Workflow[] }>('/api/workflows')
      workflows.set(out.items ?? [])
      toast.set(tx('workflows.agentsDeleted'))
      ondone()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function toggleSkill(id: string): void {
    selectedSkills = selectedSkills.includes(id)
      ? selectedSkills.filter((x) => x !== id)
      : [...selectedSkills, id]
  }
</script>

<div class="wf-agent-editor" data-wf-agent-editor={agentId}>
  <header class="detail-head agent-head">
    <div class="detail-head-main">
      <!--
        ★ 返回按钮**常驻**（宽屏也在）：这一页是把编排详情整块换掉的，不是主从布局。
        所以不能用 `.back-to-list`（那个类在宽屏是 display:none，因为列表就在左边）——
        与运行画面的返回按钮同一个做法。
      -->
      <p class="detail-sub">
        <button type="button" class="btn btn--ghost btn--sm" data-wf-agent-back onclick={ondone}>
          {$t('workflows.agentsBack')}
        </button>
      </p>
      <h2 data-wf-agent-title>
        {isNew ? $t('workflows.agentsNew') : (original?.name ?? $t('workflows.agentsTitle'))}
      </h2>
      <p class="detail-sub" data-wf-agent-sub>
        <span class="badge">{$t('workflows.agentsBadge')}</span>
        <span class="faint">{$t('workflows.agentsOfWorkflow', { name: wf?.name ?? '' })}</span>
      </p>
    </div>
    <div class="detail-actions">
      <button
        type="button"
        class="btn btn--primary"
        data-wf-agent-save
        disabled={!canSave}
        onclick={() => void save()}
      >{busy ? $t('common.saving') : $t('common.save')}</button>
      <button type="button" class="btn btn--ghost" data-wf-agent-cancel onclick={ondone}
        >{$t('common.cancel')}</button
      >
      {#if !isNew}
        <button
          type="button"
          class="btn btn--danger"
          data-wf-agent-delete
          disabled={busy}
          onclick={() => void remove()}
        >{$t('workflows.agentsDelete')}</button>
      {/if}
    </div>
  </header>

  {#if loadError}
    <div class="notice bad">{loadError}</div>
  {:else if loading}
    <div class="skeleton skeleton--block"></div>
  {:else}
    {#if error}
      <div class="notice bad" data-wf-agent-error>{error}</div>
    {/if}

    <section class="card agent-card pair-field">
      <!-- 名字：与智能体页同一条规矩（名字是标签、改名跟着搬目录——D232/D236） -->
      <label class="cell name-cell">
        {$t('workflows.agentsNameLabel')}
        <span class="field">
          <input
            type="text"
            bind:value={name}
            data-wf-agent-name
            autocomplete="off"
            placeholder={$t('workflows.agentsNamePlaceholder')}
          />
        </span>
        {#if !isNew && original && name.trim() !== original.name}
          <p class="row-hint">{$t('agents.renamePending')}</p>
        {/if}
      </label>

      <!--
        入口：**固定只有「编排」**（使用者："只是入口是固定的，只能有编排"）。
        与智能体页同一个控件（勾选框），只是勾着且禁用——不另造一个"只读徽标"，
        免得同一件事在两边长得不一样。
      -->
      <section class="cell entry-cell" data-wf-agent-entries>
        <span class="cell-label">{$t('agents.entriesLabel')}</span>
        <div class="entry-picker locked">
          <label class="entry-option">
            <input type="checkbox" checked disabled />
            <span>{$t('workflows.agentsEntryWorkflow')}</span>
          </label>
        </div>
      </section>

      <!-- 指令：与智能体页同一件控件（PromptField，右下角可展开大编辑器） -->
      <label class="cell instructions-cell">
        {$t('agents.instructionsLabel')}
        <span class="field">
          <PromptField
            id="wf-agent-instructions"
            class="instructions"
            bind:value={instructions}
            label={$t('agents.instructionsLabel')}
            rows={6}
          />
        </span>
      </label>

      <!-- 技能：共享（技能库，勾选）+ 独有（文件资产，只读）——与智能体页同一个 `.skill-box` -->
      <div class="cell skills-cell">
        <span class="cell-label">{$t('agents.attachedSkillsLabel')}</span>
        <div class="skill-box">
          <div class="skill-picker" data-wf-agent-skills>
            {#each pickableSkills as s (s.id)}
              <label class="skill-option">
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(s.id as string)}
                  onchange={() => toggleSkill(s.id as string)}
                />
                <span title={s.localDir ?? s.name}>{s.name}</span>
              </label>
            {:else}
              <p class="hint">{$t('agents.noSkillsOption')}</p>
            {/each}
          </div>
          {#if exclusiveSkills.length > 0}
            <div class="exclusive-skills" data-wf-agent-exclusive>
              <span class="cell-label-inner">{$t('workflows.agentsExclusiveTitle')}</span>
              <span class="lockmark">{$t('agents.lockReadOnly')}</span>
              <ul class="exclusive-list">
                {#each exclusiveSkills as s (s.name)}
                  <li><code class="mono">{s.name}</code></li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</div>

<style>
  .wf-agent-editor {
    height: 100%;
    overflow: auto;
    padding: 0 var(--pad-frame-body) var(--pad-frame-body);
  }
  /* 与智能体编辑页同一档：名字占一整行、指令与技能左右配对（`.pair-field` 负责配对，
     这里只保证"名字不自成半行"）。 */
  .name-cell {
    grid-column: 1 / -1;
  }
  .exclusive-skills {
    border-top: 1px solid var(--line);
    margin-top: var(--sp-2);
    padding-top: var(--sp-2);
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    align-items: baseline;
  }
  .exclusive-list {
    margin: 0;
    padding-left: var(--sp-4);
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
</style>
