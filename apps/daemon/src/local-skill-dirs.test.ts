import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { Skill, WorkspaceId } from '@agentdeck/protocol'
import {
  LOCAL_DIR_SOURCE_PREFIX,
  localSkillDirCandidates,
  scanSkillDir,
  sourceDirOf,
} from './local-skill-dirs.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 「本地技能目录」——**只扫，不读**（供「从本地安装」页签列出可装的技能）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件盯的是"认得出真实形状"
 * ══════════════════════════════════════════════════════════════════
 *
 * 实测这台机器上 `~/.claude/skills` 是扁平的 `<slug>/SKILL.md`，而
 * `~/.codex/skills` 底下多一层 `.system/<slug>/SKILL.md`。只认一种形状的实现会在
 * 另一台上**静默地少列一半**——而那看起来像"我明明有，怎么没列出来"。
 *
 * ⚠️ 曾经这里还盯另外两件事（对账：内容没变就不写库 / 取消勾选不抽走能力）。
 *    那套随"本地技能目录改成**显式安装**"整块撤掉了（D73）：本模块现在只剩
 *    「扫目录 → 列出技能」，装不装由使用者在页签里一条条点（走安装那条路）。
 */

const WS = 'ws-localdirs' as WorkspaceId

/** 造一个技能目录：`<root>/<rel>/SKILL.md`（+ 可选的支持文件）。 */
async function makeSkillDir(
  root: string,
  rel: string,
  options: { name?: string; extra?: Record<string, string> } = {},
): Promise<string> {
  const dir = join(root, rel)
  await mkdir(dir, { recursive: true })
  const name = options.name ?? (rel.split('/').pop() ?? rel)
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# ${name}\n\n正文。\n`,
    'utf8',
  )
  for (const [path, content] of Object.entries(options.extra ?? {})) {
    const full = join(dir, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

function existingRecord(input: { id: string; slug: string; dir: string; body: string }): Skill {
  return {
    id: input.id as Skill['id'],
    workspaceId: WS,
    slug: input.slug,
    name: input.slug,
    description: null,
    body: input.body,
    verdictSchemaVersion: 1,
    source: 'local',
    sourceRef: `${LOCAL_DIR_SOURCE_PREFIX}${input.dir}`,
    version: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('★ 扫描：认得出真实存在的两种形状', () => {
  test('★ 扁平形状（claude / cursor）：`<slug>/SKILL.md`', async () => {
    const root = await makeTempDir('scandir-flat')
    try {
      await makeSkillDir(root, 'browser-use')
      await makeSkillDir(root, 'another-one')
      const scan = await scanSkillDir(root)
      assert.equal(scan.error, null)
      assert.deepEqual(
        scan.found.map((f) => f.rel).sort(),
        ['another-one', 'browser-use'],
        '两个技能目录都要认出来',
      )
      assert.deepEqual(scan.found.map((f) => f.depth), [1, 1], '它们是根目录的直接子目录（第 1 层）')
    } finally {
      await cleanup(root)
    }
  })

  test('★ 嵌套形状（codex）：`.system/<slug>/SKILL.md` —— 实测 ~/.codex/skills 就是这样', async () => {
    const root = await makeTempDir('scandir-nested')
    try {
      await makeSkillDir(root, '.system/skill-creator')
      await makeSkillDir(root, '.system/plugin-creator')
      // 也允许同时有扁平的（用户自己放的）
      await makeSkillDir(root, 'my-own')
      const scan = await scanSkillDir(root)
      assert.deepEqual(
        scan.found.map((f) => f.rel).sort(),
        ['.system/plugin-creator', '.system/skill-creator', 'my-own'],
        '★ 多一层分组目录也要认——只认扁平形状的实现会在这里少列两个',
      )
    } finally {
      await cleanup(root)
    }
  })

  test('★ 没有 SKILL.md 的目录**不是技能**，而且必须如实报出来', async () => {
    const root = await makeTempDir('scandir-empty')
    try {
      // 实测 ~/.claude/skills 里就有一个这样的空目录
      await mkdir(join(root, 'baoyu-markdown-to-html'), { recursive: true })
      await makeSkillDir(root, 'real-one')
      const scan = await scanSkillDir(root)
      assert.deepEqual(scan.found.map((f) => f.rel), ['real-one'])
      assert.equal(scan.skipped.length, 1, '★ 那个空目录要说出来')
      assert.match(scan.skipped[0]!.rel, /baoyu-markdown-to-html/)
      assert.match(scan.skipped[0]!.reason, /SKILL\.md/, '理由必须说清是"这里没有 SKILL.md"')
    } finally {
      await cleanup(root)
    }
  })

  test('★ 技能**内部**的 SKILL.md 不算第二个技能（认到有 SKILL.md 就停）', async () => {
    const root = await makeTempDir('scandir-inner')
    try {
      await makeSkillDir(root, 'outer', {
        extra: { 'references/SKILL.md': '# 这不是一个技能\n' },
      })
      const scan = await scanSkillDir(root)
      assert.deepEqual(scan.found.map((f) => f.rel), ['outer'], '★ 只算一个')
    } finally {
      await cleanup(root)
    }
  })

  test('版本库 / 依赖目录直接跳过', async () => {
    const root = await makeTempDir('scandir-skip')
    try {
      await makeSkillDir(root, 'node_modules/evil')
      await makeSkillDir(root, '.git/hooks/evil')
      await makeSkillDir(root, 'good')
      const scan = await scanSkillDir(root)
      assert.deepEqual(scan.found.map((f) => f.rel), ['good'])
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 符号链接：不跟随，但**必须报出来**（实测 ~/.claude/skills 里就有一个）', async () => {
    const root = await makeTempDir('scandir-symlink')
    const outside = await makeTempDir('scandir-outside')
    try {
      await makeSkillDir(outside, 'shared-skill')
      await makeSkillDir(root, 'real-one')
      // 指向另一个目录里的技能：这是"在多个工具之间共用一份 skill"的常见做法
      await symlink(join(outside, 'shared-skill'), join(root, 'linked-skill'), 'dir')
      // 悬空的链接（实测那个就是这样：目标目录已经被删了）
      await symlink(join(outside, 'not-there'), join(root, 'dangling'), 'dir')

      const scan = await scanSkillDir(root)
      assert.deepEqual(scan.found.map((f) => f.rel), ['real-one'], '★ 链接不跟随')
      assert.deepEqual(
        scan.skipped.map((k) => k.rel).sort(),
        ['dangling', 'linked-skill'],
        '★ 但两个链接都要说出来——静默跳过会让"里面 1 个"与 Finder 里的两个对不上',
      )
      for (const k of scan.skipped) assert.match(k.reason, /符号链接/)
    } finally {
      await cleanup(root)
      await cleanup(outside)
    }
  })

  test('目录不存在 ⇒ 如实报错，不是"里面没有技能"', async () => {
    const root = await makeTempDir('scandir-missing')
    try {
      const scan = await scanSkillDir(join(root, '没有这个目录'))
      assert.match(scan.error ?? '', /不存在|读不了/)
      assert.deepEqual(scan.found, [])
    } finally {
      await cleanup(root)
    }
  })
})

describe('★ 内置候选目录', () => {
  test('绝对路径，且 id 稳定', () => {
    const list = localSkillDirCandidates('/home/tester')
    assert.deepEqual(
      list.map((c) => c.id),
      ['claude', 'codex', 'cursor', 'agents'],
    )
    for (const c of list) {
      assert.ok(c.path.startsWith('/home/tester/'), `${c.id} 应当是绝对路径`)
    }
  })
})

describe('★ sourceDirOf：只认自己写的那个前缀', () => {
  test('认 `localdir:`，别的（path: / remote: / null）一律 null', () => {
    assert.equal(sourceDirOf(existingRecord({ id: 'a', slug: 'a', dir: '/x', body: '' })), '/x')
    assert.equal(
      sourceDirOf({ ...existingRecord({ id: 'b', slug: 'b', dir: '/x', body: '' }), sourceRef: 'path:/x' }),
      null,
    )
    assert.equal(
      sourceDirOf({ ...existingRecord({ id: 'c', slug: 'c', dir: '/x', body: '' }), sourceRef: null }),
      null,
    )
  })
})
