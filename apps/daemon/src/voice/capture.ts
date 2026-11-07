import { createRequire } from 'node:module'

/**
 * 采集端口：把麦克风变成"一串 16kHz 单声道 Int16 帧 + 语音/静音事件"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是端口（而不是直接 `new Microphone()`
 * ══════════════════════════════════════════════════════════════════
 *
 * ① 测试绝不能开麦克风（NFR-T-01 的同一类纪律：跑测试不该弹系统权限窗、也不该
 *    依赖这台机器有没有麦）。测试注入假采集，按脚本吐帧与 speech/silence 事件。
 * ② 将来要换"页面采集 + 音频传给 daemon"时（比如 daemon 跑在容器里、机器上没有麦），
 *    只换这一层的实现，会话与转写一行不用动。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须有 Silero VAD（而不是看音量）
 * ══════════════════════════════════════════════════════════════════
 *
 * 约束是"VAD 静音自动结束"。能量阈值（RMS）在两类场景必然出错：安静房间永远判
 * "没说话"、有风扇/键盘的房间永远判"一直在说"。decibri 的 Node 版**内置 Silero**
 * （模型 2.2 MiB 随包发、完全离线），这才是能用的自动结束。
 *
 * ⚠️ 浏览器版 decibri 只有 energy VAD——这是当初把采集放在 daemon 侧（方案 A）的
 *   主要理由之一，别为了"页面采集"把它换掉而不补 Silero。
 */

export interface CaptureOptions {
  /** 采样率恒为 16000：whisper 只吃这个（再采样是另一份风险）。 */
  sampleRate: 16000
  channels: 1
  /** Silero 阈值与"静音多久算说完"（来自设置的灵敏度档）。 */
  vad: { threshold: number; holdoffMs: number }
  /**
   * 高通滤波（Hz）。默认 80：笔记本麦克风的低频隆隆声会让 whisper "听成"词，
   * 去掉它比换更大模型便宜得多。
   */
  highpass: 80 | 100
  /** decibri 的 fastenhancer 降噪。默认关：它会削掉轻声。 */
  denoise: boolean
  /** 指定输入设备（省略 = 系统默认）。 */
  device?: string
}

export interface CaptureEvents {
  /** 一帧 PCM（16k 单声道 Int16）。 */
  data: (chunk: Int16Array) => void
  /** VAD 判定"开始说话"。 */
  speech: () => void
  /** VAD 判定"静音已超过 holdoff"。 */
  silence: () => void
  error: (err: Error) => void
}

export interface Capture {
  start(): Promise<void>
  stop(): void
  /** 释放底层资源（可重复调用）。 */
  dispose(): void
}

/** 造一个采集器（注入用）。 */
export type CaptureFactory = (options: CaptureOptions, events: CaptureEvents) => Capture

export class CaptureUnavailableError extends Error {
  readonly code = 'capture_unavailable'
  constructor(detail: string) {
    super(`麦克风采集不可用：${detail}`)
    this.name = 'CaptureUnavailableError'
  }
}

interface MicrophoneLike {
  on(event: 'data', listener: (chunk: Buffer | Int16Array) => void): void
  on(event: 'speech', listener: () => void): void
  on(event: 'silence', listener: () => void): void
  on(event: 'error', listener: (err: Error) => void): void
  start?: () => Promise<void>
  stop(): void
  readonly vadScore?: number
}

interface DecibriModuleLike {
  Microphone: {
    open(options: Record<string, unknown>): Promise<MicrophoneLike>
  }
}

let cachedModule: DecibriModuleLike | null = null
let cachedError: string | null = null

function loadDecibri(): DecibriModuleLike {
  if (cachedModule !== null) return cachedModule
  if (cachedError !== null) throw new CaptureUnavailableError(cachedError)
  try {
    const require = createRequire(import.meta.url)
    cachedModule = require('decibri') as DecibriModuleLike
    return cachedModule
  } catch (err) {
    cachedError =
      `装不上 decibri（${err instanceof Error ? err.message : String(err)}）。` +
      `它只提供 macOS / Windows / Linux 的预编译版本。`
    throw new CaptureUnavailableError(cachedError)
  }
}

/**
 * 真实现：decibri 的 Microphone。
 *
 * ⚠️ **必须用 `Microphone.open()`（异步），不能用 `new Microphone()`**：同步构造函数
 *   会在 event loop 上做 Silero 模型的加载（几十到几百毫秒），而 daemon 里同一时间
 *   还跑着 SSE 长连接——一次录音就把页面上所有实时流卡住，症状看起来像"界面卡死"。
 * ⚠️ `Buffer` 是 Node 的字节视图，可能落在一个大 Buffer 池的中间（`byteOffset` 不一定
 *   是偶数）⇒ 直接 `new Int16Array(buf.buffer, …)` 会抛 RangeError。所以这里**拷贝**一份，
 *   顺带也让"帧被后续复用"这件事不再成立（我们要把帧攒到录音结束）。
 */
export const createDecibriCapture: CaptureFactory = (options, events) => {
  let mic: MicrophoneLike | null = null
  let disposed = false
  return {
    async start(): Promise<void> {
      if (disposed) throw new CaptureUnavailableError('采集器已经释放')
      const mod = loadDecibri()
      try {
        mic = await mod.Microphone.open({
          sampleRate: options.sampleRate,
          channels: options.channels,
          dtype: 'int16',
          highpass: options.highpass,
          ...(options.denoise ? { denoise: 'fastenhancer-t' } : {}),
          vad: { model: 'silero', threshold: options.vad.threshold, holdoffMs: options.vad.holdoffMs },
          ...(options.device === undefined ? {} : { device: options.device }),
        })
      } catch (err) {
        throw new CaptureUnavailableError(explainCaptureFailure(err))
      }
      mic.on('data', (chunk) => {
        if (chunk instanceof Int16Array) {
          events.data(chunk.slice())
          return
        }
        // Buffer：拷一份再当 Int16 看（见上面那段 byteOffset 的坑）
        const copy = new Uint8Array(chunk.length)
        copy.set(chunk)
        events.data(new Int16Array(copy.buffer, 0, copy.length >> 1))
      })
      mic.on('speech', () => events.speech())
      mic.on('silence', () => events.silence())
      mic.on('error', (err) => events.error(err instanceof Error ? err : new Error(String(err))))
    },
    stop(): void {
      try {
        mic?.stop()
      } catch {
        // 停已经在停的麦克风不算错误
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      this.stop()
    },
  }
}

/**
 * 把 decibri 的原始报错翻译成"能照着做的一句话"。
 *
 * ★ 为什么值得单独写：麦克风失败在 macOS / Windows 上各有各的拦法（系统隐私设置、
 *   被别的应用独占、根本没有输入设备），而 decibri 抛出来的是平台错误码。使用者看到
 *   "NotAllowedError" 不会知道该去系统设置里勾哪一项。
 */
export function explainCaptureFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string })?.code ?? ''
  const text = `${code} ${raw}`.toLowerCase()
  if (text.includes('notallowed') || text.includes('permission') || text.includes('denied')) {
    return (
      `没有麦克风权限（${raw}）。` +
      `macOS：系统设置 → 隐私与安全性 → 麦克风，勾上启动 daemon 的那个程序（终端 / 应用）；` +
      `Windows：设置 → 隐私 → 麦克风，允许桌面应用访问。改完要重启 daemon。`
    )
  }
  if (text.includes('device') || text.includes('nodevice') || text.includes('not found')) {
    return `找不到可用的麦克风（${raw}）。检查设备是否插好、是否被别的应用独占。`
  }
  if (text.includes('busy') || text.includes('in use')) {
    return `麦克风被别的程序占着（${raw}）。关掉那个程序（会议软件最常见）再试。`
  }
  return `麦克风打不开：${raw}`
}
