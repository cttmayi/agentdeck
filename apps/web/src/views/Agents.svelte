<script lang="ts">
  import { agents, identity, loadAgents, loadIdentity, loading, loadError } from '../lib/stores.ts'
  import NewAgentForm from '../components/NewAgentForm.svelte'

  /**
   * 智能体视图 = agent 配置 + runtime 状态。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么 runtime 放这里而不是单独一栏
   * ══════════════════════════════════════════════════════════════════
   *
   * agent 跑在哪个 runtime 上是它**配置的一部分**，两个概念分开看会让人
   * 对不上号——"这个 agent 到底用的哪个 CLI"变成要去另一页拼。侧边栏则
   * 保持只有四项。
   *
   * ══════════════════════════════════════════════════════════════════
   * 证据等级与版本判定**必须显示**
   * ══════════════════════════════════════════════════════════════════
   *
   * `provisional` 的 runtime 与实测过的可信度完全不同；`undeclared` 的
   * 版本范围意味着"我们没验证过任何版本"。把这些藏起来，使用者就会以为
   * 它们一样可信——那正是这个项目反复在防的那类"把不确定说成确定的"。
   */
  const SUPPORT_LABEL: Record<string, string> = {
    verified: '实测过',
    'in-range-unverified': '在范围内但未实测',
    'out-of-range': '超出范围',
    undeclared: '未声明',
    unknown: '无法判断',
  }
</script>

<div class="view-head">
  <div>
    <h2>智能体</h2>
    <p>
      每个 agent 独立配置指令、技能子集与「认哪些 kind」——后者既是<strong>路由键</strong>
      也是<strong>审核标准的选择键</strong>，所以换审核 agent 就等于换审核标准。
    </p>
  </div>
  <div style="display:flex;gap:var(--sp-2)">
    <NewAgentForm oncreated={() => void loadAgents()} />
    <button
      type="button"
      class="secondary"
      onclick={() => Promise.all([loadAgents(), loadIdentity()])}
    >
      刷新
    </button>
  </div>
</div>

{#if $loading['agents'] && $agents.length === 0}
  <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
  <div class="skeleton" style="width:60%"></div>
{:else if $loadError['agents']}
  <div class="notice bad">{$loadError['agents']}</div>
{:else}
  <div class="table-wrap" style="margin-bottom:var(--sp-6)">
    <table>
      <thead>
        <tr>
          <th>agent</th><th>指令摘要</th><th>技能</th><th>认哪些 kind</th>
          <th>兜底审核</th><th>自动审核</th><th>并发</th><th>工作目录</th>
        </tr>
      </thead>
      <tbody>
        {#each $agents as a (a.id)}
          <tr>
            <td><strong>{a.name}</strong></td>
            <td class="muted">{a.instructions.slice(0, 48) || '—'}{a.instructions.length > 48 ? '…' : ''}</td>
            <td>{a.skillIds.length}</td>
            <td>
              {#if a.kindPatterns.length > 0}
                {#each a.kindPatterns as k}<code style="margin-right:4px">{k}</code>{/each}
              {:else}
                <span class="faint">—</span>
              {/if}
            </td>
            <td>{a.isFallbackReviewer ? '<span class="good">是</span>' : '<span class="faint">否</span>'}</td>
            <td>{a.autoReview ? '开' : '<span class="faint">关</span>'}</td>
            <td>{a.maxConcurrentRuns}</td>
            <td class="faint small">
              {a.workDir ?? '每任务自动分配'}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <h3>Runtime</h3>
  <p class="hint" style="margin-bottom:var(--sp-3)">
    <strong>证据等级</strong>：<code>provisional</code> 表示该 CLI 的字段名<strong>没有对照过
    真实程序</strong>，是按公开形状推导的——它和 <code>verified</code> 的可信度不同。
    <strong>版本判定</strong>：<code>undeclared</code> 表示我们<strong>没有实测过</strong>任何版本；
    按 FR-CLI-07，凭文档推断的范围不算声明，所以这里如实报成"未声明"。
  </p>

  {#if $identity}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>runtime</th><th>命令</th><th>版本</th><th>证据等级</th><th>版本判定</th><th>会话状态</th></tr>
        </thead>
        <tbody>
          {#each $identity.runtimes as r (r.key)}
            <tr>
              <td><code>{r.key}</code></td>
              <td class="mono">{r.command}</td>
              <td>
                {#if r.available}
                  {r.cliVersion ?? '已就绪'}
                {:else}
                  <span class="bad">未找到</span>
                {/if}
              </td>
              <td class:good={r.evidence === 'verified'} class="muted">{r.evidence}</td>
              <td>
                <span
                  class:good={r.versionSupport?.status === 'verified'}
                  class:bad={r.versionSupport?.status === 'out-of-range'}
                  class:faint={!['verified', 'out-of-range'].includes(r.versionSupport?.status ?? '')}
                >
                  {SUPPORT_LABEL[r.versionSupport?.status ?? ''] ?? r.versionSupport?.status ?? '—'}
                </span>
              </td>
              <td class="faint">{r.sessionState ?? '—'}</td>
            </tr>
            {#if r.versionSupport?.message && r.versionSupport.status !== 'verified'}
              <tr>
                <td colspan="6" class="hint" style="padding-top:0">{r.versionSupport.message}</td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    <p class="hint" style="margin-top:var(--sp-3)">
      要让版本判定变成"实测过"：<code>pnpm run daemon --verify-runtime all</code>
    </p>
  {/if}
{/if}
