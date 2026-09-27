import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { FileStore } from '@agentdeck/store-file'
import {
  assertCanDeriveRun,
  detectChainCycle,
  depthFromChain,
  withCurrentVerdict,
  loadChainSteps,
  type ChainStep,
} from '@agentdeck/domain'
import { type Action, type Run, type VerdictRecord } from '@agentdeck/protocol'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 回路边界（链路重建 + 环检测 / 深度上限，INV-14~16）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这些测试为什么重要
 * ══════════════════════════════════════════════════════════════════
 *
 * 在补上这一块之前，`issue.assign_agent` 返回的是一个**占位字符串**
 * `pending:<issueId>:<agentId>`：它看起来像"派生成功"，但**没有任何 run 被创建**。
 * 后果是环检测从未被端到端走到过——因为环需要真的有一条链路才存在。
 *
 * 所以这里不测"函数返回了正确的值"，而是**真的把链路建出来**：
 * 写 run、写 verdict、写 action，然后让 `loadChainSteps` 沿
 * `derivedFrom` 把整条链还原回来，再让 `detectChainCycle` / `assertCanDeriveRun`
 * 在域层判出环、拦住超深的那一圈。
 *
 * ⚠️ D41 之后这些域函数在 daemon 侧**没有调用点**了（动作全部来自工具包，而工具
 *    脚本改不了平台数据，于是没有"动作派生新 run"这回事）。它们的实现仍在
 *    `packages/domain/src/loop/*`，这一组用例守的就是那份实现本身——不要因为
 *    暂时没有调用点就把它们删掉：那是**能力的规定**，不是当前接线情况。
 */

const WS = 'ws_loop' as Run['workspaceId']

let dir: string
let store: FileStore

before(async () => {
  dir = await makeTempDir('loop-closure')
  store = await FileStore.open({ dataDir: dir, fsync: false })
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '',
    chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS,
    name: '闭环测试',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
})

after(async () => {
  await store.close()
  await cleanup(dir)
})

/** 造一条 run。 */
async function putRun(
  id: string,
  over: Partial<Run> = {},
): Promise<Run> {
  const now = Date.now()
  const run: Run = {
    id: id as Run['id'],
    workspaceId: WS,
    kind: 'review',
    status: 'completed',
    agentId: 'agent-x' as Run['agentId'],
    subject: { type: 'issue', id: 'issue-1' as never },
    trigger: 'third_party',
    derivedFrom: null,
    chainDepth: 0,
    skillRefs: [],
    workDir: null,
    waitReason: null,
    sessionId: null,
    attempt: 1,
    maxAttempts: 2,
    failureReason: null,
    usage: null,
    queuedAt: now,
    dispatchedAt: now,
    startedAt: now,
    finishedAt: now,
    ...over,
  }
  await store.insertRun(run)
  return run
}

/** 造一条 verdict + 一条由它派生的 action + 那条 action 派生出的 run。 */
async function putVerdictAndAction(input: {
  verdictId: string
  runId: string
  reasonCode: string
  actionId: string
}): Promise<void> {
  const now = Date.now()
  // ⚠️ 用**工具动作名**做夹具（D41 之后动作名只可能是 `<包 slug>.<动作名>` 这个形状；
  //    原来写的 `issue.assign_agent` 连形状都不合法——下划线不在允许字符里）。
  //    这几个 describe 只关心链路数据本身，动作名是什么并不影响断言。
  const actionType = 'example-note.append-note'
  const verdict: VerdictRecord = {
    id: input.verdictId as VerdictRecord['id'],
    workspaceId: WS,
    runId: input.runId as VerdictRecord['runId'],
    subject: { type: 'issue', id: 'issue-1' as never },
    status: 'dispatched_to_action',
    conclusion: 'pass',
    reasonCode: input.reasonCode as VerdictRecord['reasonCode'],
    confidence: 0.9,
    findings: [],
    action: {
      type: actionType,
      params: { issueId: 'issue-1', agentId: 'agent-x' },
    },
    escalateReason: null,
    invalidResolution: null,
    skillRefs: [],
    modelId: null,
    promptHash: null,
    createdAt: now,
  }
  await store.insertVerdict(verdict)

  const action: Action = {
    id: input.actionId as Action['id'],
    workspaceId: WS,
    verdictId: verdict.id,
    type: actionType,
    plane: 'local',
    params: { issueId: 'issue-1', agentId: 'agent-x' },
    status: 'executed',
    idempotencyKey: `k-${input.actionId}`,
    dryRun: false,
    result: null,
    error: null,
    rollbackRef: null,
    createdAt: now,
    finishedAt: now,
  }
  await store.insertAction(action)
}

describe('链路重建（loadChainSteps）', () => {
  test('★ 沿 derivedFrom 往回走，能把整条链还原出来（根在前）', async () => {
    await putRun('r1', { agentId: 'A' as Run['agentId'] })
    await putVerdictAndAction({
      verdictId: 'v1',
      runId: 'r1',
      reasonCode: 'needs_fix',
      actionId: 'a1',
    })
    await putRun('r2', {
      agentId: 'B' as Run['agentId'],
      derivedFrom: 'a1' as Run['derivedFrom'],
      chainDepth: 1,
    })
    await putVerdictAndAction({
      verdictId: 'v2',
      runId: 'r2',
      reasonCode: 'needs_fix',
      actionId: 'a2',
    })
    const r3 = await putRun('r3', {
      agentId: 'A' as Run['agentId'],
      derivedFrom: 'a2' as Run['derivedFrom'],
      chainDepth: 2,
    })

    const steps = await loadChainSteps(store, r3)
    assert.deepEqual(
      steps.map((s) => `${s.agentId}:${s.reasonCode}`),
      // r3 的判决还没写下去 ⇒ 它那一步是 null。这是**真实形状**，不是瑕疵：
      // loadChainSteps 就是在判决落库之前被调用的（见 withCurrentVerdict）。
      ['A:needs_fix', 'B:needs_fix', 'A:null'],
    )
    // 根在前 —— detectChainCycle 按出现顺序判重，顺序错了就抓不到环
    assert.equal(steps[0]?.agentId, 'A')
    assert.equal(depthFromChain(steps), 2, '深度 = 步数 - 1，与 Run.chainDepth 的含义一致')
  })

  test('★ withCurrentVerdict 必须补上刚产出的原因码 —— 否则环永远抓不到', async () => {
    await putRun('w1', { agentId: 'A' as Run['agentId'] })
    await putVerdictAndAction({
      verdictId: 'wv1',
      runId: 'w1',
      reasonCode: 'needs_fix',
      actionId: 'wa1',
    })
    await putRun('w2', {
      agentId: 'B' as Run['agentId'],
      derivedFrom: 'wa1' as Run['derivedFrom'],
      chainDepth: 1,
    })
    await putVerdictAndAction({
      verdictId: 'wv2',
      runId: 'w2',
      reasonCode: 'needs_fix',
      actionId: 'wa2',
    })
    const w3 = await putRun('w3', {
      agentId: 'A' as Run['agentId'],
      derivedFrom: 'wa2' as Run['derivedFrom'],
      chainDepth: 2,
    })

    const raw = await loadChainSteps(store, w3)
    // 裸链路：第三步是 null ⇒ 与第一步配不上，环检测静默失效
    assert.equal(detectChainCycle(raw), null, '这正是那个很隐蔽的失效点')

    // 补上刚产出的原因码之后，第三步与第一步撞上 ⇒ 环被抓到
    const folded = withCurrentVerdict(raw, 'needs_fix')
    const cycle = detectChainCycle(folded)
    assert.ok(cycle, '同一个 agent 再次给出同样的判断，必须被判成环')
    assert.equal(cycle.agentId, 'A')
  })

  test('根 run（没有 derivedFrom）只得到一步', async () => {
    const root = await putRun('r-root', { agentId: 'solo' as Run['agentId'] })
    const steps = await loadChainSteps(store, root)
    assert.equal(steps.length, 1)
    assert.equal(steps[0]?.agentId, 'solo')
    assert.equal(depthFromChain(steps), 0)
  })

  test('★ 数据里有断链（action 引用的 verdict 不存在）时停在那里，不抛异常', async () => {
    await putRun('dangling', {
      agentId: 'A' as Run['agentId'],
      derivedFrom: 'no-such-action' as Run['derivedFrom'],
    })
    const steps = await loadChainSteps(store, await store.getRun('dangling' as Run['id']) as Run)
    assert.equal(steps.length, 1, '走不通就停下——重建失败不该让审核本身失败')
  })

  test('derivedFrom 指回自己时也不会死循环（数据被手改过的兜底）', async () => {
    // 自环：action a-self 的 verdict 属于 run r-self 本身
    await putRun('r-self', {
      agentId: 'A' as Run['agentId'],
      derivedFrom: 'a-self' as Run['derivedFrom'],
    })
    await putVerdictAndAction({
      verdictId: 'v-self',
      runId: 'r-self',
      reasonCode: 'x',
      actionId: 'a-self',
    })

    const steps = await loadChainSteps(store, (await store.getRun('r-self' as Run['id'])) as Run)
    assert.ok(steps.length <= 2, `自环必须被截断，实得 ${steps.length} 步`)
  })
})

describe('★ 环检测：A → B → A 这种短环必须被抓到', () => {
  test('深度小但永远转圈 —— 只看深度是抓不住的', () => {
    const steps: ChainStep[] = [
      { subjectId: 'issue-1', agentId: 'A', reasonCode: 'needs_fix' },
      { subjectId: 'issue-1', agentId: 'B', reasonCode: 'needs_fix' },
      { subjectId: 'issue-1', agentId: 'A', reasonCode: 'needs_fix' },
    ]
    // 这一步的深度只有 2，远没到上限 5
    assert.equal(depthFromChain(steps), 2)
    // 但它是一个环
    const cycle = detectChainCycle(steps)
    assert.ok(cycle, '同样的 agent 在同样的对象上给出同样的原因码两次 ⇒ 这是环')
    assert.equal(cycle.agentId, 'A')
    assert.throws(() => assertCanDeriveRun(steps), /回路/)
  })

  test('原因码在推进时不算环 —— 真的在做事的链路不能被误判', () => {
    const steps: ChainStep[] = [
      { subjectId: 'issue-1', agentId: 'A', reasonCode: 'missing_tests' },
      { subjectId: 'issue-1', agentId: 'B', reasonCode: 'flaky_test' },
      { subjectId: 'issue-1', agentId: 'A', reasonCode: 'style' },
    ]
    assert.equal(detectChainCycle(steps), null)
    assert.doesNotThrow(() => assertCanDeriveRun(steps))
  })
})

// ─────────────────────────────────────────────────────────────
// ⚠️ 这里原本还有一个 describe「动作派生的真实闭环（ActionRunner.deriveRun）」，
//    5 条用例（以及只服务于它们的局部助手 `runnerWith` / `makeIssue` /
//    `makeAgent`）已经**整块删掉**。它们守的是：
//
//      · 指派动作真的调用派生回调，并把返回的 runId 如实带回来；
//      · 派生回调返回 null 时如实记 null，而不是编一个 id；
//      · 环上不再派生，但指派照常成功、且发出一条可读通知；
//      · 深度超限与环被区分开（`derivationBlocked.reason` 是 `depth` 还是 `cycle`）；
//      · 不能把 issue 指派给刚做出该判决的 agent（INV-1）。
//
// `issue.assign_agent` 的"指派 + 派生一条新 run"已经不在平台内（D41：动作全部
// 来自工具包，而工具脚本改不了平台数据）。环检测/深度上限的域实现
// （`packages/domain/src/loop/*`）仍在，只是 daemon 侧没有调用点了。
//
// 也就是说：`ActionRunner` 不再有 `deriveRun` 回调，`ExecuteActionInput` 不再有
// `chainSteps`，`ExecuteActionResult` 不再有 `spawnedRunId` / `derivationBlocked`。
// 上面两个 describe 守的是**域函数**本身（`loadChainSteps` / `withCurrentVerdict` /
// `detectChainCycle` / `assertCanDeriveRun` / `depthFromChain`），它们仍然存在、
// 仍然要测，所以原样保留。
// ─────────────────────────────────────────────────────────────
