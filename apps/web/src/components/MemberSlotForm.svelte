<script lang="ts">
  import type { Agent, Skill } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'

  /**
   * 组详情里的一个成员槽（第二轮）：选已有的 / 新建私有。
   *
   * ⚠️ `member` 的字段由父组件（`views/Groups.svelte`）定义并负责更新——这里只
   *    负责"显示 + 上报"（onSetSource / onGlobalPick / onPatchPrivate 三个回调），
   *    不持有状态：这样父组件的 `save()` 拿到的一定是这一份草稿，没有两份真相。
   *
   * ══════════════════════════════════════════════════════════════════
   * 布局（与使用者敲定的重排）：
   * ══════════════════════════════════════════════════════════════════
   *
   * 每个槽 = 一张**成员卡**（两种模式共用同一张卡的框架，切换不整块换掉）：
   *
   *   ┌─ 执行者 ─────────────── [选已有的|新建私有] ─┐
   *   │ 名字 [______]   │  CLI   [▼ claude]          │
   *   │ 指令  [textarea] │  SKILL [☑甲 ☑乙 ☐丙]（2 列）│
   *   └──────────────────────────────────────────────┘
   *
   * · 私有模式：2×2 网格——第一行 名字|CLI，第二行 内容|SKILL（审核者那格是
   *   审核标准正文，不是指令；形状完全一致，只是内容格按角色换）。
   * · SKILL = 表格：固定 2 列、只要「勾选 + 名字」（与智能体页同款盒子样式）。
   * · 选已有的：下拉 + 选中后一行摘要（名字 · CLI · 技能数）。
   */

  interface PrivateDraft {
    id: string | null
    name: string
    instructions: string
    /** 审核标准**正文**（平台侧 ReviewStandard 只有 body）。 */
    standard: string
    runtimeKey: string
    skillIds: string[]
  }

  interface MemberSlotView {
    source: 'global' | 'private'
    globalId: string
    privateDraft: PrivateDraft
  }

  let {
    label,
    hint,
    member,
    options,
    workflowSupported,
    isReviewer,
    onSetSource,
    onGlobalPick,
    onPatchPrivate,
    runtimeOptions,
    skillsList,
    noSkillsText,
    skillsLabel,
    nameLabel,
    runtimeLabel,
    instructionsLabel,
    standardBodyLabel,
  }: {
    label: string
    hint: string
    member: MemberSlotView
    options: Agent[]
    workflowSupported: boolean
    isReviewer: boolean
    onSetSource: (source: 'global' | 'private') => void
    onGlobalPick: (id: string) => void
    onPatchPrivate: (patch: Partial<PrivateDraft>) => void
    runtimeOptions: string[]
    skillsList: Skill[]
    noSkillsText: string
    skillsLabel: string
    nameLabel: string
    runtimeLabel: string
    instructionsLabel: string
    standardBodyLabel?: string
  } = $props()

  /** 「选已有的」下拉里当前选中的那个全局 agent（用于一行摘要）。 */
  const picked = $derived(options.find((a) => a.id === member.globalId) ?? null)

  /** 内容格当前的值（执行者=指令；审核者=审核标准）。 */
  const contentValue = $derived(
    isReviewer ? member.privateDraft.standard : member.privateDraft.instructions,
  )

  /**
   * 指令/标准自动增高：`rows=5` 起，内容变多跟着长，**最多 20 行**后内部滚动。
   * 量法：先放平（height=auto）再按 `scrollHeight` 撑起来，封顶 = 20 行行高 +
   * 上下内边距。`overflow-y: auto` 兜底：到了上限内容继续多就滚动而不是撑破卡。
   */
  function autosize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6 || 22
    const padTop = parseFloat(cs.paddingTop) || 0
    const padBottom = parseFloat(cs.paddingBottom) || 0
    const maxH = lineHeight * 20 + padTop + padBottom
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`
  }

  let contentArea = $state<HTMLTextAreaElement | undefined>(undefined)
  // 内容一变（输入 / 载入已有私有成员）就重新量一次高度——只靠 oninput 的话，
  // "打开编辑已有私有成员"时预填的长内容不会自动长高。
  $effect(() => {
    if (contentArea) {
      void contentValue
      autosize(contentArea)
    }
  })
</script>

<div class="member-card">
  <div class="slot-head">
    <span class="field-label">{label}</span>
    {#if workflowSupported}
      <div class="slot-source-toggle">
        <button
          type="button"
          class:active={member.source === 'global'}
          onclick={() => onSetSource('global')}
        >
          {$t('groups.slotGlobal')}
        </button>
        <button
          type="button"
          class:active={member.source === 'private'}
          onclick={() => onSetSource('private')}
        >
          {$t('groups.slotPrivate')}
        </button>
      </div>
    {/if}
  </div>

  {#if member.source === 'global'}
    <div class="pick-body">
      <select
        value={member.globalId}
        onchange={(e) => onGlobalPick((e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="" disabled>{$t('groups.slotPickPlaceholder')}</option>
        {#each options as a (a.id)}
          <option value={a.id}>{a.name}</option>
        {/each}
      </select>
      {#if picked}
        <p class="pick-summary">
          {$t('groups.pickSummary', {
            name: picked.name,
            runtime: picked.runtimeKey,
            skills: picked.skillIds.length,
          })}
        </p>
      {/if}
      <span class="hint">{hint}</span>
    </div>
  {:else}
    <div class="grid-form">
      <label class="cell">
        {nameLabel}
        <input
          value={member.privateDraft.name}
          oninput={(e) => onPatchPrivate({ name: (e.currentTarget as HTMLInputElement).value })}
          placeholder={$t('groups.privateNamePlaceholder')}
          autocomplete="off"
        />
      </label>

      <label class="cell">
        {runtimeLabel}
        <select
          value={member.privateDraft.runtimeKey}
          onchange={(e) => onPatchPrivate({ runtimeKey: (e.currentTarget as HTMLSelectElement).value })}
        >
          {#each runtimeOptions as key (key)}
            <option value={key}>{key}</option>
          {/each}
        </select>
      </label>

      <label class="cell">
        {isReviewer ? standardBodyLabel : instructionsLabel}
        <textarea
          rows="5"
          bind:this={contentArea}
          value={contentValue}
          oninput={(e) => {
            const ta = e.currentTarget as HTMLTextAreaElement
            autosize(ta)
            onPatchPrivate(
              isReviewer
                ? { standard: ta.value }
                : { instructions: ta.value },
            )
          }}
        ></textarea>
      </label>

      <div class="cell">
        <span class="cell-label">{skillsLabel}</span>
        {#if skillsList.length === 0}
          <p class="hint">{noSkillsText}</p>
        {:else}
          <div class="skill-picker">
            {#each skillsList as s (s.id)}
              <label class="skill-option" title={s.name}>
                <input
                  type="checkbox"
                  checked={member.privateDraft.skillIds.includes(s.id)}
                  onchange={(e) => {
                    const on = (e.currentTarget as HTMLInputElement).checked
                    onPatchPrivate({
                      skillIds: on
                        ? [...member.privateDraft.skillIds, s.id]
                        : member.privateDraft.skillIds.filter((id) => id !== s.id),
                    })
                  }}
                />
                <span>{s.name}</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    {#if member.privateDraft.id}
      <span class="badge">{$t('groups.privateBadge')}</span>
    {/if}
  {/if}
</div>

<style>
  /* ── 成员卡：两种模式共用一个框架 ── */
  .member-card {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--radius, 8px);
  }

  .slot-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  /**
   * 选已有的 / 新建私有 二选一（2026-10）：改成与顶栏「列表 / 看板」同款的分段轨
   * —— `var(--line)` 的轨 + 圆角矩形按钮，活动态 `--accent-dim` 实心底白字。
   * 原来是独立胶囊（`border-radius: 999px` + 细边框），使用者要求改样式。
   */
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

  .member-card input,
  .member-card select,
  .member-card textarea {
    width: 100%;
  }

  /* ── 选已有的：下拉 + 一行摘要 ── */
  .pick-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  /* ★ 占位「（选一个）」的字色：select 文字**显式**设成正文色——不然部分浏览器
     把"没选中时的禁用占位 option"渲染成浅色（白字），看不清选没选。 */
  .pick-body select {
    color: var(--text);
  }

  .pick-body select option[value=''][disabled] {
    color: var(--text-faint);
  }

  .pick-summary {
    margin: 0;
    font-size: 0.9em;
    color: var(--text-faint, #888);
  }

  /* ── 私有：2×2 网格 ── */
  .grid-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
    align-items: start;
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }

  .cell-label {
    font-size: 0.9em;
    color: var(--text-faint, #888);
  }

  /* ★ 指令/审核标准：默认 5 行，随内容自动增高（JS 按 scrollHeight 撑），
     最多 20 行（`autosize()` 封顶），到顶内部滚动、不撑破卡。 */
  .cell textarea {
    resize: none;
    overflow-y: auto;
    line-height: 1.6;
  }

  /* ── SKILL：表格、固定 2 列、只要「勾选 + 名字」 ──
     与智能体页/新建任务页的技能选择器同一套视觉（边框盒子 + 限高滚动 +
     多列网格，见 `NewAgentForm.svelte` 的 `.skill-picker`），这里按使用者拍板
     固定成 2 列、去掉说明/来源细节列。行内 checkbox 靠左、名字不换行。 */
  .skill-picker {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-1) var(--sp-2);
    max-height: 11rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
    text-align: left;
  }

  .skill-option {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    cursor: pointer;
    font-size: var(--fs-sm);
    min-width: 0;
    text-align: left;
  }

  .skill-option input {
    width: auto;
    margin: 0;
    flex-shrink: 0;
  }

  .skill-option span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .badge {
    align-self: flex-start;
    font-size: 0.8em;
    padding: 0.15em 0.6em;
    border-radius: 999px;
    /* ⚠️ 2026-10：原来 `background: var(--accent-soft, #e8f0ff)` —— `--accent-soft`
       全局没有定义，暗色主题下回退到浅底 #e8f0ff + 浅蓝 `--accent`，浅底浅字看不清。
       改用全局 `.badge` 同款主题安全写法：accent 文字 + 12% accent 底色，
       两种主题都可读（浅色：深蓝字浅蓝底；暗色：浅蓝字深蓝底）。 */
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
  }
</style>
