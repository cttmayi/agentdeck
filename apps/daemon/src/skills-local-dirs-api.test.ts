import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { startDaemon, type DaemonHandle } from './server.ts'
import type { Skill } from '@agentdeck/protocol'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 「从本地安装」的**接口层**（扫目录 → 逐条安装 → 出现在列表 → 能挂给智能体）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里证明的是"这条链真的通"，而不只是"扫描算得对"
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者要的是：**扫到 → 装进来 → 在 Skills 页看见 → 在智能体上选中**。四件事各自
 * "看起来对"而中间断了，是最容易漏的那种——所以这里一路量到底，并且钉住最关键的一条：
 * **装完之后正文落在我们自己的 `skillsRoot` 下**（与其它来源完全一致）。
 *
 * ⚠️ 2026-10 之前这里是"勾选目录 ⇒ 自动对账读进库"。那套撤掉了（D73）：扫描只读、
 *    装是显式动作。所以这个文件里**没有**勾选框、没有"取消勾选"、没有"保 id"那些用例。
 */

/**
 * 起一个 daemon，它扫的候选目录由测试自己给（临时目录）。
 *
 * ★ 注入 `skillDirCandidates` 是必须的：内置表指向**真实家目录**（`~/.claude/skills`
 *   这类），依赖跑测机器上真的装着 Claude Code 是不可重复的（与 NFR-T-01 同一类
 *   理由）。生产代码永远不传它。
 */
async function withDaemon<T>(
  fn: (ctx: { url: string; store: DaemonHandle['store']; skillsRoot: string }) => Promise<T>,
  options: { dirs?: Array<{ id: string; path: string }>; skillsRoot?: string } = {},
): Promise<T> {
  const dir = await makeTempDir('skills-local-dirs-api')
  const skillsRoot = options.skillsRoot ?? join(dir, 'skills')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    workRoot: join(dir, 'work'),
    skillsRoot,
    skillDirCandidates: () => options.dirs ?? [],
    backend: {
      key: 'claude',
      protocol: 'stream-json',
      rejectDetectable: true,
      async probe() {
        return { available: false, command: 'claude', cliVersion: null }
      },
      async execute() {
        throw new Error('这个测试不该执行任何 run')
      },
    } as never,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn({ url: d.url, store: d.store, skillsRoot })
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

interface SkillView {
  id: string
  slug: string
  body: string
  description: string | null
  source: string
  sourceRef: string | null
  localDir: string | null
}

interface ScanDir {
  id: string
  path: string
  sourceRef: string
  exists: boolean
  error: string | null
  skills: Array<{
    slug: string
    rel: string
    dir: string
    name: string
    description: string | null
    installed: boolean
  }>
  skipped: Array<{ rel: string; reason: string }>
}

async function listSkills(url: string): Promise<SkillView[]> {
  const res = await fetch(`${url}/api/skills`)
  assert.equal(res.status, 200)
  return ((await res.json()) as { skills: SkillView[] }).skills
}

async function scanDirs(url: string): Promise<ScanDir[]> {
  const res = await fetch(`${url}/api/skills/local-dirs`)
  assert.equal(res.status, 200)
  return ((await res.json()) as { dirs: ScanDir[] }).dirs
}

/** 走「从本地安装」那条路装一条（正是界面点「安装」时发的请求）。 */
async function installFromDir(url: string, dir: ScanDir, skillDir: string, slug: string) {
  const res = await fetch(`${url}/api/skills/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: { kind: 'path', path: skillDir, sourceRef: dir.sourceRef, },
      slug,
    }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 造一个技能目录：`<root>/<rel>/SKILL.md`。 */
async function makeSkillDir(root: string, rel: string): Promise<void> {
  const dir = join(root, rel)
  await mkdir(dir, { recursive: true })
  const name = rel.split('/').pop() ?? rel
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# ${name}\n\n正文。\n`,
    'utf8',
  )
}

async function makeAgent(url: string, body: Record<string, unknown>) {
  const res = await fetch(`${url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instructions: '', runtimeKey: 'claude', ...body }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('★ 从本地安装：扫描', () => {
  test('列出目录里发现的技能（slug / 相对路径 / 说明），一开始都是「未安装」', async () => {
    const root = await makeTempDir('localdirs-scan')
    const other = await makeTempDir('localdirs-scan-other')
    try {
      await makeSkillDir(root, 'browser-use')
      await makeSkillDir(root, '.system/skill-creator')
      await withDaemon(
        async ({ url }) => {
          const dirs = await scanDirs(url)
          assert.deepEqual(
            dirs.map((d) => d.id),
            ['claude', 'other'],
          )
          const claude = dirs[0]!
          assert.equal(claude.path, root)
          assert.equal(claude.exists, true)
          assert.equal(claude.error, null, '目录读得了')
          assert.equal(claude.sourceRef, `localdir:${root}`, '★ 来源标记 = localdir:<根目录>')
          assert.deepEqual(
            claude.skills.map((s) => s.slug).sort(),
            ['browser-use', 'skill-creator'],
            '★ 扁平与嵌套两种形状都要认出来',
          )
          for (const s of claude.skills) {
            assert.equal(s.installed, false, '一个都还没装')
            assert.equal(s.description, `${s.slug} 的说明`, 'frontmatter 里的说明要带出来')
          }
          // 第二个目录是空的
          assert.equal(dirs[1]!.skills.length, 0)
        },
        { dirs: [{ id: 'claude', path: root }, { id: 'other', path: other }] },
      )
    } finally {
      await cleanup(root)
      await cleanup(other)
    }
  })

  test('★ 没有 SKILL.md 的目录**如实报**（"我这儿有，怎么没列出来"要能追到原因）', async () => {
    const root = await makeTempDir('localdirs-skip')
    try {
      await mkdir(join(root, 'baoyu-markdown-to-html'), { recursive: true })
      await makeSkillDir(root, 'real-one')
      await withDaemon(
        async ({ url }) => {
          const [claude] = await scanDirs(url)
          assert.deepEqual(claude!.skills.map((s) => s.slug), ['real-one'])
          assert.equal(claude!.skipped.length, 1, '★ 那个空目录必须说出来')
          assert.match(claude!.skipped[0]!.rel, /baoyu-markdown-to-html/)
          assert.match(claude!.skipped[0]!.reason, /SKILL\.md/)
        },
        { dirs: [{ id: 'claude', path: root }] },
      )
    } finally {
      await cleanup(root)
    }
  })

  test('目录不存在 ⇒ 200，但 `error` + `exists:false` 如实说（不是"里面没有技能"）', async () => {
    await withDaemon(
      async ({ url }) => {
        const [claude] = await scanDirs(url)
        assert.equal(claude!.exists, false)
        assert.match(claude!.error ?? '', /不存在|读不了/)
        assert.deepEqual(claude!.skills, [])
      },
      { dirs: [{ id: 'claude', path: '/绝对不存在的技能目录-xyz' }] },
    )
  })
})

describe('★ 从本地安装：装进来', () => {
  test('★★ 端到端：扫描 → 安装 → 出现在列表 → **正文落在 skillsRoot 下** → 能挂到智能体上', async () => {
    const root = await makeTempDir('localdirs-install')
    try {
      await makeSkillDir(root, 'browser-use')
      await makeSkillDir(root, 'my-helper')
      await withDaemon(
        async ({ url, skillsRoot }) => {
          // ① 扫到两条，都还没装
          const dir = (await scanDirs(url))[0]!
          const target = dir.skills.find((s) => s.slug === 'browser-use')!

          // ② 装一条（界面点「安装」时发的就是这一条）
          const install = await installFromDir(url, dir, target.dir, target.slug)
          assert.equal(install.status, 201, JSON.stringify(install.body))

          // ③ ★★ 正文落在**我们自己的** skillsRoot 下——这是"显式安装"的核心承诺：
          //    装完就是一条普通技能，不再依赖源目录。
          const onDisk = await readFile(join(skillsRoot, 'browser-use', 'SKILL.md'), 'utf8')
          assert.match(onDisk, /正文/)

          // ④ 列表里看得见，带着来源标记
          const skills = await listSkills(url)
          const found = skills.find((s) => s.slug === 'browser-use')!
          assert.equal(found.sourceRef, `localdir:${root}`, '★ 落库的 sourceRef 就是给的 localdir:<根目录>')
          assert.equal(found.localDir, root, '列表据此显示"来自本地技能目录：…"')
          assert.equal(found.source, 'local')

          // ⑤ 再扫一遍：装过的显示「已安装」，没装的还是「未安装」
          const again = (await scanDirs(url))[0]!
          assert.equal(again.skills.find((s) => s.slug === 'browser-use')!.installed, true)
          assert.equal(again.skills.find((s) => s.slug === 'my-helper')!.installed, false)

          // ⑥ ★★ 真把它挂到一个执行者身上——这是使用者要的最后一环
          const agent = await makeAgent(url, {
            name: '执行者',
            role: 'executor',
            skillIds: [found.id],
          })
          assert.equal(agent.status, 201, JSON.stringify(agent.body))
          assert.deepEqual(agent.body['skillIds'], [found.id], '★ 挂上了')
        },
        { dirs: [{ id: 'claude', path: root }] },
      )
    } finally {
      await cleanup(root)
    }
  })

  test('★★ 装完之后**源目录删掉也不影响**（正文在我们自己这儿，不再跟磁盘走）', async () => {
    const root = await makeTempDir('localdirs-source-gone')
    try {
      await makeSkillDir(root, 'standalone')
      await withDaemon(
        async ({ url }) => {
          const dir = (await scanDirs(url))[0]!
          const target = dir.skills[0]!
          assert.equal((await installFromDir(url, dir, target.dir, target.slug)).status, 201)

          // 使用者在 Claude Code 那边把整个技能目录删了
          await cleanup(join(root, 'standalone'))

          // ★ 库里那条照旧可用、正文照旧读得出来——这正是"改成显式安装"要的效果：
          //   以前对账会把这条标成"失效"，现在它是一条独立技能。
          const found = (await listSkills(url)).find((s) => s.slug === 'standalone')!
          assert.ok(found, '★ 源目录没了，技能还在')
          assert.match(found.body, /正文/)

          // 源目录里也确实没有它了
          assert.deepEqual((await scanDirs(url))[0]!.skills, [])
        },
        { dirs: [{ id: 'claude', path: root }] },
      )
    } finally {
      await cleanup(root)
    }
  })
})

describe('★ 列表里的「说明」列', () => {
  /**
   * ★ 旧记录（改动之前装的）在库里 `description` 是 null，而它的 SKILL.md
   *   frontmatter 里其实写着说明。列表接口要**当场补出来**——否则已经装好的
   *   技能永远只显示空那一列，除非使用者把所有技能重装一遍。
   */
  test('★★ 库里 description 为 null 的旧记录，列表接口从 frontmatter 补出来', async () => {
    await withDaemon(async ({ url, store }) => {
      const ws = ((await store.listWorkspaceIds())[0] ?? 'ws_test') as Skill['workspaceId']
      // 直接写一条"旧记录"：body 里有 frontmatter，但 description 是 null
      await store.insertSkill({
        id: 'sk_legacy' as Skill['id'],
        workspaceId: ws,
        slug: 'legacy-skill',
        name: 'legacy-skill',
        description: null,
        body: '---\nname: legacy-skill\ndescription: 老记录里那句说明\n---\n\n正文。\n',
        verdictSchemaVersion: 1,
        source: 'local',
        sourceRef: 'github:owner/repo@main:skills/legacy-skill',
        version: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const found = (await listSkills(url)).find((s) => s.slug === 'legacy-skill')
      assert.ok(found, '这条旧记录应该在列表里')
      assert.equal(found.description, '老记录里那句说明', '★ 库里的 null 不该盖住 frontmatter 里的说明')
      // ★ 只补展示，**不动库**：库里那份仍然是 null（审计是 append-only 的）
      const raw = await store.getSkill('sk_legacy' as Skill['id'])
      assert.equal(raw?.description, null, '列表接口不该顺手改库')
    })
  })

  test('库里有 description 时就用自己的（不从正文覆盖）', async () => {
    await withDaemon(async ({ url, store }) => {
      const ws = ((await store.listWorkspaceIds())[0] ?? 'ws_test') as Skill['workspaceId']
      await store.insertSkill({
        id: 'sk_stored' as Skill['id'],
        workspaceId: ws,
        slug: 'stored-desc',
        name: 'stored-desc',
        description: '库里登记的那句',
        body: '---\nname: stored-desc\ndescription: frontmatter 里那句\n---\n\n正文。\n',
        verdictSchemaVersion: 1,
        source: 'remote',
        sourceRef: 'remote:stored-desc',
        version: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const found = (await listSkills(url)).find((s) => s.slug === 'stored-desc')
      assert.equal(found?.description, '库里登记的那句')
    })
  })
})
