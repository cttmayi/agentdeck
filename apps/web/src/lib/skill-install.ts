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
 */

/**
 * 动作表。
 *
 * ⚠️ 必须与 `packages/protocol/src/enums.ts` 的 `ActionType` 一致。
 * 网页这边不 import protocol（那是给服务端与测试用的），所以只能列一份——
 * **但真正的守卫在 daemon 侧**：不在表里的动作会被 400 拒绝，所以这里即使
 * 漏了一个，也不会让使用者装出一个"每次判决都不合规"的技能。
 */
export const ACTION_TYPES = [
  'comment.create',
  'issue.update_status',
  'issue.add_label',
  'issue.create',
  'issue.assign_agent',
  'notify.emit',
] as const

/** 默认动作：最小权限。装的时候不显式选，就只能发评论。 */
export const DEFAULT_ACTIONS = ['comment.create']

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
  allowedActions?: string[]
  overwrite?: boolean
}): Promise<InstallResult> {
  return post({
    source: input.kind === 'path' ? { kind: 'path', path: input.value } : { kind: 'url', url: input.value },
    ...(input.slug ? { slug: input.slug } : {}),
    ...(input.allowedActions ? { allowedActions: input.allowedActions } : {}),
    ...(input.overwrite ? { overwrite: true } : {}),
  })
}

/** 把远端目录里的一个条目交给 daemon 装。 */
export function installRemoteEntry(input: {
  slug: string
  /** SKILL.md 的内容（远端目录的 `content`）。 */
  body: string
  sourceRef: string
  allowedActions?: string[]
  overwrite?: boolean
}): Promise<InstallResult> {
  return post({
    source: {
      kind: 'payload',
      slug: input.slug,
      body: input.body,
      sourceRef: input.sourceRef,
    },
    ...(input.allowedActions ? { allowedActions: input.allowedActions } : {}),
    ...(input.overwrite ? { overwrite: true } : {}),
  })
}

/**
 * 把安装结果变成一句人话。
 *
 * ★ 三件事都必须在里面：**装了什么**、**什么没装上（以及为什么）**、
 *   **有什么被跳过了**。只说"安装完成"是最糟的一种——
 *   使用者会以为自己拿到了一个完整的技能，而实际可能只装了 SKILL.md。
 */
export function describeInstall(result: InstallResult): string {
  const parts: string[] = []
  if (result.installed.length > 0) {
    parts.push(`已安装 ${result.installed.map((s) => s.slug).join('、')}`)
    parts.push(`（来自 ${result.resolvedFrom}）`)
  }
  if (result.ignored.length > 0) {
    parts.push(
      `；没装进来：${result.ignored.map((i) => `${i.path}（${i.reason}）`).join('、')}`,
    )
  }
  for (const s of result.skipped) parts.push(`；跳过 ${s.slug}：${s.reason}`)
  return parts.join('') || '没有任何改动'
}

/** 按错误码给出下一步建议——错误信息本身不够，使用者要的是"那我该怎么做"。 */
export function installErrorHint(code: string): string {
  switch (code) {
    case 'blocked_host':
      return '只支持 GitHub 的公开仓库链接。本机上的技能请改用「本地目录」并填绝对路径。'
    case 'github_rate_limited':
      return 'GitHub 匿名访问有每小时 60 次的限制。等一会儿再试，或设置环境变量 ALPHA_HELPER_GITHUB_TOKEN。'
    case 'missing_skill_md':
      return '技能是一个**目录**，里面必须有 SKILL.md（大写）。请把链接/路径指到那个目录。'
    case 'bad_slug':
      return 'slug 只能是小写字母、数字与连字符。可以显式指定一个。'
    case 'not_found':
      return '检查路径/链接：仓库是否为私有、分支名与目录是否写对。'
    case 'too_large':
    case 'too_many_files':
      return '技能应当是少量文本文件。请精简后再装。'
    default:
      return ''
  }
}
