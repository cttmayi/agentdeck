<script lang="ts">
  import { leaveCreate } from '../lib/leave-create.ts'
  import { creating, view, go, VIEWS } from '../lib/view.ts'
  import { t } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'

  /**
   * 侧边栏导航。
   *
   * 每一项都是"一个视图"，右侧主区显示它。
   *
   * ══════════════════════════════════════════════════════════════════
   * D40 的「工具」那一项已经不在了（2026-11，D123）
   * ══════════════════════════════════════════════════════════════════
   * 下面这段解释它当初**为什么**单独占一项，如今留着是因为"为什么曾把它与 Skills
   * 分开"这个判断仍然成立（动作能力退场只是让工具包整个消失，不是又把它并回 Skills）。
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
   * ⚠️ 顺序有含义：任务 → 智能体 → Skills → 工具，是"从干活
   *    到配置"的顺序。工具排在最后，因为它是"给智能体加能力"的配置动作。
   */
  const ITEMS: Array<{
    id: (typeof VIEWS)[number]
    title: WebTextId
    hint: WebTextId
  }> = [
    { id: 'chat', title: 'shell.navChat', hint: 'shell.navChatHint' },
    // ⚠️ 2026-10（D58）：`'new'` 这一项**故意不在导航里**——「新建任务」并进了
    //    「任务」（建 + 看是一件事的两半）。它的视图与词条都留着：路由 `#/new`、
    //    `#/tasks/new` 直达那个表单，任务页顶栏那个主操作也跳它。
    { id: 'tasks', title: 'shell.navTasks', hint: 'shell.navTasksHint' },
    { id: 'agents', title: 'shell.navAgents', hint: 'shell.navAgentsHint' },
    // ⚠️ 2026-11（S3）：这里原来是「智能体组」那一项（D70）。组退场 ⇒ 导航项删。
    { id: 'skills', title: 'shell.navSkills', hint: 'shell.navSkillsHint' },
    // ⚠️ 2026-11（D123）：这里原来还有一项「工具」（D40 的可插拔行动组）。工具包
    //   与动作能力一起退场，页面、视图名、词条都删了。
    // ★ D80 三轮第七项：沉淀（排工具之下——使用者在导航列点名的位置）。
    //   沉淀的整个过程在此页进行（左栏列表切沉淀任务，右栏流程页）。
    { id: 'crystallize', title: 'crystallize.navTitle', hint: 'crystallize.navHint' },
    // ★ 定时任务（2026-11，使用者立项）：到点的任务生成器，排沉淀之下。
    { id: 'schedules', title: 'schedules.navTitle', hint: 'schedules.navHint' },
    // ★ 编排（2026-11，使用者立项）：代码控制的多智能体流程，排定时任务之下
    //   （同属"任务生成器"一类；运行画面是子路由，不是又一个视图）。
    { id: 'workflows', title: 'workflows.navTitle', hint: 'workflows.navHint' },
    /*
     * ⚠️ 2026-11（D132）：这里原来有一项「编排任务」（全部编排运行的列表）。
     *   **删掉**：编排的每一次运行都会建一条 issue，它在**任务页**里按编排分组列着、
     *   点开就是同一个运行画面（`Tasks.svelte` 的 `wfRunForSelected`）——同一批数据
     *   列两处，迟早分叉。定义页「该编排的历史」那一栏照旧（那是按编排看）。
     */
    // ★ 设置（2026-11，使用者立项）：从右侧抽屉改主窗口视图（主题/语言/默认
    //   运行时/成本/远端能力）。排「关于」前面——设置是常用入口。
    { id: 'settings', title: 'settings.navTitle', hint: 'settings.navHint' },
    // ★ 关于（2026-11，使用者立项）：版本 · 环境 · 边界，排最后（它说明"这一台
    //   是怎么搭的"，不是天天用的入口）。
    { id: 'about', title: 'about.navTitle', hint: 'about.navHint' },
  ]

  /**
   * ★ 点某一项去哪儿。
   *
   * ⚠️ 只有一件特殊的事：**「任务」那一项在"正在建任务"时等于"回列表"**，而
   *    表单里可能写着半句话（`createDirty`）。所以那一条要先问一句，其它项照旧
   *    直接走。见 `lib/leave-create.ts` 顶部那段——去掉「返回任务清单」那个按钮
   *    之后，这一项与顶栏那两颗按钮一起，就是"怎么回去"的全部答案，而这里是
   *    **全屏常驻、最容易点到**的那一个。
   *
   * ⚠️ 注意 `$view === 'tasks'` 时点它**不是**空操作：地址从"建任务"回到 `#/tasks`
   *    本来就是一次真实的切换（`$creating` 由地址决定）。
   */
  async function navigate(id: (typeof VIEWS)[number]): Promise<void> {
    if (id === 'tasks' && $creating && !(await leaveCreate())) return
    go(id)
  }
</script>

<nav class="sidebar">
  {#each ITEMS as item (item.id)}
    <button
      type="button"
      class="nav-item"
      class:active={$view === item.id}
      onclick={() => void navigate(item.id)}
      aria-current={$view === item.id ? 'page' : undefined}
    >
      <span class="nav-title">{$t(item.title)}</span>
      <span class="nav-hint">{$t(item.hint)}</span>
    </button>
  {/each}
</nav>
