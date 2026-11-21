/**
 * 路由的**判据**：地址 → (视图, 是不是在建任务, 沉淀页选没选)。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这一层单独一个文件、而且**不碰 `location`
 * ══════════════════════════════════════════════════════════════════
 *
 * `view.ts` 里挂着 store 与 `window.addEventListener`，那是浏览器环境才有的东西
 * ——`node --test` 里 import 它就崩，于是"地址解析得对不对"这件事**从来没被测过**，
 * 只能靠探针隔着浏览器看。而这个函数的两条分支（老地址、未知地址回落）恰恰是
 * 那种"错了也不报错、只是把人送到别的页面上"的东西。
 *
 * 所以判据放这里：入参是一个字符串，出参是一个对象，纯函数、有单测。
 * `view.ts` 只负责"读 `location.hash` → 调它 → 写 store"。
 */

/**
 * ★ 顺序 = 侧边栏顺序：聊天在最前、沉淀在最后（工具之下）。
 *
 * ⚠️ 2026-10（D58）：「新建任务」**不是**这一个数组里的一项——它是「任务」页右栏
 *    的一个**状态**（`Route.creating`），不是另一个页面。把它留在这里会让"页面
 *     有几个"这件事有两个答案（这个数组说六个、侧栏画五个），而那种分叉最后
 *    一定会在某处漏出来（顶栏页名、探针的项数、文档里的表）。
 *
 * ⚠️ 2026-10（D80 三轮）：`crystallize` 是**第七个视图**（使用者在导航列工具下
 *    加的一页，沉淀的整个过程在此页进行）。它不是聊天/任务的子状态——那版
 *    （`#/chat/crystallize/<runId>`）已经**重定向**到本视图的正规地址。
 */
export const VIEWS = [
  'chat',
  'tasks',
  'agents',
  /*
   * ⚠️ 2026-11（S3）：这里原来有一项 `'groups'`（智能体组页）。组退场、页面删了，
   *   视图名也删掉——理由同下面 `tools` 那条：留着它，`#/groups` 会解析成一个
   *   没有组件的视图（白屏），而不是回落。
   */
  'skills',
  // ⚠️ 2026-11（D123）：这里原来有一项 `'tools'`（工具包页）。工具包与动作能力
  //   一起退场，页面删了，视图名也删掉——留着它，`#/tools` 会解析成一个没有任何
  //   组件的视图（白屏），而不是回落。
  'crystallize',
  // ★ 定时任务（2026-11，使用者立项）：到点的任务生成器，排沉淀之后。
  'schedules',
  // ★ 编排（2026-11，使用者立项）：代码控制的多智能体编排——定义页在这里；
  //   它的"运行画面"是子路由（`#/workflows/run/<runId>`，同 crystallize 模式），
  //   不是又一个视图。排定时任务之后（同属"任务生成器"一类）。
  'workflows',
  /*
   * ⚠️ 2026-11（D132）：这里原来有一项 `'workflow-runs'`（「编排任务」页 = 全部编排
   *   运行的列表）。**删掉**：编排的每一次运行都会建一条 issue（`source.kind =
   *   'workflow'`），它在**任务页**里按编排分组列着，点开就是同一个运行画面
   *   （`Tasks.svelte` 里 `wfRunForSelected` ⇒ `WorkflowRunView embedded`）——
   *   两处列同一批数据，迟早分叉。
   *   留着这个视图名会让 `#/workflow-runs` 解析成一个没有组件的视图（白屏），
   *   而不是回落，所以名字一起删；`#/workflow-runs/<id>` 那种旧链接由
   *   `parseHash` 认成**运行画面**并重写成 `#/workflows/run/<id>`（见下面那段）。
   */
  // ★ 设置（2026-11，使用者立项）：从右侧抽屉改为**主窗口视图**——主题/语言/
  //   默认运行时/成本/远端能力全在这页。排「关于」前面（设置是常用入口）。
  'settings',
  // ★ 关于（2026-11，使用者立项）：版本 · 环境 · 边界，收拢散在各处的诊断信息，
  //   排最后——它是"这一台是怎么搭的"的说明页，不是天天用的入口。
  'about',
] as const
export type ViewName = (typeof VIEWS)[number]

/**
 * 建任务那一栏的正规地址。
 *
 * ★ 写成 `#/tasks/new` 而不是 `#/new`：合并之后"建"是**任务页里的一个位置**，
 *   地址读起来也该是这样。`#/new` 继续认得（见 `parseHash`）——书签、文档、
 *   别人手上的链接都用过它，作废一个地址等于让那些链接悄悄落到别处。
 */
export const CREATE_HASH = '#/tasks/new'

/** 地址里带的那点信息。 */
export interface Route {
  view: ViewName
  /** 「任务」页右栏此刻是**建任务**的表单（而不是某条任务的详情）。 */
  creating: boolean
  /**
   * 沉淀页（`crystallize` 视图）此刻选中了哪条沉淀。
   *
   * 非空 = 右主区在**沉淀流程页**（`#/crystallize/<runId>`）；空 = 列表空态。
   * 与 `creating` 同构：`view` 决定住哪个视图，crystallize 决定右栏画什么。
   */
  crystallize: { runId: string } | null
  /**
   * 编排运行画面（2026-11）：`#/workflows/run/<runId>`——编排视图的主区在画运行画面。
   *
   * ⚠️ 2026-11（D132）：旧地址 `#/workflow-runs/<runId>`（「编排任务」页里点一条）也
   *   解析到**这个**状态，并重写成上面那个正规形态。
   * 非空 = 主区在运行画面；空 = 定义页。与 crystallize 同构。
   */
  workflowRun: { runId: string } | null
  /**
   * 编排内建智能体的编辑页（2026-11，D237）：`#/workflows/agents/<编排id>/<智能体id|new>`。
   *
   * 使用者拍板："编辑的时候，可以类似设置那样，直接跳转过去，然后可以返回回来"。
   * 所以它是**地址**而不是组件里的开关（与 `workflowRun` / `crystallize` 同构）：
   * 刷新还在、地址能分享、返回一步回到同一条编排的详情。
   */
  wfAgent: { workflowId: string; agentId: string } | null
}

/** 沉淀页选中某条的正规地址形态：`crystallize/<runId>`。 */
const CRYSTALLIZE_RE = /^crystallize\/([0-9A-Za-z]+)$/

/**
 * 二轮（`#/chat/crystallize/<runId>` / `#/tasks/crystallize/<runId>`）的**旧地址**。
 *
 * ★ 继续认得——但只认不吐：`parseHash` 把它们解析成沉淀视图的同一状态，
 *   `view.ts` 的 `syncRoute` 顺手把地址**重定向**到正规形态 `#/crystallize/<runId>`
 *   （书签 / 分享链接不作废，使用者定稿：保留并重定向）。
 */
export const LEGACY_CRYSTALLIZE_RE = /^(chat|tasks)\/crystallize\/([0-9A-Za-z]+)$/

/** 编排内建智能体的编辑页：`workflows/agents/<编排id>/<智能体id|new>`。 */
const WF_AGENT_RE = /^workflows\/agents\/([0-9A-Za-z]+)\/([0-9A-Za-z]+|new)$/

/** 旧地址：`#/workflow-runs/<runId>`（「编排任务」页删掉之前，那一页里点一条的地址）。 */
export const LEGACY_WORKFLOW_RUN_RE = /^workflow-runs\/([0-9A-Za-z]+)$/

/** 地址 → 路由。认不出来的一律回落「任务」。 */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  // 沉淀页选中某条：先于普通视图匹配（`crystallize/…` 不是 VIEWS 里的一项）。
  // 编排运行画面子路由：先于普通视图匹配（`workflows/run/…` 不是 VIEWS 里的一项）。
  const wfRun = /^workflows\/run\/([0-9A-Za-z]+)$/.exec(raw)
  if (wfRun) {
    return {
      view: 'workflows',
      creating: false,
      crystallize: null,
      workflowRun: { runId: wfRun[1]! },
      wfAgent: null,
    }
  }
  // 编排内建智能体的编辑页：同样先于普通视图匹配（`workflows/agents/…` 不是 VIEWS 的一项）。
  const wfAgent = WF_AGENT_RE.exec(raw)
  if (wfAgent) {
    return {
      view: 'workflows',
      creating: false,
      crystallize: null,
      workflowRun: null,
      wfAgent: { workflowId: wfAgent[1]!, agentId: wfAgent[2]! },
    }
  }
  /**
   * ⚠️ 2026-11（D132）：`#/workflow-runs/<runId>` 是「编排任务」页时代的地址。那一页
   *   删了，但**这个链接的意思没变**——"打开这一次运行的画面"。所以它现在解析成
   *   **编排视图的运行画面**（`#/workflows/run/<id>`），并由 `syncRoute` 把地址
   *   写回正规形态（与上面 `LEGACY_CRYSTALLIZE_RE` 同一处置：不让两个地址同时活着，
   *   否则刷新之后又跳回旧样子）。
   */
  const wfRunLegacy = LEGACY_WORKFLOW_RUN_RE.exec(raw)
  if (wfRunLegacy) {
    return {
      view: 'workflows',
      creating: false,
      crystallize: null,
      workflowRun: { runId: wfRunLegacy[1]! },
      wfAgent: null,
    }
  }
  const crystal = CRYSTALLIZE_RE.exec(raw)
  if (crystal) {
    return {
      view: 'crystallize',
      creating: false,
      crystallize: { runId: crystal[1]! },
      workflowRun: null,
      wfAgent: null,
    }
  }
  // 旧子路由（聊天/任务右栏的流程页）：同样解析成沉淀视图，地址由 syncRoute 重定向。
  const legacy = LEGACY_CRYSTALLIZE_RE.exec(raw)
  if (legacy) {
    return {
      view: 'crystallize',
      creating: false,
      crystallize: { runId: legacy[2]! },
      workflowRun: null,
      wfAgent: null,
    }
  }
  // ⚠️ 两个地址都指向同一个状态：`tasks/new` 是正规写法，`new` 是 D58 之前那个
  //    「新建任务」整页的地址（当时它还是侧栏一项）。同义地址写两处会不会分叉？
  //    不会——它们在这里**就是同一行**，而 `hashFor()` 只吐正规那个。
  if (raw === 'tasks/new' || raw === 'new') {
    return { view: 'tasks', creating: true, crystallize: null, workflowRun: null, wfAgent: null }
  }
  // 未知地址回落 `tasks`（D58 改的：原来回落到那个表单，而合并之后"任务"才是主场）
  if (!(VIEWS as readonly string[]).includes(raw)) {
    return { view: 'tasks', creating: false, crystallize: null, workflowRun: null, wfAgent: null }
  }
  return { view: raw as ViewName, creating: false, crystallize: null, workflowRun: null, wfAgent: null }
}

/**
 * 路由 → 地址。与 `parseHash` 是**一对**：`parseHash(hashFor(x)) === x` 有单测
 * 逐项钉住（`VIEWS` 里每一项都过一遍）。两处各写一份映射的后果是"点进去是 A、
 * 地址栏写着 B"，而刷新一下才发现。
 */
export function hashFor(
  view: ViewName,
  opts: {
    creating?: boolean
    crystallize?: { runId: string }
    workflowRun?: { runId: string }
    wfAgent?: { workflowId: string; agentId: string }
  } = {},
): string {
  // ⚠️ 编排的两条子路由都与 view 绑定（`workflows`），传进来别的视图就当没传。
  if (opts.wfAgent && view === 'workflows') {
    return `#/workflows/agents/${opts.wfAgent.workflowId}/${opts.wfAgent.agentId}`
  }
  // ⚠️ `crystallize` 只对沉淀视图成立：别的视图没有这个状态，传进来就当没传
  //    （与 `creating` 同一个处方，见下）。
  if (opts.workflowRun && view === 'workflows') {
    return `#/workflows/run/${opts.workflowRun.runId}`
  }
  if (opts.crystallize && view === 'crystallize') {
    return `#/crystallize/${opts.crystallize.runId}`
  }
  // ⚠️ `creating` 只对「任务」成立：别的视图没有"建任务"这个状态，传进来就当没传
  //    （不然会造出一个 `#/agents` 之外还带着建模式的地址，而没人认得它）。
  return opts.creating === true && view === 'tasks' ? CREATE_HASH : `#/${view}`
}
