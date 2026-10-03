import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { startDaemon, type DaemonHandle } from './server.ts'
import type { Skill } from '@agentdeck/protocol'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 「本地技能目录」的**接口层**（设置里勾选 → 出现在列表 → 能挂给智能体）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 单元测试证明了"对账算得对"，这里证明"这条链真的通"
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者要的是三件事连起来：**勾选 → 在 Skills 页看见 → 在智能体上选中**。
 * 三件事各自"看起来对"而中间断了，是最容易漏的那种——所以这里一路量到底：
 * 勾一个真目录，然后**用同一个 daemon** 把那条 skill 挂到智能体上。
 */

async function withDaemon<T>(
  fn: (url: string, store: DaemonHandle['store']) => Promise<T>,
): Promise<T> {
  const dir = await makeTempDir('local-skill-dirs-api')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    workRoot: join(dir, 'work'),
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
    return await fn(d.url, d.store)
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

interface SkillView {
  id: string
  slug: string
  body: string
  source: string
  sourceRef: string | null
  localDir: string | null
  selectable: boolean
}

async function listSkills(url: string): Promise<{
  skills: SkillView[]
  localDirs: { enabled: string[]; report: Record<string, unknown> }
}> {
  const res = await fetch(`${url}/api/skills`)
  assert.equal(res.status, 200)
  return (await res.json()) as never
}

async function getDirs(url: string) {
  const res = await fetch(`${url}/api/skills/local-dirs`)
  assert.equal(res.status, 200)
  return (await res.json()) as {
    candidates: Array<{ id: string; path: string; exists: boolean; skillCount: number }>
    enabled: string[]
    custom: Array<{ path: string; exists: boolean; skillCount: number; skipped: unknown[] }>
    report: Record<string, unknown>
  }
}

async function putDirs(url: string, dirs: unknown) {
  const res = await fetch(`${url}/api/skills/local-dirs`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dirs }),
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

describe('★ 本地技能目录：勾选 → 看见 → 能挂', () => {
  test('★★ 端到端：勾一个真目录 ⇒ skill 出现在列表，并且**能挂到智能体上**', async () => {
    const root = await makeTempDir('localdirs-real')
    try {
      await makeSkillDir(root, 'browser-use')
      await makeSkillDir(root, 'my-helper')

      await withDaemon(async (url) => {
        // ① 勾上（注意：路径是运行时才知道的，所以这里走"自定义路径"那条路）
        const put = await putDirs(url, [root])
        assert.equal(put.status, 200, JSON.stringify(put.body))
        assert.deepEqual(put.body['enabled'], [root])
        assert.deepEqual((put.body['report'] as { added: string[] }).added, ['browser-use', 'my-helper'])

        // ② 列表里看得见，而且标着来源目录
        const { skills, localDirs } = await listSkills(url)
        assert.deepEqual(skills.map((s) => s.slug).sort(), ['browser-use', 'my-helper'])
        for (const skill of skills) {
          assert.equal(skill.localDir, root, '要说清它是从哪个目录来的')
          assert.equal(skill.selectable, true, '目录还勾着、文件还在 ⇒ 可以选')
          assert.equal(skill.source, 'local')
          // ★ 2026-10：作者写在 SKILL.md frontmatter 里的 description 要落库
          //   （原来恒为 null，列表里那一列永远是空的）
          assert.equal(
            (skill as { description?: string | null }).description,
            `${skill.slug} 的说明`,
          )
        }
        assert.deepEqual(localDirs.enabled, [root])

        // ③ ★★ 真把它挂到一个执行者身上——这是使用者要的最后一环
        const agent = await makeAgent(url, {
          name: '执行者',
          role: 'executor',
          skillIds: [skills[0]!.id],
        })
        assert.equal(agent.status, 201, JSON.stringify(agent.body))
        assert.deepEqual(agent.body['skillIds'], [skills[0]!.id], '★ 挂上了')
      })
    } finally {
      await cleanup(root)
    }
  })

  test('★ 磁盘上改了 ⇒ 下一次读列表就跟着变（磁盘为准），而且 id 不变', async () => {
    const root = await makeTempDir('localdirs-live')
    try {
      await makeSkillDir(root, 'live-skill')
      await withDaemon(async (url) => {
        await putDirs(url, [root])
        const before = (await listSkills(url)).skills[0]!
        assert.match(before.body, /正文/)

        // 使用者在 Claude Code 那边改了正文
        await writeFile(
          join(root, 'live-skill', 'SKILL.md'),
          '---\nname: live-skill\n---\n\n# 改过了\n',
          'utf8',
        )

        const after = (await listSkills(url)).skills[0]!
        assert.match(after.body, /改过了/, '★ 不用手动同步，读列表时就对账')
        assert.equal(after.id, before.id, '★ id 不变，挂载关系才不断')
      })
    } finally {
      await cleanup(root)
    }
  })

  test('★ 空目录会被如实报出来（"我勾了，怎么少一个"要能追到原因）', async () => {
    const root = await makeTempDir('localdirs-skip')
    try {
      await mkdir(join(root, 'baoyu-markdown-to-html'), { recursive: true })
      await makeSkillDir(root, 'real-one')
      await withDaemon(async (url) => {
        const put = await putDirs(url, [root])
        const report = put.body['report'] as {
          added: string[]
          skipped: Array<{ dir: string; rel: string; reason: string }>
        }
        assert.deepEqual(report.added, ['real-one'])
        assert.equal(report.skipped.length, 1, '★ 那个空目录必须说出来')
        assert.match(report.skipped[0]!.rel, /baoyu-markdown-to-html/)
        assert.match(report.skipped[0]!.reason, /SKILL\.md/)
      })
    } finally {
      await cleanup(root)
    }
  })

  test('★ 取消勾选：没人挂着就移出去；**有人挂着就留着**（使用者的原话）', async () => {
    const root = await makeTempDir('localdirs-uncheck')
    try {
      await makeSkillDir(root, 'still-used')
      await makeSkillDir(root, 'not-used')
      await withDaemon(async (url) => {
        await putDirs(url, [root])
        const skills = (await listSkills(url)).skills
        const used = skills.find((s) => s.slug === 'still-used')!

        const agent = await makeAgent(url, {
          name: '执行者',
          role: 'executor',
          skillIds: [used.id],
        })
        assert.equal(agent.status, 201)

        const put = await putDirs(url, [])
        const report = put.body['report'] as {
          removed: string[]
          keptBecauseUsed: Array<{ slug: string; dir: string; usedBy: string[] }>
        }
        assert.deepEqual(report.removed, ['not-used'])
        assert.deepEqual(
          report.keptBecauseUsed.map((k) => k.slug),
          ['still-used'],
          '★ 正在用的那条留着',
        )
        assert.deepEqual(report.keptBecauseUsed[0]!.usedBy, ['执行者'], '而且要说是谁在用')

        // 列表里那条还在，但标成"不再活跃"——界面据此说清为什么它还在
        const after = (await listSkills(url)).skills
        const kept = after.find((s) => s.slug === 'still-used')
        assert.ok(kept, '★ 记录还在 = 那个智能体的能力没被抽走')
        assert.equal(kept.selectable, false, '但它已经不该出现在"可以选"的那一列里')
        assert.deepEqual(after.find((s) => s.slug === 'not-used'), undefined)
      })
    } finally {
      await cleanup(root)
    }
  })

  test('★ 勾选状态存在工作区上（重开页面/换进程都还在）', async () => {
    const root = await makeTempDir('localdirs-persist')
    try {
      await makeSkillDir(root, 'persisted')
      const dataDir = await makeTempDir('localdirs-persist-data')
      const boot = async () =>
        startDaemon({
          dataDir,
          port: 0,
          fsync: false,
          workRoot: join(dataDir, 'work'),
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
        const first = await boot()
        await putDirs(first.url, [root])
        await first.close()

        const second = await boot()
        try {
          assert.deepEqual((await getDirs(second.url)).enabled, [root], '★ 勾选状态要落库')
          assert.deepEqual((await listSkills(second.url)).skills.map((s) => s.slug), ['persisted'])
        } finally {
          await second.close()
        }
      } finally {
        await cleanup(dataDir)
      }
    } finally {
      await cleanup(root)
    }
  })

  test('候选目录：内置表 + 每个目录里现在有几个技能（勾之前就看得见）', async () => {
    await withDaemon(async (url) => {
      const { candidates, enabled, custom } = await getDirs(url)
      assert.deepEqual(
        candidates.map((c) => c.id),
        ['claude', 'codex', 'cursor', 'agents'],
      )
      for (const c of candidates) {
        assert.ok(c.path.startsWith('/'), `${c.id} 应当是绝对路径`)
        assert.equal(typeof c.exists, 'boolean')
        assert.equal(typeof c.skillCount, 'number')
      }
      assert.deepEqual(enabled, [], '新工作区一个都没勾')
      assert.deepEqual(custom, [])
    })
  })

  test('自己填的路径会出现在 custom 里（要能看见、能取消）', async () => {
    const root = await makeTempDir('localdirs-custom')
    try {
      await makeSkillDir(root, 'mine')
      await withDaemon(async (url) => {
        await putDirs(url, [root])
        const { custom, candidates } = await getDirs(url)
        // ★ 自己填的路径也带上"里面几个 skill / 跳过了什么"：勾之前就该看得见
        assert.deepEqual(
          custom.map((c) => c.path),
          [root],
          '不在候选表里的路径要单列出来',
        )
        assert.equal(custom[0]!.skillCount, 1, '里面有一个 skill')
        assert.equal(custom[0]!.exists, true)
        assert.ok(
          !candidates.some((c) => c.path === root),
          '它本来就不该混进内置候选里',
        )
      })
    } finally {
      await cleanup(root)
    }
  })

  test('`~` 会展开成绝对路径（勾选状态按字符串相等匹配，形态必须唯一）', async () => {
    await withDaemon(async (url) => {
      const put = await putDirs(url, ['~/绝对不存在的技能目录-xyz'])
      assert.equal(put.status, 200, JSON.stringify(put.body))
      const enabled = put.body['enabled'] as string[]
      assert.equal(enabled.length, 1)
      assert.ok(enabled[0]!.startsWith('/'), `应当是绝对路径，实际 ${enabled[0]}`)
      assert.ok(!enabled[0]!.startsWith('~'))
    })
  })

  test('参数不对：dirs 不是数组 / 有非字符串项 / 相对路径 —— 都是 400', async () => {
    await withDaemon(async (url) => {
      assert.equal((await putDirs(url, 'x')).status, 400)
      assert.equal((await putDirs(url, [123])).status, 400)
      const relative = await putDirs(url, ['./skills'])
      assert.equal(relative.status, 400)
      assert.match(String(relative.body['error']), /绝对路径/)
    })
  })

  test('目录不存在 ⇒ 允许勾（可能还没建），但列表里读不到东西，也不是错误', async () => {
    await withDaemon(async (url) => {
      const put = await putDirs(url, ['/绝对不存在的技能目录-xyz'])
      assert.equal(put.status, 200, '★ 拒绝它会让使用者连"我勾了但目录不在"都看不到')
      const report = put.body['report'] as { dirErrors: Array<{ dir: string; reason: string }> }
      assert.equal(report.dirErrors.length, 1, '但要如实说这个目录读不了')
      assert.deepEqual((await listSkills(url)).skills, [])
    })
  })

  test('★ 手装的 skill 不会被对账碰掉', async () => {
    const root = await makeTempDir('localdirs-handmade')
    try {
      await makeSkillDir(root, 'from-dir')
      await withDaemon(async (url) => {
        // 先用老办法手装一条（source.kind = path）
        const install = await fetch(`${url}/api/skills/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // ⚠️ 这条老路子要的是**一个技能目录**（里面直接有 SKILL.md），
          //    不是装着技能目录的父目录——与"勾选一个目录"是两件事
          body: JSON.stringify({ source: { kind: 'path', path: join(root, 'from-dir') } }),
        })
        assert.equal(install.status, 201, await install.text())

        await putDirs(url, [])
        await listSkills(url)
        const skills = (await listSkills(url)).skills
        const slugs = skills.map((s) => s.slug)
        assert.ok(slugs.includes('from-dir'), '★ 对账顺手删掉别人的东西是最难查的那种事故')
        // ★ 2026-10：从路径装的那条也要带上 frontmatter 里的说明
        assert.equal(
          (skills.find((s) => s.slug === 'from-dir') as { description?: string | null })
            .description,
          'from-dir 的说明',
        )
      })
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
    await withDaemon(async (url, store) => {
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

      const found = (await listSkills(url)).skills.find((s) => s.slug === 'legacy-skill')
      assert.ok(found, '这条旧记录应该在列表里')
      assert.equal(
        (found as { description?: string | null }).description,
        '老记录里那句说明',
        '★ 库里的 null 不该盖住作者写在 frontmatter 里的说明',
      )
      // ★ 只补展示，**不动库**：库里那份仍然是 null（审计是 append-only 的）
      const raw = await store.getSkill('sk_legacy' as Skill['id'])
      assert.equal(raw?.description, null, '列表接口不该顺手改库')
    })
  })

  test('库里有 description 时就用自己的（不从正文覆盖）', async () => {
    await withDaemon(async (url, store) => {
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
      const found = (await listSkills(url)).skills.find((s) => s.slug === 'stored-desc')
      assert.equal((found as { description?: string | null }).description, '库里登记的那句')
    })
  })
})
