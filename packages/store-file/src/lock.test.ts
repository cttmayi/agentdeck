import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileStore } from './file-store.ts'
import { LockHeldError } from './lock.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string

before(async () => {
  dir = await makeTempDir('lock')
})
after(async () => {
  await cleanup(dir)
})

describe('单进程锁（NFR-D-05）', () => {
  test('第一个实例拿到锁', async () => {
    const a = await FileStore.open({ dataDir: dir, fsync: false })
    assert.equal(await a.formatVersion(), 1)
    await a.close()
  })

  test('★ 第二个实例必须启动失败并给出可读原因，而不是静默损坏数据', async () => {
    const a = await FileStore.open({ dataDir: dir, fsync: false })
    try {
      await assert.rejects(
        () => FileStore.open({ dataDir: dir, fsync: false }),
        (err: unknown) => {
          assert.ok(err instanceof LockHeldError, '应为 LockHeldError')
          const lockErr = err as LockHeldError
          assert.match(lockErr.message, /已被另一个 daemon 进程占用/)
          assert.equal(lockErr.heldBy.pid, process.pid)
          return true
        },
      )
    } finally {
      await a.close()
    }
  })

  test('关闭后可被重新打开', async () => {
    const a = await FileStore.open({ dataDir: dir, fsync: false })
    await a.close()
    const b = await FileStore.open({ dataDir: dir, fsync: false })
    await b.close()
  })
})

describe('存储格式版本门禁（FR-STOR-04）', () => {
  test('数据目录版本高于程序支持 ⇒ 拒绝打开并给出可读原因', async () => {
    const d = await makeTempDir('version')
    try {
      const store = await FileStore.open({ dataDir: d, fsync: false })
      await store.close()
      // 手工把版本改高，模拟"用旧程序打开新数据"
      const metaPath = join(d, 'meta.json')
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
      meta['formatVersion'] = 99
      const { writeFile } = await import('node:fs/promises')
      await writeFile(metaPath, JSON.stringify(meta))

      await assert.rejects(
        () => FileStore.open({ dataDir: d, fsync: false }),
        (err: unknown) => {
          assert.match((err as Error).message, /请升级程序/)
          return true
        },
      )
    } finally {
      await cleanup(d)
    }
  })
})

describe('端口纯洁性（FR-STOR-03）—— 守护"将来能换数据库"', () => {
  test('★ 端口里不得出现 file / json / line / path 这类存储实现词汇', async () => {
    const portPath = fileURLToPath(
      new URL('../../domain/src/ports/store.ts', import.meta.url),
    )
    const src = await readFile(portPath, 'utf8')
    const methodNames = [...src.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]!)

    assert.ok(methodNames.length > 20, `应检出接口方法，实际只有 ${methodNames.length} 个`)

    const offenders = methodNames.filter((n) => /file|json|line|path|readall/i.test(n))
    assert.deepEqual(
      offenders,
      [],
      `端口方法名泄漏了存储实现：${offenders.join(', ')}`,
    )
  })
})
