import { after, before, describe, test } from 'node:test'
import { deliveredText } from './testing/delivered.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { VERDICT_FENCE_BEGIN, VERDICT_FENCE_END, ulid, type RunId } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 智能体组（D70 增量添加）的端到端测试。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一版是**增量**：老路径（执行者「由谁审它」+ 审核者「行动权限」）一行没改，
 * 组是另一条入口。所以测试分两组：
 *   · A 组：组的 CRUD 与写入口校验（形态 / 成员 / 动作 / 停用）；
 *   · B 组：提交 run 带 `groupId` 的**展开**——执行者、审核者、动作、返工
 *     次数全部默认从组取，且**跑的是同一条老链路**（真的派生审核 run、真的
 *     落库）。
 *
 * 为什么走真实链路：`POST /api/runs` 的展开发生在 `executor.submit()` 之前，
 * 展开后的字段要一路跟到 `Run.reviewerAgentId` / `Run.allowedActions` /
 * `Run.maxReworks` / `Run.groupId` 才算数——纯函数单测看不见这一整段。
 *
 * **NFR-T-01：绝不调用使用者真实安装的 agent CLI。** 假后端 + 真 HTTP。
 */

const PASS_VERDICT: Record<string, unknown> = {
  schemaVersion: 1,
  conclusion: 'pass',
  reasonCode: 'meets_criteria',
  confidence: 0.9,
  findings: [],
  action: null,
  escalateReason: null,
}

/** 假 CLI：执行说人话，审核吐合法判决。判据是"有没有判决围栏"。 */
class GroupBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = false

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    const text = deliveredText(opts)
    const isReview = text.includes(VERDICT_FENCE_BEGIN)
    const body = isReview
      ? `结论：\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(PASS_VERDICT)}\n${VERDICT_FENCE_END}\n`
      : '我做完了这件事。'
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: body })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed' as const,
        output: body,
        error: null,
        durationMs: 3,
        sessionId: isReview ? 'review-session' : 'exec-session',
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' as const },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

interface Harness {
  daemon: DaemonHandle
  backend: GroupBackend
  url: string
  workDir: string
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const dir = await makeTempDir('groups')
  const backend = new GroupBackend()
  const daemon = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    workRoot: join(dir, 'workroot'),
    backend,
    onWarn: () => {},
    onInfo: () => {},
    scriptRuntimePath: process.execPath,
  })
  return {
    daemon,
    backend,
    url: daemon.url,
    workDir: join(dir, 'workroot'),
    async close() {
      await daemon.close()
      await cleanup(dir)
    },
  }
}

let h: Harness
before(async () => {
  h = await startHarness()
})
after(async () => {
  await h.close()
})

async function createAgent(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${h.url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeKey: 'claude', instructions: '按标准判断', ...body }),
  })
  const created = (await res.json()) as { id?: string }
  assert.equal(res.status, 201, `建 agent 失败：${JSON.stringify(created)}`)
  assert.ok(created.id)
  return created.id
}

async function createGroup(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.url}/api/agent-groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function patchGroup(id: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.url}/api/agent-groups/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function listGroups(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${h.url}/api/agent-groups`)
  return ((await res.json()) as { groups: Array<Record<string, unknown>> }).groups
}

async function submitRun(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function getRunRecord(runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.url}/api/runs/${runId}`)
  return (await res.json()) as Record<string, unknown>
}

async function until<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function derivedReviewRuns(executeRunId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${h.url}/api/runs`)
  const list = (await res.json()) as { runs: Array<Record<string, unknown>> }
  // ⚠️ 不能按 kind === 'review' 全局找：同一个 daemon 里可能躺着别的用例的审核 run，
  //    那样断言会匹配到**别人的**审核。按 subject 过滤（审核 run 的 subject 是
  //    {type:'run', id}）。
  return list.runs.filter((r) => {
    const subject = r.subject as { type?: string; id?: string } | undefined
    return subject?.type === 'run' && subject.id === executeRunId && r.kind === 'review'
  })
}

describe('智能体组：CRUD 与写入口校验', () => {
  test('建组（1 执行 + 1 审核）→ 201；列表可见', async () => {
    const executor = await createAgent({ name: '执行者 G1', role: 'executor' })
    const reviewer = await createAgent({ name: '审核者 G1', role: 'reviewer' })
    const res = await createGroup({
      name: '组 G1',
      members: [executor, reviewer],
      allowedActions: [],
      actionParams: {},
      debugActions: [],
      maxReworks: 1,
      enabled: true,
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const id = (res.body as { group: { id: string } }).group.id
    assert.ok(id)

    const groups = await listGroups()
    const found = groups.find((g) => g.id === id)
    assert.ok(found, '列表里应该有这条组')
    assert.equal(found['name'], '组 G1')
    assert.equal(found['maxReworks'], 1)
    assert.deepEqual(found['members'], [executor, reviewer])
  })

  test('形态不对（两个执行者）⇒ 400，报出几个、是谁', async () => {
    const e1 = await createAgent({ name: '执行者 E1', role: 'executor' })
    const e2 = await createAgent({ name: '执行者 E2', role: 'executor' })
    const r = await createAgent({ name: '审核者 R', role: 'reviewer' })
    const res = await createGroup({ name: '坏组', members: [e1, e2, r] })
    assert.equal(res.status, 400)
    assert.match(String(res.body['error']), /2 个执行者/)
    assert.match(String(res.body['error']), /执行者 E2/)
  })

  test('没有审核者 ⇒ 400，报"没有审核者"', async () => {
    const e = await createAgent({ name: '执行者 E3', role: 'executor' })
    const res = await createGroup({ name: '坏组2', members: [e] })
    assert.equal(res.status, 400)
    assert.match(String(res.body['error']), /没有审核者/)
  })

  test('成员不存在 ⇒ 400，报出 id', async () => {
    const e = await createAgent({ name: '执行者 E4', role: 'executor' })
    const res = await createGroup({ name: '坏组3', members: [e, 'ghost-id'] })
    assert.equal(res.status, 400)
    assert.match(String(res.body['error']), /ghost-id/)
  })

  test('动作来自没装的包 ⇒ 400（与 agents 同一套"为什么拒"）', async () => {
    const e = await createAgent({ name: '执行者 E5', role: 'executor' })
    const r = await createAgent({ name: '审核者 R5', role: 'reviewer' })
    const res = await createGroup({
      name: '坏组4',
      members: [e, r],
      allowedActions: ['fake-tool.hello'],
    })
    assert.equal(res.status, 400)
    assert.match(String(res.body['error']), /还没安装/)
  })

  test('PATCH：改名 / 换审核者 / 改返工次数；未知字段被拒', async () => {
    const e = await createAgent({ name: '执行者 E6', role: 'executor' })
    const r1 = await createAgent({ name: '审核者 R6a', role: 'reviewer' })
    const r2 = await createAgent({ name: '审核者 R6b', role: 'reviewer' })
    const created = await createGroup({ name: '组 G6', members: [e, r1] })
    const id = (created.body as { group: { id: string } }).group.id

    const patched = await patchGroup(id, { name: '组 G6 改名', members: [e, r2], maxReworks: 3 })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const g = (patched.body as { group: Record<string, unknown> }).group
    assert.equal(g['name'], '组 G6 改名')
    assert.deepEqual(g['members'], [e, r2])
    assert.equal(g['maxReworks'], 3)

    const unknown = await patchGroup(id, { frobnicate: 1 })
    assert.equal(unknown.status, 400)
    assert.match(String(unknown.body['error']), /frobnicate/)
  })

  test('maxReworks：0–100 与 null（无限）往返；越界值被拒', async () => {
    const e = await createAgent({ name: '执行者 E6b', role: 'executor' })
    const r = await createAgent({ name: '审核者 R6b', role: 'reviewer' })

    // 有限上限内（100）与越界（101）都要走同一条校验。
    const created = await createGroup({ name: '组 G6b', members: [e, r], maxReworks: 100 })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal((created.body as { group: Record<string, unknown> }).group['maxReworks'], 100)

    // null = 无限返工：建组、改回有限、再改回 null，都要原样落库。
    const id = (created.body as { group: { id: string } }).group.id
    const unlim = await patchGroup(id, { maxReworks: null })
    assert.equal(unlim.status, 200, JSON.stringify(unlim.body))
    assert.equal((unlim.body as { group: Record<string, unknown> }).group['maxReworks'], null)

    const finite = await patchGroup(id, { maxReworks: 20 })
    assert.equal(finite.status, 200)
    assert.equal((finite.body as { group: Record<string, unknown> }).group['maxReworks'], 20)

    const again = await patchGroup(id, { maxReworks: null })
    assert.equal(again.status, 200)
    assert.equal((again.body as { group: Record<string, unknown> }).group['maxReworks'], null)

    for (const bad of [-1, 101, 1.5]) {
      const res = await patchGroup(id, { maxReworks: bad })
      assert.equal(res.status, 400, `${bad} 应当被拒`)
    }
  })

  test('DELETE → 200；再查列表为空', async () => {
    const e = await createAgent({ name: '执行者 E7', role: 'executor' })
    const r = await createAgent({ name: '审核者 R7', role: 'reviewer' })
    const created = await createGroup({ name: '组 G7', members: [e, r] })
    const id = (created.body as { group: { id: string } }).group.id

    const res = await fetch(`${h.url}/api/agent-groups/${id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const groups = await listGroups()
    assert.ok(!groups.some((g) => g.id === id), '删掉的组不应还在列表里')
  })
})

describe('智能体组：提交 run 的展开', () => {
  test('带 groupId ⇒ 展开：执行者/审核者/动作/返工全部来自组，Run.groupId 记录', async () => {
    const executor = await createAgent({ name: '执行者 B1', role: 'executor' })
    const reviewer = await createAgent({ name: '审核者 B1', role: 'reviewer' })
    const created = await createGroup({
      name: '组 B1',
      members: [executor, reviewer],
      allowedActions: [],
      actionParams: {},
      debugActions: [],
      maxReworks: 2,
      enabled: true,
    })
    const groupId = (created.body as { group: { id: string } }).group.id

    const runId = ulid() as RunId
    const res = await submitRun({
      runId,
      kind: 'execute',
      groupId,
      agentRef: { id: executor, name: '执行者 B1', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-gb1' },
      prompt: '用组 B1 跑这件事',
      workDir: h.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(res.status, 202, JSON.stringify(res.body))

    // 展开后的字段必须真的落库（且只有显式覆盖时才不跟随组）
    const run = await getRunRecord(runId as string)
    assert.equal(run['agentId'], executor)
    assert.equal(run['reviewerAgentId'], reviewer, '审核者应默认来自组')
    assert.equal(run['maxReworks'], 2, '返工次数应默认来自组')
    assert.equal(run['groupId'], groupId, 'groupId 要记录，供"这条任务是哪队人"回查')
  })

  test('带 groupId + 显式换审核者 ⇒ 覆盖组的审核者（三态覆盖纪律）', async () => {
    const executor = await createAgent({ name: '执行者 B2', role: 'executor' })
    const groupReviewer = await createAgent({ name: '组审核者 B2', role: 'reviewer' })
    const overrideReviewer = await createAgent({ name: '临时审核者 B2', role: 'reviewer' })
    const created = await createGroup({ name: '组 B2', members: [executor, groupReviewer] })
    const groupId = (created.body as { group: { id: string } }).group.id

    const runId = ulid() as RunId
    const res = await submitRun({
      runId,
      kind: 'execute',
      groupId,
      reviewerAgentId: overrideReviewer,
      agentRef: { id: executor, name: '执行者 B2', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-gb2' },
      prompt: '这次换人审',
      workDir: h.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(res.status, 202, JSON.stringify(res.body))

    const run = await getRunRecord(runId as string)
    assert.equal(run['reviewerAgentId'], overrideReviewer, '显式换人应盖过组的审核者')
    assert.equal(run['groupId'], groupId, '换人后 groupId 仍记录（覆盖体现在展开字段上）')
  })

  test('agentRef 的执行者 ≠ 组的执行者 ⇒ 400 group_executor_mismatch', async () => {
    const executor = await createAgent({ name: '组执行者 B3', role: 'executor' })
    const other = await createAgent({ name: '别人执行者 B3', role: 'executor' })
    const reviewer = await createAgent({ name: '审核者 B3', role: 'reviewer' })
    const created = await createGroup({ name: '组 B3', members: [executor, reviewer] })
    const groupId = (created.body as { group: { id: string } }).group.id

    const res = await submitRun({
      runId: ulid() as RunId,
      kind: 'execute',
      groupId,
      agentRef: { id: other, name: '别人执行者 B3', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-gb3' },
      prompt: '组与手动执行者矛盾',
      workDir: h.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(res.status, 400)
    assert.equal(res.body['code'], 'group_executor_mismatch')
  })

  test('组已停用 ⇒ 400 group_disabled', async () => {
    const executor = await createAgent({ name: '执行者 B4', role: 'executor' })
    const reviewer = await createAgent({ name: '审核者 B4', role: 'reviewer' })
    const created = await createGroup({ name: '组 B4', members: [executor, reviewer] })
    const groupId = (created.body as { group: { id: string } }).group.id
    await patchGroup(groupId, { enabled: false })

    const res = await submitRun({
      runId: ulid() as RunId,
      kind: 'execute',
      groupId,
      agentRef: { id: executor, name: '执行者 B4', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-gb4' },
      prompt: '停用的组不可选',
      workDir: h.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(res.status, 400)
    assert.equal(res.body['code'], 'group_disabled')
  })

  test('组不存在 ⇒ 400 group_not_found', async () => {
    const executor = await createAgent({ name: '执行者 B5', role: 'executor' })
    const res = await submitRun({
      runId: ulid() as RunId,
      kind: 'execute',
      groupId: 'ghost-group',
      agentRef: { id: executor, name: '执行者 B5', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-gb5' },
      prompt: '不存在的组',
      workDir: h.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(res.status, 400)
    assert.equal(res.body['code'], 'group_not_found')
  })

  test('真实链路：组执行 run 完成 ⇒ 真的派生审核 run，审核者就是组的审核者', async () => {
    const executor = await createAgent({ name: '执行者 B6', role: 'executor' })
    const reviewer = await createAgent({ name: '审核者 B6', role: 'reviewer', instructions: '按标准判' })
    const created = await createGroup({ name: '组 B6', members: [executor, reviewer] })
    const groupId = (created.body as { group: { id: string } }).group.id

    const runId = ulid() as RunId
    const res = await submitRun({
      runId,
      kind: 'execute',
      groupId,
      agentRef: { id: executor, name: '执行者 B6', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-gb6' },
      prompt: '跑完要被组 B6 审',
      workDir: h.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(res.status, 202, JSON.stringify(res.body))

    const review = await until(
      async () => (await derivedReviewRuns(runId as string))[0] ?? null,
      `run ${runId} 派生审核`,
    )
    assert.equal(review['agentId'], reviewer, '派生出来的审核 run 应使用组的审核者')
  })
})

// ══════════════════════════════════════════════════════════════════════
// 第二轮（2026 续）：工作流模式 + 私有智能体
// ══════════════════════════════════════════════════════════════════════
//
// 使用者拍板：组有模式（现在只有 'workflow'）；成员可以是全局 agent，也可以是
// **私有**的（归属组：不进全局列表、不能当默认、随组删）。这里守的是：
//
//   · mode 只在创建时写（PATCH 不认它）；省略即 'workflow'；
//   · `createAgents` 是组的私有成员创建入口——一次请求建组 + 建私有 agent +
//     并进 members，形态不对时**一个都不建**；
//   · 私有 agent 不在 `GET /api/agents` 里，但组的接口带着它们（界面上才查得到）；
//   · 私有执行者/审核者走真实 run 链路（展开 → 派生审核）与全局成员一样；
//   · 删组按 `ownerGroupId` 级联删私有成员。

describe('智能体组（第二轮）：工作流模式', () => {
  test('★ daemon 上报 agent-groups-workflow 能力（前端「新建私有」的门控；忘了注册前端就一直看不到）', async () => {
    const idRes = await fetch(`${h.url}/api/identity`)
    const id = (await idRes.json()) as { capabilities: string[] }
    assert.ok(id.capabilities.includes('agent-groups'), '组能力要在')
    assert.ok(id.capabilities.includes('agent-groups-workflow'), '工作流能力要在——否则前端藏起「新建私有」')
  })

  test('★ 建组默认 mode=workflow；显式传 mode 也收；PATCH 不认 mode（未知字段拒绝）', async () => {
    const executor = await createAgent({ name: '执行者 M1', role: 'executor' })
    const reviewer = await createAgent({ name: '审核者 M1', role: 'reviewer' })
    const created = await createGroup({ name: '组 M1', members: [executor, reviewer] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const group = (created.body as { group: Record<string, unknown> }).group
    assert.equal(group['mode'], 'workflow', '省略 mode ⇒ 默认 workflow')

    const created2 = await createGroup({
      name: '组 M1b',
      mode: 'workflow',
      members: [executor, reviewer],
    })
    assert.equal(created2.status, 201, JSON.stringify(created2.body))

    const patch = await patchGroup(group['id'] as string, { mode: 'workflow' })
    assert.equal(patch.status, 400)
    assert.match(patch.body['error'] as string, /不认识的字段.*mode/)
  })

  test('★ 全私有组：members=[] + createAgents(执行+审核草稿) ⇒ 一次请求建成，私有 agent 归属组', async () => {
    const res = await createGroup({
      name: '组 M2 全私有',
      members: [],
      createAgents: [
        { name: '私有执行者', role: 'executor', instructions: '干活', runtimeKey: 'claude', skillIds: [] },
        {
          name: '私有审核者',
          role: 'reviewer',
          instructions: '按标准判',
          reviewStandard: { name: '标准', body: '认真看' },
          runtimeKey: 'claude',
          skillIds: [],
        },
      ],
    })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    const { group, members } = res.body as { group: Record<string, unknown>; members: Array<Record<string, unknown>> }
    assert.equal((group['members'] as string[]).length, 2)
    assert.equal(members.length, 2)
    for (const m of members) {
      assert.equal(m['ownerGroupId'], group['id'], '私有成员必须归属这个组')
    }
    // 私有 agent 不进全局列表
    const agentsRes = await fetch(`${h.url}/api/agents`)
    const agentsBody = (await agentsRes.json()) as { agents: Array<{ id: string }> }
    for (const m of members) {
      assert.ok(!agentsBody.agents.some((a) => a.id === m['id']), '私有 agent 不应出现在全局列表')
    }
  })

  test('★ 形态不对 ⇒ 草稿一个都不建（组 POST 拒绝，不留下孤儿私有 agent）', async () => {
    const executor = await createAgent({ name: '执行者 M3', role: 'executor' })
    const bad = await createGroup({
      name: '组 M3 坏形态',
      members: [executor],
      createAgents: [{ name: '第二个执行者', role: 'executor', instructions: 'x', runtimeKey: 'claude', skillIds: [] }],
    })
    assert.equal(bad.status, 400)
    assert.match(bad.body['error'] as string, /2 个执行者/)

    // 全私有但缺审核者 ⇒ 同样在写入前拒绝
    const noReviewer = await createGroup({
      name: '组 M3 缺审核',
      members: [],
      createAgents: [{ name: '执行者', role: 'executor', instructions: 'x', runtimeKey: 'claude', skillIds: [] }],
    })
    assert.equal(noReviewer.status, 400)
    assert.match(noReviewer.body['error'] as string, /没有审核者/)
  })

  test('★ 私有成员在组的接口里带着（名字/角色有处可查），detail 也有', async () => {
    const created = await createGroup({
      name: '组 M4',
      members: [],
      createAgents: [
        { name: '私有执行者 M4', role: 'executor', instructions: '干活', runtimeKey: 'claude', skillIds: [] },
        { name: '私有审核者 M4', role: 'reviewer', instructions: '判', reviewStandard: { name: 's', body: 'b' }, runtimeKey: 'claude', skillIds: [] },
      ],
    })
    const groupId = (created.body as { group: { id: string } }).group.id

    const list = await listGroups()
    const listed = list.find((g) => g['id'] === groupId)!
    assert.ok(listed)
    const listRes = await fetch(`${h.url}/api/agent-groups`)
    const listBody = (await listRes.json()) as { members: Array<Record<string, unknown>> }
    const listMembers = listBody.members.filter((m) => (listed['members'] as string[]).includes(m['id'] as string))
    assert.equal(listMembers.length, 2)

    const detail = await fetch(`${h.url}/api/agent-groups/${groupId}`)
    const detailBody = (await detail.json()) as { members: Array<Record<string, unknown>> }
    assert.equal(detailBody.members.length, 2)
  })

  test('★ 真实链路：私有执行者 + 私有审核者的组，run 展开与派生审核照常', async () => {
    const created = await createGroup({
      name: '组 M5 私有链路',
      members: [],
      createAgents: [
        { name: '私有执行者 M5', role: 'executor', instructions: '干活', runtimeKey: 'claude', skillIds: [] },
        { name: '私有审核者 M5', role: 'reviewer', instructions: '判', reviewStandard: { name: 's', body: 'b' }, runtimeKey: 'claude', skillIds: [] },
      ],
    })
    const { group, members } = created.body as { group: Record<string, unknown>; members: Array<{ id: string; role: string }> }
    const privateExecutor = members.find((m) => m.role === 'executor')!.id
    const privateReviewer = members.find((m) => m.role === 'reviewer')!.id

    const runId = ulid() as RunId
    const res = await submitRun({
      runId,
      kind: 'execute',
      groupId: group['id'] as string,
      agentRef: { id: privateExecutor, name: '私有执行者 M5', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-gm5' },
      prompt: '私有链路的执行',
      workDir: h.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(res.status, 202, JSON.stringify(res.body))

    const review = await until(
      async () => (await derivedReviewRuns(runId as string))[0] ?? null,
      `run ${runId} 派生审核（私有审核者）`,
    )
    assert.equal(review['agentId'], privateReviewer, '派生审核应使用组的私有审核者')
  })

  test('★ PATCH 也能补建私有成员（编辑组时新增）', async () => {
    const executor = await createAgent({ name: '执行者 M6', role: 'executor' })
    const reviewer = await createAgent({ name: '审核者 M6', role: 'reviewer' })
    const created = await createGroup({ name: '组 M6', members: [executor, reviewer] })
    const groupId = (created.body as { group: { id: string } }).group.id

    // 编辑组：把审核者换成私有草稿——members 传"换完之后剩下的全局成员"，
    // createAgents 传草稿，daemon 把新 id 并进去，最终仍是 1 执行 + 1 审核。
    const patched = await patchGroup(groupId, {
      members: [executor],
      createAgents: [
        { name: '补建的私有审核者', role: 'reviewer', instructions: '判', reviewStandard: { name: 's', body: 'b' }, runtimeKey: 'claude', skillIds: [] },
      ],
    })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const body = patched.body as { group: Record<string, unknown>; members: Array<Record<string, unknown>> }
    assert.equal((body.group['members'] as string[]).length, 2)
    assert.equal(body.members.length, 2)
    const privateReviewer = body.members.find((m) => m['role'] === 'reviewer')!
    assert.equal(privateReviewer['ownerGroupId'], groupId)
    assert.ok((body.group['members'] as string[]).includes(executor), '原有的全局执行者还在')
    assert.ok(!(body.group['members'] as string[]).includes(reviewer), '被替换掉的全局审核者已不在')
  })

  test('★ 删组按 ownerGroupId 级联删私有成员，并报告数量', async () => {
    const created = await createGroup({
      name: '组 M7 删组级联',
      members: [],
      createAgents: [
        { name: '私有执行者 M7', role: 'executor', instructions: 'x', runtimeKey: 'claude', skillIds: [] },
        { name: '私有审核者 M7', role: 'reviewer', instructions: '判', reviewStandard: { name: 's', body: 'b' }, runtimeKey: 'claude', skillIds: [] },
      ],
    })
    const { group, members } = created.body as { group: Record<string, unknown>; members: Array<{ id: string }> }
    const privateIds = members.map((m) => m['id'] as string)

    const del = await fetch(`${h.url}/api/agent-groups/${group['id'] as string}`, { method: 'DELETE' })
    const delBody = (await del.json()) as { ok: boolean; removedPrivateAgents: number }
    assert.equal(del.status, 200)
    assert.equal(delBody.ok, true)
    assert.equal(delBody.removedPrivateAgents, 2)

    // 组没了，私有 agent 也没了（按 id 直查 404）
    for (const id of privateIds) {
      const res = await fetch(`${h.url}/api/agents/${id}`)
      assert.equal(res.status, 404, `私有 agent ${id} 应随组删除`)
    }
  })

  test('★ POST /api/agents 带 ownerGroupId：私有归属写进去；组不存在 ⇒ 400', async () => {
    const created = await createGroup({
      name: '组 M8',
      members: [],
      createAgents: [
        { name: '私有执行者 M8', role: 'executor', instructions: 'x', runtimeKey: 'claude', skillIds: [] },
        { name: '私有审核者 M8', role: 'reviewer', instructions: '判', reviewStandard: { name: 's', body: 'b' }, runtimeKey: 'claude', skillIds: [] },
      ],
    })
    const groupId = (created.body as { group: { id: string } }).group.id

    const res = await fetch(`${h.url}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '直接建的私有执行者',
        role: 'executor',
        instructions: '干活',
        runtimeKey: 'claude',
        skillIds: [],
        ownerGroupId: groupId,
      }),
    })
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()))
    const agent = (await res.json()) as Record<string, unknown>
    assert.equal(agent['ownerGroupId'], groupId)

    const bad = await fetch(`${h.url}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '孤儿',
        role: 'executor',
        instructions: '干活',
        runtimeKey: 'claude',
        skillIds: [],
        ownerGroupId: 'ghost-group',
      }),
    })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as Record<string, unknown>)['error'] as string, /智能体组不存在/)
  })

  test('★ 私有执行者不能当默认智能体（PUT /api/agents/default 拒绝）', async () => {
    const created = await createGroup({
      name: '组 M9',
      members: [],
      createAgents: [
        { name: '私有执行者 M9', role: 'executor', instructions: 'x', runtimeKey: 'claude', skillIds: [] },
        { name: '私有审核者 M9', role: 'reviewer', instructions: '判', reviewStandard: { name: 's', body: 'b' }, runtimeKey: 'claude', skillIds: [] },
      ],
    })
    const { members } = created.body as { members: Array<{ id: string; role: string }> }
    const privateExecutor = members.find((m) => m.role === 'executor')!.id

    const res = await fetch(`${h.url}/api/agents/default`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: privateExecutor }),
    })
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as Record<string, unknown>)['error'] as string, /私有智能体/)
  })
})
