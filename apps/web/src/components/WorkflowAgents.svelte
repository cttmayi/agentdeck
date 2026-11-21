<script lang="ts">
  /**
   * **编排内建智能体**（2026-11，D237/D238）——编排详情右栏那一节。
   *
   * 它只是**列表 + 入口**：点「新建 / 编辑」跳到独立编辑页（地址
   * `#/workflows/agents/<编排id>/<智能体id|new>`），那一页与智能体页一致：
   * 新建复用 `NewAgentForm`、编辑复用 `AgentDetail`（使用者："页面要和编排的新建智能体
   * 要和智能体的新建智能体页面一致，最好复用"）。
   *
   * ★ 样式全部走 `ui-style.md` 的现成控件：`.fold-section`（折叠）+ `.table-wrap >
   *   table.table`（列表）+ `.field-row`（一排）+ `.btn`。这一节**没有**自己的 CSS——
   *   设计稿里那个自造的 `.ag-row` 已经删掉（那是"看起来像"的发明）。
   *
   * ⚠️ Svelte 5 legacy 模式（与 Workflows.svelte 同款约束）：不引 runes。
   */
  import { t } from '../lib/i18n.ts'
  import type { WorkflowInlineAgent } from '../lib/api.ts'

  export let workflowId: string
  export let agents: WorkflowInlineAgent[] = []
  /** 「新建」与「编辑」都只做一件事：把地址切到编辑页（由页面决定怎么切）。 */
  export let onedit: (agentId: string) => void = () => {}
  /**
   * 与智能体页同名 = 代码里写这个名字时**用的是这一条**（内建优先，D234）。
   * 这件事必须看得见（"遮蔽必须可见"）——所以由调用方把全局那份的名字集合给进来。
   */
  export let globalNames: Set<string> = new Set()

  let open = true

  function skillsCount(a: WorkflowInlineAgent): number {
    return (a.skillIds ?? []).length
  }
</script>

<div class="fold-section" data-wf-agents={workflowId}>
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
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>{$t('workflows.agentsColName')}</th>
                <th>{$t('workflows.agentsColSkills')}</th>
                <th aria-label={$t('workflows.agentsColActions')}></th>
              </tr>
            </thead>
            <tbody>
              {#each agents as a (a.id)}
                <tr data-wf-agent={a.name}>
                  <td>
                    <code>{a.name}</code>
                    {#if globalNames.has(a.name)}
                      <span class="badge warn" title={$t('workflows.agentsShadowTitle')}
                        >{$t('workflows.agentsShadowed')}</span
                      >
                    {/if}
                  </td>
                  <td class="faint fs-xs">
                    {$t('workflows.agentsSkillCount', { n: String(skillsCount(a)) })}
                  </td>
                  <td>
                    <button
                      type="button"
                      class="btn btn--secondary btn--sm"
                      data-wf-agent-edit={a.id}
                      onclick={() => onedit(a.id)}
                    >{$t('common.edit')}</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
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
