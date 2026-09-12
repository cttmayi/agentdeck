import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import {
  MAX_SKILL_BYTES,
  SkillTooLargeError,
  normalizeSkillFrontmatter,
  skillPath,
  splitFrontmatter,
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
