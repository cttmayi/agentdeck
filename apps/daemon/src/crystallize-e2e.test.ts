/**
 * D80 端到端：真 daemon + 假后端（NFR-T-01），HTTP 走完
 * 「沉淀目标 → 起草 run → 确认入库 → git 版本管理」整条链。
 *
 * 为什么必须端到端：起草/入库路由是**装配点**（store 双根 + executor 复用 +
 * git 探测/init/commit 在同一段代码里），单元测试各自绿不代表它们接起来绿。
 * 这里用**真 git**（git 不是 agent CLI，且 `ensureMineRepo` 用 per-repo 兜底
 * 身份，不碰全局配置）——git 集成（init → add → commit → log）要真跑一遍。
 *
 * 覆盖：
 *   ① targets：任务 run 的 scope/reviewed；
 *   ② draft：202 + materialStats，起草 run 的 subject 是 `skill-draft`；
 *   ③ commit：新建落 skills-mine（磁盘真文件 + /api/skills source:'mine' +
 *      git log 有提交）；
 *   ④ 撞 slug：同一 slug 再新建 → 409 clash_mine + existing 指向旧那条；
 *   ⑤ 更新（进化）：复用原 id、正文覆盖、git 再提交一条。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { ulid, type Issue, type RunId } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/** 最小假后端：每次 execute 立刻推一段文本产出并 completed。 */
class FakeBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(_opts: ExecOptions): Promise<AgentSession> {
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'status', content: '会话已启动' })
    queue.push({ type: 'text', content: '我先看看任务。' })
    queue.push({ type: 'tool_use', tool: 'Read', content: '调用工具 Read', input: { file_path: 'a.ts' } })
    queue.push({ type: 'tool_result', tool: null, content: '文件内容', output: '文件内容', outputTruncated: false })
    queue.push({ type: 'text', content: '报告：任务已完成。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed' as const,
        output: '报告：任务已完成。',
        error: null,
        durationMs: 5,
        sessionId: 'fake-session-1',
        usage: null,
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
let workRoot: string
let mineRoot: string
let daemon: DaemonHandle
let agentId: string
let issueId: string

/** 在 skills-mine 仓库里跑 git 命令（验证真提交）。 */
function git(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: mineRoot })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`git ${args.join(' ')} 失败（${code}）：${err}`))
    })
  })
}

before(async () => {
  dataDir = await makeTempDir('crystal-e2e-data')
  workRoot = await makeTempDir('crystal-e2e-work')
  mineRoot = join(dataDir, 'skills-mine')
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend: new FakeBackend(),
    onWarn: () => {},
    onInfo: () => {},
    // ★ skillsMineRoot 指进测试目录：commit 只写这里，不碰真家目录（NFR-T-01）
    skillsMineRoot: mineRoot,
    workRoot,
  })

  const agents = await (
    await fetch(`${daemon.url}/api/agents`)
  ).json() as { agents: Array<{ id: string; role: string }> }
  agentId = agents.agents.find((a) => a.role === 'executor')!.id

  const issueRes = await fetch(`${daemon.url}/api/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '写一份报告', description: '随便看看' }),
  })
  issueId = ((await issueRes.json()) as Issue).id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
  await cleanup(workRoot)
})

/** 提交一个任务 run 并等它终态，返回 runId（素材的源 run）。 */
async function runOnce(prompt: string): Promise<string> {
  const runId = ulid() as RunId
  const res = await fetch(`${daemon.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'execute',
      agentRef: { id: agentId, name: '助手', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: issueId },
      prompt,
      limits: { maxTurns: null, timeoutMs: null },
    }),
  })
  assert.equal(res.status, 202, '源 run 受理')
  // 假后端立刻完成：轮询等终态
  for (let i = 0; i < 40; i += 1) {
    const r = (await (await fetch(`${daemon.url}/api/runs/${runId}`)).json()) as { status: string }
    if (['completed', 'failed', 'cancelled'].includes(r.status)) return runId as string
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('源 run 未在限时内终态')
}

/** 起草一个 run 并等终态，返回 draftRunId。 */
async function draftAndWait(payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${daemon.url}/api/crystallize/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.equal(res.status, 202, '起草必须受理（202）')
  const body = (await res.json()) as { draftRunId: string; materialStats: { turns: number; toolCalls: number } }
  assert.equal(typeof body.draftRunId, 'string')
  for (let i = 0; i < 40; i += 1) {
    const r = (await (await fetch(`${daemon.url}/api/runs/${body.draftRunId}`)).json()) as { status: string }
    if (r.status === 'completed') return body.draftRunId
    if (['failed', 'cancelled'].includes(r.status)) throw new Error(`起草 run ${r.status}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('起草 run 未在限时内完成')
}

async function commit(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${daemon.url}/api/crystallize/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('D80 端到端：沉淀整条链（目标 → 起草 → 入库 → git）', () => {
  test('targets：任务 run 给 task 场景（无审核 ⇒ reviewed:false）', async () => {
    const runId = await runOnce('写一份关于依赖漏洞的报告')
    const res = await (await fetch(`${daemon.url}/api/crystallize/targets?runId=${runId}`)).json() as {
      scope: string
      reviewed: boolean
      hasUserFeedback: boolean
      loadedSkills: unknown[]
    }
    assert.equal(res.scope, 'task')
    assert.equal(res.reviewed, false, '没有审核 run 就不算审核过')
    assert.equal(res.hasUserFeedback, false, '还没有用户反馈机制')
  })

  test('draft：受理返回 draftRunId + 素材统计，subject 是 skill-draft', async () => {
    const runId = await runOnce('再做一次任务（素材源）')
    const res = await fetch(`${daemon.url}/api/crystallize/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        target: { kind: 'new', purpose: '沉淀这段报告流程' },
      }),
    })
    assert.equal(res.status, 202)
    const body = (await res.json()) as { draftRunId: string; materialStats: { turns: number; toolCalls: number } }
    assert.ok(body.materialStats.toolCalls >= 1, '素材统计带工具调用数')
    // 等它终态（executor 异步处理：queued → dispatched → completed）
    let status = ''
    for (let i = 0; i < 40; i += 1) {
      const run = (await (await fetch(`${daemon.url}/api/runs/${body.draftRunId}`)).json()) as {
        subject: { type: string }
        status: string
      }
      if (i === 0) assert.equal(run.subject.type, 'skill-draft', '起草 run 不进闭环')
      status = run.status
      if (['completed', 'failed', 'cancelled'].includes(status)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(status, 'completed', '假后端应完成起草 run')
  })

  test('★ 新建入库：落 skills-mine（真文件 + 列表 source:mine + git 提交）', async () => {
    const runId = await runOnce('产出一份可复用的流程')
    const draftRunId = await draftAndWait({
      runId,
      target: { kind: 'new', purpose: '把这份流程沉淀成 skill' },
    })

    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'my-flow',
      name: '我的流程',
      description: '审 xx 类报告时用',
      body: '# 我的流程\n## When to Use\n审报告时。\n## Procedure\n1. 看证据。',
    })
    assert.equal(status, 201, JSON.stringify(body))
    const skill = body['skill'] as { id: string; slug: string; source: string }
    assert.equal(skill.slug, 'my-flow')
    assert.equal(skill.source, 'mine', '入库的来源是 mine')

    // 磁盘：<skillsMineRoot>/<slug>/SKILL.md 真文件
    assert.equal(
      await readFile(join(mineRoot, 'my-flow', 'SKILL.md'), 'utf8'),
      '# 我的流程\n## When to Use\n审报告时。\n## Procedure\n1. 看证据。',
    )
    // 列表接口：source 'mine' 可见
    const list = (await (await fetch(`${daemon.url}/api/skills`)).json()) as { skills: Array<{ slug: string; source: string }> }
    const mine = list.skills.find((s) => s.slug === 'my-flow')
    assert.equal(mine?.source, 'mine')
    // git：仓库初始化了，且有这次提交（版本管理开着）
    assert.equal((body['versioning'] as { enabled: boolean }).enabled, true)
    const log = await git('log', '--oneline')
    assert.match(log, /沉淀（新建）/)
  })

  test('★ 撞 slug：同一 slug 再新建 ⇒ 409 clash_mine + existing 指回旧那条', async () => {
    const runId = await runOnce('又一个流程任务')
    const draftRunId = await draftAndWait({
      runId,
      target: { kind: 'new', purpose: '再沉淀一份' },
    })
    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'my-flow',
      name: '重复的',
      description: 'd',
      body: '# 重复\n',
    })
    assert.equal(status, 409)
    assert.equal(body['code'], 'clash_mine')
    const existing = body['existing'] as { slug: string; id: string }
    assert.equal(existing.slug, 'my-flow')
    assert.equal(typeof existing.id, 'string', 'existing 带 id，前端好切「更新」')
  })

  test('★ 更新安装的 skill：创建你的版本遮蔽它，安装根原文件不动', async () => {
    // 先装一条"安装的" skill（POST /api/skills 走安装通道，source 不是 mine）
    const installRes = await fetch(`${daemon.url}/api/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skills: [{ slug: 'installed-flow', name: '安装的流程', body: '# 安装版\n原样保留' }],
        overwrite: false,
      }),
    })
    assert.equal(installRes.status, 201)
    const installedList = (await (await fetch(`${daemon.url}/api/skills`)).json()) as {
      skills: Array<{ id: string; slug: string; source: string; body: string }>
    }
    const installed = installedList.skills.find((s) => s.slug === 'installed-flow')!
    assert.notEqual(installed.source, 'mine', '装出来的是安装来源')

    // 以"安装的"为目标起草 + 入库（设计 §4.1 第 1 步：选中安装的 = 基于它创建你的版本）
    const runId = await runOnce('流程任务（矫正安装版）')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'update', skillId: installed.id } })
    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'update', skillId: installed.id },
      slug: 'installed-flow',
      name: '我的流程（基于安装版）',
      description: 'd',
      body: '# 我的版本\n基于安装版沉淀',
    })
    assert.equal(status, 201, JSON.stringify(body))
    const skill = body['skill'] as { id: string; source: string; slug: string }
    assert.equal(skill.source, 'mine', '落的是你的版本')
    assert.notEqual(skill.id, installed.id, '不是改安装那条——新建你的版本')

    // 安装那条原样不动
    const after = (await (await fetch(`${daemon.url}/api/skills`)).json()) as {
      skills: Array<{ id: string; slug: string; source: string; body: string }>
    }
    const installedAfter = after.skills.find((s) => s.id === installed.id)!
    assert.equal(installedAfter.body, '# 安装版\n原样保留', '安装根原文件不动')
    // 遮蔽：mine 版与安装版同 slug 并存
    const mineNow = after.skills.find((s) => s.slug === 'installed-flow' && s.source === 'mine')!
    assert.equal(mineNow.body, '# 我的版本\n基于安装版沉淀')
    // git 提交在（你的版本进仓库）
    const log = await git('log', '--oneline')
    assert.match(log, /进化（更新）/)
  })

  test('★ 更新（进化）：复用原 id、正文覆盖、git 再提交一条', async () => {
    const runId = await runOnce('流程被纠正过一次')
    const skillId = (await (await fetch(`${daemon.url}/api/skills`)).json()) as {
      skills: Array<{ id: string; slug: string }>
    }
    const mine = skillId.skills.find((s) => s.slug === 'my-flow')!
    const draftRunId = await draftAndWait({
      runId,
      target: { kind: 'update', skillId: mine.id },
    })
    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'update', skillId: mine.id },
      slug: 'my-flow',
      name: '我的流程 v2',
      description: '审 xx 类报告时用（更新版）',
      body: '# 我的流程 v2\n## Procedure\n1. 先校验证据。\n2. 再下结论。',
    })
    assert.equal(status, 201, JSON.stringify(body))
    const skill = body['skill'] as { id: string; name: string }
    assert.equal(skill.id, mine.id, '进化复用原 id（不留孤儿记录）')
    assert.equal(skill.name, '我的流程 v2')
    // 磁盘覆盖
    assert.match(await readFile(join(mineRoot, 'my-flow', 'SKILL.md'), 'utf8'), /我的流程 v2/)
    // git 两条提交
    const log = await git('log', '--oneline')
    assert.match(log, /进化（更新）/)
  })
})
