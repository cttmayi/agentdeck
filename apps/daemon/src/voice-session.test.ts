/**
 * 录音会话的状态机（分批第 277 批）。
 *
 * 这是"约束 2（VAD 自动结束 + 手动停止）"的全部实现，也是最容易写错的地方，
 * 所以每条测试都对着一个**真实会发生的错法**：
 *
 *   · 一按按钮还没开口就结束（静音计时过早启动）—— 表现为"点一下就没了"
 *   · 点了按钮走开，麦克风一直开着（没有"没开口超时"）
 *   · 忘了停，录了十分钟（没有"最长录音"）
 *   · 麦克风坏了，录完什么都没发生（没有"没声音"兜底）
 *   · 说完话以后 VAD 没停（silence 事件不该只认 speech 之后）
 *   · 手动停与静音停同时到（重复 finish，状态乱跳）
 *
 * ⚠️ 绝不碰真麦克风与真模型：采集与转写都是注入的假实现（NFR-T-01 同一条纪律）。
 *    定时器也注入（不然每条测试都要真等 8 秒）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Capture, CaptureEvents, CaptureOptions } from '../src/voice/capture.ts'
import { VoiceSession, DEFAULT_LIMITS, toFloat32 } from '../src/voice/session.ts'
import { DEFAULT_SETTINGS } from '../src/voice/settings.ts'
import type { Transcriber } from '../src/voice/transcriber.ts'
import { EMPTY_VOCAB } from '../src/voice/vocab.ts'

/** 一帧"有声音"的 PCM（16k 单声道 Int16）。 */
function loudFrame(samples = 1600): Int16Array {
  const f = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) f[i] = Math.round(8000 * Math.sin((i / samples) * Math.PI * 8))
  return f
}

/** 一帧"没声音"（全 0）——用来验证"麦克风没声音"的兜底。 */
function silentFrame(samples = 1600): Int16Array {
  return new Int16Array(samples)
}

interface FakeCapture {
  factory: (options: CaptureOptions, events: CaptureEvents) => Capture
  events: CaptureEvents | null
  options: CaptureOptions | null
  disposed: number
}

function fakeCapture(): FakeCapture {
  const state: FakeCapture = {
    factory: (_options, events) => {
      state.events = events
      state.options = _options
      return {
        async start() {},
        stop() {},
        dispose() {
          state.disposed += 1
        },
      }
    },
    events: null,
    options: null,
    disposed: 0,
  }
  return state
}

function fakeTranscriber(text = '我们来讨论一下语音方案'): Transcriber {
  return {
    async transcribe(request) {
      // 断言"调用方把 16k 单声道 Float32 送进来了"（-1..1）
      assert.ok(request.pcm instanceof Float32Array)
      return {
        segments: [{ start: '00:00:00,000', end: '00:00:02,000', text: ` ${text}` }],
        ms: 12,
      }
    },
    dispose() {},
  }
}

interface Harness {
  session: VoiceSession
  capture: FakeCapture
  changes: string[]
  /** 手动触发一个定时器（按注册顺序）。 */
  fireTimer: (index: number) => Promise<void>
  timers: Array<{ fn: () => void; ms: number }>
}

function makeSession(options: { transcriber?: Transcriber; text?: string; vocab?: typeof EMPTY_VOCAB } = {}): Harness {
  const capture = fakeCapture()
  const changes: string[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const session = new VoiceSession({
    id: 's1',
    settings: { ...DEFAULT_SETTINGS },
    vocab: options.vocab ?? EMPTY_VOCAB,
    captureFactory: capture.factory,
    getTranscriber: async () => options.transcriber ?? fakeTranscriber(options.text),
    onChange: (s) => changes.push(s.state),
    setTimeoutImpl: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
  })
  return {
    session,
    capture,
    changes,
    timers,
    fireTimer: async (index: number) => {
      timers[index]?.fn()
      // 定时器回调里是 `void this.finish(...)`，让微任务跑完再断言
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

describe('会话的起手式', () => {
  test('★ 一开始是 recording/waiting-speech，并装了三条闸（没开口 / 最长 / 没声音）', async () => {
    const h = makeSession()
    await h.session.start()
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'recording')
    assert.equal(snap.phase, 'waiting-speech')
    assert.equal(h.timers.length, 3)
    assert.deepEqual(
      h.timers.map((t) => t.ms),
      [DEFAULT_LIMITS.startWaitMs, DEFAULT_LIMITS.maxRecordMs, DEFAULT_LIMITS.noSignalMs],
    )
  })

  test('★ 采集参数按设置来：16k 单声道、Silero VAD（档位来自设置）、高通 80', async () => {
    const h = makeSession()
    await h.session.start()
    assert.equal(h.capture.options?.sampleRate, 16000)
    assert.equal(h.capture.options?.channels, 1)
    assert.deepEqual(h.capture.options?.vad, { threshold: 0.5, holdoffMs: 800 })
    assert.equal(h.capture.options?.highpass, 80)
    assert.equal(h.capture.options?.denoise, false)
  })
})

describe('自动结束：VAD', () => {
  test('★★ 还没开口时的 silence 事件**不许**结束会话（这是"点一下就没"的根因）', async () => {
    const h = makeSession()
    await h.session.start()
    h.capture.events?.silence()
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(h.session.snapshot().state, 'recording')
  })

  test('★★ 说过话之后的静音才结束，并走完转写拿到文本', async () => {
    const h = makeSession()
    await h.session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    assert.equal(h.session.snapshot().phase, 'speaking')
    h.capture.events?.silence()
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'done')
    assert.equal(snap.endedBy, 'silence')
    assert.equal(snap.text, '我们来讨论一下语音方案')
    // 转写完要把麦克风放开（否则它一直开着，下一次录音打不开）
    assert.equal(h.capture.disposed, 1)
  })

  test('★★ 手动 stop 也走转写；重复 stop / stop 与 silence 同时到只结算一次', async () => {
    const h = makeSession()
    await h.session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    await Promise.all([h.session.stop(), h.session.stop()])
    h.capture.events?.silence()
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'done')
    // "done" 只出现一次（转写只跑了一次）
    assert.equal(h.changes.filter((s) => s === 'done').length, 1)
  })
})

describe('三条闸', () => {
  test('★★ 8 秒没开口 ⇒ failed 且说清"没听到声音"（防"点了就走开"一直占着麦克风）', async () => {
    const h = makeSession()
    await h.session.start()
    await h.fireTimer(0)
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'failed')
    assert.match(snap.error ?? '', /没听到声音/)
    assert.equal(h.capture.disposed, 1)
  })

  test('★★ 超过最长录音 ⇒ **转写出来**并标 truncated（人说的是真话，只是长了点）', async () => {
    const h = makeSession()
    await h.session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    await h.fireTimer(1)
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'done')
    assert.equal(snap.truncated, true)
    assert.equal(snap.endedBy, 'max-duration')
  })

  test('★★ 2 秒内一帧非零都没有 ⇒ 失败并叫人检查麦克风（比"录完什么都没发生"好）', async () => {
    const h = makeSession()
    await h.session.start()
    h.capture.events?.data(silentFrame())
    await h.fireTimer(2)
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'failed')
    assert.match(snap.error ?? '', /麦克风没有收到任何声音/)
  })

  test('★ 有声音的时候"没声音"那条闸不误伤', async () => {
    const h = makeSession()
    await h.session.start()
    h.capture.events?.data(loudFrame())
    await h.fireTimer(2)
    assert.equal(h.session.snapshot().state, 'recording')
  })
})

describe('取消与失败', () => {
  test('★★ 取消：丢掉音频、不转写、麦克风放开（人反悔的那条路）', async () => {
    const h = makeSession()
    await h.session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    h.session.cancel()
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'cancelled')
    assert.equal(snap.text, undefined)
    assert.equal(h.capture.disposed, 1)
  })

  test('★ 没开口就手动停 ⇒ 当成"没听到声音"，不产生空文本', async () => {
    const h = makeSession()
    await h.session.start()
    await h.session.stop()
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    // 注意：这条走的是 finish('no-speech') ⇒ 没有音频 ⇒ failed
    assert.equal(snap.state, 'failed')
    assert.match(snap.error ?? '', /没有音频|没听到声音/)
  })

  test('★★ 转写器加载不了（模型没下）⇒ failed 且原样带出原因，会话不会卡在转写中', async () => {
    const h = makeSession()
    // 让 getTranscriber 抛错（模拟"模型还没下载"）
    const session = new VoiceSession({
      id: 's2',
      settings: { ...DEFAULT_SETTINGS },
      vocab: EMPTY_VOCAB,
      captureFactory: h.capture.factory,
      getTranscriber: async () => {
        throw new Error('还没有语音模型')
      },
      setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => {}) as unknown as typeof clearTimeout,
    })
    await session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    h.capture.events?.silence()
    await new Promise((r) => setTimeout(r, 20))
    const snap = session.snapshot()
    assert.equal(snap.state, 'failed')
    assert.match(snap.error ?? '', /还没有语音模型/)
  })
})

describe('词典替换在会话里真的生效', () => {
  test('★★ 会话产出的是**替换后**的文本，同时带回 raw 与 corrections（可回显）', async () => {
    const h = makeSession({
      text: '我们用微思普来识别',
      vocab: { version: 1, promptTerms: ['Whisper'], rules: [{ from: '微思普', to: 'Whisper' }] },
    })
    await h.session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    h.capture.events?.silence()
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'done')
    assert.equal(snap.text, '我们用 Whisper 来识别')
    assert.equal(snap.raw, '我们用微思普来识别')
    assert.deepEqual(snap.corrections, [{ from: '微思普', to: 'Whisper', count: 1 }])
  })

  test('★★ 替换之后再收拾一遍空格（换词会造成中英文交界缺空格）', async () => {
    // 真机验证抓到的：`Whisp 古来` → `Whisper来`，中英文之间少了空格
    const h = makeSession({
      text: '我们用Whisp 古来识别',
      vocab: { version: 1, promptTerms: [], rules: [{ from: 'Whisp 古', to: 'Whisper' }] },
    })
    await h.session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    h.capture.events?.silence()
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'done')
    assert.equal(snap.text, '我们用 Whisper 来识别')
    // 原始那份只做过**排版**（不改词）：中英文交界处那个空格是 `normalizeText` 加的
    assert.equal(snap.raw, '我们用 Whisp 古来识别')
  })

  test('★★ 一句都没识别出词 ⇒ 失败并说"没听清"（不是给出一个空字符串）', async () => {
    const h = makeSession({ text: '  ' })
    await h.session.start()
    h.capture.events?.data(loudFrame())
    h.capture.events?.speech()
    h.capture.events?.silence()
    await new Promise((r) => setTimeout(r, 20))
    const snap = h.session.snapshot()
    assert.equal(snap.state, 'failed')
    assert.match(snap.error ?? '', /没听清/)
  })
})

describe('音频换算', () => {
  test('★ Int16 → Float32：满量程 32767 ≈ 1.0，且多帧按顺序拼起来', () => {
    const out = toFloat32([new Int16Array([0, 16384, 32767, -32768])])
    assert.equal(out.length, 4)
    assert.equal(out[0], 0)
    assert.ok(Math.abs((out[1] as number) - 0.5) < 0.001)
    assert.ok((out[2] as number) > 0.99)
    assert.equal(out[3], -1)
  })
})
