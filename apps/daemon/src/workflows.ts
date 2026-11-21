/**
 * **编排**（2026-11，使用者立项："编排用代码控制，节点 = 智能体组；先做编排任务页，
 * 不破坏现有任务页，后面再把单 Agent 任务移植成单步编排"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 本模块做四件事：类型、存储、引擎状态机、原语定义
 * ══════════════════════════════════════════════════════════════════
 *
 * · 存储是**自己的目录**（`<dataDir>/workflows/<id>/` + `<dataDir>/workflow-runs/<runId>.json`），
 *   不进 domain 的 store：编排是 daemon 的"外挂功能"——每步的 run 全部走既有链路
 *   （submitRunRequest / issue），它自己只是"把几步串起来跑"的计划，不值得为此动
 *   protocol/domain/store 协议层（判据与 D34 同一句：能不动的层就不动）。
 *   ⚠️ 2026-11（D224）：原来是 `workflows.json` / `workflow-runs.json` 两个大数组文件，
 *   现在改成一实体一目录（形状见 `workflows-dirs.ts` 头注释）——一条坏掉不再毁掉全部。
 *
 * · 引擎是**代码重跑 + 步骤幂等**：
 *   编排代码被包进一个 async 函数（注入原语）执行；每个原语调用按顺序登记一个
 *   步骤（seq）。续跑/重跑时，已完成（done）的步骤直接跳过、不重新提交 run；
 *   gate 步骤以 waiting-human 挂起，确认后才继续；暂停在步骤边界生效。
 *   ⚠️ 幂等键是 seq ⇒ 续跑只对**未改过的代码**有效；改了代码建议重新运行。
 *
 * · 「提交 run」通过注入的 `submit` 回调完成（server 提供：调 submitRunRequest，
 *   组展开/校验/起进程都在那里）——本模块保持纯逻辑、可单测。
 *
 * · ⚠️ 安全边界：原语只接受**组 id / 内嵌智能体**，不接受任意 workDir 的 run；
 *   编排代码是使用者自己写的（本机工具，等同定时任务的 cron 表达式）——它
 *   只能"用已配置的组跑"，不能开放代码执行入口。
 */

import type { WorkspaceId } from '@agentdeck/protocol'
import type { WorkflowRun, WorkflowStep } from '@agentdeck/orchestration'
import {
  legacyWorkflowRunsPath,
  legacyWorkflowsPath,
  listWorkflowDirs,
  listWorkflowRunFiles,
  migrateLegacyWorkflowRuns,
  migrateLegacyWorkflows,
  removeWorkflowDir,
  writeWorkflowDir,
  writeWorkflowRunFile,
  workflowsRoot,
  workflowDirPath,
  workflowRunPath,
  workflowRunsRoot,
} from './workflows-dirs.ts'

/* ══════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════ */

/** 编排定义（一个有名字的代码脚本，节点 = 组 / 内嵌智能体）。 */
export interface Workflow {
  id: string
  workspaceId: WorkspaceId
  name: string
  /** 编排代码（一等公民：模板/快捷/AI 生成的也是代码，随时可改）。 */
  code: string
  /** 来源：模板 / 手动 / AI（聊天里生成后采纳）。 */
  source: 'template' | 'manual' | 'ai'
  /** 模板键（source==='template' 时记录是哪个模板，展示用）。 */
  templateKey: string | null
  /** 编排内嵌智能体（只在编排里有效，不占智能体组页）。 */
  inlineAgents: WorkflowInlineAgent[]
  createdAt: number
  updatedAt: number
}

/** 编排内嵌智能体：只在编排里有效的执行者/审核者（2026-11 使用者："可以给编排
 *  单独设置智能体（只在编排有用）"）。代码里用 `inline({...})` 引用。 */
export interface WorkflowInlineAgent {
  id: string
  /** 名字（展示 + 代码里引用）。 */
  name: string
  /** 角色：执行者 / 审核者 / 执行（不审）。 */
  role: 'executor' | 'reviewer' | 'executor-no-review'
  /** 模型 runtime（claude / codex / generic…）。 */
  model: string | null
  /** 审核标准（role 是 reviewer 时）。 */
  reviewStandard: string | null
}

/** 模板骨架：新建编排时插入代码。 */
export interface WorkflowTemplate {
  key: string
  name: string
  /** 骨架代码（**语法必须合法**、只用现有原语——`templates.test.ts` 逐条编译检查）。 */
  code: string
  /** 一句话说清它做什么（界面上当副标题，别让人靠读代码猜）。 */
  summary: string
}

/**
 * 固定模板清单（UI「从模板」入口）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-11 使用者：这批模板"并没有实际用途，建议给实际有用的编排"
 * ══════════════════════════════════════════════════════════════════
 *
 * 旧的那七条（单组流程 / 顺序流水线 / 并行派活 / 评审返工 / 路由分流 / 协调者 / 人机把关）
 * 是**语法演示**：读完知道原语怎么用，但真拿去做事还得自己从头写。而且其中两条
 * 是**坏的**——`flow('inline:协调智能体')` 传的是字符串，而 `flow` 的入参是
 * `Handle[]`（内部 `agents.map`）⇒ 一跑就炸。
 *
 * 新的五条都是**一件真实的活**，并且各自演示一个"真有用"的组合：
 *   ① 流水线 + **人放行**（`reuseOutput`：不重写，直接问你）
 *   ② 机器把关的返工循环 + 人放行（两个 loop 串起来）
 *   ③ 并行调研 + 汇总 + 人放行（并行结果用 JS 拼，再交给一个 agent 收口）
 *   ④ 并行改造 + 核验 + 人放行（多模块同时改、先核验冲突）
 *   ⑤ 发布前多路检查 + 人拍板（每个检查项一个 agent，结论汇总）
 *
 * ⚠️ 代码里的 **agent 名字是占位**（"数据员"这类）：跑之前要在智能体页建同名智能体，
 *    或者把名字换成你已经有的。模板开头的注释就是这么写的——**别让模板看起来能直接跑**。
 * ⚠️ 每条都必须**语法合法、只用现有原语**：`templates.test.ts` 逐条编译检查，
 *    并禁止 `inline:` / 组名这些已经退场的写法（老模板坏在这上面）。
 */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    key: 'weekly-report',
    name: '周报流水线（含你放行）',
    code: `// 周报：取数 → 成稿 → 你过目
// ⚠️ 把 agent('…') 里的名字换成你智能体页里真实的智能体
const 取数 = agent('数据员')
const 撰稿 = agent('撰稿员')

// ① 取数 → 成稿（第二个人接着第一个人的产物写）
await flow([取数, 撰稿], '{{task}}')

// ② 你过目：**不重写**，直接把这一版摆到你面前；不满意就带着你的意见重写（最多 3 次）
await loop(撰稿, gate('这版周报可以发了吗？不满意请说明，我会打回重写'), {
  maxRounds: 3,
  reuseOutput: true,
})`.trimEnd(),
    summary: '两个人接力写完，再让你放行',
  },
  {
    key: 'review-rework',
    name: '写完自动复查（不过就重写）',
    code: `// 写完自动复查：机器把关在前、你放行在后
// ⚠️ 把 agent('…') 里的名字换成你智能体页里真实的智能体
const 开发 = agent('开发')
const 复查 = agent('代码审查员', (意见) =>
  意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' })

// ① 写 ↔ 复查：不通过就带着意见重写（最多 3 轮）
await loop(开发, 复查, '{{task}}', { maxRounds: 3 })

// ② 机器过了再给你看：不重写，只等你决定
await loop(开发, gate('改完了，请过目'), { maxRounds: 2, reuseOutput: true })`.trimEnd(),
    summary: '机器先挑一遍毛病，再交给你',
  },
  {
    key: 'research-brief',
    name: '并行调研 → 汇总成一份',
    code: `// 并行调研：两个人分头查，再合成一份交给你
// ⚠️ 把 agent('…') 里的名字换成你智能体页里真实的智能体
const 甲 = agent('调研员甲')
const 乙 = agent('调研员乙')
const 汇总 = agent('报告撰写员')

// ① 分头查（同一任务，两个人各查一路）
const 两路 = await parallel([甲, 乙], '{{task}}')
const 材料 = 两路
  .map((r) => (typeof r.message === 'string' ? r.message : ''))
  .filter((s) => s.trim() !== '')
  .join('\\n\\n')

// ② 合成一份（并行结果由 JS 拼好，再交给一个人收口）
await flow([汇总], '把下面几路材料整理成一份报告：\\n\\n' + 材料)

// ③ 你过目
await loop(汇总, gate('报告可以发了吗'), { maxRounds: 3, reuseOutput: true })`.trimEnd(),
    summary: '两路并行查，一份汇总给你',
  },
  {
    key: 'batch-refactor',
    name: '批量改造（并行改 + 核验冲突）',
    code: `// 批量改造：几个模块同时改，改完先核验有没有互相踩
// ⚠️ 把 agent('…') 里的名字换成你智能体页里真实的智能体
const 模块A = agent('模块A负责人')
const 模块B = agent('模块B负责人')
const 模块C = agent('模块C负责人')
const 核验 = agent('合并核验员')

// ① 三路同时改
const 三路 = await parallel([模块A, 模块B, 模块C], '{{task}}')
const 清单 = 三路
  .map((r) => (typeof r.message === 'string' ? r.message : ''))
  .filter((s) => s.trim() !== '')
  .join('\\n\\n')

// ② 核验 + 给合并顺序
await flow([核验], '下面几路改动是否互相冲突？给出合并顺序与风险点：\\n\\n' + 清单)

// ③ 你决定要不要合
await gate('改动清单与合并顺序在这，确认后你自己合并')`.trimEnd(),
    summary: '多模块并行改，先核验再交给你',
  },
  {
    key: 'release-check',
    name: '发布前检查（多路结论汇总）',
    code: `// 发布前检查：几个检查项并行跑，最后合成一句"能不能发"
// ⚠️ 把 agent('…') 里的名字换成你智能体页里真实的智能体
const 检查 = [agent('测试员'), agent('安全审查员'), agent('文档校对')]
const 收口 = agent('发布协调员')

// ① 各查各的
const 结论 = await parallel(检查, '{{task}}')
const 汇总材料 = 结论
  .map((r) => (typeof r.message === 'string' ? r.message : ''))
  .filter((s) => s.trim() !== '')
  .join('\\n\\n')

// ② 合成一句结论
await flow([收口], '把下面几项检查结论汇总成"能不能发布"+ 阻塞项：\\n\\n' + 汇总材料)

// ③ 你拍板
await gate('可以发布了吗')`.trimEnd(),
    summary: '测试 / 安全 / 文档并行查，你来放行',
  },
]

/* ══════════════════════════════════════════════════════════════════
 * 存储（一实体一目录——落盘形状在 `workflows-dirs.ts`）
 * ══════════════════════════════════════════════════════════════════ */

/*
 * 下面这一组是**读写的门面**：server 只认这五个名字，形状全在 `workflows-dirs.ts`。
 *
 * 为什么读要返回 `{ …, errors }` 而不是直接给数组：2026-11 之前是
 * `catch { return [] }`——一个坏文件让编排页变空，而日志里一个字都没有。
 * 现在**逐条读、逐条报**：坏的那条点名，其余照常（使用者的编排不会因为邻居坏了而消失）。
 */

/** 读全部编排（顺带把老的 `workflows.json` 迁成目录，幂等）。 */
export async function loadWorkflows(dir: string): Promise<{
  workflows: Workflow[]
  errors: string[]
  migrated: { migrated: number; skipped: number; errors: string[] } | null
}> {
  const migrated = await migrateLegacyWorkflows(dir)
  const { workflows, errors } = await listWorkflowDirs(dir)
  return { workflows, errors, migrated }
}

/** 写一条编排（`workflow.json` + `main.js`，两份都原子写）。 */
export async function saveWorkflow(dir: string, workflow: Workflow): Promise<void> {
  await writeWorkflowDir(dir, workflow)
}

/** 删一条编排（整个目录，含代码）。运行记录**不删**——历史是历史。 */
export async function removeWorkflow(dir: string, id: string): Promise<void> {
  await removeWorkflowDir(dir, id)
}

/** 读全部运行记录（顺带把老的 `workflow-runs.json` 迁成目录，幂等）。 */
export async function loadWorkflowRuns(dir: string): Promise<{
  runs: WorkflowRun[]
  errors: string[]
  migrated: { migrated: number; skipped: number; errors: string[] } | null
}> {
  const migrated = await migrateLegacyWorkflowRuns(dir)
  const { runs, errors } = await listWorkflowRunFiles(dir)
  return { runs, errors, migrated }
}

/**
 * 写**一条**运行记录。
 *
 * 为什么是"一条"而不是"整表"：引擎每步都会 persist 一次。以前每次都是把**全部**运行
 * （真机上 23 条 / 47 KB）重写一遍；现在是它自己那个文件（几 KB 以内），
 * 而且一条坏掉不会牵连别的运行。
 */
export async function saveWorkflowRun(dir: string, run: WorkflowRun): Promise<void> {
  await writeWorkflowRunFile(dir, run)
}

/** 落盘路径（给启动日志与测试用；别在别处自己拼路径）。 */
export {
  legacyWorkflowsPath,
  legacyWorkflowRunsPath,
  workflowsRoot,
  workflowDirPath,
  workflowRunPath,
  workflowRunsRoot,
}

/* ══════════════════════════════════════════════════════════════════
 * 审核前置判据（纯函数——server 用、单测直接量）
 * ══════════════════════════════════════════════════════════════════ */

/** 被审 run 的最小形状（只取判据要用的两个字段）。
 *  ⚠️ `failureMessage` 显式带 `| undefined`：`exactOptionalPropertyTypes` 下，
 *  "字段存在但值是 undefined"与"字段不存在"是两回事——Run 实体传进来的就是前者。 */
export interface ReviewableRun {
  status: string
  failureMessage?: string | null | undefined
}

/**
 * 这条被审 run **能不能送审**（编排的把关者位提交审核 run 之前必过的一关）。
 *
 * ★ 为什么要有这一关（2026-11 使用者报的真机缺陷）：
 *   原来只要步骤链上登记了一个 runId 就送去审，不看那条 run 的死活。真机后果是
 *   **两个方向都错**：codex 在 `thread/resume` 上 infra 失败的那两步，审核员拿到的是
 *   空的【产出】——一次判「不通过」（写作员被拖去重写，真实原因是这条 run 根本没跑），
 *   另一次对**同样的空材料**判「通过」，于是编排把没跑成的一步当通过往下走，
 *   运行画面停在 waiting-human，谁也不知道中途失败过。
 *
 *   这一关必须由平台把住：模型对空材料既可能说"不通过"也可能说"通过"，两种输出
 *   都不是对产出的判断，而判过之后会真的影响流程。
 *
 * 与 `submitStep` 执行分支的关系：那边在子 run 未 completed 时返回失败，原语据此
 * 抛错（`primitives.ts` 的 `执行失败`）。这里是**第二道闸**——两道都要在：
 * 少一道，"拿失败 run 去审"就又从别的路径回来了。
 */
export function checkReviewable(
  run: ReviewableRun,
  output: string,
): { ok: true } | { ok: false; error: string } {
  if (run.status !== 'completed') {
    const why = run.failureMessage ? `：${run.failureMessage}` : ''
    return {
      ok: false,
      error: `被审的执行 run 没有正常完成（status=${run.status}${why}），不提交审核`,
    }
  }
  // 完成但零产出（模型端空响应之类）也是"没有可审的东西"。
  if (output.trim() === '') {
    return { ok: false, error: '被审的执行 run 没有产出（空文本），不提交审核' }
  }
  return { ok: true }
}

/* ══════════════════════════════════════════════════════════════════
 * 引擎（v5）——已迁到 @agentdeck/orchestration（与界面/daemon 解耦）
 * ══════════════════════════════════════════════════════════════════ */

export { executeWorkflow } from '@agentdeck/orchestration'
export type {
  EngineHooks,
  GateVerdict,
  StepSubmitOptions,
  StepSubmitResult,
  WorkflowRun,
  WorkflowStep,
} from '@agentdeck/orchestration'
