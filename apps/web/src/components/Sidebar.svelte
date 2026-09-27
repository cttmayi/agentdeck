<script lang="ts">
  import { view, go, VIEWS, openDrawer } from '../lib/view.ts'
  import { identity, syncStatus } from '../lib/stores.ts'
  import { t } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'

  /**
   * 侧边栏导航。
   *
   * 每一项都是"一个视图"，右侧主区显示它。
   *
   * ══════════════════════════════════════════════════════════════════
   * 从**四项**变成**五项**（D40）
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来这里写着"保持只有四项——侧边栏一长，就没人扫得完"，而 Runtime 状态与
   * 执行记录都被并进别的项里来凑那四项。D40 加了**工具**（可插拔的行动组）：
   * ★ 使用者的决定是"它就是第五项"，排在 Skills 之后。
   *
   * 为什么不把它并进 Skills：两者**不是一件事**。skill 是给 agent 看的资料
   * （进上下文、影响它怎么写），工具是**能被执行的行动组**（判决里写
   * `<包slug>.<动作名>`、授权单位是组）。并在一起的话，"这个 agent 能干什么"
   * 与"它参考了什么"会挤在同一张表里——而那正是 D40 要拆开的东西。
   *
   * ⚠️ 顺序有含义：新建任务 → 任务清单 → 智能体 → Skills → 工具，是"从干活
   *    到配置"的顺序。工具排在最后，因为它是"给智能体加能力"的配置动作。
   */
  const ITEMS: Array<{
    id: (typeof VIEWS)[number]
    title: WebTextId
    hint: WebTextId
  }> = [
    { id: 'chat', title: 'shell.navChat', hint: 'shell.navChatHint' },
    { id: 'new', title: 'shell.navNewTask', hint: 'shell.navNewTaskHint' },
    { id: 'tasks', title: 'shell.navTasks', hint: 'shell.navTasksHint' },
    { id: 'agents', title: 'shell.navAgents', hint: 'shell.navAgentsHint' },
    { id: 'skills', title: 'shell.navSkills', hint: 'shell.navSkillsHint' },
    // ★ D40 第五项。词条在 `tools.ts`（导航那两条本该在 `shell.ts`，理由写在
    //   那份文件顶部：这一轮的交界不让动 shell.ts，D40 收口时归位）。
    { id: 'tools', title: 'tools.navTitle', hint: 'tools.navHint' },
  ]

  /**
   * ══════════════════════════════════════════════════════════════════
   * 环境状态从**顶栏**挪到侧栏底部
   * ══════════════════════════════════════════════════════════════════
   *
   * 设备名、CLI 版本、证据等级原来常驻顶栏 —— 那条带子是界面上最显眼的位置，
   * 而这三样是**偶尔才看**的诊断信息（排查"agent 为什么没跑起来"时）。常驻
   * 在那里会把"去哪儿"和"我是谁"挤到边上。
   *
   * 挪到侧栏底部之后仍然**一眼可见**（有异常时点一下变红），点开就是设置抽屉。
   */
</script>

<nav class="sidebar">
  {#each ITEMS as item (item.id)}
    <button
      type="button"
      class="nav-item"
      class:active={$view === item.id}
      onclick={() => go(item.id)}
      aria-current={$view === item.id ? 'page' : undefined}
    >
      <span class="nav-title">{$t(item.title)}</span>
      <span class="nav-hint">{$t(item.hint)}</span>
    </button>
  {/each}

  <div class="sidebar-foot">
    {#if $identity}
      {@const rt = $identity.runtimes.find((r) => r.key === $identity?.currentRuntime) ?? $identity.runtimes[0] ?? null}
      {@const envIssues = $identity.environment?.issues ?? []}
      {@const problem = envIssues.length > 0 || (rt !== null && !rt.available)}
      <button
        type="button"
        class="env"
        onclick={() => openDrawer.set('settings')}
        title={envIssues.map((i) => i.summary).join('；') || $t('shell.envOk')}
      >
        <span class="env-dot" class:bad={problem}></span>
        <span class="env-body">
          <span class="env-line">{$identity.deviceName}</span>
          <span class="faint small">
            {#if rt === null}
              {$t('shell.envNoCli')}
            {:else if !rt.available}
              {$t('shell.envMissing', { command: rt.command })}
            {:else if rt.cliVersion}
              {$t('shell.envReady', { command: rt.command, version: rt.cliVersion })}
            {:else}
              {$t('shell.envReadyNoVersion', { command: rt.command })}
            {/if}
            {#if envIssues.length > 0}{$t('shell.envIssueCount', { count: envIssues.length })}{/if}
          </span>
        </span>
      </button>
    {/if}

    {#if $syncStatus?.error}
      <div class="faint small" title={$syncStatus.error}>{$t('shell.syncError')}</div>
    {:else if $syncStatus}
      <div class="faint small">
        {$t('shell.syncedCount', { count: $syncStatus.reported })}
        {#if $syncStatus.queued > 0}{$t('shell.syncedQueued', { count: $syncStatus.queued })}{/if}
      </div>
    {:else}
      <div class="faint small">{$t('shell.neverSynced')}</div>
    {/if}
  </div>
</nav>
