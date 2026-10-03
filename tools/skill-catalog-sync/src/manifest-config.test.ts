import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  BUILTIN_MANIFEST_PATH,
  CONFIG_FILE_NAME,
  configPathFor,
  resolveManifest,
  summarizeManifest,
} from './manifest-config.ts'

/**
 * 清单的"默认值 → 配置文件"（D54，使用者："逻辑上 recommended-skills.json 只是默认值，
 * 运行后需要转存到另外的位置上，未来可以进行配置"）。
 *
 * 这里钉四件事：
 *   ① **第一次运行会转存**（并且日志要说清转存到哪儿）；
 *   ② **已经存在就不覆盖**（那是使用者的配置，改过的不能丢）；
 *   ③ `--manifest` 显式指定时**不转存**、缺了直接报错；
 *   ④ 摘要三种状态（有 / 没有 / 读不了）都不编值。
 */
describe('推荐清单：默认值 vs 配置文件', () => {
  test('★ 配置就放在内容目录旁边（一起搬走时不拆散）', () => {
    assert.equal(
      configPathFor('/data/remote/catalog-skills'),
      `/data/remote/${CONFIG_FILE_NAME}`,
    )
  })

  test('★★ 第一次运行：把内置默认**转存**到配置位置，然后就用那一份', async () => {
    const root = await makeTempDir('manifest-config')
    const catalogDir = join(root, 'catalog-skills')
    const lines: string[] = []
    try {
      const resolved = await resolveManifest({
        catalogDir,
        log: (l) => lines.push(l),
      })

      assert.equal(resolved.origin, 'seeded-from-builtin')
      assert.equal(resolved.seeded, true)
      assert.equal(resolved.path, configPathFor(catalogDir))
      // 转存出来的内容与内置那份**逐字相同**
      assert.equal(
        await readFile(resolved.path, 'utf8'),
        await readFile(BUILTIN_MANIFEST_PATH, 'utf8'),
      )
      // ★ 日志必须说清"以后改哪一份"——否则使用者会继续去改仓库里那份（然后被 git 覆盖）
      assert.ok(
        lines.some((l) => l.includes(resolved.path)),
        `日志里要有转存位置：${lines.join(' | ')}`,
      )
      assert.ok(lines.some((l) => l.includes('以后改')), '要说清以后改哪一份')
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 已经存在配置 ⇒ 用它，**绝不覆盖**（那是使用者的东西）', async () => {
    const root = await makeTempDir('manifest-config-existing')
    const catalogDir = join(root, 'catalog-skills')
    try {
      const configPath = configPathFor(catalogDir)
      await writeFile(
        configPath,
        JSON.stringify({ schema: 'agentdeck/recommended-skills@1', verifiedAt: '2026-01-01', items: [{ url: 'https://github.com/o/r', name: 'x', category: 'other', summary: 's' }] }),
        'utf8',
      )
      const resolved = await resolveManifest({ catalogDir })
      assert.equal(resolved.origin, 'config')
      assert.equal(resolved.seeded, false)
      const kept = JSON.parse(await readFile(configPath, 'utf8')) as { verifiedAt: string }
      assert.equal(kept.verifiedAt, '2026-01-01', '使用者改过的那份不能被动')
    } finally {
      await cleanup(root)
    }
  })

  test('★ `--manifest` 显式指定：不转存、缺了直接报错', async () => {
    const root = await makeTempDir('manifest-config-explicit')
    const catalogDir = join(root, 'catalog-skills')
    try {
      const explicit = join(root, 'mine.json')
      await writeFile(explicit, '{"schema":"agentdeck/recommended-skills@1","items":[]}', 'utf8')
      const resolved = await resolveManifest({ catalogDir, explicitPath: explicit })
      assert.equal(resolved.origin, 'explicit')
      assert.equal(resolved.path, explicit)
      // ★ 显式指定时**不**在旁边生成配置文件（否则会出现"两份清单谁说了算"）
      assert.deepEqual(await readdir(root).catch(() => []), ['mine.json'])

      await assert.rejects(
        () => resolveManifest({ catalogDir, explicitPath: join(root, 'nope.json') }),
        /不存在/,
      )
    } finally {
      await cleanup(root)
    }
  })

  test('★ 摘要三种状态：有 / 还没转存 / 读不了（都不编值）', async () => {
    const root = await makeTempDir('manifest-config-summary')
    try {
      const missing = await summarizeManifest(join(root, 'nope.json'))
      assert.deepEqual(
        { exists: missing.exists, count: missing.count, verifiedAt: missing.verifiedAt, error: missing.error },
        { exists: false, count: 0, verifiedAt: null, error: null },
        '还没转存是**合法状态**，不是错误',
      )

      const good = join(root, 'good.json')
      await writeFile(
        good,
        JSON.stringify({ schema: 'agentdeck/recommended-skills@1', verifiedAt: '2026-10-05', items: [{}, {}] }),
        'utf8',
      )
      const summary = await summarizeManifest(good)
      assert.equal(summary.exists, true)
      assert.equal(summary.count, 2)
      assert.equal(summary.verifiedAt, '2026-10-05')
      assert.equal(summary.error, null)

      const broken = join(root, 'broken.json')
      await writeFile(broken, '{ 这不是 JSON', 'utf8')
      const bad = await summarizeManifest(broken)
      assert.equal(bad.exists, true)
      assert.equal(bad.count, 0, '读不了就**不许**编一个条数')
      assert.ok(bad.error !== null, '要说清读不了')
    } finally {
      await cleanup(root)
    }
  })
})
