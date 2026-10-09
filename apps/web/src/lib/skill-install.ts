import type { TextParams, WebTextId } from '@agentdeck/i18n'
import { ApiError, api } from './api.ts'

/**
 * skill 安装（FR-AGENT-09/11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两个来源，一个出口
 * ══════════════════════════════════════════════════════════════════
 *
 * 安装有两条路：
 *
 *   1. **路径 / GitHub 链接** —— 由 daemon 自己去读（本地路径只有它读得到）；
 *   2. **远端目录** —— 页面把条目的内容取好交过去（daemon 不向远端服务发请求）。
 *
 * 两条路都走同一个接口 `POST /api/skills/install`、同一套"必须有 SKILL.md"
 * 的检查、同一套同名冲突规则。这样"从哪装"不会改变"装成什么"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里拼的是**键**，不是中文句子（D39）
 * ══════════════════════════════════════════════════════════════════
 *
 * "安装完成了，但 A 没装进来、B 被跳过"这类话原来是在这一层拼死的中文。界面语言
 * 可切之后那就不成立了：库层不知道当前语言，切到英文时这些句子会留在中文里。
 * 所以现在这层只产出 `InstallMessage`（`{ id, params }`），由界面按当前语言渲染
 * （`Skills.svelte` 拿 `$t` 当渲染器传进 `renderInstallMessage()`）。
 */

/**
 * ⚠️ 这里原来还有一张**动作表**（`ACTION_TYPES` / `DEFAULT_ACTIONS`）：「允许这个
 *    skill 触发哪些动作」曾是这个安装请求体的一个字段。D40 收口之后它走了——
 *    动作权限与"装一份资料包"无关，所以安装既不再收它、也不再写它（见下面两个
 *    入参类型里各自那条注释）。那份表跟着这件事一起搬到了 `agent-actions.ts`
 *    （2026-10 之后它的服务对象是**组**：动作只属于智能体组）。
 */
export interface InstallFile {
  path: string
  bytes: number
}

export interface InstallSkipped {
  slug: string
  reason: string
  existingSource?: string
}

export interface InstallResult {
  installed: Array<{ slug: string; id: string; source: string }>
  skipped: InstallSkipped[]
  /** 从哪儿解析的（人可读）。 */
  resolvedFrom: string
  source: string
  sourceRef: string
  /** 装进来的文件。 */
  included: InstallFile[]
  /** **明确没装**的东西及原因。 */
  ignored: Array<{ path: string; reason: string }>
}

/** 安装失败时的结构化信息——界面要按 code 给不同的下一步建议。 */
export class InstallError extends Error {
  readonly code: string
  readonly detail: string | null

  constructor(message: string, code: string, detail: string | null) {
    super(message)
    this.name = 'InstallError'
    this.code = code
    this.detail = detail
  }
}

async function post(body: unknown): Promise<InstallResult> {
  try {
    return await api<InstallResult>('/api/skills/install', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch (err) {
    // api() 抛的是 ApiError，原始响应体在 `body` 里。**必须把 code 与 detail
    // 取出来**——它们正是界面给出"下一步该怎么做"的依据（比如 blocked_host
    // 要引导去用本地路径，而不是让使用者对着"400"发呆）。
    if (err instanceof ApiError) {
      const body = (err.body ?? {}) as Record<string, unknown>
      throw new InstallError(
        typeof body['error'] === 'string' ? body['error'] : err.message,
        typeof body['code'] === 'string' ? body['code'] : 'unknown',
        typeof body['detail'] === 'string' ? body['detail'] : null,
      )
    }
    throw err
  }
}

/** 从本地路径或 GitHub 链接安装。 */
export function installFromPathOrUrl(input: {
  /** `path` 走本地目录；`url` 目前只支持 GitHub。 */
  kind: 'path' | 'url'
  value: string
  slug?: string
  /**
   * 来源标记（只对 `path` 有用）。「从本地安装」页签装的时候传 `localdir:<根目录>`，
   * 落库后列表里就能显示「来自本地技能目录：…」。不给 = daemon 用默认的 `path:<目录>`。
   */
  sourceRef?: string
  overwrite?: boolean
}): Promise<InstallResult> {
  return post({
    source:
      input.kind === 'path'
        ? {
            kind: 'path',
            path: input.value,
            ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
          }
        : { kind: 'url', url: input.value },
    ...(input.slug ? { slug: input.slug } : {}),
    ...(input.overwrite ? { overwrite: true } : {}),
  })
}

/** 把远端目录里的一个条目交给 daemon 装。 */
export function installRemoteEntry(input: {
  slug: string
  /** SKILL.md 的内容（远端目录的 `content`）。 */
  body: string
  /**
   * ★ **支持文件**（相对路径 → 内容）。不传的话装进来只有 `SKILL.md`——
   *   而技能是可以带脚本与参考文件的（pptx 那类），少了它们技能就是坏的，
   *   且坏得很安静：界面显示"已安装"，跑起来才发现少东西。
   *   daemon 收这个字段（`POST /api/skills` 的 payload 路），并**再校验一遍**。
   */
  files?: Record<string, string>
  /** 目录给的版本——落库后界面才能判断"已安装 / 可更新"。取不到时是 null。 */
  version: string | null
  sourceRef: string
  overwrite?: boolean
}): Promise<InstallResult> {
  return post({
    source: {
      kind: 'payload',
      slug: input.slug,
      body: input.body,
      ...(input.files && Object.keys(input.files).length > 0 ? { files: input.files } : {}),
      version: input.version,
      sourceRef: input.sourceRef,
    },
    ...(input.overwrite ? { overwrite: true } : {}),
  })
}

/**
 * 界面渲染一条文案的方式（形状就是 `apps/web/src/lib/i18n.ts` 的 `tx`，直接传它）。
 *
 * ★ 这里**不 import** 那个 `tx`：`i18n.ts` 依赖 svelte 的 store，把库层和界面层
 *   绑在一起之后，这些纯函数就没法在 `node:test` 里单独跑了。
 */
export type TextRenderer = (id: WebTextId, params?: TextParams) => string

/** 安装结果里的一段话：**键 + 插值**，中文/英文由界面按当前语言渲染。 */
export interface InstallMessage {
  id: WebTextId
  params?: Readonly<Record<string, InstallParamValue>>
}

/** 插值。列表占位符（`{slugs}` / `{items}`）的值是 `InstallList`（见 `renderInstallMessage`）。 */
export type InstallParamValue = string | number | InstallList

/**
 * 一串要连接起来的片段。
 *
 * ★ 用一个显式的包装而不是"直接传数组"：数组在运行时**分不出**是"一串片段"
 *   还是"一个片段"（`['a','b']` 既可能是两个 slug，也可能是一段消息），照
 *   "是数组就当消息列表"处理会把 slug 列表渲染成空串。包一层之后，"这是列表"
 *   在类型上和运行上都是看得见的事。
 */
export interface InstallList {
  /** 片段：原样的值（如 slug），或另一段消息（如"某个没装进来的文件"）。 */
  items: readonly (string | number | InstallMessage)[]
}

function isList(value: InstallParamValue): value is InstallList {
  return typeof value === 'object' && value !== null && 'items' in value
}

/**
 * 渲染一段消息。
 *
 * ★ 列表的连接**必须**用调用方给的 `render` 取 `install.listSeparator`：中文是
 *   `、`、英文是 `, `，库层自己 join 会把中文的顿号带进英文界面。
 */
export function renderInstallMessage(message: InstallMessage, render: TextRenderer): string {
  const params: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(message.params ?? {})) {
    if (!isList(value)) {
      params[key] = value
      continue
    }
    params[key] = value.items
      .map((item) => (typeof item === 'object' ? renderInstallMessage(item, render) : String(item)))
      .join(render('install.listSeparator'))
  }
  return render(message.id, params)
}

/**
 * 把安装结果变成**要显示的几段话**。
 *
 * ★ 三件事都必须在里面：**装了什么**、**什么没装上（以及为什么）**、
 *   **有什么被跳过了**。只说"安装完成"是最糟的一种——
 *   使用者会以为自己拿到了一个完整的技能，而实际可能只装了 SKILL.md。
 *
 * 返回数组而不是一句话：界面把它们渲染出来后按原顺序拼起来即可（原中文里的
 * `；` 已经在各条词条里，所以拼接不需要额外的分隔符）。
 */
export function describeInstallMessages(result: InstallResult): InstallMessage[] {
  const messages: InstallMessage[] = []
  if (result.installed.length > 0) {
    // slugs 用 `InstallList` 包起来：分隔符由渲染方按语言取（见 `renderInstallMessage`）。
    messages.push({
      id: 'install.installedList',
      params: { slugs: { items: result.installed.map((s) => s.slug) } },
    })
    messages.push({ id: 'install.fromSource', params: { source: result.resolvedFrom } })
  }
  if (result.ignored.length > 0) {
    messages.push({
      id: 'install.ignoredList',
      params: {
        items: {
          items: result.ignored.map((i): InstallMessage => ({
            id: 'install.ignoredItem',
            params: { path: i.path, reason: i.reason },
          })),
        },
      },
    })
  }
  for (const s of result.skipped) {
    messages.push({ id: 'install.skipped', params: { slug: s.slug, reason: s.reason } })
  }
  return messages
}

/**
 * 按错误码给出下一步建议的**键**——错误信息本身不够，使用者要的是"那我该怎么做"。
 *
 * 认不出的码返回 `null`（= 没有建议可说），而不是一条空词条：词表里不允许空值，
 * 而"编一句通用的话"会把 daemon 的原始错误盖掉。
 */
export function installErrorHintMessage(code: string): InstallMessage | null {
  switch (code) {
    case 'blocked_host':
      return { id: 'install.errBlockedHost' }
    case 'github_rate_limited':
      return { id: 'install.errRateLimited' }
    case 'missing_skill_md':
      return { id: 'install.errMissingSkillMd' }
    case 'bad_slug':
      return { id: 'install.errBadSlug' }
    case 'not_found':
      return { id: 'install.errNotFound' }
    case 'too_large':
    case 'too_many_files':
      return { id: 'install.errTooLarge' }
    default:
      return null
  }
}
