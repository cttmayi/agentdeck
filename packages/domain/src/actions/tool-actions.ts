import { z } from 'zod'
import {
  actionEntry,
  toolActionType,
  toolSlugOfAction,
  type ActionPlane,
  type ActionRef,
  type ActionRefType,
  type BoundParamSpec,
  type OpenParamSpec,
  type Tool,
  type ToolRuntime,
} from '@agentdeck/protocol'
import {
  type ActionDefinition,
  type ActionValidation,
} from './definition.ts'

/**
 * 工具包动作（D40）：把**已安装**的工具包摊成"动作名 → 定义"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件是纯的
 * ══════════════════════════════════════════════════════════════════
 *
 * 不读 store、不碰 fs、不起进程。输入是 `Tool[]`（调用方从
 * `store.listTools(workspaceId)` 取），输出是定义 / 校验结果。
 *
 * 为什么这条界线值得守：这里的每个判断都是**安全判断**——"这个动作存不存在"
 * "模型给的参数能不能过" "绑定值有没有缺失"。它们的正确性只该取决于
 * 传进来的清单与事实，一旦掺进"顺便去读一下磁盘/数据库"，就无法在单测里
 * 把每一种坏输入摆出来，而这些判断恰恰是最需要摆出来的东西。
 *
 * ══════════════════════════════════════════════════════════════════
 * 平台保留的四件事里，这个文件管两件
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **参数绑定与校验** —— 本文件（`bindParams` / `validateOpenParams` /
 *      `mergeActionParams` / `validateActionRefWith`）；
 *   ② 幂等（键含 verdictId）、审计、状态 —— 在 `state/action.ts` 与 daemon 侧，
 *      本文件**不碰**。
 *
 * 执行（真去跑脚本）在 `apps/daemon/src/script-executor.ts`。执行器不认识
 * "bound / open" 这套区分：它只拿到**已经合并好的参数**——边界是平台的事，
 * 不该漏给脚本。
 *
 * ══════════════════════════════════════════════════════════════════
 * bound / open 二分，以及为什么"未声明即拒绝"要在这里再判一次
 * ══════════════════════════════════════════════════════════════════
 *
 * 安装时已经校验过清单（`packages/protocol/src/tools.ts` 的 `ToolManifest`）。
 * 这里再判一次不是不信任 zod，而是因为**判的东西不同**：
 *
 *   · 安装时判："这份清单是不是适配本平台"（结构、命名、限额）；
 *   · 这里判："**这条工作区**现在能不能执行这个动作"（包装没装、
 *     动作名对不对、事实够不够把绑定值算出来）。
 *
 * 第二种判断依赖运行时的状态（装了哪些包、这条 run 有没有工作目录），
 * 安装那一刻根本无从得知。
 */

// ══════════════════════════════════════════════════════════════════
// 定义
// ══════════════════════════════════════════════════════════════════

/**
 * 协议里 `BoundParamSpec` 只导出了 schema、没有配套的 type
 * （`OpenParamSpec` 两者都有）。这里就地取它的推断类型，不去改协议文件——
 * 那是另一个工作面的东西，而这里需要的只是"校验过之后的那个形状"。
 */
type BoundSpec = z.infer<typeof BoundParamSpec>
type OpenSpec = z.infer<typeof OpenParamSpec>

/** 动作是哪个包给的。审计与界面要能回答"这条动作是谁提供的"。 */
export interface ToolProvider {
  /** 包 slug（= 组名 = 动作命名空间）。 */
  slug: string
  toolId: string
  /** 给人看的包名。 */
  name: string
  version: string | null
  /** 来源：本机目录还是远端目录。 */
  source: 'local' | 'remote'
  /** 来源标识（`path:/…` / `remote:…`）。 */
  sourceRef: string | null
}

/**
 * 一个第三方动作的完整定义。
 *
 * 它**是**一份 `ActionDefinition`（动作定义只有这一种来源），外加
 * 执行它所需要的那些东西（runtime、入口、超时、dry-run 能力、执行器键）。
 */
export interface ToolActionDefinition extends ActionDefinition {
  type: ActionRefType
  plane: ActionPlane
  provider: ToolProvider
  /** 组内动作名（**不含**命名空间）。 */
  name: string
  runtime: ToolRuntime
  /** 相对包根的入口（动作自己的 `entry`，没有则用包级 `entry`）。 */
  entry: string
  /** 绑定参数规格：模型看不见、也填不了。 */
  bound: Readonly<Record<string, BoundSpec>>
  /** 开放参数规格：模型填的那部分，每一项都有界。 */
  open: Readonly<Record<string, OpenSpec>>
  /**
   * ★ 是否支持 dry-run。
   *
   * 不支持的动作**不许被平台在 dry-run 模式下调用**——约定是脚本自己保证
   * "dry-run 时不改"，而没法保证的脚本只能老实写 `unsupported`，
   * 代价是它不能被自动执行。
   */
  dryRun: 'supported' | 'unsupported'
  timeoutMs: number
  /**
   * 执行器键。`script:<slug>` —— 说清"这一组动作由哪个执行器跑"。
   *
   * 用不透明字符串（而不是函数引用）是为了让定义可以进日志、进审计、
   * 甚至跨进程传递：函数引用一序列化就没了，而"由谁执行"这句话必须留着。
   */
  executorKey: `script:${string}`
}

/** 这个定义是不是第三方工具动作（内置定义没有 `provider`）。 */
export function isToolActionDefinition(
  definition: ActionDefinition,
): definition is ToolActionDefinition {
  return 'executorKey' in definition && 'provider' in definition
}

/** 参数值的简短摘要——只用于日志/通知里的一行话，不进任何契约。 */
function summarizeParams(params: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(params)
  if (entries.length === 0) return ''
  const shown = entries.slice(0, 3).map(([k, v]) => {
    const raw =
      typeof v === 'string' ? v : v === null || v === undefined ? String(v) : JSON.stringify(v)
    const text = raw === undefined ? 'undefined' : raw
    return `${k}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`
  })
  const more = entries.length > shown.length ? ` 等 ${entries.length} 个` : ''
  return `（${shown.join('，')}${more}）`
}

/**
 * 把一个 `ToolActionSpec` 变成定义。
 *
 * `params` 字段（`ActionDefinition` 要求）是**最终参数**的形状校验：
 * 开放参数按各自的界严格校验，绑定参数原样通过（它们的值由平台算出来，
 * 不是外部输入，所以这里没有什么可判的——但要**在**：缺了就是平台绑错了）。
 *
 * 为什么需要它而不是只用 `validateOpenParams`：`validateActionRefWith`
 * 会先把绑定值注入再校验，那时"最终参数"才第一次成形；这一层是那次校验的
 * 落点，也是"绑定值一定被注入过"的机器检查。
 */
function buildDefinition(tool: Tool, action: Tool['manifest']['actions'][number]): ToolActionDefinition {
  const type = toolActionType(tool.manifest, action.name)
  const open: Record<string, OpenSpec> = { ...action.params.open }
  const bound: Record<string, BoundSpec> = { ...action.params.bound }

  const shape: Record<string, z.ZodType> = {}
  for (const key of Object.keys(bound)) {
    // 绑定参数：值由平台算出来。`undefined` 视为"没绑上"——那是平台的 bug，
    // 不该被悄悄放过（`z.unknown()` 本身接受 undefined，所以要显式收紧）。
    shape[key] = z
      .unknown()
      .refine((v) => v !== undefined, { message: '绑定参数缺失（平台没有绑上）' })
  }
  for (const [key, spec] of Object.entries(open)) {
    shape[key] = openParamSchema(spec)
  }

  return {
    type,
    plane: 'local',
    provider: {
      slug: tool.slug,
      toolId: String(tool.id),
      name: tool.manifest.name,
      version: tool.manifest.version,
      source: tool.source,
      sourceRef: tool.sourceRef,
    },
    name: action.name,
    runtime: tool.manifest.runtime,
    entry: actionEntry(tool.manifest, action),
    bound,
    open,
    reversible: action.reversible,
    dryRun: action.dryRun,
    timeoutMs: action.timeoutMs,
    executorKey: `script:${tool.slug}`,
    params: z.strictObject(shape),
    describe: (p) => {
      const summary = `${tool.manifest.name}（${type}）：${action.summary}`
      return `${summary}${summarizeParams(p)}`
    },
  }
}

/** 单个开放参数的 zod 形状——与 `validateOpenParams` 判的是同一件事。 */
function openParamSchema(spec: OpenSpec): z.ZodType {
  let base: z.ZodType
  switch (spec.type) {
    case 'string':
      base = z.string().max(spec.max)
      break
    case 'integer':
      base = z.number().int().min(spec.min).max(spec.max)
      break
    case 'boolean':
      base = z.boolean()
      break
    case 'enum':
      base = z
        .string()
        .refine((v) => (spec.values as readonly string[]).includes(v), {
          message: `允许的取值：${spec.values.join('、')}`,
        })
      break
  }
  return spec.required ? base : base.optional()
}

/**
 * 把一个工作区里**已安装**的工具包摊成"动作名 → 定义"。
 *
 * 动作名是 `<slug>.<name>`（与判决里写的完全一致）。
 *
 * ⚠️ slug 在同一个工作区内唯一（存储层的 `getToolBySlug` 就是这么用的）。
 *    真出现两个同 slug 的包时**先装的赢**——不合并、不静默覆盖：动作名是
 *    判决里写死的字符串，"两个包都想提供它"这件事没有任何正确答案，
 *    而"后者悄悄顶掉前者"会让同一条判决在不同时间执行出不同的东西。
 */
export function toolActionDefinitions(
  tools: readonly Tool[],
): Record<string, ToolActionDefinition> {
  const definitions: Record<string, ToolActionDefinition> = {}
  const seenSlug = new Set<string>()

  for (const tool of tools) {
    if (seenSlug.has(tool.slug)) continue
    seenSlug.add(tool.slug)
    for (const action of tool.manifest.actions) {
      const type = toolActionType(tool.manifest, action.name)
      if (type in definitions) continue
      definitions[type] = buildDefinition(tool, action)
    }
  }

  return definitions
}

/**
 * 按动作名找一个**已安装**的工具动作。找不到 ⇒ `null`。
 *
 * 找不到的三种情况（对调用方是同一件事——"这个动作不可用"）：
 *   ① 名字不带包 slug（`<包 slug>.<动作名>` 是唯一的形状）；
 *   ② 命名空间对应的包没装；
 *   ③ 包装了，但清单里没有这个动作名。
 */
export function resolveToolActionDefinition(
  type: string,
  tools: readonly Tool[],
): ToolActionDefinition | null {
  const slug = toolSlugOfAction(type)
  if (slug === null) return null
  const tool = tools.find((t) => t.slug === slug)
  if (!tool) return null
  const action = tool.manifest.actions.find((a) => toolActionType(tool.manifest, a.name) === type)
  if (!action) return null
  return buildDefinition(tool, action)
}

/**
 * 解析一个动作类型：按 `<包 slug>.<动作名>` 在**已安装的工具包**里找。
 *
 * 返回 `null` ⇒ 调用方按"未知动作类型"处理（走既有的 invalid 路径，
 * 而不是忽略这条动作——忽略等于给模型留了一条绕过边界的路）。
 *
 * ⚠️ 这里原来有一段"**内置优先**"的分支：内置动作是裸名（`comment.create` 那种
 *    恰好长得像命名空间的名字），搜索时得先查注册表、再查工具包，还得靠
 *    `RESERVED_TOOL_SLUGS` 挡住想占用那几个前缀的工具包。D41 把内置动作整个
 *    删掉之后这一整套都不需要了：**每个动作名都带包 slug**，只有一种来源，
 *    不存在"内置压住第三方"的撞车。
 */
export function resolveActionDefinition(
  type: string,
  tools: readonly Tool[],
): ToolActionDefinition | null {
  return resolveToolActionDefinition(type, tools)
}

// ══════════════════════════════════════════════════════════════════
// 参数绑定
// ══════════════════════════════════════════════════════════════════

/**
 * 绑定参数要用到的**事实**。
 *
 * 它不是"用户输入"，而是平台自己对当前处境的描述：这条 run 在审谁、
 * 有没有工作目录。所以要什么给什么、给不出就说清缺什么。
 */
export interface ActionFacts {
  /** 当前受审对象的 issue id；subject 不是 issue 时是 `null`。 */
  issueId: string | null
  /** 这条 run 的 id；没有关联 run 时是 `null`。 */
  runId: string | null
  workspaceId: string
  /** 这次 run 的工作目录（绝对路径）；还没分配时是 `null`。 */
  workdir: string | null
}

export type BindParamsOutcome =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; issues: string[] }

/**
 * 按 `bound` 规格算实际值。
 *
 * ★ 需要的事实缺失时**返回一条说清缺什么的错误**，绝不塞空串。
 *
 * 塞空串是这个位置最典型的错法：脚本拿到 `dir: ""` 之后要么在**当前目录**
 * 里写文件（daemon 是从哪儿启动的就写到哪儿），要么报一句"目录不对"——
 * 两种都比"平台说清工作目录还没分配"难查得多。所以这里宁可让动作失败并
 * 说清原因，也不猜一个默认值。
 */
export function bindParams(
  action: ToolActionDefinition,
  facts: ActionFacts,
): BindParamsOutcome {
  const params: Record<string, unknown> = {}
  const issues: string[] = []

  for (const [key, spec] of Object.entries(action.bound)) {
    switch (spec.from) {
      case 'literal': {
        if (spec.value === undefined) {
          // 清单 schema 要求 literal 必带 value，走到这里说明校验被绕过了。
          issues.push(
            `绑定参数 ${key}：清单里声明为 literal 却没有 value（清单校验漏了，请重新安装这个工具包）`,
          )
          break
        }
        params[key] = spec.value
        break
      }
      case 'subject.issueId': {
        if (facts.issueId === null || facts.issueId === '') {
          issues.push(
            `动作要求绑定参数 ${key}（来源 subject.issueId），但这条 run 的 subject 不是 issue —— ` +
              `没有可绑定的 issue id。平台不会用空串顶替：那会让脚本去操作一个不存在的对象。`,
          )
          break
        }
        params[key] = facts.issueId
        break
      }
      case 'subject.runId': {
        if (facts.runId === null || facts.runId === '') {
          issues.push(
            `动作要求绑定参数 ${key}（来源 subject.runId），但这次执行没有关联的 run —— 没有可绑定的 run id。`,
          )
          break
        }
        params[key] = facts.runId
        break
      }
      case 'workspace.id': {
        if (facts.workspaceId === '') {
          issues.push(`动作要求绑定参数 ${key}（来源 workspace.id），但工作区 id 是空的。`)
          break
        }
        params[key] = facts.workspaceId
        break
      }
      case 'workdir': {
        if (facts.workdir === null || facts.workdir === '') {
          issues.push(
            `动作要求绑定参数 ${key}（来源 workdir），但这条 run 还没有工作目录 ` +
              `（可能还停在 waiting_local_directory）。`,
          )
          break
        }
        params[key] = facts.workdir
        break
      }
      default: {
        // 协议以后加了新的来源、而这个版本还不认识时**明确失败**，
        // 而不是把 undefined 绑上去。
        const unknownSource: unknown = (spec as { from: unknown }).from
        issues.push(`绑定来源 ${String(unknownSource)} 这个平台版本还不认识（协议比实现新）。`)
        break
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, params }
}

// ══════════════════════════════════════════════════════════════════
// 开放参数校验
// ══════════════════════════════════════════════════════════════════

/**
 * 校验模型给的开放参数。
 *
 * 五条判据，全部是**拒绝**：未知键、必填缺失、字符串超长、枚举越界、
 * 整数越界。每一条的文案都要能直接给人看——说清是哪个参数、为什么、
 * 允许的是什么。判决不合规的通知里就是把这几句原文贴出来，
 * 所以"参数 x 不合法"这种话没有任何用处。
 *
 * ⚠️ 错误文案统一加 `动作参数 ` 前缀——结构性 invalid 与"模型手误可重试"就是靠它区分的。
 *    这不只是好看：`isStructuralInvalid`（`review/pipeline.ts`）就是靠这个
 *    前缀把"模型这次手误"（**重试有意义**）与"标准与注册表对不上"
 *    （重试无意义）分开的。少一个前缀，模型的手误就会被判成配置错误、
 *    连重试机会都没有。
 */
export function validateOpenParams(
  action: ToolActionDefinition,
  open: Readonly<Record<string, unknown>>,
  /**
   * 使用者在界面上设好的**固定参数**（D43）：这些参数由平台注入，
   * **模型不许写**——写了就是结构性不合规。
   */
  fixed?: Readonly<Record<string, unknown>>,
): ActionValidation {
  const issues: string[] = []
  const issue = (key: string, message: string): void => {
    issues.push(`动作参数 ${key}：${message}`)
  }

  // ── ① 未知键一律拒 ──
  for (const key of Object.keys(open)) {
    if (!(key in action.open)) {
      issue(key, `这个动作没有这个参数（可用的开放参数：${openKeys(action)}）`)
    }
  }

  // ── ①b 固定参数模型不许写（D43）──
  //
  // 使用者钉死的参数在界面上设了值、执行时由平台注入，模型**不该知道也不该填**
  // 它。模型写了 ⇒ 结构性不合规（不可重试）：这不是"模型手误"，而是它越过了
  // 使用者明确钉下的边界——重试只会让模型把同样的越界再写一遍。
  //
  // ⚠️ 前缀**不能**是 `动作参数 `：`isStructuralInvalid` 靠"以 `动作参数 ` 开头"
  //    把参数手误判成可重试（见 pipeline.ts）。这条是动作类的结构性错误，借用
  //    那个前缀会把它错判成"模型下次可能写对"——于是越界被重试、甚至降级，
  //    而不是升级给人。`固定参数 ` 前缀落到 `path: ['action']` 上 ⇒ 结构性。
  if (fixed !== undefined) {
    for (const key of Object.keys(open)) {
      if (key in fixed) {
        issues.push(`固定参数 ${key}：已由使用者在界面上固定为 ${JSON.stringify(fixed[key])}——这个参数模型不需要、也不许写（写了会被判不合规）`)
      }
    }
  }

  for (const [key, spec] of Object.entries(action.open)) {
    // ★ D43：已固定的参数不查"必填"——平台注入，模型**不该**给（给了反而越界）。
    //   查下去会把契约里已经减去的那一项报成"必填缺失"，让模型永远过不了。
    if (fixed !== undefined && key in fixed) continue
    const value = open[key]
    // `null` 与"没给"同义：JSON 里 null 常被用来表示"空"，而这里的每个
    // 参数类型都不接受 null——把它当"给了个 null"去报类型错，会把
    // "必填但没填"这条更准确的原因盖掉。
    if (value === undefined || value === null) {
      if (spec.required) issue(key, '必填，但模型没有给这个参数')
      continue
    }

    const problem = openValueIssue(spec, value)
    if (problem !== null) issue(key, problem)
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true }
}

function openKeys(action: ToolActionDefinition): string {
  const keys = Object.keys(action.open)
  return keys.length === 0 ? '无（这个动作没有开放参数）' : keys.join('、')
}

/**
 * 单个开放参数的值合不合规（类型 / 上限 / 枚举）。合法返回 `null`。
 *
 * ★ 与 `validateOpenParams` 共享同一套取值判据：模型填的值与使用者在界面上
 *   设的固定值，走的是**同一个**校验——否则会存在"模型填 `channel: 'qq'` 被
 *   拒、使用者在界面上设 `channel: 'qq'` 却存得进去"这种自相矛盾。
 */
function openValueIssue(spec: OpenSpec, value: unknown): string | null {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return `必须是字符串（实际是 ${describeValue(value)}）`
      }
      if (value.length > spec.max) {
        return `太长：最多 ${spec.max} 个字符，实际 ${value.length} 个`
      }
      return null
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `必须是整数（实际是 ${describeValue(value)}）`
      }
      if (value < spec.min || value > spec.max) {
        return spec.min === spec.max
          ? `只允许 ${spec.min}，实际 ${value}`
          : `超出允许范围 ${spec.min}..${spec.max}，实际 ${value}`
      }
      return null
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return `必须是 true 或 false（实际是 ${describeValue(value)}）`
      }
      return null
    }
    case 'enum': {
      if (typeof value !== 'string' || !(spec.values as readonly string[]).includes(value)) {
        return `不在允许的取值里（允许：${spec.values.join('、')}；实际是 ${describeValue(value)}）`
      }
      return null
    }
  }
}

/**
 * 校验**使用者在界面上设的固定参数**（D43，保存时校验用）。
 *
 * 与 `validateOpenParams`（校验模型填的值）的差别：
 *   · 这里从**固定参数那一侧**出发——逐条查使用者给的每个参数名/值；
 *   · **不做"必填但没给"检查**：使用者可以只钉死几个参数，其余的留给模型在
 *     判决时填——"固定了 0 个参数"是合法的（等于没设固定参数）。
 *
 * 判据：参数名必须是这个动作的 **open** 参数（bound 参数是平台的事实，不归
 * 使用者钉）；值必须满足类型 / 上限 / 枚举。
 */
export function validateFixedParams(
  action: ToolActionDefinition,
  fixed: Readonly<Record<string, unknown>>,
): ActionValidation {
  const issues: string[] = []
  const issue = (key: string, message: string): void => {
    issues.push(`动作参数 ${key}：${message}`)
  }

  for (const [key, value] of Object.entries(fixed)) {
    const spec = action.open[key]
    if (!spec) {
      issue(
        key,
        `这个动作没有这个开放参数（可用的开放参数：${openKeys(action)}）。` +
          `固定参数只能设 open 参数——绑定参数是平台按事实注入的，不归使用者钉`,
      )
      continue
    }
    if (value === undefined || value === null) {
      issue(key, '固定参数不能是空值：要固定就填一个值，不想固定就把这一项删掉')
      continue
    }
    const problem = openValueIssue(spec, value)
    if (problem !== null) issue(key, problem)
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true }
}

/** 给人看的值描述——长度有界，免得把一整篇正文贴进通知里。 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return `字符串「${value.length > 60 ? `${value.slice(0, 60)}…` : value}」`
  }
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === 'object' && value !== null) return '对象'
  return JSON.stringify(value) ?? String(value)
}

// ══════════════════════════════════════════════════════════════════
// 合并
// ══════════════════════════════════════════════════════════════════

export type MergeParamsOutcome =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; issues: string[] }

/**
 * 先校验开放参数，再与绑定值合并出**最终参数**。
 *
 * 顺序是刻意的：先拒掉模型给错的东西，再算绑定值——否则一条参数错误的
 * 判决会先撞上"工作目录还没分配"，让人以为问题出在环境上。
 *
 * 合并方向是 `{...open, ...fixed, ...bound}`：**固定值与绑定值一定在、且一定赢**。
 * 正常情况下三者不可能同名（安装时 `ToolActionSpec` 就拒了 open/bound 同名，
 * 固定值只可能是 open 参数），所以这里的"赢"只是兜底——更重要的是**两者一定
 * 出现**：少一个固定值/绑定值，脚本就会拿到一个缺参数的调用。
 *
 * 模型想覆盖固定值只有一条路：把那个参数名当开放参数填进来。那条路
 * 在 `validateOpenParams` ①b 就被拒了（已固定的参数模型不许写）——
 * 这是"误操作到别的 id"从结构上不可能的原因。
 */
export function mergeActionParams(
  action: ToolActionDefinition,
  facts: ActionFacts,
  open: Readonly<Record<string, unknown>>,
  /**
   * 使用者在界面上设好的固定参数（D43）。
   *
   * 语义与绑定值同一档：**模型看不见、也不许写**（写在 `open` 里会被
   * `validateOpenParams` 的 ①b 拒掉），执行时由平台注入。
   */
  fixed?: Readonly<Record<string, unknown>>,
): MergeParamsOutcome {
  const openCheck = validateOpenParams(action, open, fixed)
  if (!openCheck.ok) return { ok: false, issues: openCheck.issues }

  const bound = bindParams(action, facts)
  if (!bound.ok) return { ok: false, issues: bound.issues }

  // 合并方向 `{...open, ...fixed, ...bound}`：固定值与绑定值都**一定在、且一定赢**
  // ——模型想覆盖固定值只有一条路（把参数名当 open 写进来），那条路在 ①b 就被
  // 拒了。正常情况下三者不可能同名（open 定义里只有 open 参数；固定值只可能是
  // open 参数；bound 是另一组），"赢"只是兜底——重要的是三者都**出现**。
  const params = { ...open, ...(fixed ?? {}), ...bound.params }

  // 合成之后再对一次形状：这一步能抓住"绑定值没绑上"（定义里的绑定字段
  // 不接受 undefined）与"开放参数越界"两种问题。放在这里而不是只在
  // `validateActionRefWith` 里做，是因为执行路径（`ActionRunner`）也要它——
  // 两条路共用同一个判据，才不会出现"判决校验过了、执行时才发现少个参数"。
  const finalCheck = validateFinalParams(action, params)
  if (!finalCheck.ok) return { ok: false, issues: finalCheck.issues }

  return { ok: true, params }
}

/** 最终参数与定义里的形状对一次（开放参数严格、绑定参数必须在）。 */
function validateFinalParams(
  action: ToolActionDefinition,
  params: Readonly<Record<string, unknown>>,
): ActionValidation {
  const parsed = action.params.safeParse(params)
  if (parsed.success) return { ok: true }
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (i) => `动作参数 ${i.path.map(String).join('.') || '(根)'}：${i.message}`,
    ),
  }
}

// ══════════════════════════════════════════════════════════════════
// 校验一个 ActionRef（考虑已安装的工具）
// ══════════════════════════════════════════════════════════════════

export interface ValidateActionRefOptions {
  /** 该工作区**已安装**的工具包（`store.listTools(workspaceId)`）。 */
  tools: readonly Tool[]
  /**
   * 绑定参数要用的事实。
   *
   * ⚠️ 不给时只校开放参数——因为绑定值算不出来，也就无从注入。真正的执行
   *    路径**一定**要传（`ActionRunner` 就是从那台 store 里把 subject 与
   *    workdir 读出来传进来的）；不传的场景是"只想知道这个动作名能不能用"。
   */
  facts?: ActionFacts
  /**
   * 使用者在界面上设好的固定参数（D43）：模型不许写这些参数（写了 ⇒ 结构性
   * 不合规），执行时由平台注入。不给 = 这次没有固定参数。
   */
  fixed?: Readonly<Record<string, unknown>>
}

/**
 * 校验一个 `ActionRef`，**把已安装的工具算进去**。
 *
 * 三层，顺序不能换：
 *
 *   ① **类型是否存在**（内置注册表，或已安装工具包里声明的动作）。
 *      不存在 ⇒ 一条带 `未知动作类型` 前缀的错误。这条前缀同样是给
 *      `isStructuralInvalid` 看的：动作名对不上是**标准/配置**的问题，
 *      重试只会让模型把同一个名字再写一遍。
 *   ② **开放参数**（模型给的那部分）逐项严格校验。
 *   ③ **注入绑定值，再校验最终参数**——模型只被要求给开放参数，
 *      所以"只校它给的那部分"是正确的口径；但**最终要执行的是合并后的
 *      那份**，所以合并之后必须再过一次（否则"绑定值缺失"这类平台侧的
 *      问题会一路漂到脚本里）。
 *
 * `validateActionRef`（内置那版）的行为**一字未改**：这里对内置类型直接
 * 转调它。内置动作没有 bound/open 之分，参数 schema 就是全部判据。
 */
export function validateActionRefWith(
  ref: ActionRef,
  options: ValidateActionRefOptions,
): ActionValidation {

  const slug = toolSlugOfAction(ref.type)
  if (slug === null) {
    // 带了点、但不是合法的 `<slug>.<动作名>`（大写、下划线、空段……）。
    // 这一条也要说清"形状不对"，而不是含糊地说"没装"。
    return {
      ok: false,
      issues: [
        `未知动作类型：${ref.type}（动作只能来自已安装的工具包，名字形如 <工具包 slug>.<动作名>；平台不内置任何动作）`,
      ],
    }
  }

  const definition = resolveToolActionDefinition(ref.type, options.tools)
  if (!definition) {
    const installed = options.tools.some((t) => t.slug === slug)
    return {
      ok: false,
      issues: [
        installed
          ? `未知动作类型：${ref.type} —— 工具包 ${slug} 已安装，但它没有声明这个动作`
          : `未知动作类型：${ref.type} —— 工具包 ${slug} 还没有装到这个工作区（第三方动作必须先安装它的包）`,
      ],
    }
  }

  const openCheck = validateOpenParams(definition, ref.params, options.fixed)
  if (!openCheck.ok) return openCheck

  if (!options.facts) return { ok: true }

  const merged = mergeActionParams(definition, options.facts, ref.params, options.fixed)
  if (!merged.ok) return { ok: false, issues: merged.issues }

  return validateFinalParams(definition, merged.params)
}

// ══════════════════════════════════════════════════════════════════
// 审核者的行动权限（`Agent.allowedActions`，老数据回退到标准里那份）
// ══════════════════════════════════════════════════════════════════

export interface AllowedActionsResolution {
  /**
   * 可以出现在判决里的动作名：**已安装工具包声明过的动作**（D41：没有内置动作）。
   *
   * 类型就是协议里的 `ActionRefType`——白名单与判决里的 `action.type` 是
   * **同一个形状**，所以它可以直接喂给 `validateActionAllowed`（那边也是
   * `ActionRefType`），不需要任何断言。
   */
  allowed: ActionRefType[]
  /**
   * 标准里写了、但当前**不可用**的动作（包没装，或包里没这个动作）。
   *
   * 单独列出来是为了"不要静默忽略"：调用方应当把它记一条日志/通知。
   * 判决真引用了它时，`validateActionRefWith` 会让它走 invalid 路径。
   */
  unavailable: Array<{ type: string; reason: string }>
}

/**
 * 把审核标准声明的动作白名单，解析成"**这个工作区现在**允许的动作集合"。
 *
 * 三件事合起来才让第三方动作有可能被执行：
 *
 *   ① 标准声明的内置动作**原样保留**（既有行为一个字不变）；
 *   ② 标准声明的第三方动作只在**它的包真的装了**、且包里真有这个动作名时
 *      保留——否则进 `unavailable`，判决引用它就走 invalid（结构性），
 *      绝不静默当成"允许"；
 *   ③ **只有**白名单里点名的第三方动作才保留（见下面结尾那段注释）。
 *
 * 关于"授权单位"：D40 收口之后，权威白名单是 **`Agent.allowedActions`**
 * （审核者的能力）。"装了一个包"**不等于**授权它——那会让白名单名存实亡，
 * 也会与"未声明即拒绝"冲突。要收窄到"还要挂给某个执行者"（第二把锁），
 * 只需给本函数多加一个入参，判据不必重写。
 */
export function resolveAllowedActionsWithTools(
  declared: readonly string[],
  tools: readonly Tool[],
): AllowedActionsResolution {
  const definitions = toolActionDefinitions(tools)
  const allowed: ActionRefType[] = []
  const unavailable: AllowedActionsResolution['unavailable'] = []

  for (const type of declared) {
    if (type in definitions) {
      allowed.push(type)
      continue
    }
    const slug = toolSlugOfAction(type)
    if (slug === null) {
      unavailable.push({
        type,
        reason: `标准里的动作 ${type} 既不是内置动作，也不是 <工具包>.<动作名> 的形状`,
      })
      continue
    }
    unavailable.push({
      type,
      reason: tools.some((t) => t.slug === slug)
        ? `工具包 ${slug} 已安装，但它没有声明动作 ${type}`
        : `动作 ${type} 来自工具包 ${slug}，但这个工作区没有装它`,
    })
  }

  // ══════════════════════════════════════════════════════════════════
  // ⚠️ 这里**不再**把"已安装包声明的动作"无条件塞进来
  // ══════════════════════════════════════════════════════════════════
  //
  // 原来那一段（"装一个包 = 授权它的整组动作"）在过去是说得通的：那时动作权限
  // 还挂在 skill/标准上，没有"审核者的行动权限"这个一等字段。D40 收口之后
  // `Agent.allowedActions` 就是**权威白名单**，而上面那段会让它**名存实亡**——
  // 只要包装上了，没在白名单里写的工具动作照样能跑。
  //
  // 症状是"界面上的勾选不起作用"：使用者取消了某个动作，判决却仍然能触发它。
  // 这与整个项目反复守的那条规矩（**未声明即拒绝**）正面冲突，所以删掉。
  //
  // 代价是**要说清怎么改**：判决引用了没写进白名单的工具动作时，错误信息必须
  // 指出"去那个审核者的『行动权限』里把它勾上"——否则使用者只会看到
  // "动作不可用"而无处下手（D38 那次"卸载被拒要说清是谁挂着"的教训）。
  return { allowed, unavailable }
}

/** 契约里一条第三方动作的说明（`toolActionHints` 的产物）。 */
export interface ToolActionHint {
  type: ActionRefType
  summary: string
  /**
   * 模型**该填**的那几个参数名。
   *
   * ★ 只可能是 `open` 那一组：绑定参数（`bound`）由平台按事实注入，写进契约
   *   只会诱导模型去填、然后被校验拒掉——"误操作到别的 issue"就是这么来的。
   *
   * ⚠️ D43：已经由使用者在界面上**固定**的 open 参数**不在这一组里**——模型
   *   不需要填它，写了反而会被判不合规。
   */
  openParams: string[]
  /**
   * 已固定的参数（D43）：使用者在界面上设的值，执行时由平台注入。
   *
   * 契约里要**说出口**：模型看到"你只需要给：X、Y"却不知道 Z 去哪了，
   * 要么猜 Z 是可选、要么去编——两个都是错。列出"Z 已固定为 …"，
   * 模型才不会把固定参数当漏填的必填项。
   */
  fixedParams?: readonly { name: string; value: unknown }[]
}

/**
 * 判决契约里那几行"第三方动作"的说明（D40）。
 *
 * ★ 为什么必须有它：契约里**没有**的动作名，模型写不出来。而"契约里没写枚举
 *   ⇒ 整条判决作废"在这个仓库里真实发生过两次（D33 那次两轮审核都废在这里）。
 *   所以只要审核者允许了第三方动作，就必须把它连同"你要填哪些参数"一起告诉模型。
 *
 * ⚠️ 只列 `open`（模型该填的）：绑定参数由平台按事实注入，写进契约只会诱导模型
 *    去写、然后被校验拒掉——那正是"误操作到别的 issue"这类问题的温床。
 *
 * ⚠️ D43：`fixedByType` 里列出的参数从 `openParams` 里**减去**、并进
 *    `fixedParams`——契约只说"该填的"，已固定的参数单独说"已固定、不要写"。
 */
export function toolActionHints(
  allowed: readonly ActionRefType[],
  tools: readonly Tool[],
  fixedByType?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): ToolActionHint[] {
  const definitions = toolActionDefinitions(tools)
  const hints: ToolActionHint[] = []
  for (const type of allowed) {
    const definition = definitions[type]
    if (!definition) continue // 内置动作或不可用的名字：不在这里列
    const fixed = fixedByType?.[type] ?? {}
    const fixedNames = new Set(Object.keys(fixed))
    hints.push({
      type,
      summary: definition.describe({}),
      // `open` 是清单里声明的那一组；顺序按清单给的（作者写什么顺序就什么顺序）
      openParams: Object.keys(definition.open).filter((p) => !fixedNames.has(p)),
      ...(Object.keys(fixed).length > 0
        ? {
            fixedParams: Object.entries(fixed).map(([name, value]) => ({ name, value })),
          }
        : {}),
    })
  }
  return hints
}
