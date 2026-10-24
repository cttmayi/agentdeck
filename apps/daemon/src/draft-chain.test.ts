import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chainOf, groupByChain, rootOf, type ChainRun } from './draft-chain.ts'

/**
 * 这一组钉的是真机上量到的那个缺陷（2026-10-23）：来源 run `Q2SQ16` 下有两个根
 * （`H5YM0E` 4 版、`9D67DN` 10 版），两者 `sourceRunId` 相同、`crystallizeTarget` 都是
 * `{"kind":"new"}` ⇒ 四份"同来源+同目标"的口径把它们当成一条链 ⇒ 列表一行 18 版、
 * 自动返工的额度被邻链撑爆（已用 17 > 上限 2 ⇒ 一次都没自动返工）。
 */
function run(id: string, revisedFrom: string | null, queuedAt: number): ChainRun {
  return { id, revisedFrom, queuedAt }
}

/** 真机那两条链的形状（目标不是本函数的输入，所以"目标相同"这件事不会影响结果）。 */
const REAL_SHAPE: ChainRun[] = [
  run('H5YM0E', null, 100),
  run('WFS3AT', 'H5YM0E', 110),
  run('GB96Z8', 'WFS3AT', 120),
  run('V9BEXX', 'GB96Z8', 130),
  run('AJEAWK', null, 140), // 另一个根：更新到某个已存在的 skill
  run('9D67DN', null, 200),
  run('T6FKQB', '9D67DN', 210),
  run('QFJCB8', 'T6FKQB', 220),
]

test('★★ 同一个来源下的两个根 = 两条链（真机上被并成了一行 18 版）', () => {
  const groups = groupByChain(REAL_SHAPE)
  assert.equal(groups.size, 3, '两个新建链 + 一个更新链，必须是三组')
  assert.deepEqual(
    groups.get('H5YM0E')?.map((r) => r.id),
    ['H5YM0E', 'WFS3AT', 'GB96Z8', 'V9BEXX'],
  )
  assert.deepEqual(groups.get('9D67DN')?.map((r) => r.id), ['9D67DN', 'T6FKQB', 'QFJCB8'])
  assert.deepEqual(groups.get('AJEAWK')?.map((r) => r.id), ['AJEAWK'])
})

test('★ 邻链的版本不进这一条的链（额度/轮次/目录都靠它）', () => {
  // 这正是"自动返工额度被撑爆"的那一格：H5YM0E 那条链有 4 版，
  // 9D67DN 这条链自己只有 3 版 —— 旧口径会数成 7 版。
  assert.equal(chainOf(REAL_SHAPE, '9D67DN').length, 3)
  assert.equal(chainOf(REAL_SHAPE, 'H5YM0E').length, 4)
})

test('根 = revisedFrom 为空的那一版；中间版本上溯也能找到同一个根', () => {
  const byId = new Map(REAL_SHAPE.map((r) => [r.id, r]))
  assert.equal(rootOf('QFJCB8', byId), '9D67DN')
  assert.equal(rootOf('V9BEXX', byId), 'H5YM0E')
  assert.equal(rootOf('AJEAWK', byId), 'AJEAWK')
})

test('父 run 已不存在 ⇒ 自成一根（不许被并进别人家）', () => {
  const runs = [run('orphan', 'gone-run', 10), run('other', null, 20)]
  const groups = groupByChain(runs)
  assert.equal(groups.size, 2)
  assert.deepEqual(
    groups.get('orphan')?.map((r) => r.id),
    ['orphan'],
  )
})

test('★ 脏数据成环也不许转死，而且根必须与"从哪一版进来"无关', () => {
  const runs = [run('a', 'b', 1), run('b', 'a', 2)]
  // 两条都在同一组、函数必须返回（而不是无限上溯）
  const groups = groupByChain(runs)
  assert.equal(groups.size, 1)
  assert.equal([...groups.values()][0]?.length, 2)
  // ⚠️ 这条是第二版才发现要钉的：第一版"上溯到重复就停" ⇒ 从 a 进得到 b、从 b 进得到 a，
  //    同一条脏数据算成两条链（列表一行变两行、额度数两遍）。取环上最早那一版才确定。
  const byId = new Map(runs.map((r) => [r.id, r]))
  assert.equal(rootOf('a', byId), 'a', '环上最早的是 a（queuedAt 1）')
  assert.equal(rootOf('b', byId), 'a', '从 b 进来也必须得到同一个根')
})

test('组内按时间升序：第一版在最前（界面按这个算"第几版"）', () => {
  const runs = [run('c', 'b', 3), run('a', null, 1), run('b', 'a', 2)]
  assert.deepEqual(
    groupByChain(runs).get('a')?.map((r) => r.id),
    ['a', 'b', 'c'],
  )
})
