<script lang="ts">
  import { view, go, VIEWS, openDrawer } from '../lib/view.ts'
  import { identity, syncStatus } from '../lib/stores.ts'

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
  const ITEMS: Array<{ id: (typeof VIEWS)[number]; title: string; hint: string }> = [
    { id: 'new', title: '新建任务', hint: '交给 agent 去做' },
    { id: 'tasks', title: '任务清单', hint: '看板 / 列表 · 执行记录' },
    { id: 'agents', title: '智能体', hint: '配置 · runtime' },
    { id: 'skills', title: 'Skills', hint: '审核标准 · 动作子集' },
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
      <span class="nav-title">{item.title}</span>
      <span class="nav-hint">{item.hint}</span>
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
        title={envIssues.map((i) => i.summary).join('；') || '运行环境正常'}
      >
        <span class="env-dot" class:bad={problem}></span>
        <span class="env-body">
          <span class="env-line">{$identity.deviceName}</span>
          <span class="faint small">
            {#if rt === null}
              未检测到 agent CLI
            {:else if !rt.available}
              未检测到 {rt.command}
            {:else}
              {rt.command} {rt.cliVersion ?? '已就绪'}
            {/if}
            {#if envIssues.length > 0}· {envIssues.length} 个环境问题{/if}
          </span>
        </span>
      </button>
    {/if}

    {#if $syncStatus?.error}
      <div class="faint small" title={$syncStatus.error}>同步异常</div>
    {:else if $syncStatus}
      <div class="faint small">
        已上报 {$syncStatus.reported}
        {#if $syncStatus.queued > 0}· 暂存 {$syncStatus.queued}{/if}
      </div>
    {:else}
      <div class="faint small">尚未同步</div>
    {/if}
  </div>
</nav>
