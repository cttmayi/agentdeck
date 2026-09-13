import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** 临时目录沿用工作区内 `.cache/test-tmp` 的约定（不用系统 tmp：受限沙箱里可能不可写）。 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')
async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`))
}
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
import {
  MAX_SKILL_BYTES,
  SkillTooLargeError,
  normalizeSkillFrontmatter,
  removeInjectedSkills,
  skillPath,
  splitFrontmatter,
  SkillCollisionError,
  listManagedSkills,
  syncInjectedSkills,
} from './skill-injection.ts'

function frontmatterOf(content: string): Record<string, unknown> {
  const { frontmatter } = splitFrontmatter(content)
  assert.notEqual(frontmatter, null)
  return parseYaml(frontmatter!) as Record<string, unknown>
}

describe('frontmatter 拆分', () => {
  test('正常拆分', () => {
    const r = splitFrontmatter('---\nname: a\n---\n正文')
    assert.equal(r.frontmatter, 'name: a')
    assert.equal(r.body, '正文')
  })

  test('没有 frontmatter ⇒ 整段是正文', () => {
    const r = splitFrontmatter('# 标题\n正文')
    assert.equal(r.frontmatter, null)
    assert.equal(r.body, '# 标题\n正文')
  })

  test('★ 有开始无结束 ⇒ 当作没有 frontmatter，不丢内容（与半个块同源）', () => {
    const r = splitFrontmatter('---\nname: a\n正文没有结束标记')
    assert.equal(r.frontmatter, null)
    assert.equal(r.body, '---\nname: a\n正文没有结束标记')
  })

  test('BOM 被剥离', () => {
    const r = splitFrontmatter('\ufeff---\nname: a\n---\nb')
    assert.equal(r.frontmatter, 'name: a')
  })
})

describe('元数据规范化（FR-CLI-20~22）', () => {
  test('slug 是权威名：与作者填的名字不一致时按 slug 改写', () => {
    const r = normalizeSkillFrontmatter('sec-vuln', '---\nname: 安全审计\ndescription: x\n---\n正文')
    assert.equal(frontmatterOf(r.content)['name'], 'sec-vuln')
    assert.ok(r.notes.some((n) => n.includes('按 slug 改写')))
  })

  test('缺少 name ⇒ 注入 slug', () => {
    const r = normalizeSkillFrontmatter('doc-review', '---\ndescription: 只看文档\n---\n正文')
    assert.equal(frontmatterOf(r.content)['name'], 'doc-review')
    assert.ok(r.notes.some((n) => n.includes('缺少 name')))
  })

  test('没有 frontmatter ⇒ 注入最小元数据，正文保留', () => {
    const r = normalizeSkillFrontmatter('my-skill', '# 正文标题\n\n内容')
    assert.equal(frontmatterOf(r.content)['name'], 'my-skill')
    assert.match(r.content, /# 正文标题/)
    assert.ok(r.notes.some((n) => n.includes('没有 frontmatter')))
  })

  test('★ 重建时保留其他键——特别是作者用来隐藏技能的那个（丢了等于重新暴露）', () => {
    const original = [
      '---',
      'name: 旧名字',
      'description: 描述',
      'disable-model-invocation: true',
      'allowed-tools: Read, Grep',
      '---',
      '正文',
    ].join('\n')

    const r = normalizeSkillFrontmatter('hidden-skill', original)
    const meta = frontmatterOf(r.content)

    assert.equal(meta['name'], 'hidden-skill', 'slug 权威')
    assert.equal(meta['disable-model-invocation'], true, '★ 隐藏开关必须保留')
    assert.equal(meta['description'], '描述')
    assert.equal(meta['allowed-tools'], 'Read, Grep')
  })

  test('★ YAML 损坏 ⇒ 重建，且正文不丢', () => {
    const broken = '---\nname: [未闭合\ndescription: : :\n---\n重要的正文内容'
    const r = normalizeSkillFrontmatter('broken-skill', broken)
    assert.equal(frontmatterOf(r.content)['name'], 'broken-skill')
    assert.match(r.content, /重要的正文内容/, '重建后正文必须还在')
    assert.ok(r.notes.some((n) => n.includes('无法解析')))
  })

  test('frontmatter 是数组等非对象 ⇒ 重建', () => {
    const r = normalizeSkillFrontmatter('s', '---\n- a\n- b\n---\n正文')
    assert.equal(frontmatterOf(r.content)['name'], 's')
    assert.match(r.content, /正文/)
  })

  test('★ 用解析器判定而不是词法扫描：`name:` 无值 与 `name: x` 区别对待', () => {
    // 词法扫描会把两者都当成"没名字"，于是注入第二个 name，
    // 而重复键会让严格 YAML 加载器直接拒掉整个技能文件
    const withEmpty = normalizeSkillFrontmatter('s1', '---\nname:\n---\n正文')
    assert.equal(frontmatterOf(withEmpty.content)['name'], 's1')
    assert.equal(countKeys(withEmpty.content, 'name'), 1, '不能出现重复键')

    const withValue = normalizeSkillFrontmatter('s2', '---\nname: 别的\n---\n正文')
    assert.equal(frontmatterOf(withValue.content)['name'], 's2')
    assert.equal(countKeys(withValue.content, 'name'), 1)
  })

  test('name 与 slug 相同 ⇒ 不改动，也不记 note', () => {
    const r = normalizeSkillFrontmatter('same', '---\nname: same\n---\n正文')
    assert.equal(frontmatterOf(r.content)['name'], 'same')
    assert.equal(r.notes.length, 0)
  })

  test('超过大小上限 ⇒ 抛错（FR-CLI-25）', () => {
    const huge = 'x'.repeat(MAX_SKILL_BYTES + 1)
    assert.throws(
      () => normalizeSkillFrontmatter('big', huge),
      (err: unknown) => {
        assert.ok(err instanceof SkillTooLargeError)
        assert.match(err.message, /超过上限/)
        return true
      },
    )
  })

  test('恰好等于上限 ⇒ 允许', () => {
    const body = 'x'.repeat(MAX_SKILL_BYTES - 30)
    assert.doesNotThrow(() => normalizeSkillFrontmatter('edge', body))
  })
})

function countKeys(content: string, key: string): number {
  const { frontmatter } = splitFrontmatter(content)
  if (!frontmatter) return 0
  return frontmatter.split('\n').filter((line) => line.trimStart().startsWith(`${key}:`)).length
}

describe('技能路径', () => {
  test('落在 CLI 原生目录下（靠摆对目录被发现，不靠喂提示词）', () => {
    assert.equal(skillPath('.claude/skills', 'sec-vuln'), '.claude/skills/sec-vuln/SKILL.md')
  })
})

describe('★ 技能在工作目录里的去留：按落盘的归属清单对账', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 三版规则，这里是每一版都要守住的那条底线
   * ══════════════════════════════════════════════════════════════════
   *
   * ① 最早：run 结束就把技能删掉。坏在**删除的依据是进程内的数组**——
   *    daemon 崩溃/被 kill 之后那份记忆就没了，残留的技能文件**会被以后的
   *    run 继续发现**（实测在 `~/.alpha-helper-workspace/run-01M2SANDBOX…`
   *    里就躺着这么一个残留的 `general-review`）。
   * ② 中间：改成保留（使用者的要求）。
   * ③ 现在：**还是收掉**（使用者放弃了保留那条要求），但删除的依据是**落盘
   *    的归属清单**，不是内存——①里危险的那一半已经被清单解决了。
   *
   * 无论哪一版，这里的两条底线不变：
   *   - 清单里记着的、这次不要的 ⇒ 删（自愈崩溃残渣）；
   *   - **不在清单里的同名目录 ⇒ 报错/不碰**（那是使用者自己放的）。
   */
  async function tmp(): Promise<string> {
    const dir = await makeTempDir('skill-sync')
    return dir
  }

  test('★ 同名的使用者技能**绝不被覆盖**，而是明确报错', async () => {
    const dir = await tmp()
    try {
      // 使用者自己放了一个技能（不在清单里）
      await mkdir(join(dir, '.claude', 'skills', 'mine'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', 'mine', 'SKILL.md'), '我的标准', 'utf8')

      await assert.rejects(
        () =>
          syncInjectedSkills(dir, '.claude/skills', [
            { slug: 'mine', content: '# 平台的标准' },
          ]),
        (err: unknown) => err instanceof SkillCollisionError,
        '★ 覆盖使用者的文件比 run 失败糟得多',
      )
      // 他的内容一个字都没变
      assert.equal(
        await readFile(join(dir, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8'),
        '我的标准',
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 摘掉的技能会从工作目录消失（按清单自愈）', async () => {
    const dir = await tmp()
    try {
      await syncInjectedSkills(dir, '.claude/skills', [
        { slug: 'a', content: '# A' },
        { slug: 'b', content: '# B' },
      ])
      assert.deepEqual(await listManagedSkills(dir, '.claude/skills'), ['a', 'b'])

      // 下一次这个 agent 只挂 a 了（b 被摘下）
      const result = await syncInjectedSkills(dir, '.claude/skills', [{ slug: 'a', content: '# A2' }])
      assert.deepEqual(result.pruned, ['b'], '★ 摘掉的必须消失，否则它会被 CLI 继续发现并使用')
      assert.deepEqual(await listManagedSkills(dir, '.claude/skills'), ['a'])

      const entries = await readdir(join(dir, '.claude', 'skills'))
      assert.equal(entries.includes('b'), false)
      assert.equal(entries.includes('a'), true, '仍然挂着的要留着')
      // 内容被更新了（`writeSkill` 会补上 frontmatter，所以看正文即可）
      assert.match(
        await readFile(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), 'utf8'),
        /# A2/,
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 崩溃残渣能自愈：清单里的 slug 下次仍然会被清理', async () => {
    // 模拟"上一次跑完没来得及收拾"：文件在、清单也在
    const dir = await tmp()
    try {
      await syncInjectedSkills(dir, '.claude/skills', [
        { slug: 'leftover', content: '# 残留' },
      ])
      // 这次一个技能都不挂了
      const result = await syncInjectedSkills(dir, '.claude/skills', [])
      assert.deepEqual(result.pruned, ['leftover'])
      assert.deepEqual(await readdir(join(dir, '.claude', 'skills')), ['.alpha-helper-managed.json'])
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 收尾只收清单里记着的：点名一个别人的目录也不会删', async () => {
    const dir = await tmp()
    try {
      await syncInjectedSkills(dir, '.claude/skills', [{ slug: 'ours', content: '# 我们的' }])
      // 使用者自己的（不在清单里）
      await mkdir(join(dir, '.claude', 'skills', 'theirs'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', 'theirs', 'SKILL.md'), '别人的', 'utf8')

      // ⚠️ 故意把别人的名字也点进去：调用方给错名单**不该**造成破坏
      const swept = await removeInjectedSkills(dir, '.claude/skills', ['ours', 'theirs', '../逃逸'])

      assert.deepEqual(swept.removed, ['ours'])
      assert.deepEqual(swept.kept, [])
      assert.equal(
        await readFile(join(dir, '.claude', 'skills', 'theirs', 'SKILL.md'), 'utf8'),
        '别人的',
        '★ 能不能删由**落盘清单**决定，不由调用方给的名单决定',
      )
      // 我们那份收干净了，清单也跟着收掉（空了就没有意义）
      assert.deepEqual(await readdir(join(dir, '.claude', 'skills')), ['theirs'])
    } finally {
      await cleanup(dir)
    }
  })

  test('收尾只删点名的那些：清单里还有别的就留着并更新清单', async () => {
    const dir = await tmp()
    try {
      await syncInjectedSkills(dir, '.claude/skills', [
        { slug: 'a', content: '# A' },
        { slug: 'b', content: '# B' },
      ])
      const swept = await removeInjectedSkills(dir, '.claude/skills', ['a'])
      assert.deepEqual(swept.removed, ['a'])
      assert.deepEqual(swept.kept, ['b'])

      const left = await readdir(join(dir, '.claude', 'skills'))
      assert.ok(left.includes('b') && !left.includes('a'))
      const manifest = JSON.parse(
        await readFile(join(dir, '.claude', 'skills', '.alpha-helper-managed.json'), 'utf8'),
      ) as { slugs: string[] }
      assert.deepEqual(manifest.slugs, ['b'], '★ 清单要跟着更新，否则残留无从识别')
    } finally {
      await cleanup(dir)
    }
  })

  test('没有清单时收尾什么都不做（宁可少删）', async () => {
    const dir = await tmp()
    try {
      await mkdir(join(dir, '.claude', 'skills', 'theirs'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', 'theirs', 'SKILL.md'), '别人的', 'utf8')
      const swept = await removeInjectedSkills(dir, '.claude/skills', ['theirs'])
      assert.deepEqual(swept.removed, [], '★ 没有清单 = 我们什么都没放过 = 一个都不删')
      assert.equal(await readFile(join(dir, '.claude', 'skills', 'theirs', 'SKILL.md'), 'utf8'), '别人的')
    } finally {
      await cleanup(dir)
    }
  })

  test('清单读不懂时**宁可少删**（当作我们什么都没放过）', async () => {
    const dir = await tmp()
    try {
      await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', '.alpha-helper-managed.json'), '{坏掉的 json', 'utf8')
      await mkdir(join(dir, '.claude', 'skills', 'theirs'), { recursive: true })
      await writeFile(join(dir, '.claude', 'skills', 'theirs', 'SKILL.md'), '别人的', 'utf8')

      const result = await syncInjectedSkills(dir, '.claude/skills', [])
      assert.deepEqual(result.pruned, [], '★ 读不懂清单不能成为删东西的理由')
      assert.equal(
        await readFile(join(dir, '.claude', 'skills', 'theirs', 'SKILL.md'), 'utf8'),
        '别人的',
      )
    } finally {
      await cleanup(dir)
    }
  })
})
