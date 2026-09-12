<script lang="ts">
  import { api, newRunId, type Issue } from '../lib/api.ts'
  import { agents, issues, loadIssues, loadRuns } from '../lib/stores.ts'
  import { go, selectedIssueId, showToast } from '../lib/view.ts'

  /**
   * 新建任务。
   *
   * ══════════════════════════════════════════════════════════════════
   * 工作目录默认**不需要填**（D27）
   * ══════════════════════════════════════════════════════════════════
   *
   * 每个任务自动获得一个独立目录。填这里只在一种情况下有意义：你要让
   * agent 直接在你的仓库里干活。所以它收在「高级」折叠区里——**默认路径
   * 不该出现在必经之路上**。
   */
  let title = ''
  let description = ''
  let workDir = ''
  let agentId = ''
  let busy = false
  let error = ''

  // agent 列表到了之后默认选第一个（通常是兜底那个"助手"）
  $: if (!agentId && $agents.length > 0) agentId = $agents[0]!.id
  $: chosen = $agents.find((a) => a.id === agentId) ?? null

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = ''
    const t = title.trim()
    if (!t) return
    const agent = chosen
    if (!agent) {
      error = '还没有可用的 agent。'
      return
    }

    busy = true
    try {
      const issue = await api<Issue>('/api/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: t,
          description: description.trim(),
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
          skills: [],
          subject: { type: 'issue', id: issue.id },
          prompt: [t, description.trim()].filter(Boolean).join('\n\n'),
          // 只有真的填了才带这个字段：空字符串与"没指定"是两件事
          ...(workDir.trim() ? { workDir: workDir.trim() } : {}),
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      title = ''
      description = ''
      await Promise.all([loadIssues(), loadRuns()])
      // 切到任务清单并选中它——跳过这一步的话，使用者提交后停在原地，
      // 不知道到底成没成
      selectedIssueId.set(issue.id)
      go('tasks')
      showToast('已创建并派发')
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<div class="view-head">
  <div>
    <h2>新建任务</h2>
    <p>写清楚要做什么。创建后会立刻派给 agent 执行，你可以在「任务清单」里看它的进展。</p>
  </div>
</div>

<form onsubmit={submit} style="max-width:42rem">
  <label>
    要做什么
    <input bind:value={title} placeholder="例如：审一下这次依赖升级的影响面" required autocomplete="off" />
  </label>

  <label>
    补充说明（可选）
    <textarea bind:value={description} rows="4" placeholder="背景、约束、你希望看到什么"></textarea>
  </label>

  {#if $agents.length > 1}
    <label>
      交给哪个 agent
      <select bind:value={agentId}>
        {#each $agents as a (a.id)}
          <option value={a.id}>
            {a.name}{a.isFallbackReviewer ? '（兜底审核者）' : ''}
          </option>
        {/each}
      </select>
    </label>
  {:else if chosen}
    <p class="hint">将由 <strong>{chosen.name}</strong> 执行。</p>
  {/if}

  <details style="margin:var(--sp-4) 0">
    <summary class="hint" style="cursor:pointer">高级：指定自己的工作目录（可选）</summary>
    <label style="margin-top:var(--sp-3)">
      工作目录
      <input bind:value={workDir} placeholder="留空即自动分配" />
    </label>
    <p class="hint">
      留空时<strong>每个任务会自动获得一个独立目录</strong>，不需要你操心。
      填这里只在你要让 agent 直接在你的仓库里干活时才有意义——填了之后，
      同一个目录同时只跑一个任务，其余排队。
    </p>
  </details>

  {#if error}
    <div class="notice bad" style="margin-bottom:var(--sp-3)">{error}</div>
  {/if}

  <button type="submit" disabled={busy || !title.trim()}>
    {busy ? '正在创建…' : '创建并派发'}
  </button>
</form>

<p class="hint" style="margin-top:var(--sp-5);max-width:52rem">
  ⚠️ <strong>页面是派发的通道。</strong>关闭本页面后不会有新的执行被派发；
  已经在跑的会跑完。
</p>
