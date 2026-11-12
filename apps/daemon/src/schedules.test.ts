/**
 * 定时任务（2026-11，使用者立项）。
 *
 * 两层：
 *   · 纯函数层：模板变量渲染、cron 校验/人话描述、存储往返、任务文本切分；
 *   · 整链层（假后端，NFR-T-01）：起真 daemon → 建定时任务 → **手动触发**
 *     （`POST /api/schedules/:id/trigger` 与到点触发同一条 fire，测试靠它驱动，
 *      croner job 的到点没法在测试里等）→ 验证 issue + run + 触发记录落库。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { startDaemon, type DaemonHandle } from './server.ts'
import {
  describeCron,
  loadSchedules,
  renderScheduleTask,
  saveSchedules,
  scheduleVarsFor,
  splitScheduleRequest,
  validateCron,
  nextRunAt,
  type Schedule,
} from './schedules.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'


// ────────────────────────────────────────────────────────────────
// 单元：模板变量
// ────────────────────────────────────────────────────────────────

describe('定时任务模板变量（触发时快照）', () => {
  const vars = scheduleVarsFor(new Date(2026, 10, 16, 9, 5, 0).getTime(), 12, 'run-1', 'run-0')

  test('★ scheduleVarsFor：日期/时刻/星期格式正确', () => {
    assert.equal(vars.date, '2026-11-16')
    assert.equal(vars.time, '09:05')
    assert.equal(vars.weekday, '周一')
    assert.equal(vars.count, 12)
    assert.equal(vars.runId, 'run-1')
    assert.equal(vars.lastRunId, 'run-0')
  })

  test('★ 渲染：六个变量全替换，不识别的 {{xxx}} 保留原样', () => {
    const out = renderScheduleTask(
      '{{date}} {{time}} {{weekday}} 第{{count}}期 run={{runId}} 上期={{lastRunId}} {{typo}}',
      vars,
    )
    assert.equal(out, '2026-11-16 09:05 周一 第12期 run=run-1 上期=run-0 {{typo}}')
  })

  test('★ lastRunId 首次为空 ⇒ 替换成空串，不留 {{lastRunId}} 字样', () => {
    const first = scheduleVarsFor(Date.now(), 1, 'run-1', null)
    const out = renderScheduleTask('上次={{lastRunId}}结束', first)
    assert.equal(out, '上次=结束')
  })
})

// ────────────────────────────────────────────────────────────────
// 单元：cron 工具
// ────────────────────────────────────────────────────────────────

describe('定时任务 cron 工具', () => {
  test('★ validateCron：合法返回 null，非法返回人话，空返回空提示', () => {
    assert.equal(validateCron('0 9 * * 1'), null)
    assert.equal(validateCron('*/30 * * * *'), null)
    assert.ok(validateCron('bad expr') !== null)
    assert.ok(validateCron('   ') !== null)
  })

  test('★ describeCron：表单生成的几类有人话描述，手填的复杂表达式显示原文', () => {
    assert.equal(describeCron('0 9 * * *'), '每天 09:00')
    assert.equal(describeCron('0 9 * * 1'), '每周 周一 09:00')
    assert.equal(describeCron('0 9 * * 1,3'), '每周 周一、周三 09:00')
    assert.equal(describeCron('0 9 1 * *'), '每月 1 日 09:00')
    assert.equal(describeCron('*/30 * * * *'), '每 30 分钟')
    assert.equal(describeCron('15 * * * *'), '每小时 15 分')
    // 高级模式手填：看不懂就不假装看懂
    assert.equal(describeCron('0 9 * * 1-5/2'), '0 9 * * 1-5/2')
  })

  test('★ nextRunAt：合法表达式给出未来时刻，非法返回 null', () => {
    const from = new Date(2026, 10, 11, 10, 0, 0) // 2026-11-11 周三
    const next = nextRunAt('0 9 * * 1', from)
    assert.ok(next !== null && next > from.getTime())
    // 周一 09:00：11-11 是周三，下一个周一是 11-16
    assert.equal(new Date(next!).getDate(), 16)
    assert.equal(nextRunAt('nope', from), null)
  })
})

// ────────────────────────────────────────────────────────────────
// 单元：存储往返 + 任务文本切分
// ────────────────────────────────────────────────────────────────

describe('定时任务存储与切分', () => {
  test('★ saveSchedules/loadSchedules 往返（原子写 + 读回）', async () => {
    const dir = await makeTempDir('schedules-store')
    try {
      const s: Schedule = {
        id: 'sched-1',
        workspaceId: 'ws' as Schedule['workspaceId'],
        name: '竞品周报',
        enabled: true,
        cron: '0 9 * * 1',
        executorType: 'agent',
        executorId: 'a-1',
        taskText: '{{date}} 竞品周报',
        createdAt: 1,
        updatedAt: 1,
        triggerCount: 3,
        lastRunId: 'run-9' as Schedule['lastRunId'],
        lastTriggerAt: 2,
        records: [{ triggeredAt: 2, runId: 'run-9' as Schedule['records'][number]['runId'], issueId: 'i-9', status: 'triggered', note: null }],
      }
      await saveSchedules(dir, [s])
      const loaded = await loadSchedules(dir)
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.name, '竞品周报')
      assert.equal(loaded[0]!.triggerCount, 3)
      assert.equal(loaded[0]!.records[0]!.status, 'triggered')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ loadSchedules：没有文件（从没建过）= 空数组；坏 JSON = 空数组', async () => {
    const dir = await makeTempDir('schedules-empty')
    try {
      assert.deepEqual(await loadSchedules(dir), [])
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'schedules.json'), 'not json{{{', 'utf8')
      assert.deepEqual(await loadSchedules(dir), [])
    } finally {
      await cleanup(dir)
    }
  })

  test('★ splitScheduleRequest：第一行当标题、前面空行不算、标题超 500 截断', () => {
    const { title, body } = splitScheduleRequest('\n\n2026-11-16 竞品周报\n抓取本周更新。')
    assert.equal(title, '2026-11-16 竞品周报')
    assert.equal(body, '抓取本周更新。')
    const long = splitScheduleRequest('x'.repeat(600) + '\n正文')
    assert.equal(long.title.length, 500)
  })
})

// ────────────────────────────────────────────────────────────────
// 整链（假后端）
// ────────────────────────────────────────────────────────────────

/** 假后端：execute 直接产出结果，不做任何文件操作（定时任务的 run 不需要产物）。 */
class InstantBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(_opts: ExecOptions): Promise<AgentSession> {
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '定时任务产出。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '定时任务产出。',
        durationMs: 1,
        sessionId: 'sched-session',
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

let dataDir: string
let daemon: DaemonHandle
let executorAgentId: string

const json = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${daemon.url}${path}`, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}

const postJson = (path: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const patchJson = (path: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  json(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

before(async () => {
  dataDir = await makeTempDir('schedules-e2e-data')
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend: new InstantBackend(),
    onWarn: () => {},
    onInfo: () => {},
  })
  const agents = await json('/api/agents')
  const list = (agents.body as { agents: Array<{ id: string; role: string }> }).agents
  executorAgentId = list.find((a) => a.role === 'executor')!.id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
})

describe('定时任务整链（建 → 触发 → run → 记录）', () => {
  test('★ 创建校验：空名字 / 坏 cron / 不存在的执行者 → 400', async () => {
    assert.equal((await postJson('/api/schedules', { name: ' ', cron: '0 9 * * *', executorType: 'agent', executorId: executorAgentId, taskText: 'x' })).status, 400)
    assert.equal((await postJson('/api/schedules', { name: 'a', cron: 'bad', executorType: 'agent', executorId: executorAgentId, taskText: 'x' })).status, 400)
    assert.equal((await postJson('/api/schedules', { name: 'a', cron: '0 9 * * *', executorType: 'agent', executorId: 'no-such-agent', taskText: 'x' })).status, 400)
    assert.equal((await postJson('/api/schedules', { name: 'a', cron: '0 9 * * *', executorType: 'agent', executorId: executorAgentId, taskText: '  ' })).status, 400)
  })

  test('★ 建一个带模板变量的定时任务 → 手动触发 → issue + run + 记录都落库，变量已渲染', async () => {
    const created = await postJson('/api/schedules', {
      name: '竞品周报',
      cron: '0 9 * * 1',
      executorType: 'agent',
      executorId: executorAgentId,
      taskText: '{{date}} 竞品周报（第 {{count}} 期，上次 run={{lastRunId}}）\n抓取本周更新。',
    })
    assert.equal(created.status, 201, `创建失败：${JSON.stringify(created.body)}`)
    const scheduleId = (created.body as { id: string }).id

    // 列表视图：humanCron 人话 + nextRunAt 未来时刻
    const list = await json('/api/schedules')
    const item = (list.body as { items: Array<Record<string, unknown>> }).items.find((x) => x.id === scheduleId)
    assert.ok(item, '列表里要有刚建的')
    assert.equal(item!.humanCron, '每周 周一 09:00')
    assert.ok(typeof item!.nextRunAt === 'number' && (item!.nextRunAt as number) > Date.now())

    // 手动触发（与到点触发同一条 fire）
    const triggered = await postJson(`/api/schedules/${scheduleId}/trigger`, {})
    assert.equal(triggered.status, 200, `触发失败：${JSON.stringify(triggered.body)}`)
    const record = (triggered.body as { records: Array<{ runId: string | null; status: string }> }).records[0]
    assert.ok(record && record.runId, `要有一条 triggered 记录：${JSON.stringify(triggered.body)}`)
    assert.equal(record.status, 'triggered')

    // run 已提交并终态（假后端立即完成）
    const runId = record.runId!
    await waitForTerminal(runId)

    // 详情：triggerCount=1、lastRunId 已设、记录齐全
    const detail = await json(`/api/schedules/${scheduleId}`)
    const sched = (detail.body as { schedule: { triggerCount: number; lastRunId: string | null; lastTriggerAt: number | null } }).schedule
    assert.equal(sched.triggerCount, 1)
    assert.equal(sched.lastRunId, runId)
    assert.ok(sched.lastTriggerAt !== null)

    // 模板变量已渲染进 issue 标题（{{date}} 今天）
    const issues = await json('/api/issues')
    const titles = (issues.body as { items: Array<{ title: string }> }).items.map((i) => i.title)
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    assert.ok(titles.some((t) => t.startsWith(todayStr)), `issue 标题应含今天日期：${titles.join(' | ')}`)

    // 停用 → 列表 enabled=false
    const patched = await patchJson(`/api/schedules/${scheduleId}`, { enabled: false })
    assert.equal(patched.status, 200)
    const after = await json('/api/schedules')
    const item2 = (after.body as { items: Array<{ id: string; enabled: boolean }> }).items.find((x) => x.id === scheduleId)
    assert.equal(item2!.enabled, false)

    // 删除 → 列表不再有
    assert.equal((await json(`/api/schedules/${scheduleId}`, { method: 'DELETE' })).status, 200)
    const final = await json('/api/schedules')
    assert.ok(!(final.body as { items: Array<{ id: string }> }).items.some((x) => x.id === scheduleId))
  })

  test('★ 组执行者触发（组存在性失败路径）：不存在的组 → 记录 failed 且不建 run', async () => {
    const created = await postJson('/api/schedules', {
      name: '组任务',
      cron: '0 9 * * *',
      executorType: 'group',
      executorId: 'no-such-group',
      taskText: '跑一下。',
    })
    // 创建时校验存在性 → 400（组不存在，创建都过不了）
    assert.equal(created.status, 400)
  })

  test('★ 组执行者触发（成功路径）：建组 → 定时任务走组 → run 挂 groupId', async () => {
    const agents = (await json('/api/agents')).body as { agents: Array<{ id: string; role: string }> }
    const executor = agents.agents.find((a) => a.role === 'executor')!
    const reviewer = agents.agents.find((a) => a.role === 'reviewer')!
    const createdGroup = await postJson('/api/agent-groups', {
      name: '组A',
      members: [executor.id, reviewer.id],
      allowedActions: [],
      actionParams: {},
      debugActions: [],
      maxReworks: 0,
    })
    assert.equal(createdGroup.status, 201, `建组失败：${JSON.stringify(createdGroup.body)}`)
    const groupId = (createdGroup.body as { group: { id: string } }).group.id

    const created = await postJson('/api/schedules', {
      name: '组任务',
      cron: '0 9 * * *',
      executorType: 'group',
      executorId: groupId,
      taskText: '跑一下。',
    })
    assert.equal(created.status, 201, `创建失败：${JSON.stringify(created.body)}`)
    const scheduleId = (created.body as { id: string }).id

    const triggered = await postJson(`/api/schedules/${scheduleId}/trigger`, {})
    assert.equal(triggered.status, 200, `触发失败：${JSON.stringify(triggered.body)}`)
    const record = (triggered.body as { records: Array<{ runId: string | null; status: string }> }).records[0]
    assert.ok(record?.runId, '组触发也要有 triggered 记录')
    const run = await json(`/api/runs/${record.runId}`)
    assert.equal((run.body as { groupId: string | null }).groupId, groupId)
    await waitForTerminal(record.runId)
  })
})

async function waitForTerminal(runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { body } = await json(`/api/runs/${runId}`)
    const status = (body as { status?: string } | null)?.status
    if (status !== undefined && ['completed', 'failed', 'cancelled'].includes(status)) return
    if (Date.now() > deadline) throw new Error(`run ${runId} 一直没到终态`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
