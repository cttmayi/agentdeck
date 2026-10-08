import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 目录创建（幂等）。 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** 读取 JSON，不存在或解析失败返回 null。 */
export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
}

/**
 * 原子写：写临时文件 → fsync → rename。
 *
 * `rename` 在同一文件系统内是原子的，所以读者要么看到旧内容、要么看到
 * 新内容，不会看到半个文件。这是"崩溃安全"的基础。
 */

/**
 * Windows 上 `rename` 会**偶发**失败，原因不在我们这边。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要重试（2026-10 Windows 兼容性审计的 B6）
 * ══════════════════════════════════════════════════════════════════
 *
 * Windows 的 `MoveFileEx` 在**目标文件此刻被别的进程打开着**时会失败（`EPERM`/
 * `EACCES`），而被打开的原因常常是**别人的事**：杀毒软件正在扫这个文件、索引服务
 * 在读它、另一个句柄还没释放。这类占用**毫秒级**就过去了。
 *
 * 我们的写入面正好是最容易被扫的：`meta.json`（每次启动都重写）、
 * `device.json`、日志轮转、blob。所以"偶发 EPERM"在 Windows 上不是异常，
 * 是常态——而它现在会让**启动直接失败**（`meta.json` 写不进去）。
 *
 * 试一次就放弃是不合理的；无限重试也是。所以：**同一个失败只重试几次、
 * 退避 20/40/80/160ms**（总上限约 300ms），超过就把原始错误抛出去——
 * 那才是"真的不能写"。
 *
 * ⚠️ 重试**只在 win32 上做**。POSIX 上 `rename` 不会因为这个原因失败，
 *    在那边重试 300ms 只会让"真的没权限"这个错误晚 300ms 才报出来。
 *    （POSIX 上 `rename` 覆盖已打开的文件是允许的——这正是两个平台的根本差别。）
 */
export interface RenameRetryDeps {
  /** 注入平台（默认 `process.platform`）——注入是为了能在 macOS 上测 Windows 那条。 */
  platform?: NodeJS.Platform
  /** 注入 rename（默认 `node:fs/promises` 的）。 */
  rename?: (from: string, to: string) => Promise<void>
  /** 注入等待（默认真等）。测试里换成"立刻返回"，免得判据真的睡 300ms。 */
  sleep?: (ms: number) => Promise<void>
}

/** 会被"别人正开着"这个原因影响的错误码。 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export async function renameWithRetry(
  from: string,
  to: string,
  deps: RenameRetryDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform
  const doRename = deps.rename ?? rename
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const delays = platform === 'win32' ? [20, 40, 80, 160] : []
  for (let attempt = 0; ; attempt += 1) {
    try {
      await doRename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const delay = delays[attempt]
      if (delay === undefined || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw err
      await sleep(delay)
    }
  }
}

export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
  deps: RenameRetryDeps = {},
): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await renameWithRetry(tmp, path, deps)
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 追加句柄：保持打开以减少 open/close 开销，并在每次追加后 fsync。
 *
 * 为什么每次 fsync：本项目的写入量很低（几百 issue 级别的本地工具），
 * 而"崩溃后日志缺了最后几条"会直接表现为状态丢失。用性能换正确性
 * 在这里是划算的。测试环境可以关掉。
 */
export class AppendHandle {
  #path: string
  #handle: FileHandle | null = null
  #fsync: boolean

  constructor(path: string, options: { fsync?: boolean } = {}) {
    this.#path = path
    this.#fsync = options.fsync ?? true
  }

  async #open(): Promise<FileHandle> {
    if (!this.#handle) {
      await ensureDir(dirname(this.#path))
      this.#handle = await open(this.#path, 'a')
    }
    return this.#handle
  }

  /** 追加一个换行结尾的记录。写入是串行的——由调用方的锁保证。 */
  async appendLine(line: string): Promise<void> {
    const handle = await this.#open()
    await handle.write(`${line}\n`)
    if (this.#fsync) await handle.sync()
  }

  async close(): Promise<void> {
    if (this.#handle) {
      await this.#handle.close()
      this.#handle = null
    }
  }
}

/** 存在与否。 */
export async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
}

/** 读整个文件的原始字节；不存在返回 null。 */
export async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export { writeFile, join }
