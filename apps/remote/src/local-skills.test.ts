import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  LocalSkillConflict,
  describeInstallError,
  installLocalSkill,
  listLocalSkills,
  uninstallLocalSkill,
} from './local-skills.ts'

/**
 * 远端目录的**本地层**（手动装的技能，D52）。
 *
 * 这一层的存在理由是一个具体的坏法：同步目录归同步工具**独占**（整目录原子替换），
 * 手动往里塞一条，下次同步就**静默**没了。所以这里钉两件事：
 *   ① 它写在**另一个目录**、有自己的索引；
 *   ② 装之前**先看两层有没有同名**（撞名一律拒绝，不覆盖）。
 *
 * ⚠️ 不联网（NFR-T-01）：用一个按协议假装的假 GitHub（contents + raw）。
 */
function fakeGithub(files: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const contents = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/(.*?)(?:\?|$)/.exec(url)
    if (contents) {
      const dir = contents[1] ?? ''
      const entries = Object.keys(files)
        .filter((p) => (dir === '' ? true : p.startsWith(`${dir}/`)))
        .filter((p) => !(dir === '' ? p : p.slice(dir.length + 1)).includes('/'))
        .map((p) => ({
          name: p.split('/').pop(),
          path: p,
          type: 'file',
          size: Buffer.byteLength(files[p]!, 'utf8'),
          download_url: `https://raw.githubusercontent.com/o/r/main/${p}`,
        }))
      return new Response(JSON.stringify(entries), { status: 200 })
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.*)$/.exec(url)
    if (raw) {
      const content = files[raw[1]!]
      if (content === undefined) return new Response('no', { status: 404 })
      return new Response(content, { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
}

describe('远端目录：手动装的技能（本地层）', () => {
  test('★ 装一条：文件落进本地层、索引里标 `manual`，且**不碰同步目录**', async () => {
    const root = await makeTempDir('local-skills')
    const syncedDir = join(root, 'catalog-skills')
    const localDir = join(root, 'catalog-skills-local')
    try {
      // 同步目录里先有一条（用来证明这条不碰它）
      await writeFile(join(root, 'placeholder'), '', 'utf8')

      const fetchImpl = fakeGithub({
        'skills/foo/SKILL.md': '---\nname: foo\n---\n\n正文',
        'skills/foo/extra.md': '补充',
      })
      const item = await installLocalSkill(localDir, {
        url: 'https://github.com/o/r/tree/main/skills/foo',
        name: '示例技能',
        summary: '一句话',
        needs: '还得配个 key',
        takenSlugs: new Set(),
        fetchImpl,
      })

      assert.equal(item.slug, 'foo')
      assert.equal(item.manual, true)
      assert.equal(item.sourceRef, 'github:o/r@main:skills/foo')
      assert.deepEqual(item.files.sort(), ['SKILL.md', 'extra.md'])
      assert.equal(item.version, null, '手动装的不编版本号（界面会如实说"无法判断"）')
      assert.equal(item.needs, '还得配个 key')

      // 内容真的落盘（含支持文件——缺了它技能是坏的，而且坏得很安静）
      assert.equal(await readFile(join(localDir, 'foo', 'SKILL.md'), 'utf8'), '---\nname: foo\n---\n\n正文')
      assert.equal(await readFile(join(localDir, 'foo', 'extra.md'), 'utf8'), '补充')

      // 索引：条目 + manual 标记
      const index = JSON.parse(await readFile(join(localDir, '.sync.json'), 'utf8')) as {
        items: Array<{ slug: string; manual: boolean }>
      }
      assert.equal(index.items.length, 1)
      assert.equal(index.items[0]!.slug, 'foo')
      assert.equal(index.items[0]!.manual, true)

      // ★ 同步目录**一个字都没动**
      assert.deepEqual(await readdir(syncedDir).catch(() => []), [], '本地装的不许碰同步目录')
      assert.deepEqual((await listLocalSkills(localDir)).map((i) => i.slug), ['foo'])
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 撞名一律拒绝（同步目录里已有的也算），不覆盖', async () => {
    const root = await makeTempDir('local-skills-conflict')
    const localDir = join(root, 'catalog-skills-local')
    try {
      const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
      // 「同步目录里已经有了」这种情况由调用方把 slug 传进来（`takenSlugs`）
      await assert.rejects(
        () =>
          installLocalSkill(localDir, {
            url: 'https://github.com/o/r/tree/main/skills/foo',
            takenSlugs: new Set(['foo']),
            fetchImpl,
          }),
        (err: unknown) => {
          assert.ok(err instanceof LocalSkillConflict)
          assert.equal(err.slug, 'foo')
          return true
        },
      )
      // 被拒绝时**什么都不该留下**
      assert.deepEqual(await readdir(localDir).catch(() => []), [])
    } finally {
      await cleanup(root)
    }
  })

  test('★ 卸一条：目录与索引一起清掉；不存在时返回 false（调用方回 404）', async () => {
    const root = await makeTempDir('local-skills-remove')
    const localDir = join(root, 'catalog-skills-local')
    try {
      const fetchImpl = fakeGithub({ 'skills/foo/SKILL.md': '# 正文' })
      await installLocalSkill(localDir, {
        url: 'https://github.com/o/r/tree/main/skills/foo',
        takenSlugs: new Set(),
        fetchImpl,
      })
      assert.equal(await uninstallLocalSkill(localDir, 'foo'), true)
      assert.deepEqual(await readdir(localDir), ['.sync.json'], '内容清掉、索引留着（空是真话）')
      assert.deepEqual((await listLocalSkills(localDir)).map((i) => i.slug), [])
      assert.equal(await uninstallLocalSkill(localDir, 'foo'), false, '再删一次是 false，不是抛')
    } finally {
      await cleanup(root)
    }
  })

  test('★ 取包失败的原话要说出来（含 detail：为什么装不上是唯一能行动的信息）', async () => {
    const root = await makeTempDir('local-skills-bad')
    const localDir = join(root, 'catalog-skills-local')
    try {
      // 目标目录里没有 SKILL.md ⇒ 取包规则会拒绝（与 daemon 装技能同一套）
      const fetchImpl = fakeGithub({ 'skills/foo/readme.md': '不是技能' })
      await assert.rejects(
        () =>
          installLocalSkill(localDir, {
            url: 'https://github.com/o/r/tree/main/skills/foo',
            takenSlugs: new Set(),
            fetchImpl,
          }),
        (err: unknown) => {
          const text = describeInstallError(err)
          assert.match(text, /SKILL\.md/)
          return true
        },
      )
    } finally {
      await cleanup(root)
    }
  })
})
