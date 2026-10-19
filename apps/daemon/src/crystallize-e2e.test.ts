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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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

/**
 * 最小假后端：普通 run 立刻推一段文本产出并 completed。
 *
 * ★ 起草 run（工作目录是 `skill-draft-*`）**真的把文件写到 `skill/` 下**——
 *   四轮之后产出是"文件集合"，只推一段文本就测不到多文件那条路。
 */
class FakeBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 起草时写什么（测试可以改：模拟"只写文本"或"拒绝沉淀"）。 */
  draftFiles: Record<string, string> = {
    'SKILL.md':
      '---\nname: draft-flow\ndescription: 当需要复用这套报告流程时用\n---\n\n' +
      '# 报告流程\n\n## When to Use\n- 需要复用时\n\n## Procedure\n1. 看证据\n',
    'references/checklist.md': '# 自检\n- 每条结论都有证据\n',
  }

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    if (opts.workDir.includes('skill-draft-')) {
      for (const [rel, text] of Object.entries(this.draftFiles)) {
        const full = join(opts.workDir, 'skill', rel)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, text, 'utf8')
      }
    }
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
/** 假后端的引用（测试要换起草产出：写目录 / 只写 REFUSED.md）。 */
let fakeBackend: FakeBackend
let agentId: string
let reviewerId: string
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
    backend: (fakeBackend = new FakeBackend()),
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
  reviewerId = agents.agents.find((a) => a.role === 'reviewer')!.id

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

/**
 * 提交一个任务 run 并**补一条已完成的审核 run**，返回 runId。
 *
 * ★ 三轮：后端 draft 路由按设计 §4.3 拦"没审核过的任务"（`task_gate`）。
 *   这些 e2e 测的是起草/入库机制，不是门槛本身，所以夹具要走**过门**的那条路；
 *   门槛的负例（没审核 ⇒ reviewed:false）由上面那条 targets 测试钉着。
 */
async function runReviewed(prompt: string): Promise<string> {
  const runId = await runOnce(prompt)
  await reviewOnce(runId)
  return runId
}

/** 给一条任务 run 起一条审核 run 并等它终态（假后端立刻完成）。 */
async function reviewOnce(executeRunId: string): Promise<void> {
  const runId = ulid() as RunId
  const res = await fetch(`${daemon.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'review',
      agentRef: { id: reviewerId, name: '审核者', instructions: '' },
      subject: { type: 'run', id: executeRunId },
      prompt: '审一下',
      limits: { maxTurns: null, timeoutMs: null },
      review: { kind: 'k', title: 't', body: 'b', inputBlobRef: null, relatedIssueId: issueId },
    }),
  })
  assert.equal(res.status, 202, '审核 run 受理')
  for (let i = 0; i < 40; i += 1) {
    const r = (await (await fetch(`${daemon.url}/api/runs/${runId}`)).json()) as { status: string }
    if (['completed', 'failed', 'cancelled'].includes(r.status)) {
      assert.equal(r.status, 'completed', '假后端的审核 run 应完成')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('审核 run 未在限时内终态')
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
      materialStats: { turns: number; toolCalls: number } | null
      activeDraft: { runId: string; status: string } | null
    }
    assert.equal(res.scope, 'task')
    assert.equal(res.reviewed, false, '没有审核 run 就不算审核过')
    assert.equal(res.hasUserFeedback, false, '还没有用户反馈机制')
    assert.ok(res.materialStats, '素材统计起草前可见')
    assert.equal(res.activeDraft, null, '还没起草过')
  })

  test('draft：受理返回 draftRunId + 素材统计，subject 是 skill-draft', async () => {
    const runId = await runReviewed('再做一次任务（素材源）')
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
        subject: { type: string; sourceRunId?: string }
        status: string
      }
      if (i === 0) {
        assert.equal(run.subject.type, 'skill-draft', '起草 run 不进闭环')
        assert.equal(run.subject.sourceRunId, runId, '起草 run 记 source（恢复进行中的起草用）')
      }
      status = run.status
      if (['completed', 'failed', 'cancelled'].includes(status)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(status, 'completed', '假后端应完成起草 run')
  })

  test('★ 新建入库：落 skills-mine（真文件 + 列表 source:mine + git 提交）', async () => {
    const runId = await runReviewed('产出一份可复用的流程')
    const draftRunId = await draftAndWait({
      runId,
      target: { kind: 'new', purpose: '把这份流程沉淀成 skill' },
    })

    // ★ 恢复进行中的起草：起草完成但未入库 → targets 给 activeDraft
    const t1 = (await (await fetch(`${daemon.url}/api/crystallize/targets?runId=${runId}`)).json()) as {
      activeDraft: { runId: string; status: string; target: { kind: string } } | null
    }
    assert.deepEqual(
      t1.activeDraft,
      { runId: draftRunId, status: 'completed', target: { kind: 'new' } },
      '已完成待审阅可恢复，目标随行',
    )

    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'my-flow',
      files: {
        'SKILL.md':
          '---\nname: my-flow\ndescription: 审 xx 类报告时用\n---\n\n# 我的流程\n\n## When to Use\n审报告时。\n\n## Procedure\n1. 看证据。\n',
        'references/fields.md': '# 字段表\n',
      },
    })
    assert.equal(status, 201, JSON.stringify(body))
    const skill = body['skill'] as { id: string; slug: string; source: string; name: string }
    assert.equal(skill.slug, 'my-flow')
    assert.equal(skill.source, 'mine', '入库的来源是 mine')

    // 磁盘：<skillsMineRoot>/<slug>/ 下的真文件（正文 + 支持文件都落）
    assert.match(await readFile(join(mineRoot, 'my-flow', 'SKILL.md'), 'utf8'), /# 我的流程/)
    assert.equal(
      await readFile(join(mineRoot, 'my-flow', 'references', 'fields.md'), 'utf8'),
      '# 字段表\n',
      '支持文件也要落盘（四轮：多文件产物）',
    )
    // name / description 来自 SKILL.md 的 frontmatter（不再由请求体传）
    assert.equal(skill.name, 'my-flow', 'name 从 frontmatter 解析')
    assert.equal(
      (body['skill'] as { description: string | null }).description,
      '审 xx 类报告时用',
      'description 从 frontmatter 解析',
    )
    // 列表接口：source 'mine' 可见
    const list = (await (await fetch(`${daemon.url}/api/skills`)).json()) as { skills: Array<{ slug: string; source: string }> }
    const mine = list.skills.find((s) => s.slug === 'my-flow')
    assert.equal(mine?.source, 'mine')
    // git：仓库初始化了，且有这次提交（版本管理开着）
    assert.equal((body['versioning'] as { enabled: boolean }).enabled, true)
    const log = await git('log', '--oneline')
    assert.match(log, /沉淀（新建）/)

    // ★ 入库后 → activeDraft 清空（crystallized 跳过，不再"继续"已沉淀的草稿）
    const t2 = (await (await fetch(`${daemon.url}/api/crystallize/targets?runId=${runId}`)).json()) as {
      activeDraft: { runId: string; status: string } | null
    }
    assert.equal(t2.activeDraft, null, '入库后不恢复')
  })

  test('★ 撞 slug：同一 slug 再新建 ⇒ 409 clash_mine + existing 指回旧那条', async () => {
    const runId = await runReviewed('又一个流程任务')
    const draftRunId = await draftAndWait({
      runId,
      target: { kind: 'new', purpose: '再沉淀一份' },
    })
    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'my-flow',
      files: {
        'SKILL.md':
          '---\nname: my-flow\ndescription: 重复的\n---\n\n# 重复\n\n## When to Use\n- x\n\n## Procedure\n1. y\n',
      },
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
    const runId = await runReviewed('流程任务（矫正安装版）')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'update', skillId: installed.id } })
    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'update', skillId: installed.id },
      slug: 'installed-flow',
      files: {
        'SKILL.md':
          '---\nname: installed-flow\ndescription: 基于安装版\n---\n\n# 我的版本\n\n## When to Use\n- x\n\n## Procedure\n1. 基于安装版沉淀\n',
      },
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
    assert.match(mineNow.body, /基于安装版沉淀/)
    // git 提交在（你的版本进仓库）
    const log = await git('log', '--oneline')
    assert.match(log, /进化（更新）/)
  })

  test('★ 更新（进化）：复用原 id、正文覆盖、git 再提交一条', async () => {
    const runId = await runReviewed('流程被纠正过一次')
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
      files: {
        'SKILL.md':
          '---\nname: my-flow\ndescription: 审 xx 类报告时用（更新版）\n---\n\n# 我的流程 v2\n\n## When to Use\n- x\n\n## Procedure\n1. 先校验证据。\n2. 再下结论。\n',
      },
    })
    assert.equal(status, 201, JSON.stringify(body))
    const skill = body['skill'] as { id: string; name: string; description: string | null }
    assert.equal(skill.id, mine.id, '进化复用原 id（不留孤儿记录）')
    assert.equal(skill.name, 'my-flow', 'name 取 SKILL.md 的 frontmatter')
    assert.match(skill.description ?? '', /更新版/)
    // 磁盘覆盖
    assert.match(await readFile(join(mineRoot, 'my-flow', 'SKILL.md'), 'utf8'), /我的流程 v2/)
    // git 两条提交
    const log = await git('log', '--oneline')
    assert.match(log, /进化（更新）/)
  })
})

  test('★ 放弃：没入库的草稿打个标记就从列表消失（列表只增不减的出口）', async () => {
    const runId = await runReviewed('写个会留在列表里的草稿')
    const draftRunId = await draftAndWait({
      runId,
      target: { kind: 'new', purpose: '这条会被放弃' },
    })

    const before = (await (await fetch(`${daemon.url}/api/crystallize/drafts`)).json()) as {
      items: Array<{ runId: string }>
    }
    assert.ok(before.items.some((i) => i.runId === draftRunId), '放弃前在列表里')

    const res = await fetch(`${daemon.url}/api/crystallize/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    assert.equal(res.status, 200, '放弃受理')

    const after = (await (await fetch(`${daemon.url}/api/crystallize/drafts`)).json()) as {
      items: Array<{ runId: string }>
    }
    assert.ok(!after.items.some((i) => i.runId === draftRunId), '放弃后不在列表里')

    // 恢复进行中的起草也不再挂它（不然重开流程页又会把放弃的草稿"继续"一遍）
    const t = (await (await fetch(`${daemon.url}/api/crystallize/targets?runId=${runId}`)).json()) as {
      activeDraft: unknown
    }
    assert.equal(t.activeDraft, null, '放弃过的草稿不再算「进行中的起草」')

    // 幂等：再放弃一次也不报错（列表里本来就没有它）
    const again = await fetch(`${daemon.url}/api/crystallize/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    assert.equal(again.status, 200, '重复放弃是幂等的')

    // 不是起草 run / 不存在 ⇒ 404
    const bogus = await fetch(`${daemon.url}/api/crystallize/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: '01M2NOTADRAFT0000000000000' }),
    })
    assert.equal(bogus.status, 404)
  })

  test('★ 已入库的不许放弃（那是已经发生的事实，该去技能页删）', async () => {
    const runId = await runReviewed('写一份入库后不能放弃的')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new', purpose: '入库后用' } })
    const { status } = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'no-discard',
      files: {
        'SKILL.md':
          '---\nname: no-discard\ndescription: 入库后不许放弃\n---\n\n# 不能放弃\n\n## When to Use\n- 时\n\n## Procedure\n1. 做。\n',
      },
    })
    assert.equal(status, 201)

    const res = await fetch(`${daemon.url}/api/crystallize/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    assert.equal(res.status, 409, '已入库 ⇒ 409 already_crystallized')
    const body = (await res.json()) as { code?: string }
    assert.equal(body.code, 'already_crystallized')
  })

describe('四轮：素材落盘 + 产出读目录', () => {
  test('★ 起草的素材真的落盘在草稿工作目录里（agent 能读，人也能翻）', async () => {
    const runId = await runReviewed('落盘素材的任务')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })

    const res = (await (
      await fetch(`${daemon.url}/api/crystallize/material?draftRunId=${draftRunId}`)
    ).json()) as { dir: string; items: Array<{ relPath: string; text: string; bytes: number }> }
    const paths = res.items.map((i) => i.relPath)
    assert.ok(paths.includes('00-README.md'), '索引页在（agent 的第一个入口）')
    assert.ok(paths.includes('task-run.md'), '任务素材按任务一份')
    assert.ok(paths.includes('skills-index.md'), '现有技能清单在')
    assert.ok(paths.includes('meta.json'), '结构化元信息在')
    assert.match(res.items.find((i) => i.relPath === '00-README.md')!.text, /产出写在哪/)
    // 目录就在草稿工作目录里（claude 的 PreToolUse 隔离 hook 只放行 workDir）
    assert.match(res.dir, /skill-draft-[A-Z0-9]+[/\\]material$/)
  })

  test('★ 起草产出是多文件：artifacts 给文件集合 + 解析后的 frontmatter', async () => {
    const runId = await runReviewed('多文件产出的任务')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })

    const res = (await (
      await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${draftRunId}`)
    ).json()) as {
      mode: string
      files: Record<string, string>
      skillMd: { name: string; description: string; body: string }
      validation: { ok: boolean; problems: unknown[] }
      status: string
    }
    assert.equal(res.mode, 'files', '假后端写的是目录 ⇒ 走多文件那条路')
    assert.equal(res.status, 'completed')
    assert.deepEqual(Object.keys(res.files).sort(), ['SKILL.md', 'references/checklist.md'])
    assert.equal(res.skillMd.name, 'draft-flow')
    assert.match(res.skillMd.description, /当需要复用这套报告流程时用/)
    assert.equal(res.validation.ok, true, JSON.stringify(res.validation.problems))

    // 入库：整份 files 原样交出去，服务端照样写两个文件
    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'draft-flow',
      files: res.files,
    })
    assert.equal(status, 201, JSON.stringify(body))
    assert.match(await readFile(join(mineRoot, 'draft-flow', 'SKILL.md'), 'utf8'), /## Procedure/)
    assert.match(
      await readFile(join(mineRoot, 'draft-flow', 'references', 'checklist.md'), 'utf8'),
      /自检/,
      '支持文件跟着入库',
    )
  })

  test('★ 校验不过不许入库（缺 frontmatter 的 SKILL.md）', async () => {
    const runId = await runReviewed('缺 frontmatter 的任务')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
    const { status, body } = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'no-frontmatter',
      files: { 'SKILL.md': '# 只有标题\n' },
    })
    assert.equal(status, 400)
    assert.equal(body['code'], 'invalid_artifacts')
    assert.match(String(body['error']), /frontmatter/)
  })

  test('★ 起草者写了 REFUSED.md ⇒ artifacts 是 refused（结论，不是失败）', async () => {
    const runId = await runReviewed('不可沉淀的任务')
    const previous = fakeBackend.draftFiles
    fakeBackend.draftFiles = { 'REFUSED.md': '全是环境问题，没有可复用做法。' }
    try {
      const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
      const res = (await (
        await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${draftRunId}`)
      ).json()) as { mode: string; refusalReason?: string }
      assert.equal(res.mode, 'refused')
      assert.match(res.refusalReason ?? '', /环境问题/)
    } finally {
      fakeBackend.draftFiles = previous
    }
  })

  test('★ 更新场景：artifacts 带 baseline（当前版本），界面据此算 A/M/D', async () => {
    // 先入库一份，再基于它起草更新
    const runId = await runReviewed('更新基线任务')
    const firstDraft = await draftAndWait({ runId, target: { kind: 'new' } })
    const created = await commit({
      draftRunId: firstDraft,
      target: { kind: 'new' },
      slug: 'baseline-flow',
      files: {
        'SKILL.md':
          '---\nname: baseline-flow\ndescription: 基线用\n---\n\n# 基线\n\n## When to Use\n- x\n\n## Procedure\n1. y\n',
        'references/old.md': '# 旧的\n',
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const skillId = (created.body['skill'] as { id: string }).id

    const runId2 = await runReviewed('基于它再改一版')
    const draftRunId = await draftAndWait({ runId: runId2, target: { kind: 'update', skillId } })
    const res = (await (
      await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${draftRunId}`)
    ).json()) as { baseline: { slug: string; files: Record<string, string> } | null }
    assert.ok(res.baseline, '更新场景必须带当前版本')
    assert.equal(res.baseline!.slug, 'baseline-flow')
    assert.match(res.baseline!.files['SKILL.md'] ?? '', /# 基线/)
    assert.ok('references/old.md' in res.baseline!.files, '基线含支持文件（界面能算出删除项）')
  })
})

describe('四轮：文本兜底草稿更新时不删支持文件', () => {
  test('★ 文本产出（没写出目录）+ 更新 ⇒ 现有支持文件被保留（不是"整目录替换"）', async () => {
    // 先入库一份带支持文件的技能
    const runId = await runReviewed('建一个带支持文件的技能')
    const firstDraft = await draftAndWait({ runId, target: { kind: 'new' } })
    const created = await commit({
      draftRunId: firstDraft,
      target: { kind: 'new' },
      slug: 'keep-refs',
      files: {
        'SKILL.md':
          '---\nname: keep-refs\ndescription: 保留支持文件\n---\n\n# 保留\n\n## When to Use\n- x\n\n## Procedure\n1. y\n',
        'references/fields.md': '# 字段表\n',
        'scripts/run.sh': '#!/bin/sh\n',
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const skillId = (created.body['skill'] as { id: string }).id

    // 起草一份"只写出文本"的更新：让假后端什么都不写（模拟 generic runtime）
    const previous = fakeBackend.draftFiles
    fakeBackend.draftFiles = {}
    let textDraftId = ''
    try {
      const runId2 = await runReviewed('只给文本的更新')
      textDraftId = await draftAndWait({ runId: runId2, target: { kind: 'update', skillId } })
    } finally {
      fakeBackend.draftFiles = previous
    }
    const art = (await (
      await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${textDraftId}`)
    ).json()) as { mode: string }
    assert.equal(art.mode, 'text', '没写出目录 ⇒ 文本兜底')

    const { status, body } = await commit({
      draftRunId: textDraftId,
      target: { kind: 'update', skillId },
      slug: 'keep-refs',
      files: {
        'SKILL.md':
          '---\nname: keep-refs\ndescription: 文本版更新\n---\n\n# 保留 v2\n\n## When to Use\n- x\n\n## Procedure\n1. z\n',
      },
    })
    assert.equal(status, 201, JSON.stringify(body))
    // 支持文件还在（否则就是一次静默的数据丢失）
    assert.match(await readFile(join(mineRoot, 'keep-refs', 'references', 'fields.md'), 'utf8'), /字段表/)
    assert.match(await readFile(join(mineRoot, 'keep-refs', 'scripts', 'run.sh'), 'utf8'), /#!\/bin\/sh/)
    assert.match(await readFile(join(mineRoot, 'keep-refs', 'SKILL.md'), 'utf8'), /保留 v2/)
  })
})
