import type { TextParams, WebTextId } from '@agentdeck/i18n'
import { ApiError, api, type Tool, type ToolManifest } from './api.ts'

/**
 * 工具安装 / 卸载（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与 skill 那条路的关系
 * ══════════════════════════════════════════════════════════════════
 *
 * skill 是"一份资料"（`POST /api/skills/install`，正文 + 支持文件），工具是
 * **"一个可插拔的行动组"**（`POST /api/tools`，清单 + 入口脚本 + 组内若干动作）。
 * 两者共用的只有"从本机目录读"这套 I/O 与限额，**判断合不合规的规则完全不同**
 * （skill 靠 `SKILL.md` 存在与否，工具靠 `tool.json` 的 schema）。所以这边是
 * 独立的一个模块，不是给 `skill-install.ts` 加一个分支。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里拼的是**键**，不是中文句子（D39）
 * ══════════════════════════════════════════════════════════════════
 *
 * 与 `skill-install.ts` 同一条规矩：库层产出 `{ id, params }`，界面用 `$t`
 * 渲染——装完之后切语言，那几行字必须跟着变。
 */

/** 失败时的结构化信息：界面要按 `code` 给"那我该怎么做"。 */
export class ToolInstallError extends Error {
  readonly code: string
  readonly detail: string | null

  constructor(message: string, code: string, detail: string | null) {
    super(message)
    this.name = 'ToolInstallError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 卸载被拒：还有 agent 挂着它。
 *
 * ★ 这是一个**单独的**错误类型而不是一句字符串：界面要"指名道姓"地说出
 *   还挂着的是谁（使用者的要求），而那需要结构化的 `holders`。把名单拼进
 *   错误消息里，界面就只剩下一句不可拆的话可显示。
 */
/** 一段待渲染的文案：键 + 插值（渲染方式与 `skill-install.ts` 的 `TextRenderer` 同形）。 */
export interface TextMessage {
  id: WebTextId
  params?: TextParams
}

/**
 * 安装结果里"装进来了什么 / 明确没装什么"。
 *
 * ★ `included` / `ignored` **优先用后端给的**：只有它知道哪些文件被跳过以及为什么
 *   （二进制、符号链接、版本库目录…）。后端这一版只返回 `{ tool }` 时退回
 *   `tool.files` ——`files` 里就是**真正收下**的那些文件，所以"装进来了什么"
 *   仍然是对的，只是"没装什么"无从得知（`ignoredKnown: false`，界面会说明
 *   这一点，而不是假装"全都装进来了"）。
 *
 * ⚠️ 协议里 `Tool` 没有 `included` / `ignored` 字段，所以这里**不去改协议**：
 *   多出来的字段按"有就用、没有就退回"处理。
 */
export interface ToolInstallResult {
  tool: Tool
  included: Array<{ path: string; bytes: number | null }>
  ignored: Array<{ path: string; reason: string }>
  /** 后端有没有权威的"没装进来"清单。 */
  ignoredKnown: boolean
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readIncluded(body: Record<string, unknown>): Array<{ path: string; bytes: number | null }> | null {
  const raw = body['included']
  if (!Array.isArray(raw)) return null
  return raw.map((item) => {
    const rec = readRecord(item)
    return {
      path: String(rec['path'] ?? ''),
      bytes: typeof rec['bytes'] === 'number' ? rec['bytes'] : null,
    }
  })
}

function readIgnored(body: Record<string, unknown>): Array<{ path: string; reason: string }> | null {
  const raw = body['ignored']
  if (!Array.isArray(raw)) return null
  return raw.map((item) => {
    const rec = readRecord(item)
    return { path: String(rec['path'] ?? ''), reason: String(rec['reason'] ?? '') }
  })
}

/**
 * 从本机目录装一个工具包（`POST /api/tools { source: 'path', path }`）。
 *
 * ★ 只支持本地目录是**刻意的**：工具的入口是**要被执行**的脚本，从远端拉一份
 *   脚本下来直接跑是另一件需要单独讨论的事。所以这条路上没有 `url` 分支。
 */
export async function installToolFromPath(input: {
  path: string
  slug?: string
  /** 同名时允许替换（服务端要求显式传，见 `Tools.svelte` 里那个勾选框的注释）。 */
  overwrite?: boolean
}): Promise<ToolInstallResult> {
  let body: unknown
  try {
    body = await api<unknown>('/api/tools', {
      method: 'POST',
      body: JSON.stringify({
        source: 'path',
        path: input.path,
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.overwrite ? { overwrite: true } : {}),
      }),
    })
  } catch (err) {
    // api() 抛的是 ApiError，原始响应体在 `body` 里。**必须把 code 与 detail 取
    // 出来**：它们正是界面给出"下一步该怎么做"的依据（`manifest_invalid` 要引导
    // 去看 detail 说的那一处，而不是让使用者对着"400"发呆）。
    if (err instanceof ApiError) {
      const rec = readRecord(err.body)
      throw new ToolInstallError(
        typeof rec['error'] === 'string' ? rec['error'] : err.message,
        typeof rec['code'] === 'string' ? rec['code'] : 'unknown',
        typeof rec['detail'] === 'string' ? rec['detail'] : null,
      )
    }
    throw err
  }

  const rec = readRecord(body)
  const tool = rec['tool'] as Tool | undefined
  if (!tool) throw new ToolInstallError('服务器没有返回装进来的工具', 'unknown', null)

  const included = readIncluded(rec)
  const ignored = readIgnored(rec)
  return {
    tool,
    included: included ?? Object.keys(tool.files ?? {}).map((path) => ({ path, bytes: null })),
    ignored: ignored ?? [],
    ignoredKnown: ignored !== null,
  }
}

/**
 * 从**远端目录**装一个工具包：`POST /api/tools {source:'payload'}`（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是"页面取好内容、再交给本机 daemon"
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon **不主动外联**（D20）：远端目录由页面取（它本来就连着远端），
 * 取到的 `manifest` / `files` / `docs` 原样交给 daemon 装。与 skill 那条路
 * 完全同形——两条路只有"装什么"不同，没有第二套通信方式。
 *
 * ⚠️ 本地会用**同一份清单 schema** 再校验一遍（远端已经校过一次）。这不是
 *    重复劳动：远端说 A、daemon 按 B 解析的话，症状是"装进来的包少了一个动作"，
 *    没有报错、没有堆栈。
 *
 * ⚠️ `version` 必须与清单里的一致，否则 daemon 会拒（版本只能有一处权威）。
 *    这里直接取清单里的值，别从别处再拿一个。
 */
export async function installToolFromCatalog(entry: {
  slug: string
  version: string | null
  manifest: ToolManifest
  files: Record<string, string>
  docs: string
  overwrite?: boolean
}): Promise<ToolInstallResult> {
  let body: unknown
  try {
    body = await api<unknown>('/api/tools', {
      method: 'POST',
      body: JSON.stringify({
        source: 'payload',
        slug: entry.slug,
        manifest: entry.manifest,
        files: entry.files,
        docs: entry.docs,
        // 版本以**清单**为准（daemon 会核对两者一致）
        version: entry.manifest.version ?? entry.version,
        // 来源标识：界面与审计据此说清"这包是从哪儿来的"
        sourceRef: `remote:${entry.slug}@${entry.manifest.version ?? 'unknown'}`,
        ...(entry.overwrite ? { overwrite: true } : {}),
      }),
    })
  } catch (err) {
    if (err instanceof ApiError) {
      const rec = readRecord(err.body)
      throw new ToolInstallError(
        typeof rec['error'] === 'string' ? rec['error'] : err.message,
        typeof rec['code'] === 'string' ? rec['code'] : 'unknown',
        typeof rec['detail'] === 'string' ? rec['detail'] : null,
      )
    }
    throw err
  }

  const rec = readRecord(body)
  const tool = rec['tool'] as Tool | undefined
  if (!tool) throw new ToolInstallError('服务器没有返回装进来的工具', 'unknown', null)
  const included = readIncluded(rec)
  const ignored = readIgnored(rec)
  return {
    tool,
    included: included ?? Object.keys(tool.files ?? {}).map((path) => ({ path, bytes: null })),
    ignored: ignored ?? [],
    ignoredKnown: ignored !== null,
  }
}

/**
 * 卸载一个工具包：`DELETE /api/tools/:id`。
 *
 * ⚠️ 这里原来会把 400 + `holders` 转成 `ToolInUseError`，让界面"指名道姓"地
 *    说出还有哪些 agent 挂着它。服务端那条拒绝已经删掉（"摘掉"这个动作不存在了，
 *    见 `server.ts` 里 DELETE 那段），所以这个错误类型与这段转换一并删了——
 *    卸载现在只会抛"真的坏了"那类错误。
 */
export async function deleteTool(id: string): Promise<void> {
  await api(`/api/tools/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/**
 * 按错误码给出下一步建议的**键**——错误信息本身不够，使用者要的是"那我该怎么做"。
 *
 * 码来自 daemon 的 `ToolSourceErrorCode`（`tool-source.ts`）。认不出的码返回
 * `null`（= 没有建议可说），而不是一条空词条——词表里不允许空值。
 */
export function toolInstallErrorHint(code: string): TextMessage | null {
  switch (code) {
    case 'bad_input':
      return { id: 'tools.errBadInput' }
    case 'not_found':
      return { id: 'tools.errNotFound' }
    case 'not_a_directory':
      return { id: 'tools.errNotADirectory' }
    case 'missing_tool_json':
      return { id: 'tools.errMissingToolJson' }
    case 'bad_json':
      return { id: 'tools.errBadJson' }
    case 'manifest_invalid':
      return { id: 'tools.errManifestInvalid' }
    case 'missing_entry':
      return { id: 'tools.errMissingEntry' }
    case 'binary_file':
      return { id: 'tools.errBinaryFile' }
    case 'too_large':
    case 'too_many_files':
      return { id: 'tools.errTooLarge' }
    default:
      return null
  }
}
