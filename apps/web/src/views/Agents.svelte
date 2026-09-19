<script lang="ts">
  import {
    agents,
    effectiveDefaultAgentId,
    identity,
    loadAgents,
    loadIdentity,
    loading,
    loadError,
    setDefaultAgent,
  } from '../lib/stores.ts'
  import NewAgentForm from '../components/NewAgentForm.svelte'
  import WorkspaceSettings from '../components/WorkspaceSettings.svelte'
  import AgentDetail from '../components/AgentDetail.svelte'
  import { t } from '../lib/i18n.ts'

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
   * 正在新建（D32 修）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这个状态为什么要提到视图这一层
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来「新建智能体」那个按钮**自己**管着"开不开"，表单就渲染在它旁边——
   * 而它在左栏的 `pane-head` 里。于是表单被塞进一个 416px 宽的头部行：
   * 实测表单是 736px（横着盖住右栏）、头部从 167px 涨到 1070px、agent 清单
   * 被顶到视口外。**"新建"这个动作把一个主从布局整垮了。**
   *
   * 现在按钮在头部（位置不变），表单在它下面的正文里（`pane-body`）。
   * 两处联动 ⇒ 状态放在这里，两边都只是渲染。
   */
  let creating = false

  /**
   * 打开「设置」（右侧抽屉）。
   *
   * ★ 里面装的是**平台行为**的设置：现在有"第一句话模版"（D32，通用配置——
   *   一次设定、所有 agent 生效），以后还会有别的。入口放在这一页的「新建」
   *   旁边——按使用者的说法："智能体的设置…应该在'新建'附近"。
   *
   * ⚠️ 两个抽屉互斥：同时开两个的话遮罩会叠在一起，Esc 也不知道该关哪个。
   */
  let settingsOpen = false

  /**
   * 环境预检的问题。
   *
   * ⚠️ 这里必须写全可选链：`environment` 是可选字段，而模板里的类型流
   *    与普通代码不同——svelte-check 会如实报出来，tsc 根本看不到这些行。
   */
  $: envIssues = $identity?.environment?.issues ?? []

  /**
   * 版本判定状态 → 标签。
   *
   * ⚠️ 用 `$:` 而不是 `const`（D39）：标签要**跟着界面语言变**。写成 `const`
   *    只在组件初始化时算一次，切语言时这五行会停在旧语言上——而它们恰恰是
   *    使用者判断"这个 runtime 可信不可信"的依据。
   */
  $: SUPPORT_LABEL = {
    verified: $t('agents.supportVerified'),
    'in-range-unverified': $t('agents.supportInRange'),
    'out-of-range': $t('agents.supportOutOfRange'),
    undeclared: $t('agents.supportUndeclared'),
    unknown: $t('agents.supportUnknown'),
  } as Record<string, string>

  function refresh(): void {
    void Promise.all([loadAgents(), loadIdentity()])
  }
</script>

<div class="split-layout" class:with-detail={selected !== null}>
  <!-- ══════════════════ 左栏：智能体清单 + Runtime ══════════════════ -->
  <section class="pane list-pane">
    <header class="pane-head">
      <div>
        <h2>{$t('agents.viewTitle')}</h2>
        <p class="hint">
          {$t('agents.listHintBefore')}<strong>{$t('agents.listHintExecutor')}</strong>{$t('agents.listHintMid')}<strong>{$t('agents.listHintReviewer')}</strong>{$t('agents.listHintAfter')}
        </p>
      </div>
      <div class="pane-actions">
        <!--
          ⚠️ 这里**只放按钮**：两个面板都在右侧抽屉里（见文件末尾）。
             把面板塞进 `pane-actions`（一个 flex 行）会按它的 max-width 撑开、
             横向盖住右栏——见 `creating` 那段注释里的实测数字；放进左栏正文
             则是不溢出但太窄。抽屉是这两件事的正解。
        -->
        <button
          type="button"
          disabled={creating}
          onclick={() => {
            creating = true
            settingsOpen = false
            selectedId = null
          }}
        >
          {$t('agents.newButton')}
        </button>
        <button
          type="button"
          class="secondary small"
          disabled={settingsOpen}
          title={$t('agents.settingsTitle')}
          onclick={() => {
            settingsOpen = true
            creating = false
            selectedId = null
          }}
        >
          {$t('agents.settingsButton')}
        </button>
        <button type="button" class="secondary small" onclick={refresh}>{$t('common.refresh')}</button>
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
          <h3 class="warn">{$t('agents.envIssuesTitle')}</h3>
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
          <strong>{$t('agents.emptyTitle')}</strong>
          {$t('agents.emptyHint')}
        </div>
      {:else}
        <ul class="agent-list">
          {#each $agents as a (a.id)}
            {@const reviewer =
              a.role === 'reviewer'
                ? $t('agents.reviewsOthers')
                : !a.reviewerAgentId
                  ? $t('agents.noAutoReview')
                  : ($agents.find((x) => x.id === a.reviewerAgentId)?.name ??
                    $t('agents.reviewerMissing'))}
            <!-- 整条可点：只在名字上加链接的话命中区域太小，而且其余字段看起来像"不可点" -->
            <!--
              ⚠️ 「设为默认」是**兄弟节点**，不能放进 `.agent-item` 里面：
                 那个按钮本身就是一条整行可点的 `<button>`，按钮里套按钮是
                 非法结构，浏览器会把里层那个拆出去（点起来就是坏的）。
            -->
            <li class="agent-row" class:active={a.id === selectedId}>
              <button
                type="button"
                class="agent-item"
                onclick={() => (selectedId = a.id)}
              >
                <span class="agent-line">
                  <strong>{a.name}</strong>
                  <span class="badge {a.role === 'reviewer' ? 'in_review' : 'in_progress'}">
                    {a.role === 'reviewer' ? $t('agents.roleReviewer') : $t('agents.roleExecutor')}
                  </span>
                  {#if a.role === 'reviewer' && a.skillIds.length === 0}
                    <!-- 审核者不挂 skill 就审不了任何东西，这件事必须在列表上就看得见 -->
                    <span class="bad small">{$t('agents.skillMissing')}</span>
                  {/if}
                  {#if a.id === $effectiveDefaultAgentId}
                    <!-- 新建任务的默认选择是谁，必须在列表上看得见 -->
                    <span class="badge default-badge">{$t('agents.defaultBadge')}</span>
                  {/if}
                </span>
                <span class="agent-note faint small">
                  {a.instructions.trim()
                    ? a.instructions.slice(0, 48) + (a.instructions.length > 48 ? '…' : '')
                    : $t('agents.noInstructions')}
                </span>
                <span class="agent-note faint small">
                  {reviewer}{$t('agents.skillCount', { count: a.skillIds.length })}<code>{a.runtimeKey}</code>
                </span>
              </button>

              <!--
                ★ 「默认」是**单选**：每个 agent 一个「设为默认」，点谁就是谁——
                  设了新的，原来那个自动不再是默认。**没有「取消默认」**：
                  必须有一个默认（使用者的要求），空着只会让"新建任务交给谁"
                  变成一个每次都要想的问题。

                  只对执行者给出这个动作——审核者不接任务（服务端也会拒，
                  这里只是别让人白点一次）。
              -->
              {#if a.role === 'executor' && a.id !== $effectiveDefaultAgentId}
                <button
                  type="button"
                  class="ghost small default-toggle"
                  title={$t('agents.setDefaultTitle')}
                  onclick={(e) => {
                    e.stopPropagation()
                    void setDefaultAgent(a.id)
                  }}
                >
                  {$t('agents.setDefault')}
                </button>
              {/if}
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
          <h3>{$t('agents.runtimeLocal')}</h3>
          <p class="hint">
            <strong>{$t('agents.evidenceStrong')}</strong>{$t('agents.colon')}<code>provisional</code>{$t('agents.evidenceAfter')}<strong>{$t('agents.evidenceUnverified')}</strong>{$t('agents.evidenceMid')}<code>verified</code>{$t('agents.evidenceTail')}
            <strong>{$t('agents.versionStrong')}</strong>{$t('agents.colon')}<code>undeclared</code>{$t('agents.versionAfter')}<strong>{$t('agents.versionUntested')}</strong>{$t('agents.versionMid')}{$t('agents.versionTail')}
          </p>

          {#each $identity.runtimes as r (r.key)}
            <div class="runtime-card">
              <div class="runtime-line">
                <code>{r.key}</code>
                {#if r.available}
                  <span class="faint small">{r.cliVersion ?? $t('agents.runtimeReady')}</span>
                {:else}
                  <span class="bad small">{$t('agents.runtimeNotFound')}</span>
                {/if}
                <span class="faint small" class:good={r.evidence === 'verified'}>
                  {$t('agents.runtimeEvidence', { value: r.evidence })}
                </span>
              </div>
              <div class="runtime-line faint small">
                <span class="mono">{r.command}</span>
                <span>{$t('agents.runtimeSession', { state: r.sessionState ?? '—' })}</span>
              </div>
              <div class="runtime-line small">
                <span class="faint">{$t('agents.versionSupportLabel')}</span>
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
            {$t('agents.versionVerifyHint')}<code>pnpm run daemon --verify-runtime all</code>
          </p>
        </section>
      {/if}
    </div>
  </section>

  <!--
    ⚠️ 两个抽屉挂在**这一层**（与主从两栏并列，不在 `.pane-body` 里）：
       它们是浮层，谁都不该"住在"左栏里——那正是上一版把布局整垮的原因。
  -->
  <NewAgentForm
    open={creating}
    onclose={() => (creating = false)}
    oncreated={() => {
      creating = false
      void loadAgents()
    }}
  />
  <WorkspaceSettings open={settingsOpen} onclose={() => (settingsOpen = false)} />

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
          <strong>{$t('agents.pickOneTitle')}</strong>
          {$t('agents.pickOneHint')}
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

  /**
   * ══════════════════════════════════════════════════════════════════
   * 卡片是**这一行**（li），开关在卡片**里面**
   * ══════════════════════════════════════════════════════════════════
   *
   * 第一版把开关放在卡片外面（行是 flex，卡片一个 `width:100%` 的按钮、
   * 开关是它的兄弟）。两个毛病：
   *
   *   1. **溢出**：`.agent-item` 的 `min-width: auto`（flex 默认）不让它缩到
   *      内容宽度以下，于是"卡片 368px + 开关 74px"直接顶出栏外——实测开关
   *      右边缘 710px，而左栏右边界 656px，多出 54px 的横向溢出；
   *   2. **开关挂在边框外面**，看起来像没画完。
   *
   * 现在边框画在 li 上，内层按钮透明、`flex: 1` + `min-width: 0`（这条是上面
   * 那个坑的正解），开关在同一个框里靠右。
   */
  .agent-row {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-1);
    border: 1px solid transparent;
    border-radius: var(--radius);
  }

  .agent-row:hover {
    background: var(--surface-2);
  }

  /* 选中的那条要一眼看出来：主从布局里"右边是谁"全靠这个 */
  .agent-row.active {
    background: var(--surface-2);
    border-color: var(--accent);
  }

  .default-toggle {
    flex-shrink: 0;
    margin: var(--sp-2) var(--sp-2) 0 0;
  }

  .default-badge { color: var(--accent); }

  .agent-item {
    /* ★ `flex: 1` + `min-width: 0`：后者是让按钮能缩到内容宽度以下的关键，
          否则它会把整行顶出栏外（见上面那段） */
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    text-align: left;
    padding: var(--sp-3);
    background: none;
    border: none;
    color: var(--text);
    cursor: pointer;
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
