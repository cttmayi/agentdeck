import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunStatus } from '@agentdeck/protocol'
import {
  allowedRunTransitions,
  assertRunTransition,
  canTransitionRun,
  statusAfterDispatch,
} from './run.ts'
/*
 * ⚠️ 2026-11（D125）：这里原来还 import 了 './verdict.ts' 的三个东西
 *   （`assertVerdictTransition` / `canTransitionVerdict` /
 *   `verdictStatusForResolution`）。判决退场 ⇒ 那份状态机整份删掉。
 */
/*
 * ⚠️ 2026-11（D123）：这里原来还 import 了 './action.ts' 的四个东西
 *   （`actionIdempotencyKey` / `assertActionTransition` / `canTransitionAction` /
 *   `stableStringify`）。动作记录退场 ⇒ 那份状态机整份删掉，这里随之删；
 *   它的两组用例（「Action 生命周期」「动作幂等键」，后者含 `stableStringify`）
 *   也一并删了——守着已不存在的东西的用例，比没有用例更坏。
 */
import { DomainError, DomainErrorCode, IllegalTransitionError } from '../errors.ts'

describe('Run 状态机', () => {
  test('正常路径：queued → dispatched → running → completed', () => {
    assert.equal(canTransitionRun('queued', 'dispatched'), true)
    assert.equal(canTransitionRun('dispatched', 'running'), true)
    assert.equal(canTransitionRun('running', 'completed'), true)
  })

  test('deferred 到点后进入 queued', () => {
    assert.equal(canTransitionRun('deferred', 'queued'), true)
    assert.equal(canTransitionRun('deferred', 'running'), false)
  })

  test('目录被占用时停放，释放后回队列（不失败）', () => {
    assert.equal(canTransitionRun('dispatched', 'waiting_local_directory'), true)
    assert.equal(canTransitionRun('waiting_local_directory', 'queued'), true)
  })

  test('任意态都可被取消', () => {
    const states: RunStatus[] = [
      'deferred',
      'queued',
      'dispatched',
      'waiting_local_directory',
      'running',
    ]
    for (const s of states) {
      assert.equal(canTransitionRun(s, 'cancelled'), true, `${s} 应可取消`)
    }
  })

  test('★ 终态没有出边——重试是新建 run，不是复活旧记录（DR-3）', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      assert.deepEqual(allowedRunTransitions(s), [], `${s} 不应有出边`)
      assert.equal(canTransitionRun(s, 'running'), false)
      assert.equal(canTransitionRun(s, 'queued'), false)
    }
  })

  test('非法转移抛错，且错误带机器可读 code', () => {
    assert.throws(
      () => assertRunTransition('completed', 'running'),
      (err: unknown) => {
        assert.ok(err instanceof IllegalTransitionError)
        assert.equal(err.code, DomainErrorCode.IllegalTransition)
        assert.ok(err instanceof DomainError)
        return true
      },
    )
  })

  test('statusAfterDispatch：目录空闲则直接 running', () => {
    assert.equal(statusAfterDispatch(false), 'running')
  })

  test('statusAfterDispatch：目录被占则停放，而不是失败', () => {
    assert.equal(statusAfterDispatch(true), 'waiting_local_directory')
  })
})

/*
 * ⚠️ 2026-11（D125）：这里原来是「Verdict 生命周期」——判决状态机（pending →
 * emitted → validated → dispatched_to_action / invalid 的三条处置路径，以及
 * "非法转移要抛而不是静默"）。
 *
 *   判决退场 ⇒ 整组用例删。
 *
 *   ⚠️ 其中一条规则没有过期，它是这套状态机最值钱的地方：**`invalid` 是独立的
 *   失败类型，不是"随便哪一档都能回退"**——`validated` 不能回到 `invalid`，
 *   因为那已经是终局判定。同一件事在 `run.ts` 那边还守着。
 */
