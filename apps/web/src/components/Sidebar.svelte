<script lang="ts">
  import { view, go, VIEWS, openDrawer } from '../lib/view.ts'
  import { identity, syncStatus } from '../lib/stores.ts'
  import { t } from '../lib/i18n.ts'
  import type { WebTextId } from '@alpha-helper/i18n'

  /**
   * 侧边栏导航。
   *
   * 每一项都是"一个视图"，右侧主区显示它。保持**只有四项**——侧边栏一长，
   * 就没人扫得完，而使用者会退化成凭记忆点。
   *
   * Runtime 状态归到「智能体」（agent 跑在哪个 runtime 上是它的配置问题），
   * 执行记录归到「任务清单」的详情里（执行属于某个任务）。这样四项就够装了。
   *
   * ══════════════════════════════════════════════════════════════════
   * 环境状态从**顶栏**挪到这里
   * ══════════════════════════════════════════════════════════════════
   *
   * 设备名、CLI 版本、证据等级原来常驻顶栏 —— 那条带子是界面上最显眼的位置，
   * 而这三样是**偶尔才看**的诊断信息（排查"agent 为什么没跑起来"时）。常驻
   * 在那里会把"去哪儿"和"我是谁"挤到边上。
   *
   * 挪到侧栏底部之后仍然**一眼可见**（有异常时点一下变红），点开就是设置抽屉。
   */
  const ITEMS: Array<{
    id: (typeof VIEWS)[number]
    title: WebTextId
    hint: WebTextId
  }> = [
    { id: 'new', title: 'shell.navNewTask', hint: 'shell.navNewTaskHint' },
    { id: 'tasks', title: 'shell.navTasks', hint: 'shell.navTasksHint' },
    { id: 'agents', title: 'shell.navAgents', hint: 'shell.navAgentsHint' },
    { id: 'skills', title: 'shell.navSkills', hint: 'shell.navSkillsHint' },
  ]
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
