<script lang="ts">
  import { agents, identity, loadAgents, loadIdentity, loading, loadError } from '../lib/stores.ts'
  import NewAgentForm from '../components/NewAgentForm.svelte'
  import AgentDetail from '../components/AgentDetail.svelte'

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
  /** 当前点开查看的 agent。null = 显示列表。 */
  let selectedId: string | null = null
  $: selected = $agents.find((a) => a.id === selectedId) ?? null

  const SUPPORT_LABEL: Record<string, string> = {
    verified: '实测过',
    'in-range-unverified': '在范围内但未实测',
    'out-of-range': '超出范围',
    undeclared: '未声明',
    unknown: '无法判断',
  }
</script>

{#if selected}
  <AgentDetail
    agent={selected}
    onclose={() => (selectedId = null)}
    onchanged={() => void loadAgents()}
  />
{:else}
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
          <th>agent</th><th>角色</th><th>由谁审它</th><th>指令摘要</th><th>skill</th><th>runtime</th>
        </tr>
      </thead>
      <tbody>
        {#each $agents as a (a.id)}
          <!-- 整行可点开详情：只在名字上加链接的话，命中区域太小，
               而且其余字段看起来像"不可点" -->
          <tr onclick={() => (selectedId = a.id)} style="cursor:pointer">
            <td>
              <strong>{a.name}</strong>
              <div class="faint small">点开查看与编辑</div>
            </td>
            <td>
              <span class="badge {a.role === 'reviewer' ? 'in_review' : 'in_progress'}">
                {a.role === 'reviewer' ? '审核' : '执行'}
              </span>
            </td>
            <td class="muted">
              {#if a.role === 'reviewer'}
                <span class="faint">—</span>
              {:else}
                {$agents.find((x) => x.id === a.reviewerAgentId)?.name ??
                  (a.reviewerAgentId ? '（已不存在）' : '不自动审核')}
              {/if}
            </td>
            <td class="muted">{a.instructions.slice(0, 40) || '—'}{a.instructions.length > 40 ? '…' : ''}</td>
            <td>
              {#if a.skillIds.length === 0}
                {#if a.role === 'reviewer'}
                  <span class="bad">未挂</span>
                {:else}
                  <span class="faint">—</span>
                {/if}
              {:else}
                {a.skillIds.length}
              {/if}
            </td>
            <td class="faint small">{a.runtimeKey}</td>
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
{/if}

{#if $identity && !$identity.environment?.ok && ($identity.environment?.issues?.length ?? 0) > 0}
  <!--
    环境预检的问题要显示出来。它最常见的形态是"CLI 自己的状态目录写不进去"，
    而那个错误在 agent 输出里长得像"工作目录没建成功"——**指向完全错误的
    方向**。放在这里比让使用者去猜便宜得多。
  -->
  <section style="margin-top:var(--sp-6)">
    <h3 class="warn">环境问题</h3>
    {#each $identity.environment.issues as issue}
      <div class="notice warn" style="margin-bottom:var(--sp-2);flex-direction:column;align-items:flex-start">
        <strong>{issue.summary}</strong>
        <span>{issue.action}</span>
      </div>
    {/each}
  </section>
{/if}
