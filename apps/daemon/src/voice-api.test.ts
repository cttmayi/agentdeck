/**
 * 语音的三个接口（分批第 277 批）：能力、词表/设置、录音会话。
 *
 * 这一层测的是**路由与装配**，不是 ASR 本身（那是 `voice-session.test.ts` 与
 * `voice-vocab.test.ts` 的事）。所以：
 *
 *   · 采集是注入的假实现（**绝不开麦克风**：跑测试不该弹系统权限窗）；
 *   · 转写是注入的假实现（**绝不加载模型**：那要几十 MiB 与几百毫秒）；
 *   · 模型下载的 fetch 也是注入的（**绝不联网**）。
 *
 * 三条纪律在这里被钉住：
 *   ① 同一时刻只允许一次录音（第二次 409，而不是"悄悄换主人"）；
 *   ② 结束之后页面还能按 id 拿到结果（否则"刚好在这次轮询之前结束"就丢了）；
 *   ③ **没有任何写库的路由**——识别结果只回给调用方（约束 4/5）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import type { CaptureEvents, CaptureOptions } from './voice/capture.ts'
import type { Transcriber } from './voice/transcriber.ts'

/** 假采集：把事件通道交给测试，由测试"扮演麦克风"。 */
function fakeCaptureBox(): {
  factory: (options: CaptureOptions, events: CaptureEvents) => {
    start(): Promise<void>
    stop(): void
    dispose(): void
  }
  events: () => CaptureEvents | null
  options: () => CaptureOptions | null
} {
  let current: CaptureEvents | null = null
  let options: CaptureOptions | null = null
  return {
    factory: (opts, events) => {
      options = opts
      current = events
      return { async start() {}, stop() {}, dispose() {} }
    },
    events: () => current,
    options: () => options,
  }
}

const transcript: Transcriber = {
  async transcribe() {
    return {
      segments: [{ start: '00:00:00,000', end: '00:00:01,000', text: ' 用微思普跑一遍语音方案' }],
      ms: 5,
    }
  },
  dispose() {},
}

function loudFrame(samples = 1600): Int16Array {
  const f = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) f[i] = 6000
  return f
}

async function withDaemon<T>(fn: (ctx: { url: string; box: ReturnType<typeof fakeCaptureBox> }) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('voice-api')
  const box = fakeCaptureBox()
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    // ★ 语音落点必须在临时目录里（否则会往真实家目录写词表与模型）
    asrRoot: `${dir}/asr`,
    voiceCaptureFactory: box.factory,
    voiceTranscriberLoader: async () => transcript,
    // 闸调小到 0 之外仍留一点余量，避免"跑完这条测试要等 8 秒"
    voiceLimits: { startWaitMs: 60_000, maxRecordMs: 60_000, noSignalMs: 60_000 },
    /**
     * ⚠️ 这两条注入是**必须**的，不是图省事：真探测的结果取决于跑测试这台机器
     * （有没有预编译包、有没有下过模型）。不注入的话，同一份测试在 macOS 上会走完
     * 整个会话流程、在 Linux 上会"提前 return"——绿得毫无意义的那种绿。
     */
    voiceProbeNative: () => ({
      capture: { ok: true, detail: 'ok' },
      transcribe: { ok: true, detail: 'ok' },
    }),
    voiceModelStateOf: async (asrRoot: string, modelId: string) => ({
      id: modelId,
      path: `${asrRoot}/models/ggml-base-q5_1.bin`,
      present: true,
      looksValid: true,
      bytes: 60_000_000,
      hashOk: true,
    }),
    backend: {
      key: 'claude',
      protocol: 'stream-json',
      rejectDetectable: true,
      async probe() {
        return { available: false, command: 'claude', cliVersion: null }
      },
      async execute() {
        throw new Error('这个测试不该执行任何 run')
      },
    } as never,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn({ url: d.url, box })
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init)
  const text = await res.text()
  const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  return { status: res.status, body }
}

describe('能力接口', () => {
  test('★★ capability 说清三件事：能不能用、为什么不能、模型在不在', async () => {
    await withDaemon(async ({ url }) => {
      const { status, body } = await json(`${url}/api/voice/capability`)
      assert.equal(status, 200)
      // 模型没下 ⇒ 不可用，但**原生模块与平台**是好的（这台机器是 macOS arm64；
      // 在别的平台上这条的 reason 应换成"平台没有预编译包"——两种都可接受）
      assert.equal(typeof body['available'], 'boolean')
      assert.equal(typeof body['reason'], 'string')
      assert.equal(body['mic'], 'unknown')
      assert.equal(typeof (body['model'] as Record<string, unknown>)['id'], 'string')
      const paths = body['paths'] as Record<string, unknown>
      assert.ok(String(paths['asrRoot']).endsWith('/asr'))
      assert.ok(String(paths['models']).endsWith('/asr/models'))
    })
  })

  test('★★ 能力标志里有 voice-dictation（旧 daemon 上界面靠它决定画不画麦克风按钮）', async () => {
    await withDaemon(async ({ url }) => {
      const { body } = await json(`${url}/api/identity`)
      const capabilities = body['capabilities'] as string[]
      assert.ok(capabilities.includes('voice-dictation'), JSON.stringify(capabilities))
    })
  })
})

describe('词表与设置', () => {
  test('★★ 词表可读可写；坏条目跳过并如实报 problems（手改坏不报错）', async () => {
    await withDaemon(async ({ url }) => {
      const empty = await json(`${url}/api/voice/vocab`)
      assert.equal(empty.status, 200)
      assert.deepEqual(empty.body['promptTerms'], [])
      assert.deepEqual(empty.body['rules'], [])

      const saved = await json(`${url}/api/voice/vocab`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          promptTerms: ['Whisper', 'AgentDeck'],
          rules: [
            { from: '微思普', to: 'Whisper' },
            { from: '', to: 'x' },
          ],
        }),
      })
      assert.equal(saved.status, 200)
      assert.deepEqual(saved.body['rules'], [{ from: '微思普', to: 'Whisper' }])
      assert.ok((saved.body['problems'] as string[]).length >= 1)

      const again = await json(`${url}/api/voice/vocab`)
      assert.deepEqual(again.body['promptTerms'], ['Whisper', 'AgentDeck'])
    })
  })

  test('★★ 设置：默认 base-q5_1 / zh / 中档；PATCH 之后读回来是新的', async () => {
    await withDaemon(async ({ url }) => {
      const initial = await json(`${url}/api/voice/settings`)
      assert.equal(initial.body['model'], 'base-q5_1')
      assert.equal(initial.body['language'], 'zh')
      assert.equal(initial.body['sensitivity'], 'normal')
      assert.equal(initial.body['outputMode'], 'input')

      const patched = await json(`${url}/api/voice/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'auto', sensitivity: 'quick', outputMode: 'via-skill' }),
      })
      assert.equal(patched.status, 200)
      assert.equal(patched.body['language'], 'auto')
      assert.equal(patched.body['sensitivity'], 'quick')
      assert.equal(patched.body['outputMode'], 'via-skill')
    })
  })
})

describe('模型目录', () => {
  test('★★ 三档都列出来，且每档带"在不在"（缺一档 ⇒ 设置页那个下拉就选不到它）', async () => {
    await withDaemon(async ({ url }) => {
      const { status, body } = await json(`${url}/api/voice/models`)
      assert.equal(status, 200)
      const models = body['models'] as Array<Record<string, unknown>>
      assert.equal(models.length, 3)
      assert.deepEqual(
        models.map((m) => m['id']),
        ['base-q5_1', 'small-q5_1', 'small'],
      )
      // 注入的 modelStateOf 说"在"，所以三档都该报 present
      assert.ok(models.every((m) => m['present'] === true))
      assert.equal(body['default'], 'base-q5_1')
      // 每档都带界面上要显示的体积（否则"首次需下载约 xx MiB"编不出来）
      assert.ok(models.every((m) => typeof m['approxMb'] === 'number'))
    })
  })
})

describe('下载进度', () => {
  test('★★ 没在下载时是 null（界面据此不画进度条），而且这条不联网也不落盘', async () => {
    await withDaemon(async ({ url }) => {
      const { status, body } = await json(`${url}/api/voice/models/progress`)
      assert.equal(status, 200)
      assert.equal(body['progress'], null)
    })
  })
})

describe('录音会话', () => {
  test('★★ 开录音 ⇒ 201 + 会话 id；同一时刻只许一个（第二次 409）', async () => {
    await withDaemon(async ({ url }) => {
      const first = await json(`${url}/api/voice/sessions`, { method: 'POST' })
      assert.equal(first.status, 201, JSON.stringify(first.body))
      assert.equal(first.body['state'], 'recording')
      const id = String(first.body['id'])

      // ★ 第二次必须**明确拒绝**：悄悄换主人会让第一次的音频留在半路，
      //   而人以为自己还在录（麦克风已经归第二个会话了）
      const second = await json(`${url}/api/voice/sessions`, { method: 'POST' })
      assert.equal(second.status, 409)
      assert.match(String(second.body['error']), /已经有一次录音/)

      await json(`${url}/api/voice/sessions/${id}/cancel`, { method: 'POST' })
    })
  })

  test('★★ 模型没下 / 平台不支持时开录音 ⇒ 400，且原因能照着做（不是"点了没反应"）', async () => {
    const dir = await makeTempDir('voice-api-nomodel')
    const box = fakeCaptureBox()
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      asrRoot: `${dir}/asr`,
      voiceCaptureFactory: box.factory,
      voiceTranscriberLoader: async () => transcript,
      voiceProbeNative: () => ({
        capture: { ok: true, detail: 'ok' },
        transcribe: { ok: true, detail: 'ok' },
      }),
      // 模型不在 ⇒ 不可用
      voiceModelStateOf: async (asrRoot: string, modelId: string) => ({
        id: modelId,
        path: `${asrRoot}/models/ggml-base-q5_1.bin`,
        present: false,
        looksValid: false,
        bytes: 0,
        hashOk: null,
      }),
      backend: {
        key: 'claude',
        protocol: 'stream-json',
        rejectDetectable: true,
        async probe() {
          return { available: false, command: 'claude', cliVersion: null }
        },
        async execute() {
          throw new Error('这个测试不该执行任何 run')
        },
      } as never,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const { status, body } = await json(`${d.url}/api/voice/sessions`, { method: 'POST' })
      assert.equal(status, 400)
      assert.match(String(body['error']), /首次使用需要下载/)
    } finally {
      await d.close()
      await cleanup(dir)
    }
  })

  test('★★ 会话走完一遍：speech → silence ⇒ done + 文本 + 词典纠正回显', async () => {
    await withDaemon(async ({ url, box }) => {
      // 先写一条词表，验证"会话真的用上了这一层"
      await json(`${url}/api/voice/vocab`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ promptTerms: ['Whisper'], rules: [{ from: '微思普', to: 'Whisper' }] }),
      })
      const started = await json(`${url}/api/voice/sessions`, { method: 'POST' })
      assert.equal(started.status, 201, JSON.stringify(started.body))
      const id = String(started.body['id'])

      const events = box.events()
      assert.ok(events !== null, '采集应该被创建出来')
      events?.data(loudFrame())
      events?.speech()
      events?.silence()

      // 轮询到 done（转写是异步的）
      let snapshot: Record<string, unknown> = {}
      for (let i = 0; i < 40; i += 1) {
        const res = await json(`${url}/api/voice/sessions/${id}`)
        assert.equal(res.status, 200)
        snapshot = res.body
        if (snapshot['state'] === 'done' || snapshot['state'] === 'failed') break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.equal(snapshot['state'], 'done', JSON.stringify(snapshot))
      // 替换之后再收拾一遍空格 ⇒ 中英文交界有一个空格（真机验证抓到的排版）
      assert.equal(snapshot['text'], '用 Whisper 跑一遍语音方案')
      assert.equal(snapshot['raw'], '用微思普跑一遍语音方案')
      assert.deepEqual(snapshot['corrections'], [{ from: '微思普', to: 'Whisper', count: 1 }])
    })
  })

  test('★★ 结束之后的会话还能按 id 查到（否则"刚好在这次轮询之前结束"就丢了）', async () => {
    await withDaemon(async ({ url, box }) => {
      const started = await json(`${url}/api/voice/sessions`, { method: 'POST' })
      assert.equal(started.status, 201, JSON.stringify(started.body))
      const id = String(started.body['id'])
      const events = box.events()
      events?.data(loudFrame())
      events?.speech()
      await json(`${url}/api/voice/sessions/${id}/stop`, { method: 'POST' })
      await new Promise((r) => setTimeout(r, 60))
      const { status, body } = await json(`${url}/api/voice/sessions/${id}`)
      assert.equal(status, 200)
      assert.equal(body['state'], 'done')
    })
  })

  test('★ 不存在的会话 ⇒ 404 并说清"可能过期了"', async () => {
    await withDaemon(async ({ url }) => {
      const { status, body } = await json(`${url}/api/voice/sessions/nope`)
      assert.equal(status, 404)
      assert.match(String(body['error']), /过期|没有这个录音会话/)
    })
  })

  test('★★ 取消：立刻 cancelled，且不产出文本（人反悔就不该留下文字）', async () => {
    await withDaemon(async ({ url, box }) => {
      const started = await json(`${url}/api/voice/sessions`, { method: 'POST' })
      assert.equal(started.status, 201, JSON.stringify(started.body))
      const id = String(started.body['id'])
      box.events()?.data(loudFrame())
      box.events()?.speech()
      const cancelled = await json(`${url}/api/voice/sessions/${id}/cancel`, { method: 'POST' })
      assert.equal(cancelled.status, 200)
      assert.equal(cancelled.body['state'], 'cancelled')
      const after = await json(`${url}/api/voice/sessions/${id}`)
      assert.equal(after.body['state'], 'cancelled')
      assert.equal(after.body['text'], undefined)
    })
  })
})
