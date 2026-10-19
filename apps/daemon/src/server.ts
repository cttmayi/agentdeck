import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import {
  ALL_KINDS,
  buildBlocks,
  checkVersionSupport,
  DEFAULT_TEMPLATES,
  getRuntimeDescriptor,
  migrateTemplate,
  renderFirstSentence,
  SAMPLE_FIRST_SENTENCE_INPUTS,
  shouldRefuseToRun,
  TEMPLATE_BLOCKS,
  TEMPLATE_VARIABLES,
  validateTemplate,
  extractSkillMeta,
  type AgentBackend,
  type BlockTemplates,
  type FirstSentenceKind,
  type SandboxMode,
  type TemplateBlock,
} from '@agentdeck/agent-core'
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  aggregateCost,
  assertReviewerDistinct,
  checkGroupShape,
  exportAudit,
  toolActionDefinitions,
  validateFixedParams,
  type Store,
} from '@agentdeck/domain'
import {
  LOCAL_DIR_SOURCE_PREFIX,
  localSkillDirCandidates,
  scanSkillDir,
  sourceDirOf,
  type LocalSkillDirCandidate,
} from './local-skill-dirs.ts'
import {
  LOCAL_PROTOCOL_VERSION,
  Capability,
  parseVerdict,
  toolSlugOfAction,
  ulid,
  type ActionRefType,
  type Agent,
  type InboxItem,
  type Issue,
  type IssueId,
  type BlobRef,
  type Report,
  type Run,
  type RunId,
  type RunMessage,
  type Conversation,
  type ConversationId,
  type Skill,
  type SkillId,
  type Tool,
  type ReviewStandard,
  type VerdictRecord,
  type SubmitRunRequest,
  SubmitHumanVerdictRequest,
  type AgentRole,
  type Workspace,
  type WorkspaceId,
  type AgentGroup,
} from '@agentdeck/protocol'
import { FileStore } from '@agentdeck/store-file'
import { resolveReviewStandard, reviewerIdentity } from './review-standard.ts'
import { runAgentLegacyCleanupOnce } from './agent-legacy-cleanup.ts'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@agentdeck/i18n'
import { NOT_BUILT_HINT, isWebBuilt, loadStatic, webBuildId } from '@agentdeck/web'
import { ActionRunner } from './actions.ts'
import { createScriptExecutor } from './script-executor.ts'
import { submitChatTurn, titleFromText } from './chat.ts'
import {
  buildDraftPrompt,
  buildMaterial,
  crystallizeTargets,
  listCrystallizeDrafts,
  listCrystallizeSources,
  resolveSourceRun,
} from './crystallize.ts'
import { commitMine, ensureMineRepo, probeGit } from './run-hooks/skill-mine.ts'
import { RunExecutor } from './executor.ts'
import {
  ReportIngestor,
  ThirdPartyItemSchema,
  unmatchedReportNotice,
  type ThirdPartyItem,
} from './ingest.ts'
import { reconcileInterruptedRuns } from './reconcile.ts'
import { checkEnvironment, renderEnvironmentReport } from './environment.ts'
import { fallbackSkillsRoot, fallbackWorkRoot } from './workdir.ts'
import {
  MEDIA_FILE_HEADERS,
  UnsafePathError,
  WORK_FILE_HEADERS,
  listWorkDir,
  openWorkFile,
  parseByteRange,
  type ManagedPaths,
  managedPathsFor,
} from './workdir-files.ts'
import { resolveWorkDir } from './workdir.ts'
import { ReviewCoordinator } from './review.ts'
import { RunRegistry, replayMessagesSince } from './registry.ts'
import { createRuntimeBackend, knownRuntimeAdapters } from './runtime-registry.ts'
import { Semaphore } from './semaphore.ts'
import { WorkDirLocks } from './workdir-locks.ts'
import { defaultSkillListPath, loadSkillList } from './skill-list.ts'
import {
  SkillSourceError,
  describeSource,
  resolveLocalPath,
  resolvePayloadEntry,
  resolveSkillSource,
  type ResolvedSkillSource,
  type SkillSourceSpec,
} from '@agentdeck/skill-source'
import {
  ToolSourceError,
  buildToolPackage,
  describeToolSource,
  resolveLocalToolPath,
  toToolRecord,
  type ResolvedToolPackage,
  type ToolSourceErrorCode,
} from './tool-source.ts'

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
 * 任务级返工次数的上限（D45；2026-09 起从 5 放宽到 100，`null` = 无限）。
 *
 * 与 `SubmitRunRequest.maxReworks` 的 schema 上限**必须是同一个数**：schema 管
 * 协议层，这里管"HTTP 入口的早拒"。两处不一致时，宽的那个就是实际生效的那个
 * ——而它会是没人审过的那个。
 *
 * ⚠️ `null`（无限返工）是**另一条合法值**，不在这个上限里：早拒时单独放行，
 * 只有"有限次数越界"才按越界拒。
 */
const MAX_REWORKS = 100

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
  /**
   * 跑脚本动作时用的 **node 解释器路径**（D40）。
   *
   * 默认是 daemon 自己那个（`process.execPath`）。留这个口子有两个用途：
   * 测试里钉死一个已知解释器；部署上把解释器与 daemon 分开钉。
   */
  scriptRuntimePath?: string
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
   * 不碰家目录。CLI 会显式传 `~/agentdeck-workspace`（可见的那一个），
   * 因为"工作目录放哪"是面向使用者的产品决定，属于 CLI 那一层。
   */
  workRoot?: string
  /**
   * 技能内容的落点根（2026-10）。
   *
   * 缺省是**数据目录之内的 `skills/`**（`fallbackSkillsRoot`）——与 `workRoot`
   * 逐字对应的自洽兜底，不碰家目录。CLI 会显式传 `~/.agentdeck/skills`（可见的
   * 那个），因为"技能正文放哪"是面向使用者的产品决定，属于 CLI 那一层。
   */
  skillsRoot?: string
  /**
   * **使用者提炼**技能（D80）的落点根。缺省 = 数据目录内的 `skills-mine/`
   * （`fallbackSkillsRoot` 的对应兜底）；CLI 显式传 `~/.agentdeck/skills-mine`。
   *
   * ★ 这个根是 **git 仓库**（平台自动 commit，可回退，见 `run-hooks/skill-mine.ts`）；
   *   测试可覆盖（指向临时目录，NFR-T-01 的同类理由）。
   */
  skillsMineRoot?: string
  /**
   * 可选沙箱（M4）。缺省 `'none'`——见 `docs/design/design.md` §14.1 与 NG7：
   * 首版 run 以 daemon 用户的完整权限执行，这一点必须如实披露。
   *
   * ⚠️ 开启后如果平台上拿不到沙箱工具，daemon **会在起 run 时报错**，
   *    而不是静默降级——静默降级会让人在以为自己被保护着的情况下裸奔。
   */
  sandboxMode?: SandboxMode
  /**
   * GitHub **加速器**基址（`parseGithubProxy` 规范化过的，2026-10）。
   *
   * 不给 = 直连 GitHub。给 = 每个 GitHub 请求都转给这个第三方主机
   * （国内直连不稳时用），代价是**它能看也能改内容**——所以只在命令行
   * 显式指定时才启用，而且**不会**把 `githubToken` 交给它（见 `githubRequestTarget`）。
   */
  githubProxy?: string | null
  /**
   * 「本地安装清单」的路径（技能页「从本地清单安装」读的那份 JSON）。
   *
   * 缺省用仓库自带的那份（`skill-list.ts` 的 `defaultSkillListPath()`）。给了就用
   * 给的——**不回落**：路径写错时接口明确报错，而不是悄悄改用默认那份。
   */
  skillListPath?: string
  /**
   * 「从本地安装」页签扫的那几个目录（内置表：claude / codex / cursor / agents）。
   *
   * 缺省用 `localSkillDirCandidates()`（读当前用户的家目录）。给了就用给的——
   * **测试要指向临时目录**（NFR-T-01 的同类理由：测试不能依赖跑测机器上真的装着
   * Claude Code）。生产代码永远不传它。
   */
  skillDirCandidates?: () => LocalSkillDirCandidate[]
  /**
   * 注入 fetch，供"从 GitHub 安装 skill"使用。
   *
   * ★ 存在的理由是 **NFR-T-01**：测试**绝不能联网**。不注入的话，任何一条
   *   覆盖 GitHub 安装路径的测试都会真的去打 GitHub——既不可重复、又会被
   *   匿名限额卡住、还会在没网的机器上失败。
   */
  fetchImpl?: typeof fetch
  /** GitHub 令牌（可选）。缺省读环境变量 AGENTDECK_GITHUB_TOKEN。 */
  githubToken?: string | null
  /**
   * claude 个人配置的受管目录（D78）。缺省 = `dataDir/claude-config`。
   *
   * ★ 位置约束见 `run-hooks/claude-config.ts` 头注释：必须在 daemon 数据
   *   目录下（agent 不可见），**绝不放任务工作目录**。测试可覆盖（指向
   *   临时目录）。
   */
  claudeConfigDir?: string
  /**
   * copy env 的源 settings.json（D78）。缺省 = 使用者 `~/.claude/settings.json`。
   *
   * 做成可注入是 NFR-T-01 的同类理由：测试**绝不读使用者的真实配置**，
   * 生产代码永远不传它。
   */
  claudeSettingsSource?: string
  /**
   * codex 个人配置的受管目录（2026-10，D78 的 codex 版）。缺省 = 数据目录下
   * 的 `codex-config`（agent 不可见），**绝不放任务工作目录**。测试可覆盖。
   */
  codexConfigDir?: string
  /**
   * copy 认证/端点的源 `~/.codex/`（D78 的 codex 版）。缺省 = 使用者主目录。
   * 做成可注入是 NFR-T-01 的同类理由：测试绝不读使用者的真实配置。
   */
  codexConfigSource?: string
  onWarn?: (message: string) => void
  onInfo?: (message: string) => void
}

export interface DaemonHandle {
  url: string
  port: number
  store: Store
  /** 实际生效的工作目录根——启动横幅要显示它，见 cli.ts。 */
  workRoot: string
  /** 实际生效的技能内容根——同样要印在启动横幅上（技能正文就落在这里）。 */
  skillsRoot: string
  /** 使用者提炼技能（D80）的落点根（git 化）——CLI 横幅一并显示。 */
  skillsMineRoot: string
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

/**
 * 把某一层工作目录发出去（`GET …/files`）。
 *
 * 抽出来是因为它现在**有两个入口**：任务详情按某次执行问（`/api/runs/:id/files`），
 * 聊天按某个对话问（`/api/conversations/:id/files`）。两处只差"目录从哪来"，
 * 响应形状与错误口径必须一致——各写一份就是迟早只改一处。
 */
async function sendWorkDirListing(
  res: ServerResponse,
  workDir: string,
  dir: string,
  managed: ManagedPaths,
): Promise<void> {
  try {
    sendJson(res, 200, await listWorkDir(workDir, dir, managed))
  } catch (err) {
    // 路径不合法是**使用者输入问题**（400），不是服务坏了
    if (err instanceof UnsafePathError) {
      sendJson(res, 400, { error: err.message })
      return
    }
    throw err
  }
}

/**
 * 把工作目录里的一个文件发出去（`GET …/file?path=`）。
 *
 * ★ 每个响应都带 `nosniff`：这些文件是 **agent 写的**，而页面由 daemon 托管 ⇒
 *   与接口同源。非媒体的响应还带 `WORK_FILE_HEADERS` 里那条 `sandbox` 的 CSP
 *   （挡住 agent 写的 html/svg 在本源里跑脚本）——理由见 `workdir-files.ts`
 *   顶上那两段。
 *
 * ★ 2026-10：**音视频走另一条发法**（`streamable`）——不读进内存、认 `Range`、
 *   回 206。理由见 `workdir-files.ts` 顶上第三段：那条路上"能不能 seek"不是
 *   优化而是能不能用。
 */
async function sendWorkFile(
  res: ServerResponse,
  req: IncomingMessage,
  workDir: string,
  relPath: string,
): Promise<void> {
  try {
    const file = await openWorkFile(workDir, relPath)

    if (!file.streamable) {
      // 非媒体：老路子——整份读出来（查看器的「原文」面要的就是这串字节）
      res.writeHead(200, {
        'content-type': file.contentType,
        'content-length': file.size,
        ...WORK_FILE_HEADERS,
      })
      res.end(await readFile(file.path))
      return
    }

    // ── 媒体：流着发，并且认 Range ──
    //
    // ⚠️ `Range` 越界必须回 **416**（不是"忽略它回 200 整份"）：客户端会以为
    //    自己拿到了要的那一段，而症状是"视频播到某处就卡住/seek 到结尾"。
    const range = parseByteRange(req.headers.range, file.size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        'content-type': file.contentType,
        'content-range': `bytes */${file.size}`,
        ...MEDIA_FILE_HEADERS,
      })
      res.end()
      return
    }

    const start = range === null ? 0 : range.start
    const end = range === null ? Math.max(0, file.size - 1) : range.end
    const length = file.size === 0 ? 0 : end - start + 1
    res.writeHead(range === null ? 200 : 206, {
      'content-type': file.contentType,
      'content-length': length,
      ...(range === null ? {} : { 'content-range': `bytes ${start}-${end}/${file.size}` }),
      ...MEDIA_FILE_HEADERS,
    })
    if (file.size === 0) {
      res.end()
      return
    }
    // 流式发。
    //
    // ⚠️ **断开是常态，不许往上抛**：浏览器放媒体时会自己掐连接（seek 就是"取到要的
    //    那一段就断"，关掉播放器、切走页面同理）。往上抛会落到请求分发那一层的
    //    `请求处理失败：…` 上——使用者拖一次进度条，日志里就多一行像故障的东西，
    //    而真出故障时反而淹在里面。三种 code 都是这件事的不同长相。
    await pipeline(createReadStream(file.path, { start, end }), res).catch((err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'EPIPE' || code === 'ECONNRESET') {
        return
      }
      throw err
    })
  } catch (err) {
    if (err instanceof UnsafePathError) {
      sendJson(res, 400, { error: err.message })
      return
    }
    throw err
  }
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
 * 这条 run 能不能承载一条**人工裁决**（D46）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这个检查必须存在（而不是"界面对了就行"）
 * ══════════════════════════════════════════════════════════════════
 *
 * 阶段推导（`apps/web/src/lib/pipeline.ts` 的 `stageOf`）**只认审核 run 上的
 * 判决**——一条任务有没有审完，看的是"它最新那次执行有没有一条已完成的审核
 * run"。所以如果人工裁决被挂到一条**不生效**的 run 上，后果是：
 *
 *   人点了「人工通过」→ 请求 201 成功 → 判决确实落库了 → **看板一动不动**。
 *
 * 这是这个仓库最防的那类失效："看起来对、实际错"，而且两边都不报错。所以
 * 这个函数不是防御性编程，它是这条路由**唯一的正确性保证**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 判据：什么样的 run 才有"可裁决的结论"
 * ══════════════════════════════════════════════════════════════════
 *
 * | run | 允许吗 | 为什么 |
 * |---|---|---|
 * | 非终态（跑着 / 排队中） | ✗ | 还没有产出，人没有可看的东西——裁决它等于凭想象下结论 |
 * | `review`，已有判决，且它审的执行**仍是这条任务最新的一次** | ✓ | 裁决的就是那份结论 |
 * | `review`，没有判决 | ✗ | 判决不合规到连记录都没有时，没有"结论"可裁决。这时该做的是重试审核，不是替它下结论 |
 * | `review`，但它审的执行**已经被后来的一次执行取代** | ✗ | 那条判决在阶段推导里**已经不生效**了（看板只看最新一次执行的审核）。挂在它上面就是"点了通过、看板不动" |
 * | `execute`，这条执行**没有任何审核 run** | ✓ | 这就是"压根没配审核者"那种任务：它永远停在「待审查」，而人想自己确认。裁决挂在执行 run 上，`stageOf` 有对应的分支 |
 * | `execute`，**已经有审核结论** | ✗ | 裁决必须挂在**那条审核 run** 上（否则同上） |
 * | `execute`，**审核正在跑** | ✗ | 结论马上就出来了，这时候插一脚只会让两个结论打架。等它跑完 |
 *
 * ⚠️ 关于"它审的执行是不是最新的一次"：这条**只对审核 run** 判，而且只判
 *    "这条任务最新那次执行是哪条"——**不是**在 daemon 侧重算整个 `stageOf`。
 *    锚点的完整规则（含返工、审核重试、执行失败）仍然只有 `pipeline.ts` 一处
 *    实现，界面把算好的锚点传过来；这里补的这一条是**防陈旧页面**用的：
 *    页面开着的时候又跑了一次执行/审核，那时界面手上的锚点就过期了。
 */
async function canHostHumanVerdict(
  store: Store,
  run: Run,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
    return {
      ok: false,
      reason: `这条 run 还没结束（${run.status}），现在没有可裁决的东西`,
    }
  }

  if (run.kind === 'review') {
    const verdicts = await store.listVerdictsByRun(run.id)
    if (verdicts.length === 0) {
      return {
        ok: false,
        reason:
          '这条审核 run 没有产出过判决，所以没有可裁决的结论。' +
          '要人工下结论，请对那条执行 run 做裁决；要重试审核，请从任务详情重新派一次审核。',
      }
    }

    // ── 它审的那次执行，还是这条任务最新的一次吗 ──
    //
    // 只有"审的是 issue 的执行 run"这一种形状能判：subject 是 run 而不是 issue 的
    // 那些（理论上存在）不在这里下结论——判不了就不拦，而不是猜一个。
    if (run.subject.type === 'run') {
      const target = await store.getRun(run.subject.id as RunId)
      if (target && target.kind === 'execute' && target.subject.type === 'issue') {
        const issueId = target.subject.id
        const page = await store.listRuns({ workspaceId: run.workspaceId, limit: 10_000 })
        const latest = page.items
          .filter(
            (r) =>
              r.kind === 'execute' && r.subject.type === 'issue' && r.subject.id === issueId,
          )
          .sort((a, b) => b.queuedAt - a.queuedAt)[0]
        if (latest && latest.id !== target.id) {
          return {
            ok: false,
            reason:
              `这条审核判的是更早那次执行（run ${target.id}），它已经被后来的一次执行` +
              `（run ${latest.id}）取代了——那条判决在看板上不生效。` +
              '请对最新那次执行的审核结论做裁决。',
          }
        }
      }
    }
    return { ok: true }
  }

  if (run.kind === 'execute') {
    // 这条执行身上有没有审核 run？
    //
    // 一次列表读取就够（`RunQuery` 没有 kind/subject 过滤，所以在这里筛）：
    // `limit` 取一个远大于实际规模的数——单工作区的 run 数是千级，而这是
    // **人点按钮时**才走的一条路，不是热路径。
    const page = await store.listRuns({ workspaceId: run.workspaceId, limit: 10_000 })
    const reviews = page.items.filter(
      (r) => r.kind === 'review' && r.subject.type === 'run' && r.subject.id === run.id,
    )

    const reviewed = reviews.find((r) => r.status === 'completed')
    if (reviewed) {
      // 找到了就**把那条 run 的 id 说给使用者**：只说"不允许"会让人不知道
      // 下一步该去哪儿，而这一步完全是可操作的（就是界面上那条审核 run 的标签页）。
      return {
        ok: false,
        reason:
          `这条执行已经有审核结论了（审核 run ${reviewed.id}），` +
          '人工裁决要挂在那条审核 run 上——否则判决会落在一个阶段推导不看的地方，' +
          '表现为"点了通过但看板不动"。',
      }
    }

    const running = reviews.find((r) => !TERMINAL_RUN_STATUSES.includes(r.status))
    if (running) {
      return {
        ok: false,
        reason: `这条执行的审核还在跑（run ${running.id}），等它出结论再裁决`,
      }
    }

    return { ok: true }
  }

  return { ok: false, reason: `不能对 ${run.kind} 类型的 run 做人工裁决` }
}

/**
 * 这条 run 是不是**这条任务**的（D47 放弃时用来找出要取消哪些 run）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能只判 `subject.type === 'issue'`
 * ══════════════════════════════════════════════════════════════════
 *
 * **审核 run 的 subject 是那条执行 run 的 id，不是 issue**（这条链在
 * `pipeline.ts` 顶部解释过一次，`stageOf` 也因此踩过坑）。只按 issue 过滤的
 * 后果是：放弃一条任务时，**正在跑的审核 run 不会被取消**——它继续读产出、
 * 继续调模型、最后写一条判决挂在一条已经放弃的任务上。
 *
 * 所以顺着 subject 往上走：`review → execute → issue`。深度**有界**（只走
 * 两层），因为更长的链在当前实现里不存在，而一个无界递归遇到坏数据会转不出来。
 */
async function runBelongsToIssue(store: Store, run: Run, issueId: IssueId): Promise<boolean> {
  let cursor: Run | null = run
  for (let depth = 0; depth < 3 && cursor; depth++) {
    const subject = cursor.subject
    if (subject.type === 'issue') return subject.id === issueId
    if (subject.type !== 'run') return false
    cursor = await store.getRun(subject.id as RunId)
  }
  return false
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
      // ★ payload 给了就用 payload 的；没有就从 SKILL.md frontmatter 解析
      //   （作者写的那句用途说明）。都没有才是真的"没有说明"。
      description: payload.description ?? extractSkillMeta(validated.body).description ?? null,
      // 用**校验过的**正文与支持文件，而不是原始入参：规范化（比如 frontmatter
      // 里的 name 与 slug 对齐）在 `resolvePayloadEntry` 那边已经做过了
      body: validated.body,
      // 支持文件要落库，否则"装进来了但注入时只有 SKILL.md"——
      // 那种技能是坏的，而且坏得很安静
      ...(Object.keys(validated.files).length > 0 ? { files: validated.files } : {}),
      verdictSchemaVersion: 1,
      // ⚠️ 这里原来写 `allowedActions`（默认 `['comment.create']`）。D40 收口之后
      //    **skill 没有这个字段了**——动作权限属于智能体组
      //    （`AgentGroup.allowedActions`），安装 skill 不再接受、也不再写动作配置。
      //    老客户端在 source/payload 或批量条目里传了它会被忽略（不是"装错了"，
      //    只是那一项不再属于 skill）；写回它反而会让实体多出一个协议里没有的键。
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
    // 可选来源标识：「从本地安装」页签传 `localdir:<根目录>`，让列表显示得出
    // "来自本地技能目录：…"。不给就是默认的 `path:<技能目录>`。
    const sourceRef = obj['sourceRef']
    if (sourceRef !== undefined && sourceRef !== null && typeof sourceRef !== 'string') {
      return { ok: false, error: 'source.sourceRef 必须是字符串' }
    }
    const ref = typeof sourceRef === 'string' ? sourceRef.trim() : ''
    return {
      ok: true,
      spec: { kind: 'path', path: value.trim(), ...(ref !== '' ? { sourceRef: ref } : {}) },
    }
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

// ══════════════════════════════════════════════════════════════════
// 工具包（D40）：安装 / 卸载 / 挂载
// ══════════════════════════════════════════════════════════════════

/**
 * 工具包的错误一律用**同一个 400 形状**回。
 *
 * `error` 是给使用者看的一句话，`code` 让界面决定怎么提示（本地路径装不上、
 * 清单不合规、包太大……下一步动作完全不同），`detail` 里可能有换行（比如
 * 逐条列出的 schema 问题），界面要能**原样显示**——把它压成一行就等于把
 * "第几个动作的哪个字段不对"这条信息丢掉。
 */
function sendToolError(
  res: ServerResponse,
  error: string,
  code: ToolSourceErrorCode,
  detail: string | null = null,
): void {
  sendJson(res, 400, { error, code, detail })
}

/**
 * 工具包的安装来源。契约（D40）：`path` 或 `payload` 二选一。
 *
 * ⚠️ 与 skill 那条路（`SkillSourceSpec`）刻意分开：skill 有 `url`（GitHub），
 *    工具包**没有**——工具包里的脚本会在使用者机器上真的执行，而"从任意
 *    URL 下载一段可执行的东西并装上"不是首版该开的门。
 */
type ToolInstallSpec =
  | { kind: 'path'; path: string; slug: string | null }
  | {
      kind: 'payload'
      slug: string
      manifest: Record<string, unknown>
      files: Record<string, string>
      docs: string
      sourceRef: string
      version: string | null
    }

/**
 * 校验安装来源。**逐字段**校验，因为这是运行时的任意 JSON。
 *
 * 返回 `{ok:false}` 而不是抛异常：来源不对是**使用者输入问题**（400），
 * 不是服务出错（500）。
 */
function parseToolInstallSource(
  raw: unknown,
): { ok: true; spec: ToolInstallSpec } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '需要一个 JSON 对象作为请求体' }
  }
  const obj = raw as Record<string, unknown>
  const source = obj['source']

  if (source === 'path') {
    const value = obj['path']
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: 'source=path 需要非空的 path（绝对路径）' }
    }
    const slug = obj['slug']
    if (slug !== undefined && slug !== null && typeof slug !== 'string') {
      return { ok: false, error: 'slug 必须是字符串' }
    }
    return {
      ok: true,
      spec: {
        kind: 'path',
        path: value.trim(),
        slug: typeof slug === 'string' && slug.trim() !== '' ? slug.trim() : null,
      },
    }
  }

  if (source === 'payload') {
    const slug = obj['slug']
    if (typeof slug !== 'string' || slug.trim() === '') {
      return {
        ok: false,
        error: 'source=payload 需要非空的 slug（它同时是包的名字与动作的命名空间）',
      }
    }
    const manifest = obj['manifest']
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return {
        ok: false,
        error:
          'source=payload 需要 manifest（清单对象）。它是"是不是适配本平台的工具"的判据，' +
          '格式见 packages/protocol/src/tools.ts',
      }
    }
    const files = obj['files']
    if (files !== undefined && files !== null) {
      if (typeof files !== 'object' || Array.isArray(files)) {
        return { ok: false, error: 'source.files 必须是 相对路径→内容 的对象' }
      }
      for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          return {
            ok: false,
            error: `source.files['${k}'] 必须是字符串：首版只收文本文件（二进制装进来会写坏）`,
          }
        }
      }
    }
    const docs = obj['docs']
    if (docs !== undefined && docs !== null && typeof docs !== 'string') {
      return { ok: false, error: 'source.docs 必须是字符串（TOOL.md 的正文）' }
    }
    const sourceRef = obj['sourceRef']
    if (sourceRef !== undefined && sourceRef !== null && typeof sourceRef !== 'string') {
      return { ok: false, error: 'source.sourceRef 必须是字符串' }
    }
    const version = obj['version']
    if (version !== undefined && version !== null && typeof version !== 'string') {
      return { ok: false, error: 'source.version 必须是字符串或 null' }
    }
    return {
      ok: true,
      spec: {
        kind: 'payload',
        slug: slug.trim(),
        manifest: manifest as Record<string, unknown>,
        files: (files ?? {}) as Record<string, string>,
        docs: typeof docs === 'string' ? docs : '',
        // ★ 缺省是 `remote:`：这条路本来就是"页面从远端目录里取好交过来"。
        //   默认成别的会让"这包是哪来的"在数据上就错了——与 skill 那条路
        //   （`Skill.source` 默认 `remote`）同一个理由。
        sourceRef:
          typeof sourceRef === 'string' && sourceRef.trim() !== ''
            ? sourceRef.trim()
            : `remote:${slug.trim()}`,
        version: typeof version === 'string' ? version : null,
      },
    }
  }

  return {
    ok: false,
    error: "source 必须是 'path' 或 'payload'（从本机目录装 / 装页面送来的包）",
  }
}

/**
 * 来源里给的 slug 与清单里的 slug 必须一致。
 *
 * 理由与 `resolveLocalToolPath` 里那一段逐条相同（动作名是
 * `<slug>.<动作名>`，两处不一致时判决里该写哪个就没有答案了）。路径那条路
 * 已经查过一次，这里补的是 payload 那条——**同一句话在两处出现**是有意的：
 * 调用方看到的是同一句提示，而不是"看你走哪条路"。
 */
function slugDisagreement(given: string | null, manifestSlug: string): string | null {
  if (given === null || given === manifestSlug) return null
  return (
    `你指定的 slug「${given}」与清单里的「${manifestSlug}」不一致。` +
    '动作名是 `<包 slug>.<动作名>` 这个形状——两处不一致时，判决里该写哪个就没有答案了。请改清单，别用覆盖值。'
  )
}

/**
 * 安装内核（工具包）：路由只做"slug 唯一性 + id/时间 + 写库"，
 * "这是不是一个适配本平台的工具包"完全由 `tool-source.ts` 判。
 *
 * ⚠️ 这里**不重复**任何来源校验。在路由里再写一套，两条路（本地目录 /
 *    payload）迟早会在某个边界上不一致（大小写、符号链接、限额、入口文件
 *    是否真的存在），而那种不一致的表现是"从远端装能过、从路径装过不了"。
 */
async function installToolPackage(input: {
  store: Store
  workspaceId: WorkspaceId
  pkg: ResolvedToolPackage
  overwrite: boolean
  now: number
}): Promise<{ ok: true; tool: Tool } | { ok: false; error: string }> {
  const { store, workspaceId, pkg, overwrite, now } = input
  const slug = pkg.manifest.slug

  // ══════════════════════════════════════════════════════════════════
  // slug 在**一个工作区里唯一**：同名一律拒绝写入，不静默覆盖
  // ══════════════════════════════════════════════════════════════════
  //
  // 与 skill 那条路同一个规则、同一句话，理由也同一条：`insertTool` 是按
  // **id** 写入的，所以"同名但 id 不同"的两个包会**同时存在**，而
  // `getToolBySlug` 只取得到其中一条——判决里写的 `<slug>.<动作名>` 会
  // 抽到哪一份就没有答案了。哪种结果都不对，且都没有提示。
  //
  // 要替换必须显式说（`overwrite: true`）。工具包比 skill 更需要这条出路：
  // 卸载会被"还有 agent 挂着"挡住（见 DELETE），所以"改了包里的脚本重新装"
  // 如果只能靠卸载再装，就得先把所有挂载摘掉、装完再挂回去——那条路上任何
  // 一步忘掉，症状都是"某个 agent 的工具悄悄没了"。
  const clash = await store.getToolBySlug(workspaceId, slug)
  if (clash && !overwrite) {
    return {
      ok: false,
      error:
        `已有同名工具包「${slug}」（来源：${describeToolSource(clash.sourceRef ?? clash.source)}）。` +
        '同名一律拒绝写入，避免"装的时候顺手覆盖了你自己的东西"；' +
        '确实要替换请显式传 overwrite: true（替换会复用同一条记录，所以判决与审计里' +
        '写过的「<包 slug>.<动作名>」照样对得上）。',
    }
  }

  const tool = toToolRecord(pkg, {
    // 同名替换时**复用原 id**。原来的理由是"agent 的 toolIds 指着这个 id"，
    // 那条已经随挂载能力一起撤了；现在复用 id 是为了**别的东西**：
    // `allowedActions` 里的动作名是 `<包 slug>.<动作名>`，而审计记录、判决、
    // 已经在跑的 run 里都留着这个包的 id 与 slug——换 id 会让"刚才那条动作是哪个
    // 包做的"在追溯时对不上。
    id: (clash?.id ?? (ulid() as Tool['id'])) as Tool['id'],
    workspaceId,
    createdAt: clash?.createdAt ?? now,
    updatedAt: now,
  })
  await store.insertTool(tool)
  return { ok: true, tool }
}

/**
 * 解析一次安装请求的结果：要么是一份**校验过的包**，要么是"输入不对"的
 * 统一形状（直接可以交给 `sendToolError`）。
 */
type ToolResolveOutcome =
  | { ok: true; pkg: ResolvedToolPackage }
  | { ok: false; error: string; code: ToolSourceErrorCode; detail: string | null }

/**
 * 解析一次工具安装请求的**来源**（path 或 payload）→ 一份校验过的包。
 *
 * 两条路**共用同一关**（`resolveLocalToolPath` / `buildToolPackage`），
 * 差别只在"文件是从哪读来的"这一点。
 */
async function resolveToolInstall(spec: ToolInstallSpec): Promise<ToolResolveOutcome> {
  try {
    if (spec.kind === 'path') {
      const pkg = await resolveLocalToolPath(spec.path, { slug: spec.slug })
      return { ok: true, pkg }
    }

    // `tool.json` / `TOOL.md` 不该出现在 `files` 里：它们各自有字段
    // （`manifest` / `docs`）。两处都写时"以哪个为准"没有答案，而静默丢掉
    // 其中一份的表现是"我明明在包里改了清单，装进来却没变"。
    const reserved = Object.keys(spec.files).filter((p) => p === 'tool.json' || p === 'TOOL.md')
    if (reserved.length > 0) {
      return {
        ok: false,
        error: `source.files 里不该有 ${reserved.join('、')}：清单与说明另有字段（manifest / docs）`,
        code: 'bad_input',
        detail: '两处都写时以哪个为准没有答案。把清单放进 manifest、把说明放进 docs 即可。',
      }
    }

    // 清单在这里**重新序列化**再过 `buildToolPackage`：这样 payload 与本地目录
    // 走的是**同一个** `ToolManifest` 校验（含入口文件是否真的在包里）。
    const pkg = buildToolPackage({
      files: spec.files,
      manifestText: JSON.stringify(spec.manifest),
      docs: spec.docs,
      sourceRef: spec.sourceRef,
      resolvedFrom: spec.sourceRef,
    })

    const slugError = slugDisagreement(spec.slug, pkg.manifest.slug)
    if (slugError !== null) {
      return { ok: false, error: slugError, code: 'bad_input', detail: null }
    }

    // 版本只有一处权威：清单里的 `version`（`Tool.version` 就是从它落库的）。
    // 来源里再声明一个不同的值，就是"两处版本、没有权威"——界面显示哪个、
    // 判决里记哪个都会变成掷骰子，所以这里拒掉，并说清该改哪儿。
    if (spec.version !== null && spec.version !== pkg.manifest.version) {
      return {
        ok: false,
        error:
          `source.version 是「${spec.version}」，而清单里的版本是` +
          `「${pkg.manifest.version ?? '（没写）'}」——版本只有一处权威。`,
        code: 'bad_input',
        detail: '请把版本写进清单的 `version` 字段（写成 x.y.z），来源里的这个值只是转述。',
      }
    }

    return { ok: true, pkg }
  } catch (err) {
    if (err instanceof ToolSourceError) {
      // 400 而不是 500：这是"输入不对"，不是"服务坏了"。
      // code 一并返回，界面可以据此做不同的提示（比如"路径不存在"要引导去改路径）。
      return { ok: false, error: err.message, code: err.code, detail: err.detail }
    }
    throw err
  }
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
): Promise<{
  executeTemplate: string
  reviewTemplate: string
  chatTemplate: string
  executeIdentityTemplate: string
  executeTaskTemplate: string
  reviewIdentityTemplate: string
  reviewTaskTemplate: string
  chatIdentityTemplate: string
  chatTaskTemplate: string
  defaultAgentId: string | null
  locale: Locale
  /** D77：claude 的 WebSearch/WebFetch 开关。老数据没有这个键 ⇒ 默认开。 */
  webSearchEnabled: boolean
}> {
  const workspace = await store.getWorkspace(workspaceId)
  return {
    executeTemplate: workspace?.executeTemplate ?? '',
    reviewTemplate: workspace?.reviewTemplate ?? '',
    chatTemplate: workspace?.chatTemplate ?? '',
    // 2026-10 后加的六个键（② 身份 / ③ 任务框）：老 workspace 没有 ⇒ 空 = 平台默认
    executeIdentityTemplate: workspace?.executeIdentityTemplate ?? '',
    executeTaskTemplate: workspace?.executeTaskTemplate ?? '',
    reviewIdentityTemplate: workspace?.reviewIdentityTemplate ?? '',
    reviewTaskTemplate: workspace?.reviewTaskTemplate ?? '',
    chatIdentityTemplate: workspace?.chatIdentityTemplate ?? '',
    chatTaskTemplate: workspace?.chatTaskTemplate ?? '',
    defaultAgentId: workspace?.defaultAgentId ?? null,
    // 老数据没有这个键 ⇒ 中文（本项目的默认语言，也是所有既有数据的语言）
    locale: workspace?.locale ?? DEFAULT_LOCALE,
    webSearchEnabled: workspace?.webSearchEnabled ?? true,
  }
}

/**
 * 解析并校验「审核标准」（D37 / D40）。
 *
 * 三种"没给"都算**没有标准**（`value: null`）：字段缺省、显式 `null`、正文为空白。
 * 没有标准的审核者不会拿到审核任务——那是一个**明确的状态**，不是错误
 * （使用者可能正在编辑它）。
 *
 * 校验两件事，每件都有具体的坏结果撑着：
 *
 *   1. **名字与正文非空**：一条没有正文的"标准"等于没有标准，而它会让
 *      "这个审核者能不能用"的判断失效（平台以为它有标准）；
 *   2. **名字不超长**：它要进界面与日志。
 *
 * ══════════════════════════════════════════════════════════════════
 * 动作权限**不在这里**——也不在 agent 上，它在**智能体组**里（2026-10）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这里**只收正文**：标准回答"按什么判"，而"判完允许动什么"属于**这条链**，
 * 权威是 `AgentGroup.allowedActions`（组配置页 ③，建任务时展开进 `Run.*`）。
 *
 * 所以客户端若还按老契约在 `reviewStandard` 里塞 `allowedActions`（那个字段一度
 * 与判断依据合体存在这里），那是**老客户端**的写法——值被忽略（见下面的注释），
 * 请求本身不报错。
 *
 * 校验动作的那一半现在在 `parseAllowedActions` 里（同一个文件、同一套措辞），
 * 它给**组**与**这一次任务**用。
 */
function parseReviewStandard(
  raw: unknown,
  warn: (message: string) => void,
): { ok: true; value: Agent['reviewStandard'] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'reviewStandard 必须是含 body 的对象或 null' }
  }
  const obj = raw as Record<string, unknown>
  const body = typeof obj['body'] === 'string' ? obj['body'].trim() : ''
  // 正文空 ⇒ 当成"清空标准"（与传 null 等价）：没有标准就拿不到审核任务，
  // 所以"空正文"和"没有标准"是同一件事，不该存成一条空标准。
  if (body === '') return { ok: true, value: null }
  // ⚠️ 老客户端会照旧送 `name` 进来（它以前是必填的）。**刻意忽略**，不报 400：
  //    使用者没做错什么，只是少升了一次级；而收下它等于把一个已经删掉的字段
  //    又写回数据里。与下面 `allowedActions` 那段同一个处置。

  // ⚠️ 老字段 `reviewStandard.allowedActions` 在这里**被刻意忽略**：
  //    它连同 `Agent` 上那三个同名字段**一起撤掉了**（2026-10），现在动作权限的
  //    唯一出处是**智能体组**。老客户端（页面还是旧的那版）会照旧把它送进来
  //    ——收下它等于让同一件事又有了一个出处，而那个出处已经不存在了。
  //
  //    这里不报 400：老客户端不该因为"少了一次升级"就整条保存失败。但**也不
  //    静默**——静默的表现是"我明明配了动作，判完却说不在允许范围里"，
  //    那是这次搬家最容易产生的一类困惑，所以日志里留一句，排查有落点。
  //    （值被丢掉这件事本身还有一层兜底：启动时会把老记录里那个键摘掉，
  //    见 `agent-legacy-cleanup.ts`。）
  const legacy = obj['allowedActions']
  if (Array.isArray(legacy) && legacy.length > 0) {
    warn(
      '收到 reviewStandard.allowedActions（老契约）。动作权限已经搬到**智能体组**上（组配置页 ③ 行动），' +
        `这次的值（${legacy.length} 个）不会被写入——请改在组上配动作。`,
    )
  }

  return { ok: true, value: { body } }
}

/**
 * 解析并校验**智能体组的动作权限**（`AgentGroup.allowedActions`，2026-10 起的唯一
 * 出处；在那之前短暂地是 `Agent.allowedActions`）。
 *
 * 每一项必须是**已安装工具包声明的动作**（`<包 slug>.<动作名>`，与判决
 * `action.type` 同一个形状）——D41 之后没有内置动作了，**裸名一律不接受**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么第三方动作在保存时就校验"包装着没有"
 * ══════════════════════════════════════════════════════════════════
 *
 * 早拒的理由是无人值守：跑到一半才发现"策略要的动作找不到包/没声明"，就是
 * **每一次任务都以同一个原因失败**，而那时既没有人能改，错误也指向不了配置。
 * 在这里拒，至少有人在保存的那一刻能看到"哪个动作、因为哪个包没装"，并把包装上
 * 或把动作去掉。
 *
 * ⚠️ 运行时仍然有**第二道**守卫：判决被接受之前按这份白名单校验，而且动作解析
 *    要能真的找到包的入口。这里拒的是"配置时就知道不可能的"，那道守卫拦的是
 *    "装进来之后包被换掉/卸载"这类变化——两道都要有。
 *
 * ⚠️ 只做**去重**，不排序、不补默认："允许什么"必须是使用者说了算的东西，
 *    平台不替他放宽（也不替他收紧）。
 */
function parseAllowedActions(
  raw: unknown,
  installedTools: readonly Tool[],
): { ok: true; value: ActionRefType[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'allowedActions 必须是数组' }
  }
  // ⚠️ 不用 `parseAllowedActions` 那一类会**抛异常**的解析：这里是路由里的校验，
  //    要的是"返回 400 并带一句可读的话"。
  //
  // ⚠️ 这里原来还有一个 `const builtin = new Set(ActionType.options)`，用来
  //    "内置动作名原样放行"。D41 把内置动作全部移除之后那个集合不存在了，
  //    而**留着它的等价物会更糟**：白名单里允许写一个永远解析不出来的名字，
  //    判决一旦引用就走结构性 invalid，且不可重试。

  /**
   * 已安装工具包：slug → 它声明的动作名。
   *
   * 用 `slug` 做键（而不是 id）：判决里写的是 `<slug>.<动作名>`，白名单与判决
   * 必须**按同一个东西**对齐——用 id 对齐的话，白名单里就得写一个使用者看不到
   * 的 id，而"这个动作来自哪个包"在界面上就没法解释了。
   */
  const toolsBySlug = new Map<string, Set<string>>()
  for (const tool of installedTools) {
    toolsBySlug.set(tool.slug, new Set(tool.manifest.actions.map((a) => a.name)))
  }

  const notAnAction: string[] = []
  const fromMissingPackage: Array<{ action: string; slug: string }> = []
  const notDeclared: Array<{ action: string; slug: string; declared: string[] }> = []
  const accepted: string[] = []

  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      notAnAction.push(String(entry))
      continue
    }
    const action = entry.trim()
    // 动作名一律是 `<包 slug>.<动作名>`。形状不对的一律归到"不认识的动作"，
    // 不猜它是想写哪个（猜错会变成"允许了一个使用者没打算允许的动作"）。
    const slug = toolSlugOfAction(action)
    if (slug === null) {
      notAnAction.push(action)
      continue
    }
    const declared = toolsBySlug.get(slug)
    if (!declared) {
      fromMissingPackage.push({ action, slug })
      continue
    }
    const actionName = action.slice(slug.length + 1)
    if (!declared.has(actionName)) {
      notDeclared.push({ action, slug, declared: [...declared] })
      continue
    }
    accepted.push(action)
  }

  if (notAnAction.length > 0) {
    return {
      ok: false,
      error:
        `allowedActions 里有不认识的动作：${notAnAction.join('、')}。` +
        `动作只能来自已安装的工具包，写成 \`<包 slug>.<动作名>\` ` +
        `（平台没有内置动作——D41 已经把它们全部移除了）。`,
    }
  }
  if (fromMissingPackage.length > 0) {
    return {
      ok: false,
      error:
        'allowedActions 里有动作来自还没安装的工具包：' +
        fromMissingPackage.map((m) => `${m.action}（来自工具包「${m.slug}」）`).join('、') +
        '。先把这些包装上（装完再配动作），或者把这些动作去掉' +
        '——这里拒掉是因为：等到真的跑起来才发现"策略要的动作找不到包"，' +
        '在无人值守下就是每次任务都以同一个原因失败。',
    }
  }
  if (notDeclared.length > 0) {
    return {
      ok: false,
      error:
        'allowedActions 里有工具包没有声明的动作：' +
        notDeclared
          .map(
            (m) =>
              `${m.action}（工具包「${m.slug}」声明的是：${m.declared.join('、') || '（没有动作）'}）`,
          )
          .join('；') +
        '。多半是拼错了动作名——这个动作在运行时找不到实现，会让每一次判决都不合规。',
    }
  }

  // ⚠️ 这里必须 cast：`ActionRefType` 的形状（正则）比"已安装包里真的有这个
  //    动作"宽，而上面已经**逐条查过**每个动作来自已安装且确实声明了该动作的包，
  //    所以运行时是安全的。不收窄的话这条路由会比协议更严，表现就是"装得上的
  //    工具动作、agent 上却配不进去"。
  return { ok: true, value: [...new Set(accepted)] as ActionRefType[] }
}

/**
 * 解析并校验动作的**固定参数**（`AgentGroup.actionParams` /
 * `SubmitRunRequest.actionParams`，D43）。
 *
 * 形状：`Record<动作名, Record<参数名, 值>>`。两条判据：
 *
 *   1. **每个动作都必须是已安装工具包声明的动作**——与 `parseAllowedActions`
 *      同一条规矩、同一个理由（早拒：无人值守下"策略要的动作找不到包"就是每次
 *      任务都以同一个原因失败）。
 *   2. **每个参数都必须是那个动作的 open 参数、且值满足声明**（类型/上限/枚举）
 *      ——固定参数与模型填的开放参数走**同一个**取值判据
 *      （`validateFixedParams` → `openValueIssue`），否则会出现"模型填 `channel:
 *      'qq'` 被拒、使用者在界面上设 `channel: 'qq'` 却存得进去"这种自相矛盾。
 *      bound 参数一律拒：那是平台按事实注入的，不归使用者钉。
 *
 * ⚠️ 只做**去重**（同动作重复键后者覆盖前者），不排序、不补默认。
 */
function parseActionParams(
  raw: unknown,
  installedTools: readonly Tool[],
): { ok: true; value: Record<ActionRefType, Record<string, unknown>> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'actionParams 必须是对象：动作名 → 参数名 → 值' }
  }

  const definitions = toolActionDefinitions(installedTools)
  const out: Record<string, Record<string, unknown>> = {}
  const unknownActions: string[] = []
  const badParams: string[] = []

  for (const [type, params] of Object.entries(raw as Record<string, unknown>)) {
    const definition = definitions[type as ActionRefType]
    if (!definition) {
      // 与 allowedActions 同一套"为什么拒"的说法：动作要来自**已安装**的包。
      unknownActions.push(type)
      continue
    }
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      badParams.push(`${type}（参数必须是对象）`)
      continue
    }
    const check = validateFixedParams(definition, params as Record<string, unknown>)
    if (!check.ok) {
      badParams.push(`${type}：${check.issues.join('；')}`)
      continue
    }
    out[type] = { ...(params as Record<string, unknown>) }
  }

  if (unknownActions.length > 0) {
    return {
      ok: false,
      error:
        'actionParams 里有动作来自还没安装的工具包（或那个包没有声明这个动作）：' +
        unknownActions.join('、') +
        '。先把这些包装上（装完再配固定参数），或者把这一项去掉——' +
        '固定参数是给"这一次判决要触发的动作"钉值的，动作都不存在，参数就无处安放。',
    }
  }
  if (badParams.length > 0) {
    return {
      ok: false,
      error:
        'actionParams 里有参数不合规：' +
        badParams.join('；') +
        '。固定参数只能设这个动作的 open 参数（模型本来要填的那几个），' +
        '值必须满足声明（类型 / 上限 / 枚举）；bound 参数是平台按事实注入的，不归使用者钉。',
    }
  }

  return { ok: true, value: out as Record<ActionRefType, Record<string, unknown>> }
}

/**
 * 解析并校验智能体组的**可写字段**（D70 增量添加）。
 *
 * POST 与 PATCH 共用：`current` 为 `undefined` 时是建组（几个字段必填），
 * 给了 `current` 时是改组（PATCH 语义：**没传的字段不校验也不返回**，保持原值）。
 *
 * ⚠️ 校验的动作白名单 / 固定参数与 agents 那套**共用同一个函数**（`parse
 *    AllowedActions` / `parseActionParams`）——"为什么拒"的说法两处必须
 *    一致，各写一遍迟早会漂。
 *
 * ⚠️ 形态校验（`checkGroupShape`）在这里做：`members` 是列表，而"恰好 1 执行 +
 *    1 审核"是组唯一的受支持形态，形态不对要在**写入前**拒（不能等提交 run 时
 *    才炸）。成员的角色从各自的 `Agent.role` 读。
 */
interface GroupFieldValue {
  name?: string
  members?: AgentGroup['members']
  allowedActions?: AgentGroup['allowedActions']
  actionParams?: AgentGroup['actionParams']
  debugActions?: AgentGroup['debugActions']
  /** 0–100，或 null = 无限返工。 */
  maxReworks?: number | null
  enabled?: boolean
  /** 组模式（第二轮）：只在创建时写（PATCH 的未知字段拒绝已经把它挡掉了）。 */
  mode?: AgentGroup['mode']
}

async function parseGroupFields(
  body: Record<string, unknown>,
  store: Store,
  workspaceId: WorkspaceId,
  current?: AgentGroup,
): Promise<{ ok: true; value: GroupFieldValue } | { ok: false; error: string }> {
  const tools = await store.listTools(workspaceId)
  const out: GroupFieldValue = {}

  // ── name ──
  if (body['name'] !== undefined) {
    const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
    if (name === '') {
      return { ok: false, error: '智能体组需要 name（非空字符串）' }
    }
    if (name.length > 100) {
      return { ok: false, error: 'name 太长了（上限 100 字符）' }
    }
    out.name = name
  } else if (current === undefined) {
    return { ok: false, error: '智能体组需要 name（非空字符串）' }
  }

  // ── members（建组必填；改组可传）──
  //
  // ★ 第二轮：`createAgents`（私有成员的草稿）也在组请求里——建一个"全私有"的
  //   组时 `members` 传 `[]` 是**合法的**（私有成员由 daemon 建好后并入 members）。
  //   所以这里只校验"给出来的 members 里的 id 存在"，空数组放行，**形状校验留给
  //   处理器**（它要把 createAgents 的角色算进去之后才校验 1 执行 + 1 审核）。
  const hasDrafts = Array.isArray(body['createAgents']) && body['createAgents'].length > 0
  if (body['members'] !== undefined) {
    const raw = body['members']
    if (!Array.isArray(raw)) {
      return { ok: false, error: 'members 必须是数组' }
    }
    if (raw.length === 0 && hasDrafts) {
      out.members = []
    } else if (raw.length === 0) {
      return { ok: false, error: 'members 必须是数组，且至少要有一个成员' }
    } else {
      const bad = raw.find((v) => typeof v !== 'string' || v.trim() === '')
      if (bad !== undefined) {
        return { ok: false, error: `members 里每一项都必须是非空字符串（收到 ${JSON.stringify(bad)}）` }
      }
      const ids = (raw as string[]).map((v) => v.trim())
      const allAgents = await store.listAgents(workspaceId)
      const byId = new Map(allAgents.map((a) => [a.id as string, a]))
      const unknownId = ids.find((id) => !byId.has(id))
      if (unknownId !== undefined) {
        return { ok: false, error: `组员不存在：${unknownId}。它可能已经被删掉了，请重新选择成员。` }
      }
      out.members = ids as AgentGroup['members']
    }
  } else if (current === undefined && !hasDrafts) {
    return { ok: false, error: '智能体组需要 members（至少一个成员）' }
  }

  // ── allowedActions ──
  if (body['allowedActions'] !== undefined) {
    const check = parseAllowedActions(body['allowedActions'], tools)
    if (!check.ok) return { ok: false, error: check.error }
    out.allowedActions = check.value
  } else if (current === undefined) {
    out.allowedActions = []
  }

  // ── actionParams ──
  if (body['actionParams'] !== undefined) {
    const check = parseActionParams(body['actionParams'], tools)
    if (!check.ok) return { ok: false, error: check.error }
    out.actionParams = check.value
  } else if (current === undefined) {
    out.actionParams = {}
  }

  // ── debugActions（必须是 allowedActions 的子集；判据用改完之后的白名单）──
  if (body['debugActions'] !== undefined) {
    const dbg = body['debugActions']
    if (!Array.isArray(dbg)) {
      return { ok: false, error: 'debugActions 必须是数组' }
    }
    const dbgCheck = parseAllowedActions(dbg, tools)
    if (!dbgCheck.ok) return { ok: false, error: dbgCheck.error }
    const allowedNow =
      body['allowedActions'] !== undefined
        ? out.allowedActions!
        : (current?.allowedActions ?? [])
    const notAllowed = dbgCheck.value.filter((a) => !allowedNow.includes(a))
    if (notAllowed.length > 0) {
      return {
        ok: false,
        error:
          `调试动作必须在行动权限里：${notAllowed.join('、')} 不在这个组的 ` +
          'allowedActions 里。先把它加进行动权限，再标调试。',
      }
    }
    out.debugActions = dbgCheck.value
  } else if (current === undefined) {
    out.debugActions = []
  }

  // ── maxReworks（0–100，或 null = 无限；任务级仍可覆盖）──
  if (body['maxReworks'] !== undefined) {
    const raw = body['maxReworks']
    if (raw === null) {
      // 无限返工：审核判 fail 就一直交回执行者重做，直到通过或交给人。
      // （协议层已 nullable；这里显式收一下，免得"宽松的 schema"悄悄变宽。）
      out.maxReworks = null
    } else if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_REWORKS) {
      return {
        ok: false,
        error: `maxReworks 必须是 0–${MAX_REWORKS} 的整数（返工次数，0 = 不返工），或 null（无限返工）`,
      }
    } else {
      out.maxReworks = raw
    }
  } else if (current === undefined) {
    out.maxReworks = 0
  }

  // ── enabled ──
  if (body['enabled'] !== undefined) {
    if (typeof body['enabled'] !== 'boolean') {
      return { ok: false, error: 'enabled 必须是布尔值' }
    }
    out.enabled = body['enabled']
  } else if (current === undefined) {
    out.enabled = true
  }

  // ── mode（第二轮）：现在只有 'workflow'（工作流模式）。省略 = 默认工作流。──
  if (body['mode'] !== undefined) {
    if (body['mode'] !== 'workflow') {
      return { ok: false, error: `mode 必须是 'workflow'（现在只实现了工作流模式；收到 ${JSON.stringify(body['mode'])}）` }
    }
    out.mode = 'workflow'
  } else if (current === undefined) {
    out.mode = 'workflow'
  }

  return { ok: true, value: out }
}

/**
 * 私有成员的草稿（第二轮）：组 POST/PATCH 的 `createAgents` 数组里的一项。
 *
 * 「组是私有智能体的创建入口」——组请求里带上这些草稿，daemon 建好 agent
 * （`ownerGroupId = 组 id`）之后把 id 并入 `members`，一次请求完成、不留下
 * "建了一半"的孤儿。表单收敛（使用者拍板）：名字 + 指令（执行者）/ 审核标准
 * （审核者）+ runtime + 可选技能——正好是这四样。
 */
interface GroupCreateAgentDraft {
  name: string
  role: Agent['role']
  instructions: string
  reviewStandard: Agent['reviewStandard']
  runtimeKey: string
  skillIds: SkillId[]
}

/**
 * 解析并校验组请求里的 `createAgents`（数组；可选）。
 *
 * ⚠️ 只**校验不落库**：创建动作在组处理器里（那时组 id 才存在，私有 agent 的
 *    `ownerGroupId` 才有着落）。校验与 `POST /api/agents` 共用同一批判据
 *    （runtime 存在、skill 存在、审核标准形状、名字长度），措辞两处一致。
 */
async function parseGroupCreateAgents(
  body: Record<string, unknown>,
  store: Store,
  workspaceId: WorkspaceId,
  warn: (msg: string) => void,
): Promise<{ ok: true; value: GroupCreateAgentDraft[] } | { ok: false; error: string }> {
  const raw = body['createAgents']
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'createAgents 必须是数组（每个元素是一个私有智能体的草稿）' }
  }
  if (raw.length > 2) {
    return { ok: false, error: `createAgents 最多 2 个（1 执行 + 1 审核；收到 ${raw.length} 个）` }
  }

  const out: GroupCreateAgentDraft[] = []
  const skills = await store.listSkills(workspaceId)
  const knownSkills = new Set(skills.map((s) => s.id as string))
  for (let i = 0; i < raw.length; i++) {
    const draft = raw[i]
    if (typeof draft !== 'object' || draft === null) {
      return { ok: false, error: `createAgents[${i}] 必须是对象（私有智能体的草稿）` }
    }
    const d = draft as Record<string, unknown>
    const who = `createAgents[${i}]`

    const name = typeof d['name'] === 'string' ? d['name'].trim() : ''
    if (name === '') return { ok: false, error: `${who} 需要 name（非空字符串）` }
    if (name.length > 100) return { ok: false, error: `${who} 的 name 太长了（上限 100 字符）` }

    if (d['role'] !== 'executor' && d['role'] !== 'reviewer') {
      return { ok: false, error: `${who} 的 role 必须是 'executor' 或 'reviewer'（组的 1+1 形态只消费这两种）` }
    }
    const role = d['role'] as Agent['role']

    if (typeof d['instructions'] !== 'string') {
      return { ok: false, error: `${who} 需要 instructions（字符串；私有执行者的指令）` }
    }

    const standardCheck = parseReviewStandard(d['reviewStandard'], warn)
    if (!standardCheck.ok) return { ok: false, error: `${who} 的 ${standardCheck.error}` }

    const runtimeCheck = await resolveRuntimeKey(d['runtimeKey'])
    if (!runtimeCheck.ok) return { ok: false, error: `${who} 的 ${runtimeCheck.error}` }

    const skillIdsRaw = d['skillIds']
    const skillIds: SkillId[] = []
    if (skillIdsRaw !== undefined && skillIdsRaw !== null) {
      if (!Array.isArray(skillIdsRaw)) {
        return { ok: false, error: `${who} 的 skillIds 必须是数组` }
      }
      const bad = skillIdsRaw.find((v) => typeof v !== 'string' || v.trim() === '')
      if (bad !== undefined) {
        return { ok: false, error: `${who} 的 skillIds 里每一项都必须是非空字符串（收到 ${JSON.stringify(bad)}）` }
      }
      for (const id of skillIdsRaw as string[]) {
        if (!knownSkills.has(id.trim())) {
          return {
            ok: false,
            error: `${who} 挂载的 skill 不存在：${id}。可用的：${
              skills.map((s) => s.slug).join(', ') || '（还没有 skill）'
            }`,
          }
        }
        skillIds.push(id.trim() as SkillId)
      }
    }

    out.push({ name, role, instructions: d['instructions'], reviewStandard: standardCheck.value, runtimeKey: runtimeCheck.runtimeKey, skillIds })
  }
  return { ok: true, value: out }
}

/**
 * 把 `createAgents` 草稿落库（第二轮）。调用方保证：组 id 已存在（私有 agent 的
 * `ownerGroupId` 才有归属）、草稿已通过 `parseGroupCreateAgents` 校验。
 *
 * 返回建好的 agent（`members` 要把它们的 id 并进去）。私有 agent 不带个人动作
 * 权限（`allowedActions: []`）——动作权限住在**组**上（D70 的设计：同一份动作
 * 是这条链的，不是审核者个人的），组展开时会用组的默认。
 */
async function createDraftAgents(
  drafts: readonly GroupCreateAgentDraft[],
  ownerGroupId: AgentGroup['id'],
  workspaceId: WorkspaceId,
  store: Store,
): Promise<Agent[]> {
  const now = Date.now()
  const out: Agent[] = []
  for (const d of drafts) {
    const agent: Agent = {
      id: ulid() as Agent['id'],
      workspaceId,
      name: d.name,
      instructions: d.instructions,
      model: null,
      runtimeKey: d.runtimeKey,
      workDir: null,
      skillIds: d.skillIds,
      env: {},
      role: d.role,
      reviewStandard: d.reviewStandard,
      ownerGroupId,
      createdAt: now,
      updatedAt: now,
    }
    await store.insertAgent(agent)
    out.push(agent)
  }
  return out
}

/**
 * 在**写入之前**校验"已有成员 + 新建草稿"拼出来的组形态（第二轮）。
 *
 * ★ 为什么先算一遍而不是建完草稿再校验：形态不对（比如 2 个执行者）就**一个
 *   agent 都不建**——否则会留下 `ownerGroupId` 指向一个不存在的组的孤儿私有
 *   agent，使用者重试一次就多出一份。
 *
 * ⚠️ 草稿还没落库，这里用**占位对象**喂形态校验器（它只读 `id` / `role` /
 *   `name` 三个字段，见 `packages/domain/src/groups/shape.ts`）。
 */
async function shapeWithDrafts(
  baseMembers: readonly string[],
  drafts: readonly GroupCreateAgentDraft[],
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ ok: true } | { ok: false; issues: string[] }> {
  const all = await store.listAgents(workspaceId)
  const byId = new Map(all.map((a) => [a.id as string, a]))
  const members: Agent[] = []
  for (const id of baseMembers) {
    const a = byId.get(id)
    if (!a) {
      return { ok: false, issues: [`组成员不存在：${id}。它可能已经被删掉了，请重新选择成员。`] }
    }
    members.push(a)
  }
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!
    members.push({
      id: `draft-${i}` as Agent['id'],
      workspaceId: '' as Agent['workspaceId'],
      name: d.name,
      role: d.role,
      instructions: '',
      model: null,
      runtimeKey: d.runtimeKey,
      workDir: null,
      skillIds: [],
      env: {},
      reviewStandard: null,
      createdAt: 0,
      updatedAt: 0,
    })
  }
  const shape = checkGroupShape(
    {
      id: '' as AgentGroup['id'],
      workspaceId,
      name: '（新组）',
      members: members.map((m) => m.id) as AgentGroup['members'],
      allowedActions: [],
      actionParams: {},
      debugActions: [],
      maxReworks: 0,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    members,
  )
  if (!shape.ok) return { ok: false, issues: shape.issues }
  return { ok: true }
}

/**
 * 组的成员（第二轮）：按 `group.members` 从库里查出**完整** agent（含私有）。
 *
 * 界面上组的名字/角色只从这份数据 join（私有成员不在全局 `GET /api/agents` 里）。
 */
async function membersOfGroup(group: AgentGroup, store: Store): Promise<Agent[]> {
  const all = await store.listAgents(group.workspaceId)
  const wanted = new Set(group.members.map((id) => id as string))
  return all.filter((a) => wanted.has(a.id as string))
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
/**
 * 解析一块模版（某个 kind 的某个 block）。**与预览走同一道关**。
 *
 * ⚠️ 写入口漏掉一条链路的表现是**静默的**：界面上的「聊天」页签照常保存、照常
 *   提示已保存，而库里那个键根本没写（`PUT` 只遍历它认识的那几个 key）——
 *   使用者会以为"聊天那条模版不生效"，而真正生效的是平台默认那份。
 *   所以这里遍历的是 `ALL_KINDS × TEMPLATE_BLOCKS` 的**完整叉积**——加第三条链路
 *   或第三块时，写入口自动就认识它。
 */
function kindNameForApi(kind: FirstSentenceKind): string {
  return kind === 'execute' ? '执行' : kind === 'review' ? '审核' : '聊天'
}

function blockNameForApi(block: TemplateBlock): string {
  return block === 'frame' ? '① 框架' : block === 'identity' ? '② 身份' : '③ 任务'
}

function parseTemplateField(
  kind: FirstSentenceKind,
  block: TemplateBlock,
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: '' }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: `${kindNameForApi(kind)}的${blockNameForApi(block)}模版必须是字符串（空字符串 = 用平台默认模版）`,
    }
  }
  const text = raw.trim()
  if (text === '') return { ok: true, value: '' }
  const check = validateTemplate(kind, block, text)
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
 * 安装 skill 的动作配置校验**已经删掉**（D40 收口）。
 *
 * 这里原来有一个 `parseSkillAllowedActions`：它校验安装 skill 时带来的动作子集，
 * 并写进 `Skill.allowedActions`。那个字段与那条路都不存在了——动作权限住在
 * **智能体组**上（`AgentGroup.allowedActions`，校验见 `parseAllowedActions`），
 * 而 skill 只剩"正文 + 支持文件"。
 *
 * ⚠️ 别再把它加回来：一旦 skill 又能声明动作，"谁能改状态"就又有了第二个出处。
 */

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const warn = options.onWarn ?? ((m: string) => console.warn(`[warn] ${m}`))
  const info = options.onInfo ?? ((m: string) => console.log(m))

  // 技能内容的落点（2026-10）：正文 + 支持文件存成真文件放在这里，`skill.jsonl`
  // 退化成索引。兜底在数据目录之内（不碰家目录），可见的默认值由 CLI 给出。
  const skillsRoot = options.skillsRoot ?? fallbackSkillsRoot(options.dataDir)
  // 使用者提炼技能（D80）的落点：与安装根**物理分离**（`skills-mine`），
  // 且这个根是 git 仓库（平台自动 commit）。兜底同样在数据目录之内。
  const skillsMineRoot = options.skillsMineRoot ?? join(options.dataDir, 'skills-mine')

  const store = await FileStore.open({
    dataDir: options.dataDir,
    fsync: options.fsync ?? true,
    skillsRoot,
    skillsMineRoot,
  })

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

  // 「本地安装清单」的路径：给了 `--skills-catalog` 就用给的，否则用仓库自带那份。
  // 每次请求现读现算（清单是使用者会手改的文件，缓存它只会让改动看不见）。
  const skillListPath = options.skillListPath ?? defaultSkillListPath()

  const registry = new RunRegistry()
  const locks = new WorkDirLocks()
  const semaphore = new Semaphore(options.maxConcurrentRuns ?? 20)

  // ★ D40：第三方动作（工具包里的脚本）要有人真的去起进程。
  //   临时目录放在**数据目录下**：受限环境（沙箱）写不了系统临时目录，而且系统
  //   临时目录是所有进程共享的。脚本文件与它的 HOME 都落在这一次执行的专用子目录
  //   里，跑完即删（见 `apps/daemon/src/script-executor.ts` 的 finally）。
  //   `node` 解释器用 daemon 自己那个（`process.execPath`），不查 PATH——脚本因此
  //   与平台跑在同一个 node 上，也不受使用者的 PATH 影响。
  const executeToolScript = createScriptExecutor({
    tempRoot: join(options.dataDir, 'tool-tmp'),
    ...(options.scriptRuntimePath ? { nodePath: options.scriptRuntimePath } : {}),
  })

  const actionRunner = new ActionRunner({
    store,
    // ⚠️ 这里原来还有 `deriveRun: (req) => deriveRunFromAction(req)`——内置动作
    //    `issue.assign_agent` 用来派生新 run 的回调。D41 之后动作**只能**来自
    //    工具包、而工具脚本改不了平台数据，所以不再有任何东西需要这个回调。
    executeToolScript,
    onWarn: warn,
  })
  const reviewCoordinator = new ReviewCoordinator({
    store,
    actions: actionRunner,
    createRetryRun: (run) => createRetryRun(run),
    // ★ D45：审核判 `fail` ⇒ 把意见交回**执行者**重做。
    //   与 `createRetryRun` 方向相反：那个重做的是**审核者**（它没按格式输出），
    //   这个重做的是**活本身**。
    createReworkRun: (run, verdict) => createReworkRun(run, verdict),
  })

  const executor = new RunExecutor({
    store,
    workRoot,
    // ★ D78：claude 个人配置的受管目录（CLAUDE_CONFIG_DIR 指向它）。
    //   缺省放数据目录下（agent 不可见）——绝不放任务工作目录，key 会漏。
    //   `claudeSettingsSource` 只由测试注入（NFR-T-01：测试不读真实配置）。
    claudeConfigDir: options.claudeConfigDir ?? join(options.dataDir, 'claude-config'),
    ...(options.claudeSettingsSource
      ? { claudeSettingsSource: options.claudeSettingsSource }
      : {}),
    // ★ D78 的 codex 版：codex 个人配置的受管目录（CODEX_HOME 指向它）。
    //   同样放数据目录下（agent 不可见）；`codexConfigSource` 只由测试注入。
    codexConfigDir: options.codexConfigDir ?? join(options.dataDir, 'codex-config'),
    ...(options.codexConfigSource
      ? { codexConfigSource: options.codexConfigSource }
      : {}),
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
    /**
     * §3.3b（2026-09）：执行任务/执行结果的两份**落盘文件**路径（执行器在
     * 完成时写好，按轮次编号、多轮不覆盖）。透传给审核 run 的第一句话做
     * 文件引用；null = 没有（报告类审核/落盘失败）⇒ 纯内联材料。
     */
    materialRefs: { taskPath: string; resultPath: string } | null
  }): Promise<{ runId: RunId | null; note: string }> {
    const agents = await store.listAgents(workspaceId)
    const executor = agents.find((a) => (a.id as string) === input.executorAgentId)
    if (!executor) {
      warn(`找不到执行 agent ${input.executorAgentId}，跳过自动审核`)
      return { runId: null, note: '没有串接审核：找不到这次执行用的 agent（它可能已被删除）' }
    }

    // ★ 谁审**这一次任务**：唯一出处是 `Run.reviewerAgentId`。
    //
    //   2026-10：agent 上那个"由谁来审它"**整个撤掉**了，所以这里从三态收成**两态**
    //   （原来的第二态"省略 ⇒ 跟随执行者的长期配置"那条路已经不存在）：
    //
    //     有 agent id ⇒ 用它审；
    //     缺字段 / `null` ⇒ 不审。
    //
    //   ⚠️ **组模式照旧自动审**：组把它的审核者展开进这个字段（`POST /api/runs`
    //      的 `groupId` 分支），变的只是**出处**——现在只有组能回答"谁审"。
    //      `null` 与缺字段在这里同义，所以不再区分，也不再拿它劝使用者"去智能体页
    //      配一个"（那个设置已经不存在了）。
    const override = input.executeRun.reviewerAgentId
    const wanted = override ?? null
    if (!wanted) {
      // ★ 缺字段与 `null` 在**行为**上同义（都不会有审核），但它们要**分开说**：
      //   一个是"你在新建任务时主动选了不审"，一个是"你没选组所以没人审"。
      //   把主动的选择说成"少了点什么"，下一步使用者就会去改一个本来不该改的配置；
      //   反过来把"你没选"说成"你选的"，他就永远找不到该动的地方。
      //
      //   ⚠️ 这个区别能说出口，是因为 run 记录**如实保真**：显式 `null` 写下的是
      //      `null`，省略写下的没有这个键（`executor.submit` 那几行不许把它们折成
      //      一个值——`reviewer-override.test.ts` 里有一条专门钉这件事）。
      if (input.executeRun.reviewerAgentId === null) {
        return {
          runId: null,
          note:
            '没有串接审核：这次任务在新建时选择了「这次不自动审核」——' +
            '这是明确的选择，不是配置错误。',
        }
      }
      return {
        runId: null,
        note:
          '没有串接审核：这条任务没有审核者（不自动审核）。' +
          '要自动审，建任务时选一个智能体组——组的审核者就是这条链的审核者。',
      }
    }

    const reviewer = agents.find((a) => a.id === wanted)
    if (!reviewer) {
      warn(
        `agent ${executor.name} 指定的审核者已不存在（${wanted}），跳过自动审核`,
      )
      // ★ 通知，不只是日志。
      //
      //   这一档与上面两档**不是一回事**：上面那两档是"本来就没打算审"（D28 里
      //   合法的选择），所以它们只写 run 记录、不打扰人；而这一档是**出事了**——
      //   配置过一次、现在失效了，于是这条产出**没被审，而状态一切正常**。
      //   只写一行日志的话，发现它的唯一途径是有人去翻这条 run 的日志。
      //   （同一条道理在"链路深度超限"那档已经用过：意外 + 有后果 ⇒ 进通知中心。）
      //
      //   ⚠️ 2026-10：这个字段现在只可能由**组**写进来，所以"已不存在"的含义收窄成
      //   一种：**组里那位审核者被删了**（组被改坏、或私有成员被删）。文案据此指向
      //   组页，而不是那个已经不存在了的「由谁审它」。
      await store.appendInboxItem({
        id: ulid(),
        workspaceId,
        type: 'review.reviewer_missing',
        severity: 'attention',
        title: '审核者不存在，这条产出没有被审核',
        body:
          `这条任务指定的审核者已经不在了（id ${wanted}）——它在建任务之后被删掉了。` +
          `这条产出因此没有被自动审核。去「智能体组」页把那队人补回来（组的审核者），` +
          `再重试这一次任务。`,
        issueId: issueIdOfSubject(input.executeRun),
        runId: input.executeRun.id,
        read: false,
        createdAt: Date.now(),
      })
      return {
        runId: null,
        note:
          `没有串接审核：这条任务指定的审核者已经不存在了（id ${wanted}）。` +
          `它是在建任务之后被删掉的——去「智能体组」页补回组的审核者，再重试。`,
      }
    }

    // 角色在这里再过一遍：提交时校验过一次，但 agent 的角色之后可以被改。
    // 真出现"审核者是执行者角色"，那必须跳过而不是照跑——否则 INV-1 就破了，
    // 而表现是"审核结论看着正常"。
    //
    // ★ 同样要发通知（理由与上面那条一样）：这是"配置过、现在失效"，
    //   而不是"本来就不审"。
    if (reviewer.role !== 'reviewer') {
      warn(`审核者 ${reviewer.name} 当前角色是 ${reviewer.role}，不是 reviewer，跳过自动审核`)
      await store.appendInboxItem({
        id: ulid(),
        workspaceId,
        type: 'review.reviewer_role_changed',
        severity: 'attention',
        title: '审核者的角色被改了，这条产出没有被审核',
        body:
          `「${reviewer.name}」现在的角色是「${reviewer.role}」，不再是「审核者」，` +
          `所以这条执行 run 的产出没有被自动审核（执行者与审核者不能是同一个人，INV-1）。` +
          `请重新指定一个审核者。`,
        issueId: issueIdOfSubject(input.executeRun),
        runId: input.executeRun.id,
        read: false,
        createdAt: Date.now(),
      })
      return {
        runId: null,
        note:
          `没有串接审核：agent「${reviewer.name}」的角色已经不是「审核者」了` +
          `（当前是「${reviewer.role}」）。请重新指定一个审核者。`,
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
      // ★ 把这一次的动作白名单**带下去**（D42）：新建任务页 ③ 上勾的那份决定，
      //   是"这一次允许触发什么"，而它要生效的地方是审核侧（判决契约 + 收口校验）。
      //   原样带（不要 `?? []`）：缺字段 = 跟随审核者自己的「行动权限」。
      ...(input.executeRun.allowedActions === undefined
        ? {}
        : { allowedActions: input.executeRun.allowedActions }),
      // ★ 把这一次的固定参数**带下去**（D43）：与白名单同一个判据——缺字段 =
      //   跟随审核者长期的固定参数（`Agent.actionParams`）。
      ...(input.executeRun.actionParams === undefined
        ? {}
        : { actionParams: input.executeRun.actionParams }),
      // ★ 把这一次的「调试」标记**带下去**（2026-10）：组里勾了调试的那几个动作，
      //   在审核侧也必须"不真跑、只记录"。缺字段 = 一个都没标（判据同白名单）。
      ...(input.executeRun.debugActions === undefined
        ? {}
        : { debugActions: input.executeRun.debugActions }),
      // ★ 把 issue 交给模型：判决里的动作参数需要它
      relatedIssueId: issueIdOfSubject(input.executeRun),
      // ★ §3.3b（2026-09）：执行任务/执行结果的文件引用（执行器落盘、多轮不覆盖）
      materialRefs: input.materialRefs,
      prompt: '请审核上面这次执行的产出，并按审核标准给出判决。',
    })
    return {
      runId: chainedRunId,
      note: chainedRunId
        ? `已串接审核：run ${chainedRunId}（审核者「${reviewer.name}」）。它继承本次的工作目录，` +
          `所以看得见这里留下的产出。`
        : `没有串接审核：审核者「${reviewer.name}」没有写「指令」——` +
          `审核者的身份与判断依据都写在那一栏里（2026-09 起「标准」并进「指令」）。` +
          `没有依据的审核不算审核，去「智能体」页给它写一段。`,
    }
  }

  const ingestor = new ReportIngestor({ store })
  // 探测一次当前 runtime，用于环境预检（不重复探测别的 runtime——
  // 没装的 CLI 谈不上"它家目录写不进去"）
  const probe2 = await backend.probe()

  const workspaceId = await bootstrap(store, info)

  // ══════════════════════════════════════════════════════════════════
  // ★ 启动时把老 agent 记录里**已撤下的字段**从磁盘上摘掉（2026-10）
  // ══════════════════════════════════════════════════════════════════
  //
  // 撤掉的是 `reviewerAgentId`（执行者的"由谁审它"）与行动权限那三个字段
  // （`allowedActions` / `debugActions` / `actionParams`）——理由见
  // `packages/protocol/src/agent-legacy.ts`。schema 字段删掉之后老记录里的键
  // **不会自己消失**，所以这里真的改一遍：使用者要的是"不要遗留旧数据"，
  // 不是"界面看不见"。
  //
  // ⚠️ 这里原来跑的是 `planDeadActionCleanup`（清掉"永远不可能被满足"的动作名，
  //    D41 收尾）。它的**对象已经不存在**——agent 上不再有动作名单，整份名单连同
  //    那个模块一起删掉了；这一步现在是"把整个字段摘掉"，比它更彻底。
  await runAgentLegacyCleanupOnce({ store, info })

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
    /**
     * ★ 任务级动作白名单（D42）：**从被审的那条执行 run 带下来**。
     *
     * `undefined` = 跟随这个审核者自己的「行动权限」（默认，也是报告/重试那条
     * 路的形态）；给了（含空数组）= 这一次就用它。
     *
     * ⚠️ **原样带，不要 `?? []`**：那会把"跟随"变成"这一次一个动作都不许触发"，
     *    而表现是判决永远只能给结论——没有任何地方会解释为什么。
     */
    allowedActions?: readonly ActionRefType[]
    /**
     * ★ 任务级固定参数（D43）：与白名单同一个判据——**从被审的那条执行 run
     *    带下来**。`undefined` = 跟随这个审核者长期配的那份；给了（含空对象）=
     *    这一次就用它（空对象 = 这一次不固定任何参数，是明确的选择）。
     */
    actionParams?: Readonly<Record<ActionRefType, Readonly<Record<string, unknown>>>>
    /**
     * ★ 任务级「调试」标记（2026-10）：与白名单、固定参数**同一个判据**——
     *   **从被审的那条执行 run 带下来**。缺字段 = 这一次没有任何动作被标调试
     *   （审核侧的落点是 `Run.debugActions`，见 executor 里那个取法）。
     *
     * ⚠️ 这一项是 2026-10 补上的：在此之前"标了调试"这件事只写在**审核者 agent**
     *    上，审核 run 直接读 agent 自己的那份，所以从来没有"带下去"这一步。
     *    agent 上那个字段撤掉之后，组配的「调试」必须跟着 run 走——不带的话
     *    **组里勾了调试、动作却真的跑起来了**（一个安静且危险的偏差：调试的
     *    全部意义就是"别真跑"）。
     */
    debugActions?: readonly ActionRefType[]
    /**
     * §3.3b（2026-09）：执行任务/执行结果的文件引用（执行器落盘的两份路径，
     * 多轮不覆盖）。进审核的第一句话做文件引用；null/缺省 = 纯内联材料
     * （报告类审核、重试）。
     */
    materialRefs?: { taskPath: string; resultPath: string } | null
  }): Promise<RunId | null> {
    const { reviewer } = input
    // ★ 技能按 agent 求解（不是全局挂一遍，D22）——
    //   D37 之后它对**审核者**只是"可选的参考/支持文件"，标准本身在
    //   `reviewStandard` 上。所以这里照旧取，但**不拿它当"能不能审"的判据**。
    const skills = await loadAgentSkills(store, reviewer)
    /**
     * ★ 资格判据（2026-09 的决定）：**身份非空**——也就是「指令」非空。
     *
     * 在此之前判的是"有没有审核标准"，而标准现在并进「指令」、不再单独设置
     * （见 `reviewerIdentity`）。⚠️ 用合成后的**身份**判、不用裸的 `instructions`：
     * 老数据里"只写了标准、没写指令"的审核者因此仍然能派审核——直接换判据会让它
     * **静默停摆**（产出照样跑、审核没了），而那正是这条兼容路径当初要防的事。
     */
    const identity = reviewerIdentity(reviewer, skills)
    if (identity.text === '') {
      warn(`agent ${reviewer.name} 没有写「指令」（审核者的身份与判断依据都在那里），无法审核`)
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
        // ⚠️ 这里原来带 `allowedActions: s.allowedActions`。D40 收口之后 skill
        //    载荷里没有这一项了（动作权限属于智能体组，见 `AgentGroup.allowedActions`）
        //    ——skill 从执行侧到审核侧都只剩"正文 + 支持文件"。
        // 支持文件必须一路带下去，否则装上来的脚本/参考文档到不了工作目录
        files: s.files ?? {},
      })),
      subject: input.subject,
      prompt: input.prompt,
      agentDefaultWorkDir: reviewer.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      chainDepth: input.chainDepth,
      // ★ 任务级白名单**原样带下去**（D42）：它是"这一次允许触发什么"这个决定在
      //   审核侧的落点——契约里列哪些动作、判决收口时按哪份校验，都用它。
      //   ⚠️ 2026-10 起它**只有组**这一个来源（agent 上那份已撤掉）。
      ...(input.allowedActions === undefined
        ? {}
        : { allowedActions: [...input.allowedActions] }),
      // ★ 任务级固定参数**原样带下去**（D43）：与白名单同一个判据（字段在不在）。
      ...(input.actionParams === undefined
        ? {}
        : { actionParams: input.actionParams }),
      // ★ 任务级「调试」标记**原样带下去**（2026-10）：同一个判据（字段在不在）。
      //   组里勾了调试 ⇒ 这条执行 run 上有它 ⇒ 审核侧也必须是调试（不然就真跑了）。
      ...(input.debugActions === undefined
        ? {}
        : { debugActions: [...input.debugActions] }),
      review: {
        kind: input.kind,
        title: input.title,
        body: input.body,
        inputBlobRef: input.inputBlobRef ?? null,
        relatedIssueId: input.relatedIssueId ?? null,
        materialRefs: input.materialRefs ?? null,
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
   * 材料从哪儿来（2026-09 之后**不再读上下文副本**——那个文件已经不再写）：
   * 材料**记在 run 记录上**（`previousMaterialRefs` / `previousReportBody`，
   * 见 executor 落库处）：
   *
   *   · **文件式审核**（执行 run 串出来的，`materialRefs` 有值）：读
   *     `rounds/<轮次>-result.md` 那个**结果文件**当材料（文件是完整原文，
   *     比重试塞截断的内联更对）；
   *   · **报告式审核**（没有执行 run ⇒ 没有文件）：`reportBody` 就是材料
   *     （它就是渲染时被标记包起来的那段正文，原样带回）。
   *
   * 两种都拿不到 ⇒ 空材料 ⇒ 不起这次重试（见调用处）。
   */
  async function previousMaterial(
    previous: Run,
  ): Promise<{
    body: string
    from: string | null
    materialRefs: { taskPath: string; resultPath: string } | null
  }> {
    // 文件式审核：读结果文件（路径在 run 记录上）。
    const refs = previous.materialRefs
    if (refs) {
      const fileBody = await readFile(refs.resultPath, 'utf8').catch(() => null)
      if (fileBody !== null) return { body: fileBody.trim(), from: refs.resultPath, materialRefs: refs }
    }
    // 报告式审核：报告正文就是材料。
    const reportBody = previous.reportBody
    if (reportBody !== null && reportBody !== undefined && reportBody.trim() !== '') {
      return { body: reportBody.trim(), from: null, materialRefs: null }
    }
    return { body: '', from: null, materialRefs: null }
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
    if (reviewerIdentity(agent, skills).text === '') {
      warn(`agent ${agent.name} 没有写「指令」，无法重试审核`)
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
        // ⚠️ 这里原来带 `allowedActions: s.allowedActions`。D40 收口之后 skill
        //    载荷里没有这一项了（动作权限属于智能体组，见 `AgentGroup.allowedActions`）
        //    ——skill 从执行侧到审核侧都只剩"正文 + 支持文件"。
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
      // ★★ 任务级那四样**原样带下去**：审核者、动作白名单、固定参数、「调试」标记。
      //
      //   重试是"同一条任务的再给一次机会"，不是另一条任务——它审的是同一份产出、
      //   同一队人、同样的动作许可。缺字段 = 跟随（与其它三处同一套三态纪律）。
      //
      //   ⚠️ 这一组是 2026-10 补上的。在此之前这里**什么都不带**，而那时"缺字段"
      //      会回退到**审核者 agent 自己**那份白名单，所以还凑合能用；agent 上那个
      //      字段撤掉之后，"缺字段"就真的是**空白名单**——重试出来的审核拿到的契约
      //      会写着"这次不要写动作"，判决一旦引用动作就被判不合规。使用者看到的
      //      则是"同一份产出、同一队人，重试一下结论就收窄了"。
      ...(previous.reviewerAgentId === undefined
        ? {}
        : { reviewerAgentId: previous.reviewerAgentId }),
      ...(previous.allowedActions === undefined
        ? {}
        : { allowedActions: [...previous.allowedActions] }),
      ...(previous.actionParams === undefined ? {} : { actionParams: previous.actionParams }),
      ...(previous.debugActions === undefined
        ? {}
        : { debugActions: [...previous.debugActions] }),
      review: {
        kind: 'run-output',
        title: `重试审核（原 run ${previous.id.slice(-8)}）`,
        // ★ 原样的材料（文件式审核读结果文件 / 报告式按标记切，见 `previousMaterial`），
        //   不是空串
        body: material.body,
        inputBlobRef: null,
        relatedIssueId: issueIdOfSubject(previous),
        // ★ §3.3b：上次是文件式审核就把引用**带下去**——重试 run 的第一句话
        //   也走文件引用（不内联材料），与文件式的其它审核一个形状。
        materialRefs: material.materialRefs,
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
   * 审核判 `fail` ⇒ 派生一条**返工** run（D45）：把审核意见交回执行者重做。
   *
   * ══════════════════════════════════════════════════════════════════
   * 与 `createRetryRun` 的三处关键差别
   * ══════════════════════════════════════════════════════════════════
   *
   * | | `createRetryRun` | `createReworkRun` |
   * |---|---|---|
   * | 重做的是谁 | **审核者**（它没按格式输出判决） | **执行者**（活本身不合格） |
   * | run 的类型 | `review`（重发一次审核） | `execute`（重做一次活） |
   * | 链深 | 不变（同一步的再试） | **+1**（确实是往前走了一步） |
   *
   * 返工之后**审核会再串一次**：新的执行 run 收尾时照常走 `autoChainReview`，
   * 于是"执行 → 审核"这个回路能一直转到额度用完为止。
   *
   * ⚠️ **任务级的三个覆盖必须一起带下来**（`reviewerAgentId` / `allowedActions` /
   *    `actionParams`）：它们表达的是"这一次任务怎么跑"的决定，而返工 run 还是
   *   同一次任务。不带下去的话，第二轮会悄悄退回 agent 的长期配置——表现是
   *   第一轮勾掉的动作在第二轮又活了，而没有任何地方会提示这件事。
   */
  async function createReworkRun(run: Run, verdict: VerdictRecord): Promise<string | null> {
    // ① 被审的那条执行 run：返工的对象是它，目录、会话、agent 都从它来。
    if (run.subject.type !== 'run') {
      warn(`返工只对"审一条 run"有意义，subject 是 ${run.subject.type}，这次不返工`)
      return null
    }
    const target = await store.getRun(run.subject.id as RunId)
    if (!target) {
      warn(`找不到被审的执行 run ${run.subject.id}，这次不返工`)
      return null
    }
    if (target.kind !== 'execute') {
      // 审一条审核 run（理论上不该出现）⇒ 不能把"返工"套上去
      warn(`被审的 run ${target.id.slice(-8)} 不是执行 run，这次不返工`)
      return null
    }

    const agent = await store.getAgent(target.agentId)
    if (!agent) {
      warn(`无法为返工找到执行者 ${target.agentId}`)
      return null
    }

    const skills = await loadAgentSkills(store, agent)
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
        ...(s.description ? { description: s.description } : {}),
        files: s.files ?? {},
      })),
      // ★ subject 用**被审那条 run 的**（也就是原任务），不是审核 run 的
      //   （审核 run 的 subject 是 `{type:'run'}`——照抄会变成"让执行者去做
      //   一条 run"，语义完全错，而且它会被当成一条新的审核链）。
      subject: target.subject,
      prompt: reworkPrompt(verdict),
      // ★ 同一个工作目录：返工是"在原地改"，不是"另起一摊"。
      //   落进空目录会让它看不见上次干了什么、也看不见自己留下的文件。
      workDir: target.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      // ★ 链深 +1：这是**往前走了一步**（与 `createRetryRun` 的"同一步再试"
      //   不同）。额度判据就靠它——`maxReworks` 是"允许几次"，它就是"已经几次"。
      chainDepth: target.chainDepth + 1,
      // ★ 会话恢复：执行者上次干过这活，让它接着上下文改，而不是从零再来一遍。
      resumeFromRunId: target.id,
      // ★ 任务级决定原样带下去（缺字段 = 跟随长期配置，这里也一样：只有原来
      //   真的给了才带，不能 `?? null` / `?? []`——那会把"照旧"变成"明确不用"）。
      ...(target.maxReworks !== undefined ? { maxReworks: target.maxReworks } : {}),
      ...(target.reviewerAgentId === undefined
        ? {}
        : { reviewerAgentId: target.reviewerAgentId }),
      ...(target.allowedActions === undefined
        ? {}
        : { allowedActions: [...target.allowedActions] }),
      ...(target.actionParams === undefined ? {} : { actionParams: target.actionParams }),
    })

    if (outcome.kind !== 'accepted') {
      warn(`返工 run 未被受理：${outcome.kind}`)
      return null
    }
    info(`审核不通过，已派生返工 run：${runId}（第 ${target.chainDepth + 1} 次）`)
    return runId
  }

  /**
   * 返工 run 的指令：**审核意见**（D45）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么必须先说"这是审核意见"，再说"请改"
   * ══════════════════════════════════════════════════════════════════
   *
   * 执行者拿到的是一个**新的 run**（不是"有人给我留言了"），如果不点明这层
   * 来历，它会以为这是又一个新任务、从头再做一遍——上次干过什么、为什么被打回
   * 全都不知道。而"接着上次改"恰恰是返工省下的那部分成本。
   *
   * 意见本身按**结构化**给（理由码 + 逐条 findings + 证据指向），不是一段转述：
   * findings 里的 `evidence.locator` 是审核者指回产出原文的位置，少掉它执行者
   * 只能靠猜"它说的到底是哪一段"。
   */
  function reworkPrompt(verdict: VerdictRecord): string {
    const lines: string[] = [
      '上一次的产出**没有通过审核**。请按下面的审核意见修改后重新交付。',
      '',
      `审核结论：${verdict.conclusion}（理由码：${verdict.reasonCode}）`,
    ]
    if (verdict.findings.length > 0) {
      lines.push('', '审核意见：')
      for (const f of verdict.findings) {
        lines.push(`- [${f.severity}] ${f.summary}`)
        for (const e of f.evidence) {
          // locator / excerpt 都是可空的：有什么给什么，不编
          const where = [e.locator, e.excerpt].filter(Boolean).join('：')
          if (where) lines.push(`    证据：${where}`)
        }
        // `detail` 是判决里唯一自由发挥的字段（往往放着"建议怎么改"）
        if (f.detail !== null && f.detail !== undefined) {
          lines.push(`    补充：${JSON.stringify(f.detail)}`)
        }
      }
    }
    lines.push(
      '',
      '要求：',
      '- **只改需要改的地方**，不要顺手扩大范围或重写已经通过的部分。',
      '- 完成后照常给出一份报告：改了什么、为什么这样改、还有哪些不确定的地方。',
    )
    return lines.join('\n')
  }

  /**
   * ⚠️ 这里原来还有一个 `deriveRunFromAction()`——`issue.assign_agent` 的
   * "指派之后派生一条新 run"那一半（写上 `derivedFrom`、按链路算 `chainDepth`）。
   *
   * D41 把内置动作全部移除之后，**没有任何动作能派生 run 了**（工具脚本只能改
   * 工作目录里的东西，它没有平台 API），所以这份实现连同 `ActionRunner` 的
   * `deriveRun` 回调一起删掉了。
   *
   * ⚠️ **但"判完之后派生一条新 run"这件事已经回来了**（D45）：审核判 `fail`
   * 时派生的**返工 run** 就是它。差别是触发者不再是某个动作，而是**判决本身**
   * ——受控得多：它由 `maxReworks` 限额、由 `chainDepth` 计数、由终态判决收口，
   * 走的是 `createReworkRun` 而不是动作回调。
   */

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
        /**
         * ★ 缓存头是**正确性**，不是优化。
         *
         * 原来这里一个缓存头都不发（`index.html` 既没有 `Cache-Control` 也没有
         * `ETag`），于是浏览器拿这份外壳没有任何办法：既不知道能不能复用，也没有
         * 依据去问"变了没有"。表现是**重建前端之后，早就开着的标签页仍然跑旧
         * 前端**——而两边都不报错，只能靠人猜"你刷新过没有"。见
         * `apps/web/server/index.ts` 里 `cacheHeadersFor` 的注释。
         *
         * 带 `If-None-Match` 回来问的时候回 **304**：外壳每次都核对（`no-cache`），
         * 但核对本身应该便宜——不然每次刷新都要重下一份 HTML。
         */
        if (req.headers['if-none-match'] === asset.etag) {
          res.writeHead(304, {
            etag: asset.etag,
            'cache-control': asset.cacheControl,
          })
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': asset.contentType,
          'content-length': asset.body.length,
          // 同源页面，不需要放宽任何跨源策略
          'x-content-type-options': 'nosniff',
          'cache-control': asset.cacheControl,
          etag: asset.etag,
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
      //   根本看不出来——第二个适配器插上了也没人知道。每一项都带
      //   `evidence`（见 RuntimeDescriptor 的注释）。
      //
      // ⚠️ 2026-10（使用者决定）：**未接真实 CLI 的 runtime 不进这个数组**。
      //   当前只有 generic（`evidence: 'provisional'`，命令名 agent-cli 是猜的、
      //   从未对照真实 CLI 验证过）——它没有实际功能，列出来只会让使用者
      //   以为它可用（"为什么我能选 agent-cli？"）。
      //   判据是**证据等级**而不是 runtime 名字：加第四个未验证 runtime 时
      //   会自动隐藏，不用再来改这一处。
      //   这只影响 UI 能看到的清单；开发者通道不受影响——`--runtime-key
      //   generic`、`--verify-runtime all`、以及直接调 API 建 generic agent
      //   仍然可用（校验在 `resolveRuntimeKey`，与这个数组无关）。
      const adapterEntries = Object.entries(knownRuntimeAdapters()).filter(
        ([, adapter]) => adapter.descriptor.evidence === 'verified',
      )
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
        // ★ 界面语言跟着身份一起给：页面启动时就要知道用哪种语言渲染，
        //   而不是先闪一下中文再切过来（D39）
        locale: (await readWorkspaceSettings(store, workspaceId)).locale,
        // ★ D77：claude 的 WebSearch/WebFetch 开关（默认开）。设置页据此渲染
        //   那个开关——"界面显示的"与"executor 真的用的"走同一份读（上面的
        //   readWorkspaceSettings），不许分叉。
        webSearchEnabled: (await readWorkspaceSettings(store, workspaceId)).webSearchEnabled,
        /**
         * ★ 这份界面是哪一版（构建产物文件名）。
         *
         * 添加它的理由是一次真实误判：使用者报"聊天页不工作、任务页正常"，查下来
         * daemon 与当前前端都是好的——他看的是一个**早就开着、没有刷新**的标签页。
         * 这类"两边都不报错"的错位只能靠一句话回答："你现在跑的是哪一版前端"。
         */
        webBuild: await webBuildId(),
        runtimes,
        capabilities: [
          Capability.SseResume,
          Capability.Artifacts,
          // ★ D42：页面要据此决定"这一次换人审 / 这一次不审"给不给。
          //   理由见 `Capability.ReviewerOverride` 的注释——旧 daemon 会**静默
          //   忽略**那个字段，于是界面说的与实际发生的不一致。
          Capability.ReviewerOverride,
          // ★ 任务级动作白名单是**另一个**字段，所以是另一个标志（理由见协议里
          //   `Capability.TaskActionWhitelist`）：合成一个会漏掉"支持前者、不支持
          //   后者"的中间态——那时勾选会被静默丢掉，而使用者以为这次允许了它动手。
          Capability.TaskActionWhitelist,
          // ★ D46：人工裁决。理由见协议里 `Capability.HumanVerdict` 的注释——
          //   要点是**别让界面画一个它兑现不了的承诺**：一个点了没反应的
          //   「人工通过」按钮，会让人以为自己已经通过了审核，而任务还卡着。
          Capability.HumanVerdict,
          // ★ D47：放弃任务。它与人工裁决是**两次独立的交付**，所以是两个标志
          //   （理由见协议里 `Capability.IssueAbandon`）：放弃只碰 issue 的状态、
          //   不碰判决，合成一个会漏掉"支持前者、不支持后者"的中间态。
          Capability.IssueAbandon,
          // ★ D49 ⑩：对话自带 skill（`Conversation.skillIds`）。界面据此决定
          //   "没人挂的 skill"给不给选——理由见协议里 `Capability.ConversationSkills`
          //   的注释：旧 daemon 会静默忽略那个字段，而"只重建前端、不重启 daemon"
          //   正是日常做法。
          Capability.ConversationSkills,
          // ★ D49 ⑩ 的第二半：对话级的工作目录（聊天右栏底部那一栏）。与上面
          //   那条分开是**两个字段、两份契约**：那条决定 skill 怎么进去，这条
          //   决定文件怎么看出来。合成一个会漏掉中间态——那时界面画出一栏，
          //   而旧 daemon 上它的接口 404（"取不到"必须说出来，不能安静地空着，
          //   这是任务页那次实测的教训）。
          Capability.ConversationFiles,
          // ★ D70：智能体组（`/api/agent-groups` 存在 + `POST /runs` 认
          //   `groupId`）。界面据此决定"从智能体组"那一档给不给——理由见协议里
          //   `Capability.AgentGroups` 的注释：旧 daemon 会静默忽略 `groupId`，
          //   于是组的安排全部落空而两边都不报错。
          Capability.AgentGroups,
          // ★ 第二轮：工作流模式（`createAgents` + `ownerGroupId`）。界面据此才给
          //   「新建私有」与模式展示——理由见协议里 `Capability.AgentGroupsWorkflow`
          //   的注释：旧 daemon 会静默忽略 `ownerGroupId`，把私有智能体建成全局的。
          //   ⚠️ 这个数组是**硬编码清单**：只加协议枚举值、忘了注册到这里，界面
          //   就一直看不到新能力（实测踩过：前端正确藏起「新建私有」，而 daemon
          //   报的清单里根本没有它）。
          Capability.AgentGroupsWorkflow,
        ],
      })
      return
    }

    // ── agents / issues（M0 看板需要的最小 CRUD）──
    if (req.method === 'GET' && path === '/api/agents') {
      const [allAgents, settings] = await Promise.all([
        store.listAgents(workspaceId),
        readWorkspaceSettings(store, workspaceId),
      ])
      // ★ 过滤私有智能体（第二轮）：`ownerGroupId` 有值 = 私有，**只属于它那个
      //   组**。界面（智能体页 / 建任务页的手动候选 / 组里的"选全局"下拉）都拿
      //   不到它——它只能经组到达任务。⚠️ 过滤**只在路由层**：store 层保持全量，
      //   `autoChainReview` 等内部链路按 id 找执行者/审核者，私有 agent 必须能
      //   找到——过滤到执行链路上，私有审核者就会"找不到"。
      const agents = allAgents.filter((a) => a.ownerGroupId === undefined)
      // ★ 默认智能体跟着列表一起给：界面要在卡片上标「默认」，新建任务页要用它
      //   当预选项——两处都拿同一份，不各自猜。
      sendJson(res, 200, { agents, defaultAgentId: settings.defaultAgentId })
      return
    }

    // ── 智能体组（D70 增量添加）：一队 agent 的编队 ──
    //
    // 组是「执行 → 审核 → 行动」整条链的配置单位，也是"谁审我""判完能做什么"的
    // **唯一出处**（2026-10：agent 上那两个设置撤掉了，现在只有组能回答）。提交 run
    // 时带 `groupId` 由 `POST /api/runs` 展开成 run 上的字段——这里只管组的 CRUD
    // 与形态校验（`checkGroupShape`：恰好 1 执行 + 1 审核）。
    //
    // ⚠️ 写入口的校验与 agents 那套共用同一个函数（`parseAllowedActions` /
    //    `parseActionParams`）：动作白名单与固定参数的"为什么拒"的说法
    //    两处必须一致，各写一遍迟早会漂。

    if (req.method === 'GET' && path === '/api/agent-groups') {
      const groups = await store.listGroups(workspaceId)
      // ★ 带上成员（第二轮）：私有成员不进全局 `GET /api/agents`，界面上组的
      //   名字/角色只能从这份数据 join——否则私有成员在组里"查无此人"。
      const ids = new Set<string>(groups.flatMap((g) => g.members.map((id) => id as string)))
      const members = (await store.listAgents(workspaceId)).filter((a) => ids.has(a.id as string))
      sendJson(res, 200, { groups, members })
      return
    }

    if (req.method === 'POST' && path === '/api/agent-groups') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const parse = await parseGroupFields(body, store, workspaceId)
      if (!parse.ok) {
        sendJson(res, 400, { error: parse.error })
        return
      }
      const drafts = await parseGroupCreateAgents(body, store, workspaceId, warn)
      if (!drafts.ok) {
        sendJson(res, 400, { error: drafts.error })
        return
      }
      const groupId = ulid() as AgentGroup['id']

      // ★ 写入前先算最终形态（已有成员 + 草稿角色）——不对就一个都不建
      const prospective = await shapeWithDrafts(parse.value.members ?? [], drafts.value, store, workspaceId)
      if (!prospective.ok) {
        sendJson(res, 400, { error: prospective.issues.join('；') })
        return
      }

      // 建私有成员（`ownerGroupId = 新组 id`，组是它们的创建入口）
      const created = await createDraftAgents(drafts.value, groupId, workspaceId, store)
      const now = Date.now()
      const members = [...(parse.value.members ?? []), ...created.map((a) => a.id as string)]
      // POST 分支：parseGroupFields 已保证 name/members 必填、其余有默认值
      // （allowedActions=[] / actionParams={} / debugActions=[] / maxReworks=0 /
      // enabled=true / mode='workflow'），所以这里的 `!` 断言是安全的。
      const group: AgentGroup = {
        id: groupId,
        workspaceId,
        name: parse.value.name!,
        members: members as AgentGroup['members'],
        allowedActions: parse.value.allowedActions!,
        actionParams: parse.value.actionParams!,
        debugActions: parse.value.debugActions!,
        maxReworks: parse.value.maxReworks!,
        enabled: parse.value.enabled ?? true,
        mode: parse.value.mode ?? 'workflow',
        createdAt: now,
        updatedAt: now,
      }
      await store.insertGroup(group)
      sendJson(res, 201, { group, members: await membersOfGroup(group, store) })
      return
    }

    const groupMatch = /^\/api\/agent-groups\/([^/]+)$/.exec(path)
    if (groupMatch) {
      const groupId = decodeURIComponent(groupMatch[1]!) as AgentGroup['id']

      if (req.method === 'GET') {
        const group = await store.getGroup(groupId)
        if (!group) {
          sendJson(res, 404, { error: `智能体组不存在：${groupId}` })
          return
        }
        sendJson(res, 200, { group, members: await membersOfGroup(group, store) })
        return
      }

      if (req.method === 'PATCH' || req.method === 'PUT') {
        const current = await store.getGroup(groupId)
        if (!current) {
          sendJson(res, 404, { error: `智能体组不存在：${groupId}` })
          return
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>

        // 只认识这些字段——未知字段**明确拒绝**而不是静默忽略（与 agents
        // PATCH 同一条规矩：拼错字段时静默忽略会让人以为保存成功了）。
        // ⚠️ `mode` **不在这里**：模式只在创建时定（这轮只有 'workflow'，改了也
        //    没意义；未来模式出现时再放开）。`createAgents` 在这里（编辑组时
        //    也能补建私有成员）。
        const allowed = new Set([
          'name',
          'members',
          'allowedActions',
          'actionParams',
          'debugActions',
          'maxReworks',
          'enabled',
          'createAgents',
        ])
        const unknown = Object.keys(body).filter((k) => !allowed.has(k))
        if (unknown.length > 0) {
          sendJson(res, 400, {
            error: `不认识的字段：${unknown.join(', ')}。可改的有：${[...allowed].join(', ')}`,
          })
          return
        }

        const parse = await parseGroupFields(body, store, workspaceId, current)
        if (!parse.ok) {
          sendJson(res, 400, { error: parse.error })
          return
        }
        const drafts = await parseGroupCreateAgents(body, store, workspaceId, warn)
        if (!drafts.ok) {
          sendJson(res, 400, { error: drafts.error })
          return
        }

        // 最终 members = 请求给的（或保留当前） + 新建草稿的 id
        const baseMembers = (parse.value.members ?? current.members) as string[]
        const prospective = await shapeWithDrafts(baseMembers, drafts.value, store, workspaceId)
        if (!prospective.ok) {
          sendJson(res, 400, { error: prospective.issues.join('；') })
          return
        }
        const created = await createDraftAgents(drafts.value, groupId, workspaceId, store)
        const finalMembers = [...baseMembers, ...created.map((a) => a.id as string)]

        const group: AgentGroup = {
          ...current,
          ...(parse.value.name !== undefined ? { name: parse.value.name } : {}),
          members: finalMembers as AgentGroup['members'],
          ...(parse.value.allowedActions !== undefined
            ? { allowedActions: parse.value.allowedActions }
            : {}),
          ...(parse.value.actionParams !== undefined ? { actionParams: parse.value.actionParams } : {}),
          ...(parse.value.debugActions !== undefined ? { debugActions: parse.value.debugActions } : {}),
          ...(parse.value.maxReworks !== undefined ? { maxReworks: parse.value.maxReworks } : {}),
          ...(parse.value.enabled !== undefined ? { enabled: parse.value.enabled } : {}),
          updatedAt: Date.now(),
        }
        const updated = await store.updateGroup(group)
        if (!updated) {
          sendJson(res, 404, { error: `智能体组不存在：${groupId}` })
          return
        }
        sendJson(res, 200, { group, members: await membersOfGroup(group, store) })
        return
      }

      if (req.method === 'DELETE') {
        const group = await store.getGroup(groupId)
        if (!group) {
          sendJson(res, 404, { error: `智能体组不存在：${groupId}` })
          return
        }
        // ★ 级联删私有成员（第二轮，使用者拍板「提示后一起删」）。
        //   按 `ownerGroupId` 删（不是按 `members` 删）：建到一半/被移走的孤儿
        //   私有 agent 也一起清掉。先删 agent 再删组——失败时组还在，不会出现
        //   "组没了、私有 agent 悬着"。
        const all = await store.listAgents(group.workspaceId)
        const privateAgents = all.filter((a) => (a.ownerGroupId as string) === groupId)
        for (const a of privateAgents) {
          await store.deleteAgent(a.id)
        }
        const deleted = await store.deleteGroup(groupId)
        sendJson(res, deleted ? 200 : 404, { ok: deleted, removedPrivateAgents: privateAgents.length })
        return
      }
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

      // ★ **没有"取消默认"**：必须有一个默认（使用者的要求）。要换就直接设成另一个，
      //   原来那个自动让位——那样"新建任务交给谁"永远是确定的，不会变成一个
      //   每次都要现想的问题。
      if (typeof raw !== 'string' || raw.trim() === '') {
        sendJson(res, 400, {
          error:
            'agentId 必须是某个执行者的 id —— 默认智能体必须有一个（要换就设成另一个，' +
            '原来那个会自动让位）',
        })
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
      // ★ 私有执行者不能当默认（第二轮）：界面上的候选池过滤了私有 agent，选
      //   不到它；接口上补一刀——否则"默认交给一个谁也看不见的智能体"。
      if (agent.ownerGroupId !== undefined) {
        sendJson(res, 400, {
          error: `「${agent.name}」是私有智能体（属于智能体组），不能当默认——` +
            '它只能经组到达任务，不会出现在手动候选里。',
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
    // ── 界面语言（D39）──
    //
    // 存在 workspace 上，因为 daemon 也要用它渲染第一句话里的语言指令——
    // 浏览器偏好的话，"界面英文、模型仍被要求中文回答"就成了默认结果。
    if (req.method === 'PUT' && path === '/api/workspace/locale') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const raw = body['locale']
      if (!isLocale(raw)) {
        sendJson(res, 400, { error: `locale 必须是 'zh' 或 'en'（收到 ${JSON.stringify(raw)}）` })
        return
      }
      const workspace = await store.getWorkspace(workspaceId)
      if (!workspace) {
        sendJson(res, 404, { error: `workspace 不存在：${workspaceId}` })
        return
      }
      await store.insertWorkspace({ ...workspace, locale: raw, updatedAt: Date.now() })
      sendJson(res, 200, { locale: raw })
      return
    }

    // ── claude 的 WebSearch / WebFetch 开关（D77）──
    //
    // 这两个是服务端工具：官方端点真执行，第三方兼容端点（百炼/DeepSeek）无
    // 执行器会幻觉搜索结果。全局开关默认开（尊重功能）；关掉时 executor 把
    // WebSearch/WebFetch 并进 claude 的 `--disallowedTools`（退化为 Bash+curl
    // 调研）。校验收在**布尔字面量**上：收到字符串 "false" 不算关（前端传
    // JSON 布尔，不会出现那种情况；但接口自己别把"假值"当"关了"）。
    if (req.method === 'PUT' && path === '/api/workspace/web-search') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      if (typeof body['enabled'] !== 'boolean') {
        sendJson(res, 400, { error: `enabled 必须是布尔值（收到 ${JSON.stringify(body['enabled'])}）` })
        return
      }
      const workspace = await store.getWorkspace(workspaceId)
      if (!workspace) {
        sendJson(res, 404, { error: `workspace 不存在：${workspaceId}` })
        return
      }
      await store.insertWorkspace({ ...workspace, webSearchEnabled: body['enabled'], updatedAt: Date.now() })
      sendJson(res, 200, { enabled: body['enabled'] })
      return
    }

    if (req.method === 'GET' && path === '/api/first-sentence/templates') {
      const stored = await readWorkspaceSettings(store, workspaceId)
      /**
       * ★ 返回的是**迁移后**的样子（2026-09 三块组装、2026-10 三框改造）。
       *
       * 库里存着的老模版（框架框）里可能还写着退役变量（`{{instructions}}` 那六个）。
       * 执行器渲染前会摘掉它们（内容由平台组装进 ②③），所以**界面必须看到同一份**
       * ——否则使用者在设置里看到的是一份"写了却不起作用"的文本，而真正投递的是
       * 另一份。
       *
       * `adjustments` 按 kind × block 把"调了什么"如实带出去，界面据此告诉他
       * "平台替你调整过，内容一个字没丢"。**不静默**。
       */
      const flat: Record<FirstSentenceKind, { frame: string; identity: string; task: string }> = {
        execute: {
          frame: stored.executeTemplate,
          identity: stored.executeIdentityTemplate,
          task: stored.executeTaskTemplate,
        },
        review: {
          frame: stored.reviewTemplate,
          identity: stored.reviewIdentityTemplate,
          task: stored.reviewTaskTemplate,
        },
        chat: {
          frame: stored.chatTemplate,
          identity: stored.chatIdentityTemplate,
          task: stored.chatTaskTemplate,
        },
      }
      /**
       * 迁移某一条链路的三块，逐块报告"摘了什么、哪几行成了空标题"。
       * `removed` / `orphanLines` 只可能来自**框架框**（身份/任务框是新字段，
       * 老数据里没有）；但接口按 kind × block 给形状，界面据此逐块显示。
       */
      const migrateKind = (
        t: { frame: string; identity: string; task: string },
      ): {
        next: BlockTemplates
        perBlock: Record<TemplateBlock, { removed: string[]; orphanLines: string[] }>
      } => {
        const frame = migrateTemplate(t.frame)
        const identity = migrateTemplate(t.identity)
        const task = migrateTemplate(t.task)
        return {
          next: { frame: frame.next, identity: identity.next, task: task.next },
          perBlock: {
            frame: { removed: frame.removed, orphanLines: frame.orphanLines },
            identity: { removed: identity.removed, orphanLines: identity.orphanLines },
            task: { removed: task.removed, orphanLines: task.orphanLines },
          },
        }
      }
      const executed = migrateKind(flat.execute)
      const reviewed = migrateKind(flat.review)
      const chatted = migrateKind(flat.chat)
      const current = {
        execute: executed.next,
        review: reviewed.next,
        chat: chatted.next,
      }
      sendJson(res, 200, {
        defaults: DEFAULT_TEMPLATES,
        variables: TEMPLATE_VARIABLES,
        // ★ 当前生效的那几份（空 = 平台默认）。它是**全局配置**，
        //   与任何 agent 无关——所以这里不按 agent 分。
        current,
        adjustments: {
          execute: executed.perBlock,
          review: reviewed.perBlock,
          chat: chatted.perBlock,
        },
      })
      return
    }

    // ── 改全局的第一句话模版（D32，2026-10 起三块各一份）──
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
      // 请求体：{ execute?: { frame?, identity?, task? }, review?: {...}, chat?: {...} }
      // 未传的块 = 别动它；空串 / null = 回到平台默认。
      // ★ 平面键映射（kind × block → workspace 键）：执行/审核/聊天 × 框架/身份/任务
      //   = 九个键。老键 `executeTemplate` 等就是框架框（改名会弄丢老 workspace 内容）。
      const TEMPLATE_KEYS: Record<
        FirstSentenceKind,
        Record<TemplateBlock, keyof Workspace>
      > = {
        execute: {
          frame: 'executeTemplate',
          identity: 'executeIdentityTemplate',
          task: 'executeTaskTemplate',
        },
        review: {
          frame: 'reviewTemplate',
          identity: 'reviewIdentityTemplate',
          task: 'reviewTaskTemplate',
        },
        chat: {
          frame: 'chatTemplate',
          identity: 'chatIdentityTemplate',
          task: 'chatTaskTemplate',
        },
      }
      const patch: Record<string, string> = {}
      for (const kind of ALL_KINDS) {
        const kindBody = body[kind]
        if (kindBody === undefined || kindBody === null) continue
        if (typeof kindBody !== 'object' || Array.isArray(kindBody)) {
          sendJson(res, 400, { error: `${kindNameForApi(kind)}的模版必须是对象（{ frame, identity, task }）` })
          return
        }
        const blocks = kindBody as Record<string, unknown>
        for (const block of TEMPLATE_BLOCKS) {
          /**
           * ★ 存进来时先**迁移**再校验（2026-09）：老模版里那六个退役变量会被摘掉，
           *   摘完再判合不合法。不迁移的话，使用者"原样再存一遍"会得到 400——
           *   而那正是他上次存进去的内容，看起来像界面坏了。
           */
          const raw = blocks[block]
          const seen = typeof raw === 'string' ? migrateTemplate(raw) : null
          const parsed = parseTemplateField(kind, block, seen ? seen.next : raw)
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error })
            return
          }
          // undefined = 这次没传（别动它）；空串 = 回到平台默认
          if (parsed.value !== undefined) patch[TEMPLATE_KEYS[kind][block]] = parsed.value
        }
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
      /**
       * ★ 三条链路都能预览（2026-09 加了「聊天」）。
       *
       * ⚠️ 这里写死两条时的表现是**界面上一个按钮直接报错**：设置里第三个页签
       *   （聊天）上点「预览」，得到的是"kind 必须是 execute 或 review"——
       *   而那句话对使用者毫无意义（他点的就是界面上的页签）。判据与写入口同一份：
       *   `ALL_KINDS` 里有什么，这里就收什么。
       */
      if (typeof kindRaw !== 'string' || !(ALL_KINDS as readonly string[]).includes(kindRaw)) {
        sendJson(res, 400, {
          error: `kind 必须是 ${ALL_KINDS.join(' / ')} 之一`,
        })
        return
      }
      const kind = kindRaw as FirstSentenceKind
      // ★ 2026-10：预览指定**哪一块**（框架/身份/任务）。只渲染那一块——作者想看的
      //   就是"我的 ② 身份框会变成什么"，不是把三块拼起来再看。
      const blockRaw = body['block']
      if (typeof blockRaw !== 'string' || !(TEMPLATE_BLOCKS as readonly string[]).includes(blockRaw)) {
        sendJson(res, 400, { error: `block 必须是 ${TEMPLATE_BLOCKS.join(' / ')} 之一` })
        return
      }
      const block = blockRaw as TemplateBlock
      const raw = body['template']
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        sendJson(res, 400, { error: 'template 必须是字符串（留空 = 用平台默认模版）' })
        return
      }
      const text = typeof raw === 'string' ? raw.trim() : ''
      // 与保存时同一道关：预览里能过，保存就能过（反之也一样）
      if (text !== '') {
        const check = validateTemplate(kind, block, text)
        if (!check.ok) {
          sendJson(res, 400, { error: check.error })
          return
        }
      }
      const sample = SAMPLE_FIRST_SENTENCE_INPUTS[kind]
      // ★ 只渲染被预览的那一块（其它两块走平台默认，与真实投递一致）
      const rendered = buildBlocks({
        ...sample,
        template: { [block]: text === '' ? null : text },
      } as never)
      sendJson(res, 200, { text: rendered[block] })
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

      // ★ 只认识这些字段——未知字段**明确拒绝**（与 PATCH 同一条规矩，2026-10 补上）。
      //
      //   新建这条路原来对未知字段是**静默忽略**的，而 2026-10 撤掉了四个字段
      //   （`reviewerAgentId` / `allowedActions` / `actionParams` / `debugActions`）：
      //   一个还在照旧发它们的客户端会拿到 201，然后配置**一个字节都没写进去**
      //   ——使用者以为"我给它配了审核者/动作权限"，下次打开发现配置不见了，谁也
      //   说不清是哪一步丢的。拼错字段名（`instruction`）也是同一个后果。
      //   所以这里改成拒绝，并把"可改的有"列出来。
      const allowedKeys = new Set([
        'name',
        'instructions',
        'model',
        'runtimeKey',
        'workDir',
        'skillIds',
        'env',
        'role',
        'reviewStandard',
        // 私有归属：『组里新建私有』是它唯一的生产入口（见下面那段）
        'ownerGroupId',
      ])
      const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k))
      if (unknownKeys.length > 0) {
        sendJson(res, 400, {
          error: `不认识的字段：${unknownKeys.join(', ')}。可改的有：${[...allowedKeys].join(', ')}`,
        })
        return
      }

      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (name === '') {
        sendJson(res, 400, { error: 'agent 需要 name（非空字符串）' })
        return
      }
      if (name.length > 100) {
        sendJson(res, 400, { error: 'name 太长了（上限 100 字符）' })
        return
      }

      // ★ 私有归属（第二轮）：`ownerGroupId` 有值 = 这个 agent 属于某个组。
      //   「组里新建私有」是它唯一的生产入口（组 POST/PATCH 的 `createAgents`），
      //   这里单独接受它，供组详情编辑私有成员时直接调用。
      //   ⚠️ 组必须存在；角色限定执行/审核（组的 1+1 形态只消费这两种）。
      const ownerGroupId = body['ownerGroupId']
      if (ownerGroupId !== undefined && ownerGroupId !== null) {
        if (typeof ownerGroupId !== 'string' || ownerGroupId.trim() === '') {
          sendJson(res, 400, { error: 'ownerGroupId 必须是组的 id（非空字符串）' })
          return
        }
        const owner = await store.getGroup(ownerGroupId.trim() as AgentGroup['id'])
        if (!owner || owner.workspaceId !== workspaceId) {
          sendJson(res, 400, { error: `智能体组不存在：${ownerGroupId}。私有智能体必须属于一个组。` })
          return
        }
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

      const roleCheck = await validateRole(body['role'])
      if (!roleCheck.ok) {
        sendJson(res, 400, { error: roleCheck.error })
        return
      }

      const runtimeCheck = await resolveRuntimeKey(body['runtimeKey'])
      if (!runtimeCheck.ok) {
        sendJson(res, 400, { error: runtimeCheck.error })
        return
      }

      // 审核标准只收"名字 + 正文"（D40：动作权限不在标准里了，见那个函数）
      const standardCheck = parseReviewStandard(body['reviewStandard'], warn)
      if (!standardCheck.ok) {
        sendJson(res, 400, { error: standardCheck.error })
        return
      }

      // ⚠️ 这里原来校验并写入三样动作配置（`allowedActions` / `actionParams` /
      //    `debugActions`）。2026-10 起 agent 上**不再有这些字段**——"判完允许动什么"
      //    属于**这条链**，唯一权威是智能体组（组页 ③ 行动）。所以这里一个字都不收：
      //    请求里带了它们就是"不认识的字段"400，而不是悄悄忽略。

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
        env: envCheck.value,
        role: roleCheck.role,
        // D37：审核标准内联在 agent 上（校验在上面）
        reviewStandard: standardCheck.value,
        // ★ 私有归属（第二轮）：有值 = 私有（只属于那个组）；省略 = 全局。
        //   `exactOptionalPropertyTypes` 同理——字段在不在就是判据。
        ...(ownerGroupId !== undefined && ownerGroupId !== null
          ? { ownerGroupId: (ownerGroupId as string).trim() as Agent['ownerGroupId'] }
          : {}),
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
          'runtimeKey',
          // FR-AGENT-06：自定义环境变量。它原来不在白名单里 —— 于是"支持为
          // agent 配置环境变量"只存在于协议与实体里，任何入口都改不动它。
          'env',
          // D37：审核标准（内联在 agent 上）
          'reviewStandard',
        ])
        // ⚠️ 2026-10：`reviewerAgentId` / `allowedActions` / `actionParams` /
        //    `debugActions` 四个键**从这个白名单里拿掉了**——它们已经从 `Agent` 上
        //    整个撤掉（"谁审"与"判完能做什么"都归**智能体组**）。写了它们的请求会走
        //    下面那条 400（`不认识的字段`），而不是被悄悄忽略：那份配置**改不动**了，
        //    使用者必须知道这件事，而不是以为保存成功了。
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

        if (body['role'] !== undefined) {
          const roleCheck = await validateRole(body['role'])
          if (!roleCheck.ok) {
            sendJson(res, 400, { error: roleCheck.error })
            return
          }
          patch.role = roleCheck.role
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


        if (body['reviewStandard'] !== undefined) {
          // 同新建时：只收名字与正文（动作权限已经不在标准里了，见那个函数）
          const standardCheck = parseReviewStandard(body['reviewStandard'], warn)
          if (!standardCheck.ok) {
            sendJson(res, 400, { error: standardCheck.error })
            return
          }
          patch.reviewStandard = standardCheck.value
        }

        // ⚠️ 这里原来有三块：动作权限（`allowedActions`）、固定参数
        //    （`actionParams`）、调试动作（`debugActions`）的校验与写入，还有一条
        //    "执行者不能有动作权限"的角色一致性检查（`rejectActionsForExecutor`）。
        //    2026-10 起 agent 上不再有这些字段——**动作只属于智能体组**（组页 ③ 行动），
        //    所以那三块与那条检查一起删掉了。请求里带了它们会走白名单那条 400。

        // ★ 审核者不许挂工具（D40）——这条不变量必须在**所有**能改到它的入口上成立。
        //
        // 工具那边（`PUT /api/agents/:id/tools`）已经拒了"给审核者挂工具"，但
        // 角色是可以改的：一个挂着工具的**执行者**，只要把角色改成 reviewer，
        // 就绕过了那条检查，变成一个"既判断又动手"的智能体——那正是审核者不带
        // 工具要防的事（INV-1 的精神：判断的人不碰现场）。
        //
        // 拒的时候要说清下一步：先把工具摘掉（`PUT /api/agents/:id/tools` 传
        // 空数组），再改角色。
        // ⚠️ 只在"**要变成**审核者"时拒：老数据里可能有挂着工具的审核者（它是在
        //    这条规则之前建的）。那种记录该修，而"连改个名字都 400"会让人连修
        //    的入口都找不到。
        //
        // ⚠️ 这里原来还有一道门："挂着工具包的 agent 不能改成审核者"。挂载能力
        //    撤掉之后那个字段不再存在，这道门**没有可判的东西**了，一并删掉
        //    （上面那句"连改个名字都 400"讲的正是这种门要留出路的道理）。

        /**
         * ★★ 保存时**顺手把内联老标准并进「指令」**（2026-09）。
         *
         * ══════════════════════════════════════════════════════════════════
         * 为什么是"保存时"，而不是"等使用者去点那个按钮"
         * ══════════════════════════════════════════════════════════════════
         *
         * 使用者的原话：「还留着老的信息…建议我重新编辑保存后 就应该去掉这些旧资讯」。
         * 他说的是界面上的真实观感：明明已经把判断依据并进「指令」这件事做完了
         * （`reviewStandard` 只剩兼容读取），可只要库里那个老字段还在，详情页就永远
         * 挂着一条"还带着一份老的标准"的警告——**改个名字、写一段指令，那条警告
         * 都不动**。一条只有点另一个按钮才会消失的提示，等于把清理老数据的责任
         * 推给使用者，而他并没有做错什么。
         *
         * 所以：**保存一次就把老字段清掉**。这不是"顺手改数据"，因为这一步
         * **不改变投递出去的那段文字**——`reviewerIdentity` 本来就是
         * `[instructions, reviewStandard.body]`（同一个顺序、同一个空行分隔），
         * 并进来之后算出来的身份与并之前**逐字节相同**（有测试钉着）。
         * 变的只是"这段文字住在哪个字段里"。
         *
         * ⚠️ 三个不收工的地方，每一条都有具体理由：
         *   ① **请求里明确带了 `reviewStandard`** ⇒ 不动它。老客户端照旧能写那个
         *      字段，我们不该在同一次请求里把它写进去又搬走。
         *   ② **指令为空** ⇒ 不并。并进来会把"只有一份老标准、没有身份"的审核者
         *      变成"指令非空"，而**资格判据就是指令非空**（FR-AGENT-25）——那等于
         *      保存一次就悄悄让它开始接审核任务。让他先写身份，那条警告就留着。
         *      （这不是漏做：那种 agent 现在**本来就不审**，警告正好说的是这件事。）
         *   ③ **正文来自挂载的 skill**（`reviewStandard` 是空的、body 从 skill 推出来）
         *      ⇒ 不并。并它必须**清空 `skillIds`**，而"改个名字顺手把我的挂载摘了"
         *      是使用者没同意的改动；那一种仍然走详情页那个按钮（它会说清"挂载也一起摘掉"）。
         */
        const patchedInstructions = patch.instructions ?? current.instructions ?? ''
        const legacyInlineBody = current.reviewStandard?.body?.trim() ?? ''
        const foldInOnSave =
          (patch.role ?? current.role) === 'reviewer' &&
          body['reviewStandard'] === undefined &&
          legacyInlineBody !== '' &&
          patchedInstructions.trim() !== ''
        if (foldInOnSave) {
          patch.instructions = [patchedInstructions.trim(), legacyInlineBody].join('\n\n')
          patch.reviewStandard = null
          warn(
            `agent「${current.name}」：保存时把老的内联标准并进了「指令」` +
              `（${legacyInlineBody.length} 字，位置改由平台定，投递出去的那段文字一字未变）。`,
          )
        }

        const updated: Agent = { ...current, ...patch, updatedAt: Date.now() }
        await store.insertAgent(updated)
        sendJson(res, 200, updated)
        return
      }

      // ── 删 agent（2026-11：智能体编辑页底部加「删除」按钮）──
      //
      // 两道闸都是"拒绝 + 说清下一步"，不偷偷改别人的配置：
      //   ① 还是某智能体组的成员 ⇒ 组里会悬着一条找不到人的成员 id；
      //   ② 是「新建任务的默认智能体」⇒ 界面强调"必须有一个默认"。
      // 老 run 不挡：run 上带的是**执行时的快照**（`agentRef`），agent 删了
      // 历史任务照常显示（与组删私有成员一路的取舍：删 agent 不删历史）。
      if (req.method === 'DELETE') {
        const current = await store.getAgent(agentId)
        if (!current) {
          sendJson(res, 404, { error: `agent 不存在：${agentId}` })
          return
        }
        const refGroups = await store.listGroupsByAgent(agentId)
        if (refGroups.length > 0) {
          sendJson(res, 400, {
            error:
              `「${current.name}」还是智能体组「${refGroups.map((g) => g.name).join('、')}」的成员` +
              `——先从组里移除它，再删。`,
          })
          return
        }
        const workspace = await store.getWorkspace(current.workspaceId)
        if (workspace?.defaultAgentId === agentId) {
          sendJson(res, 400, {
            error: `「${current.name}」是「新建任务的默认智能体」——先把它换成另一个执行者，再删。`,
          })
          return
        }
        const deleted = await store.deleteAgent(agentId)
        sendJson(res, deleted ? 200 : 404, { ok: deleted })
        return
      }
    }

    if (req.method === 'GET' && path === '/api/issues') {
      const page = await store.listIssues({ workspaceId, limit: 200 })
      sendJson(res, 200, page)
      return
    }

    // ── 放弃 / 恢复一条任务（D47）──
    //
    // ★ 两条路由而不是一条 `PUT /api/issues/{id}/status`：**每条路只意味着一件事**。
    //   给一条通用的改状态接口，调用方就能把 issue 设成 `in_progress`、`done`
    //   这类**平台自己不维护**的状态——而那些状态在阶段推导里没有任何位置，
    //   于是会造出一种"看起来设了、看板不认"的记录。这里由服务端决定目标状态
    //   （放弃 ⇒ `cancelled`，恢复 ⇒ `todo`），调用方只说意图。
    // ══════════════════════════════════════════════════════════════════
    // 删除一条任务（任务列表每项右侧的「删除」按钮）
    // ══════════════════════════════════════════════════════════════════
    //
    // 连带范围在 `Store.deleteIssue` 的文档里（该 issue 上的全部 run——含审核
    // 链——逐个走 deleteRun 的连带，再加评论与 issue 本体；审计、通知与 blob
    // 不删）。与 run 的删除不同，这里**没有"运行中不能删"的闸**：任务删除
    // 先把还在跑的 run 取消掉（与「放弃」同一处副作用），再删——否则一条
    // 正在烧 token 的任务会在删除的瞬间变成"看不见的正在跑"。
    const issueDeleteMatch = /^\/api\/issues\/([^/]+)$/.exec(path)
    if (issueDeleteMatch && req.method === 'DELETE') {
      const issueId = issueDeleteMatch[1] as IssueId
      const issue = await store.getIssue(issueId)
      if (!issue || issue.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: '任务不存在' })
        return
      }
      // ★ 先取消还在跑的 run，再删（与 abandon 同一处副作用、同一句解释）。
      const page = await store.listRuns({ workspaceId, limit: 10_000 })
      for (const run of page.items) {
        if (TERMINAL_RUN_STATUSES.includes(run.status)) continue
        if (!(await runBelongsToIssue(store, run, issueId))) continue
        await executor.cancel(run.id)
      }
      await store.deleteIssue(issueId)
      sendJson(res, 200, { ok: true })
      return
    }

    const issueStatusMatch = /^\/api\/issues\/([^/]+)\/(abandon|reopen)$/.exec(path)
    if (issueStatusMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '这个地址只接受 POST' })
        return
      }
      const issueId = issueStatusMatch[1] as IssueId
      const action = issueStatusMatch[2]
      const target = action === 'abandon' ? 'cancelled' : 'todo'

      const issue = await store.getIssue(issueId)
      // 别的 workspace 的 issue 一律当"不存在"（404）——与 `/api/runs` 同一口径。
      if (!issue || issue.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: '任务不存在' })
        return
      }
      if (issue.status === target) {
        // ★ 说清"已经是了"，而不是回 200 假装改成功：界面据此把按钮置灰，
        //   而一个静默成功的空操作会让人以为刚才那次点击没生效。
        sendJson(res, 409, {
          error:
            action === 'abandon' ? '这条任务已经放弃过了' : '这条任务没有处于放弃状态',
        })
        return
      }

      // CAS：`expect` 是**刚读到的那一个**状态。中间被别人改过 ⇒ 返回 false，
      // 于是这里回 409 而不是盲目覆盖（`transitionIssue` 的契约就是如此）。
      const ok = await store.transitionIssue(issueId, issue.status, target)
      if (!ok) {
        sendJson(res, 409, { error: '这条任务的状态刚被别处改过，请刷新后重试' })
        return
      }

      // ★ 放弃时**顺手取消还在跑的 run**。
      //
      //   不取消的话，"放弃"只改了看板，而那条 run 还在烧 token、还在往工作
      //   目录里写东西——而"放弃"的意思恰恰是"这条不要再做了"。这是这个功能
      //   唯一的一处副作用，所以它在界面上也写着（见 `tasks.abandonNote`）。
      //
      //   恢复时**不**把 run 拉回来（取消是不可逆的，而且 run 的终态没有出边）；
      //   要接着干就点「反馈」，那会派一条新的 run——与 D45 的返工同一个形状。
      const cancelled: string[] = []
      if (action === 'abandon') {
        const page = await store.listRuns({ workspaceId, limit: 10_000 })
        for (const run of page.items) {
          if (TERMINAL_RUN_STATUSES.includes(run.status)) continue
          // 只碰**这条任务**的 run：review run 的 subject 是执行 run 的 id，
          // 所以要顺着它的 subject 往上找一层，否则会漏掉正在跑的审核。
          if (!(await runBelongsToIssue(store, run, issueId))) continue
          if (await executor.cancel(run.id)) cancelled.push(run.id)
        }
      }

      sendJson(res, 200, {
        issue: (await store.getIssue(issueId)) ?? issue,
        cancelledRunIds: cancelled,
      })
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
        'content-disposition': `attachment; filename="agentdeck-audit-${Date.now()}.json"`,
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
      return
    }

    // ── 聊天/任务沉淀 skill（D80）──
    //
    // 两个场景、一套流水线（设计文档 `docs/design/skill-crystallization.md`）：
    // 点按钮 → 沉淀目标面板（新建必填作用描述 / 更新本次加载的）→ 起草 run →
    // 草稿审阅 → 确认入库（skills-mine 根，source:'mine'，git 化）。
    //
    // 三个端点：
    //   · GET  /api/crystallize/targets?runId=…  目标面板信息（加载的 skill、任务是否审核过）
    //   · GET  /api/crystallize/drafts           沉淀任务列表（未入库的起草 run + 来源标签）
    //   · GET  /api/crystallize/sources          新建沉淀的来源选择器（对话/达标任务 + 源 runId）
    //   · POST /api/crystallize/draft            打包素材 → 起草 run → 返回 draftRunId
    //   · POST /api/crystallize/discard          放弃一条没入库的起草（列表只增不减的出口）
    //   · POST /api/crystallize/commit           审阅确认 → 落 skills-mine + git commit
    if (req.method === 'GET' && path === '/api/crystallize/drafts') {
      sendJson(res, 200, { items: await listCrystallizeDrafts(store, workspaceId) })
      return
    }
    if (req.method === 'GET' && path === '/api/crystallize/sources') {
      sendJson(res, 200, { items: await listCrystallizeSources(store, workspaceId) })
      return
    }
    /**
     * 放弃一条起草（沉淀任务）。
     *
     * ★ 三轮：起草 run 完成 ≠ 沉淀完成——没入库的草稿会一直躺在左栏（"很多沉淀任务
     * 标注已完成、实际没完成"），而旧版的「放弃」只重置了界面状态，草稿仍在库里。
     * 这里给它一个真实的出口：还在跑就先停，然后打 `discarded: true`，两个列表
     * （沉淀列表、恢复进行中的起草）都不再理它。
     *
     * 已入库的（`crystallized: true`）不给放弃——那是已经发生的事实，应该去技能页删。
     */
    if (req.method === 'POST' && path === '/api/crystallize/discard') {
      const body = (await readJsonBody(req)) as { draftRunId?: unknown }
      const draftRunId = typeof body.draftRunId === 'string' ? body.draftRunId : ''
      if (draftRunId === '') {
        sendJson(res, 400, { error: '需要 draftRunId', code: 'draft_run_id_required' })
        return
      }
      const draftRun = await store.getRun(draftRunId as RunId)
      if (
        !draftRun ||
        draftRun.workspaceId !== workspaceId ||
        draftRun.subject.type !== 'skill-draft'
      ) {
        sendJson(res, 404, { error: `起草 run 不存在（${draftRunId}）`, code: 'draft_run_not_found' })
        return
      }
      if (draftRun.crystallized === true) {
        sendJson(res, 409, { error: '这条已经入库，不能放弃', code: 'already_crystallized' })
        return
      }
      // 还在跑就先停掉（否则它跑完又会出现在列表里）
      if (!['completed', 'failed', 'cancelled'].includes(draftRun.status)) {
        await executor.cancel(draftRunId as RunId).catch(() => {})
      }
      await store.insertRun({ ...draftRun, discarded: true })
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && path === '/api/crystallize/targets') {
      const url2 = new URL(req.url ?? '/', 'http://localhost')
      const runId = url2.searchParams.get('runId') ?? ''
      if (runId === '') {
        sendJson(res, 400, { error: '需要 runId', code: 'run_id_required' })
        return
      }
      const run = await store.getRun(runId as RunId)
      if (!run || run.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: `run 不存在（${runId}）`, code: 'run_not_found' })
        return
      }
      sendJson(res, 200, await crystallizeTargets(store, run))
      return
    }

    if (req.method === 'POST' && path === '/api/crystallize/draft') {
      const raw = (await readJsonBody(req)) as {
        runId?: unknown
        target?: unknown
        userFeedback?: unknown
      }
      const runId = typeof raw?.runId === 'string' ? raw.runId : ''
      if (runId === '') {
        sendJson(res, 400, { error: '需要 runId', code: 'run_id_required' })
        return
      }
      const requestedRun = await store.getRun(runId as RunId)
      if (!requestedRun || requestedRun.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: `run 不存在（${runId}）`, code: 'run_not_found' })
        return
      }
      // 传进来的可能是起草 run 自己（草稿列表点进来）——归一成源 run，
      // 绝不拿草稿的产出当素材（见 crystallize.ts 的 resolveSourceRun）。
      const sourceRun = await resolveSourceRun(store, requestedRun)
      // 目标：新建（必填作用描述）或 更新本次加载的 skill。
      let target:
        | { kind: 'new'; purpose: string }
        | { kind: 'update'; skillId: string }
      const t = raw?.target as Record<string, unknown> | undefined
      if (t?.kind === 'new') {
        const purpose = typeof t['purpose'] === 'string' ? t['purpose'].trim() : ''
        if (purpose === '') {
          sendJson(res, 400, { error: '新建需要「作用描述」（防 agent 总结偏离）', code: 'purpose_required' })
          return
        }
        target = { kind: 'new', purpose }
      } else if (t?.kind === 'update') {
        const skillId = typeof t['skillId'] === 'string' ? t['skillId'] : ''
        if (skillId === '') {
          sendJson(res, 400, { error: '更新需要 skillId', code: 'skill_id_required' })
          return
        }
        target = { kind: 'update', skillId }
      } else {
        sendJson(res, 400, { error: '需要 target（{kind:"new"} 或 {kind:"update"}）', code: 'target_required' })
        return
      }

      // ── 素材打包 ──
      const userFeedback = typeof raw?.userFeedback === 'string' ? raw.userFeedback : undefined
      const material = await buildMaterial(store, sourceRun, userFeedback)
      if (material.text.trim() === '') {
        sendJson(res, 400, { error: '这个 run 没有可沉淀的内容（消息为空）', code: 'empty_material' })
        return
      }

      // ── 现有 skill 列表 + 更新基线 ──
      const targets = await crystallizeTargets(store, sourceRun)
      // ── 任务场景的门槛（设计 §4.3）：有用户反馈 或 审核过才可沉淀 ──
      // 前端在任务按钮 / 流程页都拦（本页「新建沉淀」能选任意任务，不能只靠按钮）；
      // 这里再拦一道——界面画对了而忘了带，这条就是兜底（门是设计规则，不是 UI 细节）。
      if (targets.scope === 'task' && !(targets.reviewed || targets.hasUserFeedback)) {
        sendJson(res, 400, {
          error: '任务沉淀需要有审核结论或用户反馈（设计 §4.3）',
          code: 'task_gate',
        })
        return
      }
      const existingSkills = targets.loadedSkills.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
      }))
      let existingSkill: { name: string; body: string; description: string | null } | null = null
      if (target.kind === 'update') {
        const mine = await store.listSkills(workspaceId)
        const skill = mine.find((s) => (s.id as string) === target.skillId)
        if (!skill) {
          sendJson(res, 404, { error: `skill 不存在（${target.skillId}）`, code: 'skill_not_found' })
          return
        }
        existingSkill = {
          name: skill.name,
          body: skill.body,
          description: skill.description,
        }
      }

      const prompt = buildDraftPrompt({
        material: material.text,
        ...(target.kind === 'new' ? { purpose: target.purpose } : {}),
        existingSkill,
        existingSkills,
        scope: targets.scope,
      })

      // ── 起起草 run（复用执行管道：第一句话投递、日志、收口全现成）──
      const draftRunId = ulid() as RunId
      const sourceAgent = await store.getAgent(sourceRun.agentId)
      if (!sourceAgent) {
        sendJson(res, 400, { error: '发起 run 的执行者已不存在', code: 'agent_not_found' })
        return
      }
      const outcome = await executor.submit({
        runId: draftRunId,
        kind: 'execute',
        agentRef: {
          id: sourceAgent.id,
          name: sourceAgent.name,
          instructions: sourceAgent.instructions,
        },
        // 起草 run 不注入任何 skill——素材里已含现有技能列表（文本），
        // 注入会干扰"提炼"这件事本身。
        skills: [],
        // ★ 唯一 subject：`skill-draft` 不在闭环里（报告摄取不认它），
        //   也不会被"同 subject 并发"拦（每起草一次一个新 id）。
        //   `sourceRunId` = 它从哪条 run 发起（对话 = 那一轮 run，任务 =
        //   任务执行 run）——"恢复进行中的起草"按它找回这条草稿（§4.1.1）。
        subject: { type: 'skill-draft', id: draftRunId, sourceRunId: runId },
        prompt,
        limits: { maxTurns: null, timeoutMs: null },
        // 起草 run **绝不自动审**（评审在人——审阅界面是它唯一的大门）。
        reviewerAgentId: null,
        // 沉淀目标随 run 落库：恢复进行中的起草时按它还原（§4.1.1）。
        // ⚠️ purpose 不落库——它只影响起草 prompt，提交时用不到。
        crystallizeTarget:
          target.kind === 'new' ? { kind: 'new' } : { kind: 'update', skillId: target.skillId },
        // 起草的产出是文本草稿，进 run 的 result；工作目录给它一间专用小屋，
        // 不碰源 run 的目录（草稿不进任何工作目录，设计 §5）。
        workDir: join(workRoot, `skill-draft-${draftRunId}`),
      })
      if (outcome.kind === 'rejected') {
        sendJson(res, 503, { error: `起草 run 未受理：${outcome.reason}`, code: 'draft_rejected' })
        return
      }
      sendJson(res, 202, { draftRunId, materialStats: material.stats })
      return
    }

    if (req.method === 'POST' && path === '/api/crystallize/commit') {
      const raw = (await readJsonBody(req)) as {
        draftRunId?: unknown
        target?: unknown
        slug?: unknown
        name?: unknown
        description?: unknown
        body?: unknown
        files?: unknown
      }
      const draftRunId = typeof raw?.draftRunId === 'string' ? raw.draftRunId : ''
      if (draftRunId === '') {
        sendJson(res, 400, { error: '需要 draftRunId', code: 'draft_run_id_required' })
        return
      }
      const draftRun = await store.getRun(draftRunId as RunId)
      if (!draftRun || draftRun.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: `起草 run 不存在（${draftRunId}）`, code: 'draft_run_not_found' })
        return
      }
      // 起草 run 必须跑完（completed）才能确认入库——草稿都没出来就入库是幻觉。
      if (draftRun.status !== 'completed') {
        sendJson(res, 409, { error: `起草 run 尚未完成（${draftRun.status}）`, code: 'draft_not_completed' })
        return
      }

      let target: { kind: 'new' } | { kind: 'update'; skillId: string }
      const t = raw?.target as Record<string, unknown> | undefined
      if (t?.kind === 'new') {
        target = { kind: 'new' }
      } else if (t?.kind === 'update' && typeof t['skillId'] === 'string' && t['skillId'] !== '') {
        target = { kind: 'update', skillId: t['skillId'] }
      } else {
        sendJson(res, 400, { error: '需要 target', code: 'target_required' })
        return
      }

      const slug = typeof raw?.slug === 'string' ? raw.slug.trim() : ''
      const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
      const body = typeof raw?.body === 'string' ? raw.body : ''
      const description = typeof raw?.description === 'string' ? raw.description.trim() : ''
      if (slug === '' || name === '' || body.trim() === '') {
        sendJson(res, 400, { error: '需要 slug / name / body', code: 'fields_required' })
        return
      }

      // 校验（与安装同一关：`resolvePayloadEntry` 做规范化与限额检查）。
      let validated
      try {
        validated = resolvePayloadEntry({
          slug,
          body,
          files: typeof raw?.files === 'object' && raw.files !== null ? (raw.files as Record<string, string>) : null,
          sourceRef: `mine:${slug}`,
        })
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
          code: 'invalid_skill',
        })
        return
      }

      const existing = await store.listSkills(workspaceId)
      let clashMine: Skill | null = null
      let clashInstalled: Skill | null = null
      for (const s of existing) {
        if (s.slug !== validated.slug) continue
        if (s.source === 'mine') clashMine = s
        else clashInstalled = s
      }
      // 更新目标：提炼的 = 进化（复用原 id 覆盖 + commit）；安装的 = **基于它
      // 创建你的版本**（设计 §4.1 第 1 步：同 slug 落 skills-mine 并遮蔽安装版，
      // **安装根原文件不动**——安装的是外部内容，平台不碰）。两者都不允许改 slug
      // （改名请走"新建"）。
      if (target.kind === 'update') {
        const targetSkill = existing.find((s) => (s.id as string) === target.skillId)
        if (!targetSkill) {
          sendJson(res, 404, { error: `skill 不存在（${target.skillId}）`, code: 'skill_not_found' })
          return
        }
        if (targetSkill.slug !== validated.slug) {
          sendJson(res, 400, { error: '更新不允许改 slug（改名请新建）', code: 'slug_mismatch' })
          return
        }
      } else {
        // 新建撞提炼根已有同 slug → 让前端切到"更新"（进化）或改名。
        if (clashMine) {
          sendJson(res, 409, {
            error: `已有你提炼的同名 skill（${clashMine.slug}）`,
            code: 'clash_mine',
            existing: { slug: clashMine.slug, name: clashMine.name, id: clashMine.id },
          })
          return
        }
      }

      const now = Date.now()
      // 落库 id 的决定：
      //   · 新建 → 新 id；
      //   · 更新提炼的 → 复用它的 id（进化，不留孤儿记录）；
      //   · 更新安装的 → **你的版本**：提炼根已有同 slug 就复用那条（继续进化你的
      //     遮蔽版），没有就新开一条（基于安装版创建你的版本，设计 §4.1 第 1 步）。
      //     ⚠️ 无论哪种，安装根那条**原样不动**。
      let targetId: Skill['id']
      let targetCreatedAt: number
      if (target.kind === 'update') {
        const targetSkill = existing.find((s) => (s.id as string) === target.skillId)!
        if (targetSkill.source === 'mine') {
          targetId = targetSkill.id
          targetCreatedAt = targetSkill.createdAt
        } else {
          // 安装的 → 落到提炼根（遮蔽）：你的版本优先复用已有 mine 同 slug 那条
          targetId = clashMine?.id ?? (ulid() as Skill['id'])
          targetCreatedAt = clashMine?.createdAt ?? now
        }
      } else {
        targetId = ulid() as Skill['id']
        targetCreatedAt = now
      }

      const skill: Skill = {
        id: targetId,
        workspaceId,
        slug: validated.slug,
        name,
        description: description !== '' ? description : null,
        body: validated.body,
        ...(Object.keys(validated.files).length > 0 ? { files: validated.files } : {}),
        verdictSchemaVersion: 1,
        source: 'mine',
        sourceRef: `mine:${validated.slug}`,
        version: null,
        createdAt: targetCreatedAt,
        updatedAt: now,
      }
      await store.insertSkill(skill)

      // ── git 版本管理（可用性开关：没有 git = 版本管理关闭，沉淀照常）──
      let versioning: { enabled: boolean; note?: string } = { enabled: false }
      const probe = await probeGit()
      if (!probe.available) {
        versioning = {
          enabled: false,
          note: '版本管理未启用（系统无 git），沉淀照常、无历史回退',
        }
      } else {
        const ensure = await ensureMineRepo(skillsMineRoot)
        if (!ensure.ok) {
          versioning = { enabled: false, note: `版本管理未启用：${ensure.reason}` }
        } else {
          const message =
            target.kind === 'update'
              ? `skill ${skill.slug} 进化（更新）`
              : `skill ${skill.slug} 沉淀（新建）`
          const committed = await commitMine(skillsMineRoot, message)
          if (committed.ok) {
            versioning = { enabled: true }
          } else {
            // 降级兜底：有 git 但坏了 → note 降级，沉淀照常（设计 §7.3.1）。
            versioning = { enabled: false, note: `git 提交失败（已降级）：${committed.reason}` }
          }
        }
      }

      sendJson(res, 201, { skill, versioning })

      // ★ 标记这条起草 run 已入库（`crystallized: true`）——"恢复进行中的
      //   起草"（targets 的 activeDraft）要跳过已入库的草稿，不然每次重开
      //   流程页都会把上一条沉淀完的草稿再"继续"一遍（§4.1.1）。
      //   放在 sendJson 之后：入库成功是唯一事实，git 降级不影响它。
      await store.insertRun({ ...draftRun, crystallized: true })
      return
    }

    // ── 技能（审核模板与自建）──
    //
    // 2026-10 起这条接口**只读、无副作用**：不再对账。以前它读列表时会顺手把
    // `~/.claude/skills` 这类目录里的技能自动读进库（`reconcileLocalSkillDirs`），
    // 那条路已随"本地技能目录改成显式安装"撤掉——装是「从本地安装」页签那条路
    // （`POST /api/skills/install`）的事，读列表就只是"看现在库里有什么"。
    if (req.method === 'GET' && path === '/api/skills') {
      const skills = (await store.listSkills(workspaceId)).map((skill) => {
        return {
          ...skill,
          // ★ 旧记录落库时没有 description（改动前一直 null）。这里**按需补**：
          //   从 SKILL.md frontmatter 解析出作者写的那句用途说明——不补的话，
          //   已经装好的技能列表里永远是"没有说明"，除非重新装一遍。
          //   ⚠️ 这是纯展示层的兜底，不动库（审计是 append-only 的）；
          //   新装的记录在写入时就带上了正确的 description。
          description: skill.description ?? extractSkillMeta(skill.body).description ?? null,
          // 从**本地技能目录**装进来的（null = 手装 / 远端 / 给路径装的）——
          // 界面据此显示「来自本地技能目录：…」。装完就是一条普通技能了，
          // 这里只是留个来源标记，没有任何"跟随磁盘"的语义。
          localDir: sourceDirOf(skill),
        }
      })
      sendJson(res, 200, { skills })
      return
    }

    // ── 「本地安装清单」（技能页「从本地清单安装」）──
    //
    // 读一份**仓库自带**的 JSON（`--skills-catalog` 可换），列出可安装技能的**安装方法**
    // （GitHub 链接 / 本地路径）。它与「远端目录」不同：远端那份是**已经抓好的内容**，
    // 这份是**安装方法**——点一下才由 daemon 现去取（走 `POST /api/skills/install`）。
    //
    // ★ 这条接口**不联网**：只读本地那份 JSON、算 slug（`skill-list.ts`），不抓 GitHub。
    //   真正的下载发生在使用者点「安装」之后，由 install 那条路负责（那才是刻意例外）。
    //
    // ⚠️ 清单本身坏掉时**明确报错**（抛 ⇒ 全局 500），而不是回一张空表——"我以为
    //   清单是空的"与"清单读不了"是两件事，悄悄给空表正是这个仓库最防的那种失败。
    if (req.method === 'GET' && path === '/api/skills/install-list') {
      sendJson(res, 200, await loadSkillList(skillListPath))
      return
    }

    // ── 「从本地安装」（技能页页签）──
    //
    // 扫内置的候选目录（claude / codex / cursor / agents），把里面发现的技能列出来，
    // 由使用者**逐条显式安装**（走 `POST /api/skills/install`）。
    //
    // ★ 这条接口**只读、无副作用**。2026-10 之前它是"勾上目录 ⇒ 每次读列表自动把
    //   里面的技能对账读进库"；那套已撤，见 D73。装不装由使用者点，扫只负责"看
    //   现在有什么"——所以它不写库、不改工作区，扫完就返回。
    //
    // 候选目录是**内置表**，只给路径与 id：显示名在界面词表里（`skills.dirTool*`）
    // ——daemon 的字符串不翻译，把中文写在这里等于让这个功能只有一种语言。
    if (req.method === 'GET' && path === '/api/skills/local-dirs') {
      const installed = new Set((await store.listSkills(workspaceId)).map((s) => s.slug))
      const candidates = (options.skillDirCandidates ?? localSkillDirCandidates)()
      const dirs = []
      for (const candidate of candidates) {
        const scan = await scanSkillDir(candidate.path)
        const skills = []
        // ★ 「看到但没当成技能」的东西要跟着走，而且**要一直跟着**：实测
        //   `~/.claude/skills` 里有一个没有 SKILL.md 的空目录，界面上要是只说
        //   "这里 1 个技能"，使用者打开 Finder 数出两个，就会去查权限、查扫描是不是
        //   坏了——真正的原因（"那个没有 SKILL.md，所以它不是技能"）一个字都没说。
        const skipped = [...scan.skipped]
        for (const found of scan.found) {
          // ★ 每个发现的技能都走**安装同一条解析**（`resolveLocalPath`）来拿 slug 与
          //   description——不能在这儿自己算一遍 slug：那样"扫描显示的 slug"和
          //   "装进来后的 slug"就各有一处规则，迟早分叉（界面显示装 A，库里出现 B）。
          try {
            const resolved = await resolveLocalPath(found.dir)
            skills.push({
              slug: resolved.slug,
              // 相对根目录的路径（`.system/skill-creator` 这种）——界面按它分组
              rel: found.rel,
              dir: found.dir,
              name: found.name,
              description: extractSkillMeta(resolved.body).description ?? null,
              // 库里已经有同 slug 的 ⇒ 界面显示「已安装」并禁用按钮
              installed: installed.has(resolved.slug),
            })
          } catch (err) {
            // 解析不了 ⇒ 如实说出来（"看到了但装不了"），不静默略过
            skipped.push({
              rel: found.rel,
              reason: err instanceof SkillSourceError ? err.message : String(err),
            })
          }
        }
        dirs.push({
          id: candidate.id,
          path: candidate.path,
          // 装的时候原样带回：`source:{kind:'path', path:<技能目录>, sourceRef:<这里>}`
          sourceRef: `${LOCAL_DIR_SOURCE_PREFIX}${candidate.path}`,
          exists: scan.error === null,
          // 目录本身读不了（不存在 / 没权限）⇒ 说清是哪个目录、为什么
          error: scan.error,
          skills,
          skipped,
        })
      }
      sendJson(res, 200, { dirs })
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
    // agentdeck 的远端服务**，D20 那条规则仍然原样成立。
    // ── 卸载一个 skill（D38）──
    //
    // 这是 README 里挂着的那个已知缺口（"装了要删只有改库"）。D38 之后它更有必要：
    // 老数据里可能还留着当年播种的 `general-review`，而使用者要把它清掉。
    //
    // ⚠️ **还挂着它的 agent 会让删除被拒**，并把它们列出来。理由：静默删掉一条
    //    还被引用的东西，症状是"某个 agent 的 skill 突然没了"——那要在很久以后
    //    才被发现（而且看起来像技能求解的 bug）。宁可让使用者先摘掉引用。
    // ── 把老形态的判断依据并进「指令」（D38，2026-09 改落点）──
    //
    // 过渡期的迁移入口。老数据有两种形态，**这条端点两种都收**（判据是
    // `resolveReviewStandard`：内联老标准优先，没有才看挂载的 skill）：
    //   ① 正文写在老字段 `reviewStandard` 里；
    //   ② 正文来自挂载的 skill（更老的形态）——那时"卸载那条 skill"必须先走这一步，
    //      否则审核者会失去依据。
    // ⚠️ ① 那种（使用者的库里正好有一个）原来在界面上**只显示、没有按钮**，
    //    现在统一给入口：两种都是"依据还走在老形态上"，没理由只搬一种。
    //
    // ★ 解析用**服务端同一个函数**（`resolveReviewStandard`）——里面是"正文拼起来、
    //   动作取并集"那套规则。让前端自己拼一遍，两处规则迟早分叉，而分叉的表现是
    //   "搬完之后生效的与搬之前生效的不是同一份"。
    const adoptMatch = /^\/api\/agents\/([^/]+)\/review-standard\/adopt-from-skills$/.exec(path)
    if (adoptMatch && req.method === 'POST') {
      const agentId = decodeURIComponent(adoptMatch[1]!) as Agent['id']
      const agent = await store.getAgent(agentId)
      if (!agent) {
        sendJson(res, 404, { error: `agent 不存在：${agentId}` })
        return
      }
      if (agent.role !== 'reviewer') {
        sendJson(res, 400, { error: '只有审核角色才有判断依据可搬移' })
        return
      }
      const mounted = await loadAgentSkills(store, agent)
      const resolved = resolveReviewStandard(agent, mounted)
      if (!resolved) {
        sendJson(res, 400, {
          error:
            '它没有可搬移的判断依据：既没有内联的老标准，挂着的 skill 也都没有正文。' +
            '先在详情页给它写一段「指令」。',
        })
        return
      }
      // ⚠️ 这里原来有一段"把动作权限过一遍运行时判据再落下来"（D41 加的，为了不让
      //    老数据里那串死名字被原样搬进新字段）。agent 上不再有动作字段之后，
      //    这一步没有对象了——动作只属于智能体组，固化只搬**正文**。
      const updated: Agent = {
        ...agent,
        /**
         * ★★ 2026-09：落点是**「指令」**，不再是那个已经撤掉的「标准」字段。
         *
         * 使用者定的口径是「审核 Agent 的标准也放 ② 里面，不用单独设置」——② 就是
         * 「指令」。所以这一步现在做的是**搬家**：把当前生效的那份正文并进「指令」，
         * 并把老的标准字段清掉。
         *
         * ⚠️ 必须**清掉**老字段而不是留着：`reviewerIdentity` 会把两处合成一段，
         *    留着就是同一段文字被投递**两遍**（模型的上下文里出现两次一样的标准，
         *    而我们自己看不出来）。
         * ⚠️ 指令在前、正文在后（与 `reviewerIdentity` 同一个顺序）：这样"它原来写的
         *    身份"仍然排在最前面。
         */
        instructions: [agent.instructions?.trim() ?? '', resolved.body.trim()]
          .filter((part) => part !== '')
          .join('\n\n'),
        reviewStandard: null,
        // ⚠️ 这里原来还搬「动作权限」并回传 `droppedActions`（"没搬过来的动作"）。
        //    2026-10 起 agent 上**没有**动作字段——动作只属于智能体组，所以这一步
        //    只搬**正文**，也就没有"没搬过来的动作"可报。
        // 摘掉挂载：正文已经搬进「指令」了，再挂着同一份东西只会让"依据是什么"
        // 有两处答案（而且那两处随时可能不一致）
        skillIds: [],
        updatedAt: Date.now(),
      }
      await store.insertAgent(updated)
      sendJson(res, 200, {
        agent: updated,
        adopted: { fromSkills: mounted.map((s) => s.slug) },
      })
      return
    }

    const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(path)
    if (skillMatch && req.method === 'DELETE') {
      const skillId = decodeURIComponent(skillMatch[1]!) as Skill['id']
      const skill = await store.getSkill(skillId)
      if (!skill) {
        sendJson(res, 404, { error: `skill 不存在：${skillId}` })
        return
      }
      const agents = await store.listAgents(workspaceId)
      const holders = agents.filter((a) => a.skillIds.includes(skillId))
      if (holders.length > 0) {
        // ★ 过渡期最常见的形态：审核者**没有内联标准**，它的判断依据正来自这条
        //   skill（老数据，见 `resolveReviewStandard` 的兼容路径）。这时光说
        //   "先摘掉它"是不够的——摘掉之后审核者就没依据了。所以直接指出那一步：
        //   去详情页把判断依据并进「指令」（`adopt-from-skills`）。
        const needsAdopt = holders.filter((a) => a.role === 'reviewer' && !a.reviewStandard)
        const names = holders.map((a) => a.name).join('、')
        sendJson(res, 400, {
          error:
            `还有 ${holders.length} 个智能体挂着「${skill.slug}」：${names}。` +
            (needsAdopt.length > 0
              ? `其中「${needsAdopt.map((a) => a.name).join('、')}」还没有自己的判断依据` +
                `——它现在正拿这条 skill 当标准。去智能体页点开它，按「把这份判断依据 ` +
                `并进「指令」」，再回来卸载。`
              : `先在它们的配置里把它摘掉，再卸载`) +
            `——静默删掉一条还被引用的东西，症状会在很久以后才出现` +
            `（而且看起来像技能求解坏了）。`,
        })
        return
      }
      const removed = await store.deleteSkill(skillId)
      sendJson(res, 200, { removed, slug: skill.slug })
      return
    }

    if (req.method === 'POST' && path === '/api/skills/install') {
      const raw = (await readJsonBody(req)) as {
        source?: unknown
        slug?: unknown
        overwrite?: unknown
        /**
         * ⚠️ **老契约的字段，不再读**（D40 收口）。
         *
         * 在类型里留着它只是为了说清"它会被忽略"：老客户端（页面还是旧的那版）
         * 会照旧把它送进来，而我们要的既不是"报错"（使用者没做错什么，只是少
         * 升了一次级），也不是"收下"（那会让"判完允许动什么"又有第二个出处）。
         * 动作权限现在配在**智能体组**上：`AgentGroup.allowedActions`。
         */
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
            githubToken: options.githubToken ?? process.env['AGENTDECK_GITHUB_TOKEN'] ?? null,
            ...(options.githubProxy ? { githubProxy: options.githubProxy } : {}),
          },
        )

        outcome = await installSkillPayloads({
          store,
          workspaceId,
          payloads: [
            {
              slug: resolved.slug,
              name: resolved.slug,
              // ★ 作者在 SKILL.md frontmatter 里写的 description 要落库，
              //   否则列表里永远是"没有说明"（与本地目录扫描同一做法）。
              description: extractSkillMeta(resolved.body).description ?? null,
              body: resolved.body,
              files: resolved.files,
              source: source.spec.kind === 'payload' ? 'remote' : 'local',
              sourceRef: resolved.sourceRef,
              version: source.spec.kind === 'payload' ? source.spec.version : null,
              // ⚠️ 这里原来有 `allowedActions: parseAllowedActions(raw.allowedActions)`。
              //    D40 收口之后 skill **不接受**动作配置：动作权限属于智能体组
              //    （`AgentGroup.allowedActions`），而 skill 是给执行者参考的资料包。
              //    老客户端传进来的那个字段被忽略（不是"装错了"，只是那一项不再
              //    属于 skill），所以它连写库都不该被带上——`Skill` 实体上已经没有
              //    这个字段了。
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

    // ══════════════════════════════════════════════════════════════════
    // 工具包：安装 / 卸载 / 挂载（D40）
    // ══════════════════════════════════════════════════════════════════
    //
    // 与 skill 那三个接口同形（能装、能卸、卸的时候"还挂着就拒并列出是谁"），
    // 但有一处刻意的不同：**授权单位是"组"**——一个包一次授权，不按动作逐条授。
    // 见挂载接口那段注释。

    if (req.method === 'GET' && path === '/api/tools') {
      const tools = await store.listTools(workspaceId)
      // ⚠️ 这里原来每条还带一个 `mountedBy`（"被哪些执行者挂载"）。挂载能力撤掉
      //    之后它恒为空数组，界面那一列也删了——留着就是每次列表都去多读一遍
      //    agents，只为算一个永远是空的东西。
      sendJson(res, 200, { tools })
      return
    }

    if (req.method === 'POST' && path === '/api/tools') {
      const raw = (await readJsonBody(req)) as Record<string, unknown>

      // ★ 来源要逐字段校验，而不是信任类型声明——这里是运行时的任意 JSON
      const parsed = parseToolInstallSource(raw)
      if (!parsed.ok) {
        sendToolError(res, parsed.error, 'bad_input')
        return
      }

      // 解析（读目录 / 校验清单 / 查入口文件）整段归同一个 catch 管：
      // "清单不合规"是**输入不对**（400），不是服务坏了（500）。
      const resolved = await resolveToolInstall(parsed.spec)
      if (!resolved.ok) {
        sendToolError(res, resolved.error, resolved.code, resolved.detail)
        return
      }

      const outcome = await installToolPackage({
        store,
        workspaceId,
        pkg: resolved.pkg,
        // ⚠️ `overwrite` 不在原契约里，是**照着 skill 那条路补的**：同名一律
        //    拒绝写入，但"确实要替换"必须有一条出路。
        //
        //    ★ 这条路现在**是「更新」功能唯一走的路**：远端目录里有新版本时，列表上
        //      那个「更新到 x.y.z」就是带 `overwrite: true` 再装一遍（见
        //      `tools/src/views/Tools.svelte` 的 `updateFromCatalog`）。所以它从
        //      "给同名冲突留个后门"变成了主路径，别删。
        overwrite: raw['overwrite'] === true,
        now: Date.now(),
      })
      if (!outcome.ok) {
        // 同名冲突归到 `bad_input`（"输入不对"的一种）：界面是按 `code` 决定
        // 怎么提示的，给一个不在表里的 code 会让它掉进 default 分支。
        sendToolError(res, outcome.error, 'bad_input')
        return
      }
      sendJson(res, 201, { tool: outcome.tool })
      return
    }

    const toolMatch = /^\/api\/tools\/([^/]+)$/.exec(path)
    if (toolMatch && req.method === 'DELETE') {
      const toolId = decodeURIComponent(toolMatch[1]!) as Tool['id']
      const tool = await store.getTool(toolId)
      if (!tool) {
        sendJson(res, 404, { error: `工具包不存在：${toolId}` })
        return
      }

      // ⚠️⚠️ 这里原来有一段"**还挂着它的 agent 会让删除被拒**"，并把挂着它的
      //     agent 名字列出来（`holders`）。**整段删掉了**，现在卸载一律放行。
      //
      // 理由是那把锁**没有钥匙**：拒绝时给的话是"先在那些智能体上把它摘掉，
      // 再卸载"——而"摘掉"这个动作已经不存在了（智能体详情里那个摘挂载的地方
      // 跟着挂载能力一起撤了）。于是万一真碰上一条挂着的老记录，使用者就被锁死：
      // 卸不掉，也摘不掉，而且**界面上没有任何地方能解开它**。
      //
      // ★ 一条指向死路的拒绝，比不拒绝更糟：它把"我做不到"说成"你先去做那件事"。
      //
      // ⚠️ 那条"静默删掉一个还被引用的东西"的顾虑仍然成立，但**在这里已经不适用**：
      //    挂载能力撤掉之后，不再有新的引用被创建；老记录里的那个键在解析时就被
      //    丢掉了（见 `Agent` 上那段注释），所以删掉包**不会**留下悬空引用——
      //    没有任何代码会再去按那个 id 找包。
      await store.deleteTool(toolId)
      sendJson(res, 200, { deleted: true })
      return
    }

    // ⚠️⚠️ 这里原来是 `PUT /api/agents/:id/tools`（挂载 / 摘挂工具包，D40）：
    //     授权单位是**组**（挂上一个包 = 把整组动作交给这个 agent），语义是整体
    //     替换。**整个接口删掉了。**
    //
    // 撤掉的两步（使用者的决定："不需要，因为我已经移除了此功能"）：
    //   1. 先把界面入口撤掉（智能体详情里那个"可挂载的工具组"勾选栏）；
    //   2. 再把「被哪些执行者挂载」那一列撤掉。
    // 于是这个接口**没有任何调用方**了——界面不调、CLI 不调、MCP 也不调（都查过）。
    // 一条只能被 curl 调用的写入口，留着只会让下一个读代码的人以为挂载还能用。
    //
    // ★ 老数据不需要迁移：`Agent` 是普通 `z.object`（不是 `.strict()`），多出来的
    //   `toolIds` 键在解析时被丢掉。所以这里删的是**写入口**，不是"要清库"。
    //
    // ⚠️ 想恢复这个能力的话，除了把这个接口和 `Agent.toolIds` 加回来，还得把
    //   `executor.ts` 里"把挂载的脚本送进工作目录"那一段一起恢复——那才是它唯一的
    //   用途，也一起删了。
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
      const verdicts = await store.listVerdictsByRun(
        decodeURIComponent(verdictsMatch[1]!) as RunId,
      )
      // ★ 判决**顺带把它触发的动作**一起给（每项带 `verdictId`）。
      //
      //   为什么不是另开一个端点：界面要把它们**画在同一张卡片里**——判决说
      //   "通过"，而"通过之后真的做了什么、结果如何"是那份通过的依据的一部分
      //   （使用者的原话：「应该作为审核 PASS 的依据，放在一起更合理」）。
      //   分两次请求的话，卡片会先画出"通过"、动作过一拍才出现，中间那一瞬
      //   就是"审核通过了但什么也没发生"的样子——正是要避免的错觉。
      //
      //   一次一条判决、动作最多几条，所以这里不是 N+1 的性能问题；真要变成问题，
      //   先改 store 的批量读，而不是把接口拆开。
      const actions = (
        await Promise.all(verdicts.map((v) => store.listActionsByVerdict(v.id)))
      ).flat()
      sendJson(res, 200, { verdicts, actions })
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
    // ══════════════════════════════════════════════════════════════════
    // 聊天（`Conversation` / `ChatTurn`）——闭环的**旁路**
    // ══════════════════════════════════════════════════════════════════
    //
    // ★ 一条铁律：聊天**不进闭环**。
    //
    //   产品的脊柱是「派活 → 审核 → 判决 → 才动手」，而它唯一的门是报告摄取
    //   （`POST /api/reports` → `createReviewRun`）。聊天那一轮的 run
    //   `subject.type` 是 `conversation`，报告那条路**根本不认这个 subject**，
    //   所以它**结构上**到不了判决——这不是靠"记得别触发"，是靠没有那条路。
    //
    //   也因此聊天里**不会触发任何登记过的动作**：动作的门槛就是判决。
    //
    //   与任务之间唯一的桥是使用者自己点的那一下（把对话预填进「新建任务」），
    //   平台不替他决定。
    //
    // ★ 第二个决定：一条铁律的代价换一个字段都不加——**一轮对话 = 一条 execute run**。
    //
    //   进程、流式、落盘、SSE、取消、超时、并发槽位、目录锁、成本、审计，
    //   全部白拿。上下文靠 `resumeFromRunId` 接（底层是 `--resume <sessionId>`），
    //   而"这一轮不自动审"用的是协议里**本来就有**的三态：`reviewerAgentId: null`
    //   就是"这一次明确不自动审"。
    if (req.method === 'GET' && path === '/api/conversations') {
      sendJson(res, 200, { items: await store.listConversations(workspaceId) })
      return
    }

    // ── 新建一个对话：★ 它由**第一句话**诞生 ──
    //
    // 刻意**不**提供"先建一个空对话、再往里说话"：那样标题就没有出处，只能
    // 先填一个占位（「新对话」），然后等第一句话来了再覆盖它——而"我改了名却
    // 被第一次发言覆盖掉"是那种看得见、说不清的坏结果。对话从第一句话开始，
    // 标题就是那句话，没有第二个状态。
    if (req.method === 'POST' && path === '/api/conversations') {
      const body = (await readJsonBody(req)) as {
        agentId?: unknown
        title?: unknown
        workDir?: unknown
        text?: unknown
        skillIds?: unknown
      }
      const agentIdRaw = typeof body?.agentId === 'string' ? body.agentId : ''
      if (agentIdRaw === '') {
        sendJson(res, 400, { error: '缺少 agentId', code: 'agent_required' })
        return
      }
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') {
        sendJson(res, 400, { error: '缺少 text（第一句话）', code: 'text_required' })
        return
      }
      const agent = await store.getAgent(agentIdRaw as Agent['id'])
      if (!agent || agent.workspaceId !== workspaceId) {
        sendJson(res, 400, { error: `执行者不存在（${agentIdRaw}）`, code: 'agent_not_found' })
        return
      }
      // ★ 只让**执行者**来聊天。审核者的职责是按标准判事，而聊天不产出判决；
      //   让一个审核者来闲聊，会让人误以为它说的话带判决的分量。
      if (agent.role !== 'executor') {
        sendJson(res, 400, {
          error:
            `agent「${agent.name}」的角色是「${agent.role}」，不能用来聊天。` +
            `聊天不产出判决，所以它只接受执行者（role 为 executor）。`,
          code: 'agent_role_mismatch',
        })
        return
      }
      const now = Date.now()
      /**
       * 这个对话额外带的 skill（可选）。
       *
       * 「新对话」那个下拉里，skill 有两种来路，这里是**第二种**：挂在某个执行者
       * 身上的 skill 走"选它 = 选那个人"（这时代码里什么都不用带，执行者自己就有）；
       * 而**没人挂的** skill 只能由对话自己带着——那是使用者的要求（"所有已安装的
       * skill 都要能选"），也是这个字段存在的唯一理由。
       *
       * ⚠️ 校验到"这条 skill 在这个 workspace 里真的存在"为止：不存在 ⇒ 400。
       *    接受一个不存在的 id 会让这个对话**每一轮**都少注一条 skill，而界面上
       *    看不出任何异常——那种"静默少给"是最难查的一类。
       * ⚠️ 去重：同一个 id 传两次不是错误，但存两遍会让注入逻辑看起来像有意的。
       */
      let skillIds: SkillId[] = []
      if (body.skillIds !== undefined) {
        if (!Array.isArray(body.skillIds)) {
          sendJson(res, 400, { error: 'skillIds 必须是数组', code: 'skill_ids_invalid' })
          return
        }
        const known = new Set(
          (await store.listSkills(workspaceId)).map((s) => s.id as string),
        )
        for (const raw of body.skillIds) {
          if (typeof raw !== 'string' || raw === '') {
            sendJson(res, 400, { error: 'skillIds 里只能是不为空的字符串', code: 'skill_ids_invalid' })
            return
          }
          if (!known.has(raw)) {
            sendJson(res, 400, {
              error: `skill 不存在（${raw}）`,
              code: 'skill_not_found',
            })
            return
          }
          if (!skillIds.includes(raw as SkillId)) skillIds.push(raw as SkillId)
        }
      }
      const conversation: Conversation = {
        id: ulid() as ConversationId,
        workspaceId,
        agentId: agent.id,
        skillIds,
        title:
          typeof body.title === 'string' && body.title.trim() !== ''
            ? body.title.trim().slice(0, 200)
            : titleFromText(text),
        workDir:
          typeof body.workDir === 'string' && body.workDir.trim() !== ''
            ? body.workDir.trim()
            : null,
        createdAt: now,
        updatedAt: now,
        lastTurnAt: null,
        turnCount: 0,
      }
      await store.insertConversation(conversation)
      const out = await submitChatTurn(store, executor, conversation, agent, text, now, workRoot)
      sendJson(res, 201, out)
      return
    }

    // ── 一个对话的工作目录（聊天右栏底部那一栏）──
    //
    // 与「某次执行的工作目录」是同一个东西的两个入口：那边按 run 问，这边按对话
    // 问。后者必须存在，因为一个对话**可能还没有任何 run**（刚建起来，或第一句话
    // 就没跑起来），而它的目录属于**对话**、不属于某一条 run。
    //
    // 守卫、上限、Content-Type、CSP 全在 `workdir-files.ts` 与上面那两个
    // `sendWork*` 里——这条路由只负责回答"这个对话的目录是哪个"。
    const conversationFilesMatch = /^\/api\/conversations\/([^/]+)\/(files|file)$/.exec(path)
    if (req.method === 'GET' && conversationFilesMatch) {
      const id = conversationFilesMatch[1] as ConversationId
      const sub = conversationFilesMatch[2]
      const conversation = await store.getConversation(id)
      // 别的 workspace 的对话一律当"不存在"（404）——与上面那条同一口径。
      if (!conversation || conversation.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: '对话不存在' })
        return
      }
      /**
       * ★ 目录用 `resolveWorkDir` 算，与 `submitChatTurn` 出 run 时**同一个
       *   函数、同一套参数**。界面上显示的路径和它真正干活的路径必须是同一个：
       *   两处各算一次迟早分叉，而分叉的表现是"这一栏列的是别的目录里的东西"。
       *
       *   目录还不存在时（对话刚建、第一轮还没跑）`listWorkDir` 会返回
       *   `exists: false` + 空列表——界面据此说"这个目录还不存在"，而不是
       *   "什么都没有"。
       */
      const dir = resolveWorkDir({
        requested: conversation.workDir,
        subject: { type: 'conversation', id: conversation.id },
        fallbackId: conversation.id,
        workRoot,
      }).path
      if (sub === 'files') {
        const agent = await store.getAgent(conversation.agentId as Agent['id'])
        const managed = managedPathsFor(getRuntimeDescriptor(agent?.runtimeKey ?? 'claude'))
        await sendWorkDirListing(res, dir, url.searchParams.get('dir') ?? '', managed)
        return
      }
      await sendWorkFile(res, req, dir, url.searchParams.get('path') ?? '')
      return
    }

    // ── 一个对话：读 / 改名改目录 / 删 ──
    const conversationMatch = /^\/api\/conversations\/([^/]+)$/.exec(path)
    if (conversationMatch) {
      const id = conversationMatch[1] as ConversationId
      const conversation = await store.getConversation(id)
      // 别的 workspace 的对话一律当"不存在"（404）——与 `/api/issues`、`/api/runs` 同一口径。
      if (!conversation || conversation.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: '对话不存在' })
        return
      }

      if (req.method === 'GET') {
        /**
         * 回看一个对话：把每一轮连同**那一条 run 的结果**一起给出去。
         *
         * ══════════════════════════════════════════════════════════════════
         * 为什么由服务端拼，而不是让页面自己一轮一轮去拉
         * ══════════════════════════════════════════════════════════════════
         *
         * 智能体的回复不另存一份（它就是那条 run 的 messages，见 `ChatTurn`
         * 上面那段）。所以"回看整个对话"这件事，页面要么发 N 个请求
         * （一轮一个 `/api/runs/:id/messages`），要么由拿着全部数据的这边拼。
         *
         * N 个请求不只是慢：**并发拉 N 条 run 的消息，回来的顺序是不定的**，
         * 而聊天恰恰是**顺序就是内容**的那种界面——拼错了看不出是拼错，
         * 只觉得"它怎么答非所问"。
         *
         * 这里只拼**回看需要的那几样**（最后一段正文、状态、工具次数），
         * 不把 messages 整份塞进来：那是流式的活，界面在看"正在跑的那一轮"时
         * 走的是 SSE（与任务详情页同一套）。
         */
        const turns = await store.listChatTurns(id)
        const view = []
        for (const turn of turns) {
          if (!turn.runId) {
            view.push({ ...turn, output: null, status: null, toolCount: 0, durationMs: null })
            continue
          }
          const run = await store.getRun(turn.runId)
          const messages = await store.listRunMessages(turn.runId)
          // ★ 与任务详情页同一条规则：取**最后一条** text，不是拼接。
          //   拼接会把"它中途说过一句话又改了主意"变成两段都留着。
          let output: string | null = null
          let toolCount = 0
          for (const m of messages) {
            if (m.type === 'text' && m.content.trim() !== '') output = m.content
            if (m.type === 'tool_use') toolCount += 1
          }
          view.push({
            ...turn,
            output,
            status: run?.status ?? null,
            toolCount,
            // `Run` 上没有 durationMs（那是 AgentResult 上的），用两个时间戳算。
            durationMs:
              run?.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null,
          })
        }
        /**
         * 这个对话**实际**在哪个目录里跑。
         *
         * `conversation.workDir` 为 null 表示"让平台分配"，此时真正的目录是
         * 执行器按 subject 算出来的 `chat-<对话 id>`。这里**不去猜**：直接报
         * 最近那一轮 run 的真实 workDir，没有就报 null（界面显示"还没跑过"）。
         */
        const last = await store.lastChatTurnWithRun(id)
        const lastRun = last?.runId ? await store.getRun(last.runId) : null
        sendJson(res, 200, {
          conversation,
          turns: view,
          workDir: conversation.workDir ?? lastRun?.workDir ?? null,
        })
        return
      }

      if (req.method === 'PATCH') {
        const body = (await readJsonBody(req)) as { title?: unknown; workDir?: unknown }
        const patch: {
          title?: string
          workDir?: string | null
          updatedAt: number
        } = { updatedAt: Date.now() }
        if (typeof body?.title === 'string') {
          const title = body.title.trim()
          if (title === '') {
            // 空标题会让列表里出现一条**没有名字**的行，点都没法点。
            sendJson(res, 400, { error: '标题不能为空', code: 'title_required' })
            return
          }
          patch.title = title.slice(0, 200)
        }
        if (body?.workDir !== undefined) {
          if (body.workDir !== null && typeof body.workDir !== 'string') {
            sendJson(res, 400, { error: 'workDir 只能是字符串或 null' })
            return
          }
          const dir = typeof body.workDir === 'string' ? body.workDir.trim() : ''
          // ★ 明确区分两个意思：`null` = 「让平台分配」（回到 `chat-<对话 id>`），
          //   空串 = 调用方搞错了。收下空串会得到一个"设了但等于没设"的目录。
          if (typeof body.workDir === 'string' && dir === '') {
            sendJson(res, 400, {
              error: 'workDir 不能是空串。要回到平台分配就传 null。',
              code: 'workdir_empty',
            })
            return
          }
          patch.workDir = typeof body.workDir === 'string' ? dir : null
        }
        const next = await store.updateConversation(id, patch)
        if (!next) {
          sendJson(res, 404, { error: '对话不存在' })
          return
        }
        sendJson(res, 200, next)
        return
      }

      if (req.method === 'DELETE') {
        const done = await store.deleteConversation(id)
        // ★ 说清"本来就没有"，而不是回 200 假装删成功：界面据此刷新列表，
        //   而一个静默成功的空操作会让人以为刚才那次点击没生效。
        sendJson(res, done ? 200 : 404, done ? { ok: true } : { error: '对话不存在' })
        return
      }

      sendJson(res, 405, { error: '这个地址只接受 GET / PATCH / DELETE' })
      return
    }

    // ── 说一轮 ──
    const turnsMatch = /^\/api\/conversations\/([^/]+)\/turns$/.exec(path)
    if (turnsMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '这个地址只接受 POST' })
        return
      }
      const id = turnsMatch[1] as ConversationId
      const conversation = await store.getConversation(id)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        sendJson(res, 404, { error: '对话不存在' })
        return
      }
      const body = (await readJsonBody(req)) as { text?: unknown }
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') {
        sendJson(res, 400, { error: '缺少 text', code: 'text_required' })
        return
      }
      // 执行者可能在这中间被删掉了。**这时候要说清是哪一步坏了**，而不是
      // 静默换一个人接着聊——那会让上文与新 agent 的指令混在一起。
      const agent = await store.getAgent(conversation.agentId)
      if (!agent) {
        sendJson(res, 409, {
          error: '这个对话的执行者已经被删掉了。换一个执行者要新建对话：' +
            '上文的延续是那个 CLI 的会话，换人接不上。',
          code: 'agent_gone',
        })
        return
      }
      const out = await submitChatTurn(
        store,
        executor,
        conversation,
        agent,
        text,
        Date.now(),
        workRoot,
      )
      if (out.failure === 'no_capacity') {
        res.setHeader('retry-after', String(Math.ceil((out.retryAfterMs ?? 2000) / 1000)))
        sendJson(res, 429, out)
        return
      }
      if (out.failure === 'error') {
        sendJson(res, 500, out)
        return
      }
      sendJson(res, 202, out)
      return
    }

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
      // ★ 智能体组展开（D70 增量添加）
      //    `SubmitRunRequest.groupId` → 现有字段
      // ══════════════════════════════════════════════════════════════════
      //
      // 组 = "执行 → 审核 → 行动"整条链的**默认配置**。带 `groupId` 时，在写入
      // 前把组展开成现有字段（`agentRef` / `reviewerAgentId` / `allowedActions` /
      // `actionParams` / `debugActions` / `maxReworks`）——**展开后跑的是同一条
      // 老链路**（`autoChainReview` / `decideReview` / 返工逻辑一行不改）。
      //
      // 展开规则：
      //   · **执行者由组决定**：`agentRef.id` 必须等于组的执行者（前端选组后
      //     用组的执行者填 agentRef）。不一致 = 矛盾的意图（"选了组又手动指定
      //     别人执行"），拒绝而不是猜哪个赢。
      //   · **其余字段是覆盖**：请求体**省略**对应字段 ⇒ 用组的默认；**给了值**
      //     ⇒ 这一次用它（与老路径"省略 = 跟随"同一套三态纪律）。
      //   · 组必须存在、**enabled**、形态合法（`checkGroupShape`：恰好 1 执行 +
      //     1 审核）。形态不对在组写入时已经拦过一遍，这里再拦是防"组被改坏 /
      //     成员被删"。
      //   · `Run.groupId` 由 `executor.submit` 落库（记录用，见 `Run.groupId`）。
      // ⚠️ 组只对**执行 run** 有意义：组回答的是"这条链谁执行、谁审、判完允许动什么"，
      //   而一条审核 run 不会再被审一次、也不会再派一条链出来。
      //
      //   这一条校验必须**先于**下面那段展开：展开会把组的审核者写进
      //   `body.reviewerAgentId`，然后那条"非执行 run 不许带 reviewerAgentId"的校验
      //   会先开火——而它报的是**使用者压根没发过**的字段名（他只发了 `groupId`）。
      //   实测过：错误信息字面上在说 `reviewerAgentId`，而请求体里没有这个键，
      //   排查方向直接被带偏。所以这里单独拒，并且点名 `groupId`。
      if (body.groupId !== undefined && body.kind !== 'execute') {
        sendJson(res, 400, {
          error:
            `groupId 只对执行 run（kind:'execute'）有意义，而这条 run 的 kind 是` +
            `「${body.kind}」。组描述的是"谁执行 → 谁审 → 判完能做什么"这条链，` +
            `而审核 run 是这条链的**产物**（它的审核者由被审的那条执行 run 带下来）。`,
          code: 'group_not_applicable',
        })
        return
      }

      if (body.groupId !== undefined) {
        const group = await store.getGroup(body.groupId as AgentGroup['id'])
        if (!group) {
          sendJson(res, 400, {
            error: `智能体组不存在：${body.groupId}。它可能已经被删掉了，请重新选一个。`,
            code: 'group_not_found',
          })
          return
        }
        if (!group.enabled) {
          sendJson(res, 400, {
            error: `智能体组「${group.name}」已停用。在智能体组页把它启用后再选。`,
            code: 'group_disabled',
          })
          return
        }
        const members = (
          await Promise.all(group.members.map((id) => store.getAgent(id as Agent['id'])))
        ).filter((a): a is Agent => a !== null)
        const shape = checkGroupShape(group, members)
        if (!shape.ok) {
          // ★ 必须点名**是哪个组**：形态错误的那几句（"组里有 2 个执行者…"）单独看
          //   没有主语，而使用者库里有好几个组时，他不知道自己该去改哪一个。
          //   实测过：报错说"组里没有审核者"，而使用者第一反应是"我哪来的组"。所以
          //   前面挂上组名与组 id（点名的那个 id 正是他要打开的那条记录）。
          sendJson(res, 400, {
            error:
              `智能体组「${group.name}」（${group.id}）的形态不合法，不能用来派活：` +
              shape.issues.join('；'),
            code: 'group_shape_invalid',
          })
          return
        }
        if (body.agentRef.id !== (shape.executor.id as string)) {
          sendJson(res, 400, {
            error:
              `选了智能体组「${group.name}」，但请求里的执行者是「${body.agentRef.name}」` +
              `（id ${body.agentRef.id}）——组的执行者是「${shape.executor.name}」。` +
              `选组时执行者由组决定；要换执行者就别选组，直接在下面选人。`,
            code: 'group_executor_mismatch',
          })
          return
        }
        // 覆盖优先：省略 ⇒ 组默认。`agentRef` 已校验与组的执行者一致，
        // 快照（name/instructions）用请求体传的（前端从 agents store 拿的，
        // 与 daemon 里的同一份数据）。
        if (body.reviewerAgentId === undefined) body.reviewerAgentId = shape.reviewer.id as string
        if (body.allowedActions === undefined) body.allowedActions = group.allowedActions
        if (body.actionParams === undefined) body.actionParams = group.actionParams
        if (body.debugActions === undefined) body.debugActions = group.debugActions
        if (body.maxReworks === undefined) body.maxReworks = group.maxReworks
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
      // ══════════════════════════════════════════════════════════════════
      // ★ 本次任务的审核者覆盖（`SubmitRunRequest.reviewerAgentId`）
      // ══════════════════════════════════════════════════════════════════
      //
      // 为什么在写入之前校验：审核者的合法性**只有这一刻能查**。等执行跑完
      // 再发现"指定的审核者其实是个执行者"，使用者已经等了一轮执行，而且
      // 更糟的是那一刻只能静默跳过审核——一条本该被审的产出会看起来正常结束。
      //
      // 三种坏值分别报清楚，因为它们对应三种不同的改法：
      //   - 不存在 ⇒ 删掉了，换一个
      //   - 不是审核者角色 ⇒ 选错了
      //   - 与执行者同一个 ⇒ INV-1（自我审核 = 闭环失效）
      //
      // ⚠️ 非 execute 的 run 带上这个字段一律**拒绝**，而不是收下不用：
      //   审核 run 自己不会再被审一次，收下它就是收下一个永远不会生效的设置——
      //   而"设了但没生效"在这里是最贵的一类错（使用者以为换人审了）。
      if (body.reviewerAgentId !== undefined && body.kind !== 'execute') {
        sendJson(res, 400, {
          error:
            `reviewerAgentId 只对执行 run（kind:'execute'）有意义，` +
            `而这条 run 的 kind 是「${body.kind}」。审核 run 不会再被审一次。`,
          code: 'reviewer_override_not_applicable',
        })
        return
      }
      if (body.reviewerAgentId !== undefined && body.reviewerAgentId !== null) {
        const wanted = body.reviewerAgentId
        const picked = await store.getAgent(wanted as Agent['id'])
        if (!picked) {
          sendJson(res, 400, {
            error: `指定的审核者不存在（${wanted}）。它可能已经被删掉了，请重新选一个。`,
            code: 'reviewer_not_found',
          })
          return
        }
        // ⚠️ **顺序**：先判"是不是执行者自己"，再判角色。
        //
        //   反过来的话 `reviewer_must_differ` 就成了一句到不了的话：把一个执行者
        //   指定成它自己的审核者时，命中的会是"角色不是 reviewer"，于是使用者读到
        //   "这个 agent 不是审核者"——**指错方向**。他真正做错的是"你想让它审自己"。
        //
        //   （这里不比角色：`agentRef` 是执行者时它当然是 executor，拿角色做判据
        //   等于把这条检查关掉。判据只能是 id。）
        if ((picked.id as string) === (body.agentRef.id as string)) {
          try {
            assertReviewerDistinct(picked.id, {
              type: 'run',
              run: { agentId: body.agentRef.id } as Run,
            })
          } catch (err) {
            sendJson(res, 400, {
              error: err instanceof Error ? err.message : String(err),
              code: 'reviewer_must_differ',
            })
            return
          }
        }
        if (picked.role !== 'reviewer') {
          sendJson(res, 400, {
            error:
              `agent「${picked.name}」的角色是「${picked.role}」，不能当审核者。` +
              `审核者必须是一个 role 为 reviewer 的 agent。`,
            code: 'reviewer_role_mismatch',
          })
          return
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // ★ 任务级动作配置（D42 白名单 + D43 固定参数）
      //    `SubmitRunRequest.allowedActions` / `SubmitRunRequest.actionParams`
      // ══════════════════════════════════════════════════════════════════
      //
      // 新建任务页 ③ 上勾的那份决定（白名单）与为动作钉的固定参数。三条判据，
      // 缺一条都会留下一类"到跑起来才发现"的失败：
      //
      //   1. **只对执行 run 有意义**：审核 run 的动作配置来自被它审的那条执行
      //      run（`createRunForReviewer` 带下去），从外面另塞一份就是第二个出处。
      //      与 `reviewerAgentId` 同一条规矩：**收下不用的字段比拒掉更贵**。
      //   2. **每条动作都必须来自已安装的工具包**——判据与组配置页 ③ 的「行动权限」
      //      完全同一套（`parseAllowedActions` / `parseActionParams`），
      //      理由也是同一个：等到跑起来才发现"策略要的动作找不到包"，在无人值守下
      //      就是每次任务都以同一个原因失败。这里复用那个函数而不是重写一遍，
      //      免得两处判据分叉。
      //   3. **这一次得有审核者**：没有审核者就没有判决，也就没有任何动作会被
      //      触发——那时这份配置**没有落点**。收下它会让使用者以为"我配了动作"，
      //      而实际上这条链路上什么都不可能发生。
      // ★ 任务级返工次数（D45）：**早拒**。
      //
      //   ⚠️ 它**必须在**下面那个"给了动作才校验"的 `if` 块**外面**：返工次数与
      //   "这一次允许触发什么动作"是两件无关的事，放进那个块里就会出现
      //   "只配了返工、没碰动作 ⇒ 校验整段被跳过"——一个 `-1` 或者 `99` 于是
      //   畅通无阻地进了执行器，而它决定的是"最多再烧几次 CLI 的钱"。
      //   （这个位置错误是被 `rework-e2e.test.ts` 抓出来的：那条用例只给
      //   `maxReworks`，于是越界值拿到了 202 而不是 400。）
      if (body.maxReworks !== undefined) {
        const n = body.maxReworks
        // `null` = 无限（合法值）；只有"给了有限数却越界 / 不是整数"才拒。
        if (n !== null && (!Number.isInteger(n) || n < 0 || n > MAX_REWORKS)) {
          sendJson(res, 400, {
            error: `返工次数必须是 0 到 ${MAX_REWORKS} 之间的整数，或 null（无限返工）`,
            code: 'max_reworks_out_of_range',
          })
          return
        }
      }

      if (body.allowedActions !== undefined || body.actionParams !== undefined) {
        if (body.kind !== 'execute') {
          sendJson(res, 400, {
            error:
              `allowedActions / actionParams 只对执行 run（kind:'execute'）有意义，` +
              `而这条 run 的 kind 是「${body.kind}」——审核 run 的动作配置来自` +
              `被它审的那条执行 run。`,
            code: 'allowed_actions_not_applicable',
          })
          return
        }

        // 这次到底有没有**能用的**审核者。
        //
        // ⚠️ 2026-10：这段原来有**两支**（"显式给的"与"跟随执行者长期配置的"），
        //    因为一个执行者可以长期指定审核者。那条路整个撤掉了，所以现在只有一支：
        //    **有 `reviewerAgentId` 才算有**（它只可能由组展开写进来）——缺字段与
        //    `null` 同义，都是"这一次没有审核者"。
        //
        // ⚠️ 判据与 `autoChainReview` 同一套（那边负责在跑完之后**跳过并说明**；
        //    这里负责在写入之前**拒掉**）：两处各写一套必然分叉，而分叉的表现是
        //    "提交时说有审核者、跑完却没人审"。
        const reviewerCheck: { ok: true } | { ok: false; error: string } =
          typeof body.reviewerAgentId === 'string' && body.reviewerAgentId !== ''
            ? // 上面那一段已经查过存在性与角色了。
              { ok: true }
            : {
                ok: false,
                error:
                  '这条任务没有审核者（没选智能体组，或者这一次被显式设成了不审），' +
                  '所以动作配置没有落点——不会有判决，也就不会有任何动作被触发。' +
                  '要么选一个智能体组（组的审核者就是这条链的审核者），' +
                  '要么把动作白名单/固定参数去掉。',
              }
        if (!reviewerCheck.ok) {
          sendJson(res, 400, {
            error: reviewerCheck.error,
            code: 'allowed_actions_without_reviewer',
          })
          return
        }

        // ★ 白名单解析**只在客户端真的给了它时**做：省略 = 跟随（那个 key 根本
        //   不进请求体），而 `parseAllowedActions(undefined)` 会给出 `[]`——
        //   把它写回 `body.allowedActions` 就等于把"跟随"悄悄折成了
        //   "这一次一个动作都不许"，上面那整段注释防的正是这个。
        if (body.allowedActions !== undefined) {
          const parsed = parseAllowedActions(
            body.allowedActions,
            await store.listTools(workspaceId),
          )
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error, code: 'allowed_actions_unresolvable' })
            return
          }
          body.allowedActions = parsed.value
        }

        // ★ 任务级固定参数（D43）：判据与 agent 的固定参数同一套
        //   （`parseActionParams`）。只对执行 run 有意义、必须有审核者——
        //   上面那两条已经拦过（同一个 `if` 块），这里只管"参数本身合不合规"。
        if (body.actionParams !== undefined) {
          const paramsParsed = parseActionParams(
            body.actionParams,
            await store.listTools(workspaceId),
          )
          if (!paramsParsed.ok) {
            sendJson(res, 400, { error: paramsParsed.error, code: 'action_params_unresolvable' })
            return
          }
          body.actionParams = paramsParsed.value
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
            // ⚠️ 这里原来带 `allowedActions: s.allowedActions`。D40 收口之后
            //    skill 载荷里没有这一项了（动作权限住在 `Agent.allowedActions`）。
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
           * ★ 这条 run 来自哪个**智能体组**（`null` = 没选组，或者它的组已经被删）。
           *
           * ⚠️ 2026-10 加这个字段是为了让页面能说清"审核者**是从哪来的**"：组的
           *    审核者与"这一次单独指定"在库里都只表现为 `reviewerAgentId` 有值
           *    （见下面的 `reviewer`），而这两件事的**后续**完全不同——一个随组走
           *    （改了组，以后的任务跟着变），一个只对那一条任务有效。少了这个字段，
           *    页面只能含糊地说"由某某审"，而使用者分不清"我改了组到底有没有生效"。
           *
           * ⚠️ 组被删之后这里是 `null`（不是原 id）：那个 id 已经不指向任何东西，
           *    留着一个"悬空 id"只会让页面显示出错的信息。
           */
          groupId:
            run.groupId !== undefined && (await store.getGroup(run.groupId as AgentGroup['id']))
              ? run.groupId
              : null,
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
           * ★ 这条 run **有没有审核者**、是谁（见 `Run.reviewerAgentId`）。
           *
           *   为什么不直接给一个 `reviewerAgentId: string | null`：页面要如实显示
           *   "这条任务没人审"，而 `null` 这个值本身读不出这层意思（它长得像"没填"）。
           *   所以给一个带 `mode` 的小对象，让"没人审"是一个**说得出口的状态**。
           *
           *   ⚠️ 2026-10：这里原来是**三态**（`follow` / `none` / `override`）。
           *   `follow` 那一态（"没点名 ⇒ 跟随执行者身上那条长期配置"）随着
           *   `Agent.reviewerAgentId` 一起撤销了——没有可跟随的东西，也就没有
           *   "跟随着谁"要显示。现在只有两态：
           *
           *     `assigned` ⇒ 有审核者（**可能来自组**，也可能是这一次指定的；要区分
           *                  看 `Run.groupId`），字段里给的就是它；
           *     `none`     ⇒ 这条任务没有审核者（缺字段与 `null` 在这里同义）。
           *
           *   只在 execute run 上有意义（review run 自己不会再被审一次）。
           */
          reviewer:
            run.kind !== 'execute'
              ? null
              : run.reviewerAgentId === undefined || run.reviewerAgentId === null
                ? { mode: 'none' as const }
                : { mode: 'assigned' as const, agentId: run.reviewerAgentId },
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
           *
           * ★ D46：这里**不再按 `run.kind === 'review'` 过滤**。
           *
           *   人工裁决可能挂在**执行 run** 上——"压根没配审核者"那种任务没有
           *   审核 run 可挂（见 `canHostHumanVerdict`）。而这条响应是阶段推导
           *   读判决的**唯一**入口，过滤掉执行 run 就等于"人工裁决落库了、
           *   看板却看不见"：那正是这条路由最要防的失效。
           *
           *   对模型判决**没有任何影响**：模型判决挂在审核 run 上，执行 run 上
           *   本来就一条都没有（`listVerdictsByRun` 返回空 ⇒ `null`，与改动前
           *   逐字相同）。
           *
           * ⚠️ 与下面 `action` 那条**刻意不对称**：动作仍然只在审核 run 上找。
           *    人工裁决永远不带动作（D46 规矩②），所以对执行 run 找动作恒为
           *    `null`——多查一次库换一个必然的空值，不如不查。
           */
          verdict: await store.listVerdictsByRun(run.id).then((vs) => {
            const v = vs[vs.length - 1]
            return v
              ? {
                  status: v.status,
                  conclusion: v.conclusion,
                  // 结论之外的"为什么"——人要看的就是这一句
                  escalateReason: v.escalateReason,
                  /**
                   * ★ 这条判决是谁做的（D46）。缺字段 ≡ `'agent'`（老数据）。
                   *
                   *   阶段推导要用它：人工判「不通过」与审核者判「不通过」要给出
                   *   **不同的那句话**（"你判了不通过"vs"审核不通过"）——前者要你
                   *   去看自己刚才的决定，后者要你去查审核意见。给同一句话，等于
                   *   把"哪里需要我"这条最有用的信息抹平。
                   */
                  source: v.source ?? ('agent' as const),
                }
              : null
          }),
          /**
           * ★ 这条判决**要求做的那个动作**的结果。
           *
           * ══════════════════════════════════════════════════════════════════
           * 为什么必须给页面：不然「已审查」是一句会骗人的话
           * ══════════════════════════════════════════════════════════════════
           *
           * 判决通过 ≠ 事情做完了。动作可能还在跑、也可能**失败了**——而失败
           * 过去只在通知里说了一声，任务列表上照样显示「已审查」（那是"判决已产出"
           * 的意思，不是"事情已成"）。使用者的原话是："审核通过并行动成功才最后
           * 算通过"。
           *
           * 与 `verdict` 同源同法：**只给最新的那一份**（一次判决一条动作；重放被
           * 幂等键去重，重试会落在新的判决上）。`error` 一起给——失败原因正是
           * "要我去做什么"。
           */
          action:
            run.kind === 'review'
              ? await store.listVerdictsByRun(run.id).then(async (vs) => {
                  const v = vs[vs.length - 1]
                  if (!v) return null
                  const actions = await store.listActionsByVerdict(v.id)
                  const a = actions[actions.length - 1]
                  if (!a) return null
                   // ⚠️ 这里原来只给 `{status, type, error}`，于是**成功的动作在界面上
                   //    只剩一句"已执行"**：`result`（脚本回的那句"做了什么"、退出码、
                   //    耗时）与 `params`（它到底带着什么参数跑的）都被丢在这里。
                   //    使用者的反馈正是这个：「配了行动，但看不到行动的结果和它的
                   //    反馈信息」——数据一直在库里，只是从来没送出去。
                   return {
                     id: a.id,
                     status: a.status,
                     type: a.type,
                     error: a.error,
                     /** 脚本回的结构：`{ ok, detail, exitCode, durationMs, dryRun }`。 */
                     result: a.result,
                     /** **合并后**的参数（bound 平台注入 / open 模型填 / 界面固定值）。 */
                     params: a.params,
                     finishedAt: a.finishedAt,
                   }
                })
              : null,
        })),
      )
      sendJson(res, 200, { runs })
      return
    }

    const runMatch =
      /^\/api\/runs\/([^/]+)(?:\/(events|cancel|artifacts|messages|files|file|human-verdict))?$/.exec(
        path,
      )
    if (runMatch) {
      const runId = runMatch[1] as RunId
      const sub = runMatch[2]

      if (req.method === 'GET' && sub === undefined) {
        const run = await store.getRun(runId)
        if (!run) return sendJson(res, 404, { error: 'run 不存在' })
        sendJson(res, 200, run)
        return
      }

      // ══════════════════════════════════════════════════════════════════
      // 删除一条 run（任务列表每项右侧的「删除」按钮）
      // ══════════════════════════════════════════════════════════════════
      //
      // 连带范围在 `Store.deleteRun` 的文档里（messages / verdicts / actions /
      // artifacts / 引用它的对话轮次一起删；**审计与 blob 不删**——可追溯性
      // 是"发生过什么"的不可变历史）。这里只守两道闸：
      //
      //   ① 别的 workspace 的 run 一律当"不存在"（404，与 human-verdict 同一口径）；
      //   ② **运行中的不能删**（409）：删了它，正在跑的进程还在写
      //      `runs/<id>/messages.jsonl`，而文件已经没了——留下一个写完就丢、
      //      状态永远卡住的残骸。先「取消」或等它结束再删。
      //
      //   非终态判断复用本文件已有的 `TERMINAL_RUN_STATUSES`（补集就是
      //   `reconcile.ts` 的 `NON_TERMINAL_RUN_STATUSES`——deferred/queued/
      //   dispatched/waiting_local_directory/running）。
      if (req.method === 'DELETE' && sub === undefined) {
        const run = await store.getRun(runId)
        if (!run || run.workspaceId !== workspaceId) {
          sendJson(res, 404, { error: 'run 不存在' })
          return
        }
        if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
          sendJson(res, 409, { error: '这条 run 还在执行中，先取消或等它结束再删除' })
          return
        }
        await store.deleteRun(runId)
        sendJson(res, 200, { ok: true })
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

      // ══════════════════════════════════════════════════════════════════
      // 人工裁决（D46）
      // ══════════════════════════════════════════════════════════════════
      //
      // 判决一直是**只能由模型产出**的（D21：verdict 只由 review run 产出）。
      // 这条路由给「人」开了一个口子，所以边界要写清楚：它**不是"另一个审核者"**，
      // 它是**在审核结论之上的裁决**。
      //
      // ── 为什么需要它 ──
      //
      // 在这之前，一条任务的判决只可能落在三种"卡住"状态里，而界面上**没有
      // 任何出路**：
      //
      //   · 判 `fail` 且没有返工额度（用完或没配）⇒ 进「等待人处理」；
      //   · 判 `needs_human` ⇒ 进「等待人处理」；
      //   · 判决不合规且不可重试 ⇒ 同样。
      //
      // 人点进去只能看到结论，唯一的按钮是「继续沟通」——而那是**再派一次活给
      // agent**，不是"我自己来定"。于是"我看过了，这条我认可"这件事在整个系统里
      // **无法表达**（看板的阶段是从记录推出来的，界面上改一个变量刷新就没了）。
      //
      // ── 三条硬规矩 ──
      //
      // ① **它是追加，不是覆盖**（DR-3「历史不得被覆盖」）。模型那条判决原样
      //    留着，人这条是**新记录**。所以"当初被判过 fail、后来被人判 pass"
      //    可以从记录里读出来。哪条生效由 `createdAt` 决定
      //    （`listVerdictsByRun` 已按它排序，消费方取末条）。
      //
      // ② **不触发任何动作**。人在这里只是下结论。动作仍然只能来自判决里的
      //    `action`，而那条 `action` 由**模型**在判决里写出来（D41/D43）。
      //    让人在这顺带挑一个动作执行，等于把"动作必须来自判决"这条不变量拆掉
      //    ——动作就再也没有一个可审计的出处了。要动东西，仍然得走"让审核者
      //    判 pass 并给出动作"那条路。
      //
      // ③ **只在有可裁决的结论时允许**。见 `canHostHumanVerdict` 的注释——
      //    那是这次改动最容易出错的地方：一个"点了通过、看板却不动"的按钮，
      //    比没有这个按钮更糟。
      //
      // ⚠️ 刻意**不暴露给 MCP**（`apps/mcp`）。MCP 的暴露面本来就是刻意窄的
      //    （见那份文件开头），而这条路由的语义是"人看了产出之后的决定"——
      //    给出去等于让别的 agent 冒充人下裁决，而"谁做的决定"正是这份记录
      //    唯一的价值。
      if (req.method === 'POST' && sub === 'human-verdict') {
        const run = await store.getRun(runId)
        // 别的 workspace 的 run 一律当"不存在"（404）：这里只有一个 workspace，
        // 但把"不属于我"说成"没有"是这套接口一贯的口径。
        if (!run || run.workspaceId !== workspaceId) {
          sendJson(res, 404, { error: 'run 不存在' })
          return
        }

        // ★ 请求体**逐项校验**，不是信任类型声明（与 `POST /api/reports` 同一条
        //   口径）：类型是编译期的，这里是运行时的任意 JSON。
        const parsed = SubmitHumanVerdictRequest.safeParse(await readJsonBody(req))
        if (!parsed.success) {
          sendJson(res, 400, {
            error: `人工裁决的请求不合法：${parsed.error.issues
              .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
              .join('；')}`,
          })
          return
        }

        const gate = await canHostHumanVerdict(store, run)
        if (!gate.ok) {
          // 409 而不是 400：请求本身是合法的，是**这条 run 现在的状态**不允许。
          sendJson(res, 409, { error: gate.reason })
          return
        }

        const now = Date.now()
        const record: VerdictRecord = {
          id: ulid(now) as VerdictRecord['id'],
          workspaceId,
          runId: run.id,
          subject: run.subject,
          /**
           * ★ 恒为 `advisory`，而且这不是"暂时只支持通过"——是**没有别的可能**：
           *
           *   `advisory` 的定义本来就是"**通过、但没有动作要做** ⇒ 只记录"。
           *   人工通过不触发动作（规矩②），所以它正好就是这个状态；`stageOf`
           *   于是把任务判成「已完成审查」。
           *
           *   另两个出路**不走这条路由**，各自有自己的机制（见
           *   `SubmitHumanVerdictRequest` 的注释）：
           *     · 要它重做 ⇒ 派一条新的执行 run（就是「反馈」＝「发送并继续」）
           *     · 不要了   ⇒ 改 issue 的状态（`POST /issues/{id}/abandon`）
           *   所以这里没有"另一个结论"可选。曾经有过一个 `fail`，它被删掉是因为
           *   **没有生产者**——留一个没人发的取值只会让下一个人以为它可用。
           *
           *   ⚠️ 不走 `ReviewCoordinator`：那个类的职责是"把**模型**的输出收口成
           *      判决"，里面挂着重试计数、返工派发、通知。人工裁决不需要任何
           *      一件——它不重试（人不会"格式不对"）、不派返工（要返工是人自己
           *      的决定，不是这条路由替他做的）、也不发通知（人刚做完这个决定，
           *      通知给谁看）。
           */
          status: 'advisory',
          conclusion: 'pass',
          reasonCode: 'human_decision',
          /**
           * `confidence` 对人工裁决**没有意义**（人不是概率输出），但 schema 要求
           * 它在 `0..1`。取 `1` 表示"这就是决定"；取 `0` 会被任何统计读成
           * "完全没把握"——那是方向相反的误读，比留一个无意义的 1 更坏。
           */
          confidence: 1,
          /** 空的：人没有逐条发现（理由在 `humanReason` 里，两者刻意不混）。 */
          findings: [],
          action: null,
          escalateReason: null,
          invalidResolution: null,
          skillRefs: [],
          /** 没有模型、没有 prompt ⇒ 如实留空，不编一个占位值。 */
          modelId: null,
          promptHash: null,
          source: 'human',
          /**
           * ★ 没写理由 ⇒ `null`，这是**正常状态**不是缺失（见 `local-api.ts` 里
           *   `SubmitHumanVerdictRequest` 的注释）。所以 `''` 也要折成 `null`：
           *   存空串会让消费方分不清"没写"和"写了个空"。
           */
          humanReason: parsed.data.reason === '' ? null : (parsed.data.reason ?? null),
          createdAt: now,
        }
        await store.insertVerdict(record)
        sendJson(res, 201, { verdictId: record.id, status: record.status })
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
        // ★ "哪些是平台注入的"按**这个 run 用的 runtime** 算。
        //   写死 `.claude/` 的版本对别的 CLI 会把注入物当成 agent 的产出显示。
        const owner = await store.getAgent(run.agentId as never)
        const managed = managedPathsFor(getRuntimeDescriptor(owner?.runtimeKey ?? 'claude'))
        await sendWorkDirListing(res, run.workDir, dir, managed)
        return
      }

      if (req.method === 'GET' && sub === 'file') {
        const run = await store.getRun(runId)
        if (!run) return sendJson(res, 404, { error: 'run 不存在' })
        if (!run.workDir) return sendJson(res, 404, { error: '这条 run 没有工作目录' })

        await sendWorkFile(res, req, run.workDir, url.searchParams.get('path') ?? '')
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
        `端口 ${options.port} 已被占用。agentdeck 不自动换端口——` +
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
    skillsRoot,
    skillsMineRoot,
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
 * 校验角色（原来还管"由谁审我"的配对，2026-10 起那件事整个撤掉了）。
 *
 * ⚠️ 这个函数现在只剩一条规则：**角色必须是两者之一**，缺省 `executor`——新建一个
 *    agent 时"它能干活"是最合理的默认；默认成审核者会让它悄悄进入审核小组。
 *
 * 它原来还校验两件事，都随 `Agent.reviewerAgentId` 一起删掉了：
 *   · "审核者不能是自己"（INV-1）—— 现在"谁审"由**组**决定，组形态校验器保证
 *     恰好 1 执行 + 1 审核，两者不可能相同（`packages/domain/src/groups/shape.ts`），
 *     而 `POST /api/runs` 上另有一道显式校验（`assertReviewerDistinct`）；
 *   · "指向的必须是一个真实存在的 reviewer" —— 那个检查现在归组的形态校验器管
 *     （成员会被删，所以**组每次派活时都要再校验一遍**，这比在写入口校验一次更强）。
 */
async function validateRole(role: unknown): Promise<
  | { ok: true; role: AgentRole }
  | { ok: false; error: string }
> {
  const value = role === undefined ? 'executor' : role
  if (value !== 'executor' && value !== 'reviewer') {
    return { ok: false, error: `role 必须是 'executor' 或 'reviewer'（收到 ${JSON.stringify(role)}）` }
  }
  return { ok: true, role: value }
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
    chatTemplate: '',
    // 默认智能体（D36）：首启那一对 agent 就在这里建，顺手把执行者设为默认——
    // "建完就派"的那个流程于是有确定的行为，而不是依赖"列表里第一个是谁"。
    defaultAgentId: null,
    // 界面语言（D39）：中文（本项目的默认语言）
    locale: DEFAULT_LOCALE,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertWorkspace(workspace)

  const device = await store.getDevice()
  if (!device) {
    const { hostname } = await import('node:os')
    await store.upsertDevice({
      id: ulid() as import('@agentdeck/protocol').DeviceId,
      name: hostname(),
      createdAt: now,
      lastSeenAt: now,
    })
  }

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
    // ★ 判据（2026-09 三次改）：这是**纯判据**，一个判决词都不出现（pass /
    //   fail / needs_human 是平台的事，由判决契约 `{{verdict}}` 统一说明）。
    //   顺带修掉过时的"按挂载的审核标准"——2026-09 标准已并进「指令」，没有
    //   挂载这回事了。
    instructions:
      '你是一个严格的审核者。逐条核查被审核的内容：每条结论都要有依据，' +
      '证据要能指回原文；不要替对方补上你认为对的要求。',
    model: null,
    runtimeKey: 'claude',
    workDir: null,
    // 判断依据全在「指令」里（2026-09），这里不再挂 skill
    skillIds: [],
    env: {},
    role: 'reviewer',
    // ★ 首启的审核者**没有**独立的标准字段（2026-09：标准并进「指令」；
    //   老数据的兼容读取走 `reviewerIdentity`，不从这里来）。
    reviewStandard: null,
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
    env: {},
    role: 'executor',
    // 执行者没有「审核身份」这回事（那是审核者那一侧的东西）
    reviewStandard: null,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertAgent(agent)

  // ★ 首启就把刚播下的执行者设为「新建任务的默认智能体」（D36）：使用者建完
  //   第一件事就是"新建任务"，而那一步不该让他先想"交给谁"。这个默认随时可改
  //   （智能体卡片上的按钮）。
  await store.insertWorkspace({ ...workspace, defaultAgentId: agent.id, updatedAt: Date.now() })

  // ★★ 播种一个**智能体组**（2026-10）。
  //
  //   为什么必须补这一步：这两句 agent 原来是**靠 `reviewerAgentId` 串起来**的
  //   （"首启就是一条通的闭环"），而那个字段已经整个撤掉——谁审现在**只有组**能
  //   回答。不播种组的话，首启会留下一对永远碰不到一起的人：执行者跑完没人审、
  //   审核者永远收不到活（而且没有任何地方报错）。
  //
  //   动作权限留空：判完能做什么是使用者的决定（默认一个都不许，与之前播种的
  //   默认审核者一致——那时那份名单也是空的）。
  const group: AgentGroup = {
    id: ulid() as AgentGroup['id'],
    workspaceId: workspace.id,
    // 省略 `mode` = 工作流（`GroupMode` 的唯一合法值），与"只在创建时写入"同一条规矩
    name: '默认组',
    members: [agent.id, reviewer.id] as AgentGroup['members'],
    allowedActions: [],
    actionParams: {},
    debugActions: [],
    maxReworks: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertGroup(group)

  // ★ 顺便说清"技能库是空的"：使用者打开 Skills 页看到空列表时，不该以为是坏了
  //   （D38：审核标准内联在审核者身上，不再播种成 skill）。
  info(
    `已初始化工作区、两个 agent 与一个智能体组：${agent.name}（执行）→ ${reviewer.name}` +
      `（审核，判据写在它的「指令」里）——它们靠「默认组」串起来，新建任务时选这个组` +
      `就是这条闭环。技能库是空的：审核标准不放在 skill 里，要装 skill 请去「Skills」页。`,
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
  const resolved = agent.skillIds.flatMap((id) => {
    const skill = byId.get(id as string)
    return skill ? [skill] : []
  })
  // ★ 同 slug 遮蔽（D80，设计 §1.1）：提炼的（mine）优先于安装的。
  //   使用者挂的是安装版的 id，但库里已有他提炼的同 slug 版本——注入的是
  //   提炼版（那是他的资产；安装版被遮蔽，列表里标注）。
  const mineBySlug = new Map(
    all.filter((s) => s.source === 'mine').map((s) => [s.slug, s]),
  )
  return resolved.map((skill) => {
    if (skill.source === 'mine') return skill
    const mine = mineBySlug.get(skill.slug)
    return mine ?? skill
  })
}

export { parseVerdict }
export type { RunMessage }
