<script lang="ts">
  import { onMount } from 'svelte'
  import Topbar from './components/Topbar.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import InboxDrawer from './components/InboxDrawer.svelte'
  import SettingsDrawer from './components/SettingsDrawer.svelte'
  import { ConfirmDialog } from '@agentdeck/ui/components'
  import { t } from './lib/i18n.ts'
  import Chat from './views/Chat.svelte'
  import Tasks from './views/Tasks.svelte'
  import Agents from './views/Agents.svelte'
  import Groups from './views/Groups.svelte'
  import Skills from './views/Skills.svelte'
  import Tools from './views/Tools.svelte'
  import Crystallize from './views/Crystallize.svelte'
  import { openDrawer, toast, view } from './lib/view.ts'
  import {
    loadAgents,
    loadGroups,
    loadIdentity,
    loadInbox,
    loadIssues,
    loadConversations,
    loadRuns,
    loadSkills,
    loadTools,
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
    void Promise.all([
      loadIdentity(),
      loadIssues(),
      loadAgents(),
      // 智能体组（D70）：组页与新建任务页都要它，首屏一起取。
      loadGroups(),
      loadSkills(),
      loadTools(),
      loadRuns(),
      loadInbox(),
      // 对话列表也在首屏取：它是侧边栏第一项的页面，晚一步到会闪一下空态。
      loadConversations(),
    ])

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
    <!-- ⚠️ 这里**没有** `new` 这一支（2026-10 / D58）：建任务不再是独立一页，
         它是「任务」页右栏的一个状态（`$creating`），由 `Tasks.svelte` 自己画。
         留着一条 `{#if $view === 'new'}` 的后果是"页面有几个"有两份答案——
         而 `ViewName` 里已经没有它了，写出来是编译错误。 -->
    {#if $view === 'chat'}
      <Chat />
    {:else if $view === 'tasks'}
      <Tasks />
    {:else if $view === 'agents'}
      <Agents />
    {:else if $view === 'groups'}
      <!-- ★ D70：智能体组页。与智能体页分开的两个页面（见设计稿 §7.1）。 -->
      <Groups />
    {:else if $view === 'skills'}
      <Skills />
    {:else if $view === 'crystallize'}
      <!-- ★ D80 三轮：沉淀页（导航列工具之下）——沉淀的整个过程在此页进行，
           左栏 = 沉淀任务列表，右栏 = 流程页 / 空态。 -->
      <Crystallize />
    {:else}
      <!-- ★ D40：最后一项。`$view` 的取值来自 `VIEWS`，每一支都写明了是哪个；
           最后这个 `{:else}` 不再兼作别的视图（写死成"剩下的都是 Skills"
           时，加视图会静默落到 Skills 上——页面能打开，只是内容不对）。 -->
      <Tools />
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

<!--
  ★ 确认框挂在**外壳这一层**、只有一份（`askConfirm()` 弹出来的是它）。
    不放进各视图：四个调用点（删对话/删任务/卸技能/卸工具包）里有两个会
    把当前视图整个换掉，弹窗跟着视图卸载就会闪一下。
-->
<ConfirmDialog
  cancelLabel={$t('common.cancel')}
  closeLabel={$t('common.close')}
/>
