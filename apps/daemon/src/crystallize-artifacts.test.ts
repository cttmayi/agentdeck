/**
 * 起草产出的读取与校验（2026-10-19 四轮）。
 *
 * 覆盖四条最容易回归的语义：
 *   · 多文件目录 → `mode: 'files'`，SKILL.md 的 frontmatter 拆成 name/description
 *   · 没有 SKILL.md → `mode: 'none'`（这一轮只是说了话），不当成"交了一份坏东西"
 *   · 校验能指出**具体哪个文件**缺什么（界面要定位，不是只给一句"不合法"）
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assembleArtifacts,
  hashDraftFiles,
  isSafeDraftRelPath,
  parseSkillMd,
  readDraftSkillDir,
  validateArtifactFiles,
  writeDraftSkillFiles,
  dropForeignVersions,
} from './crystallize-artifacts.ts'
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

  // ★ 分批第 137 批：审核指纹那一组随审核一起删除（`hashDraftDir` / `writeAuditStamp` /
  //   `readAuditStamp` 已不存在）。`hashDraftFiles` 的判据还在上面——它钉的是「长度前缀防碰撞」
  //   这个纯函数性质，与审核无关。
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

  /**
   * ★ 分批第 177 批（使用者定："不需要检查 when to use 等标签"）：**章节名不再是门槛**。
   * 这一条从"缺 When to Use 要报"翻成"**不许**因为缺那两节就报"——否则装了别家技能
   * （自己的章节结构）草稿永远过不了体检。
   */
  test('缺 SKILL.md / 缺 frontmatter / 缺 name 都能定位到文件；**章节名不再是门槛**', () => {
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
      'SKILL.md': '---\nname: a-b\ndescription: 当需要 x 时用\n---\n\n正文（没有我们那两节）\n',
    })
    assert.equal(
      noSection.problems.some((p) => /When to Use|Procedure/.test(p.message)),
      false,
      '章节名是我们的写法约定，不是 skill 的通用形态 ⇒ 体检不许拿它拦人',
    )
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

describe('assembleArtifacts：两种产出形态（分批第 211 批：没交就是没交）', () => {
  test('files：有 SKILL.md 就是产出，支持文件一起带上', () => {
    const artifacts = assembleArtifacts({
      'SKILL.md': GOOD_SKILL_MD,
      'scripts/check.sh': '#!/bin/sh\n',
    })
    assert.equal(artifacts.mode, 'files')
    assert.equal(artifacts.skillMd.name, 'review-report')
    assert.ok('scripts/check.sh' in artifacts.files)
    assert.equal(artifacts.validation.ok, true)
  })

  /**
   * ★ 分批第 211 批（使用者定："人之间在对话框里看 AI 的回答就好了，应该不需要 REFUSED
   *   的特殊处理才对"）：`refused` 与 `text` 两种形态一起删了。
   *
   * 它们各自靠一个协议/兜底：`REFUSED.md`（"这是结论"）、"把它的回话当 SKILL.md"（文本兜底）。
   * 现在只有一条判据——**`skill/SKILL.md` 在不在**：不在就是"这一轮没交东西"，它说的话在
   * 消息流里（界面直接读 run 的最后一段文本），不假装成一份 SKILL.md。
   */
  test('none：只有别的文件、没有 SKILL.md ⇒ 没交东西（不再把回话冒充 SKILL.md）', () => {
    const artifacts = assembleArtifacts({ 'REFUSED.md': '全是环境问题，没有可复用做法。' })
    assert.equal(artifacts.mode, 'none')
    assert.equal(artifacts.validation.ok, false)
    assert.match(artifacts.validation.problems[0]?.message ?? '', /没有交 skill/)
    // 它写过的东西仍然带上：右栏要看得到"它到底写了什么"，而不是一片空白
    assert.ok('REFUSED.md' in artifacts.files)
  })

  /**
   * ★ 分批第 217 批（使用者定："可以是 skill 目录，也可以是 skill 下的子目录，动态侦测"）：
   * 起草者可能调它自己的写入器（真机上 distilly 的 `tools/skill_writer.py` 落点是
   * `<base-dir>/<slug>/SKILL.md`）⇒ 产出在 `skill/<dir>/` 里。**唯一一层子目录也认**：
   * 在内存里归一到根，于是编辑器/差异/入库看到的是同一套相对路径。
   */
  test('files：唯一一层子目录里的 SKILL.md 也认（读时归一到根，磁盘不动）', () => {
    const artifacts = assembleArtifacts({
      'colleague-flow/SKILL.md': GOOD_SKILL_MD,
      'colleague-flow/work.md': '# Work\n',
      'colleague-flow/meta.json': '{}',
    })
    assert.equal(artifacts.mode, 'files')
    assert.equal(artifacts.skillMd.name, 'review-report', 'frontmatter 照样能解析')
    assert.deepEqual(
      Object.keys(artifacts.files).sort(),
      ['SKILL.md', 'meta.json', 'work.md'],
      '路径归一到根（`colleague-flow/` 前缀剥掉）',
    )
    assert.equal(artifacts.validation.ok, true)
  })

  /**
   * ★ 分批第 217 批（使用者定："不要搬，动态识别位置"）：归一只发生在**读**的时候。
   *
   * 判据两半：① `readDraftSkillDir()` 给出来的路径已经是相对根的（读的人不用知道它在子目录里）；
   * ② **磁盘上的文件一个都没动**（不搬——读路径上不留副作用）。
   */
  test('★★ readDraftSkillDir：子目录落点读出来就是根上的相对路径，且磁盘不改', async () => {
    const probeDir = join(dir, 'nested-skill')
    await mkdir(join(probeDir, 'colleague-flow'), { recursive: true })
    await writeFile(join(probeDir, 'colleague-flow', 'SKILL.md'), GOOD_SKILL_MD, 'utf8')
    await writeFile(join(probeDir, 'colleague-flow', 'work.md'), '# Work\n', 'utf8')

    const files = await readDraftSkillDir(probeDir)
    assert.ok(files !== null)
    assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'work.md'], '读出来就是根上的路径')
    // ② 磁盘没动：原来的子目录还在
    assert.ok(
      await readFile(join(probeDir, 'colleague-flow', 'SKILL.md'), 'utf8').catch(() => null),
      '不搬：子目录里的文件仍在（读路径不留副作用）',
    )
  })

  test('★★ readDraftSkillDir：根上已有 SKILL.md ⇒ 子目录那棵残留树被遮掉（不出两份）', async () => {
    const probeDir = join(dir, 'mixed-skill')
    await mkdir(join(probeDir, 'colleague-flow'), { recursive: true })
    await writeFile(join(probeDir, 'SKILL.md'), GOOD_SKILL_MD, 'utf8')
    await writeFile(join(probeDir, 'work.md'), '# 新的\n', 'utf8')
    await writeFile(join(probeDir, 'colleague-flow', 'SKILL.md'), '# 上一轮的残留\n', 'utf8')
    await writeFile(join(probeDir, 'colleague-flow', 'work.md'), '# 旧的\n', 'utf8')

    const files = await readDraftSkillDir(probeDir)
    assert.ok(files !== null)
    assert.deepEqual(
      Object.keys(files).sort(),
      ['SKILL.md', 'work.md'],
      '根上的那份说了算，残留子目录不进产物（否则树里/入库里都是两份）',
    )
    assert.match(files['work.md'] ?? '', /新的/)
  })

  test('none：多份 SKILL.md ⇒ 不猜，如实报是哪几份', () => {
    const artifacts = assembleArtifacts({
      'a/SKILL.md': GOOD_SKILL_MD,
      'b/SKILL.md': GOOD_SKILL_MD,
    })
    assert.equal(artifacts.mode, 'none')
    assert.match(artifacts.validation.problems[0]?.message ?? '', /多份 SKILL\.md/)
    assert.match(artifacts.validation.problems[0]?.message ?? '', /a\/SKILL\.md/)
  })

  test('none：什么都没写（目录不存在）也是没交东西', () => {
    const artifacts = assembleArtifacts(null)
    assert.equal(artifacts.mode, 'none')
    assert.deepEqual(artifacts.files, {})
    assert.equal(artifacts.validation.ok, false)
  })
})

describe('readDraftSkillDir', () => {
  test('递归读文件，跳过隐藏文件（.claude 里是注入的技能，不是产出）', async () => {
    const skillDir = join(dir, 'skill')
    await mkdir(join(skillDir, '.claude', 'skills', 'distilly'), { recursive: true })
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), GOOD_SKILL_MD, 'utf8')
    await writeFile(join(skillDir, 'references', 'fields.md'), '# 字段\n', 'utf8')
    await writeFile(join(skillDir, '.claude', 'skills', 'distilly', 'SKILL.md'), 'x', 'utf8')

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

/**
 * ★ 分批第 210 批：这里原来有一组「内置写作技能」（`apps/daemon/assets/builtin-skills/
 * writing-skills/` 的读取）。整套**删掉了**——写法归使用者装的那份技能（distilly），
 * 平台不再自带第二份；那组测试钉的是一个已经不存在的资产。
 */

/**
 * 真机现场（2026-10-23）：`9D67DN` 的任务目录里 `.versions.json` 记着 14 条，其中 4 条属于
 * 同一来源下的另一条链 `H5YM0E`。旧的"同来源+同目标"口径在自愈时写进去的 ⇒ "这一任务有几版"
 * 与磁盘实际不符，界面的"第几版"也跟着错。
 */
test('★★ 版本表里"别的链"的条目要被剔掉（真机上混进过另一条链的 4 条）', () => {
  const versions = {
    healedAt: null,
    versions: [
      { runId: 'a1', at: 1, humanEdited: false, snapshot: null },
      { runId: 'b1', at: 2, humanEdited: true, snapshot: 'history/b1' },
      { runId: 'a2', at: 3, humanEdited: false, snapshot: null },
      { runId: 'b2', at: 4, humanEdited: false, snapshot: null },
    ],
  }
  const { kept, dropped } = dropForeignVersions(versions, new Set(['b1', 'b2']))
  assert.deepEqual(dropped, ['a1', 'a2'], '剔掉的必须是**别的链**那几条，顺序照原表')
  assert.deepEqual(
    kept.versions.map((v) => v.runId),
    ['b1', 'b2'],
    '本链的条目一条不动（含 humanEdited / 快照记录——那是人改过的证据）',
  )
  assert.equal(kept.versions[0]?.humanEdited, true)
  assert.equal(kept.versions[0]?.snapshot, 'history/b1')
})

test('表里全是本链的 ⇒ 一个字都不改（不写回，避免每次刷新都动使用者的目录）', () => {
  const versions = {
    healedAt: 7,
    versions: [{ runId: 'b1', at: 1, humanEdited: false, snapshot: null }],
  }
  const { kept, dropped } = dropForeignVersions(versions, new Set(['b1', 'b2']))
  assert.deepEqual(dropped, [])
  assert.equal(kept, versions, '没东西可剔时返回**同一个对象**：调用方据此跳过写盘')
})
