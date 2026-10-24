import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLOAT_RATIO,
  MIN_LINES_FOR_RATIO,
  REWRITE_RATIO,
  countLines,
  inspectRework,
  locatorFile,
  type GuardFile,
} from './rework-guard.ts'

/**
 * 这一组钉的是**返工收敛闸门**的判据（分批第 25 批）。
 *
 * 每一条都来自真机那条链的形态：15 版 / $62.27 还在震荡——修好 A 撞坏 B，
 * 正文 188 → 473 行只增不减。判据要是松了，"重写"就会一直被放行，
 * 而那正是震荡的来源。
 */

const skill = (lines: readonly string[]): string => lines.join('\n')

test('locatorFile：三种写法都能归一成文件（行号/小节都切掉）', () => {
  assert.equal(locatorFile('SKILL.md:183'), 'SKILL.md')
  assert.equal(locatorFile('references/extraction.md:11-13'), 'references/extraction.md')
  assert.equal(locatorFile('SKILL.md#When to Use'), 'SKILL.md')
  assert.equal(locatorFile('scripts/find-pdf-url.py'), 'scripts/find-pdf-url.py')
})

test('★★ `skill/` 前缀要归一（真机第一次跑就误判了 off-target、误停循环）', () => {
  // 审核者写 `skill/SKILL.md:183`，闸门比的是产出目录内部的 `SKILL.md`
  assert.equal(locatorFile('skill/SKILL.md:183'), 'SKILL.md')
  assert.equal(locatorFile('skill/references/research-commands.md:12'), 'references/research-commands.md')
  // 已经不带前缀的不要被误伤
  assert.equal(locatorFile('SKILL.md:183'), 'SKILL.md')
})

test('countLines：空行不算（模型爱加空行"整理版式"，那不算变胖）', () => {
  assert.equal(countLines('a\n\nb\n  \nc\n'), 3)
  assert.equal(countLines(''), 0)
  assert.equal(countLines(null), 0)
})

test('★★ 只改两行 ⇒ 放行（这才是"按意见改点到的地方"）', () => {
  const prev = skill(Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`))
  const next = prev.replace('第 12 行', '第 12 行（改好了）').replace('第 20 行', '第 20 行（也改了）')
  const r = inspectRework({
    files: [{ path: 'SKILL.md', prev, next }],
    targetLocators: ['SKILL.md:12', 'SKILL.md:20'],
  })
  assert.equal(r.kind, 'ok', `不该被判重写：${r.reasons.join('；')}`)
  assert.equal(r.facts.added, 2)
  assert.equal(r.facts.removed, 2)
  assert.equal(r.facts.targetUntouched, false)
})

test('★★★ 整篇换掉 ⇒ 判重写（改了一半以上的行，那不是改，是重写）', () => {
  const prev = skill(Array.from({ length: 40 }, (_, i) => `旧内容 ${i + 1}`))
  const next = skill(Array.from({ length: 40 }, (_, i) => `新内容 ${i + 1}`))
  const r = inspectRework({ files: [{ path: 'SKILL.md', prev, next }], targetLocators: ['SKILL.md:12'] })
  assert.equal(r.kind, 'rewrite')
  assert.ok(r.facts.changedRatio > REWRITE_RATIO)
  assert.match(r.reasons[0] ?? '', /重写整篇/)
})

test('★★ 正文一路变胖 ⇒ 判 bloat（第 1 版 188 行、第 10 版 473 行的斜率）', () => {
  const prev = skill(Array.from({ length: 100 }, (_, i) => `行 ${i + 1}`))
  const next = prev + '\n' + skill(Array.from({ length: 40 }, (_, i) => `新增的第 ${i + 1} 段`))
  const r = inspectRework({ files: [{ path: 'SKILL.md', prev, next }], targetLocators: ['SKILL.md:12'] })
  assert.equal(r.kind, 'bloat')
  assert.ok(r.facts.nextLines > r.facts.prevLines * BLOAT_RATIO)
  assert.match(r.reasons[0] ?? '', /从 100 行涨到 140 行/)
})

test('★★★ 点名的地方一个都没动（改的是别的文件）⇒ 判 off-target', () => {
  // 真机上就是这种：第 15 轮的判决点名 `SKILL.md:183`（A 路兜底用了 B 路的脚本），
  // 而返工版去改了 `references/extraction.md` —— 那处根本没被点名。
  const prevSkill = skill(Array.from({ length: 30 }, (_, i) => `SKILL 第 ${i + 1} 行`))
  const prevRef = skill(['a', 'b', 'c'])
  const nextRef = skill(['a', 'b', 'c', 'd'])
  const r = inspectRework({
    files: [
      { path: 'SKILL.md', prev: prevSkill, next: prevSkill },
      { path: 'references/extraction.md', prev: prevRef, next: nextRef },
    ],
    targetLocators: ['SKILL.md:183', 'SKILL.md:157'],
  })
  assert.equal(r.kind, 'off-target')
  assert.deepEqual(r.facts.targetFiles, ['SKILL.md'])
  assert.deepEqual(r.facts.touchedFiles, ['references/extraction.md'])
  assert.match(r.reasons[0] ?? '', /一个都没动/)
})

test('★ 一行都没改 ⇒ off-target（不是"改不好"，是"没改"）', () => {
  const same = skill(['x', 'y', 'z'])
  const r = inspectRework({
    files: [{ path: 'SKILL.md', prev: same, next: same }],
    targetLocators: ['SKILL.md:2'],
  })
  assert.equal(r.kind, 'off-target')
  assert.deepEqual(r.facts.touchedFiles, [])
  assert.equal(r.facts.added, 0)
  assert.equal(r.facts.removed, 0)
})

test('新建文件（prev 为 null）不会被算成"改了一半"', () => {
  const r = inspectRework({
    files: [
      { path: 'SKILL.md', prev: skill(['a', 'b']), next: skill(['a', 'b']) },
      { path: 'scripts/new.sh', prev: null, next: skill(['echo hi']) },
    ],
    targetLocators: ['SKILL.md:1'],
  })
  // SKILL.md 没动 ⇒ targetUntouched；新建文件不算"碰到点名文件"
  assert.equal(r.facts.removed, 0)
  assert.equal(r.facts.added, 1)
  // ⚠️ 第一版这里判成 `rewrite`（占比 1/2 = 50% > 0.4）——**比例在小文档上没有意义**。
  //    真机上 `SKILL.md` 是几百行，所以判据加了 `MIN_LINES_FOR_RATIO = 20` 的门槛。
  assert.equal(r.kind, 'off-target')
})

/**
 * ⚠️ 阈值本身也要钉住：它写在 `rework-guard.ts` 里，若有人顺手调松（比如 0.8），
 * 上面几条"整篇重写"的用例可能仍然红，但**边界**会悄悄变宽。这条把数字钉死，
 * 逼改动的人先读一遍"为什么是 0.4 / 1.3"。
 */
test('★ 阈值不许悄悄调松（0.4 / 1.3 / 20 行门槛，都是按真机那条链的形态定的）', () => {
  assert.equal(REWRITE_RATIO, 0.4)
  assert.equal(BLOAT_RATIO, 1.3)
  assert.equal(MIN_LINES_FOR_RATIO, 20)
})

/** 边界：改动刚好压线（=阈值）⇒ 不算超，放行；超过一点点 ⇒ 判。 */
test('★ 边界：改动占比正好 0.4 ⇒ 放行；0.45 ⇒ 判重写', () => {
  const prev = skill(Array.from({ length: 20 }, (_, i) => `旧 ${i + 1}`))
  // 20 行里换 8 行 = 0.4（added 8 + removed 8 = 16 / 20 = 0.8 ✗ 太粗）
  // 实算：changedRatio = (added+removed)/prevLines ⇒ 要 0.4 就得 added+removed = 8，
  // 即换 4 行（4 增 + 4 删）。
  const edge = skill(Array.from({ length: 20 }, (_, i) => (i < 4 ? `新 ${i + 1}` : `旧 ${i + 1}`)))
  const ok = inspectRework({ files: [{ path: 'SKILL.md', prev, next: edge }], targetLocators: ['SKILL.md:1'] })
  assert.equal(ok.facts.changedRatio, REWRITE_RATIO)
  assert.equal(ok.kind, 'ok', '压线放行')

  const over = skill(Array.from({ length: 20 }, (_, i) => (i < 5 ? `新 ${i + 1}` : `旧 ${i + 1}`)))
  const bad = inspectRework({ files: [{ path: 'SKILL.md', prev, next: over }], targetLocators: ['SKILL.md:1'] })
  assert.equal(bad.kind, 'rewrite')
})

test('验收：真机第 15 轮那种"改出来的新伤"在 diff 上长什么样（整篇重写 ⇒ 拦得住）', () => {
  // 浓缩版：上一版 60 行，返工版换了 45 行（其中一处"修好 A 撞坏 B"）
  const prev = skill(Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：原样`))
  const next = skill(
    Array.from({ length: 60 }, (_, i) => (i < 45 ? `第 ${i + 1} 行：重写过的内容` : `第 ${i + 1} 行：原样`)),
  )
  const r = inspectRework({
    files: [{ path: 'SKILL.md', prev, next }],
    targetLocators: ['SKILL.md:183', 'SKILL.md:157'],
  })
  assert.notEqual(r.kind, 'ok')
  assert.ok(r.reasons.length > 0)
})

/** `GuardFile` 的类型只是给调用方的形状，这里顺手钉一下"prev 可以是 null"。 */
test('类型：prev 为空串也算"这一侧没有内容"', () => {
  const files: GuardFile[] = [{ path: 'SKILL.md', prev: '', next: 'a' }]
  const r = inspectRework({ files, targetLocators: [] })
  assert.equal(r.facts.added, 1)
  assert.equal(r.facts.prevLines, 0)
  // 上一版是空的 ⇒ 无从判"重写"，也不会因为除以 0 变成 Infinity
  assert.ok(Number.isFinite(r.facts.changedRatio))
})
