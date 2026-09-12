<script lang="ts">
  import { view, go, VIEWS } from '../lib/view.ts'
  import { syncStatus } from '../lib/stores.ts'

  /**
   * 侧边栏导航。
   *
   * 每一项都是"一个视图"，右侧主区显示它。保持**只有四项**——侧边栏一长，
   * 就没人扫得完，而使用者会退化成凭记忆点。
   *
   * Runtime 状态归到「智能体」（agent 跑在哪个 runtime 上是它的配置问题），
   * 执行记录归到「任务清单」的详情里（执行属于某个任务）。这样四项就够装了。
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
