<script lang="ts">
  import { identity, unreadCount } from '../lib/stores.ts'
  import { openDrawer } from '../lib/view.ts'

  /**
   * 顶栏。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这里只放"与当前视图无关"的东西
   * ══════════════════════════════════════════════════════════════════
   *
   * 身份（这是哪台机器、跑着哪些 CLI）、通知、设置。任何属于某个视图的
   * 内容都不该出现在这里——否则切视图时它会显得"没跟着变"，而使用者
   * 会以为是 bug。
   */
  $: current =
    $identity?.runtimes.find((r) => r.key === $identity?.currentRuntime) ??
    $identity?.runtimes?.[0] ??
    null
</script>

<header class="topbar">
  <div class="brand">alpha-helper</div>

  <div class="identity">
    {#if $identity}
      <span>设备 <strong>{$identity.deviceName}</strong></span>
      {#if current}
        <span class="faint">·</span>
        {#if current.available}
          <span class="good">{current.command} {current.cliVersion ?? '已就绪'}</span>
        {:else}
          <span class="bad">未检测到 {current.command}</span>
        {/if}
        <!-- 证据等级要显示出来：provisional 的 runtime 与实测过的可信度不同，
             把它藏起来会让人以为它们一样可信 -->
        {#if current.evidence !== 'verified'}
          <span class="faint small">({current.evidence} —— 未对照真实程序)</span>
        {/if}
      {/if}
    {:else}
      <span class="faint">正在连接本机 daemon…</span>
    {/if}
  </div>

  <div class="topbar-actions">
    <button type="button" class="ghost" onclick={() => openDrawer.set('inbox')}>
      通知
      {#if $unreadCount > 0}
        <span class="badge in_progress">{$unreadCount}</span>
      {/if}
    </button>
    <button type="button" class="ghost" onclick={() => openDrawer.set('settings')}>设置</button>
  </div>
</header>
