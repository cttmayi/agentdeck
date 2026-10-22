/**
 * 起草产出的读取与校验（2026-10-19 四轮）+ 内置写作技能。
 *
 * 覆盖四条最容易回归的语义：
 *   · 多文件目录 → `mode: 'files'`，SKILL.md 的 frontmatter 拆成 name/description
 *   · 目录为空 → 回退文本（`mode: 'text'`），不当成"有多文件"
 *   · 起草者写了 REFUSED.md → `mode: 'refused'`（结论，不是失败）
 *   · 校验能指出**具体哪个文件**缺什么（界面要定位，不是只给一句"不合法"）
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assembleArtifacts,
  hashDraftDir,
  hashDraftFiles,
  isSafeDraftRelPath,
  parseSkillMd,
  readAuditStamp,
  readDraftSkillDir,
  validateArtifactFiles,
  writeAuditStamp,
  writeDraftSkillFiles,
} from './crystallize-artifacts.ts'
import { loadBuiltinSkill, WRITING_SKILLS } from './builtin-skills.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string

before(async () => {
  dir = await makeTempDir('crystallize-artifacts')
})

after(async () => {
  await cleanup(dir)
})

/**
 * 人改草稿这条路（2026-10-21 分批第 8 批）。
 *
 * 覆盖三类：**路径守卫**（不许写出 `skill/` 之外）、**只写不删**（保存不是"整目录替换"）、
 * **指纹**（内容变没变判得准，且两组不同文件不许撞同一个指纹）。
 */
describe('人改草稿：写回、路径守卫、指纹', () => {
  test('★ 路径守卫：`..` / 绝对路径 / 反斜杠 / 空段一律不安全', () => {
    for (const bad of [
      '../x.md',
      'a/../../x.md',
      '/etc/passwd',
      'C:\\x.md',
      'a\\\\b.md',
      'a//b.md',
      '',
      './a.md',
      'a/./b.md',
    ]) {
      assert.equal(isSafeDraftRelPath(bad), false, `${JSON.stringify(bad)} 应该被拒`)
    }
    for (const good of ['SKILL.md', 'references/notes.md', 'scripts/check-inline-js.js']) {
      assert.equal(isSafeDraftRelPath(good), true, `${JSON.stringify(good)} 应该放行`)
    }
  })

  test('★ 有任何一个路径不安全 ⇒ 整单拒绝，一个文件都不写', async () => {
    const hut = join(dir, 'hut-reject')
    const skillDir = join(hut, 'skill')
    await mkdir(skillDir, { recursive: true })
    const res = await writeDraftSkillFiles(skillDir, {
      'SKILL.md': '# 好文件\n',
      '../escape.md': '# 想跑出去\n',
    })
    assert.deepEqual(res.written, [], '整单拒：不半写')
    assert.deepEqual(res.rejected, ['../escape.md'])
    // 磁盘上不该出现任何东西（连合法的那个也没写）
    const files = await readDraftSkillDir(skillDir)
    assert.equal(files, null, '目录里什么都没写')
  })

  test('★★ 只写不删：保存 `SKILL.md` 不许动别人没看见的文件', async () => {
    // ⚠️ 这条是"保存"这条路的**要害**，理由与入库那条路同源（见 server.ts 里那段
    //    注释）：那种写法是"清空目录再写"，于是"只改了一个字"会顺手删掉点文件、
    //    二进制、以及任何 `readTree` 看不见的东西。第一版我打算照抄入库的写法
    //    （整目录替换），写到一半发现"没看见 ≠ 决定删"这件事在保存这条路上更贵。
    const hut = join(dir, 'hut-keep')
    const skillDir = join(hut, 'skill')
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# 旧正文\n', 'utf8')
    await writeFile(join(skillDir, 'references', 'notes.md'), '# 我改不到的东西\n', 'utf8')
    // 点文件：`readTree` 会跳过它 ⇒ 编辑器里根本没有它 ⇒ 保存不许碰它
    await writeFile(join(skillDir, '.hidden'), '别动我\n', 'utf8')

    const res = await writeDraftSkillFiles(skillDir, { 'SKILL.md': '# 新正文\n' })
    assert.deepEqual(res.written, ['SKILL.md'])
    assert.equal(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), '# 新正文\n')
    assert.equal(
      await readFile(join(skillDir, 'references', 'notes.md'), 'utf8'),
      '# 我改不到的东西\n',
      '没在请求里的文件必须原样留着',
    )
    assert.equal(await readFile(join(skillDir, '.hidden'), 'utf8'), '别动我\n', '点文件也不许删')
  })

  test('★ 指纹：内容变了就变，且两组不同文件不许撞同一个指纹', async () => {
    const a = hashDraftFiles({ 'SKILL.md': 'x\n', 'references/n.md': 'y\n' })
    assert.equal(a, hashDraftFiles({ 'references/n.md': 'y\n', 'SKILL.md': 'x\n' }), '顺序无关')
    assert.notEqual(a, hashDraftFiles({ 'SKILL.md': 'x\n', 'references/n.md': 'y2\n' }))
    assert.notEqual(a, hashDraftFiles({ 'SKILL.md': 'x\n' }), '少一个文件要变')
    // ⚠️ 用分隔符拼会在这里撞车：`{a: '1\n2'}` 与 `{a: '1', b: '2'}` 拼出来一样。
    //    长度前缀就是为它加的（撞车的表现是"改了内容却判为没过期"）。
    assert.notEqual(
      hashDraftFiles({ 'SKILL.md': '1\n2\n' }),
      hashDraftFiles({ 'SKILL.md': '1\n', 'x.md': '2\n' }),
      '内容里带换行也不许撞',
    )
  })

  test('★ 指纹与"审核时钉下的那份"对得上：写回改变了目录指纹', async () => {
    const hut = join(dir, 'hut-stamp')
    const skillDir = join(hut, 'skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# 一审时\n', 'utf8')
    const audited = await hashDraftDir(skillDir)
    await writeAuditStamp(hut, { reviewRunId: 'run-1', hash: audited, at: 1 })
    assert.deepEqual(await readAuditStamp(hut), { reviewRunId: 'run-1', hash: audited, at: 1 })

    assert.equal(await hashDraftDir(skillDir), audited, '没改 ⇒ 指纹一致（结论不算过期）')
    await writeDraftSkillFiles(skillDir, { 'SKILL.md': '# 人改过\n' })
    assert.notEqual(await hashDraftDir(skillDir), audited, '改了 ⇒ 指纹不同（结论过期）')

    // 读不到 / 坏文件 ⇒ null（"判不出来"），不许编成"没过期"
    const empty = join(dir, 'hut-no-stamp')
    await mkdir(empty, { recursive: true })
    assert.equal(await readAuditStamp(empty), null)
    await writeFile(join(empty, '.audited.json'), '{ 这不是 json', 'utf8')
    assert.equal(await readAuditStamp(empty), null)
  })
})

const GOOD_SKILL_MD = `---
name: review-report
description: 当需要审核外部报告并给出结构化判决时用
---

# 审核报告

## When to Use
- 收到外来报告需要判断对错时

## Procedure
1. 读报告，列出证据 —— \`cat report.md\`

## Pitfalls
- 别把没证据的结论当事实

## Verification
- 每条结论都能指到证据行
`

describe('parseSkillMd', () => {
  test('拆出 name / description，正文去掉 frontmatter', () => {
    const parsed = parseSkillMd(GOOD_SKILL_MD)
    assert.equal(parsed.name, 'review-report')
    assert.match(parsed.description, /当需要审核外部报告/)
    assert.match(parsed.body, /## When to Use/)
    assert.doesNotMatch(parsed.body, /^---/)
  })

  test('带引号的值去引号；没有 frontmatter 时 name 为空', () => {
    assert.equal(parseSkillMd('---\nname: "a-b"\n---\n正文').name, 'a-b')
    assert.equal(parseSkillMd('就是一段普通文本').name, '')
  })
})

describe('validateArtifactFiles', () => {
  test('合法的多文件通过', () => {
    const result = validateArtifactFiles({
      'SKILL.md': GOOD_SKILL_MD,
      'references/fields.md': '# 字段表\n',
    })
    assert.equal(result.ok, true, JSON.stringify(result.problems))
  })

  test('缺 SKILL.md / 缺 frontmatter / 缺 name / 缺 When to Use 都能定位到文件', () => {
    const noSkillMd = validateArtifactFiles({ 'references/a.md': 'x' })
    assert.equal(noSkillMd.ok, false)
    assert.ok(noSkillMd.problems.some((p) => p.file === 'SKILL.md' && /缺少 SKILL.md/.test(p.message)))

    const noFrontmatter = validateArtifactFiles({ 'SKILL.md': '# 只有标题\n' })
    assert.ok(
      noFrontmatter.problems.some((p) => /frontmatter/.test(p.message) && /只有标题/.test(p.message)),
      '报错要引出当前首行（只说不合法等于让使用者自己找）',
    )

    const noName = validateArtifactFiles({
      'SKILL.md': '---\ndescription: 当需要 x 时用\n---\n\n## When to Use\n\n## Procedure\n',
    })
    assert.ok(noName.problems.some((p) => /缺少 name/.test(p.message)))

    const noSection = validateArtifactFiles({
      'SKILL.md': '---\nname: a-b\ndescription: 当需要 x 时用\n---\n\n正文\n',
    })
    assert.ok(noSection.problems.some((p) => /When to Use/.test(p.message)))
  })

  test('name 不是 kebab-case 会点名；越界路径被拒', () => {
    const badName = validateArtifactFiles({
      'SKILL.md': '---\nname: Some Name\ndescription: 当需要 x 时用\n---\n\n## When to Use\n\n## Procedure\n',
    })
    assert.ok(badName.problems.some((p) => /kebab-case/.test(p.message)))

    const traversal = validateArtifactFiles({
      'SKILL.md': GOOD_SKILL_MD,
      '../evil.md': 'x',
    })
    assert.ok(traversal.problems.some((p) => p.file === '../evil.md' && /路径不合法/.test(p.message)))
  })
})

describe('assembleArtifacts：三种产出形态', () => {
  test('files：目录产出优先，SKILL.md 一定在', () => {
    const artifacts = assembleArtifacts(
      { 'SKILL.md': GOOD_SKILL_MD, 'scripts/check.sh': '#!/bin/sh\n' },
      '这段文本应该被忽略',
    )
    assert.equal(artifacts.mode, 'files')
    assert.equal(artifacts.skillMd.name, 'review-report')
    assert.ok('scripts/check.sh' in artifacts.files)
    assert.equal(artifacts.validation.ok, true)
  })

  test('text：目录为空时回退最后一条 text（generic runtime 的退化路径）', () => {
    const artifacts = assembleArtifacts(null, GOOD_SKILL_MD)
    assert.equal(artifacts.mode, 'text')
    assert.deepEqual(Object.keys(artifacts.files), ['SKILL.md'])
    assert.equal(artifacts.skillMd.name, 'review-report', '文本也要能解析出来')
  })

  test('refused：起草者只写了 REFUSED.md → 单独一种结论，带原因', () => {
    const artifacts = assembleArtifacts(
      { 'REFUSED.md': '全是环境问题，没有可复用做法。' },
      null,
    )
    assert.equal(artifacts.mode, 'refused')
    assert.match(artifacts.refusalReason ?? '', /环境问题/)
    assert.equal(artifacts.validation.ok, false)
  })

  test('什么都没产出 → 校验失败且说清原因（不是静默空草稿）', () => {
    const artifacts = assembleArtifacts(null, null)
    assert.equal(artifacts.mode, 'text')
    assert.equal(artifacts.validation.ok, false)
    assert.match(artifacts.validation.problems[0]?.message ?? '', /没有产出任何内容/)
  })
})

describe('readDraftSkillDir', () => {
  test('递归读文件，跳过隐藏文件（.claude 里是注入的技能，不是产出）', async () => {
    const skillDir = join(dir, 'skill')
    await mkdir(join(skillDir, '.claude', 'skills', 'writing-skills'), { recursive: true })
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), GOOD_SKILL_MD, 'utf8')
    await writeFile(join(skillDir, 'references', 'fields.md'), '# 字段\n', 'utf8')
    await writeFile(join(skillDir, '.claude', 'skills', 'writing-skills', 'SKILL.md'), 'x', 'utf8')

    const files = await readDraftSkillDir(skillDir)
    assert.ok(files)
    assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'references/fields.md'])
  })

  test('目录不存在返回 null（交给文本兜底）', async () => {
    assert.equal(await readDraftSkillDir(join(dir, 'nope')), null)
  })

  test('空目录也返回 null', async () => {
    const empty = join(dir, 'empty-skill')
    await mkdir(empty, { recursive: true })
    assert.equal(await readDraftSkillDir(empty), null)
  })
})

describe('内置写作技能', () => {
  test('能读到 SKILL.md 与三份参考（随代码走，不依赖使用者技能目录）', async () => {
    const skill = await loadBuiltinSkill(WRITING_SKILLS)
    assert.ok(skill, '内置技能必须存在——读不到沉淀就写不出规范的东西')
    assert.equal(skill.slug, 'writing-skills')
    assert.equal(skill.name, 'writing-skills')
    assert.ok((skill.description ?? '').length > 0, 'description 是渐进式披露的第一层')
    assert.match(skill.body, /## When to Use/)
    assert.match(skill.body, /## Procedure/)
    const files = Object.keys(skill.files)
    assert.ok(files.includes('references/structure.md'))
    assert.ok(files.includes('references/files.md'))
    assert.ok(files.includes('references/checklist.md'))
    assert.match(skill.files['references/structure.md'] ?? '', /不结晶清单/)
  })

  test('读不存在的内置技能返回 null（调用方据此报安装不完整）', async () => {
    assert.equal(await loadBuiltinSkill('no-such-builtin'), null)
  })
})
