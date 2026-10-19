/**
 * 文本 diff（P1）与"变更集"的单元测试。
 *
 * 重点盯四件事：
 *   · 只改一行时**不要**把整文件都标成改动（LCS 真的生效了）
 *   · 新增/删除/修改/没变 四种 change 判定
 *   · hunk 的上下文与合并（相邻改动不该被拆成两个 hunk）
 *   · 大文件退化时仍然给出**正确**的差异（只是不精细）
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { diffFileSets, diffLines } from './text-diff.ts'

const A = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n'

describe('diffLines', () => {
  test('相同文本 ⇒ 没有 hunk', () => {
    const d = diffLines(A, A)
    assert.equal(d.hunks.length, 0)
    assert.equal(d.added, 0)
    assert.equal(d.removed, 0)
  })

  test('改中间一行：只有那一行 +/-，其余是上下文', () => {
    const next = A.replace('e\n', 'E\n')
    const d = diffLines(A, next)
    assert.equal(d.added, 1)
    assert.equal(d.removed, 1)
    const changed = d.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== ' ')
    assert.deepEqual(
      changed.map((l) => `${l.kind}${l.text}`),
      ['-e', '+E'],
    )
    // 上下文只取 3 行（不算整文件）：10 行的文件 has 1+1+6 = 8 行在 hunk 里
    assert.ok(d.hunks[0]!.lines.length <= 8)
  })

  test('新增文件（空基线）⇒ 全部 +', () => {
    const d = diffLines('', 'x\ny\n')
    assert.equal(d.added, 2)
    assert.equal(d.removed, 0)
    assert.deepEqual(d.hunks[0]!.lines.map((l) => l.kind), ['+', '+'])
  })

  test('删除文件（新为空）⇒ 全部 -', () => {
    const d = diffLines('x\ny\n', '')
    assert.equal(d.removed, 2)
    assert.deepEqual(d.hunks[0]!.lines.map((l) => l.kind), ['-', '-'])
  })

  test('行号：新增行为 null，删除行为 null（前端按它标 gutter）', () => {
    const d = diffLines('a\nb\n', 'a\nc\n')
    const flat = d.hunks.flatMap((h) => h.lines)
    const del = flat.find((l) => l.kind === '-')!
    const add = flat.find((l) => l.kind === '+')!
    assert.equal(del.oldNo, 2)
    assert.equal(del.newNo, null)
    assert.equal(add.oldNo, null)
    assert.equal(add.newNo, 2)
  })

  test('末尾换行的差异算改动（`a\\n` vs `a`）——否则界面会说"没变"而写下去的字节能变', () => {
    const d = diffLines('a\n', 'a')
    assert.equal(d.added, 1)
    assert.equal(d.removed, 1)
  })

  test('两处相距很远的改动 ⇒ 两个 hunk（不合并）', () => {
    const oldText = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n'
    const newText = oldText.replace('line2\n', 'LINE2\n').replace('line35\n', 'LINE35\n')
    const d = diffLines(oldText, newText)
    assert.equal(d.hunks.length, 2, JSON.stringify(d.hunks.map((h) => h.oldStart)))
  })

  test('★ 大文件退化成整文件替换，但差异仍然正确（不编内容）', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n') + '\n'
    const d = diffLines(big, big)
    // 相同文本在退化之前就被短路了，不会走退化分支
    assert.equal(d.added + d.removed, 0)

    const changed = big.replace('row 2500', 'ROW 2500')
    const d2 = diffLines(big, changed)
    assert.equal(d2.coarse, true, '超过行数上限 ⇒ 退化')
    assert.equal(d2.added, 5000)
    assert.equal(d2.removed, 5000)
    const plus = d2.hunks[0]!.lines.filter((l) => l.kind === '+')
    assert.ok(plus.some((l) => l.text === 'ROW 2500'), '改动确实在结果里')
  })
})

describe('diffFileSets：变更集（A/M/D/same）', () => {
  const baseline = { 'SKILL.md': '# 旧\n', 'LICENSE.txt': 'MIT\n', 'references/x.md': '# x\n' }

  test('四种 change 都判定对，SKILL.md 排第一', () => {
    const draft = {
      'SKILL.md': '# 新\n',
      'references/x.md': '# x\n', // 没变
      'references/y.md': '# y\n', // 新增
      // LICENSE.txt 没了 → 删除
    }
    const diffs = diffFileSets(baseline, draft)
    assert.deepEqual(
      diffs.map((d) => [d.rel, d.change]),
      [
        // SKILL.md 第一；未删除的按路径排序；要删的堆在最后（核对时最该一眼看到）
        ['SKILL.md', 'M'],
        ['references/x.md', 'same'],
        ['references/y.md', 'A'],
        ['LICENSE.txt', 'D'],
      ],
    )
  })

  test('新增场景（空基线）⇒ 全是 A', () => {
    const diffs = diffFileSets({}, { 'SKILL.md': '# 新\n', 'scripts/a.sh': 'echo\n' })
    assert.equal(diffs.every((d) => d.change === 'A'), true)
    assert.equal(diffs[0]!.rel, 'SKILL.md')
  })

  test('修改的行数统计与 hunk 一致（+n −m 是界面上显示的那两个数）', () => {
    const diffs = diffFileSets({ 'SKILL.md': 'a\nb\nc\n' }, { 'SKILL.md': 'a\nB\nc\n' })
    const skill = diffs[0]!
    assert.equal(skill.added, 1)
    assert.equal(skill.removed, 1)
    const minus = skill.hunks.flatMap((h) => h.lines).filter((l) => l.kind === '-').length
    assert.equal(minus, skill.removed, 'hunk 里的 - 行数要对得上')
  })
})
