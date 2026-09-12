import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Run, SubjectRef } from '@alpha-helper/protocol'

/**
 * 工作目录的解析（D27）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条规则改过一次，改的是默认行为
 * ══════════════════════════════════════════════════════════════════
 *
 * D20 原来的说法是"**工作目录由使用者指定**，平台不做仓库检出"。那在
 * "把 agent 接进自己的仓库"这个用法下是对的，但它把**每建一个任务都要先想
 * 一个目录**变成了必须动作——而绝大多数任务只是"让 agent 做点事"，它需要的
 * 是一块空白的、属于它自己的工作区。
 *
 * 现在改成：**每个任务默认自动获得一个独立目录**，不必也不该由使用者操心。
 * 想接自己的仓库时仍然可以显式指定（那是高级用法，不是必经之路）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么目录按**任务**分，而不是按 run 分
 * ══════════════════════════════════════════════════════════════════
 *
 * 用户的原话是"每个**任务**默认生成一个单独的目录"。所以粒度是 `subject`，
 * 不是 run。这个选择带来两个正好需要的行为：
 *
 *   - **同一个任务的重试能看到上次留下的文件。** 按 run 分的话，一次重试
 *     就是一间全新的空房间，agent 上次做到哪儿全丢了——而"重试"的语义
 *     恰恰是"接着做"。
 *   - **同一任务的并发被自动串行化**，因为工作目录锁（FR-RUN-04）本来就是
 *     按目录加的。`waiting_local_directory` 因此从"罕见的例外"变成
 *     "同一个任务上的正常排队"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 目录名用 id，不拼标题
 * ══════════════════════════════════════════════════════════════════
 *
 * 拼标题看起来更友好，但标题是**使用者输入的任意文本**：里面有 `/`、
 * `..`、emoji、超长串。要安全就得做转义，而转义规则一旦有缝就是路径穿越。
 * 用 id 则天然安全，而且 ULID 字典序就是时间序——`ls` 出来自动按时间排。
 * 可读性交给界面：路径显示在任务旁边。
 */

/** 目录名前缀：让 `ls` 一眼看出这是哪类对象的工作区。 */
const SUBJECT_PREFIX: Record<SubjectRef['type'], string> = {
  issue: 'issue',
  report: 'report',
  run: 'run',
}

/**
 * 把 id 收敛成安全的目录名片段。
 *
 * id 本来都是 ULID（纯 ASCII），所以这里的替换在正常数据下**永远不会触发**。
 * 它的存在是因为**这条路径会拼进文件系统**：只要有一天某个 id 来自别处
 * （导入的历史数据、第三方写入的引用），一个没被过滤的 `../` 就会让工作目录
 * 跑到别的地方去。防御性检查写在这里的成本近乎为零，出事的成本是路径穿越。
 */
export function sanitizeIdPart(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_')
  // 全是非法字符时不能返回空串——空串会让 `join(root, '')` 变成根本身，
  // 于是所有这类任务**共用同一个目录**，而且是根目录
  if (cleaned === '' || /^[._-]+$/.test(cleaned)) return 'unknown'
  return cleaned.slice(0, 128)
}

export interface ResolveWorkDirInput {
  /** 请求里显式给的目录（优先级最高）。 */
  requested?: string | null
  /** 该 agent 配置的默认目录（操作者的显式选择）。 */
  agentDefault?: string | null
  /** 自动分配时的根目录。 */
  workRoot: string
  /** 目录按这个对象分组（D27：一个任务一个目录）。 */
  subject: SubjectRef
  /** subject 缺失时的兜底标识（一般用 runId）。 */
  fallbackId: string
}

export interface ResolvedWorkDir {
  path: string
  /** 这个路径是怎么来的——要显示给人看，也要写进审计。 */
  origin: 'requested' | 'agent-default' | 'auto'
  /** 一句可直接展示的说明。 */
  explanation: string
}

/**
 * 决定这次 run 用哪个目录。**纯函数，不碰文件系统**——便于测试与复用。
 *
 * 优先级：
 *   1. 请求里显式给的（使用者就是要用这个目录）
 *   2. 该 agent 配置的默认目录（操作者明确表达过"这个 agent 总在这里干活"）
 *   3. **自动分配**：`<workRoot>/<subjectType>-<subjectId>`（默认路径）
 *
 * 注意第 2 条仍然保留而不是被砍掉：它是一种**显式配置**，不是"没填时的兜底"。
 * 一个被钉在某个仓库上的 agent（比如"只在这个项目里干活的 agent"）正是
 * 这样表达的，而它与"每个任务一个新目录"并不冲突——前者是操作者的选择，
 * 后者是没人选择时的合理默认。
 */
export function resolveWorkDir(input: ResolveWorkDirInput): ResolvedWorkDir {
  const requested = input.requested?.trim()
  if (requested) {
    return {
      path: requested,
      origin: 'requested',
      explanation: '使用显式指定的工作目录',
    }
  }

  const agentDefault = input.agentDefault?.trim()
  if (agentDefault) {
    return {
      path: agentDefault,
      origin: 'agent-default',
      explanation: '使用该 agent 配置的默认工作目录',
    }
  }

  const id = input.subject?.id ? sanitizeIdPart(input.subject.id) : sanitizeIdPart(input.fallbackId)
  const prefix = input.subject?.type ? SUBJECT_PREFIX[input.subject.type] : 'run'
  return {
    path: join(input.workRoot, `${prefix}-${id}`),
    origin: 'auto',
    explanation:
      '自动分配的工作目录（D27）：每个任务一个独立目录，' +
      '同一个任务的重试会看到上次留下的文件',
  }
}

/**
 * 确保目录存在。
 *
 * 在**受理时**创建而不是等到执行时：使用者提交任务后立刻就能在界面上看到
 * 它要去哪儿，而不是等到跑起来才知道（FR-BRIDGE-06：先落盘再返回受理）。
 */
export async function ensureWorkDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * 默认的工作区根目录。
 *
 * 刻意放在**数据目录之外**。数据目录装的是应用自己的状态（日志、blob、锁），
 * 而工作目录装的是 agent 的产出——把两者混在一起，使用者想在文件管理器里
 * 找 agent 做出来的东西时，会先撞上一堆 `logs/` 与 `blobs/`。
 *
 * 默认取数据目录的**同级**，这样"数据在哪、产出在哪"仍然是相邻、可预期的。
 */
export function defaultWorkRoot(dataDir: string): string {
  return join(dataDir, '..', 'work')
}

/** 供界面显示：这个 run 的目录是谁选的。 */
export function describeWorkDirOrigin(run: Pick<Run, 'workDir'>): string {
  return run.workDir ?? '（尚未分配）'
}
