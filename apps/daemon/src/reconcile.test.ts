import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { FileStore } from '@agentdeck/store-file'
import { ulid, type Run } from '@agentdeck/protocol'
import { reconcileInterruptedRuns } from './reconcile.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 重启后的遗留 run 处置（FR-RUNTIME-11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事不能省
 * ══════════════════════════════════════════════════════════════════
 *
 * run 状态是**持久化**的。daemon 被 Ctrl-C 或崩掉之后，当时正在跑的 run
 * 会留在 `running` 这类非终态上——没有任何人有机会把它们改成终态。
 *
 * 下次启动如果什么都不做，看板会**永远**把它们显示成"进行中"，
 * 统计会把它们算成在途，使用者会去等一个不会有结果的东西。
 *
 * 这比一个明确的"失败了"糟得多，因为**失败至少是确定的**。
 */

const WS = 'ws_reconcile' as Run['workspaceId']

let dir: string
let store: FileStore

before(async () => {
  dir = await makeTempDir('reconcile')
  store = await FileStore.open({ dataDir: dir, fsync: false })
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '',
    chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS, name: 'w', createdAt: 1, updatedAt: 1 })
})

after(async () => {
  await store.close()
  await cleanup(dir)
})

async function putRun(id: string, status: Run['status']): Promise<Run> {
  const now = Date.now()
  const run: Run = {
    id: id as Run['id'],
    workspaceId: WS,
    kind: 'execute',
    status: 'queued',
    agentId: 'ag' as Run['agentId'],
    subject: { type: 'issue', id: 'issue-1' as never },
    trigger: 'assignment',
    derivedFrom: null,
    chainDepth: 0,
    skillRefs: [],
    workDir: '/tmp/work',
    waitReason: null,
    sessionId: null,
    attempt: 1,
    maxAttempts: 2,
    failureReason: null,
    usage: null,
    queuedAt: now,
    dispatchedAt: null,
    startedAt: null,
    finishedAt: null,
  }
  await store.insertRun(run)
  if (status !== 'queued') {
    // 走到目标状态：queued → dispatched → running（或 waiting_local_directory）
    await store.transitionRun(run.id, 'queued', 'dispatched', { dispatchedAt: now })
    if (status === 'running') {
      await store.transitionRun(run.id, 'dispatched', 'running', { startedAt: now })
    } else if (status === 'waiting_local_directory') {
      await store.transitionRun(run.id, 'dispatched', 'waiting_local_directory', {
        waitReason: '/tmp/work 被占用',
      })
    }
  }
  return (await store.getRun(run.id)) as Run
}

describe('★ 收口上次遗留的非终态 run', () => {
  test('★ 停在 running 的 run 必须被收口，不能永远显示成"进行中"', async () => {
    const run = await putRun(ulid(), 'running')
    const result = await reconcileInterruptedRuns({ store })

    assert.ok(
      result.interrupted.some((i) => i.runId === run.id),
      '★ 收口列表里必须有它',
    )
    const after = await store.getRun(run.id)
    assert.equal(after?.status, 'failed')
    assert.equal(
      after?.failureReason,
      'daemon_restarted',
      '失败原因要**具体**——"daemon_restarted" 让人知道该重跑，而不是去查代码',
    )
    assert.notEqual(after?.finishedAt, null, '必须有结束时间，否则统计仍会把它当在途')
  })

  test('★ dispatched 与 waiting_local_directory 同样要被收口', async () => {
    const dispatched = await putRun(ulid(), 'dispatched')
    const waiting = await putRun(ulid(), 'waiting_local_directory')
    await reconcileInterruptedRuns({ store })

    assert.equal((await store.getRun(dispatched.id))?.status, 'failed')
    assert.equal((await store.getRun(waiting.id))?.status, 'failed')
  })

  test('queued 也要收口（它同样永远不会有结果）', async () => {
    const queued = await putRun(ulid(), 'queued')
    await reconcileInterruptedRuns({ store })
    assert.equal((await store.getRun(queued.id))?.status, 'failed')
  })

  test('★ 终态 run 不受影响 —— 收口不能改写历史', async () => {
    const done = await putRun(ulid(), 'running')
    await store.transitionRun(done.id, 'running', 'completed', { finishedAt: Date.now() })

    await reconcileInterruptedRuns({ store })
    const after = await store.getRun(done.id)
    assert.equal(after?.status, 'completed', 'DR-3：历史不得被覆盖')
    assert.equal(after?.failureReason, null)
  })

  test('★ 通知汇总是**一条**，不是每个 run 一条（INV-8：通知必须稀缺）', async () => {
    const d = await makeTempDir('reconcile-notice')
    const s = await FileStore.open({ dataDir: d, fsync: false })
    const W = 'ws_notice' as Run['workspaceId']
    await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '',
    chatTemplate: '', defaultAgentId: null, locale: 'zh', id: W, name: 'w', createdAt: 1, updatedAt: 1 })

    for (let i = 0; i < 5; i += 1) {
      const id = ulid() as Run['id']
      await s.insertRun({
        id,
        workspaceId: W,
        kind: 'execute',
        status: 'queued',
        agentId: 'ag' as never,
        subject: { type: 'issue', id: 'i' as never },
        trigger: 'assignment',
        derivedFrom: null,
        chainDepth: 0,
        skillRefs: [],
        workDir: '/w',
        waitReason: null,
        sessionId: null,
        attempt: 1,
        maxAttempts: 2,
        failureReason: null,
        usage: null,
        queuedAt: 1,
        dispatchedAt: null,
        startedAt: null,
        finishedAt: null,
      })
    }

    const result = await reconcileInterruptedRuns({ store: s })
    assert.equal(result.interrupted.length, 5)
    assert.equal(result.notices, 1, '★ 5 个 run 只发 1 条汇总通知')

    const inbox = await s.listInboxItems({ workspaceId: W, limit: 50 })
    assert.equal(inbox.length, 1)
    assert.match(inbox[0]!.title, /5 个执行/)
    // ⚠️ 这里原来钉的是 `/无法续跑|没有落盘/`。2026-09 改写正文时把"落盘"换成了
    //    "存到盘上"（那是我们代码里的说法），所以断言跟着改——意图没变：
    //    **要解释为什么接不上**。
    assert.match(inbox[0]!.body, /接不上|没有存到盘上/, '要解释为什么不能续跑')
    assert.match(inbox[0]!.body, /重新发起/, '要给出可行动的下一步')

    await s.close()
    await cleanup(d)
  })

  test('没有遗留 run 时什么都不做，也不发通知', async () => {
    const d = await makeTempDir('reconcile-empty')
    const s = await FileStore.open({ dataDir: d, fsync: false })
    await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '',
    chatTemplate: '', defaultAgentId: null, locale: 'zh', id: 'ws_empty_r' as Run['workspaceId'], name: 'w', createdAt: 1, updatedAt: 1 })

    const result = await reconcileInterruptedRuns({ store: s })
    assert.deepEqual(result.interrupted, [])
    assert.equal(result.notices, 0)

    await s.close()
    await cleanup(d)
  })

  test('★ 收口是幂等的 —— 再跑一次不会重复发通知', async () => {
    const d = await makeTempDir('reconcile-twice')
    const s = await FileStore.open({ dataDir: d, fsync: false })
    const W = 'ws_twice' as Run['workspaceId']
    await s.insertWorkspace({ executeTemplate: '', reviewTemplate: '',
    chatTemplate: '', defaultAgentId: null, locale: 'zh', id: W, name: 'w', createdAt: 1, updatedAt: 1 })
    await s.insertRun({
      id: ulid() as Run['id'],
      workspaceId: W,
      kind: 'execute',
      status: 'queued',
      agentId: 'ag' as never,
      subject: { type: 'issue', id: 'i' as never },
      trigger: 'assignment',
      derivedFrom: null,
      chainDepth: 0,
      skillRefs: [],
      workDir: '/w',
      waitReason: null,
      sessionId: null,
      attempt: 1,
      maxAttempts: 2,
      failureReason: null,
      usage: null,
      queuedAt: 1,
      dispatchedAt: null,
      startedAt: null,
      finishedAt: null,
    })

    const first = await reconcileInterruptedRuns({ store: s })
    const second = await reconcileInterruptedRuns({ store: s })
    assert.equal(first.interrupted.length, 1)
    assert.equal(second.interrupted.length, 0, '第二次没有可收口的了')
    assert.equal((await s.listInboxItems({ workspaceId: W, limit: 50 })).length, 1)

    await s.close()
    await cleanup(d)
  })
})
