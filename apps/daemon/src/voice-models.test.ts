/**
 * 语音模型的管理（分批第 277 批）。
 *
 * 这一层的三类坏法，测试逐个钉住：
 *   ① **反代/镜像返回 200 + 一页 HTML** ⇒ 必须靠 ggml 魔数认出来，否则 whisper 加载时
 *      崩在一句完全指不到模型的报错上；
 *   ② **下了一半** ⇒ 必须对 Content-Length 校验，并且**删掉半成品**（留着一个"看起来
 *      在"的坏文件，下次加载还是崩）；
 *   ③ **宿主没给 Content-Length** ⇒ 直接拒绝：完整性无法确认时下完也不敢用。
 *
 * ⚠️ 测试里**绝不真的联网**：`fetchImpl` 注入假响应（NFR-T-01 的同一条纪律）。
 *    临时目录用工作区内 `.cache/test-tmp`，不用系统 tmp。
 */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  ASR_MODELS,
  DEFAULT_ASR_MODEL,
  DEFAULT_MODEL_BASE_URL,
  ensureModel,
  findModelSpec,
  looksLikeGgml,
  modelPathOf,
  modelState,
  sha256OfFile,
} from '../src/voice/models.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let root: string

before(async () => {
  root = await makeTempDir('voice-models')
})
after(async () => {
  await cleanup(root)
})

const SPEC = ASR_MODELS[0]
if (SPEC === undefined) throw new Error('ASR_MODELS 不该是空的')

/** 造一份"长得像模型"的字节：ggml 魔数 + 补到 1 MiB 以上（跳过"体积太小"的判定）。 */
function fakeModelBytes(pad = 1 << 20): Uint8Array {
  const bytes = new Uint8Array(Buffer.byteLength('ggml') + pad)
  bytes.set(Buffer.from('ggml', 'ascii'), 0)
  // 填充非零字节，避免"全是 0"看起来像稀疏文件
  bytes.fill(7, 4)
  return bytes
}

/** 一个假的 Response：body 按 chunk 吐，headers 可控。 */
function fakeResponse(
  body: Uint8Array | null,
  init: { status?: number; contentLength?: string | null } = {},
): Response {
  const status = init.status ?? 200
  const headers = new Headers()
  if (init.contentLength !== null) {
    headers.set('content-length', init.contentLength ?? String(body?.length ?? 0))
  }
  const stream =
    body === null
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            // 分三块吐，顺带验证"边写边算哈希"没有假设一次到手
            const size = Math.ceil(body.length / 3)
            for (let i = 0; i < body.length; i += size) {
              controller.enqueue(body.subarray(i, Math.min(i + size, body.length)))
            }
            controller.close()
          },
        })
  return new Response(stream, { status, headers })
}

describe('模型目录', () => {
  test('★ 默认档是 base-q5_1（体积小的那档），三档都是多语言模型', () => {
    assert.equal(DEFAULT_ASR_MODEL, 'base-q5_1')
    assert.equal(findModelSpec(DEFAULT_ASR_MODEL)?.file, 'ggml-base-q5_1.bin')
    // ⚠️ `.en` 版对中文等于不会说话——文件名里不许出现 `.en.bin`
    for (const spec of ASR_MODELS) {
      assert.ok(!spec.file.includes('.en.bin'), `${spec.file} 是多语言的还是 .en？`)
    }
    assert.equal(findModelSpec('no-such'), null)
  })
})

describe('下载与校验', () => {
  test('★★ 假的 200（HTML 错误页）当不了模型：魔数不对就删掉并报错', async () => {
    const asr = join(root, 'html-not-model')
    await assert.rejects(
      () =>
        ensureModel({
          asrRoot: asr,
          spec: SPEC,
          fetchImpl: async () => fakeResponse(new TextEncoder().encode('<html>mirror says hi</html>'.repeat(40000))),
        }),
      /不是有效的 ggml 模型|太短/,
    )
    // 半成品与目标文件都不许留下
    assert.equal((await modelState(asr, SPEC)).present, false)
    await assert.rejects(() => stat(modelPathOf(asr, SPEC)))
  })

  test('★★ 拿不到 Content-Length ⇒ 拒绝下载（完整性无法确认时下完也不敢用）', async () => {
    const asr = join(root, 'no-length')
    await assert.rejects(
      () =>
        ensureModel({
          asrRoot: asr,
          spec: SPEC,
          fetchImpl: async () => fakeResponse(fakeModelBytes(), { contentLength: null }),
        }),
      /Content-Length/,
    )
    assert.equal((await modelState(asr, SPEC)).present, false)
  })

  test('★★ 传输中断（收到的字节少于声明）⇒ 删掉半截文件，可以重试', async () => {
    const asr = join(root, 'truncated')
    const body = fakeModelBytes()
    await assert.rejects(
      () =>
        ensureModel({
          asrRoot: asr,
          spec: SPEC,
          // 声明比实际多 1000 字节：模拟连接被掐
          fetchImpl: async () => fakeResponse(body, { contentLength: String(body.length + 1000) }),
        }),
      /不完整/,
    )
    assert.equal((await modelState(asr, SPEC)).present, false)
  })

  test('★ 404 / 500 要说人话（能据此换镜像），不是抛一个 fetch 的原始错误', async () => {
    const asr = join(root, 'status-404')
    await assert.rejects(
      () => ensureModel({ asrRoot: asr, spec: SPEC, fetchImpl: async () => fakeResponse(new Uint8Array(0), { status: 404 }) }),
      /返回 404/,
    )
  })

  test('★★ 正常一次：落盘 + 写锁定哈希 + 第二次不再下载', async () => {
    const asr = join(root, 'ok')
    const body = fakeModelBytes()
    const progress: Array<[number, number]> = []
    const first = await ensureModel({
      asrRoot: asr,
      spec: SPEC,
      fetchImpl: async () => fakeResponse(body),
      onProgress: (done, total) => progress.push([done, total]),
    })
    assert.equal(first.downloaded, true)
    assert.equal(first.present, true)
    assert.equal(first.looksValid, true)
    // 首次信任：下载时算的哈希被锁住，之后用来发现"文件被改坏"
    assert.equal(first.hashOk, true)
    assert.ok(progress.length >= 2, '进度回调应该被调多次')
    assert.equal(progress.at(-1)?.[0], progress.at(-1)?.[1])

    // 磁盘上的字节与"下下来的"一致，且锁定文件里记的正是这份文件的哈希
    const onDisk = await readFile(modelPathOf(asr, SPEC))
    assert.equal(onDisk.length, body.length)
    const lock = JSON.parse(await readFile(join(asr, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { sha256: string; bytes: number }>
    }
    const locked = lock.models[SPEC.id]
    assert.ok(locked !== undefined, '下载之后必须写下锁定哈希（下次加载靠它发现文件被改坏）')
    assert.equal(locked.sha256, await sha256OfFile(modelPathOf(asr, SPEC)))
    assert.equal(locked.bytes, body.length)

    // 第二次：文件在且校验通过 ⇒ 不再下载（fetch 一调就炸，证明没调）
    const second = await ensureModel({
      asrRoot: asr,
      spec: SPEC,
      fetchImpl: async () => {
        throw new Error('不该再下载')
      },
    })
    assert.equal(second.downloaded, false)
    assert.equal(second.hashOk, true)
  })

  test('★★ 文件被改坏（哈希对不上）⇒ 重新下载，不是"报错就完了"', async () => {
    const asr = join(root, 'tampered')
    await ensureModel({ asrRoot: asr, spec: SPEC, fetchImpl: async () => fakeResponse(fakeModelBytes()) })
    // 把文件尾部改掉，保持体积不变（"截断"已被魔数/大小挡住，这里守的是内容被动过）
    const path = modelPathOf(asr, SPEC)
    const buf = await readFile(path)
    buf[buf.length - 1] = 0
    await writeFile(path, buf)
    const state = await modelState(asr, SPEC)
    assert.equal(state.looksValid, true)
    assert.equal(state.hashOk, false)

    const again = await ensureModel({ asrRoot: asr, spec: SPEC, fetchImpl: async () => fakeResponse(fakeModelBytes()) })
    assert.equal(again.downloaded, true)
    assert.equal(again.hashOk, true)
  })

  test('★ 体型太小的文件不算模型（1 MiB 以下一律判坏）', async () => {
    const asr = join(root, 'tiny')
    await mkdir(join(asr, 'models'), { recursive: true })
    await writeFile(modelPathOf(asr, SPEC), Buffer.concat([Buffer.from('ggml'), Buffer.alloc(64)]))
    const state = await modelState(asr, SPEC)
    assert.equal(state.present, true)
    assert.equal(state.looksValid, false)
  })

  test('★ 魔数判定本身：改掉头 4 个字节就不认', async () => {
    const p = join(root, 'magic.bin')
    await mkdir(root, { recursive: true })
    await writeFile(p, Buffer.concat([Buffer.from('ggml'), Buffer.alloc(1 << 20)]))
    assert.equal(await looksLikeGgml(p), true)
    await writeFile(p, Buffer.concat([Buffer.from('html'), Buffer.alloc(1 << 20)]))
    assert.equal(await looksLikeGgml(p), false)
  })

  test('★ 默认上游地址是可覆盖的（国内直连 HF 经常不通，要能换镜像）', async () => {
    const asr = join(root, 'mirror')
    let requestedUrl = ''
    await ensureModel({
      asrRoot: asr,
      spec: SPEC,
      baseUrl: 'https://mirror.example/asr/',
      fetchImpl: async (input) => {
        requestedUrl = String(input)
        return fakeResponse(fakeModelBytes())
      },
    })
    assert.equal(requestedUrl, `https://mirror.example/asr/${SPEC.file}`)
    // 默认值本身也得是那条公开地址（改它意味着所有人换源）
    assert.ok(DEFAULT_MODEL_BASE_URL.startsWith('https://huggingface.co/'))
  })
})
