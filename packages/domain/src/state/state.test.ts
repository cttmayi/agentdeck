import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { RunStatus } from '@agentdeck/protocol'
import {
  allowedRunTransitions,
  assertRunTransition,
  canTransitionRun,
  statusAfterDispatch,
} from './run.ts'
import {
  assertVerdictTransition,
  canTransitionVerdict,
  verdictStatusForResolution,
} from './verdict.ts'
import {
  actionIdempotencyKey,
  assertActionTransition,
  canTransitionAction,
  stableStringify,
} from './action.ts'
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

describe('Verdict 生命周期', () => {
  test('正常路径 pending → emitted → validated → dispatched_to_action', () => {
    assert.equal(canTransitionVerdict('pending_verdict', 'emitted'), true)
    assert.equal(canTransitionVerdict('emitted', 'validated'), true)
    assert.equal(canTransitionVerdict('validated', 'dispatched_to_action'), true)
  })

  test('★ invalid 是独立失败类型，且有三条处置路径', () => {
    assert.equal(canTransitionVerdict('emitted', 'invalid'), true)
    assert.equal(canTransitionVerdict('invalid', 'pending_verdict'), true) // retry
    assert.equal(canTransitionVerdict('invalid', 'advisory'), true) // 降级
    assert.equal(canTransitionVerdict('invalid', 'escalated'), true) // 升级
  })

  test('validated 不能直接进 invalid（已经是终局判定）', () => {
    assert.equal(canTransitionVerdict('validated', 'invalid'), false)
  })

  test('三条处置路径映射到正确状态', () => {
    assert.equal(verdictStatusForResolution('retry'), 'pending_verdict')
    assert.equal(verdictStatusForResolution('downgrade_to_advisory'), 'advisory')
    assert.equal(verdictStatusForResolution('escalate'), 'escalated')
  })

  test('非法转移抛错', () => {
    assert.throws(() => assertVerdictTransition('advisory', 'validated'))
  })
})

describe('Action 生命周期', () => {
  test('默认路径是自动批准（INV-4）', () => {
    assert.equal(canTransitionAction('proposed', 'auto_approved'), true)
    assert.equal(canTransitionAction('auto_approved', 'executing'), true)
    assert.equal(canTransitionAction('executing', 'executed'), true)
  })

  test('等待批准是例外路径，且仍可转回自动批准', () => {
    assert.equal(canTransitionAction('proposed', 'awaiting_approval'), true)
    assert.equal(canTransitionAction('awaiting_approval', 'auto_approved'), true)
  })

  test('幂等命中进 skipped（可见，不是静默成功）', () => {
    assert.equal(canTransitionAction('proposed', 'skipped'), true)
    assert.equal(canTransitionAction('auto_approved', 'skipped'), true)
  })

  test('已执行的动作可以事后回滚', () => {
    assert.equal(canTransitionAction('executed', 'rolled_back'), true)
  })

  test('终态没有出边', () => {
    for (const s of ['failed', 'rolled_back', 'skipped'] as const) {
      assert.equal(canTransitionAction(s, 'executing'), false)
    }
  })

  test('非法转移抛错', () => {
    assert.throws(() => assertActionTransition('skipped', 'executing'))
  })
})

describe('动作幂等键', () => {
  // ⚠️ D41：这两条用到的动作名只是**幂等键的夹具**（主体是"键里含哪些东西"），
  //    所以换成形状合法的工具动作名 `<包 slug>.<动作名>`——平台的内置动作已经
  //    全部移除，`issue.update_status` / `comment.create` 那种内置名在平台里
  //    不再可能出现（`<slug>.<name>` 才是唯一形状）。断言一字未改。
  test('★ 含 verdictId：不同判决的相同动作不会被去重（多视角审核，FR-AGENT-21）', () => {
    const base = { type: 'fixture-tool.act', params: { text: 'todo' } }
    const a = actionIdempotencyKey({ verdictId: 'v1', ...base })
    const b = actionIdempotencyKey({ verdictId: 'v2', ...base })
    assert.notEqual(a, b, '两个不同的 verdict 产生同一动作，必须得到不同的幂等键')
  })

  test('同一判决重放得到同一幂等键（会被去重）', () => {
    const input = { verdictId: 'v1', type: 'other-tool.act', params: { text: 'x' } }
    assert.equal(actionIdempotencyKey(input), actionIdempotencyKey({ ...input }))
  })

  test('参数键顺序不影响幂等键', () => {
    const a = actionIdempotencyKey({
      verdictId: 'v1',
      type: 't',
      params: { b: 2, a: 1 },
    })
    const b = actionIdempotencyKey({
      verdictId: 'v1',
      type: 't',
      params: { a: 1, b: 2 },
    })
    assert.equal(a, b)
  })

  test('stableStringify 递归排序，且忽略 undefined', () => {
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
    assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}')
    assert.equal(stableStringify([3, 1, 2]), '[3,1,2]')
    assert.equal(stableStringify(null), 'null')
    assert.equal(stableStringify('x'), '"x"')
  })
})
