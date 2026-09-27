import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { Skill, WorkspaceId } from '@agentdeck/protocol'
import {
  LOCAL_DIR_SOURCE_PREFIX,
  localSkillDirCandidates,
  normalizeSkillDir,
  reconcileLocalSkillDirs,
  scanSkillDir,
  sourceDirOf,
} from './local-skill-dirs.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 「本地技能目录」（把别的 AI 工具那儿的 skill 读进来）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件盯的是三件事，每件都有具体的坏结果撑着
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. **认得出真实形状**。实测这台机器上 `~/.claude/skills` 是扁平的
 *    `<slug>/SKILL.md`，而 `~/.codex/skills` 底下多一层 `.system/<slug>/SKILL.md`。
 *    只认一种形状的实现会在另一台上**静默地少读一半**——而那看起来像
 *    "我明明勾了，怎么没有"。
 * 2. **内容没变就不写库**。技能库是 append-only 的 JSONL：判成"变了"会让日志
 *    以"每次读列表一条"的速度长起来。这条用"写了几次"直接量。
 * 3. **取消勾选不抽走正在用的能力**（使用者的原话：「勾选仅仅表示可以被选择的
 *    时候看见。智能体已经被使用的 skill 不会移除」）。
 */

const WS = 'ws-localdirs' as WorkspaceId

/** 一个最小可用的技能库（只用得到本模块调的那四个方法）。 */
function makeStore(initial: Skill[] = []) {
  const skills = new Map(initial.map((s) => [s.id as string, s]))
  const agents: Array<{ id: string; name: string; skillIds: string[] }> = []
  let writes = 0
  return {
    agents,
    get writes() {
      return writes
    },
    all: () => [...skills.values()],
    bySlug: (slug: string) => [...skills.values()].filter((s) => s.slug === slug),
    api: {
      async listSkills(): Promise<Skill[]> {
        return [...skills.values()]
      },
      async listAgents() {
        return agents
      },
      async insertSkill(skill: Skill): Promise<void> {
        writes++
        skills.set(skill.id as string, skill)
      },
      async deleteSkill(id: Skill['id']): Promise<boolean> {
        writes++
        return skills.delete(id as string)
      },
    },
  }
}

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

function existingRecord(input: {
  id: string
  slug: string
  dir: string
  body: string
  files?: Record<string, string>
  createdAt?: number
}): Skill {
  return {
    id: input.id as Skill['id'],
    workspaceId: WS,
    slug: input.slug,
    name: input.slug,
    description: null,
    body: input.body,
    ...(input.files ? { files: input.files } : {}),
    verdictSchemaVersion: 1,
    source: 'local',
    sourceRef: `${LOCAL_DIR_SOURCE_PREFIX}${input.dir}`,
    version: null,
    createdAt: input.createdAt ?? 1,
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
        '★ 多一层分组目录也要认——只认扁平形状的实现会在这里少读两个',
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

describe('★ 路径校验：只校验形状，不要求现在存在', () => {
  test('相对路径被拒，并说清为什么', () => {
    const bad = normalizeSkillDir('./skills')
    assert.equal(bad.ok, false)
    assert.match(bad.ok === false ? bad.error : '', /绝对路径/)
  })

  test('`~` 展开成绝对路径（勾选状态按字符串相等匹配，所以形态必须唯一）', () => {
    const ok = normalizeSkillDir('~/.claude/skills', '/home/tester')
    assert.deepEqual(ok, { ok: true, path: '/home/tester/.claude/skills' })
  })

  test('不存在的目录**允许**勾选（可能还没建，或外置盘没挂上）', () => {
    const ok = normalizeSkillDir('/tmp/绝对不存在的技能目录-xyz', '/home/tester')
    assert.equal(ok.ok, true, '★ 拒绝它会让使用者连"我勾了这个但目录不在"都看不到')
  })

  test('内置候选是绝对路径，且 id 稳定', () => {
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

describe('★ 对账：磁盘为准', () => {
  test('★ 新目录里的技能被读进来，sourceRef 记着来源目录', async () => {
    const root = await makeTempDir('recon-add')
    try {
      await makeSkillDir(root, 'browser-use')
      const store = makeStore()
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 100,
      })
      assert.deepEqual(report.added, ['browser-use'])
      const [skill] = store.bySlug('browser-use')
      assert.ok(skill, '库里必须真的有了')
      assert.equal(skill.source, 'local')
      assert.equal(skill.sourceRef, `${LOCAL_DIR_SOURCE_PREFIX}${root}`)
      assert.equal(skill.workspaceId, WS, '★ workspaceId 必须是调用方给的那个')
      assert.match(skill.body, /browser-use/)
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 内容没变就**一个字都不写**（append-only 日志，判错会让它每次翻页长一条）', async () => {
    const root = await makeTempDir('recon-nowrite')
    try {
      await makeSkillDir(root, 'browser-use')
      const store = makeStore()
      await reconcileLocalSkillDirs({ store: store.api, workspaceId: WS, enabledDirs: [root], now: 100 })
      const afterFirst = store.writes
      const idBefore = store.bySlug('browser-use')[0]!.id

      const second = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 200,
      })
      assert.deepEqual(second.added, [])
      assert.deepEqual(second.updated, [])
      assert.equal(store.writes, afterFirst, '★ 第二次对账一次库都不该写')
      assert.equal(store.bySlug('browser-use')[0]!.id, idBefore)
      assert.equal(
        store.bySlug('browser-use')[0]!.updatedAt,
        100,
        '★ updatedAt 也不该动——界面上的"更新时间"会因此骗人',
      )
    } finally {
      await cleanup(root)
    }
  })

  test('★ 磁盘上改了内容 ⇒ 更新，但 **id 与 createdAt 不变**（挂载关系不能断）', async () => {
    const root = await makeTempDir('recon-update')
    try {
      await makeSkillDir(root, 'browser-use')
      const store = makeStore()
      await reconcileLocalSkillDirs({ store: store.api, workspaceId: WS, enabledDirs: [root], now: 100 })
      const before = store.bySlug('browser-use')[0]!
      store.agents.push({ id: 'ag-1', name: '执行者', skillIds: [before.id as string] })

      // 使用者在 Claude Code 那边改了正文
      await writeFile(
        join(root, 'browser-use', 'SKILL.md'),
        '---\nname: browser-use\ndescription: 改了\n---\n\n# 新正文\n',
        'utf8',
      )
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 300,
      })
      assert.deepEqual(report.updated, ['browser-use'])
      const after = store.bySlug('browser-use')[0]!
      assert.match(after.body, /新正文/)
      assert.equal(after.id, before.id, '★ id 一变，挂着它的智能体就指着一条不存在的记录')
      assert.equal(after.createdAt, before.createdAt)
      assert.equal(after.updatedAt, 300)
      assert.equal(store.bySlug('browser-use').length, 1, '不能变成两条')
    } finally {
      await cleanup(root)
    }
  })

  test('支持文件跟着一起变（不是只有正文）', async () => {
    const root = await makeTempDir('recon-files')
    try {
      await makeSkillDir(root, 'with-files', { extra: { 'references/a.md': '第一版' } })
      const store = makeStore()
      await reconcileLocalSkillDirs({ store: store.api, workspaceId: WS, enabledDirs: [root], now: 100 })
      assert.equal(store.bySlug('with-files')[0]!.files?.['references/a.md'], '第一版')

      await writeFile(join(root, 'with-files', 'references/a.md'), '第二版', 'utf8')
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 200,
      })
      assert.deepEqual(report.updated, ['with-files'])
      assert.equal(store.bySlug('with-files')[0]!.files?.['references/a.md'], '第二版')
    } finally {
      await cleanup(root)
    }
  })

  test('★ 磁盘上删了、没人挂着 ⇒ 从库里删掉', async () => {
    const root = await makeTempDir('recon-remove')
    try {
      await makeSkillDir(root, 'gone-soon')
      const store = makeStore()
      await reconcileLocalSkillDirs({ store: store.api, workspaceId: WS, enabledDirs: [root], now: 100 })

      await cleanup(join(root, 'gone-soon'))
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 200,
      })
      assert.deepEqual(report.removed, ['gone-soon'])
      assert.deepEqual(store.bySlug('gone-soon'), [])
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 取消勾选：没人挂着就删掉，**有人挂着就留着**（使用者的原话）', async () => {
    const root = await makeTempDir('recon-uncheck')
    try {
      await makeSkillDir(root, 'still-used')
      await makeSkillDir(root, 'not-used')
      const store = makeStore()
      await reconcileLocalSkillDirs({ store: store.api, workspaceId: WS, enabledDirs: [root], now: 100 })
      const used = store.bySlug('still-used')[0]!
      store.agents.push({ id: 'ag-1', name: '助手', skillIds: [used.id as string] })

      // 取消勾选（enabledDirs 变空）
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [],
        now: 200,
      })
      assert.deepEqual(report.removed, ['not-used'], '没人用的那条移出去')
      assert.deepEqual(
        report.keptBecauseUsed.map((k) => k.slug),
        ['still-used'],
        '★ 正在用的那条留着',
      )
      assert.deepEqual(report.keptBecauseUsed[0]!.usedBy, ['助手'], '而且要说是谁在用')
      assert.equal(store.bySlug('still-used').length, 1, '★ 留着 = 记录还在，能力没被抽走')
      assert.deepEqual(store.bySlug('not-used'), [])
    } finally {
      await cleanup(root)
    }
  })

  test('★ 手装的（`path:`）与远端的（`remote:`）记录**一律不碰**', async () => {
    const root = await makeTempDir('recon-others')
    try {
      await makeSkillDir(root, 'from-dir')
      const handMade: Skill = {
        ...existingRecord({ id: 'skill-hand', slug: 'hand-made', dir: '/别处', body: '# 手装的' }),
        sourceRef: 'path:/Users/someone/my-skill',
        source: 'local',
      }
      const fromRemote: Skill = {
        ...existingRecord({ id: 'skill-remote', slug: 'remote-one', dir: '/别处', body: '# 远端的' }),
        sourceRef: 'remote:general-review@1.0.0',
        source: 'remote',
        version: '1.0.0',
      }
      const store = makeStore([handMade, fromRemote])
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 100,
      })
      assert.deepEqual(report.removed, [], '★ 对账顺手删掉别人的东西是最难查的那种事故')
      assert.equal(store.bySlug('hand-made').length, 1)
      assert.equal(store.bySlug('remote-one').length, 1)
      assert.deepEqual(report.added, ['from-dir'])
    } finally {
      await cleanup(root)
    }
  })

  test('★ 同名冲突：库里已有一条手装的同 slug ⇒ 不抢，并说清是谁挡着', async () => {
    const root = await makeTempDir('recon-clash')
    try {
      await makeSkillDir(root, 'same-slug')
      const handMade: Skill = {
        ...existingRecord({ id: 'skill-hand', slug: 'same-slug', dir: '/别处', body: '# 手装的' }),
        sourceRef: 'path:/Users/someone/same-slug',
      }
      const store = makeStore([handMade])
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 100,
      })
      assert.deepEqual(report.added, [])
      assert.equal(store.bySlug('same-slug').length, 1, '不能变成两条')
      assert.equal(report.failed.length, 1)
      assert.match(report.failed[0]!.reason, /同名/)
      assert.match(report.failed[0]!.reason, /path:/)
    } finally {
      await cleanup(root)
    }
  })

  test('读不进来的技能**如实报**，不静默跳过（"勾了却少一个"要能追到原因）', async () => {
    const root = await makeTempDir('recon-fail')
    try {
      // 超过 MAX_SKILL_BYTES（256KB）的 SKILL.md
      const dir = join(root, 'too-big')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `---\nname: too-big\n---\n${'x'.repeat(300 * 1024)}`, 'utf8')
      const store = makeStore()
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [root],
        now: 100,
      })
      assert.deepEqual(report.added, [])
      assert.equal(report.failed.length, 1)
      assert.match(report.failed[0]!.reason, /256|大小|KB|超/, '理由要说清是"太大"')
    } finally {
      await cleanup(root)
    }
  })

  test('目录读不了 ⇒ 进 dirErrors，不是"这个目录里没有技能"', async () => {
    const store = makeStore()
    const report = await reconcileLocalSkillDirs({
      store: store.api,
      workspaceId: WS,
      enabledDirs: ['/绝对不存在的目录-xyz'],
      now: 100,
    })
    assert.equal(report.dirErrors.length, 1)
    assert.equal(report.dirErrors[0]!.dir, '/绝对不存在的目录-xyz')
  })

  test('两个来源目录里有同名 skill ⇒ 两条各归各的来源（互相当成对方的"没变"）', async () => {
    const rootA = await makeTempDir('recon-two-a')
    const rootB = await makeTempDir('recon-two-b')
    try {
      await makeSkillDir(rootA, 'shared', { name: 'shared' })
      await makeSkillDir(rootB, 'shared', { name: 'shared' })
      const store = makeStore()
      const report = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [rootA, rootB],
        now: 100,
      })
      assert.equal(report.added.length, 2, '两个目录各一条')
      const refs = store.bySlug('shared').map((s) => s.sourceRef).sort()
      assert.deepEqual(refs, [
        `${LOCAL_DIR_SOURCE_PREFIX}${rootA}`,
        `${LOCAL_DIR_SOURCE_PREFIX}${rootB}`,
      ])
      // 再对一次账：两条都该判成"没变"，一次库都不写
      const before = store.writes
      const again = await reconcileLocalSkillDirs({
        store: store.api,
        workspaceId: WS,
        enabledDirs: [rootA, rootB],
        now: 200,
      })
      assert.deepEqual([again.added, again.updated, again.removed], [[], [], []])
      assert.equal(store.writes, before, '★ 两条记录不能互相被当成对方的新版本')
    } finally {
      await cleanup(rootA)
      await cleanup(rootB)
    }
  })

  test('sourceDirOf：只认自己写的那个前缀', () => {
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
