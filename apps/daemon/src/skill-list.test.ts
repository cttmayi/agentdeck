import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SKILL_LIST_SCHEMA, defaultSkillListPath, loadSkillList } from './skill-list.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 「本地安装清单」的读取与校验（`skill-list.ts`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里盯的是两件容易错、又不容易被发现的事
 * ══════════════════════════════════════════════════════════════════
 *
 *   1. **slug 算得和装的时候一模一样**。清单不声明 slug，界面拿 daemon 算出来的
 *      去比"装没装过"——算错一个，一条已装的技能会被显示成「安装」，而且**不报错**。
 *   2. **坏条目不拖垮整张表，但也不静默消失**。一条写错进 `skipped`（带原因），
 *      整份文件坏掉才抛。
 */

/** 在临时目录里写一份清单文件，返回它的路径。 */
async function withManifest<T>(
  dir: string,
  content: unknown,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const path = join(dir, 'skills.json')
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return fn(path)
}

function manifest(items: unknown[]): unknown {
  return { schema: SKILL_LIST_SCHEMA, items }
}

describe('★ 本地安装清单：slug 与取包规则逐字相同', () => {
  test('url：tree 取目录名、仓库根取仓库名、blob 取所在目录名', async () => {
    const dir = await makeTempDir('skill-list-slug-url')
    try {
      const result = await withManifest(
        dir,
        manifest([
          { name: 'pptx', url: 'https://github.com/anthropics/skills/tree/main/skills/pptx' },
          { name: '整仓库', url: 'https://github.com/lewislulu/html-ppt-skill' },
          {
            name: 'blob 形态',
            url: 'https://github.com/o/r/blob/main/skills/some-skill/SKILL.md',
          },
        ]),
        (path) => loadSkillList(path),
      )
      assert.deepEqual(
        result.entries.map((e) => e.slug),
        ['pptx', 'html-ppt-skill', 'some-skill'],
      )
      assert.deepEqual(result.skipped, [])
      // 来源形状直接对上安装接口的入参（kind + value）
      assert.deepEqual(result.entries[0]!.source, {
        kind: 'url',
        value: 'https://github.com/anthropics/skills/tree/main/skills/pptx',
      })
    } finally {
      await cleanup(dir)
    }
  })

  test('path：取目录名；直接指向 SKILL.md 时取它所在的目录名', async () => {
    const dir = await makeTempDir('skill-list-slug-path')
    try {
      const result = await withManifest(
        dir,
        manifest([
          { name: '目录', path: '/Users/me/dev/my-skill' },
          { name: '文件', path: '/Users/me/dev/foo-bar/SKILL.md' },
        ]),
        (path) => loadSkillList(path),
      )
      assert.deepEqual(
        result.entries.map((e) => e.slug),
        ['my-skill', 'foo-bar'],
      )
      assert.deepEqual(result.entries[1]!.source, {
        kind: 'path',
        value: '/Users/me/dev/foo-bar/SKILL.md',
      })
    } finally {
      await cleanup(dir)
    }
  })

  test('缺省值：summary 缺省为空串、needs 缺省为 null、origin 缺省 community', async () => {
    const dir = await makeTempDir('skill-list-defaults')
    try {
      const result = await withManifest(
        dir,
        manifest([{ name: 'x', url: 'https://github.com/o/r' }]),
        (path) => loadSkillList(path),
      )
      const e = result.entries[0]!
      assert.equal(e.summary, '')
      assert.equal(e.needs, null)
      assert.equal(e.origin, 'community')
      assert.equal(e.category, 'other')
    } finally {
      await cleanup(dir)
    }
  })
})

describe('★ 本地安装清单：坏条目进 skipped，整份文件坏掉才抛', () => {
  test('恰好一个 url 或 path：两个都没有、或两个都给 ⇒ skipped（不拖垮其余）', async () => {
    const dir = await makeTempDir('skill-list-exactly-one')
    try {
      const result = await withManifest(
        dir,
        manifest([
          { name: 'ok', url: 'https://github.com/o/r' },
          { name: '都没有' },
          { name: '都有', url: 'https://github.com/o/r', path: '/x/y' },
        ]),
        (path) => loadSkillList(path),
      )
      assert.deepEqual(result.entries.map((e) => e.slug), ['r'])
      assert.equal(result.skipped.length, 2)
      for (const s of result.skipped) {
        assert.match(s.reason, /恰好/)
      }
    } finally {
      await cleanup(dir)
    }
  })

  test('主机不在白名单 / 非 https ⇒ skipped（带原因），其余照常列出', async () => {
    const dir = await makeTempDir('skill-list-blocked-host')
    try {
      const result = await withManifest(
        dir,
        manifest([
          { name: '好的', url: 'https://github.com/o/r' },
          { name: '别的主机', url: 'https://example.com/x/y' },
          { name: 'http', url: 'http://github.com/o/r' },
        ]),
        (path) => loadSkillList(path),
      )
      assert.deepEqual(result.entries.map((e) => e.slug), ['r'])
      assert.equal(result.skipped.length, 2)
    } finally {
      await cleanup(dir)
    }
  })

  test('条目格式不对（name 空 / 不是对象）⇒ skipped', async () => {
    const dir = await makeTempDir('skill-list-bad-item')
    try {
      const result = await withManifest(
        dir,
        manifest([{ name: '', url: 'https://github.com/o/r' }, '不是对象']),
        (path) => loadSkillList(path),
      )
      assert.deepEqual(result.entries, [])
      assert.equal(result.skipped.length, 2)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 文件读不了 ⇒ 抛（"清单是空的"与"清单读不了"是两件事）', async () => {
    const dir = await makeTempDir('skill-list-missing')
    try {
      await assert.rejects(
        () => loadSkillList(join(dir, '不存在.json')),
        (err: Error) => /ENOENT/.test(err.message),
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 不是合法 JSON ⇒ 抛，且说明是哪份文件', async () => {
    const dir = await makeTempDir('skill-list-bad-json')
    try {
      await withManifest(dir, '{ 这不是 json', async (path) => {
        await assert.rejects(
          () => loadSkillList(path),
          (err: Error) => /不是合法 JSON/.test(err.message) && err.message.includes(path),
        )
      })
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 顶层格式不对（缺 schema / items 不是数组）⇒ 抛', async () => {
    const dir = await makeTempDir('skill-list-bad-shape')
    try {
      await withManifest(dir, { items: [] }, async (path) => {
        await assert.rejects(() => loadSkillList(path), (err: Error) => /清单格式不对/.test(err.message))
      })
      await withManifest(dir, { schema: SKILL_LIST_SCHEMA, items: 'nope' }, async (path) => {
        await assert.rejects(() => loadSkillList(path), (err: Error) => /清单格式不对/.test(err.message))
      })
    } finally {
      await cleanup(dir)
    }
  })
})

describe('★ 仓库自带的那份清单本身必须是好的', () => {
  /**
   * ★ 这条守卫的是**仓库里那份真文件**：它坏了的话，界面上的「从本地清单安装」
   *   会整个变成一块红字，而这在开发时不会有人注意到（只有真去点那个页签才看得见）。
   */
  test('缺省清单能读出来，而且没有一条是坏的', async () => {
    const result = await loadSkillList(defaultSkillListPath())
    assert.ok(result.entries.length > 0, '自带清单不该是空的')
    assert.deepEqual(result.skipped, [], '自带清单里不该有坏条目')
    for (const e of result.entries) {
      assert.match(e.slug, /^[a-z0-9][a-z0-9-]{0,62}$/, `${e.name} 的 slug 不合法`)
    }
  })
})
