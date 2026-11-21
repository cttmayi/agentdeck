<script lang="ts">
  /**
   * **编排内建智能体**（2026-11，D237）——编排详情右栏那一节。
   *
   * 它只是**列表 + 入口**：点「新建 / 编辑」跳到独立编辑页（`WorkflowAgentEditor`，
   * 地址 `#/workflows/agents/<编排id>/<智能体id|new>`）。使用者拍板："编辑的时候，
   * 可以类似设置那样，直接跳转过去，然后可以返回回来"。
   *
   * 为什么列表留在这儿：内建智能体与编排代码是**同一份定义**（住在
   * `workflows/<id>/agents/<名字>/` 里）。看完代码抬头就能看见"这条编排里有哪几个人"，
   * 而编辑本身要放指令与技能多选，需要一整栏——那是另一页的事。
   *
   * 与智能体页的关系：内建智能体**不进智能体页**、不参与聊天/派活；它的编辑页与
   * 智能体编辑页同一副骨架（名字 / 指令 / 技能 / 入口），只是**入口固定只有「编排」**。
   *
   * ⚠️ Svelte 5 legacy 模式（与 Workflows.svelte 同款约束）：不引 runes。
   */
  import { t, tx } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import type { WorkflowInlineAgent } from '../lib/api.ts'

  export let workflowId: string
  export let agents: WorkflowInlineAgent[] = []
  /** 「新建」与「编辑」都只做一件事：把地址切到编辑页（由页面决定怎么切）。 */
  export let onedit: (agentId: string) => void = () => {}
  /** 折叠态：列表一多就不该占着代码下面那一块（默认展开，使用者要看得到）。 */
  let open = true

  function skillsCount(a: WorkflowInlineAgent): number {
    return (a.skillIds ?? []).length
  }

  /**
   * 与智能体页同名 = 代码里写这个名字时**用的是这一条**（内建优先，D234）。
   * 这件事必须看得见（"遮蔽必须可见"）——所以由调用方把全局那份的名字集合给进来。
   */
  export let globalNames: Set<string> = new Set()
</script>

<div class="fold-section wf-agents" data-wf-agents={workflowId}>
  <button type="button" class="fold-head" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
    <span class="fold-title">{$t('workflows.agentsTitle')}</span>
    <span class="badge" data-wf-agents-count>{agents.length}</span>
    <span class="fold-summary">
      {agents.length === 0 ? $t('workflows.agentsEmptySummary') : agents.map((a) => a.name).join('、')}
    </span>
  </button>
  {#if open}
    <div class="fold-body">
      {#if agents.length === 0}
        <p class="faint fs-xs" data-wf-agents-empty>{$t('workflows.agentsEmptyHint')}</p>
      {:else}
        {#each agents as a (a.id)}
          <div class="ag-row" data-wf-agent={a.name}>
            <span class="ag-name ellipsis" title={a.name}>{a.name}</span>
            <span class="badge">{$t('workflows.agentsSkillCount', { n: String(skillsCount(a)) })}</span>
            {#if globalNames.has(a.name)}
              <span class="badge warn" title={$t('workflows.agentsShadowTitle')}
                >{$t('workflows.agentsShadowed')}</span
              >
            {/if}
            <span class="ag-actions">
              <button
                type="button"
                class="btn btn--secondary btn--sm"
                data-wf-agent-edit={a.id}
                onclick={() => onedit(a.id)}
              >{$t('common.edit')}</button
              >
            </span>
          </div>
        {/each}
      {/if}
      <div class="field-row" style="margin-top:var(--sp-2)">
        <button
          type="button"
          class="btn btn--secondary btn--sm"
          data-wf-agent-new
          onclick={() => onedit('new')}
        >{$t('workflows.agentsNew')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* 一行 = 名字 + 技能数（+ 遮蔽徽标）+ 动作。窄一档的内距（与表格紧凑档同档），
     但它不是 `<tr>`（这一节在详情右栏里，不是表格）。 */
  .ag-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .ag-row + .ag-row {
    margin-top: var(--sp-1);
  }
  .ag-name {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .ag-actions {
    margin-left: auto;
    display: flex;
    gap: var(--sp-1);
  }
</style>
