import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { migrateLegacyDataDir } from './cli.ts'

/**
 * 数据目录的一次性迁移（2026-09 改名：alpha-helper → agentdeck）。
 *
 * 与 `workdir.test.ts` 里旧工作目录迁移同一套规矩：只在**完全安全**的情况下搬，
 * 任何不确定都原样不动、并且**说出来**（警告而不是静默跳过）。
 */

describe('★ 旧数据目录的一次性迁移', () => {
  test('★ 旧目录搬到新位置：内容真的过去了，旧目录不再存在', async () => {
    const dataDir = await makeTempDir('migrate-data')
    const legacyDataDir = await makeTempDir('migrate-data-legacy')

    try {
      await mkdir(join(legacyDataDir, 'workspaces', 'ws-1'), { recursive: true })
      await writeFile(join(legacyDataDir, 'workspaces', 'ws-1', 'note.txt'), '上次做到这里', 'utf8')

      const result = await migrateLegacyDataDir({ dataDir, legacyDataDir })

      assert.equal(result, 'moved')
      assert.equal(
        await readFile(join(dataDir, 'workspaces', 'ws-1', 'note.txt'), 'utf8'),
        '上次做到这里',
        '★ 内容必须在——迁移的全部意义就是让数据还在老地方能读到',
      )
      await assert.rejects(stat(legacyDataDir), '旧目录搬完就不该还在了')
    } finally {
      await cleanup(dataDir)
      await cleanup(legacyDataDir)
    }
  })

  test('★ 新目录非空 ⇒ 什么都不碰，并且要警告（那是使用者的地盘）', async () => {
    const dataDir = await makeTempDir('migrate-data')
    const legacyDataDir = await makeTempDir('migrate-data-legacy')

    const warnings: string[] = []
    try {
      await mkdir(join(legacyDataDir, 'workspaces', 'ws-old'), { recursive: true })
      await mkdir(join(dataDir, 'workspaces', 'ws-new'), { recursive: true })
      await writeFile(join(dataDir, 'workspaces', 'ws-new', 'mine.txt'), '我自己放的', 'utf8')

      const result = await migrateLegacyDataDir({ dataDir, legacyDataDir, onWarn: (m) => warnings.push(m) })

      assert.equal(result, 'skipped')
      assert.equal(
        await readFile(join(dataDir, 'workspaces', 'ws-new', 'mine.txt'), 'utf8'),
        '我自己放的',
        '★ 绝不能覆盖使用者已经放进新目录的东西',
      )
      assert.equal(
        (await stat(join(legacyDataDir, 'workspaces', 'ws-old'))).isDirectory(),
        true,
        '旧内容也不能丢',
      )
      assert.equal(warnings.length, 1, '★ 静默跳过会让人以为已经迁完了，必须说一声')
      assert.match(warnings[0]!, /没有丢/)
    } finally {
      await cleanup(dataDir)
      await cleanup(legacyDataDir)
    }
  })

  test('全新安装（旧目录不存在）⇒ 跳过，而且**不白建一个新目录**', async () => {
    const dataDir = await makeTempDir('migrate-data')
    const legacyDataDir = join(dataDir, '..', 'never-existed-legacy')

    try {
      const result = await migrateLegacyDataDir({ dataDir, legacyDataDir })
      assert.equal(result, 'skipped')
    } finally {
      await cleanup(dataDir)
    }
  })

  test('旧目录是空的 ⇒ 跳过（没东西可搬就不搬）', async () => {
    const dataDir = await makeTempDir('migrate-data')
    const legacyDataDir = await makeTempDir('migrate-data-legacy')

    try {
      const result = await migrateLegacyDataDir({ dataDir, legacyDataDir })
      assert.equal(result, 'skipped')
    } finally {
      await cleanup(dataDir)
      await cleanup(legacyDataDir)
    }
  })
})
