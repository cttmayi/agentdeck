<script lang="ts">
  /**
   * **聊天里的「候选编排」卡片**（2026-11，D255）。
   *
   * 使用者定的流程：
   *   1. 编排生成者把候选**写成存储的形状**（工作目录 `workflow-draft/<名字>/`），
   *      每轮结束 daemon 预检一次；
   *   2. 聊天里出现这张卡片：**能不能收**、几个人、哪一条不对；
   *   3. 顶栏那颗「收进编排库」⇒ **直接保存**（无中间确认面板）⇒ 跳到编排编辑页；
   *      同名 ⇒ 先问「覆盖那条吗」（并写明覆盖会替换什么）。
   *
   * ★ 2026-11（D260，使用者："「收进编排库」要放在顶栏，默认置灰，有检查到生成才可以用"）：
   *   **动作搬到顶栏**（`Chat.svelte` 的 `page-actions`），卡片只留"它写成了什么"——
   *   名字 / 几个人 / 代码行数 / 哪一条不对 / 打开目录。
   *   为什么：卡片是**消息流里的一段**，会被后一轮对话挤上去；而"入库"是这一页的
   *   一次完整动作（还牵着一页级的跳转），放在整页那一排才是它该在的层级
   *   （与"整理成记忆"从顶栏挪到对话头同一类判断，方向相反、理由相同）。
   *   没有候选时那颗按钮**置灰不拿掉**（D214 同一条规矩：位置不动、语义明确）。
   *
   * 为什么卡片而不是面板：产物是**工作目录里的真文件**，人要看的是"它写成了什么"；
   * 面板里再摆一份可改的文本，两份就会分叉（D245 把编辑器做成"直接改文件"是同一条理由）。
   * 要改 ⇒ 打开目录改，或让模型接着聊。
   */
  import { t } from '../lib/i18n.ts'
  import { api, type WorkflowCandidate } from '../lib/api.ts'
  import { showToast } from '../lib/view.ts'

  export let candidates: WorkflowCandidate[] = []
  /**
   * 入库失败时那一行错（键 = `dir`）——**由页面给**（动作在顶栏，错误仍显示在卡片上，
   * 人一眼看得出是哪条候选、卡在哪）。
   */
  export let errorByDir: Record<string, string> = {}

  const errorsOf = (c: WorkflowCandidate) => c.problems.filter((p) => p.level === 'error')
  const warnsOf = (c: WorkflowCandidate) => c.problems.filter((p) => p.level === 'warn')

  async function reveal(absDir: string): Promise<void> {
    try {
      await api('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path: absDir }) })
    } catch (err) {
      // 打不开文件夹不是"生成失败"，只提示一句（与智能体页的「打开目录」同一档）
      showToast($t('chat.wfOpenDirFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

</script>

{#if candidates.length > 0}
  <div class="wf-candidates" data-wf-candidates>
    {#each candidates as c (c.dir)}
      {@const errors = errorsOf(c)}
      {@const warns = warnsOf(c)}
      {@const blocked = errors.length > 0}
      <section class="wf-card" class:blocked data-wf-candidate={c.dir}>
        <header class="wf-card-head">
          <!-- ★ D190：截断走全局 `.ellipsis`（样式里不再写那三条） -->
          <span class="wf-card-title ellipsis" data-wf-candidate-name>
            {blocked
              ? $t('chat.wfBlockedTitle', { name: c.name })
              : $t('chat.wfReadyTitle', { name: c.name })}
          </span>
          <span class="spacer"></span>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-wf-open-dir
            onclick={() => void reveal(c.absDir)}
          >{$t('chat.wfOpenDir')}</button>
        </header>
        <p class="wf-card-meta" data-wf-candidate-meta>
          {$t('chat.wfMeta', {
            n: String(c.agents.length),
            names: c.agents.map((a) => a.name).join('、'),
            lines: String(c.codeLines),
          })}
        </p>
        {#if c.summary !== ''}
          <p class="wf-card-summary faint fs-xs">{c.summary}</p>
        {/if}
        {#if errors.length > 0 || warns.length > 0}
          <ul class="wf-problems" data-wf-problems>
            {#each errors as p}
              <li class="wf-problem bad">✗ {p.message}</li>
            {/each}
            {#each warns as p}
              <li class="wf-problem faint">· {p.message}</li>
            {/each}
          </ul>
        {/if}
        {#if (errorByDir[c.dir] ?? '') !== ''}
          <p class="notice bad" data-wf-adopt-error>{errorByDir[c.dir]}</p>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  /* 卡片就挂在消息流末尾：与工具行同一档（不是 agent 气泡），所以左对齐、无气泡底 */
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
