<script lang="ts">
  import { onMount } from 'svelte'
  import Topbar from './components/Topbar.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import InboxDrawer from './components/InboxDrawer.svelte'
  import SettingsDrawer from './components/SettingsDrawer.svelte'
  import NewTask from './views/NewTask.svelte'
  import Tasks from './views/Tasks.svelte'
  import Agents from './views/Agents.svelte'
  import Skills from './views/Skills.svelte'
  import { openDrawer, toast, view } from './lib/view.ts'
  import {
    loadAgents,
    loadIdentity,
    loadInbox,
    loadIssues,
    loadRuns,
    loadSkills,
    snapshot,
    syncStatus,
  } from './lib/stores.ts'
  import { startSyncLoop } from './lib/sync.ts'
  import { remote } from './lib/remote.ts'

  /**
   * 应用外壳。
   *
   * 职责只有三件：挂上顶栏与侧边栏、按视图切换主区、管抽屉。
   * 具体内容全在各视图里——外壳一旦开始懂业务，改一个视图就要读整个外壳。
   */

  let settings: Record<string, unknown> | null = null

  onMount(() => {
    // 首屏数据。**并行**取，不要串起来等——串行时任何一个慢接口都会让
    // 整个首屏白着。
    void Promise.all([loadIdentity(), loadIssues(), loadAgents(), loadSkills(), loadRuns(), loadInbox()])

    // 同步循环独立于本机功能：远端挂了只影响侧边栏那一行状态
    const loop = startSyncLoop({
      getSettings: () => settings,
      getRecords: () => {
        const { issues, runs } = snapshot()
        return [
          ...runs.map((r) => ({
            kind: 'run',
            digest: `djb2:${r.runId}`,
            conclusion: r.status,
            occurredAt: new Date(r.queuedAt).toISOString(),
          })),
          ...issues.map((i) => ({
            kind: 'action',
            digest: `djb2:${i.id}`,
            actionType: `issue.${i.status}`,
            occurredAt: new Date(i.updatedAt).toISOString(),
          })),
        ]
      },
      onStatus: (s) => {
        syncStatus.set(s)
        // 远端设定里可能带同步配置，每轮读一次 ⇒ 改完**立即生效**，不要求重启
        void remote
          .settings()
          .then((v) => {
            settings = v
          })
          .catch(() => undefined)
      },
    })

    // 两个抽屉共用一个遮罩与 Esc 关闭——分别处理迟早会漏一个
    return () => loop.stop()
  })

  function closeDrawer(): void {
    openDrawer.set(null)
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && $openDrawer) closeDrawer()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<Topbar />

<div class="shell">
  <Sidebar />

  <main class="main">
    {#if $view === 'new'}
      <NewTask />
    {:else if $view === 'tasks'}
      <Tasks />
    {:else if $view === 'agents'}
      <Agents />
    {:else}
      <Skills />
    {/if}
  </main>
</div>

{#if $openDrawer}
  <div class="drawer-backdrop" onclick={closeDrawer} role="presentation"></div>
  {#if $openDrawer === 'inbox'}
    <InboxDrawer onclose={closeDrawer} />
  {:else}
    <!-- 同一个组件，'remote' 只渲染远端那一段（顶栏点「登录」进来的路径） -->
    <SettingsDrawer onclose={closeDrawer} focus={$openDrawer === 'remote' ? 'remote' : 'all'} />
  {/if}
{/if}

{#if $toast}
  <div class="drawer" style="width:auto;left:50%;right:auto;transform:translateX(-50%);top:auto;bottom:var(--sp-5);height:auto;border-radius:var(--radius);border:1px solid var(--line-strong);">
    <div style="padding:var(--sp-3) var(--sp-4)">{$toast}</div>
  </div>
{/if}
