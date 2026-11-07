import { defaultCaptureFactory, DEFAULT_TRANSCRIBER_LOADER } from './defaults.ts'
import { probeVoiceCapability, type CapabilityDeps, type VoiceCapability } from './capability.ts'
import {
  ASR_MODELS,
  DEFAULT_ASR_MODEL,
  DEFAULT_MODEL_BASE_URLS,
  ensureModel,
  findModelSpec,
  modelState,
  type AsrModelSpec,
  type EnsureModelResult,
} from './models.ts'
import { readSettings, writeSettings, type VoiceSettings } from './settings.ts'
import type { CaptureFactory } from './capture.ts'
import { VoiceSession, type SessionLimits, type SessionSnapshot } from './session.ts'
import type { Transcriber, TranscriberLoader } from './transcriber.ts'
import { readVocab, writeVocab, type VoiceVocab } from './vocab.ts'
import { extractContextTerms } from './context-terms.ts'

/**
 * 语音这一块的**装配点**：能力、设置、词表、模型、会话，全在这里收口。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这一层（而不是在 server.ts 里直接连）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **会话是单例**：同时只开一个麦克风。这条纪律需要一个"谁持有它"的地方，
 *    散在路由里就会变成"两个请求各自 new 一个会话"（症状：第二个麦克风打不开，
 *    而错因看起来像权限问题）。
 * ② **模型上下文是常驻的**：`createWhisperContext` 要读几十到几百 MiB。这里缓存它，
 *    换模型时才 dispose 那个旧的。写在路由里的话，每个请求都会重新加载一遍——表现
 *    是"每说一句等三秒"。
 * ③ **测试要能注入**：假采集、假转写、假 fetch、假平台。都从这个构造函数的参数进。
 *
 * ★ 这一层**不认识**聊天、任务、skill、store。它只知道"麦克风 → 文本"。
 *   约束（不做向量检索、不自动记忆、不自动建链接、保存由上层 SKILL 控制）在代码里
 *   就是这一句：**这里没有任何一条写库的路径**。
 */

export interface VoiceServiceDeps extends Omit<CapabilityDeps, 'modelId'> {
  /** 上游模型地址（可换镜像）。 */
  modelBaseUrl?: string
  /** 注入 fetch（模型下载；测试绝不联网）。 */
  fetchImpl?: typeof fetch
  /** 注入采集（默认 decibri）。 */
  captureFactory?: CaptureFactory
  /** 注入转写加载器（默认 whisper-cpp-node）。 */
  transcriberLoader?: TranscriberLoader
  /** 会话的几条闸（测试把它调小，别真的等 8 秒）。 */
  limits?: Partial<SessionLimits>
  now?: () => number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  /** 会话状态变化（SSE / 轮询都靠它；这里只上报，不关心谁听）。 */
  onChange?: (snapshot: SessionSnapshot) => void
  /**
   * ★ 分批第 286 批：**从对话里抽词**的那一步由外面注入。
   *
   * ⚠️ 为什么不在这里直接读 store：这一层的纪律是"**不认识** store / skill / run"
   *   （见文件头）——它只知道"麦克风 → 文本"。识字的活儿交给 server 注入进来，
   *   边界就不动。将来任务页要接，也只需要在这里再开一个入口。
   */
  contextProvider?: (conversationId: string) => Promise<{
    userTexts: readonly string[]
    agentTexts?: readonly string[]
  }>
}

/** 结束的会话留几条结果给页面轮询（留太久会让内存慢慢长，全丢又会让"刚好在这次轮询
 *  之前结束"的那一次拿不到结果）。 */
const KEEP_FINISHED_SESSIONS = 5

export class VoiceService {
  private readonly deps: VoiceServiceDeps
  private readonly asrRoot: string
  private active: VoiceSession | null = null
  private readonly finished: SessionSnapshot[] = []
  private transcriber: Transcriber | null = null
  private transcriberKey = ''
  private modelEnsuring: Promise<EnsureModelResult> | null = null
  /**
   * 正在进行的下载进度（分批第 282 批）。
   *
   * ★ 为什么要单独记一份：`ensureModel` 是"下完才 resolve"的，而一次 57 MiB 的下载
   *   在慢网络下能跑几十秒——界面若只能显示"正在下载…"，人分不出"在动"和"卡死"。
   *   进度由 `onProgress` 写进来，界面轮询 `GET /api/voice/models/progress` 读它。
   * ⚠️ 只在内存里：daemon 重启就没了（那也正是"这次下载没在继续"的事实）。
   */
  private modelProgress: { modelId: string; done: number; total: number } | null = null
  private counter = 0

  constructor(deps: VoiceServiceDeps) {
    this.deps = deps
    this.asrRoot = deps.asrRoot
  }

  /** 当前设置（每次读盘：设置是人会手改的文件，缓存一份就等于把它变成只读）。 */
  async settings(): Promise<VoiceSettings> {
    return readSettings(this.asrRoot, ASR_MODELS.map((m) => m.id))
  }

  async updateSettings(input: unknown): Promise<VoiceSettings> {
    const next = await writeSettings(this.asrRoot, input, ASR_MODELS.map((m) => m.id))
    // 换模型⇒把旧的常驻上下文放掉（下次转写才会按新模型重新加载）
    await this.closeTranscriberIfModelChanged(next)
    return next
  }

  async vocab(): Promise<{ vocab: VoiceVocab; problems: string[] }> {
    return readVocab(this.asrRoot)
  }

  async updateVocab(input: unknown): Promise<{ vocab: VoiceVocab; problems: string[] }> {
    return writeVocab(this.asrRoot, input)
  }

  /**
   * 能力探测。
   *
   * ⚠️ 每次都重新读盘（模型文件可能刚被下好、也可能被人手删）⇒ 用进程内缓存会得到
   *   一个"卡在旧状态"的界面（实测过的经典报错："我刚下了模型，它还说没有"）。
   */
  async capability(modelId?: string): Promise<VoiceCapability> {
    const settings = await this.settings()
    return probeVoiceCapability({ ...this.deps, modelId: modelId ?? settings.model })
  }

  /**
   * 当前下载进度（没有在下载 ⇒ null）。
   *
   * ⚠️ `percent` 由服务端算好：界面不该自己相除（除零、取整不一致这类小事很容易
   *   在两边长出两种结果）。
   */
  modelDownloadProgress(): { modelId: string; done: number; total: number; percent: number } | null {
    const p = this.modelProgress
    if (p === null) return null
    const percent = p.total <= 0 ? 0 : Math.min(100, Math.round((p.done / p.total) * 100))
    return { ...p, percent }
  }

  /**
   * 模型目录 + 每一档在本地的状态（设置页那个下拉读它）。
   *
   * ⚠️ 走 `deps.modelStateOf` 那条注入（与 capability 同一个口径）：测试不落盘也能量
   *   "哪几档在"，探针用的真 daemon 则读真实文件。
   */
  async modelCatalog(): Promise<
    Array<{
      id: string
      label: string
      file: string
      approxMb: number
      note: string
      present: boolean
      bytes: number
    }>
  > {
    return Promise.all(
      ASR_MODELS.map(async (spec) => {
        const state =
          this.deps.modelStateOf !== undefined
            ? await this.deps.modelStateOf(this.asrRoot, spec.id)
            : await modelState(this.asrRoot, spec)
        return {
          id: spec.id,
          label: spec.label,
          file: spec.file,
          approxMb: spec.approxMb,
          note: spec.note,
          present: state !== null && state.present && state.looksValid,
          bytes: state?.bytes ?? 0,
        }
      }),
    )
  }

  /**
   * 确保某一档模型在本地。
   *
   * ★ 同一时刻只允许一次下载（`modelEnsuring`）：两次并发下载会往同一个文件写，
   *   两边都"成功"而结果是一份坏文件。
   */
  async ensureModel(modelId?: string): Promise<EnsureModelResult & { modelId: string }> {
    const settings = await this.settings()
    const id = modelId ?? settings.model
    const spec: AsrModelSpec = findModelSpec(id) ?? (findModelSpec(DEFAULT_ASR_MODEL) as AsrModelSpec)
    if (this.modelEnsuring !== null) {
      const running = await this.modelEnsuring
      return { ...running, modelId: id }
    }
    const promise = ensureModel({
      asrRoot: this.asrRoot,
      spec,
      // 给了 `--asr-model-base` 就只用它（钉死）；否则走默认的回退链（官方 → 镜像）
      ...(this.deps.modelBaseUrl === undefined
        ? { baseUrls: DEFAULT_MODEL_BASE_URLS }
        : { baseUrl: this.deps.modelBaseUrl }),
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
      onProgress: (done, total) => {
        this.modelProgress = { modelId: id, done, total }
      },
    })
    this.modelEnsuring = promise
    try {
      const result = await promise
      return { ...result, modelId: id }
    } finally {
      this.modelEnsuring = null
      this.modelProgress = null
    }
  }

  /**
   * 开一次录音。
   *
   * ⚠️ 已经有一个在录 ⇒ **抛错**（路由翻译成 409）。不覆盖、不复用：覆盖会让第一次
   *   录音的音频留在半路（人以为还在录，其实麦克风已经换主人了）。
   */
  async startSession(input: { conversationId?: string } = {}): Promise<SessionSnapshot> {
    if (this.active !== null) {
      throw new Error('已经有一次录音在进行。先停下或取消它，再开新的。')
    }
    const capability = await this.capability()
    if (!capability.available) {
      throw new Error(capability.reason)
    }
    const [settings, { vocab }] = await Promise.all([this.settings(), this.vocab()])
    /**
     * ★ 286 批：抽"对话里的标识符"塞进 initialPrompt。
     *
     * 为什么值得：实测"只放 3 个标识符"时 `AgentDeck`/`distilly` 都听对了（不放则全错）。
     * 抽不到词（新对话、没有 provider、开关关了）就当没有——**不许因此让录音失败**：
     * 它只是锦上添花的一层。
     */
    let contextTerms: string[] = []
    if (
      settings.useContextTerms &&
      this.deps.contextProvider !== undefined &&
      input.conversationId !== undefined &&
      input.conversationId !== ''
    ) {
      try {
        /**
         * ★ 287 批：两个来源——**你说的话** + **模型在这个对话里的回复**。
         *   前者的全小写词要出现 ≥2 次（人会打错字），后者出现一次就够
         *   （模型已经整理过）。打分与准入门槛都在 `context-terms.ts` 里，这里只管取素材。
         */
        contextTerms = extractContextTerms(await this.deps.contextProvider(input.conversationId))
      } catch {
        // 抽词失败不影响录音：那只是"少一层帮助"
        contextTerms = []
      }
    }
    this.counter += 1
    const session = new VoiceSession({
      id: `voice-${this.counter.toString(36)}-${Date.now().toString(36)}`,
      settings,
      vocab,
      contextTerms,
      captureFactory: this.deps.captureFactory ?? defaultCaptureFactory,
      getTranscriber: () => this.getTranscriber(settings),
      ...(this.deps.limits === undefined ? {} : { limits: this.deps.limits }),
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
      ...(this.deps.setTimeoutImpl === undefined ? {} : { setTimeoutImpl: this.deps.setTimeoutImpl }),
      ...(this.deps.clearTimeoutImpl === undefined
        ? {}
        : { clearTimeoutImpl: this.deps.clearTimeoutImpl }),
      onChange: (snapshot) => {
        if (snapshot.state === 'done' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
          this.retire(snapshot)
        }
        this.deps.onChange?.(snapshot)
      },
    })
    this.active = session
    try {
      await session.start()
    } catch (err) {
      this.active = null
      throw err
    }
    return session.snapshot()
  }

  /** 查一个会话（在录的、或刚结束的几条）。 */
  getSession(id: string): SessionSnapshot | null {
    if (this.active !== null && this.active.id === id) return this.active.snapshot()
    return this.finished.find((s) => s.id === id) ?? null
  }

  /** 手动结束（没开口就按取消处理，见 `VoiceSession.stop`）。 */
  async stopSession(id: string): Promise<SessionSnapshot | null> {
    if (this.active === null || this.active.id !== id) return this.getSession(id)
    // 不 await：`stop()` 里接着跑转写，路由要立刻回 202，页面才来得及显示"转写中"
    void this.active.stop()
    return this.active.snapshot()
  }

  /** 取消：丢弃这段音频。 */
  cancelSession(id: string): SessionSnapshot | null {
    if (this.active === null || this.active.id !== id) return this.getSession(id)
    /**
     * ⚠️ 先把会话**抓在局部变量里**再 cancel。`cancel()` 会同步触发 `onChange`，
     *   而那个回调里会 `retire()` 把 `this.active` 置空——之后再写 `this.active.snapshot()`
     *   就是在一个 null 上取方法（实测：接口 500，而原因是这么一行）。
     */
    const session = this.active
    session.cancel()
    const snapshot = session.snapshot()
    this.retire(snapshot)
    return snapshot
  }

  /** 关掉 daemon 时调用：释放麦克风与模型（不这么做，模型那几十 MiB 要等进程退出才还）。 */
  dispose(): void {
    this.active?.cancel()
    this.active = null
    this.transcriber?.dispose()
    this.transcriber = null
    this.transcriberKey = ''
  }

  private retire(snapshot: SessionSnapshot): void {
    if (this.active !== null && this.active.id === snapshot.id) this.active = null
    // 同一个 id 可能被上报两次（会话自己 emit 一次、路由层再收尾一次）⇒ 按 id 去重
    const existing = this.finished.findIndex((s) => s.id === snapshot.id)
    if (existing >= 0) this.finished.splice(existing, 1)
    this.finished.unshift(snapshot)
    this.finished.length = Math.min(this.finished.length, KEEP_FINISHED_SESSIONS)
  }

  private async getTranscriber(settings: VoiceSettings): Promise<Transcriber> {
    const capability = await this.capability(settings.model)
    if (!capability.available) throw new Error(capability.reason)
    const key = `${capability.model.path}`
    if (this.transcriber !== null && this.transcriberKey === key) return this.transcriber
    this.transcriber?.dispose()
    this.transcriber = null
    const loader = this.deps.transcriberLoader ?? DEFAULT_TRANSCRIBER_LOADER
    const loaded = await loader({
      modelPath: capability.model.path,
      // 留一个核给 daemon 自己（SSE、文件接口、另一个 run 都要用）
      threads: Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1)),
      useGpu: true,
    })
    this.transcriber = loaded
    this.transcriberKey = key
    return loaded
  }

  private async closeTranscriberIfModelChanged(next: VoiceSettings): Promise<void> {
    if (this.transcriber === null) return
    const spec = findModelSpec(next.model)
    if (spec === null) return
    if (this.transcriberKey === `${this.asrRoot}/models/${spec.file}`) return
    this.transcriber.dispose()
    this.transcriber = null
    this.transcriberKey = ''
  }
}
