import { z } from 'zod'
import { ActionRefType, NamespacedActionType, toolSlugOfAction } from './enums.ts'
import { EpochMs } from './entities.ts'
import { ToolId, WorkspaceId } from './ids.ts'

/**
 * 工具包（D40）：**一个目录 = 一个包 = 一个组**，组内多个动作。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件是"是不是适配本平台的工具"的**唯一判据**
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者要的是"工具目录最好有一个标准格式，用于判断是否适配"。所以格式
 * 不写在文档里靠人眼看，而是**在这里写成 schema**：装进来的包要么整份通过
 * 这里，要么带着一条具体的错被拒。文档（`docs/design.md` §15.26）只是这份
 * schema 的解说，不是判据本身——两者不一致时以这里为准。
 *
 * ── 为什么是 `tool.json` 而不是 `TOOL.md` 的 frontmatter ──
 *
 * skill 用 `SKILL.md` 带 frontmatter，看起来照抄最省事。但 skill 的
 * frontmatter **从来没有被结构化解析过**（`splitFrontmatter` 只把那段文字
 * 切出来，`name` 之类靠调用方另给），而工具清单里有 `actions[]` 这种**嵌套
 * 数组**——手写一个 YAML 子集解析器正是"格式没被完整定义、半年后在某个
 * 缩进上炸掉"的经典来源。JSON + zod 直接可校验，且全仓库都是 zod，
 * 不引入新依赖、也不引入第二个契约来源。
 *
 * 于是包里有**两个文件、各干一件事**：
 *   · `tool.json` —— 机器读的清单（本文件定义）
 *   · `TOOL.md`   —— 人读的说明（可选的正文，装进来在界面上显示）
 */

/** 清单格式的版本。**不认识这个值 ⇒ 明确拒绝**，不做"尽力而为"。 */
export const TOOL_MANIFEST_SCHEMA = 'alpha-helper/tool@1'

/** kebab-case：slug 与动作名共用（与 skill 的 slug 同一形状）。 */
const KEBAB = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * 包 slug。它同时是**组的名字**，也是动作名的命名空间。
 *
 * ⚠️ 这里原来有一张 `RESERVED_TOOL_SLUGS = ['comment','issue','notify']`
 *    （三个前缀保留给内置动作，免得工具包声明出与内置同名的动作、被"内置优先"
 *    永远压住）。**D41 把内置动作整个删掉之后就没什么可保留的了**——
 *    现在每一个动作名都带包 slug，叫 `comment` 的包声明 `comment.create`
 *    不再与任何东西撞车。于是那条限制跟着删掉：它只会挡住一个合法的包名。
 */

// ══════════════════════════════════════════════════════════════════
// 参数：bound / open 二分（D40）
// ══════════════════════════════════════════════════════════════════

/**
 * 绑定参数的来源。**绑定的值不进模型可见的契约**——模型看不见、也填不了。
 *
 * 为什么不是"允许模型填、平台再覆盖"：覆盖式语义下模型仍以为自己在控制这个
 * 字段（下次它会尝试控制别的），而且它填错时你永远看不到这个信号，审计里
 * 还会出现两套值。把它从契约里删掉，"误操作到别的 issue"就**从结构上不可能**，
 * 而不是靠"检查它填得对不对"。
 */
export const BoundFrom = z.enum([
  'literal',
  /** 当前受审对象的 issue id（执行 run 的 subject / review run 的上游）。 */
  'subject.issueId',
  /** 当前这条 run 的 id。 */
  'subject.runId',
  'workspace.id',
  /** 这次 run 的工作目录（绝对路径）。 */
  'workdir',
])
export type BoundFrom = z.infer<typeof BoundFrom>

export const BoundParamSpec = z
  .strictObject({
    from: BoundFrom,
    /** `from: 'literal'` 时必填；其余来源由平台按事实填。 */
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from === 'literal' && v.value === undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'from 为 literal 时必须给 value' })
    }
    if (v.from !== 'literal' && v.value !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: '只有 from 为 literal 时才能给 value（其余来源由平台按事实填）',
      })
    }
  })

/**
 * 开放参数：模型填的那部分，**每一项都必须有界**。
 *
 * 没有 `string()` 这种无界类型——一个不限长的字符串就是一个可以让模型
 * 往你的系统里塞任意内容的入口。上限不写就不给过。
 */
export const OpenParamSpec = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'),
    max: z.number().int().positive().max(20_000).default(1_000),
    required: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal('integer'),
    min: z.number().int(),
    max: z.number().int(),
    required: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal('boolean'),
    required: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal('enum'),
    /** 值域由工具作者钉死——拼错一个字母不会变成"另一个动作"。 */
    values: z.array(z.string().min(1).max(200)).min(1).max(50),
    required: z.boolean().default(true),
  }),
])
export type OpenParamSpec = z.infer<typeof OpenParamSpec>

// ══════════════════════════════════════════════════════════════════
// 组内动作
// ══════════════════════════════════════════════════════════════════

export const ToolActionSpec = z
  .strictObject({
    /** 组内唯一；完整动作名是 `<包 slug>.<name>`。 */
    name: z.string().regex(KEBAB, '动作名必须是 kebab-case'),
    /** 一行说明，写进判决契约与界面。 */
    summary: z.string().min(1).max(200),
    /** 相对包根的入口；不给就用包级 `entry`。 */
    entry: z.string().min(1).optional(),
    /** 不可回滚的动作必须显式写 false（FR-ACTION-05 同款）。 */
    reversible: z.boolean(),
    /**
     * ★ 准入条件：**不支持 dry-run 的动作不给"自动执行"资格**。
     *
     * 第三方脚本是你不完全了解的代码，它会在你的机器上真的改东西。
     * dry-run 是唯一便宜到人人都会用的"先看一眼它会改什么"的手段。
     */
    dryRun: z.enum(['supported', 'unsupported']),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
    params: z
      .strictObject({
        bound: z.record(z.string().regex(KEBAB), BoundParamSpec).default({}),
        open: z.record(z.string().regex(KEBAB), OpenParamSpec).default({}),
      })
      .default({ bound: {}, open: {} }),
  })
  .superRefine((v, ctx) => {
    // 同一个参数名不能既是绑定又是开放——否则"模型填不了"这条就被悄悄绕过了。
    for (const key of Object.keys(v.params.bound)) {
      if (key in v.params.open) {
        ctx.addIssue({
          code: 'custom',
          path: ['params', 'open', key],
          message: `参数 ${key} 同时出现在 bound 与 open 里；绑定参数不该再开放给模型`,
        })
      }
    }
  })
export type ToolActionSpec = z.infer<typeof ToolActionSpec>

// ══════════════════════════════════════════════════════════════════
// 清单本体
// ══════════════════════════════════════════════════════════════════

/** 执行方式白名单。**不在这里的一律拒**（不给"你自己填个命令"的自由）。 */
export const ToolRuntime = z.enum(['node', 'shell', 'python3'])
export type ToolRuntime = z.infer<typeof ToolRuntime>

export const ToolManifest = z
  .strictObject({
    schema: z.literal(TOOL_MANIFEST_SCHEMA),
    slug: z.string().regex(KEBAB, 'slug 必须是 kebab-case'),
    name: z.string().min(1).max(200),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, '版本号写成 x.y.z')
      .nullable()
      .default(null),
    description: z.string().max(2_000).default(''),
    runtime: ToolRuntime,
    /** 包级默认入口（相对包根）。 */
    entry: z.string().min(1),
    /** ★ 组：一次安装声明的**全部**动作。空组没有意义（装了也没得执行）。 */
    actions: z.array(ToolActionSpec).min(1).max(50),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>()
    for (const [i, action] of v.actions.entries()) {
      if (seen.has(action.name)) {
        ctx.addIssue({ code: 'custom', path: ['actions', i, 'name'], message: `动作名重复：${action.name}` })
      }
      seen.add(action.name)
      // 路径不许跑出包外（远端目录给的包是外部输入）
      for (const p of [action.entry, v.entry]) {
        if (p !== undefined && (p.startsWith('/') || p.includes('..'))) {
          ctx.addIssue({
            code: 'custom',
            path: ['actions', i],
            message: `入口路径必须待在包里面：${p}`,
          })
        }
      }
    }
  })
export type ToolManifest = z.infer<typeof ToolManifest>

// 动作名的**形状**与解析器住在 `enums.ts`（理由见那边的注释：判决 schema 与
// 审核标准的白名单都要用它，而它们不能反过来 import 本文件，否则成环）。
// 这里再导出一次，是为了让"工具相关的东西从 tools.ts 拿"这条直觉仍然成立——
// 两边指的是**同一个绑定**，不是两份实现。
export { ActionRefType, NamespacedActionType, toolSlugOfAction }

/** 一行的完整动作名（`issue.close` 那种命名空间形态）。 */
export function toolActionType(manifest: Pick<ToolManifest, 'slug'>, actionName: string): string {
  return `${manifest.slug}.${actionName}`
}

/** 这个动作实际用哪个入口文件。 */
export function actionEntry(manifest: ToolManifest, action: ToolActionSpec): string {
  return action.entry ?? manifest.entry
}

// ══════════════════════════════════════════════════════════════════
// 装进来之后的实体
// ══════════════════════════════════════════════════════════════════

/**
 * 一个已安装的工具包。
 *
 * ⚠️ 实体放在本文件而不是 `entities.ts`：它**没有**独立于清单的字段——
 *    `manifest` 就是它的权威内容（动作、参数、入口、超时全在里面），
 *    另外两样只是"内容从哪来"（`source`/`sourceRef`）与"文件在哪"（`files`）。
 *    拆到两个文件里，改清单的人会忘记改实体。
 */
export const Tool = z.object({
  id: ToolId,
  workspaceId: WorkspaceId,
  /** 与 `manifest.slug` 同一个值，提上来是为了列表/授权时不必先解清单。 */
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  /** 解析通过的清单（zod 校验过的原件）。 */
  manifest: ToolManifest,
  /**
   * 包里的文件：相对路径 → 文本内容（含入口脚本）。
   *
   * 与 skill 的支持文件同一条规矩：**只收文本**。二进制在安装时就被拒并列出，
   * 而不是装进来以后在某个环节悄悄写坏。
   */
  files: z.record(z.string(), z.string()),
  /** `TOOL.md` 的正文（人读的说明）。没有就是空串。 */
  docs: z.string(),
  source: z.enum(['local', 'remote']),
  sourceRef: z.string().nullable(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type Tool = z.infer<typeof Tool>
