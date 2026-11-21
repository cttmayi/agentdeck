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
  legacySchedulesPath,
  loadSchedules,
  removeSchedule,
  renderScheduleTask,
  saveSchedule,
  scheduleDirPath,
  scheduleVarsFor,
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
    // 2026-11 v8 定型新增的两档：工作日（区间 1-5）与每月最后一天（L）
    assert.equal(describeCron('0 9 * * 1-5'), '工作日（周一至周五）09:00')
    assert.equal(describeCron('0 9 L * *'), '每月最后一天 09:00')
    // 自定义模式手填：看不懂就不假装看懂
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

/** 一条定时任务夹具（字段与 `Schedule` 一致；正文里带变量，便于断言落点）。 */
function sampleSchedule(): Schedule {
  return {
    id: 'sched-1',
    workspaceId: 'ws' as Schedule['workspaceId'],
    name: '竞品周报',
    enabled: true,
    cron: '0 9 * * 1',
    executorType: 'agent',
    executorId: 'a-1',
    taskText: '{{date}} 竞品周报',
    workDir: null,
    resumeMode: 'fresh',
    createdAt: 1,
    updatedAt: 1,
    triggerCount: 3,
    lastRunId: 'run-9' as Schedule['lastRunId'],
    lastTriggerAt: 2,
    records: [
      { triggeredAt: 2, runId: 'run-9' as Schedule['records'][number]['runId'], issueId: 'i-9', status: 'triggered', note: null },
    ],
  }
}

describe('定时任务存储与切分', () => {
  test('★★ 落成目录：配置进 schedule.json（**不含正文**）、正文进 task.md、记录进 records.jsonl', async () => {
    const dir = await makeTempDir('schedules-store')
    try {
      await saveSchedule(dir, sampleSchedule())
      const { readFile } = await import('node:fs/promises')
      const base = scheduleDirPath(dir, 'sched-1')

      const json = JSON.parse(await readFile(join(base, 'schedule.json'), 'utf8')) as Record<string, unknown>
      assert.equal(json['name'], '竞品周报')
      assert.equal(json['triggerCount'], 3)
      // ★ 这两条是本次改存储的核心：正文与历史都不在 json 里
      assert.equal('taskText' in json, false, 'schedule.json 里不许出现 taskText')
      assert.equal('records' in json, false, 'schedule.json 里不许出现 records')

      assert.equal(await readFile(join(base, 'task.md'), 'utf8'), '{{date}} 竞品周报')
      // 记录一行一条、最老在前
      const lines = (await readFile(join(base, 'records.jsonl'), 'utf8')).trim().split('\n')
      assert.equal(lines.length, 1)
      assert.equal((JSON.parse(lines[0]!) as { status: string }).status, 'triggered')

      // 读回：三份拼成一条完整记录
      const loaded = await loadSchedules(dir)
      assert.equal(loaded.errors.length, 0)
      assert.equal(loaded.schedules.length, 1)
      const back = loaded.schedules[0]!
      assert.equal(back.name, '竞品周报')
      assert.equal(back.triggerCount, 3)
      assert.equal(back.taskText, '{{date}} 竞品周报')
      assert.equal(back.records[0]!.status, 'triggered')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 记录顺序：盘上最老在前、读回最新的在前（界面/接口顺序不变）', async () => {
    const dir = await makeTempDir('schedules-records')
    try {
      // 内存里新的在前（既有约定）；落盘时反着写
      await saveSchedule(dir, {
        ...sampleSchedule(),
        records: [
          { triggeredAt: 3, runId: 'r3' as never, issueId: 'i3', status: 'triggered', note: null },
          { triggeredAt: 2, runId: 'r2' as never, issueId: 'i2', status: 'triggered', note: null },
        ],
      })
      const loaded = await loadSchedules(dir)
      assert.deepEqual(
        loaded.schedules[0]!.records.map((r) => r.triggeredAt),
        [3, 2],
        '读回来仍是"新的在前"',
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★★ 一条坏掉不毁全部，而且要报出来（旧的"读成空数组"已删）', async () => {
    const dir = await makeTempDir('schedules-bad')
    try {
      await saveSchedule(dir, sampleSchedule())
      const { mkdir, writeFile } = await import('node:fs/promises')
      const bad = scheduleDirPath(dir, 'sched-bad')
      await mkdir(bad, { recursive: true })
      await writeFile(join(bad, 'schedule.json'), '{坏', 'utf8')

      const loaded = await loadSchedules(dir)
      assert.deepEqual(
        loaded.schedules.map((x) => x.id),
        ['sched-1'],
        '好的那条照常读出来',
      )
      assert.equal(loaded.errors.length, 1)
      assert.match(loaded.errors[0]!, /sched-bad/)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 缺 task.md：这条**照样列出**（正文空）但要说出来；记录坏一行不牵连其余', async () => {
    const dir = await makeTempDir('schedules-partial')
    try {
      await saveSchedule(dir, sampleSchedule())
      const { readFile, rm, writeFile } = await import('node:fs/promises')
      const base = scheduleDirPath(dir, 'sched-1')
      await rm(join(base, 'task.md'))
      // 再往记录里掺一行坏的
      const good = await readFile(join(base, 'records.jsonl'), 'utf8')
      await writeFile(join(base, 'records.jsonl'), `${good}{坏行\n`, 'utf8')

      const loaded = await loadSchedules(dir)
      assert.equal(loaded.schedules.length, 1, '照样列出（不然使用者会以为它没了）')
      assert.equal(loaded.schedules[0]!.taskText, '')
      assert.equal(loaded.schedules[0]!.records.length, 1, '好的那行照读')
      assert.equal(loaded.errors.length, 2, '缺正文 + 坏一行各报一条')
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 删一条 = 删它自己的目录（不牵连别的）', async () => {
    const dir = await makeTempDir('schedules-remove')
    try {
      await saveSchedule(dir, sampleSchedule())
      await saveSchedule(dir, { ...sampleSchedule(), id: 'sched-2', name: '第二条', createdAt: 2 })
      await removeSchedule(dir, 'sched-1')
      const loaded = await loadSchedules(dir)
      assert.deepEqual(
        loaded.schedules.map((x) => x.id),
        ['sched-2'],
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★★ 老的 schedules.json 一次迁进目录；核对通过后**删掉老文件**、幂等', async () => {
    const dir = await makeTempDir('schedules-migrate')
    try {
      const { readFile, writeFile } = await import('node:fs/promises')
      await writeFile(legacySchedulesPath(dir), JSON.stringify([sampleSchedule()]), 'utf8')

      const first = await loadSchedules(dir)
      assert.equal(first.migrated?.migrated, 1)
      assert.equal(first.schedules.length, 1)
      assert.equal(first.schedules[0]!.taskText, '{{date}} 竞品周报')
      assert.equal(first.schedules[0]!.records.length, 1)

      // ★ D227：老文件删掉（核对通过后），也不再产生 `.migrated` 档案
      await assert.rejects(() => readFile(legacySchedulesPath(dir), 'utf8'))
      await assert.rejects(() => readFile(`${legacySchedulesPath(dir)}.migrated`, 'utf8'))

      const second = await loadSchedules(dir)
      assert.equal(second.migrated, null, '已归档 ⇒ 不再迁')
      assert.equal(second.schedules.length, 1)
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 没有文件（从没建过）= 空；老文件是坏 JSON ⇒ 报错且不改名不删', async () => {
    const dir = await makeTempDir('schedules-empty')
    try {
      const empty = await loadSchedules(dir)
      assert.deepEqual(empty.schedules, [])
      assert.deepEqual(empty.errors, [])

      const { readFile, writeFile } = await import('node:fs/promises')
      await writeFile(legacySchedulesPath(dir), 'not json{{{', 'utf8')
      const loaded = await loadSchedules(dir)
      assert.deepEqual(loaded.schedules, [])
      assert.equal(loaded.migrated?.errors.length, 1)
      // 迁移不许掩盖坏数据：原文件原样还在
      assert.equal(await readFile(legacySchedulesPath(dir), 'utf8'), 'not json{{{')
    } finally {
      await cleanup(dir)
    }
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
  // ⚠️ 2026-11（S4）：角色退场 ⇒ 首启只播一个通用 agent，直接取它。
  const list = (agents.body as { agents: Array<{ id: string; builtin?: boolean }> }).agents
  executorAgentId = list[0]!.id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
})

describe('定时任务整链（建 → 触发 → run → 记录）', () => {
  test('★ preview 接口：合法 cron 返回人话 + 下次触发；非法 cron → 400', async () => {
    const ok = await postJson('/api/schedules/preview', { cron: '0 9 * * 1-5' })
    assert.equal(ok.status, 200)
    const out = ok.body as { humanCron: string; nextRunAt: number }
    assert.equal(out.humanCron, '工作日（周一至周五）09:00')
    assert.ok(out.nextRunAt > Date.now())

    const bad = await postJson('/api/schedules/preview', { cron: 'not-a-cron' })
    assert.equal(bad.status, 400)
    const badOut = bad.body as { error: string; code: string }
    assert.equal(badOut.code, 'schedule_cron_invalid')
    assert.ok(badOut.error.length > 0)
  })

  test('★ 创建校验：空名字 / 坏 cron / 不存在的执行者 → 400', async () => {
    assert.equal((await postJson('/api/schedules', { name: ' ', cron: '0 9 * * *', executorType: 'agent', executorId: executorAgentId, taskText: 'x' })).status, 400)
    assert.equal((await postJson('/api/schedules', { name: 'a', cron: 'bad', executorType: 'agent', executorId: executorAgentId, taskText: 'x' })).status, 400)
    assert.equal((await postJson('/api/schedules', { name: 'a', cron: '0 9 * * *', executorType: 'agent', executorId: 'no-such-agent', taskText: 'x' })).status, 400)
    assert.equal((await postJson('/api/schedules', { name: 'a', cron: '0 9 * * *', executorType: 'agent', executorId: executorAgentId, taskText: '  ' })).status, 400)
  })

  test('★ 2026-11：工作目录 + 启动方式（fresh/resume）随创建/更新落库；resume 模式触发不报错', async () => {
    const wd = await makeTempDir('sched-workdir')
    try {
      const created = await postJson('/api/schedules', {
        name: '续跑任务',
        cron: '0 9 * * 1',
        executorType: 'agent',
        executorId: executorAgentId,
        taskText: '继续上次的工作：{{count}}',
        workDir: wd,
        resumeMode: 'resume',
      })
      assert.equal(created.status, 201, `创建失败：${JSON.stringify(created.body)}`)
      const sched = created.body as {
        id: string
        workDir: string | null
        resumeMode: string
      }
      assert.equal(sched.workDir, wd)
      assert.equal(sched.resumeMode, 'resume')

      // resume 模式触发两次都成功（第二次续上次，走 fireSchedule 的 resumeFromRunId 分支）
      const runIds: string[] = []
      for (let i = 0; i < 2; i++) {
        const t = await postJson(`/api/schedules/${sched.id}/trigger`, {})
        assert.equal(t.status, 200, `第 ${i + 1} 次触发失败：${JSON.stringify(t.body)}`)
        const record = (t.body as { records: Array<{ runId: string | null; status: string }> }).records[0]
        assert.ok(record && record.runId, `第 ${i + 1} 次要产生 run：${JSON.stringify(t.body)}`)
        runIds.push(record.runId)
        await waitForTerminal(record.runId)
      }
      // ★ 两次 run 的工作目录必须相同（resume 续的是"上一次的那间屋子"；显式
      //   目录本来就不变——这条断言钉住"没设目录时自动分配会给新 issue 换目录"
      //   那个坑，fireSchedule 现在把上次 run 的 workDir 显式传下去）
      const wd1 = (await json(`/api/runs/${runIds[0]}`)).body as { workDir: string }
      const wd2 = (await json(`/api/runs/${runIds[1]}`)).body as { workDir: string }
      assert.equal(wd1.workDir, wd)
      assert.equal(wd2.workDir, wd, `resume 模式第二次触发不能换目录：${wd2.workDir} vs ${wd1.workDir}`)

      // ★ 不设目录 + resume：自动分配的目录也要在两次触发之间**延续**（同一间屋子）
      const created2 = await postJson('/api/schedules', {
        name: '续跑无目录',
        cron: '0 9 * * 2',
        executorType: 'agent',
        executorId: executorAgentId,
        taskText: '继续上次',
        resumeMode: 'resume',
      })
      assert.equal(created2.status, 201)
      const sched2 = created2.body as { id: string }
      const runIds2: string[] = []
      for (let i = 0; i < 2; i++) {
        const t = await postJson(`/api/schedules/${sched2.id}/trigger`, {})
        const record = (t.body as { records: Array<{ runId: string | null }> }).records[0]
        assert.ok(record && record.runId, `无目录第 ${i + 1} 次触发失败：${JSON.stringify(t.body)}`)
        runIds2.push(record.runId)
        await waitForTerminal(record.runId)
      }
      const aw1 = (await json(`/api/runs/${runIds2[0]}`)).body as { workDir: string | null }
      const aw2 = (await json(`/api/runs/${runIds2[1]}`)).body as { workDir: string | null }
      assert.ok(aw1.workDir, '第一次触发要有自动分配目录')
      assert.equal(aw2.workDir, aw1.workDir, `resume 无目录也必须延续上次目录：${aw2.workDir} vs ${aw1.workDir}`)

      // ★ 2026-11 第三档（使用者："只有新开-保持的需求"）：'fresh-same-dir' =
      //   新会话 + 保持上次目录——两次触发 workDir 延续（fireWorkDir 同 resume
      //   分支），但**不传 resumeFromRunId**（新会话；run 不落库该字段，这里
      //   断言两次都成功且目录延续即可）
      const created3 = await postJson('/api/schedules', {
        name: '新开保持目录',
        cron: '0 9 * * 3',
        executorType: 'agent',
        executorId: executorAgentId,
        taskText: '新会话同一间屋子',
        resumeMode: 'fresh-same-dir',
      })
      assert.equal(created3.status, 201, `fresh-same-dir 创建失败：${JSON.stringify(created3.body)}`)
      const sched3 = created3.body as { id: string; resumeMode: string }
      assert.equal(sched3.resumeMode, 'fresh-same-dir')
      const runIds3: string[] = []
      for (let i = 0; i < 2; i++) {
        const t = await postJson(`/api/schedules/${sched3.id}/trigger`, {})
        const record = (t.body as { records: Array<{ runId: string | null }> }).records[0]
        assert.ok(record && record.runId, `fresh-same-dir 第 ${i + 1} 次触发失败：${JSON.stringify(t.body)}`)
        runIds3.push(record.runId)
        await waitForTerminal(record.runId)
      }
      const sw1 = (await json(`/api/runs/${runIds3[0]}`)).body as { workDir: string | null }
      const sw2 = (await json(`/api/runs/${runIds3[1]}`)).body as { workDir: string | null }
      assert.ok(sw1.workDir, 'fresh-same-dir 第一次触发要有自动分配目录')
      assert.equal(sw2.workDir, sw1.workDir, `fresh-same-dir 无目录也必须延续上次目录：${sw2.workDir} vs ${sw1.workDir}`)

      // PATCH：改回 fresh + 清空目录（三态：省略不动）
      const patched = await patchJson(`/api/schedules/${sched.id}`, {
        resumeMode: 'fresh',
        workDir: null,
      })
      assert.equal(patched.status, 200)
      const after = patched.body as { resumeMode: string; workDir: string | null }
      assert.equal(after.resumeMode, 'fresh')
      assert.equal(after.workDir, null)
    } finally {
      await cleanup(wd)
    }
  })

  /*
   * ⚠️ 2026-11（S3）：这里原来是两条"定时任务挂智能体组"的用例——
   *   「不存在的组 ⇒ 创建就 400」与「建组 → 定时任务走组 → run 挂 `groupId`」。
   *   组退场 ⇒ 定时任务只能选一个具体 agent，两条用例删。
   *
   *   ⚠️ 那条"老数据里 `executorType === 'group'` 的怎么办"仍然有答案：触发时找不到
   *   agent ⇒ 记一条 failed 记录并说清"组已退场，请改选具体智能体"（不静默跳过）。
   */

/*
 * ⚠️ 2026-11（S3）：成功路径那条也删（见上一条的说明）。
 */
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
