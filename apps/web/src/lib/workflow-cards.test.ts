import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TERMINAL_RUN_STATUSES,
  isRunTerminal,
  loopRounds,
  needsFetch,
  runCardBody,
} from './workflow-cards.ts'

/**
 * 编排运行画面「每个 run 一张卡片」的判据。
 *
 * 这一组是为了钉住使用者 2026-11 那条要求：
 *   "Agent 已启动在卡片中显示出来，一直接受文字消息并显示，直到最后结束。
 *    不要 Agent 之间有依赖关系，这样就不存在相互影响。"
 *
 * 它挡的是**两个已经发生过的真缺陷**：
 *   ① 取数只看"最后一个 runId" ⇒ loop 前面几轮的 run 从来没取过数；
 *   ② 取过一次就短路 ⇒ 状态是死快照，把关者那一行（判据是"执行 run 已 completed"）
 *      永远不出现——使用者报的就是"loop 的审核 agent 显示不出来"。
 */

describe('编排运行画面：每个 run 一张卡片', () => {
  test('★ 终态那一列与协议逐项相同（抄了一份常量，就得钉住）', async () => {
    // ⚠️ 前端不 import protocol 包（`api.ts` 顶部写了理由），所以这里是**抄的一份**。
    //    抄一份不钉住 = 真正危险的那种抄：协议加了终态，这里不知道，卡片永远"正在跑"。
    // apps/web/src/lib → 仓库根是四层
    const src = await readFile(
      join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'protocol', 'src', 'enums.ts'),
      'utf8',
    )
    const m = /export const TERMINAL_RUN_STATUSES = \[([^\]]*)\]/.exec(src)
    assert.ok(m, '协议里找不到 TERMINAL_RUN_STATUSES')
    const theirs = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!)
    assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(), theirs.sort())
  })

  test('★ 非终态 ⇒ 一直重拉（「一直接受文字消息并显示」）', () => {
    for (const status of ['queued', 'dispatched', 'running', 'waiting_local_directory']) {
      assert.equal(needsFetch(status, false), true, `${status} 本身就要拉`)
      assert.equal(needsFetch(status, true), true, `${status} 有产出也要继续拉（文字会继续长）`)
    }
  })

  test('★ 终态 + 已有产出 ⇒ 不用再拉（跑完的产出不会变，别无限打接口）', () => {
    for (const status of ['completed', 'failed', 'cancelled']) {
      assert.equal(needsFetch(status, true), false, `${status} 且已有产出 ⇒ 不用再拉`)
      // ⚠️ 但终态而**没有**产出时要再拉一次：终态那一刻的全文常常还没抓到
      assert.equal(needsFetch(status, false), true, `${status} 但没有产出 ⇒ 补拉一次`)
    }
  })

  test('★ 还不知道状态 ⇒ 要拉（`undefined` 不算终态，宁可多拉一次）', () => {
    assert.equal(needsFetch(undefined, false), true)
    assert.equal(needsFetch(undefined, true), true)
    assert.equal(needsFetch(null, true), true)
    assert.equal(isRunTerminal(undefined), false)
  })

  test('★ loop 的 runIds 两两配对；奇数按半轮如实渲染（不硬凑空把关者）', () => {
    assert.deepEqual(loopRounds(['e1', 'g1', 'e2', 'g2']), [
      { exec: 'e1', guard: 'g1' },
      { exec: 'e2', guard: 'g2' },
    ])
    assert.deepEqual(loopRounds(['e1', 'g1', 'e2']), [
      { exec: 'e1', guard: 'g1' },
      { exec: 'e2', guard: null },
    ])
    assert.deepEqual(loopRounds([]), [])
  })

  test('★★ 卡片正文只看**这条 run 自己**：已启动就显示（不是"没有产出"）', () => {
    // 已启动、还没吐字 ⇒ "正在跑"（这就是使用者要的"已启动就显示出来"）
    assert.equal(runCardBody('running', undefined), 'running')
    assert.equal(runCardBody('queued', undefined), 'running')
    assert.equal(runCardBody('dispatched', undefined), 'running')
    // 有文字 ⇒ 画原文（哪怕还在跑）
    assert.equal(runCardBody('running', '第一版草稿'), 'text')
    assert.equal(runCardBody('completed', '最终稿'), 'text')
    // 跑完了、确实没产出 ⇒ 说"没有产出"（这时候才说得出口）
    assert.equal(runCardBody('completed', undefined), 'empty')
    assert.equal(runCardBody('failed', '   '), 'empty')
    // ⚠️ 反过来：**非终态的空产出绝不能说"没有产出"**——那是假话，与"已启动"矛盾
    assert.notEqual(runCardBody('running', ''), 'empty')
  })
})
