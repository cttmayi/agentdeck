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

/**
 * 造一份"长得像模型"的字节：**真的 ggml 魔数**（小端整数 → 字节 `6c 6d 67 67`）+
 * 补到 1 MiB 以上（跳过"体积太小"的判定）。
 *
 * ⚠️ 这里必须与真实文件一致。第一版拿 `Buffer.from('ggml')`（ASCII）当魔数，而真实文件
 *   的前 4 字节是 `6c 6d 67 67`——夹具跟着错代码一起错，于是**测试全绿、真机必崩**
 *   （实测：真模型下载完被判"不是 ggml 模型"）。现在按小端整数写。
 */
function fakeModelBytes(pad = 1 << 20): Uint8Array {
  const bytes = new Uint8Array(8 + pad)
  // 0x67676d6c 小端 ⇒ 6c 6d 67 67（与 `ggml-base-q5_1.bin` 的真实头 4 字节相同）
  bytes[0] = 0x6c
  bytes[1] = 0x6d
  bytes[2] = 0x67
  bytes[3] = 0x67
  // 第 5–8 字节留给"版本号"（真实文件这里是 `99ca 0000`），不必与真实值相同
  bytes[4] = 0x99
  bytes[5] = 0xca
  // 填充非零字节，避免"全是 0"看起来像稀疏文件
  bytes.fill(7, 8)
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
  test('★ 默认档是 small-q5_1（293 批：实测比 base 准得多），且 base 已从目录删除', () => {
    assert.equal(DEFAULT_ASR_MODEL, 'small-q5_1')
    assert.equal(findModelSpec(DEFAULT_ASR_MODEL)?.file, 'ggml-small-q5_1.bin')
    // 目录里**第一档就是默认档**（"第一个 = 默认"这条读起来要一致）
    assert.equal(ASR_MODELS[0]?.id, DEFAULT_ASR_MODEL)
    // ★ 294 批：`base` 不在目录里了（使用者："去掉 base 的选项，我感觉它基本不可用"）
    assert.equal(findModelSpec('base-q5_1'), null)
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
          baseUrl: 'https://pages-only.example/',
          fetchImpl: async () =>
            fakeResponse(new TextEncoder().encode('<html>mirror says hi</html>'.repeat(40000))),
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
          baseUrl: 'https://no-length.example/',
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
          baseUrl: 'https://truncated.example/',
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
      () =>
        ensureModel({
          asrRoot: asr,
          spec: SPEC,
          baseUrl: 'https://only-source.example/',
          fetchImpl: async () => fakeResponse(new Uint8Array(0), { status: 404 }),
        }),
      /返回 404/,
    )
  })

  test('★★ 第一条源连不上 ⇒ **自动换下一条**（使用者实测：直连 huggingface 就是 fetch failed）', async () => {
    const asr = join(root, 'fallback')
    const tried: string[] = []
    const res = await ensureModel({
      asrRoot: asr,
      spec: SPEC,
      baseUrls: ['https://blocked.example/', 'https://mirror.example/'],
      fetchImpl: async (input) => {
        const url = String(input)
        tried.push(url)
        if (url.startsWith('https://blocked.example/')) throw new Error('fetch failed')
        return fakeResponse(fakeModelBytes())
      },
    })
    assert.deepEqual(tried, [
      `https://blocked.example/${SPEC.file}`,
      `https://mirror.example/${SPEC.file}`,
    ])
    assert.equal(res.downloaded, true)
    // 必须说清用的是哪一条（"我下的东西来自哪儿"不该是个谜）
    assert.equal(res.source, `https://mirror.example/${SPEC.file}`)
  })

  test('★★ 第一条返回的是 HTML 错误页也照样换下一条（200 不等于"拿到了模型"）', async () => {
    const asr = join(root, 'fallback-html')
    const res = await ensureModel({
      asrRoot: asr,
      spec: SPEC,
      baseUrls: ['https://bad.example/', 'https://good.example/'],
      fetchImpl: async (input) =>
        String(input).startsWith('https://bad.example/')
          ? fakeResponse(new TextEncoder().encode('<html>nope</html>'.repeat(40000)))
          : fakeResponse(fakeModelBytes()),
    })
    assert.equal(res.downloaded, true)
    assert.equal(res.source, `https://good.example/${SPEC.file}`)
  })

  test('★★ 全都失败时，**每一个源的失败原因都列出来**（否则"都失败了"等于什么都没说）', async () => {
    const asr = join(root, 'all-fail')
    await assert.rejects(
      () =>
        ensureModel({
          asrRoot: asr,
          spec: SPEC,
          baseUrls: ['https://a.example/', 'https://b.example/'],
          fetchImpl: async (input) => {
            if (String(input).startsWith('https://a.example/')) throw new Error('fetch failed')
            return fakeResponse(new Uint8Array(0), { status: 503 })
          },
        }),
      (err: Error) => {
        assert.match(err.message, /a\.example/)
        assert.match(err.message, /fetch failed/)
        assert.match(err.message, /b\.example/)
        assert.match(err.message, /503/)
        // 还要给出"下一步怎么做"
        assert.match(err.message, /--asr-model-base/)
        return true
      },
    )
  })

  test('★ `--asr-model-base` 给了就**只用它**（钉死内网镜像的人不该被偷偷换回公网）', async () => {
    const asr = join(root, 'pinned')
    const tried: string[] = []
    await assert.rejects(
      () =>
        ensureModel({
          asrRoot: asr,
          spec: SPEC,
          baseUrl: 'https://internal.example/',
          fetchImpl: async (input) => {
            tried.push(String(input))
            throw new Error('fetch failed')
          },
        }),
      /internal\.example/
    )
    assert.deepEqual(tried, [`https://internal.example/${SPEC.file}`])
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
    await writeFile(
      modelPathOf(asr, SPEC),
      Buffer.concat([Buffer.from([0x6c, 0x6d, 0x67, 0x67]), Buffer.alloc(64)]),
    )
    const state = await modelState(asr, SPEC)
    assert.equal(state.present, true)
    assert.equal(state.looksValid, false)
  })

  test('★★ 魔数判定按**小端整数**认（真实文件头是 6c6d6767，不是 ASCII 的 "ggml"）', async () => {
    const p = join(root, 'magic.bin')
    await mkdir(root, { recursive: true })
    // 真模型的前 4 字节
    assert.equal(await writeAndCheck(p, Buffer.from([0x6c, 0x6d, 0x67, 0x67])), true)
    // GGUF（新容器格式）：文件头就是 ASCII 的 GGUF
    assert.equal(await writeAndCheck(p, Buffer.from('GGUF', 'ascii')), true)
    // 老的 'ggmf'（同样按小端整数写 ⇒ 字节是 67 67 6d 66）
    assert.equal(await writeAndCheck(p, Buffer.from([0x67, 0x67, 0x6d, 0x66])), true)
    // ASCII 的 "ggml" 是**错的**字节序——它必须被拒（第一版就是把它当成了对的）
    assert.equal(await writeAndCheck(p, Buffer.from('ggml', 'ascii')), false)
    // 反代返回的 HTML 错误页
    assert.equal(await writeAndCheck(p, Buffer.from('<html>', 'ascii')), false)
  })

  /** 写一个"头 4 字节指定 + 补到 1 MiB"的文件，返回 `looksLikeGgml` 的结论。 */
  async function writeAndCheck(path: string, head: Buffer): Promise<boolean> {
    await writeFile(path, Buffer.concat([head, Buffer.alloc(1 << 20)]))
    return looksLikeGgml(path)
  }

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
