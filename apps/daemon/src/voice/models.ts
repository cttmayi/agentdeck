import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { modelsDirOf, readJsonFile, writeJsonFile } from './paths.ts'

/**
 * Whisper 模型的管理（下载、校验、定位）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么模型要由平台管，而不是"让人自己去下"
 * ══════════════════════════════════════════════════════════════════
 *
 * 约束是"**离线**口述"——但模型文件不可能进仓库（几十到几百 MiB）。所以真实的形态
 * 是："第一次用要下一次（需要网络），之后全程离线"。这句话必须由平台说出来、也由
 * 平台做掉，否则使用者看到的是一个"点了没反应"的麦克风按钮。
 *
 * ══════════════════════════════════════════════════════════════════
 * 校验为什么是"魔数 + 大小 + 锁定哈希"，而不是只比 sha256
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **魔数**：ggml 模型文件的头 4 字节是 `ggml`。有了它，"下了一半的 HTML 错误页"
 *    与"真的模型"当场分得开——这是最常见的失败（反代 / 镜像返回 200 + 一页 HTML）。
 * ② **大小**：只做下限判断（> 1 MiB），**不钉死字节数**：上游重新量化过之后字节数
 *    会变，钉死会让老用户永远"校验失败"，而那种红是**假**的（文件其实好使）。
 * ③ **锁定哈希**（`models.lock.json`）：下载时算一次、之后每次加载都比。它守的不是
 *    "上游有没有被换"，而是"**我这份有没有被改坏**"（截断、磁盘错误、半途覆盖）。
 *
 * ⚠️ 上游真实性（TOFU 的另一半）：`spec.sha256` 是**可选**的钉，写了就以它为准；
 *   没写就按"第一次下载时的哈希"锁住（首次信任）。这不是完美方案，但比"什么都不校验"
 *   强得多，也比"编一个假哈希"诚实——假哈希会让所有下载都失败。
 */

export interface AsrModelSpec {
  /** 稳定 id（设置里存它，不存文件名）。 */
  id: string
  /** 界面上的名字。 */
  label: string
  /** 落盘文件名（ggml 的命名习惯）。 */
  file: string
  /** 大致体积（只用于界面提示"首次需下载约 xx MiB"）。 */
  approxMb: number
  /** 一句话说明它是什么档（快 / 准 / 最准）。 */
  note: string
  /** 可选的上游哈希钉（写了就必须一致）。 */
  sha256?: string
}

/**
 * 目录里可选的三档。
 *
 * ★ 默认 base-q5_1（分批第 277 批，使用者："默认模型 = 体积小的 base-q5_1"）：
 *   约 57 MiB、Apple Silicon 上 10 秒音频不到 1 秒就出结果——口述录入这种"说完就要
 *   看到字"的场景，慢的模型即使更准也会被放弃。
 * ⚠️ 三档都是**多语言**模型（不带 `.en`）：中文与中英混说都要认，`.en` 版对中文
 *   等于不会说话。
 */
export const ASR_MODELS: readonly AsrModelSpec[] = [
  {
    id: 'base-q5_1',
    label: 'base（量化 q5_1）',
    file: 'ggml-base-q5_1.bin',
    approxMb: 57,
    note: '默认：快，日常口述够用',
  },
  {
    id: 'small-q5_1',
    label: 'small（量化 q5_1）',
    file: 'ggml-small-q5_1.bin',
    approxMb: 181,
    note: '更准，慢 2–4 倍',
  },
  {
    id: 'small',
    label: 'small（f16）',
    file: 'ggml-small.bin',
    approxMb: 466,
    note: '最准的一档，最慢；网络差时别选',
  },
]

export const DEFAULT_ASR_MODEL = 'base-q5_1'

/**
 * 上游地址：**按顺序试**。
 *
 * ⚠️ 国内直连 huggingface 经常不通（本机实测 HEAD 都拿不到），而"装不上模型"会表现成
 *   "麦克风按钮点了没反应"。使用者第一次点「下载模型」就撞上 `fetch failed` 之后，
 *   他得到的建议不该是"去改一行代码"——所以这里直接给一条**回退链**：
 *
 *     ① huggingface.co（官方）
 *     ② hf-mirror.com（国内镜像，内容一致、由第三方加速）
 *
 * 第一个不可用就换第二个，并**在结果里说清用的是哪一个**（`source`）——"我下的东西
 * 到底来自哪儿"不该是个谜。
 *
 * ★ 可整体覆盖（`--asr-model-base`）：给了就只用给的那一个，**不回落**
 *   （想钉死某个内网镜像的人，不该被偷偷换回公网）。
 */
export const DEFAULT_MODEL_BASE_URLS: readonly string[] = [
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
]

/** 老名字（单值）：给"只想要官方地址"的调用方用；等价于取回退链的第一个。 */
export const DEFAULT_MODEL_BASE_URL = DEFAULT_MODEL_BASE_URLS[0] as string

export function findModelSpec(id: string): AsrModelSpec | null {
  return ASR_MODELS.find((m) => m.id === id) ?? null
}

export function modelPathOf(asrRoot: string, spec: AsrModelSpec): string {
  return join(modelsDirOf(asrRoot), spec.file)
}

/**
 * 模型文件头的魔数。
 *
 * ⚠️⚠️ **这里踩过一个真缺陷**（排查记录，别改回去）：ggml 的魔数是**按小端整数**写的
 *   `0x67676d6c`，落成字节是 `6c 6d 67 67`（读出来是 "lmgg"，**不是** "ggml"）。
 *   第一版拿 `Buffer.from('ggml')` 去比 ⇒ 每个真模型都被判成"不是 ggml 模型"，
 *   于是下载永远失败在最后一步（而且报错还说"可能返回了错误页"，指向完全错误的方向）。
 *   测试没抓到是因为夹具也用了同一段错误代码当"真模型"。
 *
 * 真实文件的前 16 字节（`ggml-base-q5_1.bin`）：
 *   `6c6d 6767 99ca 0000 dc05 0000 0002 0000`
 */
const GGML_MAGIC_LE = 0x67676d6c
/** 老版本 whisper.cpp 用过的另一个魔数（同样是按小端整数写的 "ggmf"）。 */
const GGM_F_MAGIC_LE = 0x666d6767
/**
 * GGUF 是新容器格式（文件头就是 ASCII 的 `GGUF`）。
 * 现在这些 whisper 模型都还是 ggml，但以后可能换成 GGUF——两种都认，免得那一天又
 * 变成"下完了却说文件无效"。
 */
const GGUF_MAGIC = Buffer.from('GGUF', 'ascii')
/** 小于这个数的一定不是模型（真实的量化模型最小也有几十 MiB）。 */
const MIN_MODEL_BYTES = 1 << 20

export interface ModelState {
  id: string
  path: string
  present: boolean
  /** 文件看起来是个真模型（魔数对、体积够）。`present` 但没有它就说明文件坏了。 */
  looksValid: boolean
  bytes: number
  /** 与锁定的哈希一致。null = 还没锁定（第一次下载前）或没校验。 */
  hashOk: boolean | null
}

interface ModelsLock {
  version: number
  models: Record<string, { sha256: string; bytes: number; at: string }>
}

function lockPathOf(asrRoot: string): string {
  return join(asrRoot, 'models.lock.json')
}

async function readLock(asrRoot: string): Promise<ModelsLock> {
  const raw = await readJsonFile(lockPathOf(asrRoot))
  const obj = (raw ?? {}) as Record<string, unknown>
  const models = (typeof obj['models'] === 'object' && obj['models'] !== null
    ? obj['models']
    : {}) as Record<string, { sha256: string; bytes: number; at: string }>
  return { version: 1, models }
}

async function writeLock(asrRoot: string, lock: ModelsLock): Promise<void> {
  await writeJsonFile(lockPathOf(asrRoot), lock)
}

/**
 * 读文件头，判断"这是不是一个 ggml / GGUF 模型"。
 *
 * 魔数按**小端整数**比（见上面 `GGML_MAGIC_LE` 那段：字节序搞反过一次，整个下载
 * 因此永远失败）。
 */
export async function looksLikeGgml(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(8)
      const { bytesRead } = await handle.read(buf, 0, 8, 0)
      if (bytesRead < 4) return false
      if (buf.subarray(0, 4).equals(GGUF_MAGIC)) return true
      const magic = buf.readUInt32LE(0)
      return magic === GGML_MAGIC_LE || magic === GGM_F_MAGIC_LE
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/** 算一个文件的 sha256（流式，几十 MiB 也不会把内存吃掉）。 */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/**
 * 查一个模型的当前状态（**只读**，不下载、不改任何东西）。
 *
 * capability 与设置页都用它：界面要知道"在不在、要不要下一次"。
 */
export async function modelState(asrRoot: string, spec: AsrModelSpec): Promise<ModelState> {
  const path = modelPathOf(asrRoot, spec)
  let bytes = 0
  let exists = false
  try {
    const st = await stat(path)
    exists = st.isFile()
    bytes = st.size
  } catch {
    exists = false
  }
  if (!exists) {
    return { id: spec.id, path, present: false, looksValid: false, bytes: 0, hashOk: null }
  }
  const looksValid = bytes >= MIN_MODEL_BYTES && (await looksLikeGgml(path))
  const lock = await readLock(asrRoot)
  const pinned = spec.sha256 ?? lock.models[spec.id]?.sha256
  let hashOk: boolean | null = null
  if (looksValid && pinned !== undefined) {
    hashOk = (await sha256OfFile(path)) === pinned
  }
  return { id: spec.id, path, present: true, looksValid, bytes, hashOk }
}

export interface EnsureModelDeps {
  asrRoot: string
  spec: AsrModelSpec
  /**
   * 上游根地址（结尾带斜杠）。给了就**只用它、不回落**（想钉死内网镜像的人不该被
   * 偷偷换回公网）。
   */
  baseUrl?: string
  /** 一条**回退链**（按顺序试）。不给 `baseUrl` 时用它；两者都不给用默认那条链。 */
  baseUrls?: readonly string[]
  /** 注入 fetch（测试用它给假响应，绝不真的联网）。 */
  fetchImpl?: typeof fetch
  /** 进度回调（已写字节 / 总字节；总字节来自 Content-Length）。 */
  onProgress?: (done: number, total: number) => void
}

export interface EnsureModelResult extends ModelState {
  /** 这次真的下载了（false = 本来就有一份好的）。 */
  downloaded: boolean
  /**
   * 这次用的是哪条上游地址（回退链里第几个成功的就是它）。
   * ⚠️ 必须回给界面："我下的东西到底来自哪儿"不该是个谜。
   */
  source?: string
}

/**
 * 确保本地有一份可用的模型：有就验、没有就下。
 *
 * ⚠️ 只有三种失败，且都要说人话：
 *   · 网络不通 / 非 200 ⇒ 「模型下载失败：<原因>」——使用者能据此换镜像；
 *   · 没有 Content-Length ⇒ 拒绝（**没法确认完整性**，下完也不敢用）；
 *   · 哈希/魔数不对 ⇒ 删掉半成品并报错（绝不留一个"看起来在"的坏文件：
 *     下次加载会崩在 whisper 里，那个报错完全指不到模型）。
 */
export async function ensureModel(deps: EnsureModelDeps): Promise<EnsureModelResult> {
  const { asrRoot, spec } = deps
  const before = await modelState(asrRoot, spec)
  if (before.present && before.looksValid && before.hashOk !== false) {
    return { ...before, downloaded: false }
  }

  const sources =
    deps.baseUrl !== undefined
      ? [deps.baseUrl]
      : (deps.baseUrls ?? DEFAULT_MODEL_BASE_URLS)

  /**
   * ★ 按顺序试（分批第 283 批，使用者实测报的："模型下载失败（连不上
   *   huggingface.co…）：fetch failed"）。国内直连 HF 不通是常态，而让使用者自己
   *   去找镜像等于"这功能在我这儿不能用"。
   *
   * ⚠️ 回退的判据是**任何一次失败**：连不上、非 200、缺 Content-Length、传输中断、
   *   下完发现不是模型——这些都不该把整次下载判死，换下一个源往往就好了。
   *   每一次的失败原因都留着，最后一起报（否则"全都失败了"等于什么都没说）。
   */
  const failures: Array<{ url: string; reason: string }> = []
  for (const base of sources) {
    const url = `${base.replace(/\/$/, '')}/${spec.file}`
    try {
      const result = await downloadFrom(deps, url)
      return { ...result, downloaded: true, source: url }
    } catch (err) {
      failures.push({ url, reason: messageOf(err) })
    }
  }

  const detail = failures
    .map((f) => `· ${f.url}\n    ${f.reason}`)
    .join('\n')
  throw new Error(
    `模型下载失败：试过的 ${failures.length} 个来源都不可用。\n${detail}\n` +
      `可以换一个可用的镜像：启动 daemon 时加 --asr-model-base <镜像根地址>（结尾带斜杠），` +
      `或把 ${spec.file} 手动放进 ${modelPathOf(asrRoot, spec)}。`,
  )
}

/** 从**一条**上游地址下载并校验。失败一律抛错（由调用方决定要不要换下一个源）。 */
async function downloadFrom(deps: EnsureModelDeps, url: string): Promise<ModelState> {
  const { asrRoot, spec } = deps
  const doFetch = deps.fetchImpl ?? fetch
  const dir = modelsDirOf(asrRoot)
  await mkdir(dir, { recursive: true })
  const target = modelPathOf(asrRoot, spec)
  const partial = `${target}.part`

  let response: Response
  try {
    response = await doFetch(url)
  } catch (err) {
    throw new Error(`连不上（${messageOf(err)}）`)
  }
  if (!response.ok) {
    throw new Error(`返回 ${response.status}`)
  }
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader === null) {
    throw new Error('没给 Content-Length，无法确认下载是否完整')
  }
  const total = Number(lengthHeader)
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`Content-Length 不可用（${lengthHeader}）`)
  }
  if (response.body === null) {
    throw new Error('没有响应体')
  }

  const hash = createHash('sha256')
  let done = 0
  const handle = await open(partial, 'w')
  try {
    // 边读边写边算哈希：57 MiB 一次读进内存也能行，但 466 MiB 那档就不行了
    const reader = response.body.getReader()
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      if (value) {
        hash.update(value)
        await handle.write(value)
        done += value.length
        deps.onProgress?.(done, total)
      }
    }
  } catch (err) {
    await handle.close()
    await rm(partial, { force: true })
    throw new Error(`传输中断（${messageOf(err)}），已删除半截文件`)
  }
  await handle.close()

  if (done !== total) {
    await rm(partial, { force: true })
    throw new Error(`下载不完整（收到 ${done} 字节，应为 ${total} 字节），已删除`)
  }
  const digest = hash.digest('hex')
  if (spec.sha256 !== undefined && digest !== spec.sha256) {
    await rm(partial, { force: true })
    throw new Error(`sha256 与预期不符（拿到 ${digest.slice(0, 12)}…），上游可能已更新`)
  }
  await rename(partial, target)

  const lock = await readLock(asrRoot)
  lock.models[spec.id] = { sha256: digest, bytes: done, at: new Date().toISOString() }
  await writeLock(asrRoot, lock)

  // 落盘之后按"真实文件"再确认一遍（魔数检查在这里才有意义：这是刚下下来的东西）
  const after = await modelState(asrRoot, spec)
  if (!after.looksValid) {
    await rm(target, { force: true })
    throw new Error('下载到的文件不是有效的 ggml 模型（这个源可能返回了错误页或反代页面）')
  }
  return after
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
