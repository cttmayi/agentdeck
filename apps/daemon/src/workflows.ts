/**
 * **编排**（2026-11，使用者立项："编排用代码控制，节点 = 智能体组；先做编排任务页，
 * 不破坏现有任务页，后面再把单 Agent 任务移植成单步编排"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 本模块做四件事：类型、存储、引擎状态机、原语定义
 * ══════════════════════════════════════════════════════════════════
 *
 * · 存储是**独立 JSON 文件**（`<dataDir>/workflows.json`），不进 domain 的 store：
 *   编排是 daemon 的"外挂功能"——每步的 run 全部走既有链路（submitRunRequest /
 *   issue / 审核），它自己只是"把几个组串起来跑"的计划，不值得为此动
 *   protocol/domain/store 协议层（判据与 D34 同一句：能不动的层就不动）。
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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunId, WorkspaceId } from '@agentdeck/protocol'
import type { WorkflowRun, WorkflowStep } from '@agentdeck/orchestration'

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
  /** 骨架代码（组 id 用占位符 `groupA/groupB/...`，保存时校验必须替换成真实组）。 */
  code: string
}

/** 固定模板清单（UI「从模板」入口）。 */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    key: 'single-flow',
    name: '单组流程',
    code: `// 单组流程：一个智能体跑一次任务
// {{task}} = 发起运行时填的任务描述（占位符，会被替换）
await flow([agent('智能体名')], '{{task}}')`,
  },
  {
    key: 'sequential',
    name: '顺序流水线',
    code: `// 顺序流水线：A 干完 B 接力（产物自动传递）
await flow([agent('智能体A'), agent('智能体B')], '{{task}}')`,
  },
  {
    key: 'parallel',
    name: '并行派活',
    code: `// 并行派活：分头干（同一任务 → 多个智能体）
const 部分 = await parallel([agent('智能体A'), agent('智能体B')], '{{task}}')
// 聚合 = JS 拼 + 一个 agent
const 汇总 = 部分.map((x) => x.message).join('\n\n')
await flow([agent('合并智能体')], '合并成一份：\n' + 汇总)`,
  },
  {
    key: 'loop',
    name: '评审返工',
    code: `// 评审返工：执行者 ↔ 把关者，审不过就重做（最多 2 次重写）
const 写作 = agent('执行智能体')
const 审查 = agent('审核智能体', (意见) =>
  意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' })
await loop(写作, 审查, '{{task}}', { maxRounds: 2 })`,
  },
  {
    key: 'route',
    name: '路由分流',
    code: `// 路由分流：按任务描述里的关键字选智能体（无命中 = 第一个）
await route({ 代码: agent('代码智能体'), 写作: agent('写作智能体') }, '{{task}}')`,
  },
  {
    key: 'supervise',
    name: '协调者',
    code: `// 协调者：拆任务 + 汇总（二期实现，先用 flow 兜底）
await flow('inline:协调智能体', '{{task}}')`,
  },
  {
    key: 'gate',
    name: '人机把关',
    code: `// 人机把关：干完你拍板（gate 可确认，也可否决并打回重写）
await flow('inline:智能体名', '{{task}}')
await gate('结果请你过目')`,
  },
]

/* ══════════════════════════════════════════════════════════════════
 * 存储（独立 JSON，仿 schedules.json）
 * ══════════════════════════════════════════════════════════════════ */

/** 存储路径（`<dataDir>/workflows.json`）。 */
export function workflowsPath(dir: string): string {
  return join(dir, 'workflows.json')
}

/** 读编排列表；没有文件（从没建过）= 空数组；坏 JSON = 空数组（不炸）。 */
export async function loadWorkflows(dir: string): Promise<Workflow[]> {
  try {
    const raw = await readFile(workflowsPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as Workflow[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 原子写（先写临时文件再 rename，仿 schedules.ts）。 */
export async function saveWorkflows(dir: string, list: readonly Workflow[]): Promise<void> {
  const path = workflowsPath(dir)
  await mkdir(dirname(path), { recursive: true })
  // ⚠️ tmp 名带随机后缀：并发写（编排引擎里 persist 可能在多处 await 交错）
  // 时，两个同毫秒的 Date.now() 会撞名——先 rename 的移走源文件，后者 ENOENT。
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await rename(tmp, path)
}

/** 运行实例的存储路径（`<dataDir>/workflow-runs.json`）。 */
export function workflowRunsPath(dir: string): string {
  return join(dir, 'workflow-runs.json')
}

/** 读运行实例列表（幂等存储：引擎每步 persist 一次，挂 issue 的索引也在这）。 */
export async function loadWorkflowRuns(dir: string): Promise<WorkflowRun[]> {
  try {
    const raw = await readFile(workflowRunsPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as WorkflowRun[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveWorkflowRuns(dir: string, list: readonly WorkflowRun[]): Promise<void> {
  const path = workflowRunsPath(dir)
  await mkdir(dirname(path), { recursive: true })
  // ⚠️ tmp 名带随机后缀：并发写（编排引擎里 persist 可能在多处 await 交错）
  // 时，两个同毫秒的 Date.now() 会撞名——先 rename 的移走源文件，后者 ENOENT。
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await rename(tmp, path)
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
