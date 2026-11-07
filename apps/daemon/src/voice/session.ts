import type { Capture, CaptureFactory, CaptureOptions } from './capture.ts'
import { SENSITIVITY, type VoiceSettings } from './settings.ts'
import type { Transcriber, VoiceLanguage } from './transcriber.ts'
import { hasSpeechContent, joinSegments, normalizeText } from './text.ts'
import { applyVocabRules, buildPrompt, type Correction, type VoiceVocab } from './vocab.ts'

/**
 * 一次口述会话：**按下按钮 → 攒音频 → 静音或手动停 → 转写 → 出文本**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 状态机（约束 2 的全部内容都在这里）
 * ══════════════════════════════════════════════════════════════════
 *
 *                       ┌──────────── 手动「取消」/ 没开口超时 ────────────┐
 *                       ▼                                                  │
 *   idle ──start──▶ recording:waiting-speech ──首个 speech──▶ recording:speaking
 *                       │                                        │
 *                       └── 8s 没开口 ──▶ cancelled              ├─ silence ≥ holdoff ─┐
 *                                                                ├─ 手动「停」 ────────┤
 *                                                                └─ 超 120s（截断） ───┤
 *                                                                                     ▼
 *                                                                              transcribing ──▶ done
 *                                                                                     └──▶ failed
 *
 * ⚠️ **静音计时只在"说过话之后"才启动**。这是 VAD 自动停止最常见的错法：一按按钮
 *   就开始计时，而人还没开口（或刚清嗓子）⇒ 300 ms 后就"自动结束"，表现为"点一下
 *   就没了"。所以 `waiting-speech` 阶段**不理会** silence 事件，只有 speech 之后才算。
 *
 * ⚠️ **没开口超时**（8s）与**最长录音**（120s）是两条独立的闸：
 *   前者防"点了按钮就走开"把麦克风一直占着；后者防"忘了停"。
 *
 * ⚠️ **没声音的兜底**：麦克风坏掉/静音时 decibri 不会报错，只是帧全是 0——那种
 *   "录了 30 秒什么都没发生"比报错更让人困惑。所以 2 秒内一帧非零都没有 ⇒ 直接
 *   失败并说"检查麦克风"。
 */

export type SessionState = 'recording' | 'transcribing' | 'done' | 'failed' | 'cancelled'

export interface SessionSnapshot {
  id: string
  state: SessionState
  /** 已录时长（毫秒；转写开始后定住不变）。 */
  elapsedMs: number
  /** 当前音量 0..1（VAD 分数或归一化 RMS；没有采集时是 0）。 */
  level: number
  /** `waiting-speech` / `speaking`（只有 `recording` 时才有意义）。 */
  phase: 'waiting-speech' | 'speaking' | null
  /** 识别结果（state = done 才有）。 */
  text?: string
  /** 未经词典替换的原始识别文本（对照用）。 */
  raw?: string
  /** 词典改了几处、改的是什么（回显；界面显示"纠正 N 处"）。 */
  corrections?: Correction[]
  /** 触发结束的原因（诊断用）。 */
  endedBy?: 'silence' | 'manual' | 'max-duration' | 'no-speech'
  /** 是否因为超过最长时长被截断。 */
  truncated?: boolean
  model: string
  language: VoiceLanguage
  /** 这次真的用上的"对话词"（回显用：界面上敢说"用了 5 个对话里的词"）。 */
  contextTerms?: string[]
  /** 失败原因（state = failed 才有）。 */
  error?: string
}

export interface SessionLimits {
  /** 没开口多久就放弃。 */
  startWaitMs: number
  /** 最长录音时长。 */
  maxRecordMs: number
  /** 多久之内一帧非零都没有 ⇒ 认为麦克风没声音。 */
  noSignalMs: number
  /** 转写超时。 */
  transcribeTimeoutMs: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  startWaitMs: 8000,
  maxRecordMs: 120_000,
  noSignalMs: 2000,
  transcribeTimeoutMs: 120_000,
}

export interface SessionDeps {
  id: string
  settings: VoiceSettings
  vocab: VoiceVocab
  /** 从当前对话抽出来的词（分批第 286 批；空数组 = 不用上下文）。 */
  contextTerms?: readonly string[]
  captureFactory: CaptureFactory
  /** 转写器（懒加载：模型可能还没下载 ⇒ 这里抛错就变成一次 failed）。 */
  getTranscriber: () => Promise<Transcriber>
  limits?: Partial<SessionLimits>
  /** 注入时钟（测试用假时钟推进超时）。 */
  now?: () => number
  /** 注入定时器（测试用，避免真的等 8 秒）。 */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  /** 状态变化通知（路由层用它把"转写完成"推给页面；轮询也能拿到，但推送更快）。 */
  onChange?: (snapshot: SessionSnapshot) => void
}

/** Int16 → Float32（whisper 的 `pcmf32` 契约：-1..1）。 */
export function toFloat32(chunks: readonly Int16Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 1) {
      out[offset + i] = (c[i] as number) / 32768
    }
    offset += c.length
  }
  return out
}

export class VoiceSession {
  readonly id: string
  readonly startedAt: number
  private readonly deps: SessionDeps
  private readonly limits: SessionLimits
  private readonly now: () => number
  private readonly setT: typeof setTimeout
  private readonly clearT: typeof clearTimeout

  private state: SessionState = 'recording'
  private phase: 'waiting-speech' | 'speaking' = 'waiting-speech'
  private capture: Capture | null = null
  private chunks: Int16Array[] = []
  private level = 0
  private sawSignal = false
  private endedAt: number | null = null
  private text: string | undefined
  private raw: string | undefined
  private corrections: Correction[] | undefined
  private endedBy: SessionSnapshot['endedBy']
  private truncated = false
  private error: string | undefined
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private finishing = false

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.id = deps.id
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
    this.setT = deps.setTimeoutImpl ?? setTimeout
    this.clearT = deps.clearTimeoutImpl ?? clearTimeout
    this.startedAt = this.now()
  }

  get currentState(): SessionState {
    return this.state
  }

  get finished(): boolean {
    return this.state === 'done' || this.state === 'failed' || this.state === 'cancelled'
  }

  snapshot(): SessionSnapshot {
    const sensitivity = SENSITIVITY[this.deps.settings.sensitivity]
    const base: SessionSnapshot = {
      id: this.id,
      state: this.state,
      elapsedMs: Math.max(0, (this.endedAt ?? this.now()) - this.startedAt),
      level: this.state === 'recording' ? this.level : 0,
      phase: this.state === 'recording' ? this.phase : null,
      model: this.deps.settings.model,
      language: this.deps.settings.language,
      ...(this.deps.contextTerms === undefined || this.deps.contextTerms.length === 0
        ? {}
        : { contextTerms: [...this.deps.contextTerms] }),
      ...(this.endedBy === undefined ? {} : { endedBy: this.endedBy }),
      ...(this.truncated ? { truncated: true } : {}),
      ...(this.text === undefined ? {} : { text: this.text }),
      ...(this.raw === undefined ? {} : { raw: this.raw }),
      ...(this.corrections === undefined ? {} : { corrections: this.corrections }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
    // 灵敏度只是"当前用的是什么档"，放在快照里方便界面显示，不参与状态判断
    void sensitivity
    return base
  }

  /**
   * 开始录音。
   *
   * ⚠️ 这里**只负责开麦与装定时器**，不 await 转写：路由要立刻回 `201 + sessionId`，
   *   页面才能马上把按钮切成"录音中"。转写走 `finish()` 里的异步链。
   */
  async start(): Promise<void> {
    const options: CaptureOptions = {
      sampleRate: 16000,
      channels: 1,
      vad: { ...SENSITIVITY[this.deps.settings.sensitivity] },
      highpass: 80,
      denoise: this.deps.settings.denoise,
    }
    this.capture = this.deps.captureFactory(options, {
      data: (chunk) => this.onData(chunk),
      speech: () => this.onSpeech(),
      silence: () => this.onSilence(),
      error: (err) => void this.fail(err.message),
    })
    await this.capture.start()

    // 闸①：没开口就放弃
    this.timers.push(
      this.setT(() => {
        if (this.state === 'recording' && this.phase === 'waiting-speech') {
          this.endedBy = 'no-speech'
          void this.fail('没听到声音：按一下按钮之后对着麦克风说一句再试')
        }
      }, this.limits.startWaitMs),
    )
    // 闸②：最长录音（到点**转写**而不是丢弃——人说的是真话，只是长了点）
    this.timers.push(
      this.setT(() => {
        if (this.state === 'recording') {
          this.truncated = true
          void this.finish('max-duration')
        }
      }, this.limits.maxRecordMs),
    )
    // 闸③：麦克风没声音（帧全 0）
    this.timers.push(
      this.setT(() => {
        if (this.state === 'recording' && !this.sawSignal) {
          void this.fail('麦克风没有收到任何声音：检查输入设备，或系统里的麦克风权限')
        }
      }, this.limits.noSignalMs),
    )
    this.emit()
  }

  /** 手动结束（人再点一下按钮 / Esc 之外的"停"）。没说过话就按取消处理。 */
  async stop(): Promise<void> {
    if (this.state !== 'recording') return
    if (this.phase === 'waiting-speech' && !this.sawSignal) {
      this.endedBy = 'no-speech'
      await this.finish('no-speech')
      return
    }
    await this.finish('manual')
  }

  /** 取消：丢掉这段音频，什么都不转写（人反悔的那条路）。 */
  cancel(): void {
    if (this.finished) return
    this.clearTimers()
    this.capture?.dispose()
    this.capture = null
    this.chunks = []
    this.state = 'cancelled'
    this.endedAt = this.now()
    this.emit()
  }

  private onData(chunk: Int16Array): void {
    if (this.state !== 'recording') return
    this.chunks.push(chunk)
    let peak = 0
    for (let i = 0; i < chunk.length; i += 1) {
      const v = Math.abs(chunk[i] as number)
      if (v > peak) peak = v
    }
    if (peak > 0) this.sawSignal = true
    // 电平给界面做音量条：用这一帧的峰值（0..1），比 RMS 更"跟手"
    this.level = Math.min(1, peak / 32768)
  }

  private onSpeech(): void {
    if (this.state !== 'recording') return
    this.phase = 'speaking'
    this.sawSignal = true
    this.emit()
  }

  private onSilence(): void {
    // ⚠️ 只有"说过话之后的静音"才算说完（见文件头那段：否则一按就结束）
    if (this.state !== 'recording' || this.phase !== 'speaking') return
    void this.finish('silence')
  }

  /** 结束录音并转写。多个触发源（静音/手动/超长）可能同时到，用 `finishing` 去重。 */
  private async finish(endedBy: NonNullable<SessionSnapshot['endedBy']>): Promise<void> {
    if (this.finishing || this.state !== 'recording') return
    this.finishing = true
    this.endedBy = endedBy
    this.endedAt = this.now()
    this.clearTimers()
    this.capture?.dispose()
    this.capture = null
    this.level = 0
    this.state = 'transcribing'
    this.emit()

    const pcm = toFloat32(this.chunks)
    this.chunks = []
    if (pcm.length === 0) {
      await this.fail('这一段里没有音频（麦克风没送数据）')
      return
    }

    let transcriber: Transcriber
    try {
      transcriber = await this.deps.getTranscriber()
    } catch (err) {
      await this.fail(messageOf(err))
      return
    }

    const prompt = buildPrompt(
      this.deps.vocab,
      this.deps.settings.language,
      this.deps.contextTerms ?? [],
    )
    let segments: Awaited<ReturnType<Transcriber['transcribe']>>['segments']
    try {
      const result = await withTimeout(
        transcriber.transcribe({ pcm, language: this.deps.settings.language, prompt }),
        this.limits.transcribeTimeoutMs,
        `转写超时（超过 ${Math.round(this.limits.transcribeTimeoutMs / 1000)} 秒）`,
      )
      segments = result.segments
    } catch (err) {
      await this.fail(`转写失败：${messageOf(err)}`)
      return
    }

    const joined = normalizeText(joinSegments(segments))
    if (!hasSpeechContent(joined)) {
      // 说了话，但模型没听出任何词（噪声/太小声）。这不是错误，是"没听清"。
      await this.fail('没听清：这几秒里没有识别出词，靠近麦克风再说一遍')
      return
    }
    const applied = applyVocabRules(joined, this.deps.vocab.rules)
    this.raw = joined
    /**
     * ⚠️ 替换**之后再收拾一遍空格**（278 批真机验证抓到的）：`Whisp 古来` 换成
     *   `Whisper来` 之后，中英文之间就少了一个空格——替换是"改词"，它不知道排版。
     *   这一次只动空格与标点边角（`normalizeText` 不改词），所以不会与"改词必须回显"
     *   那条纪律冲突：`corrections` 仍然只记替换本身。
     */
    this.text = normalizeText(applied.text)
    this.corrections = applied.corrections
    this.state = 'done'
    this.finishing = false
    this.emit()
  }

  private async fail(reason: string): Promise<void> {
    this.clearTimers()
    this.capture?.dispose()
    this.capture = null
    this.chunks = []
    this.level = 0
    this.error = reason
    this.state = 'failed'
    this.endedAt = this.endedAt ?? this.now()
    this.finishing = false
    this.emit()
  }

  private clearTimers(): void {
    for (const t of this.timers) this.clearT(t)
    this.timers = []
  }

  private emit(): void {
    this.deps.onChange?.(this.snapshot())
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 给异步操作套一层超时。
 *
 * ⚠️ 超时之后**不取消转写本身**（whisper 的调用没法中断）：它还在后台跑，只是我们
 *   不再等它。这是刻意的——宁可让一次转写白跑，也不要让页面永远停在"转写中"。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return (await Promise.race([promise, timeout])) as T
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
