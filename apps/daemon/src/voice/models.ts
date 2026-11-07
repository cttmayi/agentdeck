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
 * 上游的默认地址。
 *
 * ⚠️ 可覆盖（`--asr-model-base`）：国内直连 huggingface 经常不通（本机实测连
 *   HEAD 都拿不到），而"装不上模型"会表现成"麦克风按钮点了没反应"。给一个显式的
 *   镜像地址，比让人去改代码强。
 */
export const DEFAULT_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

export function findModelSpec(id: string): AsrModelSpec | null {
  return ASR_MODELS.find((m) => m.id === id) ?? null
}

export function modelPathOf(asrRoot: string, spec: AsrModelSpec): string {
  return join(modelsDirOf(asrRoot), spec.file)
}

/** ggml 文件头 4 字节。 */
const GGML_MAGIC = Buffer.from('ggml', 'ascii')
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

/** 读文件头，判断"这是不是一个 ggml 模型"。 */
export async function looksLikeGgml(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(GGML_MAGIC.length)
      const { bytesRead } = await handle.read(buf, 0, GGML_MAGIC.length, 0)
      return bytesRead === GGML_MAGIC.length && buf.equals(GGML_MAGIC)
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
  /** 上游根地址（结尾带斜杠），可注入以便测试与镜像。 */
  baseUrl?: string
  /** 注入 fetch（测试用它给假响应，绝不真的联网）。 */
  fetchImpl?: typeof fetch
  /** 进度回调（已写字节 / 总字节；总字节来自 Content-Length）。 */
  onProgress?: (done: number, total: number) => void
}

export interface EnsureModelResult extends ModelState {
  /** 这次真的下载了（false = 本来就有一份好的）。 */
  downloaded: boolean
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

  const baseUrl = deps.baseUrl ?? DEFAULT_MODEL_BASE_URL
  const doFetch = deps.fetchImpl ?? fetch
  const url = `${baseUrl.replace(/\/$/, '')}/${spec.file}`
  const dir = modelsDirOf(asrRoot)
  await mkdir(dir, { recursive: true })
  const target = modelPathOf(asrRoot, spec)
  const partial = `${target}.part`

  let response: Response
  try {
    response = await doFetch(url)
  } catch (err) {
    throw new Error(`模型下载失败（连不上 ${url}）：${messageOf(err)}`)
  }
  if (!response.ok) {
    throw new Error(`模型下载失败：${url} 返回 ${response.status}`)
  }
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader === null) {
    throw new Error(`模型下载失败：${url} 没给 Content-Length，无法确认下载是否完整`)
  }
  const total = Number(lengthHeader)
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`模型下载失败：${url} 的 Content-Length 不可用（${lengthHeader}）`)
  }
  if (response.body === null) {
    throw new Error(`模型下载失败：${url} 没有响应体`)
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
    throw new Error(`模型下载中断：${messageOf(err)}（已删除半截文件，可以重试）`)
  }
  await handle.close()

  if (done !== total) {
    await rm(partial, { force: true })
    throw new Error(`模型下载不完整：收到 ${done} 字节，应为 ${total} 字节（已删除，可以重试）`)
  }
  const digest = hash.digest('hex')
  if (spec.sha256 !== undefined && digest !== spec.sha256) {
    await rm(partial, { force: true })
    throw new Error(
      `模型校验失败：sha256 与预期不符（拿到 ${digest.slice(0, 12)}…）。` +
        `上游可能已更新——请确认来源，或换一个模型档`,
    )
  }
  await rename(partial, target)

  const lock = await readLock(asrRoot)
  lock.models[spec.id] = { sha256: digest, bytes: done, at: new Date().toISOString() }
  await writeLock(asrRoot, lock)

  // 落盘之后按"真实文件"再确认一遍（魔数检查在这里才有意义：这是刚下下来的东西）
  const after = await modelState(asrRoot, spec)
  if (!after.looksValid) {
    await rm(target, { force: true })
    throw new Error(
      `下载到的文件不是有效的 ggml 模型（头部不是 ggml）：${url} 可能返回了错误页或反代页面`,
    )
  }
  return { ...after, downloaded: true }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
