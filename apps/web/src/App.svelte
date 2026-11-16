<script lang="ts">
  import { onMount } from 'svelte'
  import Topbar from './components/Topbar.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import InboxDrawer from './components/InboxDrawer.svelte'
  import { ConfirmDialog } from '@agentdeck/ui/components'
  import { t } from './lib/i18n.ts'
  import Chat from './views/Chat.svelte'
  import Tasks from './views/Tasks.svelte'
  import Agents from './views/Agents.svelte'
  import Skills from './views/Skills.svelte'
  import Crystallize from './views/Crystallize.svelte'
  import Schedules from './views/Schedules.svelte'
  import Workflows from './views/Workflows.svelte'
  import WorkflowRuns from './views/WorkflowRuns.svelte'
  import About from './views/About.svelte'
  import Settings from './views/Settings.svelte'
  import { openDrawer, toast, view } from './lib/view.ts'
  import {
    loadAgents,
    loadIdentity,
    loadInbox,
    loadIssues,
    loadConversations,
    loadWorkflows,
    loadWorkflowRuns,
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
    void Promise.all([
      loadIdentity(),
      loadIssues(),
      loadAgents(),
      loadSkills(),
      loadRuns(),
      loadInbox(),
      // 对话列表也在首屏取：它是侧边栏第一项的页面，晚一步到会闪一下空态。
      loadConversations(),
      // 编排（2026-11）：定义列表 + 运行实例（任务列表的编排徽标、编排页历史都要）。
      loadWorkflows(),
      loadWorkflowRuns(),
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
    <!-- ⚠️ 2026-11（S3）：这里原来是「智能体组」页（D70）。组退场、页面删了。 -->
    {:else if $view === 'skills'}
      <Skills />
    {:else if $view === 'crystallize'}
      <!-- ★ D80 三轮：沉淀页（导航列工具之下）——沉淀的整个过程在此页进行，
           左栏 = 沉淀任务列表，右栏 = 流程页 / 空态。 -->
      <Crystallize />
    {:else if $view === 'schedules'}
      <!-- ★ 定时任务（2026-11，使用者立项）：到点的任务生成器。
           左栏 = 定时任务列表，右栏 = 新建表单 / 详情（含触发记录）。 -->
      <Schedules />
    {:else if $view === 'workflows'}
      <!-- ★ 编排（2026-11，使用者立项）：代码控制的多智能体流程。
           定义页在这里；`$workflowRun` 非空时右主区画「编排任务页」（子路由）。 -->
      <Workflows />
    {:else if $view === 'workflow-runs'}
      <!-- ★ 编排任务（2026-11，使用者拍板侧栏加一项）：全部编排运行的列表，
           点一条进运行画面（子路由 `#/workflows/run/<id>`）。 -->
      <WorkflowRuns />
    {:else if $view === 'settings'}
      <!-- ★ 设置（2026-11，使用者立项）：从右侧抽屉改主窗口视图——
           主题/语言/默认运行时/成本/远端能力全在这页。 -->
      <Settings />
    {:else if $view === 'about'}
      <!-- ★ 关于（2026-11，使用者立项）：版本 · 环境 · 边界。
           收拢散在各处的诊断信息（侧栏底部状态块 / 设置抽屉诊断折叠区）。 -->
      <About />
    {/if}
    <!--
      ⚠️ 2026-11（D123）：这里原来还有一个 `{:else} <Tools />`（工具包页）。
      「工具」这个视图随**动作能力退场**一起删了（`VIEWS` 里没有它了），所以不再有
      兜底那一支——`VIEWS` 的每一项上面都有一支显式的，地址不认识时是 `parseHash`
      回落成 `chat`，不该再有"剩下的都送到某页"这种兜底（它会把打错的地址静默
      送到一个看似正常的页面）。 -->

  </main>
</div>

{#if $openDrawer}
  <div class="drawer-backdrop" onclick={closeDrawer} role="presentation"></div>
  <!-- ★ 2026-11：设置从抽屉改主窗口视图——抽屉只剩「通知」（inbox）；
     设置/登录都在「设置」页（`views/Settings.svelte`）。 -->
  <InboxDrawer onclose={closeDrawer} />
{/if}

{#if $toast}
  <!-- ★ 用 `.toast`，不再借 `.drawer`（理由见 `app.css` 里那一段：一个会过期的提示
       不该被当成抽屉，"每个抽屉都得有 drawer-head"那条判据会被它误伤）。 -->
  <div class="toast">
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
