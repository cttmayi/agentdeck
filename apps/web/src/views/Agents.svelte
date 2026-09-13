<script lang="ts">
  import { agents, identity, loadAgents, loadIdentity, loading, loadError } from '../lib/stores.ts'
  import NewAgentForm from '../components/NewAgentForm.svelte'
  import AgentDetail from '../components/AgentDetail.svelte'

  /**
   * 智能体视图 = agent 配置 + runtime 状态。
   *
   * ══════════════════════════════════════════════════════════════════
   * 布局：与「任务清单」同一套主从（列表 | 详情）
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来点一个 agent 会把整页换成详情（列表消失），返回要靠详情里那个
   * 「← 智能体列表」。同一件事在任务页已经是"左列表右详情"了，两个页面对
   * 同一个动作给出两种反应是没有道理的——所以这里改成共用 `.split-layout`
   * （那套 CSS 本来就是按"两个视图共用"写的，连详情里返回按钮的隐藏规则
   * 都已经按 `.back` 写好了）。
   *
   * 页级信息（Runtime 概览、环境问题）留在**列表那一栏**：它们在改版前就是
   * "列表下面的一段"，放进左栏是原样搬运；而右栏保持"选中的那个 agent"
   * 这一件事，语义不混。窄屏下左栏会被详情顶掉，返回即可见——这与任务的
   * 行为一致。
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
  /** 当前点开查看的 agent。null = 还没有选（右栏显示占位）。 */
  let selectedId: string | null = null
  $: selected = $agents.find((a) => a.id === selectedId) ?? null

  /**
   * 环境预检的问题。
   *
   * ⚠️ 这里必须写全可选链：`environment` 是可选字段，而模板里的类型流
   *    与普通代码不同——svelte-check 会如实报出来，tsc 根本看不到这些行。
   */
  $: envIssues = $identity?.environment?.issues ?? []

  const SUPPORT_LABEL: Record<string, string> = {
    verified: '实测过',
    'in-range-unverified': '在范围内但未实测',
    'out-of-range': '超出范围',
    undeclared: '未声明',
    unknown: '无法判断',
  }

  function refresh(): void {
    void Promise.all([loadAgents(), loadIdentity()])
  }
</script>

<div class="split-layout" class:with-detail={selected !== null}>
  <!-- ══════════════════ 左栏：智能体清单 + Runtime ══════════════════ -->
  <section class="pane list-pane">
    <header class="pane-head">
      <div>
        <h2>智能体</h2>
        <p class="hint">
          每个 agent 独立配置指令、技能子集与角色：<strong>执行者</strong>接到任务动手干活，
          <strong>审核者</strong>按挂着的 skill 给判决——所以换一个审核 agent 就等于换一套审核标准。
        </p>
      </div>
      <div class="pane-actions">
        <NewAgentForm oncreated={() => void loadAgents()} />
        <button type="button" class="secondary small" onclick={refresh}>刷新</button>
      </div>
    </header>

    <div class="pane-body">
      {#if envIssues.length > 0}
        <!--
          环境预检的问题要显示出来。它最常见的形态是"CLI 自己的状态目录写不进去"，
          而那个错误在 agent 输出里长得像"工作目录没建成功"——**指向完全错误的
          方向**。放在列表上方（而不是藏在某个详情里）比让使用者去猜便宜得多。
        -->
        <section class="env-issues">
          <h3 class="warn">环境问题</h3>
          {#each envIssues as issue}
            <div class="notice warn stack">
              <strong>{issue.summary}</strong>
              <span>{issue.action}</span>
            </div>
          {/each}
        </section>
      {/if}

      {#if $loading['agents'] && $agents.length === 0}
        <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
        <div class="skeleton" style="width:60%"></div>
      {:else if $loadError['agents']}
        <div class="notice bad">{$loadError['agents']}</div>
      {:else if $agents.length === 0}
        <div class="empty">
          <strong>还没有智能体</strong>
          先建一个执行者，再建一个审核者并给它挂上 skill——别忘了在执行者的「由谁审它」里选它，
          否则产出不会被自动审核。
        </div>
      {:else}
        <ul class="agent-list">
          {#each $agents as a (a.id)}
            {@const reviewer =
              a.role === 'reviewer'
                ? '它审别人'
                : !a.reviewerAgentId
                  ? '不自动审核'
                  : ($agents.find((x) => x.id === a.reviewerAgentId)?.name ?? '（已不存在）')}
            <!-- 整条可点：只在名字上加链接的话命中区域太小，而且其余字段看起来像"不可点" -->
            <li>
              <button
                type="button"
                class="agent-item"
                class:active={a.id === selectedId}
                onclick={() => (selectedId = a.id)}
              >
                <span class="agent-line">
                  <strong>{a.name}</strong>
                  <span class="badge {a.role === 'reviewer' ? 'in_review' : 'in_progress'}">
                    {a.role === 'reviewer' ? '审核' : '执行'}
                  </span>
                  {#if a.role === 'reviewer' && a.skillIds.length === 0}
                    <!-- 审核者不挂 skill 就审不了任何东西，这件事必须在列表上就看得见 -->
                    <span class="bad small">未挂 skill</span>
                  {/if}
                </span>
                <span class="agent-note faint small">
                  {a.instructions.trim()
                    ? a.instructions.slice(0, 48) + (a.instructions.length > 48 ? '…' : '')
                    : '（没有指令）'}
                </span>
                <span class="agent-note faint small">
                  {reviewer} · {a.skillIds.length} 个 skill · <code>{a.runtimeKey}</code>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      <!--
        Runtime 概览：窄栏里不再用六列表格（那会只剩横向滚动条），改成一格
        一张卡——字段一个不少，只是竖着排。
      -->
      {#if $identity}
        <section class="runtime-block">
          <h3>Runtime（本机）</h3>
          <p class="hint">
            <strong>证据等级</strong>：<code>provisional</code> 表示该 CLI 的字段名<strong>没有对照过
            真实程序</strong>，是按公开形状推导的——它和 <code>verified</code> 的可信度不同。
            <strong>版本判定</strong>：<code>undeclared</code> 表示我们<strong>没有实测过</strong>任何版本；
            按 FR-CLI-07，凭文档推断的范围不算声明，所以这里如实报成"未声明"。
          </p>

          {#each $identity.runtimes as r (r.key)}
            <div class="runtime-card">
              <div class="runtime-line">
                <code>{r.key}</code>
                {#if r.available}
                  <span class="faint small">{r.cliVersion ?? '已就绪'}</span>
                {:else}
                  <span class="bad small">未找到</span>
                {/if}
                <span class="faint small" class:good={r.evidence === 'verified'}>
                  证据：{r.evidence}
                </span>
              </div>
              <div class="runtime-line faint small">
                <span class="mono">{r.command}</span>
                <span>会话：{r.sessionState ?? '—'}</span>
              </div>
              <div class="runtime-line small">
                <span class="faint">版本判定：</span>
                <span
                  class:good={r.versionSupport?.status === 'verified'}
                  class:bad={r.versionSupport?.status === 'out-of-range'}
                  class:faint={!['verified', 'out-of-range'].includes(r.versionSupport?.status ?? '')}
                >
                  {SUPPORT_LABEL[r.versionSupport?.status ?? ''] ?? r.versionSupport?.status ?? '—'}
                </span>
              </div>
              {#if r.versionSupport?.message && r.versionSupport.status !== 'verified'}
                <p class="hint small runtime-msg">{r.versionSupport.message}</p>
              {/if}
            </div>
          {/each}

          <p class="hint">
            要让版本判定变成"实测过"：<code>pnpm run daemon --verify-runtime all</code>
          </p>
        </section>
      {/if}
    </div>
  </section>

  <!-- ══════════════════ 右栏：选中的那个 agent（宽屏并排 / 窄屏整页）══════════════════ -->
  <section class="pane detail-pane">
    <div class="pane-body">
      {#if selected}
        <AgentDetail
          agent={selected}
          onclose={() => (selectedId = null)}
          onchanged={() => void loadAgents()}
        />
      {:else}
        <div class="empty">
          <strong>从左边选一个智能体</strong>
          点左边的条目看它的指令、挂的技能，以及它用哪个 CLI 跑。
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  /* ══════════════ 列表（窄栏里的卡片，不是表格）══════════════
     画表格的话六列会在 26rem 里互相挤；卡片竖排能放同样的字段，还顺手
     把"整条可点"表达清楚了。 */

  .agent-list {
    list-style: none;
    margin: 0 0 var(--sp-5);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .agent-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    text-align: left;
    padding: var(--sp-3);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--text);
    cursor: pointer;
  }

  .agent-item:hover {
    background: var(--surface-2);
  }

  /* 选中的那条要一眼看出来：主从布局里"右边是谁"全靠这个 */
  .agent-item.active {
    background: var(--surface-2);
    border-color: var(--accent);
  }

  .agent-line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .agent-note {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ══════════════ 环境问题 ══════════════ */

  .env-issues {
    margin-bottom: var(--sp-5);
  }

  .env-issues h3 {
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-2);
  }

  /* 两行（结论 + 怎么办）竖排：横排时第二句会被挤成一条竖线 */
  .stack {
    flex-direction: column;
    align-items: flex-start;
    margin-bottom: var(--sp-2);
  }

  /* ══════════════ Runtime ══════════════ */

  .runtime-block h3 {
    font-size: var(--fs-sm);
    margin-bottom: var(--sp-2);
  }

  .runtime-block .hint {
    margin-bottom: var(--sp-3);
  }

  .runtime-card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    padding: var(--sp-3);
    margin-bottom: var(--sp-2);
  }

  .runtime-line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .runtime-msg {
    margin: var(--sp-2) 0 0;
  }
</style>
