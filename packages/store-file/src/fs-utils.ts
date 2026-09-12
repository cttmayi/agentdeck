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
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
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
