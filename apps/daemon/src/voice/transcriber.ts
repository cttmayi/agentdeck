import { createRequire } from 'node:module'

/**
 * 转写端口：把 **16kHz、单声道、Float32（-1..1）** 的 PCM 变成分段文本。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这里是一层端口，而不是直接调 whisper
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **测试不能加载真模型**（NFR-T-01 的同一条纪律：不烧真实算力、不依赖机器上有
 *    什么）。测试注入假转写器，只验证"给什么 PCM、带什么 prompt、拿到什么文本、
 *    后处理怎么走"。
 * ② **原生模块可能不存在**：`whisper-cpp-node` 只发 darwin-arm64 与 win32-x64 的
 *    预编译包，Linux/Intel Mac 上装不上。它必须**懒加载**——在 daemon 启动时
 *    `import` 一个装不上的模块，会让整个 daemon 起不来（用户看到的会是"服务和界面
 *    全没了"，而不是"语音不可用"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两个踩过的坑，写在这里免得下次再踩
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **`import('whisper-cpp-node')` 是坏的**（0.2.12）：它的 `exports.import` 指向
 *    `dist/index.mjs`，而发布出来的包里**没有这个文件** ⇒ ESM 动态 import 直接
 *    `ERR_MODULE_NOT_FOUND`。必须走 `createRequire(...)` 拿 CJS 入口（`dist/index.js`）。
 * ② **模型只加载一次**：`createWhisperContext` 会把模型读进内存（57–466 MiB），
 *    每句一次的话每句都要等几秒。所以这里是"一个常驻上下文"，daemon 关掉时释放。
 */

export type VoiceLanguage = 'zh' | 'en' | 'auto'

/** whisper 的分段：`[开始, 结束, 文本]`（时间戳是 `HH:MM:SS,mmm`）。 */
export type TranscriptSegment = readonly [string, string, string]

export interface TranscribeRequest {
  /** 16kHz 单声道 Float32，取值 -1..1。 */
  pcm: Float32Array
  language: VoiceLanguage
  /** 第一层矫正：initialPrompt（空串 = 不带）。 */
  prompt: string
}

export interface TranscribeOutput {
  segments: TranscriptSegment[]
  /** 这一轮转写自己花的时间（不含模型加载）。 */
  ms: number
}

export interface Transcriber {
  transcribe(request: TranscribeRequest): Promise<TranscribeOutput>
  /** 释放模型（daemon 退出 / 换模型时调）。可重复调用。 */
  dispose(): void
}

export interface TranscriberLoadOptions {
  modelPath: string
  /** CPU 线程数（默认留一个核给 daemon 自己）。 */
  threads: number
  /** 是否尝试 GPU（macOS Metal / Windows Vulkan）。 */
  useGpu: boolean
}

/** 装不上原生模块时抛这个——调用方据此把能力报成"不可用"，而不是崩。 */
export class TranscriberUnavailableError extends Error {
  readonly code = 'asr_unavailable'
  constructor(detail: string) {
    super(`离线转写不可用：${detail}`)
    this.name = 'TranscriberUnavailableError'
  }
}

/** 加载器签名（可注入：测试给假加载器，永远不碰真模块）。 */
export type TranscriberLoader = (options: TranscriberLoadOptions) => Promise<Transcriber>

interface WhisperContextHandle {
  free(): void
}

interface WhisperModuleLike {
  createWhisperContext(options: Record<string, unknown>): WhisperContextHandle
  transcribeAsync(
    ctx: WhisperContextHandle,
    options: Record<string, unknown>,
  ): Promise<{ segments: TranscriptSegment[] }>
}

/** 缓存原生模块的加载结果（成功或失败都缓存：失败时每次重试都弹一样的错，没有意义）。 */
let cachedModule: WhisperModuleLike | null = null
let cachedError: string | null = null

/**
 * 加载原生模块（CJS 入口，见上面坑①）。
 *
 * ⚠️ `no_prints` 一律打开：whisper.cpp 默认往 **stdout** 打一堆进度，
 *   而 daemon 的 stdout 是给使用者看启动信息的——被几百行推理日志淹掉之后，
 *   "daemon 起了没有"这个问题会变得很难回答。
 */
function loadWhisperModule(): WhisperModuleLike {
  if (cachedModule !== null) return cachedModule
  if (cachedError !== null) throw new TranscriberUnavailableError(cachedError)
  try {
    const require = createRequire(import.meta.url)
    cachedModule = require('whisper-cpp-node') as WhisperModuleLike
    return cachedModule
  } catch (err) {
    cachedError =
      `装不上 whisper-cpp-node（${err instanceof Error ? err.message : String(err)}）。` +
      `这个包只提供 macOS(Apple Silicon 13.3+) 与 Windows(x64) 的预编译版本。`
    throw new TranscriberUnavailableError(cachedError)
  }
}

/** 原生模块到底能不能加载（capability 用；不加载模型，只 require）。 */
export function probeWhisperModule(): { ok: boolean; detail: string } {
  try {
    loadWhisperModule()
    return { ok: true, detail: 'ok' }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 真实现：包一个常驻的 whisper 上下文。
 *
 * ⚠️ `language: 'auto'` 直接透传 `'auto'`（whisper.cpp 的约定值）。中英混说时
 *   它会自己判定——判错的代价是整段腔调都偏，所以界面上默认是 `zh`，`auto` 只是
 *   一个可选档。
 */
export const loadWhisperTranscriber: TranscriberLoader = async (options) => {
  const mod = loadWhisperModule()
  let ctx: WhisperContextHandle
  try {
    ctx = mod.createWhisperContext({
      model: options.modelPath,
      use_gpu: options.useGpu,
      no_prints: true,
    })
  } catch (err) {
    throw new TranscriberUnavailableError(
      `模型加载失败（${options.modelPath}）：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let disposed = false
  return {
    async transcribe(request: TranscribeRequest): Promise<TranscribeOutput> {
      if (disposed) throw new TranscriberUnavailableError('转写上下文已经释放')
      const started = Date.now()
      const result = await mod.transcribeAsync(ctx, {
        pcmf32: request.pcm,
        language: request.language,
        ...(request.prompt === '' ? {} : { prompt: request.prompt }),
        n_threads: options.threads,
      })
      return { segments: result.segments ?? [], ms: Date.now() - started }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        ctx.free()
      } catch {
        // 释放失败不影响退出：这时候进程本来就要走了
      }
    },
  }
}
