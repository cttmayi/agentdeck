import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkVersionSupport,
  DEFAULT_TEMPLATES,
  getRuntimeDescriptor,
  MATERIAL_MARKERS,
  renderFirstSentence,
  SAMPLE_FIRST_SENTENCE_INPUTS,
  shouldRefuseToRun,
  TEMPLATE_VARIABLES,
  validateTemplate,
  type AgentBackend,
  type FirstSentenceKind,
  type SandboxMode,
} from '@alpha-helper/agent-core'
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  aggregateCost,
  assertReviewerDistinct,
  depthFromChain,
  exportAudit,
  type Store,
} from '@alpha-helper/domain'
import {
  LOCAL_PROTOCOL_VERSION,
  ActionType,
  Capability,
  parseVerdict,
  ulid,
  type Agent,
  type Issue,
  type BlobRef,
  type Report,
  type Run,
  type RunId,
  type RunMessage,
  type Skill,
  type SubmitRunRequest,
  type AgentRole,
  type Workspace,
  type WorkspaceId,
} from '@alpha-helper/protocol'
import { FileStore } from '@alpha-helper/store-file'
import { NOT_BUILT_HINT, isWebBuilt, loadStatic } from '@alpha-helper/web'
import { ActionRunner, type DeriveRunRequest } from './actions.ts'
import { RunExecutor } from './executor.ts'
import {
  ReportIngestor,
  ThirdPartyItemSchema,
  unmatchedReportNotice,
  type ThirdPartyItem,
} from './ingest.ts'
import { reconcileInterruptedRuns } from './reconcile.ts'
import { checkEnvironment, renderEnvironmentReport } from './environment.ts'
import { fallbackWorkRoot } from './workdir.ts'
import {
  UnsafePathError,
  WORK_FILE_HEADERS,
  contentTypeFor,
  listWorkDir,
  managedPathsFor,
  readWorkFile,
} from './workdir-files.ts'
import { ReviewCoordinator } from './review.ts'
import { RunRegistry, replayMessagesSince } from './registry.ts'
import { createRuntimeBackend, knownRuntimeAdapters } from './runtime-registry.ts'
import { Semaphore } from './semaphore.ts'
import { WorkDirLocks } from './workdir-locks.ts'
import {
  SkillSourceError,
  describeSource,
  resolvePayloadEntry,
  resolveSkillSource,
  type ResolvedSkillSource,
  type SkillSourceSpec,
} from './skill-source.ts'

/**
 * 本地 daemon 服务。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全模型：同源之后只剩两条必需项（design §14.2）
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为 Web UI **由本进程托管**，页面与接口同源，所以：
 *
 *   ✗ 不需要 Origin 白名单 —— 同源策略已在浏览器侧生效
 *   ✗ 不需要一次性令牌   —— 没有跨源入口
 *   ✗ 不需要约定握手     —— 页面本来就是从这个端口加载的
 *   ✓ **只绑回环地址**   —— 杜绝局域网内其他机器访问
 *   ✓ **校验 Host 头**   —— 防 DNS rebinding
 *
 * 最后一条是同源架构下剩下的主要威胁：攻击者可以让一个域名解析到
 * 127.0.0.1，但**无法伪造 Host 头**。
 */

/** 请求体上限（FR-BRIDGE-16）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * run 的终态。
 *
 * 用在 SSE 上：晚订阅（刷新后、或连上时 run 已结束）时**补发一个 terminal
 * 并结束流**。不补的话页面永远收不到终态——既不刷新，也不关闭连接，
 * 而 `EventSource` 每次断开都会自动重连，于是刷屏"连接中断，正在重连…"。
 */
const TERMINAL_RUN_STATUSES: readonly string[] = ['completed', 'failed', 'cancelled']

export interface DaemonOptions {
  dataDir: string
  port: number
  fsync?: boolean
  /** 覆盖可执行文件路径（测试用）。 */
  executablePath?: string
  /**
   * 选哪个 runtime 跑任务（FR-CLI-47）。
   *
   * ★ 加这一项的直接后果：daemon 从"只能跑 claude"变成"能跑表里的任何一个"。
   *   刻意**不做静默回退**——写错 key 就报错并列出可用的。回退到 claude 会让
   *   一次配置错误表现成"能跑，只是行为不对"，那种错最难查。
   *
   * 缺省 claude：agent 记录里的 `runtimeKey` 首版全部播种为 claude。
   * 按 agent 选 runtime 是后续步骤；本项先让第二个 runtime **真的能被跑起来**。
   */
  runtimeKey?: string
  /**
   * 注入一个后端实现。
   *
   * ★ 存在的理由是 **NFR-T-01**：单元测试与常规 CI **绝不能调用使用者真实
   *   安装的 agent CLI**——那会消耗真实额度，还可能让 agent 改动文件。
   *   所以测试用假后端，真后端只在真实运行时构造。
   */
  backend?: AgentBackend
  maxConcurrentRuns?: number
  /**
   * 自动分配的工作目录根（D27）。
   *
   * 缺省是**数据目录之内的 `work/`**（`fallbackWorkRoot`）——一个自洽的兜底，
   * 不碰家目录。CLI 会显式传 `~/alpha-helper-workspace`（可见的那一个），
   * 因为"工作目录放哪"是面向使用者的产品决定，属于 CLI 那一层。
   */
  workRoot?: string
  /**
   * 可选沙箱（M4）。缺省 `'none'`——见 `docs/design.md` §14.1 与 NG7：
   * 首版 run 以 daemon 用户的完整权限执行，这一点必须如实披露。
   *
   * ⚠️ 开启后如果平台上拿不到沙箱工具，daemon **会在起 run 时报错**，
   *    而不是静默降级——静默降级会让人在以为自己被保护着的情况下裸奔。
   */
  sandboxMode?: SandboxMode
  /**
   * 注入 fetch，供"从 GitHub 安装 skill"使用。
   *
   * ★ 存在的理由是 **NFR-T-01**：测试**绝不能联网**。不注入的话，任何一条
   *   覆盖 GitHub 安装路径的测试都会真的去打 GitHub——既不可重复、又会被
   *   匿名限额卡住、还会在没网的机器上失败。
   */
  fetchImpl?: typeof fetch
  /** GitHub 令牌（可选）。缺省读环境变量 ALPHA_HELPER_GITHUB_TOKEN。 */
  githubToken?: string | null
  onWarn?: (message: string) => void
  onInfo?: (message: string) => void
}

export interface DaemonHandle {
  url: string
  port: number
  store: Store
  /** 实际生效的工作目录根——启动横幅要显示它，见 cli.ts。 */
  workRoot: string
  close(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过上限')
    chunks.push(buf)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 内置的通用审核模板（FR-AGENT-08/09）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么提成模块级常量
 * ══════════════════════════════════════════════════════════════════
 *
 * 它现在有**两个**用处：首启播种、以及给老数据回填版本（见下一个函数）。
 * 回填要靠"正文逐字节相同"来判断"这条就是当年那份原样的内置模板"，
 * 所以两处必须用**同一个字符串**——各写一份的话，改了一处忘了另一处，
 * 回填就会静默失效（表现为版本一直是空，界面永远显示"替换本地同名"）。
 */
const BUILTIN_REVIEW_SKILL: Omit<
  Skill,
  'id' | 'workspaceId' | 'createdAt' | 'updatedAt'
> = {
  slug: 'general-review',
  name: '通用审核',
  description: '开箱可用的通用审核标准：能通过就通过，不行就给出可执行的动作，拿不准就交给人。',
  body: [
    '# 通用审核',
    '',
    '## 判断标准',
    '',
    '1. **能明确判断**时给出 `pass` 或 `fail`，并把证据指回原文。',
    '2. **判断依据不足**时给出 `needs_human`，写清楚缺什么。',
    '3. 不要引入这份标准之外的要求——那是越权，不是严谨。',
    '',
    '## 动作约定',
    '',
    '- `fail` 时用一个动作表达"接下来做什么"，而不是只描述问题。',
    '- 只有确实需要改动时才 `issue.update_status`；纯提示用 `comment.create`。',
  ].join('\n'),
  verdictSchemaVersion: 1,
  // ★ 动作子集：这个模板只允许发表评论与打标签，不允许建 issue 或指派 agent
  allowedActions: ['comment.create', 'issue.add_label'],
  source: 'local',
  sourceRef: null,
  /**
   * 内置的这份就是公共目录里 `general-review` 的 1.0.0（正文一致，
   * 见 `apps/remote/src/server.ts` 的目录）。
   *
   * 带上版本，界面才能对着目录说"已经装了、版本一致"，而不是把同名一律
   * 当成冲突——那样使用者每次点「安装」都只会看到一条像出错的提示。
   */
  version: '1.0.0',
}

/**
 * 给**老数据**里的内置模板补上版本号。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它：`version` 是后加的字段
 * ══════════════════════════════════════════════════════════════════
 *
 * 在使用者已有的数据目录里，那条内置 `general-review` 是**加字段之前**
 * 播种的，所以没有版本。界面的判断规则是"有版本才能比较"，于是它会显示
 * 「替换本地同名」——而这恰好把使用者最想看到的那句话（"已经装了、版本一致"）
 * 挡掉了：他明明装的就是同一份东西。
 *
 * 回填的判据**刻意很严**（四个条件全满足才动）：
 *
 *   - slug 相同；
 *   - `source === 'local'` 且 `sourceRef === null`（是内置播种的形态）；
 *   - 还没有版本；
 *   - **正文与内置模板逐字节相同** —— 内容被改过就不认，宁可继续显示"来源不明的同名"。
 *
 * 最后一条是关键：不去检查内容就回填，等于替一份**可能是别的东西**的文件
 * 背书（使用者会看到"已安装"然后不再去装）。宁可少回填，不可错回填。
 */
async function backfillBuiltinSkillVersion(
  store: Store,
  workspaceId: WorkspaceId,
  info: (message: string) => void,
): Promise<void> {
  for (const skill of await store.listSkills(workspaceId)) {
    if (skill.slug !== BUILTIN_REVIEW_SKILL.slug) continue
    if (skill.source !== 'local' || skill.sourceRef !== null) continue
    if (skill.version) continue
    if (skill.body !== BUILTIN_REVIEW_SKILL.body) continue

    // 只补版本，**不动正文**：这是一次登记，不是一次覆盖
    await store.insertSkill({ ...skill, version: BUILTIN_REVIEW_SKILL.version })
    info(
      `已给内置 skill ${skill.slug} 补上版本 ${BUILTIN_REVIEW_SKILL.version}` +
        `（它是公共目录那一份的本地副本；补上之后界面才能判断"已安装/可更新"）`,
    )
  }
}

/**
 * 安装内核：**两个接口共用这一份**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须抽出来，而不是在两处各写一遍
 * ══════════════════════════════════════════════════════════════════
 *
 * "同名怎么办"是一条**安全规则**：同名一律拒绝写入，避免"下载顺手覆盖了
 * 你自己的东西"；要替换必须显式说。抽出来之前只有批量那个接口有这条规则，
 * 新加的"从路径安装"如果各写一份，两边迟早会不一致——而那种不一致的表现是
 * "从远端装会被拒、从 GitHub 装会静默覆盖"，属于最难发现的一类。
 */
async function installSkillPayloads(input: {
  store: Store
  workspaceId: WorkspaceId
  payloads: Array<Partial<Skill> & { slug?: string }>
  overwrite: boolean
  now: number
}): Promise<{
  installed: Skill[]
  skipped: Array<{ slug: string; reason: string; existingSource: string }>
}> {
  const { store, workspaceId, payloads, overwrite, now } = input
  const existing = await store.listSkills(workspaceId)
  const bySlug = new Map(existing.map((s) => [s.slug, s]))
  const installed: Skill[] = []
  const skipped: Array<{ slug: string; reason: string; existingSource: string }> = []

  for (const payload of payloads) {
    const slug = typeof payload.slug === 'string' ? payload.slug : ''
    if (slug === '') {
      skipped.push({ slug: '(空)', reason: 'slug 是 skill 的权威标识，不能为空', existingSource: '' })
      continue
    }

    // ══════════════════════════════════════════════════════════════════
    // ★ 在这里过一遍"这确实是一个技能"——两个接口**同一关**
    // ══════════════════════════════════════════════════════════════════
    //
    // 这条校验原来只在"从路径/GitHub 安装"那条路上（`resolvePayloadEntry`），
    // 而批量接口（设置抽屉里那个「安装」）**直接收下**：一个 `body: ''` 的条目
    // 会被原样写进库——装进去的技能永远不会生效，而界面显示"已安装"。
    //
    // 抽到内核里做，是因为"从哪装"不该改变"装成什么"：批量那条路同样要满足
    // 「有 SKILL.md 的内容」「限额之内」。README 上那句"两条路都要过同一关"
    // 在此之前**只对其中一条成立**。
    let validated
    try {
      validated = resolvePayloadEntry({
        slug,
        body: typeof payload.body === 'string' ? payload.body : '',
        files: payload.files ?? null,
        sourceRef: payload.sourceRef ?? `remote:${slug}`,
      })
    } catch (err) {
      skipped.push({
        slug,
        existingSource: '',
        reason: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const clash = bySlug.get(slug)
    if (clash && !overwrite) {
      skipped.push({
        slug,
        existingSource: clash.source,
        reason:
          `已有同名 skill（来源：${clash.source}）。` +
          `同名一律拒绝写入，避免"下载顺手覆盖了你自己的东西"；` +
          `确实要替换请显式传 overwrite: true。`,
      })
      continue
    }

    const skill: Skill = {
      // 同名替换时**复用原 id**：否则会留下一条永远没人引用的孤儿记录
      id: (clash?.id ?? payload.id ?? (ulid() as Skill['id'])) as Skill['id'],
      workspaceId,
      slug,
      name: payload.name ?? slug,
      description: payload.description ?? null,
      // 用**校验过的**正文与支持文件，而不是原始入参：规范化（比如 frontmatter
      // 里的 name 与 slug 对齐）在 `resolvePayloadEntry` 那边已经做过了
      body: validated.body,
      // 支持文件要落库，否则"装进来了但注入时只有 SKILL.md"——
      // 那种技能是坏的，而且坏得很安静
      ...(Object.keys(validated.files).length > 0 ? { files: validated.files } : {}),
      verdictSchemaVersion: 1,
      allowedActions: payload.allowedActions ?? ['comment.create'],
      // ★ 缺省是 `remote`：批量这条路本来就是"页面从远端目录下载好交过来"。
      //   把默认值反过来会让"下载来的"默认冒充"使用者自有的"，而 FR-AGENT-10
      //   正是靠这个字段判断"本地内容会不会因远端变化而改变"。
      //   显式声明 `local` 的调用方（从本地路径/GitHub 装的）不受影响。
      source: payload.source === 'local' ? 'local' : 'remote',
      sourceRef: payload.sourceRef ?? null,
      // 版本如实落库：界面靠它判断"已安装 / 可更新"
      version: payload.version ?? null,
      createdAt: clash?.createdAt ?? now,
      updatedAt: now,
    }
    await store.insertSkill(skill)
    bySlug.set(slug, skill)
    installed.push(skill)
  }

  return { installed, skipped }
}

/**
 * 校验安装来源。**逐字段**校验，因为这是运行时的任意 JSON。
 *
 * 返回 `{ok:false}` 而不是抛异常：来源不对是**使用者输入问题**（400），
 * 不是服务出错（500），两者的处置完全不同。
 */
function parseInstallSource(
  raw: unknown,
): { ok: true; spec: SkillSourceSpec } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '需要 source（对象）' }
  }
  const obj = raw as Record<string, unknown>
  const kind = obj['kind']

  if (kind === 'path') {
    const value = obj['path']
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: 'source.kind=path 需要非空的 path（绝对路径）' }
    }
    return { ok: true, spec: { kind: 'path', path: value.trim() } }
  }

  if (kind === 'url') {
    const value = obj['url']
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: 'source.kind=url 需要非空的 url' }
    }
    return { ok: true, spec: { kind: 'url', url: value.trim() } }
  }

  if (kind === 'payload') {
    const slug = obj['slug']
    const body = obj['body']
    if (typeof slug !== 'string' || slug.trim() === '') {
      return { ok: false, error: 'source.kind=payload 需要非空的 slug' }
    }
    if (typeof body !== 'string') {
      return { ok: false, error: 'source.kind=payload 需要 body（字符串）' }
    }
    const files = obj['files']
    if (files !== undefined && files !== null) {
      if (typeof files !== 'object' || Array.isArray(files)) {
        return { ok: false, error: 'source.files 必须是 相对路径→内容 的对象' }
      }
      for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
        if (typeof v !== 'string') return { ok: false, error: `source.files['${k}'] 必须是字符串` }
      }
    }
    const sourceRef = obj['sourceRef']
    const version = obj['version']
    if (version !== undefined && version !== null && typeof version !== 'string') {
      return { ok: false, error: 'source.version 必须是字符串或 null' }
    }
    return {
      ok: true,
      spec: {
        kind: 'payload',
        slug: slug.trim(),
        body,
        ...(files ? { files: files as Record<string, string> } : {}),
        sourceRef: typeof sourceRef === 'string' && sourceRef ? sourceRef : `remote:${slug.trim()}`,
        version: typeof version === 'string' ? version : null,
      },
    }
  }

  return { ok: false, error: 'source.kind 必须是 path / url / payload 之一' }
}

/**
 * 当前生效的 workspace 级设置（D32 的模版 + D36 的默认智能体）。
 *
 * ★ store 是"存什么读什么"，不做 schema 迁移——加字段之前建的 workspace 读回来
 *   那两个键**根本不存在**。类型上写着 `string`、运行时是 `undefined`，这种
 *   "类型在骗人"的状态迟早会漏到某个 `??` 之外。所以在**这里**补成空串：
 *   空 = 平台默认模版 = 与加这个功能之前完全一样。
 *
 * 执行器读的是**同一个函数**——"界面上显示的那份"与"真的投递出去的那份"
 * 必须是同一份，否则这个功能最该防的错觉（看到的不是生效的）就成立了。
 */
async function readWorkspaceSettings(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ executeTemplate: string; reviewTemplate: string; defaultAgentId: string | null }> {
  const workspace = await store.getWorkspace(workspaceId)
  return {
    executeTemplate: workspace?.executeTemplate ?? '',
    reviewTemplate: workspace?.reviewTemplate ?? '',
    defaultAgentId: workspace?.defaultAgentId ?? null,
  }
}

/**
 * 解析并校验一个「第一句话模版」字段（D32）。
 *
 * ★ 它是**全局配置**（挂在 workspace 上），不是每个 agent 一份：那段文字是
 *   "平台怎么把一次 run 交代给模型"的骨架，与"这个 agent 是谁"是两件事。
 *
 * 返回 `value: undefined` 表示**这次没传**（PATCH 语义：别动它）。三种"清空"
 * 都算回到平台默认：不传、传 null、传空串。
 *
 * ⚠️ 校验放在这里，而不是渲染的时候：一条坏模版进了库，要等那次 run 真跑起来
 *    才以"模型乱答"的形式暴露，排查方向会指向模型，而不是那个拼错的变量名。
 *    界面的「新建 / 编辑」两个入口都过这一关。
 */
function parseTemplateField(
  key: 'executeTemplate' | 'reviewTemplate',
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string') {
    return { ok: false, error: `${key} 必须是字符串（空字符串 = 用平台默认模版）` }
  }
  const text = raw.trim()
  if (text === '') return { ok: true, value: '' }
  const kind: FirstSentenceKind = key === 'executeTemplate' ? 'execute' : 'review'
  const check = validateTemplate(kind, text)
  if (!check.ok) return { ok: false, error: check.error }
  return { ok: true, value: text }
}

/**
 * 校验 agent 的自定义环境变量（FR-AGENT-06）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么逐项校验，而不是直接收下
 * ══════════════════════════════════════════════════════════════════
 *
 * 这些值会被**原样传给子进程**（后端做 `{...process.env, ...opts.env}`）。
 * 一个对象或数组传下去只会变成 `"[object Object]"` 这种看不出问题的字符串——
 * 使用者以为设上了，CLI 拿到的是垃圾。所以类型不对就当场报错。
 *
 * ⚠️ 这里**不做白名单**：能否覆盖 `PATH`、`CLAUDE_CONFIG_DIR` 之类由使用者决定，
 *    毕竟这是他自己机器上的 agent 配置。但正因为如此，"设了什么"必须是确定的，
 *    不能靠猜。
 */
function parseEnvMap(
  raw: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'env 必须是「键 → 字符串」的对象' }
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim() === '') return { ok: false, error: 'env 的键不能为空' }
    if (typeof value !== 'string') {
      return { ok: false, error: `env['${key}'] 必须是字符串（会原样传给子进程）` }
    }
    out[key] = value
  }
  return { ok: true, value: out }
}

/**
 * 校验动作子集。
 *
 * ⚠️ 这里**不能容错**：动作表是闭合的（INV-9），一个不在表里的动作会让
 * 使用这条 skill 的**每一次判决**都判为不合规。装的时候放过去，等于给使用者
 * 埋一个"审核永远失败"的坑，而且原因看起来跟我们无关。
 */
function parseAllowedActions(raw: readonly unknown[]): Skill['allowedActions'] {
  const valid = new Set<string>(ActionType.options)
  const bad = raw.filter((a) => typeof a !== 'string' || !valid.has(a))
  if (bad.length > 0) {
    throw new SkillSourceError(
      'bad_input',
      `不认识的动作：${bad.map((b) => String(b)).join('、')}`,
      `动作表是闭合的，可用：${[...valid].join('、')}。`,
    )
  }
  return raw as Skill['allowedActions']
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const warn = options.onWarn ?? ((m: string) => console.warn(`[warn] ${m}`))
  const info = options.onInfo ?? ((m: string) => console.log(m))

  const store = await FileStore.open({ dataDir: options.dataDir, fsync: options.fsync ?? true })

  // ★ runtime 的选择从"写死 claude"变成"查装配表"（FR-CLI-47）。
  //   表里有几个 runtime，这里就能跑几个——本文件不再认识任何具体 CLI。
  const runtimeKey = options.runtimeKey ?? 'claude'
  const selected = createRuntimeBackend(runtimeKey, {
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    onWarn: warn,
  })
  const descriptor = selected.descriptor
  const backend = options.backend ?? selected.backend

  // 工作目录的根（D27）：每个任务自动分配一个独立目录。
  //
  // 兜底在数据目录**之内**（绝不碰家目录），可见的那个默认值由 CLI 给出——
  // 见 `fallbackWorkRoot` 的注释。
  const workRoot = options.workRoot ?? fallbackWorkRoot(options.dataDir)

  const registry = new RunRegistry()
  const locks = new WorkDirLocks()
  const semaphore = new Semaphore(options.maxConcurrentRuns ?? 20)

  const actionRunner = new ActionRunner({
    store,
    deriveRun: (req) => deriveRunFromAction(req),
  })
  const reviewCoordinator = new ReviewCoordinator({
    store,
    actions: actionRunner,
    createRetryRun: (run) => createRetryRun(run),
  })

  const executor = new RunExecutor({
    store,
    workRoot,
    // ★ 按 agent 的 runtimeKey 解析 backend（D28）。
    //   在此之前 agent.runtimeKey 是个没人读的字段——界面上能选、审计里会记，
    //   行为上所有 agent 都跑同一个 CLI。那正是"接口接受了、行为上不存在"。
    resolveRuntime: (key) => {
      const adapter = knownRuntimeAdapters()[key]
      if (!adapter) {
        throw new Error(`未知的 runtime：${key}。可用的：${Object.keys(knownRuntimeAdapters()).join(', ')}`)
      }
      // ★ 注入了 backend 时**必须**用它。
      //
      //   这是 NFR-T-01 的落点：测试注入一个假后端，就是为了**绝不启动
      //   使用者真实安装的 CLI**（那会消耗真实额度、还可能让 agent 改文件）。
      //   如果这里无条件 `adapter.create()`，注入的假后端就被绕过去了——
      //   测试会开始偷偷跑真 CLI。
      //
      //   这个错误当场就被测试抓到了（S2 的用例集体超时 8 秒），因为假后端
      //   不再被调用、真 CLI 却在等输入。**没有那条测试的话，它只会在使用者
      //   的账单上体现出来。**
      if (options.backend && key === selected.descriptor.key) {
        return { backend: options.backend, descriptor: adapter.descriptor }
      }
      return {
        backend: adapter.create({
          ...(options.executablePath ? { executablePath: options.executablePath } : {}),
          onWarn: warn,
        }),
        descriptor: adapter.descriptor,
      }
    },
    registry,
    backend,
    descriptor,
    semaphore,
    locks,
    reviewCoordinator,
    autoChainReview,
    ...(options.sandboxMode && options.sandboxMode !== 'none'
      ? { sandbox: { mode: options.sandboxMode } }
      : {}),
    onWarn: warn,
  })

  /**
   * S1 的自动串接：执行完成后找一个**不同的** agent 来审。
   *
   * 两条约束在这里落地：
   *   - **reviewer ≠ executor**（INV-1~3）：找审核者时直接排除执行者；
   *   - **回路边界**（INV-14）：链路深度超限就不再派生，避免
   *     "改 → 审 → 再改 → 再审" 无限循环烧 token。
   */
  async function autoChainReview(input: {
    executeRun: Run
    executorAgentId: string
    output: string
  }): Promise<{ runId: RunId | null; note: string }> {
    const agents = await store.listAgents(workspaceId)
    const executor = agents.find((a) => (a.id as string) === input.executorAgentId)
    if (!executor) {
      warn(`找不到执行 agent ${input.executorAgentId}，跳过自动审核`)
      return { runId: null, note: '没有串接审核：找不到这次执行用的 agent（它可能已被删除）' }
    }

    // ★ D28：**由这个执行 agent 自己指定**审核者，而不是"从别人里挑一个"。
    //
    //   原来是从其他 agent 里找兜底者、再退回第一个——那个规则有个很隐蔽的
    //   坏处：**换审核者不需要任何人做决定**。你新建一个 agent，它就悄悄
    //   变成了既有执行者的审核者（如果它排在前面）。而"谁来审我"是一件
    //   应该被明确指定的事。
    //
    //   `reviewerAgentId` 为空 = 明确选择不自动审（不是配置错误）。
    if (!executor.reviewerAgentId) {
      return {
        runId: null,
        note:
          `没有串接审核：agent「${executor.name}」没有指定审核者（「由谁审它」是空的）。` +
          `这是**明确的选择**，不是配置错误；要自动审就在智能体页给它选一个审核者。`,
      }
    }

    const reviewer = agents.find((a) => a.id === executor.reviewerAgentId)
    if (!reviewer) {
      warn(
        `agent ${executor.name} 指定的审核者已不存在（${executor.reviewerAgentId}），跳过自动审核`,
      )
      return {
        runId: null,
        note:
          `没有串接审核：agent「${executor.name}」指定的审核者已经不存在了` +
          `（id ${executor.reviewerAgentId}）。请在智能体页重新指定一个。`,
      }
    }

    const depth = input.executeRun.chainDepth + 1
    if (depth > DEFAULT_MAX_CHAIN_DEPTH) {
      await store.appendInboxItem({
        id: ulid(),
        workspaceId,
        type: 'chain.depth_exceeded',
        severity: 'attention',
        title: '链路深度超限，已停止自动审核',
        body: `这条链路已经连续派生 ${depth} 次，超过上限 ${DEFAULT_MAX_CHAIN_DEPTH}。停止继续派生，避免无限循环。`,
        issueId: issueIdOfSubject(input.executeRun),
        runId: input.executeRun.id,
        read: false,
        createdAt: Date.now(),
      })
      return {
        runId: null,
        note:
          `没有串接审核：这条链路已经派生 ${depth} 次，超过上限 ${DEFAULT_MAX_CHAIN_DEPTH}，` +
          `停止继续派生以避免"改 → 审 → 再改 → 再审"烧 token（已发通知）。`,
      }
    }

    const chainedRunId = await createRunForReviewer({
      reviewer,
      kind: 'run-output',
      title: `审核执行产出（run ${input.executeRun.id.slice(-8)}）`,
      body: input.output.slice(0, 20_000),
      subject: { type: 'run', id: input.executeRun.id },
      chainDepth: depth,
      // ★ 把 issue 交给模型：判决里的动作参数需要它
      relatedIssueId: issueIdOfSubject(input.executeRun),
      prompt: '请审核上面这次执行的产出，并按审核标准给出判决。',
    })
    return {
      runId: chainedRunId,
      note: chainedRunId
        ? `已串接审核：run ${chainedRunId}（审核者「${reviewer.name}」）。它继承本次的工作目录，` +
          `所以看得见这里留下的产出。`
        : `没有串接审核：审核者「${reviewer.name}」一个 skill 都没挂，` +
          `而审核标准就在 skill 里——没有标准的审核不算审核。`,
    }
  }

  const ingestor = new ReportIngestor({ store })
  // 探测一次当前 runtime，用于环境预检（不重复探测别的 runtime——
  // 没装的 CLI 谈不上"它家目录写不进去"）
  const probe2 = await backend.probe()

  const workspaceId = await bootstrap(store, info)

  // ★ Web UI 的构建产物不进版本库（gitignore），所以 clone 下来直接起 daemon
  //   会**没有界面**。这种情况必须说清楚怎么做，而不是发一个空白页让人以为
  //   是 daemon 坏了。只提示、不阻止启动——API 与 CLI 仍然完全可用。
  if (!(await isWebBuilt())) {
    warn(NOT_BUILT_HINT)
  }

  // ★ 环境预检：CLI 自己的状态目录能不能写。
  //
  //   实测踩到过：agent 的工具输出里冒出 `EPERM ... mkdir '/Users/x/.claude/
  //   session-env/<uuid>'`，而那个路径**不是工作目录**。它长得像"工作目录
  //   没建成功"，于是排查会从工作目录开始——那里根本没问题。
  //
  //   而且**越是按推荐做法部署（容器 / 专用用户 / 沙箱）越容易撞上它**，
  //   所以在启动时就说清楚，比让使用者在 agent 输出里猜便宜得多。
  const envReport = await checkEnvironment(
    Object.entries(knownRuntimeAdapters()).map(([key, adapter]) => ({
      descriptor: adapter.descriptor,
      available: key === descriptor.key ? probe2.available : false,
    })),
  )
  if (!envReport.ok) {
    warn(renderEnvironmentReport(envReport))
  }

  // ══════════════════════════════════════════════════════════════════
  // ★ 先收口上次遗留的 run，**再**起 HTTP 服务（FR-RUNTIME-11）
  // ══════════════════════════════════════════════════════════════════
  //
  // 顺序不能反：run 的状态是持久化的，所以上次退出时还在跑的 run 会留在
  // `running` 这类非终态上。若先起服务，页面立刻就能读到那些陈旧状态并
  // 显示成"进行中"——而它们永远不会再有结果。
  //
  // 收口**只能标记失败**，不能续跑：执行所需的 prompt / 技能正文 / 限额
  // 是随 HTTP 请求来的，没有落盘（`Run` 实体里只有 `skillRefs` 这类引用）。
  // 假装能续跑会跑出一个内容不对的东西，而且看起来一切正常——比明确失败糟得多。
  try {
    const reconciled = await reconcileInterruptedRuns({ store })
    if (reconciled.interrupted.length > 0) {
      warn(
        `上次退出时有 ${reconciled.interrupted.length} 个 run 没结束，` +
          `已标记为中断（daemon_restarted）。它们无法续跑——执行所需的信息没有落盘。`,
      )
    }
  } catch (err) {
    // 收口失败不该阻止 daemon 启动，但必须可见：留着会导致"永远在途"的假象
    warn(`收口遗留 run 失败（可能留下显示为"进行中"的陈旧记录）：${String(err)}`)
  }

  // 老数据里的内置技能没有版本号（字段是后加的），补上。
  // 失败同样不阻止启动：它只影响界面上显示"已安装"还是"替换同名"。
  try {
    await backfillBuiltinSkillVersion(store, workspaceId, info)
  } catch (err) {
    warn(`回填内置 skill 版本失败（界面可能显示成"来源不明的同名"）：${String(err)}`)
  }

  /** 起一个 review run（report 与 run 产出两条来源共用）。 */
  async function createRunForReviewer(input: {
    reviewer: Agent
    kind: string
    title: string
    body: string
    subject: SubmitRunRequest['subject']
    prompt: string
    chainDepth: number
    inputBlobRef?: BlobRef | null
    relatedIssueId?: string | null
  }): Promise<RunId | null> {
    const { reviewer } = input
    // ★ 技能按 agent 求解（不是全局挂一遍，D22）
    const skills = await loadAgentSkills(store, reviewer)
    if (skills.length === 0) {
      warn(`agent ${reviewer.name} 没有挂载任何 skill，无法审核`)
      return null
    }

    const runId = ulid() as RunId
    const outcome = await executor.submit({
      runId,
      kind: 'review',
      agentRef: { id: reviewer.id, name: reviewer.name, instructions: reviewer.instructions },
      skills: skills.map((s) => ({
        ref: { id: s.id, slug: s.slug, source: s.source },
        slug: s.slug,
        name: s.name,
        body: s.body,
        // 协议里是 optional（`string | undefined`），实体上是 `string | null`
        ...(s.description ? { description: s.description } : {}),
        allowedActions: s.allowedActions,
        // 支持文件必须一路带下去，否则装上来的脚本/参考文档到不了工作目录
        files: s.files ?? {},
      })),
      subject: input.subject,
      prompt: input.prompt,
      agentDefaultWorkDir: reviewer.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      chainDepth: input.chainDepth,
      review: {
        kind: input.kind,
        title: input.title,
        body: input.body,
        inputBlobRef: input.inputBlobRef ?? null,
        relatedIssueId: input.relatedIssueId ?? null,
      },
    })

    return outcome.kind === 'accepted' ? runId : null
  }

  /** 为一个 report + reviewer 起一个 review run。 */
  async function createReviewRun(report: Report, reviewer: Agent): Promise<RunId | null> {
    return createRunForReviewer({
      reviewer,
      kind: report.kind,
      title: report.title,
      body: report.body,
      subject: { type: 'report', id: report.id },
      prompt: `审核这条 ${report.kind} 类型的报告：${report.title}`,
      chainDepth: 0,
      inputBlobRef: report.blobRef,
    })
  }

  /**
   * ★ 判决不合规时的重试（FR-CLI-06 的落点）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这曾经是**第二个占位**——和动作派生那一处同源
   * ══════════════════════════════════════════════════════════════════
   *
   * `ReviewCoordinator` 一直支持 `createRetryRun`，但服务端从来没提供它。
   * 于是 `retry` 这条判决路径**永远走到"拿不到重试机会 ⇒ 降级"**那个分支：
   * 表面上"重试了"，实际上每次都是直接降级为建议。
   *
   * 这与动作派生那个占位是同一类问题：**代码看起来支持，行为上从不发生**。
   * 而它恰好掩盖了 FR-CLI-06（会话恢复）——因为恢复只发生在重试时。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两条约束
   * ══════════════════════════════════════════════════════════════════
   *
   * **① 重试是**_RESUME_**，不是重跑。** 通过 `resumeFromRunId` 指向上一次，
   *   执行器会去取它的 sessionId 并**按 sessionState 决定是否真的恢复**。
   *   不恢复时 agent 是在没有上文的情况下重新开始——那和"重试"的语义不同，
   *   所以执行器会把它显式说出来，而不是假装恢复成功了。
   *
   * **② 必须真的尝试新的会话。** 上一次留了 sessionId 就用它；没留
   *   （比如失败得很早）就当新会话跑。重试的价值在于"换一次机会"，
   *   而不在于"必须有上文"。
   */
  /**
   * 上一次审核的**材料**——从它自己的上下文副本里按材料标记切出来。
   *
   * ══════════════════════════════════════════════════════════════════
   * ★ 重试原来带的是**空材料**（`body: ''`）
   * ══════════════════════════════════════════════════════════════════
   *
   * 紧挨着的注释写着"上一次的输出会作为审核对象的正文带进来"，而代码传的是空串。
   * 真实后果（一次任务的两条审核，模型的原话）：
   *
   *   「材料区只有标题『重试审核（原 run …）』，不含任何正文/产物/结论，
   *     且与声明的对象不符，缺少可审核的实际内容」→ 判 needs_human。
   *
   * 模型是对的：**没有材料就不该审**。而它连那点材料都没有，还要花一次 CLI 的钱。
   *
   * 材料从哪儿来：每次 run 都会把自己的「第一句话」原样留一份在
   * `<workdir>/.alpha-helper/context/<runId>.md`，而里面的待审内容是**用标记
   * 包起来的**（`<<<ALPHA_MATERIAL>>>`）。按标记切一刀就是原样的材料——
   * 确定性切片，不需要另存一份、也不会随格式漂。
   */
  async function previousMaterial(
    previous: Run,
  ): Promise<{ body: string; from: string | null }> {
    const path = join(
      previous.workDir ?? '',
      '.alpha-helper',
      'context',
      `${previous.id}.md`,
    )
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) return { body: '', from: null }
    const begin = text.indexOf(MATERIAL_MARKERS.begin)
    if (begin === -1) return { body: '', from: null }
    const bodyStart = begin + MATERIAL_MARKERS.begin.length
    // ★ 取**最后一个**结束标记：材料本身可能又是一份上下文副本（里面同样有
    //   这对标记，比如"重试的重试"）。取第一个会把材料提前截断。
    const end = text.lastIndexOf(MATERIAL_MARKERS.end)
    if (end < bodyStart) return { body: '', from: null }
    return { body: text.slice(bodyStart, end).trim(), from: path }
  }

  async function createRetryRun(previous: Run): Promise<string | null> {
    // 重试的审核者是谁？——同一次审核的重试，应当由**同一个审核者**做。
    // 换人会引入"不同标准"这个额外变量，让"重试有没有变好"变成无法解释的问题。
    const agent = await store.getAgent(previous.agentId)
    if (!agent) {
      warn(`无法为重试找到 agent ${previous.agentId}`)
      return null
    }

    const skills = await loadAgentSkills(store, agent)
    if (skills.length === 0) {
      warn(`agent ${agent.name} 没有挂载任何 skill，无法重试`)
      return null
    }

    // ★ 材料必须**真的**带过来；带不来就不要起这次重试。
    //
    //   返回 null ⇒ 走既有的"拿不到重试机会 ⇒ 降级为建议"那条路：那是诚实的
    //   降级，比"花一次 CLI 的钱审一份空材料、然后判 needs_human"强得多。
    const material = await previousMaterial(previous)
    if (material.body === '') {
      warn(
        `无法为重试拿到上次审核的材料（找不到 ${previous.id.slice(-8)} 的上下文副本），` +
          `这次不重试，直接按降级处理`,
      )
      return null
    }

    const runId = ulid() as RunId
    // 重试的 prompt 与上次相同——变的是"再给一次机会"，不是任务本身。
    // 材料与 subject 都不变（subject 相同 ⇒ 还是审同一条执行产出）。
    const outcome = await executor.submit({
      runId,
      kind: 'review',
      agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
      skills: skills.map((s) => ({
        ref: { id: s.id, slug: s.slug, source: s.source },
        slug: s.slug,
        name: s.name,
        body: s.body,
        // 协议里是 optional（`string | undefined`），实体上是 `string | null`
        ...(s.description ? { description: s.description } : {}),
        allowedActions: s.allowedActions,
        // 支持文件必须一路带下去，否则装上来的脚本/参考文档到不了工作目录
        files: s.files ?? {},
      })),
      subject: previous.subject,
      // ⚠️ 措辞原来说"按**审核标准**里的围栏格式输出"——而围栏约定不在
      //    审核标准（skill）里，它在**本次任务的说明**里（第一句话的「输出要求」）。
      //    指错地方会让模型去 skill 正文里找一个根本不存在的格式。
      prompt:
        `上一次你的输出没能通过格式校验。请**重新**给出判决：**只**输出一个 JSON 对象，` +
        `放在任务说明里那对围栏标记之间，字段名与取值严格照里面的规则，不要额外字段。`,
      // 重试沿用上一次的目录：D27 下目录按**任务**分，重试本来就该在原地继续
      workDir: previous.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      chainDepth: previous.chainDepth,
      // ★ 会话恢复：指向上一次，由执行器按 sessionState 决定要不要真的用
      resumeFromRunId: previous.id,
      review: {
        kind: 'run-output',
        title: `重试审核（原 run ${previous.id.slice(-8)}）`,
        // ★ 原样的材料（从上次的上下文副本里按标记切出来的），不是空串
        body: material.body,
        inputBlobRef: null,
        relatedIssueId: issueIdOfSubject(previous),
      },
    })

    if (outcome.kind !== 'accepted') {
      warn(`重试 run 未被受理：${outcome.kind}`)
      return null
    }
    info(`判决不合规，已派生重试 run：${runId}`)
    return runId
  }

  /**
   * ★ 动作派生 run 的真实实现（M2 闭环，INV-16）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 早先这里是一个占位字符串
   * ══════════════════════════════════════════════════════════════════
   *
   * 旧实现返回 `pending:<issueId>:<agentId>`。它看起来像"派生成功"，
   * 实际上没有 run 被创建——于是**环检测端到端从未被真正走到过**，
   * 因为环需要真的有一条链路才存在。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两条在这里落地的约束
   * ══════════════════════════════════════════════════════════════════
   *
   * **① `derivedFrom` 必须写上。** 它是重建链路唯一的边；漏写的话下一次
   *    环检测就看不到这一步，"派生"会变成一条单向遗忘。
   *
   * **② `chainDepth` 从真实链路推出来，而不是 `父 + 1`。**
   *    两者在正常数据下相等，但真实链路还带着"环"这个信息——
   *    一旦有人手改过数据，只有链路上算出来的深度是可信的。
   *
   * 返回 `null` 是**正常的**：agent 不存在、没有挂载技能都会走到这里。
   * 调用方会把 `spawnedRunId: null` 如实记录，而不是编一个 id。
   */
  async function deriveRunFromAction(req: DeriveRunRequest): Promise<string | null> {
    const issueId = req.params['issueId']
    const agentId = req.params['agentId']
    if (typeof issueId !== 'string' || typeof agentId !== 'string') {
      warn(`动作派生的参数不完整：${JSON.stringify(req.params)}`)
      return null
    }

    const agent = await store.getAgent(agentId as Agent['id'])
    if (!agent) {
      warn(`动作要指派的 agent 不存在：${agentId}`)
      return null
    }

    const skills = await loadAgentSkills(store, agent)
    if (skills.length === 0) {
      warn(`agent ${agent.name} 没有挂载任何 skill，无法执行派生出的 run`)
      return null
    }

    const issue = await store.getIssue(issueId as Issue['id'])
    if (!issue) {
      warn(`动作要指派的 issue 不存在：${issueId}`)
      return null
    }

    const runId = ulid() as RunId
    const outcome = await executor.submit({
      runId,
      kind: 'execute',
      agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
      skills: skills.map((s) => ({
        ref: { id: s.id, slug: s.slug, source: s.source },
        slug: s.slug,
        name: s.name,
        body: s.body,
        // 协议里是 optional（`string | undefined`），实体上是 `string | null`
        ...(s.description ? { description: s.description } : {}),
        allowedActions: s.allowedActions,
        // 支持文件必须一路带下去，否则装上来的脚本/参考文档到不了工作目录
        files: s.files ?? {},
      })),
      subject: { type: 'issue', id: issue.id },
      prompt:
        `你被指派处理 issue「${issue.title}」。\n\n` +
        `${issue.description || '（没有更多描述）'}\n\n` +
        `这条任务是由一次审核判决派生出来的，请完成它。`,
      agentDefaultWorkDir: agent.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      // ★ 链路：这一环来自那个动作
      chainDepth: depthFromChain(req.chainSteps) + 1,
      derivedFrom: req.fromActionId,
    })

    if (outcome.kind !== 'accepted') {
      warn(`动作派生的 run 未被受理：${outcome.kind}`)
      return null
    }
    info(`动作派生出一条新 run：${runId}（agent ${agent.name} ← issue ${issue.title}）`)
    return runId
  }

  // ── Host 校验：防 DNS rebinding ──
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      warn(`请求处理失败：${String(err)}`)
      if (!res.headersSent) sendJson(res, 500, { error: String(err) })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const host = req.headers.host ?? ''

    // 只有本机来源可用。攻击者能让域名解析到 127.0.0.1，但改不了 Host。
    if (!isAllowedHost(host, server.address() as AddressInfo | null)) {
      sendJson(res, 403, {
        error: `拒绝访问：Host 头 ${JSON.stringify(host)} 不在允许列表内（只接受回环地址）`,
      })
      return
    }

    const path = url.pathname

    // ── 静态资源（UI）──
    if (req.method === 'GET' && !path.startsWith('/api/') && path !== '/health') {
      const asset = await loadStatic(path)
      if (asset) {
        res.writeHead(200, {
          'content-type': asset.contentType,
          'content-length': asset.body.length,
          // 同源页面，不需要放宽任何跨源策略
          'x-content-type-options': 'nosniff',
        })
        res.end(asset.body)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('未找到')
      return
    }

    // ── GET /health ──
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    // ── GET /api/identity ──
    if (req.method === 'GET' && path === '/api/identity') {
      const device = await store.getDevice()
      const probe = await backend.probe()

      // ★ runtimes 数组从"只有当前那一个"改成**枚举装配表里的全部**。
      //
      //   原先只报当前 runtime，于是"平台支持哪些 CLI"这件事在接口上
      //   根本看不出来——第二个适配器插上了也没人知道。现在每一项都带
      //   `evidence`：`provisional` 的条目在 UI 上应当被标注为未验证，
      //   否则使用者会以为它和 claude 一样可信（见 RuntimeDescriptor 的注释）。
      const adapterEntries = Object.entries(knownRuntimeAdapters())
      const runtimes = await Promise.all(
        adapterEntries.map(async ([key, adapter]) => {
          const isCurrent = key === descriptor.key
          const live = isCurrent
            ? { available: probe.available, cliVersion: probe.cliVersion }
            : await adapter.create({ onWarn: warn }).probe()

          const desc = isCurrent ? descriptor : adapter.descriptor

          // ★ 版本支持判定（FR-CLI-07）必须出现在身份接口里。
          //
          //   "我们验过哪些 CLI 版本"是个会影响信任的事实：一个未声明的
          //   runtime 和一个已实测的 runtime，使用者对它们的预期完全不同。
          //   把它藏在日志里等于没说——身份接口正是页面展示能力的地方。
          const support = checkVersionSupport(desc, live.cliVersion)

          return {
            key,
            command: desc.command,
            available: live.available,
            cliVersion: live.cliVersion,
            evidence: desc.evidence,
            // 未验证的 runtime 要能说清**缺什么证据**：只标"未验证"会让人
            // 以为"再等等就好"，而实际上需要一次真实 CLI 的逐条核对。
            evidenceNote: desc.evidenceNote ?? null,
            // 会话状态：`unknown` 必须与 `stateless` 区分开，
            // 因为前者要人去核对真实 CLI，后者什么都不用做。
            sessionState: desc.sessionState,
            versionSupport: {
              status: support.status,
              range: desc.versions?.range ?? null,
              verifiedWith: support.verifiedWith,
              refusalWouldApply: shouldRefuseToRun(support),
              message: support.message,
            },
          }
        }),
      )

      // 环境问题也要进身份接口：界面据此在智能体页给出提示，
      // 而不是等使用者从 agent 输出里读一句 EPERM
      const env = await checkEnvironment([
        { descriptor, available: probe.available },
      ])

      sendJson(res, 200, {
        environment: { ok: env.ok, issues: env.issues },
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        deviceId: device?.id ?? 'unknown',
        deviceName: device?.name ?? 'unknown',
        runtimes,
        capabilities: [Capability.SseResume, Capability.Artifacts],
      })
      return
    }

    // ── agents / issues（M0 看板需要的最小 CRUD）──
    if (req.method === 'GET' && path === '/api/agents') {
      const [agents, settings] = await Promise.all([
        store.listAgents(workspaceId),
        readWorkspaceSettings(store, workspaceId),
      ])
      // ★ 默认智能体跟着列表一起给：界面要在卡片上标「默认」，新建任务页要用它
      //   当预选项——两处都拿同一份，不各自猜。
      sendJson(res, 200, { agents, defaultAgentId: settings.defaultAgentId })
      return
    }

    // ── 指定 / 取消「新建任务的默认智能体」（D36）──
    //
    // 它是**全局单值**（"默认交给谁"就是一个选择），所以入口不是一个新实体，
    // 而是 workspace 上的一个字段 + 这一个接口。
    if (req.method === 'PUT' && path === '/api/agents/default') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const raw = body['agentId']
      const workspace = await store.getWorkspace(workspaceId)
      if (!workspace) {
        sendJson(res, 404, { error: `workspace 不存在：${workspaceId}` })
        return
      }

      if (raw === null) {
        // 取消：显式回到"没设过"
        await store.insertWorkspace({ ...workspace, defaultAgentId: null, updatedAt: Date.now() })
        sendJson(res, 200, { defaultAgentId: null })
        return
      }

      if (typeof raw !== 'string' || raw.trim() === '') {
        sendJson(res, 400, { error: 'agentId 必须是 agent 的 id，或 null（= 取消默认）' })
        return
      }
      const agent = await store.getAgent(raw as Agent['id'])
      if (!agent) {
        sendJson(res, 400, { error: `agent 不存在：${raw}` })
        return
      }
      // ★ 只有执行者能当默认：审核者是被动的一方（它由执行者的 reviewerAgentId
      //   指过去），把任务交给它执行是配置错误——这种错误在"任务已经派出去"
      //   之后才发现，而那时它已经跑了一轮。
      if (agent.role !== 'executor') {
        sendJson(res, 400, {
          error: `只有「执行」角色的智能体能当默认——「${agent.name}」是审核者。` +
            `审核者是别人产出交给它的那一方，不会接任务。`,
        })
        return
      }
      await store.insertWorkspace({
        ...workspace,
        defaultAgentId: agent.id,
        updatedAt: Date.now(),
      })
      sendJson(res, 200, { defaultAgentId: agent.id })
      return
    }

    // ── 第一句话的模版（D32）──
    //
    // 界面上的那一栏要三样东西：两个默认模版（"填入默认模版"用）、变量对照表
    // （写模版时照着填）、以及一个**真的走渲染器**的预览。
    //
    // ★ 预览不放在前端拼：那样迟早与真实投递的东西走偏，而"预览里好好的"
    //   恰恰是模版功能最该防的那种错觉。这里用的是渲染器 + 同一份示例值
    //   （`SAMPLE_FIRST_SENTENCE_INPUTS`，文档里逐字贴的也是它）。
    if (req.method === 'GET' && path === '/api/first-sentence/templates') {
      const current = await readWorkspaceSettings(store, workspaceId)
      sendJson(res, 200, {
        defaults: DEFAULT_TEMPLATES,
        variables: TEMPLATE_VARIABLES,
        // ★ 当前生效的那两份（空 = 平台默认）。它是**全局配置**，
        //   与任何 agent 无关——所以这里不按 agent 分。
        current,
      })
      return
    }

    // ── 改全局的第一句话模版（D32）──
    //
    // ★ 它挂在 workspace 上，**一次设定对所有 agent 生效**。校验与预览、与
    //   写入口过的是同一道关（`parseTemplateField` → `validateTemplate`）。
    if (req.method === 'PUT' && path === '/api/first-sentence/templates') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const workspace = await store.getWorkspace(workspaceId)
      if (!workspace) {
        sendJson(res, 404, { error: `workspace 不存在：${workspaceId}` })
        return
      }
      const patch: Partial<Workspace> = {}
      for (const key of ['executeTemplate', 'reviewTemplate'] as const) {
        const parsed = parseTemplateField(key, body[key])
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error })
          return
        }
        // undefined = 这次没传（别动它）；空串 = 回到平台默认
        if (parsed.value !== undefined) patch[key] = parsed.value
      }
      if (Object.keys(patch).length > 0) {
        await store.insertWorkspace({ ...workspace, ...patch, updatedAt: Date.now() })
      }
      sendJson(res, 200, await readWorkspaceSettings(store, workspaceId))
      return
    }

    if (req.method === 'POST' && path === '/api/first-sentence/preview') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const kindRaw = body['kind']
      if (kindRaw !== 'execute' && kindRaw !== 'review') {
        sendJson(res, 400, { error: 'kind 必须是 execute 或 review' })
        return
      }
      const kind: FirstSentenceKind = kindRaw
      const raw = body['template']
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        sendJson(res, 400, { error: 'template 必须是字符串（留空 = 用平台默认模版）' })
        return
      }
      const text = typeof raw === 'string' ? raw.trim() : ''
      // 与保存时同一道关：预览里能过，保存就能过（反之也一样）
      if (text !== '') {
        const check = validateTemplate(kind, text)
        if (!check.ok) {
          sendJson(res, 400, { error: check.error })
          return
        }
      }
      const sample = SAMPLE_FIRST_SENTENCE_INPUTS[kind]
      sendJson(res, 200, {
        text: renderFirstSentence({ ...sample, template: text === '' ? null : text } as never),
      })
      return
    }
    // ── 新建 / 更新 agent ──
    //
    // ══════════════════════════════════════════════════════════════════
    // 这里需要校验，而**不是**"缺什么给个默认值"
    // ══════════════════════════════════════════════════════════════════
    //
    // 原来每个字段都 `?? 默认值`。对 `instructions` 这类"空着也行"的字段
    // 没问题，但对 `name` 不行：它会造出一个叫"新 agent"的家伙，而使用者
    // 明明填了名字——只是字段名写错了。**静默兜底会把一个拼写错误变成一条
    // 脏数据**，而且看起来像成功了。
    //
    // 另外 `skillIds` 与 `kindPatterns` 必须校验**元素类型**：它们是数组，
    // 但客户端完全可能传 `[""]` 或 `[123]`，那会让后续的技能求解与 kind 路由
    // 在很远的地方以莫名其妙的方式失败。
    if (req.method === 'POST' && path === '/api/agents') {
      const body = (await readJsonBody(req)) as Record<string, unknown>

      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (name === '') {
        sendJson(res, 400, { error: 'agent 需要 name（非空字符串）' })
        return
      }
      if (name.length > 100) {
        sendJson(res, 400, { error: 'name 太长了（上限 100 字符）' })
        return
      }

      const stringArray = (key: string): string[] | { error: string } => {
        const raw = body[key]
        if (raw === undefined || raw === null) return []
        if (!Array.isArray(raw)) return { error: `${key} 必须是数组` }
        const bad = raw.find((v) => typeof v !== 'string' || v.trim() === '')
        if (bad !== undefined) {
          return { error: `${key} 里每一项都必须是非空字符串（收到 ${JSON.stringify(bad)}）` }
        }
        return (raw as string[]).map((v) => v.trim())
      }

      const skillIds = stringArray('skillIds')
      if (!Array.isArray(skillIds)) {
        sendJson(res, 400, { error: skillIds.error })
        return
      }
      // 挂载的 skill 必须真的存在——写了不存在的 id 会让审核在运行时
      // 才失败，而那时错误信息指向的是"没有 skill"，不是"你填错了 id"
      const existing = await store.listSkills(workspaceId)
      const knownSkills = new Set(existing.map((s) => s.id as string))
      const unknownSkill = skillIds.find((id) => !knownSkills.has(id))
      if (unknownSkill !== undefined) {
        sendJson(res, 400, {
          error: `skill 不存在：${unknownSkill}。可用的：${
            existing.map((s) => s.slug).join(', ') || '（还没有 skill）'
          }`,
        })
        return
      }

      const roleCheck = await validateRoleAndReviewer(store, {
        role: body['role'],
        reviewerAgentId: body['reviewerAgentId'],
        selfId: null,
        workspaceId,
      })
      if (!roleCheck.ok) {
        sendJson(res, 400, { error: roleCheck.error })
        return
      }

      const runtimeCheck = await resolveRuntimeKey(body['runtimeKey'])
      if (!runtimeCheck.ok) {
        sendJson(res, 400, { error: runtimeCheck.error })
        return
      }

      // 自定义环境变量。原来这里写死 `env: {}`，而 PATCH 的白名单里也没有它
      // ⇒ 这个字段**既写不进也读不到**，是纯装饰。现在两端都通了，
      // 执行器也会把它传给 CLI（见 executor）。
      const envCheck = parseEnvMap(body['env'])
      if (!envCheck.ok) {
        sendJson(res, 400, { error: envCheck.error })
        return
      }


      const now = Date.now()
      const agent: Agent = {
        id: ulid() as Agent['id'],
        workspaceId,
        name,
        instructions: typeof body['instructions'] === 'string' ? body['instructions'] : '',
        model: typeof body['model'] === 'string' && body['model'] !== '' ? body['model'] : null,
        // D28：runtime 可由使用者选（它现在真的会被消费，见 executor）
        runtimeKey: runtimeCheck.runtimeKey,
        workDir:
          typeof body['workDir'] === 'string' && body['workDir'].trim() !== ''
            ? body['workDir'].trim()
            : null,
        skillIds: skillIds as Agent['skillIds'],
        toolIds: [],
        env: envCheck.value,
        role: roleCheck.role,
        reviewerAgentId: roleCheck.reviewerAgentId,
        createdAt: now,
        updatedAt: now,
      }
      await store.insertAgent(agent)
      sendJson(res, 201, agent)
      return
    }

    // ── 改 agent（FR-AGENT-19：可点开看细节并编辑）──
    //
    // 用 PATCH 语义：**只改传了的字段**。整体替换会让"只想改个名字"的请求
    // 顺手把没传的字段清空——那是个很容易踩且很难发现的坑（保存之后
    // 发现指令没了）。
    const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(path)
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]!) as Agent['id']

      if (req.method === 'GET') {
        const agent = await store.getAgent(agentId)
        if (!agent) {
          sendJson(res, 404, { error: `agent 不存在：${agentId}` })
          return
        }
        sendJson(res, 200, agent)
        return
      }

      if (req.method === 'PATCH' || req.method === 'PUT') {
        const current = await store.getAgent(agentId)
        if (!current) {
          sendJson(res, 404, { error: `agent 不存在：${agentId}` })
          return
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>

        // 只认识这些字段——未知字段**明确拒绝**而不是静默忽略：
        // 拼错 `instructions` 为 `instruction` 时，静默忽略会让人以为保存成功了
        const allowed = new Set([
          'name',
          'instructions',
          'model',
          'workDir',
          'skillIds',
          'role',
          'reviewerAgentId',
          'runtimeKey',
          // FR-AGENT-06：自定义环境变量。它原来不在白名单里 —— 于是"支持为
          // agent 配置环境变量"只存在于协议与实体里，任何入口都改不动它。
          'env',
        ])
        const unknown = Object.keys(body).filter((k) => !allowed.has(k))
        if (unknown.length > 0) {
          sendJson(res, 400, {
            error: `不认识的字段：${unknown.join(', ')}。可改的有：${[...allowed].join(', ')}`,
          })
          return
        }

        const patch: Partial<Agent> = {}

        if (body['name'] !== undefined) {
          const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
          if (name === '') {
            sendJson(res, 400, { error: 'name 不能为空' })
            return
          }
          patch.name = name
        }
        if (body['instructions'] !== undefined) {
          if (typeof body['instructions'] !== 'string') {
            sendJson(res, 400, { error: 'instructions 必须是字符串' })
            return
          }
          patch.instructions = body['instructions']
        }

        const stringArray = (key: string): string[] | { error: string } => {
          const raw = body[key]
          if (!Array.isArray(raw)) return { error: `${key} 必须是数组` }
          const bad = raw.find((v) => typeof v !== 'string' || v.trim() === '')
          if (bad !== undefined) {
            return { error: `${key} 里每一项都必须是非空字符串（收到 ${JSON.stringify(bad)}）` }
          }
          return (raw as string[]).map((v) => v.trim())
        }

        if (body['skillIds'] !== undefined) {
          const ids = stringArray('skillIds')
          if (!Array.isArray(ids)) {
            sendJson(res, 400, { error: ids.error })
            return
          }
          // 与新建时同样校验：挂不存在的 skill 会在**运行时**才报"没有 skill"，
          // 而不是"你填错了 id"
          const skills = await store.listSkills(current.workspaceId)
          const known = new Set(skills.map((s) => s.id as string))
          const unknownSkill = ids.find((id) => !known.has(id))
          if (unknownSkill !== undefined) {
            sendJson(res, 400, {
              error: `skill 不存在：${unknownSkill}。可用的：${
                skills.map((s) => s.slug).join(', ') || '（还没有 skill）'
              }`,
            })
            return
          }
          patch.skillIds = ids as Agent['skillIds']
        }

        // 角色与"由谁审我"必须**一起**校验：把 role 从 reviewer 改成 executor
        // 时，原来那条 reviewerAgentId 的合法性也要重新过一遍。
        if (body['role'] !== undefined || body['reviewerAgentId'] !== undefined) {
          const roleCheck = await validateRoleAndReviewer(store, {
            role: body['role'] ?? current.role,
            reviewerAgentId:
              body['reviewerAgentId'] !== undefined ? body['reviewerAgentId'] : current.reviewerAgentId,
            selfId: current.id as string,
            workspaceId: current.workspaceId,
          })
          if (!roleCheck.ok) {
            sendJson(res, 400, { error: roleCheck.error })
            return
          }
          patch.role = roleCheck.role
          patch.reviewerAgentId = roleCheck.reviewerAgentId
        }

        if (body['runtimeKey'] !== undefined) {
          const runtimeCheck = await resolveRuntimeKey(body['runtimeKey'])
          if (!runtimeCheck.ok) {
            sendJson(res, 400, { error: runtimeCheck.error })
            return
          }
          patch.runtimeKey = runtimeCheck.runtimeKey
        }

        if (body['workDir'] !== undefined) {
          if (body['workDir'] !== null && typeof body['workDir'] !== 'string') {
            sendJson(res, 400, { error: 'workDir 必须是字符串或 null' })
            return
          }
          const wd = typeof body['workDir'] === 'string' ? body['workDir'].trim() : ''
          patch.workDir = wd === '' ? null : wd
        }

        if (body['model'] !== undefined) {
          const m = typeof body['model'] === 'string' ? body['model'].trim() : ''
          patch.model = m === '' ? null : m
        }

        if (body['env'] !== undefined) {
          const envCheck = parseEnvMap(body['env'])
          if (!envCheck.ok) {
            sendJson(res, 400, { error: envCheck.error })
            return
          }
          patch.env = envCheck.value
        }


        const updated: Agent = { ...current, ...patch, updatedAt: Date.now() }
        await store.insertAgent(updated)
        sendJson(res, 200, updated)
        return
      }
    }

    if (req.method === 'GET' && path === '/api/issues') {
      const page = await store.listIssues({ workspaceId, limit: 200 })
      sendJson(res, 200, page)
      return
    }
    if (req.method === 'POST' && path === '/api/issues') {
      const body = (await readJsonBody(req)) as Partial<Issue>
      const now = Date.now()
      const issue: Issue = {
        id: (body.id ?? (ulid() as Issue['id'])) as Issue['id'],
        workspaceId,
        title: body.title ?? '未命名',
        description: body.description ?? '',
        status: body.status ?? 'todo',
        priority: body.priority ?? 'none',
        assignee: body.assignee ?? null,
        labels: body.labels ?? [],
        createdAt: now,
        updatedAt: now,
      }
      await store.insertIssue(issue)
      sendJson(res, 201, issue)
      return
    }

    // ── 通知中心（FR-ISSUE-07/08）──
    if (req.method === 'GET' && path === '/api/inbox') {
      const unreadOnly = url.searchParams.get('all') !== '1'
      sendJson(res, 200, {
        items: await store.listInboxItems({ workspaceId, unreadOnly, limit: 100 }),
      })
      return
    }
    const inboxRead = /^\/api\/inbox\/([^/]+)\/read$/.exec(path)
    if (req.method === 'POST' && inboxRead) {
      const ok = await store.markInboxItemRead(decodeURIComponent(inboxRead[1]!))
      sendJson(res, ok ? 200 : 404, { ok })
      return
    }

    // ── 成本（M4）──
    //
    // 只读。刻意**不**做成一个"成本报表"页面元素，而是一个能被别处消费的
    // 数据接口——MCP 的 cost_report 与将来的导出都从这里取。
    if (req.method === 'GET' && path === '/api/costs') {
      const page = await store.listRuns({ workspaceId, limit: 10_000 })
      sendJson(
        res,
        200,
        aggregateCost(
          page.items.map((r) => ({
            agentId: r.agentId as string,
            kind: r.kind,
            usage: r.usage,
          })),
        ),
      )
      return
    }

    // ── 审计导出（M4）──
    //
    // `runId` 可选：给了就只导这一条 run 的审计链，不给就导整个工作区。
    // 导出物自带校验和，且把"可追溯但不可复现"这条限制写进文件本身——
    // 因为它会被带出本机，看到它的人未必读过这份设计文档。
    if (req.method === 'GET' && path === '/api/audits/export') {
      const url2 = new URL(req.url ?? '/', 'http://localhost')
      const onlyRun = url2.searchParams.get('runId')
      const doc = await exportAudit(store, {
        workspaceId,
        ...(onlyRun ? { runIds: [onlyRun] } : {}),
      })
      // 下载语义而不是内联渲染：这是一份要被存下来的文件。
      const payload = JSON.stringify(doc, null, 2)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="alpha-helper-audit-${Date.now()}.json"`,
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
      return
    }

    // ── 技能（审核模板与自建）──
    if (req.method === 'GET' && path === '/api/skills') {
      sendJson(res, 200, { skills: await store.listSkills(workspaceId) })
      return
    }
    // ── 安装 skill（FR-AGENT-09/10/11）──
    //
    // ══════════════════════════════════════════════════════════════════
    // 这里此前是一个"能写进去就行"的实现，有两个真问题
    // ══════════════════════════════════════════════════════════════════
    //
    // **① 它把 `source` 写死成 `'local'`。** 而从远端目录下载来的 skill
    //    会被记成"使用者自有的"——于是"本地内容不因远端变化而改变"
    //    （FR-AGENT-10）这条保证在数据上就无从判断，因为根本分不清谁是谁。
    //
    // **② 它没有任何同名处理。** `insertSkill` 是按 **id** 写入的，所以
    //    两个 slug 相同、id 不同的 skill 会**同时存在**——同名冲突不是
    //    "被覆盖"，而是"悄悄多出一条"，而 `loadAgentSkills` 只会取到其中
    //    一条。哪种结果都不对，且都没有提示。
    //
    // 现在的规则（确定性 + 绝不静默）：
    //
    //   - 同名一律**拒绝写入**，并在 `skipped` 里说清与谁冲突、对方是哪来的；
    //   - 想换掉必须显式传 `overwrite: true`——那是一个明确的动作，
    //     而不是"下载顺手覆盖了你的东西"；
    //   - 与 FR-REG-03 一致：**不做版本管理、不检查更新、不比较新旧**，
    //     所以远端 skill 之间也不存在"升级"。
    if (req.method === 'POST' && path === '/api/skills') {
      const raw = (await readJsonBody(req)) as {
        skills?: unknown
        batchId?: unknown
        overwrite?: unknown
      }
      if (!Array.isArray(raw.skills)) {
        sendJson(res, 400, { error: '需要 skills（数组）' })
        return
      }
      const outcome = await installSkillPayloads({
        store,
        workspaceId,
        payloads: raw.skills.map((entry) => entry as Partial<Skill> & { slug?: string }),
        overwrite: raw.overwrite === true,
        now: Date.now(),
      })
      sendJson(res, 201, outcome)
      return
    }

    // ── 从「路径 / GitHub 链接」安装 skill（FR-AGENT-09/11）──
    //
    // ══════════════════════════════════════════════════════════════════
    // 为什么这个接口由 daemon 自己去取内容
    // ══════════════════════════════════════════════════════════════════
    //
    // 别的接口都遵守"daemon 不发对外请求、页面是唯一通道"（D19/D20）。
    // 这条路是**刻意的例外**，理由有两条：
    //
    //   1. **本地目录路径只有 daemon 读得到。** 使用者在自己机器上开发技能，
    //      要装的就是 `/Users/me/dev/my-skill`。页面读不了磁盘；
    //   2. "下载到本地"这件事本来就发生在 daemon 这台机器上。
    //
    // 例外被严格限制在 `skill-source.ts` 里：只允许 GitHub 的三个主机、
    // 只允许 https、每跳都校验主机、限大小/文件数/超时。它**不涉及
    // alpha-helper 的远端服务**，D20 那条规则仍然原样成立。
    if (req.method === 'POST' && path === '/api/skills/install') {
      const raw = (await readJsonBody(req)) as {
        source?: unknown
        slug?: unknown
        overwrite?: unknown
        allowedActions?: unknown
      }

      // ★ 来源要逐字段校验，而不是信任类型声明——这里是运行时的任意 JSON
      const source = parseInstallSource(raw.source)
      if (!source.ok) {
        sendJson(res, 400, { error: source.error })
        return
      }

      let slugOverride: string | null = null
      if (raw.slug !== undefined && raw.slug !== null && raw.slug !== '') {
        if (typeof raw.slug !== 'string') {
          sendJson(res, 400, { error: 'slug 必须是字符串' })
          return
        }
        slugOverride = raw.slug.trim()
      }

      // ★ 整段（解析 + 参数校验 + 入库）都归同一个 catch 管。
      //
      //   一开始只想给 `resolveSkillSource` 挂 catch，结果"动作表里有不认识的动作"
      //   是**参数不对**（该 400），却因为抛在 catch 外面而以 500 + 内部错误原文
      //   返回——那会让使用者以为服务坏了，而其实是他自己填错了。
      let resolved: ResolvedSkillSource
      let outcome: Awaited<ReturnType<typeof installSkillPayloads>>
      try {
        resolved = await resolveSkillSource(
          source.spec,
          { slug: slugOverride },
          {
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            githubToken: options.githubToken ?? process.env['ALPHA_HELPER_GITHUB_TOKEN'] ?? null,
          },
        )

        outcome = await installSkillPayloads({
          store,
          workspaceId,
          payloads: [
            {
              slug: resolved.slug,
              name: resolved.slug,
              body: resolved.body,
              files: resolved.files,
              source: source.spec.kind === 'payload' ? 'remote' : 'local',
              sourceRef: resolved.sourceRef,
              version: source.spec.kind === 'payload' ? source.spec.version : null,
              ...(Array.isArray(raw.allowedActions)
                ? { allowedActions: parseAllowedActions(raw.allowedActions) }
                : {}),
            } as Partial<Skill> & { slug: string },
          ],
          overwrite: raw.overwrite === true,
          now: Date.now(),
        })
      } catch (err) {
        if (err instanceof SkillSourceError) {
          // 400 而不是 500：这是"输入不对"，不是"服务坏了"。
          // code 一并返回，界面可以据此做不同的提示（比如引导去用本地路径）。
          sendJson(res, 400, {
            error: err.message,
            code: err.code,
            detail: err.detail,
            source: describeSource(source.spec),
          })
          return
        }
        throw err
      }

      sendJson(res, outcome.installed.length > 0 ? 201 : 200, {
        ...outcome,
        // 来源解析的**过程与结果**要如实回报：使用者得知道
        // ① 到底从哪儿读的 ② SKILL.md 在哪 ③ 还有什么没装进来
        source: describeSource(source.spec),
        resolvedFrom: resolved.resolvedFrom,
        sourceRef: resolved.sourceRef,
        included: resolved.included,
        ignored: resolved.ignored,
      })
      return
    }

    // ── 第三方报告摄取（S2 的入口）──
    if (req.method === 'POST' && path === '/api/reports') {
      const body = (await readJsonBody(req)) as { source?: string; items?: unknown }
      if (typeof body.source !== 'string' || !Array.isArray(body.items)) {
        sendJson(res, 400, { error: '需要 source（字符串）与 items（数组）' })
        return
      }

      // ★ **逐条校验**，而不是信任类型声明。
      //
      //   类型是编译期的东西，而这里是运行时的任意 JSON。此前只检查了
      //   `Array.isArray(items)`，于是省略 `body` 的条目会让 `undefined`
      //   一路走到 `createHash().update()`，以 HTTP 500 + 内部错误原文返回。
      //   按 MCP 那边的工具 schema（body 可选）写的调用**必然**踩到它。
      //
      //   校验要报到"第几条、哪个字段"——只说"输入不合法"会让调用方
      //   无从下手，尤其是批量投递时。
      const items: ThirdPartyItem[] = []
      for (const [index, raw] of body.items.entries()) {
        const parsed = ThirdPartyItemSchema.safeParse(raw)
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`)
            .join('；')
          sendJson(res, 400, {
            error: `items[${index}] 不合法：${detail}`,
            index,
            issues: parsed.error.issues.map((i) => ({
              path: i.path.map(String),
              message: i.message,
            })),
          })
          return
        }
        items.push(parsed.data)
      }
      if (items.length === 0) {
        sendJson(res, 400, { error: 'items 不能为空数组' })
        return
      }

      const summary = await ingestor.ingest(workspaceId, body.source, items)
      const runIds: RunId[] = []
      let unmatched = 0

      for (const routed of summary.routed) {
        if (routed.unmatched) {
          // ★ 不得静默丢弃：存下 report 并通知（FR-AGENT-22）
          unmatched += 1
          await store.appendInboxItem(unmatchedReportNotice(workspaceId, routed.report, Date.now()))
          continue
        }
        for (const reviewer of routed.reviewers) {
          const runId = await createReviewRun(routed.report, reviewer)
          if (runId) runIds.push(runId)
        }
      }

      sendJson(res, 202, {
        total: summary.total,
        created: summary.created,
        deduplicated: summary.deduplicated,
        unmatched,
        runIds,
      })
      return
    }

    // ── 判决与审计 ──
    const verdictsMatch = /^\/api\/runs\/([^/]+)\/verdicts$/.exec(path)
    if (req.method === 'GET' && verdictsMatch) {
      sendJson(res, 200, {
        verdicts: await store.listVerdictsByRun(decodeURIComponent(verdictsMatch[1]!) as RunId),
      })
      return
    }
    const auditsMatch = /^\/api\/runs\/([^/]+)\/audits$/.exec(path)
    if (req.method === 'GET' && auditsMatch) {
      sendJson(res, 200, {
        audits: await store.listAuditsByRun(decodeURIComponent(auditsMatch[1]!) as RunId),
      })
      return
    }

    // ── POST /api/runs ──
    if (req.method === 'POST' && path === '/api/runs') {
      const body = (await readJsonBody(req)) as SubmitRunRequest
      // `workDir` 从 D27 起是**可选**的：缺省由 daemon 按任务自动分配。
      // 这个校验漏改过一次，症状是"页面不填目录就提交不了"——而那正是 D27
      // 要消除的动作。
      if (typeof body?.runId !== 'string' || body.runId === '') {
        sendJson(res, 400, { error: '缺少 runId' })
        return
      }

      // ══════════════════════════════════════════════════════════════════
      // ★ INV-1（reviewer ≠ executor）**在写入之前**强制校验
      // ══════════════════════════════════════════════════════════════════
      //
      // 这条不变量在 `packages/domain/src/review/distinct.ts` 里实现好了，
      // 那个文件的注释还专门写明"校验放在 **run 创建时**（写入之前），而不是
      // 执行时"——**但那个调用点从来没被接上**：`assertReviewerDistinct` 在全仓
      // 只有它自己的测试在引用。
      //
      // 自动串接那条路（执行者指向审核者）因为角色单一而**结构上**安全，
      // 所以这个洞一直没暴露；但 `POST /api/runs` 是公开接口，直接构造一条
      // `kind:'review'` + `subject:{type:'run'}` 并且 agentRef 就是那条执行 run
      // 的 agent，就能拿到一次"自己审自己"。而 INV-1 一旦破了，S1 的整个闭环
      // 就是假的——审核退化成自我确认。
      //
      // 复用 domain 里那个函数而不是在这里重写一遍比较：**不变量只有一份**，
      // 两边各写一遍迟早会分叉（而分叉的表现是"某一条路能绕过校验"）。
      if (body.kind === 'review' && body.subject?.type === 'run') {
        const target = await store.getRun(body.subject.id as RunId)
        if (target) {
          try {
            assertReviewerDistinct(body.agentRef.id as Agent['id'], { type: 'run', run: target })
          } catch (err) {
            sendJson(res, 400, {
              error: err instanceof Error ? err.message : String(err),
              code: 'reviewer_must_differ',
            })
            return
          }
        }
      }
      // ★ 解析 skill（见 SubmitRunRequest.skills 的说明）。
      //
      //   省略 ⇒ 按该 agent 的配置解析；显式给了就用给的。
      //   显式给空数组而 agent 明明配了 skill ⇒ **警告**，因为那几乎一定是
      //   调用方漏了，而它的后果是"用裸模型跑审核"——正常完成、结果不对。
      let skills = body.skills
      if (skills === undefined || skills.length === 0) {
        const agent = await store.getAgent(body.agentRef.id as Agent['id'])
        const configured = agent ? await loadAgentSkills(store, agent) : []
        if (skills !== undefined && configured.length > 0) {
          warn(
            `run ${body.runId} 显式传了空 skills，但 agent ${agent?.name ?? body.agentRef.id} ` +
              `配了 ${configured.length} 个 skill。如果这不是有意的，检查调用方是否漏了 skills。`,
          )
        }
        if (skills === undefined) {
          skills = configured.map((s) => ({
            ref: { id: s.id, slug: s.slug, source: s.source },
            slug: s.slug,
            name: s.name,
            body: s.body,
        // 协议里是 optional（`string | undefined`），实体上是 `string | null`
        ...(s.description ? { description: s.description } : {}),
            allowedActions: s.allowedActions,
            // 支持文件必须一路带下去，否则装上来的脚本/参考文档到不了工作目录
        files: s.files ?? {},
          }))
          if (skills.length > 0) {
            info(`run ${body.runId} 按 agent 配置解析到 ${skills.length} 个 skill`)
          }
        }
      }

      const outcome = await executor.submit({ ...body, skills })
      if (outcome.kind === 'rejected') {
        // 取不到槽位就不返回 202——让页面稍后重试（FR-RUNTIME-04）
        res.setHeader('retry-after', String(Math.ceil(outcome.retryAfterMs / 1000)))
        sendJson(res, 429, outcome)
        return
      }
      sendJson(res, 202, outcome)
      return
    }

    // ── GET /api/runs ──
    if (req.method === 'GET' && path === '/api/runs') {
      const page = await store.listRuns({ workspaceId, limit: 100 })
      const runs = await Promise.all(
        page.items.map(async (run) => ({
          runId: run.id,
          kind: run.kind,
          status: run.status,
          agentId: run.agentId,
          /**
           * ★ `subject` 必须带上——页面靠它把 run 归到具体的任务上。
           *
           * 少了它，任务详情里永远显示"这个任务还没有执行过"，而实时日志
           * 也就永远出不来：不是日志坏了，是**页面根本不知道该显示哪些 run**。
           * 这类"接口少给一个字段"的缺陷不会报错，只会让功能静默地不工作。
           */
          subject: run.subject,
          workDir: run.workDir,
          // ★ 这里曾经返回 `lastSeq: await store.lastRunMessageSeq(run.id)`，
          //   而页面把它当成了 `?since=` 参数——"跳过 N 及之前的一切"，
          //   于是打开已跑完的任务时日志全空。服务端事实 ≠ 客户端游标，
          //   这个数字没有正当用途，所以不再提供（详见协议里的说明）。
          queuedAt: run.queuedAt,
          finishedAt: run.finishedAt,
          failureReason: run.failureReason,
          chainDepth: run.chainDepth,
          /**
           * ★ 审核 run 的**判决结论**要带上——阶段推导需要它。
           *
           *   页面原来只能看到"审核 run 完成了没有"，于是无论判决是
           *   `needs_human` 还是 `pass`，都显示成「已审查」。而
           *   `needs_human` 的意思是**卡在人这儿**：把它显示成"已完成"，
           *   等于把待办说成做完了（使用者的原话：「审查的结论是 needs_human，
           *   被标为已审查，不合理」）。
           *
           *   只给最新的那一份（一次审核一条判决；重试会落在新的 run 上）。
           */
          verdict:
            run.kind === 'review'
              ? await store.listVerdictsByRun(run.id).then((vs) => {
                  const v = vs[vs.length - 1]
                  return v
                    ? {
                        status: v.status,
                        conclusion: v.conclusion,
                        // 结论之外的"为什么"——人要看的就是这一句
                        escalateReason: v.escalateReason,
                      }
                    : null
                })
              : null,
        })),
      )
      sendJson(res, 200, { runs })
      return
    }

    const runMatch =
      /^\/api\/runs\/([^/]+)(?:\/(events|cancel|artifacts|messages|files|file))?$/.exec(path)
    if (runMatch) {
      const runId = runMatch[1] as RunId
      const sub = runMatch[2]

      if (req.method === 'GET' && sub === undefined) {
        const run = await store.getRun(runId)
        if (!run) return sendJson(res, 404, { error: 'run 不存在' })
        sendJson(res, 200, run)
        return
      }

      if (req.method === 'GET' && sub === 'messages') {
        const since = Number(url.searchParams.get('since') ?? '-1')
        sendJson(res, 200, { messages: await store.listRunMessages(runId, since) })
        return
      }

      if (req.method === 'GET' && sub === 'events') {
        await streamEvents(req, res, runId, Number(url.searchParams.get('since') ?? '-1'))
        return
      }

      if (req.method === 'POST' && sub === 'cancel') {
        const ok = await executor.cancel(runId)
        sendJson(res, ok ? 200 : 409, { cancelled: ok })
        return
      }

      // ── 工作目录的文件（任务详情右边那一栏）──
      //
      // 被读的是**使用者工作目录里的文件**，而路径来自查询参数 ⇒ 见
      // workdir-files.ts 里那两道检查（`..`/绝对路径 + 软链），以及为什么
      // 每个响应都要带 sandbox 的 CSP。
      if (req.method === 'GET' && sub === 'files') {
        const run = await store.getRun(runId)
        if (!run) return sendJson(res, 404, { error: 'run 不存在' })
        if (!run.workDir) {
          sendJson(res, 200, { workDir: null, entries: [], truncated: false })
          return
        }
        // ?dir= 列子目录（一次一层）。界面点开一个目录时才请求下一层，
        // 而不是一次把整棵树拉回来 —— 那样一长串嵌套路径会把真正的产出淹掉。
        const dir = url.searchParams.get('dir') ?? ''
        try {
          // ★ "哪些是平台注入的"按**这个 run 用的 runtime** 算。
          //   写死 `.claude/` 的版本对别的 CLI 会把注入物当成 agent 的产出显示。
          const owner = await store.getAgent(run.agentId as never)
          const managed = managedPathsFor(
            getRuntimeDescriptor(owner?.runtimeKey ?? 'claude'),
          )
          sendJson(res, 200, await listWorkDir(run.workDir, dir, managed))
        } catch (err) {
          if (err instanceof UnsafePathError) {
            sendJson(res, 400, { error: err.message })
            return
          }
          throw err
        }
        return
      }

      if (req.method === 'GET' && sub === 'file') {
        const run = await store.getRun(runId)
        if (!run) return sendJson(res, 404, { error: 'run 不存在' })
        if (!run.workDir) return sendJson(res, 404, { error: '这条 run 没有工作目录' })

        const relPath = url.searchParams.get('path') ?? ''
        try {
          const body = await readWorkFile(run.workDir, relPath)
          res.writeHead(200, {
            'content-type': contentTypeFor(relPath),
            'content-length': body.length,
            ...WORK_FILE_HEADERS,
          })
          res.end(body)
        } catch (err) {
          // 路径不合法是**使用者输入问题**（400），不是服务坏了
          if (err instanceof UnsafePathError) {
            sendJson(res, 400, { error: err.message })
            return
          }
          throw err
        }
        return
      }

      if (req.method === 'GET' && sub === 'artifacts') {
        const artifacts = await store.listArtifactsByRun(runId)
        sendJson(res, 200, {
          artifacts: await Promise.all(
            artifacts.map(async (a) => ({
              blobRef: a.blobRef,
              summary: a.summary,
              sizeBytes: (await store.getBlob(a.blobRef))?.length ?? 0,
            })),
          ),
        })
        return
      }
    }

    sendJson(res, 404, { error: `未知路径 ${path}` })
  }

  /**
   * SSE 流。
   *
   * 先用 store 里已落盘的消息补齐（`?since=N`），再挂上实时订阅。
   * 顺序不能反：先订阅再补齐的话，补齐过程中新产生的消息会重复。
   */
  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    runId: RunId,
    since: number,
  ): Promise<void> {
    const run = await store.getRun(runId)
    if (!run) {
      sendJson(res, 404, { error: 'run 不存在' })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const write = (event: unknown): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    // 心跳与清理要先定义：下面的"已结束"分支会提前用到 cleanup
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
    heartbeat.unref?.()
    let unsubscribed = false
    let unsubscribe = (): void => {
      unsubscribed = true
    }

    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)

    // ① 先补齐历史（已落盘的消息是权威）
    const persisted = await store.listRunMessages(runId, since)
    for (const message of replayMessagesSince(persisted, since)) {
      write({ t: 'message', seq: message.seq, message })
    }

    // ══════════════════════════════════════════════════════════════════
    // ② 已经结束的 run：补发一个 terminal 并**立刻结束流**
    // ══════════════════════════════════════════════════════════════════
    //
    // 这是实测出来的一个 bug。原来这里只补齐历史消息就挂上订阅——而
    // **`terminal` 事件从不落库**，它只由 registry 实时发一次。
    //
    // 后果是晚订阅的页面（刷新后、或者连上时 run 已经结束）：
    //
    //   - **永远收不到终态** ⇒ 既不刷新到最终状态，也不关闭连接；
    //   - 那条连接就这么挂着，靠心跳维持。
    //
    // 而 `EventSource` 在任何一次断开后都会**自动重连**。于是 daemon 一重启
    //（或者网络抖一下），页面就重连 → 拿不到终态 → 再断 → 再重连……
    // 日志里就是刷屏的"连接中断，正在重连…"。
    //
    // 修法：晚订阅时**补发**一个 terminal，然后主动 `end()`。
    // 客户端收到终态就会关掉订阅，重连循环自然停下。
    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      write({
        t: 'terminal',
        status: run.status,
        result: null,
        error: run.failureReason
          ? { reason: run.failureReason, message: '这条执行已经结束（终态由运行记录给出）' }
          : null,
      })
      res.end()
      cleanup()
      return
    }

    // ③ 再挂实时订阅
    const fromSeq =
      persisted.length > 0 ? Math.max(since, persisted[persisted.length - 1]!.seq) : since
    unsubscribe = registry.subscribe(runId, (event) => {
      // ══════════════════════════════════════════════════════════════
      // ★ 收到终态：写出去，然后**主动结束这条流**
      // ══════════════════════════════════════════════════════════════
      //
      // 原来这里只把事件写出去就完事，连接一直挂着。客户端确实会自己
      // `close()`，但那只是把问题藏起来了：
      //
      //   - 客户端没关（旧页面、后台标签页、或者将来别的接入方）时，
      //     这条连接、它的心跳定时器、以及 registry 里的订阅**永远不释放**；
      //   - 对使用者来说，日志看着像"还连着"，其实早就跑完了。
      //
      // 终态之后再没有任何消息可发，所以此时 `end()` 是明确的：
      // 流结束 = 这条 run 结束了。客户端据此停掉重连（见 RunLog.svelte）。
      if (event.t === 'terminal') {
        write(event)
        res.end()
        cleanup()
        return
      }
      if (event.seq > fromSeq) write(event)
    })

    // ══════════════════════════════════════════════════════════════════
    // 订阅与请求之间有个 await，使用者可能**在这中间就走了**
    // ══════════════════════════════════════════════════════════════════
    //
    // 上一步 `await store.listRunMessages(...)` 之前 `cleanup` 就已经挂上了。
    // 如果在那之后再挂上真实订阅，而 close 早就发生过了，那么这个订阅
    // 就再也没有人去取消——**一个谁也不认识的订阅者会一直收消息**。
    if (unsubscribed) unsubscribe()
  }

  // ══════════════════════════════════════════════════════════════════
  // 监听失败必须变成**可读的错误**，而不是一个未捕获的 'error' 事件
  // ══════════════════════════════════════════════════════════════════
  //
  // 早先这里是 `listen(port, host, resolve)`——**没有挂 error 处理器**。
  // 端口被占用时 `listen` 会 emit `'error'`，而没人接，于是 Node 直接抛出
  // 未捕获异常、打一串栈、进程退出；同时那个 Promise **永远不会 settle**，
  // 所以 cli.ts 里那段写得好好的"端口被占用，可用 --port 指定别的端口"
  // 提示**一行都执行不到**。
  //
  // 这正是"只有真的跑一次才会发现"的那类缺陷：类型检查过得去，
  // 单测（都用 port: 0）也照常通过。
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.port, '127.0.0.1')
    })
  } catch (err) {
    // 起不来就得把已经占下的资源还回去——主要是数据目录的**单进程锁**。
    // 不还的话，使用者改个端口重启会撞上"数据已被另一个进程占用"，
    // 而那个"另一个进程"其实正是刚刚失败的自己。错误信息会把人带偏。
    await executor.shutdown(0).catch(() => undefined)
    await store.close().catch(() => undefined)

    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      throw new Error(
        `端口 ${options.port} 已被占用。alpha-helper **不自动换端口**——` +
          `随机端口意味着"重启后地址变了"，而地址会被写进书签与配置里，` +
          `那种漂移比端口冲突难查得多。请先停止占用该端口的进程，` +
          `或用 --port 显式指定另一个端口。`,
      )
    }
    if (code === 'EACCES') {
      throw new Error(`没有权限绑定端口 ${options.port}（1024 以下的端口通常需要更高权限）`)
    }
    throw err
  }

  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    port: address.port,
    store,
    workRoot,
    async close() {
      // 先断开所有连接：`server.close()` 会等现有连接自然结束，而页面的
      // keep-alive 与 SSE 长连接可能挂很久——那会让"停止 daemon"看起来卡住。
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))

      // ★ 关停执行器**必须**在关 store 之前，而且必须等它结束。
      //   顺序反过来的话，run 会在 store 已关之后继续写——写不进去，
      //   或者更糟：进程退出时留下一个"看起来在执行"的 run。
      await executor.shutdown()

      await store.close()
    },
  }
}

/**
 * Host 校验（FR-BRIDGE-10）。
 *
 * 只接受回环 Host。**不校验就等着被 DNS rebinding 打**：攻击者让自己的域名
 * 解析到 127.0.0.1，用户浏览器就会把请求发到本机 daemon——而 Host 头带的
 * 是攻击者的域名，所以我们能认出来。
 */
export function isAllowedHost(host: string, address: AddressInfo | null): boolean {
  const port = address?.port
  const allowed = ['127.0.0.1', 'localhost', '[::1]', '::1']
  const bare = host.replace(/:\d+$/, '')
  if (!allowed.includes(bare)) return false
  // 端口也必须对得上（避免同机别的服务冒充）
  if (port === undefined) return true
  const hostPort = host.match(/:(\d+)$/)?.[1]
  return hostPort === undefined || Number(hostPort) === port
}

/** 首次启动时准备一个可用的 workspace 与默认 agent。 */
/**
 * 校验角色与"由谁审我"的配对（D28）。
 *
 * 三条规则，每条都对应一种"配置上看起来没问题、行为上很别扭"的情形：
 *
 * 1. **角色必须是两者之一**。缺省给 `executor`——新建一个 agent 时，
 *    "它能干活"是最合理的默认；把它默认成审核者会让它悄悄进入审核小组。
 * 2. **审核者不能是自己**。那违反 INV-1（reviewer ≠ executor），
 *    而且它表达的意思等于"我自己审我自己"。
 * 3. **executor 的 reviewerAgentId 必须指向一个真实存在的 `reviewer`**。
 *    指向一个 executor 是最容易犯的错：名字看起来对，但那个 agent 没有
 *    审核标准可用，run 起不来或审出没有依据的结论。
 *
 * ⚠️ `robustness`：agent 可能被改名，也可能还不存在（新建时先选审核者、
 *    审核者后建）——所以引用**按 id**，而且找不到时只跳过自动审核并警告，
 *    不把它当成致命错误。删 agent 的功能还没有，所以悬空引用只会来自
 *    手工改数据。
 */
async function validateRoleAndReviewer(
  store: Store,
  input: {
    role: unknown
    reviewerAgentId: unknown
    selfId: string | null
    workspaceId: WorkspaceId
  },
): Promise<
  | { ok: true; role: AgentRole; reviewerAgentId: Agent['reviewerAgentId'] }
  | { ok: false; error: string }
> {
  const role = input.role === undefined ? 'executor' : input.role
  if (role !== 'executor' && role !== 'reviewer') {
    return { ok: false, error: `role 必须是 'executor' 或 'reviewer'（收到 ${JSON.stringify(input.role)}）` }
  }

  const raw = input.reviewerAgentId
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, role, reviewerAgentId: null }
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'reviewerAgentId 必须是 agent 的 id 或 null' }
  }

  // 只有 executor 才谈得上"由谁审我"
  if (role === 'reviewer') {
    return {
      ok: false,
      error:
        'reviewer 角色的 agent 不该配 reviewerAgentId——它是**审别人的那个**，' +
        '不是被审的那个。如果你想让两个审核者互相复核，那需要另一套设计，现在没有。',
    }
  }

  if (input.selfId !== null && raw === input.selfId) {
    return { ok: false, error: '不能让一个 agent 审自己（INV-1：审核者必须不同于执行者）' }
  }

  // 指向的对象**必须真实存在且是审核角色**。
  //
  //   指向一个 executor 是最容易犯的错：名字看起来对，但那个 agent 没有
  //   审核标准可用，run 起不来（或审出没有依据的结论）。
  const target = await store.getAgent(raw as Agent['id'])
  if (!target) {
    return { ok: false, error: `指定的审核者不存在：${raw}` }
  }
  if (target.role !== 'reviewer') {
    return {
      ok: false,
      error:
        `${target.name} 不是审核角色（它是 executor）。审核者必须是 role: 'reviewer' 的 agent —— ` +
        `否则它没有审核标准可用，run 起不来或审出没有依据的结论。`,
    }
  }

  return { ok: true, role, reviewerAgentId: target.id }
}

/** 校验 runtimeKey：必须是**装了**的那个，否则 run 起不来且错误出现在很远的地方。 */
async function resolveRuntimeKey(
  raw: unknown,
): Promise<{ ok: true; runtimeKey: string } | { ok: false; error: string }> {
  const adapters = knownRuntimeAdapters()
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, runtimeKey: 'claude' }
  }
  if (typeof raw !== 'string' || !(raw in adapters)) {
    return {
      ok: false,
      error: `未知的 runtime：${String(raw)}。可用的：${Object.keys(adapters).join(', ')}`,
    }
  }
  return { ok: true, runtimeKey: raw }
}

async function bootstrap(store: Store, info: (m: string) => void): Promise<Workspace['id']> {
  const existing = await store.listWorkspaceIds()
  const first = existing[0]
  if (first) return first

  const now = Date.now()
  const workspace: Workspace = {
    id: ulid() as Workspace['id'],
    name: '默认工作区',
    // 第一句话模版（D32）：空 = 平台默认。首启不替使用者写模版。
    executeTemplate: '',
    reviewTemplate: '',
    // 默认智能体（D36）：首启那一对 agent 就在这里建，顺手把执行者设为默认——
    // "建完就派"的那个流程于是有确定的行为，而不是依赖"列表里第一个是谁"。
    defaultAgentId: null,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertWorkspace(workspace)

  const device = await store.getDevice()
  if (!device) {
    const { hostname } = await import('node:os')
    await store.upsertDevice({
      id: ulid() as import('@alpha-helper/protocol').DeviceId,
      name: hostname(),
      createdAt: now,
      lastSeenAt: now,
    })
  }

  // ── 内置审核模板（FR-AGENT-08/09）──
  // S2 在没有任何模板时是**空的**：使用者得先从零写一个 skill 才能用上。
  // 所以内置一个最小可用的通用审核标准，作为兜底审核者的默认凭据。
  const template: Skill = {
    ...BUILTIN_REVIEW_SKILL,
    id: ulid() as Skill['id'],
    workspaceId: workspace.id,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertSkill(template)

  // ══════════════════════════════════════════════════════════════════
  // 播种**一对** agent：一个执行的、一个审的（D28）
  // ══════════════════════════════════════════════════════════════════
  //
  // 为什么不只播种一个执行者：D28 去掉了"兜底审核者"这个概念，报告的路由
  // 变成"`role: 'reviewer'` 的 agent 都审"。如果首启只有一个执行者，那么
  // **一个审核者都没有** —— 所有报告都会落进 unmatched（存下来 + 发通知），
  // 一条也不会被审。
  //
  // 那是"按需求实现了"但**开箱即坏**：这个产品的核心闭环就是
  // 「任务 → 执行 → 审核 → 判决 → 动作」，首启没有审核者等于闭环断了一半，
  // 而使用者需要先读文档才知道要自己建一个。
  //
  // 所以播种一对，并且**把执行者指向审核者**。这个默认是可改的：把
  // reviewerAgentId 清掉就是不自动审，新建自己的审核者再指过去也行。

  const reviewer: Agent = {
    id: ulid() as Agent['id'],
    workspaceId: workspace.id,
    name: '审核员',
    instructions:
      '你是一个严格的审核者。按挂载的审核标准逐条对照，' +
      '判断依据不足时给出 needs_human 并说清缺什么，不要替对方补上你认为对的要求。',
    model: null,
    runtimeKey: 'claude',
    workDir: null,
    // 审核标准就在 skill 里——审核者**必须**挂 skill，否则它审不出有依据的结论
    skillIds: [template.id],
    toolIds: [],
    env: {},
    role: 'reviewer',
    reviewerAgentId: null,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertAgent(reviewer)

  const agent: Agent = {
    id: ulid() as Agent['id'],
    workspaceId: workspace.id,
    name: '助手',
    instructions: '你是一个严谨的协作者。先理解任务，再动手；报告要写清楚结论与不确定的地方。',
    model: null,
    runtimeKey: 'claude',
    workDir: null,
    // 执行者不需要审核 skill——它的 skill 是"干活时参考什么"，
    // 而审核标准是审核者的事。两者混在一起会让执行者按审核标准去改自己的产出。
    skillIds: [],
    toolIds: [],
    env: {},
    role: 'executor',
    // ★ 指向刚播种的审核者：这样首启就是一条**通的闭环**
    reviewerAgentId: reviewer.id,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertAgent(agent)

  // ★ 首启就把刚播下的执行者设为「新建任务的默认智能体」（D36）：使用者建完
  //   第一件事就是"新建任务"，而那一步不该让他先想"交给谁"。这个默认随时可改
  //   （智能体卡片上的按钮）。
  await store.insertWorkspace({ ...workspace, defaultAgentId: agent.id, updatedAt: Date.now() })

  info(
    `已初始化工作区、审核模板（${template.slug}）与两个 agent：` +
      `${reviewer.name}（审核）、${agent.name}（执行 → 由 ${reviewer.name} 审）`,
  )
  return workspace.id
}

/** 从 subject 里取 issueId（不是 issue 时为 null）。 */
function issueIdOfSubject(run: Run): Issue['id'] | null {
  return run.subject.type === 'issue' ? (run.subject.id as Issue['id']) : null
}

/** 取一个 agent 挂载的 skill 内容（按 agent 求解的子集，D22）。 */
async function loadAgentSkills(store: Store, agent: Agent): Promise<Skill[]> {
  const all = await store.listSkills(agent.workspaceId)
  const byId = new Map(all.map((s) => [s.id as string, s]))
  return agent.skillIds.flatMap((id) => {
    const skill = byId.get(id as string)
    return skill ? [skill] : []
  })
}

export { parseVerdict }
export type { RunMessage }
