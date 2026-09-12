import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, removeQuietly } from './fs-utils.ts'

/**
 * 单进程锁。
 *
 * 为什么必须有（NFR-D-05）：同一数据目录被两个 daemon 进程同时打开，
 * 两个进程各自维护一份内存索引并互相覆盖日志——**数据会静默损坏**，
 * 而且损坏是延迟暴露的，等发现时已经不知道从哪一条开始错。
 *
 * 所以第二个实例必须**启动失败并给出可读原因**，而不是"凑合能跑"。
 */

export interface LockInfo {
  pid: number
  startedAt: number
  deviceName?: string
}

export class LockHeldError extends Error {
  readonly heldBy: LockInfo
  constructor(lockPath: string, heldBy: LockInfo) {
    super(
      `数据目录已被另一个 daemon 进程占用（pid=${heldBy.pid}）。` +
        `请先停止它，或改用其他数据目录。锁文件：${lockPath}`,
    )
    this.name = 'LockHeldError'
    this.heldBy = heldBy
  }
}

export function lockPath(dataDir: string): string {
  return join(dataDir, 'lock')
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    // 信号 0 只做存在性检查，不真的发信号
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 取锁。已有**存活**进程持锁则抛 `LockHeldError`；
 * 持锁进程已死则视为陈旧锁，直接接管。
 */
export async function acquireLock(dataDir: string, info?: Partial<LockInfo>): Promise<() => Promise<void>> {
  await ensureDir(dataDir)
  const path = lockPath(dataDir)
  const payload: LockInfo = {
    pid: process.pid,
    startedAt: Date.now(),
    ...info,
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' 保证"不存在才创建"——这是原子操作，不会有两个进程同时成功
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(JSON.stringify(payload))
        await handle.sync()
      } finally {
        await handle.close()
      }

      return async () => {
        await removeQuietly(path)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

      const existing = await readLock(path)
      if (existing && isProcessAlive(existing.pid)) {
        throw new LockHeldError(path, existing)
      }

      // 陈旧锁：上次异常退出留下的。清掉后重试一次。
      await removeQuietly(path)
    }
  }

  throw new Error(`无法获取数据目录锁：${path}`)
}

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockInfo
  } catch {
    return null
  }
}
