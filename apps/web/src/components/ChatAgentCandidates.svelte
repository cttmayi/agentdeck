<script lang="ts">
  /**
   * **聊天里的「候选智能体」卡片**（2026-11，D256）。
   *
   * 与「候选编排」卡片（`ChatWorkflowCandidates.svelte`）同一张图纸：
   *   1. 智能体生成者把候选写成**存储的形状**（工作目录 `agent-draft/<岗位名>/`），
   *      每轮结束 daemon 预检一次；
   *   2. 聊天里出现这张卡片：这个人是谁、带几条配套技能、能不能收、哪一条不对；
   *   3. 点「生成智能体」⇒ **直接落库**（建智能体 + 配套技能落成它的独有技能）
   *      ⇒ 跳到智能体编辑页并选中它。
   *
   * 同名不覆盖：库里已有同名智能体时服务端 409——覆盖一条已有的智能体会连带它的
   * 记忆/技能一起换掉，风险不对等，所以这里只把原话说出来，让人改名或先删旧的。
   */
  import { t } from '../lib/i18n.ts'
  import { api, type Agent, type AgentCandidate } from '../lib/api.ts'
  import { showToast } from '../lib/view.ts'
  import { loadAgents } from '../lib/stores.ts'

  export let conversationId = ''
  export let candidates: AgentCandidate[] = []
  /** 落库之后（页面负责跳转到智能体编辑页并选中它）。 */
  export let onadopted: (agent: Agent) => void = () => {}

  let busyDir = ''
  let errorByDir: Record<string, string> = {}

  const errorsOf = (c: AgentCandidate) => c.problems.filter((p) => p.level === 'error')
  const warnsOf = (c: AgentCandidate) => c.problems.filter((p) => p.level === 'warn')

  async function reveal(absDir: string): Promise<void> {
    try {
      await api('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path: absDir }) })
    } catch (err) {
      showToast($t('chat.wfOpenDirFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  async function adopt(c: AgentCandidate): Promise<void> {
    if (busyDir !== '') return
    busyDir = c.dir
    errorByDir = { ...errorByDir, [c.dir]: '' }
    try {
      const out = await api<{ agent: Agent; exclusiveNames: string[] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/agent-adopt`,
        { method: 'POST', body: JSON.stringify({ dir: c.dir }) },
      )
      // 写动作成功后界面跟着数据走：先重拉列表，再交给页面跳转
      await loadAgents()
      showToast($t('chat.agentAdopted', { name: out.agent.name }))
      onadopted(out.agent)
    } catch (err) {
      // 服务端原话照给（同名 409 的说法里已经写清"改名或先删旧的"；校验不过说清哪一条）
      errorByDir = { ...errorByDir, [c.dir]: err instanceof Error ? err.message : String(err) }
    } finally {
      busyDir = ''
    }
  }
</script>

{#if candidates.length > 0}
  <div class="wf-candidates" data-agent-candidates>
    {#each candidates as c (c.dir)}
      {@const errors = errorsOf(c)}
      {@const warns = warnsOf(c)}
      {@const blocked = errors.length > 0}
      <section class="wf-card" class:blocked data-agent-candidate={c.dir}>
        <header class="wf-card-head">
          <!-- ★ D190：截断走全局 `.ellipsis` -->
          <span class="wf-card-title ellipsis" data-agent-candidate-name>
            {blocked
              ? $t('chat.agentBlockedTitle', { name: c.name })
              : $t('chat.agentReadyTitle', { name: c.name })}
          </span>
          <span class="spacer"></span>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-agent-open-dir
            onclick={() => void reveal(c.absDir)}
          >{$t('chat.wfOpenDir')}</button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            data-agent-adopt={c.dir}
            disabled={blocked || busyDir !== ''}
            title={blocked ? errors[0]?.message ?? '' : ''}
            onclick={() => void adopt(c)}
          >{busyDir === c.dir ? $t('common.saving') : $t('chat.agentAdopt')}</button>
        </header>
        <p class="wf-card-meta" data-agent-candidate-meta>
          {$t('chat.agentMeta', {
            n: String(c.skills.length),
            skills: c.skills.map((s) => s.name).join('、'),
            chars: String(c.instructionsChars),
          })}
        </p>
        <p class="wf-card-summary faint fs-xs">{c.instructionsPreview}</p>
        {#if errors.length > 0 || warns.length > 0}
          <ul class="wf-problems" data-agent-problems>
            {#each errors as p}
              <li class="wf-problem bad">✗ {p.message}</li>
            {/each}
            {#each warns as p}
              <li class="wf-problem faint">· {p.message}</li>
            {/each}
          </ul>
        {/if}
        {#if (errorByDir[c.dir] ?? '') !== ''}
          <p class="notice bad" data-agent-adopt-error>{errorByDir[c.dir]}</p>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  /* 卡片挂在消息流末尾：与「候选编排」那张同一套长相（左对齐、不是 agent 气泡）。
     两张卡片共用同一组类名，样式各自定义一份会漂——所以这里的声明与
     `ChatWorkflowCandidates.svelte` 里的那几行**逐字相同**，改动时一起改。 */
  .wf-candidates {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: var(--sp-3) 0;
  }

  .wf-card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }

  .wf-card.blocked {
    border-color: var(--line-strong);
    background: var(--surface-2);
  }

  .wf-card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }

  .wf-card-head .spacer {
    flex: 1 1 auto;
  }

  .wf-card-title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
    min-width: 0;
  }

  .wf-card-meta {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .wf-card-summary {
    margin: 0;
  }

  .wf-problems {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-xs);
  }

  .wf-problem.bad {
    color: var(--bad);
  }
</style>
