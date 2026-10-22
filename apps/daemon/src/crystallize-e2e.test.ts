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
import { VERDICT_FENCE_BEGIN, VERDICT_FENCE_END, ulid, type Issue, type RunId } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { deliveredText } from './testing/delivered.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 最小假后端：普通 run 立刻推一段文本产出并 completed。
 *
 * ★ 起草 run（工作目录是 `skill-draft-*`）**真的把文件写到 `skill/` 下**——
 *   四轮之后产出是"文件集合"，只推一段文本就测不到多文件那条路。
 */
class FakeBackend implements AgentBackend {
  /**
   * 「审起草出来的 skill」那一路的回答（§10.5 第 ③ 条：判决 ⇒ 自动返工）。
   *
   * ⚠️ 单独一个开关、不复用业务审核那一路：业务审核的判决形状被别的测试钉着
   * （`runReviewed` 靠它过 `task_gate`）。用一个开关控制两种审核，会让"改这条链的假回答"
   * 变成"改所有审核测试的前置条件"。
   */
  draftReviewVerdict: Record<string, unknown> | null = null

  /** 投递出去的全部第一句话（审核那一路的提示词判据从这里读，与 run 日志互为对照）。 */
  readonly prompts: string[] = []
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

  /**
   * 让**起草** run 卡在"跑完之前"（分批第 8 批加）。
   *
   * 为什么需要它：有一条判据是"起草没跑完不许保存"（409），假后端默认立刻完成 ⇒
   * 那条分支根本来不及被看见。第一版我打算靠"POST 起草之后抢在完成前再 POST 保存"
   * 去撞，那是把一条纪律押在调度顺序上——机器一忙就红。
   */
  draftGate: Promise<void> | null = null

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    // 判据用**投递出去的第一句话**，不用工作目录：起草 run 与审它的 run 用的是**同一间小屋**
    // （`skill-draft-<id>`，这是设计的一部分：审核者要读同一份 `skill/` 与 `material/`），
    // 所以"目录里带 skill-draft"分不出这两者。
    const delivered = deliveredText(opts)
    this.prompts.push(delivered)
    const isDraftReview = delivered.includes('审一条刚起草出来的 skill')

    if (opts.workDir.includes('skill-draft-') && this.draftGate !== null) {
      await this.draftGate
    }
    /**
     * ⚠️ **只有起草 run 写文件**（2026-10-21 分批第 8 批修）。
     *
     * 原来这里的条件是"工作目录是草稿小屋就写"——而审核 run 用的**就是同一间小屋**
     * （设计如此）⇒ 审核者一跑就把 `skill/` 重写回夹具内容。第 8 批那条"人改 → 落盘"
     * 的用例因此变成一场竞态：**单跑通过**（审核先跑完，之后才保存），全量跑时机器忙、
     * 审核 run 收尾晚于保存 ⇒ 人手改的内容被审核 run 盖回去，红的却是"磁盘上真的换了内容"。
     *
     * 真链路上审核者**不写 skill**（它只读、指出问题），假后端不许比真链路多干一件事。
     */
    if (opts.workDir.includes('skill-draft-') && !isDraftReview) {
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
    const text =
      isDraftReview && this.draftReviewVerdict !== null
        ? `结论：\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(this.draftReviewVerdict)}\n${VERDICT_FENCE_END}\n`
        : '报告：任务已完成。'
    queue.push({ type: 'text', content: text })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed' as const,
        output: text,
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

describe('五轮：变更集 diff（P1）', () => {
  test('新建草稿：全部文件是 A，行数统计与 hunk 对得上，SKILL.md 排第一', async () => {
    const runId = await runReviewed('diff 新建')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
    const res = await fetch(`${daemon.url}/api/crystallize/diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      against: string
      baselineLabel: string
      files: Array<{ rel: string; change: string; added: number; hunks: unknown[] }>
      totals: { changed: number }
    }
    assert.equal(body.against, 'current')
    assert.equal(body.baselineLabel, '空（新建）')
    assert.ok(body.files.length >= 2, JSON.stringify(body.files.map((f) => f.rel)))
    assert.equal(body.files[0]!.rel, 'SKILL.md')
    assert.equal(
      body.files.every((f) => f.change === 'A'),
      true,
    )
    assert.ok(body.totals.changed >= 2)
  })

  test('★ 更新草稿：只有改动的那几行算 +/−，其余是上下文（LCS 真生效）', async () => {
    const runId = await runReviewed('diff 更新')
    const first = await draftAndWait({ runId, target: { kind: 'new' } })
    const created = await commit({
      draftRunId: first,
      target: { kind: 'new' },
      slug: 'diff-target',
      files: {
        'SKILL.md':
          '---\nname: diff-target\ndescription: 差异目标\n---\n\n# 标题\n\n## When to Use\n- 第一行\n\n' +
          '## Procedure\n1. 第二行\n2. 第三行\n',
        'references/a.md': '# a\n',
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const skillId = (created.body['skill'] as { id: string }).id

    const runId2 = await runReviewed('diff 更新二')
    const second = await draftAndWait({ runId: runId2, target: { kind: 'update', skillId } })
    // 只改 SKILL.md 的一行，并把 references/a.md 换个名字 → 一个 M、一个 A、一个 D
    const res = await fetch(`${daemon.url}/api/crystallize/diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRunId: second,
        files: {
          'SKILL.md':
            '---\nname: diff-target\ndescription: 差异目标\n---\n\n# 标题\n\n## When to Use\n- 第一行\n\n' +
            '## Procedure\n1. 第二行改过了\n2. 第三行\n',
          'references/b.md': '# b\n',
        },
      }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      files: Array<{ rel: string; change: string; added: number; removed: number }>
    }
    const byRel = new Map(body.files.map((f) => [f.rel, f]))
    assert.equal(byRel.get('SKILL.md')!.change, 'M')
    assert.equal(byRel.get('SKILL.md')!.added, 1, '只改一行 ⇒ 只有一个 +')
    assert.equal(byRel.get('SKILL.md')!.removed, 1)
    assert.equal(byRel.get('references/b.md')!.change, 'A')
    assert.equal(byRel.get('references/a.md')!.change, 'D')
    // 删除的排在最后（核对时最该一眼看到）
    assert.equal(body.files[body.files.length - 1]!.rel, 'references/a.md')
  })

  test('diff 也吃"当次编辑后的文件"：传什么算什么，不回读磁盘', async () => {
    const runId = await runReviewed('diff 用编辑内容')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
    const res = await fetch(`${daemon.url}/api/crystallize/diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, files: { 'SKILL.md': '---\nname: x\ndescription: y\n---\n' } }),
    })
    const body = (await res.json()) as { files: Array<{ rel: string }> }
    assert.deepEqual(
      body.files.map((f) => f.rel),
      ['SKILL.md'],
      '传一份只含 SKILL.md 的集合 ⇒ 差异里也只有它',
    )
  })

  test('缺 draftRunId / 不存在的草稿 ⇒ 400 / 404（不猜）', async () => {
    const bad = await fetch(`${daemon.url}/api/crystallize/diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(bad.status, 400)
    const missing = await fetch(`${daemon.url}/api/crystallize/diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: '01NOPE00000000000000000000' }),
    })
    assert.equal(missing.status, 404)
  })
})

describe('五轮：按意见改一版（P1）', () => {
  test('★ 新 run 复用同一份素材 + 上一版产出进 previous-draft/ + 意见进 feedback.md', async () => {
    const runId = await runReviewed('改一版')
    const first = await draftAndWait({ runId, target: { kind: 'new' } })
    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: first, feedback: 'Procedure 要写全命令参数' }),
    })
    assert.equal(res.status, 202, JSON.stringify(await res.clone().text()))
    const created = (await res.json()) as { draftRunId: string; revisedFrom: string }
    assert.equal(created.revisedFrom, first)

    // 等新 run 终态
    const draftRun = await fetch(`${daemon.url}/api/runs/${created.draftRunId}`)
    const run = (await draftRun.json()) as { status: string; revisedFrom?: string }
    assert.equal(run.revisedFrom, first, 'revisedFrom 要随 run 落库（对比上一版靠它）')

    // 素材：上一版素材被复制过来 + previous-draft/ + feedback.md
    const mat = (await (
      await fetch(`${daemon.url}/api/crystallize/material?draftRunId=${created.draftRunId}`)
    ).json()) as { items: Array<{ relPath: string; text: string }> }
    const rels = mat.items.map((i) => i.relPath)
    assert.ok(rels.includes('00-README.md'))
    assert.ok(rels.includes('feedback.md'), JSON.stringify(rels))
    assert.ok(rels.some((r) => r.startsWith('previous-draft/')), JSON.stringify(rels))
    assert.match(mat.items.find((i) => i.relPath === 'feedback.md')!.text, /写全命令参数/)
    assert.match(
      mat.items.find((i) => i.relPath === '00-README.md')!.text,
      /按意见改一版/,
      '索引要告诉起草者这一版在改上一版',
    )
    // 上一版自己的 feedback.md / previous-draft 不会被一层层套进来
    assert.equal(rels.filter((r) => r === 'feedback.md').length, 1)
    assert.equal(rels.filter((r) => r.startsWith('previous-draft/previous-draft/')).length, 0)
  })

  test('「对比上一版」：against=previous 用上一版草稿当基线', async () => {
    const runId = await runReviewed('对比上一版')
    const first = await draftAndWait({ runId, target: { kind: 'new' } })
    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: first, feedback: '改一句' }),
    })
    const created = (await res.json()) as { draftRunId: string }
    for (let i = 0; i < 40; i += 1) {
      const r = (await (await fetch(`${daemon.url}/api/runs/${created.draftRunId}`)).json()) as {
        status: string
      }
      if (r.status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // 假后端两版写的内容一样 ⇒ 对比上一版应当全部"没变"
    const diff = (await (
      await fetch(`${daemon.url}/api/crystallize/diff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: created.draftRunId, against: 'previous' }),
      })
    ).json()) as { against: string; baselineLabel: string; files: Array<{ change: string }> }
    assert.equal(diff.against, 'previous')
    assert.equal(diff.baselineLabel, '上一版草稿')
    assert.ok(diff.files.length > 0)
    assert.equal(
      diff.files.every((f) => f.change === 'same'),
      true,
      JSON.stringify(diff.files),
    )

    // artifacts 里带着 revisedFrom，界面据此才显示"对比上一版"
    const art = (await (
      await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${created.draftRunId}`)
    ).json()) as { revisedFrom: string | null }
    assert.equal(art.revisedFrom, first)
  })

  test('意见为空 ⇒ 400；不是起草 run ⇒ 400（不静默再起草一版）', async () => {
    const runId = await runReviewed('意见为空')
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
    const empty = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, feedback: '   ' }),
    })
    assert.equal(empty.status, 400)
    const notDraft = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: runId, feedback: '改一下' }),
    })
    assert.equal(notDraft.status, 400)
  })
})

describe('六轮：git 历史与版本对比（P2，§7.4）', () => {
  /**
   * 造一条「我提炼的」技能并拿到它的 id（历史与对比都要一条 mine 的技能）。
   *
   * ⚠️ 复用 P1 那条真实路径（起草 → 入库），不直接往 store 里塞：这一组要量的
   *    正是"沉淀时真的打了 commit ⇒ 历史里真的有一条"——绕过入库就量不到它。
   */
  async function makeMineSkill(slug: string, marker: string): Promise<string> {
    const runId = await runReviewed(`历史夹具 ${slug}`)
    const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
    // ⚠️ 正文必须过**入库校验**（`## When to Use` / `## Procedure` 两节）：少了它
    //    入库路由会 400 `invalid_artifacts`，而那条错看起来像"历史接口坏了"。
    //    所以夹具按最小合法形状写，内容用 marker 区分。
    const created = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug,
      files: {
        'SKILL.md':
          `---\nname: ${slug}\ndescription: 历史夹具 ${slug}\n---\n\n# ${slug}\n\n` +
          `## When to Use\n- ${marker}\n\n## Procedure\n1. ${marker}\n`,
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    return (created.body['skill'] as { id: string }).id
  }

  test('★★★ history：我提炼的技能历史里**真的有**那条沉淀提交（git 可用时）', async () => {
    const skillId = await makeMineSkill('hist-one', '历史一')
    const res = await fetch(`${daemon.url}/api/skills/${skillId}/history`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as
      | { available: true; entries: Array<{ rev: string; short: string; when: string; message: string }> }
      | { available: false; reason: string }
    // ⚠️ 两种都合法：**没有 git 是正常状态**（§7.3.1）。但"不可用"必须带理由——
    //    否则界面只能说一句"版本管理未启用"，而使用者不知道是没 git 还是坏了。
    if (!body.available) {
      assert.ok(body.reason.length > 0, 'available:false 必须带理由')
      return
    }
    assert.ok(body.entries.length >= 1, JSON.stringify(body.entries))
    const top = body.entries[0]!
    assert.match(top.message, /hist-one/)
    assert.ok(top.rev.length >= 7)
    assert.ok(top.when.includes('T'), `when 要是 ISO 时间，量到 ${top.when}`)
  })

  test('★★★ compare：最新提交 vs 库里现在这份 —— 差异由**后端**算出来', async () => {
    const skillId = await makeMineSkill('hist-two', '历史二')
    const hist = (await (
      await fetch(`${daemon.url}/api/skills/${skillId}/history`)
    ).json()) as { available: boolean; entries?: Array<{ rev: string }> }
    if (!hist.available) return // 没 git：正常状态，上面那条已经量过"带理由"
    const rev = hist.entries?.[0]?.rev ?? 'current'
    const res = await fetch(
      `${daemon.url}/api/skills/${skillId}/compare?from=${rev}&to=current`,
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as
      | { available: true; files: Array<{ rel: string; change: string }> }
      | { available: false; reason: string }
    assert.equal(body.available, true, JSON.stringify(body))
    if (!body.available) return
    // 刚沉淀完，工作区与最新提交一字不差 ⇒ 每个文件都是 `same`（不是"没有差异就没文件"）
    assert.ok(body.files.length >= 1)
    assert.equal(
      body.files.every((f) => f.change === 'same'),
      true,
      JSON.stringify(body.files),
    )
  })

  test('★ 安装来的技能：history 说清"外部内容没有历史"，**不是** 404', async () => {
    // 夹具走**公开接口**造（`POST /api/skills` 支持 `source: 'local'` = 安装来的）：
    // 这个测试文件没有 store 句柄（daemon 自己持有），而且"装一条技能"本来就是
    // 使用者做过的事——用接口造比戳库更接近真实状态。
    const created = await fetch(`${daemon.url}/api/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skills: [
          {
            slug: 'hist-installed',
            name: 'hist-installed',
            body: '---\nname: hist-installed\n---\n\n装来的\n',
            source: 'local',
          },
        ],
      }),
    })
    // ⚠️ 正文只能读一次：`assert.equal(…, await created.text())` 那个失败消息参数是
    //    **无条件求值**的，读完之后 `.json()` 就报 "Body is unusable"。
    const createdText = await created.text()
    // `POST /api/skills` 成功是 **201**（创建），不是 200——第一版按读接口的习惯写成 200
    assert.equal(created.status, 201, createdText)
    const installedId = (JSON.parse(createdText) as { installed: Array<{ id: string }> })
      .installed[0]!.id
    const res = await fetch(`${daemon.url}/api/skills/${installedId}/history`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { available: boolean; reason?: string }
    assert.equal(body.available, false)
    assert.match(body.reason ?? '', /安装/)
  })

  test('★ 缺参数与找不到技能：各自的错说各自的（不混成一句"失败了"）', async () => {
    const missing = await fetch(`${daemon.url}/api/skills/01NOPE/history`)
    assert.equal(missing.status, 404)

    const skillId = await makeMineSkill('hist-three', '历史三')
    const noRev = await fetch(`${daemon.url}/api/skills/${skillId}/revision`)
    assert.equal(noRev.status, 400)
    const noRange = await fetch(`${daemon.url}/api/skills/${skillId}/compare?from=current`)
    assert.equal(noRange.status, 400)
  })
})

/**
 * §10 第 ②.5 步：起草之后的**审核 run**（内置的 skill 审核者）。
 *
 * 判据为什么要落在"那条 run 的 subject / agentRef / 工作目录"上，而不是"接口返回 202"：
 *   · **subject 是纪律的落点**——`skill-draft-review` 不进任务列表、不挂 issue、不走
 *     `ReportIngestor`。subject 写错（比如飘成报告类）会让它**混进业务闭环**，
 *     而界面上只是"多了一条任务"，没人会去怀疑。
 *   · **agentRef 必须是内置审核者**：写成来源 run 的执行者，等于"起草者自己审自己"，
 *     而那正是这个审核步要防的。
 *   · **工作目录必须是草稿小屋**：审核者要读的 `skill/` 与 `material/` 都在那里；
 *     缺省目录下它读不到 `skill/SKILL.md`，报错看起来却像"起草没产出"。
 */
describe('§10：起草之后的审核 run', () => {
  test('★★ 起了审核 run：subject=skill-draft-review、执行者是内置审核者、工作目录是草稿小屋', async () => {
    // ⚠️ 用 `runReviewed` 不是 `runOnce`：起草路由对**任务** run 有 `task_gate`
    //    （任务要先审过才允许沉淀），拿一条没审过的 run 去起草会被 400 拒，
    //    而那条报错看起来像"接口坏了"。
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的依赖漏洞处置流程'),
      target: { kind: 'new', purpose: '依赖漏洞处置流程' },
    })

    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    // ⚠️ 响应体**只能读一次**：先 `text()` 再 `JSON.parse`。写成
    //    `assert.equal(res.status, 202, await res.text())` + `await res.json()`
    //    会抛 `Body is unusable: Body has already been read` —— 而那条错看起来像
    //    "接口坏了"。这个坑我在同一个会话里踩了四次，所以把它钉在注释里。
    const draftText = await res.text()
    assert.equal(res.status, 202, draftText)
    const { reviewRunId, reviewerAgentId } = JSON.parse(draftText) as {
      reviewRunId: string
      reviewerAgentId: string
    }

    const run = (await (await fetch(`${daemon.url}/api/runs/${reviewRunId}`)).json()) as {
      subject: { type: string; id: string }
      agentId: string
      workDir: string | null
      kind: string
    }
    assert.equal(run.subject.type, 'skill-draft-review', 'subject 类型是纪律的落点')
    assert.equal(run.subject.id, draftRunId, '指回被审的那条起草 run')
    assert.equal(run.agentId, reviewerAgentId, '执行者是内置审核者，不是起草者自己')
    assert.equal(run.kind, 'review', '走的是审核那一侧（执行/审核两次同构）')
    assert.match(String(run.workDir), /skill-draft-/, '审核者在草稿小屋里跑')

    // 内置审核者：角色是 skill-reviewer（**不是** reviewer，否则会去审业务报告）
    const agent = (await (await fetch(`${daemon.url}/api/agents/${reviewerAgentId}`)).json()) as {
      role: string
      builtin?: boolean
    }
    assert.equal(agent.builtin, true)
    assert.equal(agent.role, 'skill-reviewer')
  })

  test('★ 它**不进任务列表**（与起草 run 同一条纪律：不打扰任何人）', async () => {
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的另一个流程'),
      target: { kind: 'new', purpose: '依赖漏洞处置流程' },
    })
    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    const text = await res.text()
    assert.equal(res.status, 202, text)
    const { reviewRunId } = JSON.parse(text) as { reviewRunId: string }

    const tasks = (await (await fetch(`${daemon.url}/api/tasks`)).json()) as unknown
    assert.ok(
      !JSON.stringify(tasks).includes(reviewRunId),
      '审核 run 不许出现在任务列表里（它不在闭环里）',
    )
  })

  test('★ 不是起草 run ⇒ 400；没跑完 ⇒ 409（两种拒绝都要说清是哪一种）', async () => {
    const otherRunId = await runOnce('写一份关于依赖漏洞的报告')
    const bad = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: otherRunId }),
    })
    assert.equal(bad.status, 400)
    const badBody = (await bad.json()) as { code?: string }
    assert.equal(badBody.code, 'not_a_draft')

    const missing = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missing.status, 400)
    assert.equal(((await missing.json()) as { code?: string }).code, 'draft_run_id_required')
  })
})

/**
 * §10.5 第 ③ 条：审核**不通过** ⇒ 自动返工（把审核意见交回内置起草者重改一版）。
 *
 * 挂点是现成的 `createReworkRun`（D45 那条"审核不通过 ⇒ 交回执行者重做"的路），
 * 我们只在那条路的**开头**开了一个窄口子（`subject.type === 'skill-draft-review'`）。
 * 所以这里要证的是三件事：**该返工时真的返工**、**不改返工时一次都不动**、
 * **返工交下去的是审核者写的那几条意见**（不是一句"不通过"）。
 *
 * ⚠️ 判据不要用"起草 run 的条数"：`/api/runs` 是**分页**的，条数会撞上限，
 *    于是"多了一条"看不见（我第一版就是这么写的，卡在"等不到第 27 条"）。
 *    改用两处更硬的证据：①判决的状态（`rework_requested` 只在这条路上出现，
 *    额度用尽/派不出去时是 `escalated`）②文件系统里**新的一间草稿小屋**里
 *    确实有那份 `material/feedback.md`。
 */
describe('§10.5：审核不通过 ⇒ 自动返工', () => {
  /** 起一条起草审核 run 并等它收口（判决落库发生在终态之后，所以等的是判决）。 */
  async function reviewDraftAndWait(draftRunId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    const text = await res.text()
    assert.equal(res.status, 202, text)
    const { reviewRunId } = JSON.parse(text) as { reviewRunId: string }
    // ⚠️ 等的是**收口之后**的判决，不是"判决一出现"：收口分两步（先落库 `validated`，
    //    再按决定 transition 成 `rework_requested` / `escalated`）。只等"有判决"会读到
    //    中间态，于是断言 `=== 'rework_requested'` 变成一场竞态 —— 单跑这个文件时侥幸通过，
    //    全量跑（机器忙、调度顺序变）就红。我第一次就是这么写的，全量跑时红了这一条。
    for (let i = 0; i < 200; i += 1) {
      const vs = (await (
        await fetch(`${daemon.url}/api/runs/${reviewRunId}/verdicts`)
      ).json()) as { verdicts?: Record<string, unknown>[] }
      const v = (vs.verdicts ?? [])[0]
      if (v && v.status !== 'validated') return v
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('审核判决没在限时内收口')
  }

  /** 草稿小屋的目录名（`skill-draft-<run id>`）——返工会在旁边新开一间。 */
  async function draftHuts(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    return (await readdir(workRoot)).filter((n) => n.startsWith('skill-draft-'))
  }

  /** 等"多出来的一间小屋"出现（返工的表现），返回它。 */
  async function waitForNewHut(before: string[]): Promise<string> {
    for (let i = 0; i < 200; i += 1) {
      const fresh = (await draftHuts()).filter((n) => !before.includes(n))
      if (fresh.length > 0) return fresh[0]!
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('没有出现新的草稿小屋（自动返工没发生）')
  }

  test('★★ 判决 fail ⇒ 返工派得出去（判决状态 rework_requested）且意见落进新一版素材', async () => {
    const sourceRunId = await runReviewed('审完的流程（要触发自动返工）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '自动返工流程' },
    })
    const before = await draftHuts()

    // ⚠️ 这份判决必须**完全合规**，否则它连"不通过"都算不上：`reasonCode` 是平台枚举
    //    （`packages/protocol/src/enums.ts` 的 `ReasonCode`），`severity` 也是。
    //    我第一版随手写了 `reasonCode: 'missing_when_to_use'`、`severity: 'major'`、
    //    还漏了 `schemaVersion`/`confidence` ⇒ 判决被判成**结构性不合规** ⇒ `decideReview`
    //    走 invalid 那一支、**根本不会返工**。表现是"自动返工永远不触发"，而日志里
    //    没有一句相关的话（它压根没走到返工那一步）——所以这份 fixture 照合规形状写。
    fakeBackend.draftReviewVerdict = {
      schemaVersion: 1,
      conclusion: 'fail',
      reasonCode: 'style_violation',
      confidence: 0.8,
      findings: [
        {
          severity: 'high',
          summary: '正文里没有 `## When to Use` 一节',
          evidence: [{ blobRef: null, locator: 'SKILL.md', excerpt: '# 依赖漏洞处置' }],
          detail: {},
        },
      ],
      action: null,
      escalateReason: null,
    }
    try {
      const verdict = await reviewDraftAndWait(draftRunId)
      assert.equal(verdict.conclusion, 'fail')
      // ★ 这个状态就是"派出去了一条返工 run"的落点：拿不到额度或派不出去时是 `escalated`
      assert.equal(
        verdict.status,
        'rework_requested',
        '不通过且有额度 ⇒ 必须真的派出一条返工 run（escalated 说明根本没派）',
      )

      const hut = await waitForNewHut(before)
      const feedback = await readFile(join(workRoot, hut, 'material', 'feedback.md'), 'utf8')
      assert.match(feedback, /style_violation/, '理由码要交下去')
      assert.match(feedback, /正文里没有 `## When to Use` 一节/, '审核者的条目要交下去')
      assert.match(feedback, /SKILL\.md/, '位置要交下去（否则起草者不知道改哪儿）')
      // 返工是"再起草一版"，不是覆盖上一版
      assert.ok(
        (await draftHuts()).includes(`skill-draft-${draftRunId}`),
        '被审的那一版不许消失',
      )
    } finally {
      fakeBackend.draftReviewVerdict = null
    }
  })

  test('★★ 判决 pass ⇒ 不返工（判决只是记录，一版都不多）', async () => {
    const sourceRunId = await runReviewed('审完的流程（判决通过）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '通过就不返工' },
    })
    const before = await draftHuts()

    fakeBackend.draftReviewVerdict = {
      schemaVersion: 1,
      conclusion: 'pass',
      reasonCode: 'meets_criteria',
      confidence: 0.9,
      findings: [],
      action: null,
      escalateReason: null,
    }
    try {
      const verdict = await reviewDraftAndWait(draftRunId)
      assert.equal(verdict.conclusion, 'pass')
      assert.notEqual(verdict.status, 'rework_requested', '通过不该返工')
      // 给返工足够的时间去犯错（如果它真会犯错）：判决落库之后还有异步的收尾
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.deepEqual(await draftHuts(), before, '通过不该多出草稿小屋')
    } finally {
      fakeBackend.draftReviewVerdict = null
    }
  })

  test('★ 读结论的接口：没审过 ⇒ review=null（**不是**"不通过"）；审过 ⇒ 带回条目与版本数', async () => {
    const sourceRunId = await runReviewed('审完的流程（读结论）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '读结论' },
    })
    const before = await (
      await fetch(`${daemon.url}/api/crystallize/review?draftRunId=${draftRunId}`)
    ).json() as { review: unknown; reviewRunId: unknown; versions: number }
    // ★ 这条判据是给界面用的：`review === null` 与"结论 needs_human"必须分得开，
    //   否则界面会把"还没审过"画成"不通过"，人会去改一份根本没被审过的稿子。
    assert.equal(before.review, null, '还没审过 ⇒ review 必须是 null')
    assert.equal(before.reviewRunId, null)
    assert.equal(before.versions, 1, '刚起草完是第 1 版')

    fakeBackend.draftReviewVerdict = {
      schemaVersion: 1,
      conclusion: 'pass',
      reasonCode: 'meets_criteria',
      confidence: 0.9,
      findings: [],
      action: null,
      escalateReason: null,
    }
    try {
      await reviewDraftAndWait(draftRunId)
      const after = (await (
        await fetch(`${daemon.url}/api/crystallize/review?draftRunId=${draftRunId}`)
      ).json()) as {
        review: { conclusion: string; reasonCode: string; status: string } | null
        versions: number
      }
      assert.equal(after.review?.conclusion, 'pass')
      assert.equal(after.review?.reasonCode, 'meets_criteria')
      assert.equal(after.versions, 1, '通过 ⇒ 没有返工 ⇒ 还是一版')
    } finally {
      fakeBackend.draftReviewVerdict = null
    }
  })

  test('★★ 审核**没跑成**（产出里没有判决块）⇒ 不返工也不当通过', async () => {
    const sourceRunId = await runReviewed('审完的流程（判决不合规）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '判决不合规' },
    })
    const before = await draftHuts()

    // `draftReviewVerdict` 保持 null ⇒ 假后端给的是普通产出（没有判决围栏）
    const verdict = await reviewDraftAndWait(draftRunId)
    assert.equal(verdict.conclusion, 'needs_human', '不合规要如实降级，不许伪装成通过')
    assert.notEqual(verdict.status, 'rework_requested', '审核没跑成不是"活没干好"，不返工')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await draftHuts(), before, '不合规时一版都不该多')
  })
})

/**
 * §10.5 第 ③ 条：审核者**真执行**草稿脚本（含总开关）。
 *
 * 这一条最容易被做错成"加句话就完事"：权限其实**本来就有**（claude 跑在
 * `--permission-mode bypassPermissions`；D76 的运行期钩子只拦越界——`..` / `~` /
 * 工作目录外的绝对路径），缺的是**让它去跑**与**跑挂了要有上限**这两件事。
 * 所以这里证的是：
 *   ① 开关开 ⇒ 提示词里有一段"把脚本真的跑一遍"（含"只在小屋里活动"的约束与
 *      "跑不起来就说跑不起来"）；开关关 ⇒ 那一段**换成**"不要执行脚本"，而不是消失
 *      —— 消失的话它可能照跑（权限还在），或者没跑却写下"已执行通过"；
 *   ② 审核 run 有**有界超时**（挂住的脚本不会把审核永远吊着）；
 *   ③ D76 的钩子对"小屋内部相对路径跑脚本"真的是放行的（这是①能成立的地基，
 *      所以直接量那个脚本，而不是相信"应该没问题"）。
 */
/**
 * §10.6 人改草稿（2026-10-21 分批第 8 批）。
 *
 * 使用者原话：「缺少一个可以改的地方」。编辑器一直都在（草稿 tab 每个文本文件都能改），
 * 缺的是**改完算不算数**：改动只活在浏览器内存里，而审核者读的是磁盘上的 `skill/`。
 * 这一块钉住补上的那条路：**写回落盘 → 指纹变化 → 结论标过期 → 重新审核**。
 */
describe('§10.6 人改草稿：落盘 + 结论过期 + 重新审核', () => {
  /** 读一次 review 接口（界面上那条结论条就是从它来的）。 */
  async function reviewInfo(draftRunId: string): Promise<{
    review: { conclusion?: string; status?: string } | null
    reviewRunId: string | null
    reviewRunStatus: string | null
    stale: boolean | null
    versions: number
  }> {
    const res = await fetch(`${daemon.url}/api/crystallize/review?draftRunId=${draftRunId}`)
    const text = await res.text()
    assert.equal(res.status, 200, text)
    return JSON.parse(text) as never
  }

  /** 起一轮审核（不等判决：`stale` 的判据只看"有没有审核 run + 有没有指纹"）。 */
  async function startAudit(draftRunId: string): Promise<string> {
    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    const text = await res.text()
    assert.equal(res.status, 202, text)
    return (JSON.parse(text) as { reviewRunId: string }).reviewRunId
  }

  /** 等 `stale` 变成期望值（指纹文件是审核路由写的，理论上立刻就好；等一等不押调度顺序）。 */
  async function waitStale(draftRunId: string, want: boolean | null): Promise<boolean | null> {
    for (let i = 0; i < 200; i += 1) {
      const info = await reviewInfo(draftRunId)
      if (info.stale === want) return info.stale
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return (await reviewInfo(draftRunId)).stale
  }

  test('★★ 人改 → 落盘 → 结论过期 → 重审：四步都真的发生在磁盘与接口上', async () => {
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的流程（人要手改一版）'),
      target: { kind: 'new', purpose: '人改草稿流程' },
    })
    await startAudit(draftRunId)
    assert.equal(await waitStale(draftRunId, false), false, '刚审完、没改过 ⇒ 不过期')

    /**
     * ★★ 这里必须**同时**钉住"重试"那种情形（第一版就是在这里红的）。
     *
     * 这一轮的假后端不吐判决块 ⇒ 平台判定"判决不合规" ⇒ 它会**自动重试**一次
     * （`createRetryRun`，同 subject、同内容、相隔几毫秒），于是同一条草稿上有了**两条**
     * 审核 run，而接口报的是**最后**那条。第一版把指纹绑在"报出来的那条审核 run"上
     * ⇒ 恰恰在"审核出问题、重试了"的时候，`stale` 变成"判不出来"（null）——
     * 也就是人最需要知道"结论还算不算数"的那一刻，界面反而什么都不说。
     *
     * 所以这里等**报出来的审核 run 换了一条**（= 重试真的发生了），再断言 stale 仍然是
     * 一个**判得出来**的布尔值。只断言"不过期"会漏掉这条——重试前它也是 false。
     */
    const firstReviewRunId = (await reviewInfo(draftRunId)).reviewRunId
    let retried = false
    for (let i = 0; i < 200 && !retried; i += 1) {
      const info = await reviewInfo(draftRunId)
      retried = info.reviewRunId !== null && info.reviewRunId !== firstReviewRunId
      if (!retried) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(retried, true, '这一轮应该触发一次自动重试（假后端不吐判决块 ⇒ 判决不合规）')
    assert.equal(
      (await reviewInfo(draftRunId)).stale,
      false,
      '重试之后 stale 仍必须判得出来（第一版绑在"报出来那条 run"上 ⇒ 这里变成 null）',
    )

    const before = await reviewInfo(draftRunId)
    assert.equal(typeof before.stale, 'boolean', 'stale 必须是"判得出来"的（不是 null）')

    // ① 保存改动：写的是**磁盘**，不是浏览器内存
    const edited = `---\nname: hand-edited\ndescription: 人手改过的描述\n---\n\n# 人手改过的正文\n\n## When to Use\n- 手改\n\n## Procedure\n1. 手改\n`
    const saved = await fetch(`${daemon.url}/api/crystallize/save-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, files: { 'SKILL.md': edited } }),
    })
    const savedText = await saved.text()
    assert.equal(saved.status, 200, savedText)
    assert.deepEqual((JSON.parse(savedText) as { written: string[] }).written, ['SKILL.md'])

    const hut = join(workRoot, `skill-draft-${draftRunId}`, 'skill')
    assert.equal(await readFile(join(hut, 'SKILL.md'), 'utf8'), edited, '磁盘上真的换了内容')
    assert.equal(
      await readFile(join(hut, 'references', 'checklist.md'), 'utf8'),
      '# 自检\n- 每条结论都有证据\n',
      '只写不删：没在请求里的支持文件必须原样留着',
    )

    // ② 结论标记成"改之前的"
    assert.equal(
      await waitStale(draftRunId, true),
      true,
      '内容变了 ⇒ 那个结论不能继续算数（界面据此标「结论已过期」并给「重新审核」）',
    )

    // ③ 人改**不算一版**：额度按"同一来源起草过几版"算，人改不起新 run ⇒ 不吃额度
    assert.equal((await reviewInfo(draftRunId)).versions, before.versions, '人改不该被算成返工一版')

    // ④ 重审 ⇒ 指纹钉在新内容上 ⇒ 不再过期
    await startAudit(draftRunId)
    assert.equal(await waitStale(draftRunId, false), false, '重审之后钉的是改后的内容')
  })

  test('★ 保存的守卫：逃逸路径整单拒、非起草 run 拒、缺 id 拒、没跑完拒', async () => {
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的流程（保存守卫）'),
      target: { kind: 'new', purpose: '保存守卫' },
    })

    // 逃逸：整单拒（一个文件都不写），并且真的没写到小屋外面
    const escape = await fetch(`${daemon.url}/api/crystallize/save-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRunId,
        files: { 'SKILL.md': '# 好的\n', '../../../escaped.md': '# 想跑出去\n' },
      }),
    })
    const escapeText = await escape.text()
    assert.equal(escape.status, 400, escapeText)
    assert.equal((JSON.parse(escapeText) as { code?: string }).code, 'unsafe_path')
    assert.equal(
      await readFile(join(workRoot, 'escaped.md'), 'utf8').catch(() => null),
      null,
      '逃逸文件不许出现在工作根上',
    )
    assert.equal(
      await readFile(join(workRoot, `skill-draft-${draftRunId}`, 'skill', 'SKILL.md'), 'utf8').then(
        (t) => t.includes('想跑出去'),
      ),
      false,
      '整单拒之后，连合法的那份也不许被写',
    )

    // 非起草 run
    const otherRunId = await runOnce('写一份关于保存守卫的报告')
    const notDraft = await fetch(`${daemon.url}/api/crystallize/save-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: otherRunId, files: { 'SKILL.md': '# x\n' } }),
    })
    assert.equal(notDraft.status, 400)
    assert.equal(((await notDraft.json()) as { code?: string }).code, 'not_a_draft')

    // 缺 draftRunId / files 不是一组字符串
    const missing = await fetch(`${daemon.url}/api/crystallize/save-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missing.status, 400)
    assert.equal(((await missing.json()) as { code?: string }).code, 'draft_run_id_required')

    // ★ 起草没跑完 ⇒ 409。用 `draftGate` 把起草卡在"跑完之前"——
    //   ⚠️ 第一版我打算"POST 起草之后抢在它完成前再 POST 保存"，那是把纪律押在调度顺序上。
    // ⚠️ 写成 `let release: (() => void) | null = null` 再 `release?.()` 会被 tsc 判成
    //    "not callable"：赋值发生在 Promise 执行器**里面**，控制流分析看不见它，于是在
    //    `finally` 那一处 `release` 的类型被收窄成 `null`。而 `node --test`（只擦类型、
    //    不做检查）跑得好好的——正是 `pnpm run check` 里那一步 typecheck 才能抓到的形状。
    //    执行器是**同步**跑的，所以这里用确定赋值断言是安全的。
    let release!: () => void
    fakeBackend.draftGate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const res = await fetch(`${daemon.url}/api/crystallize/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: await runReviewed('审过的流程（起草中保存）'),
          target: { kind: 'new', purpose: '起草中保存' },
        }),
      })
      const draftText = await res.text()
      assert.equal(res.status, 202, draftText)
      const runningDraftId = (JSON.parse(draftText) as { draftRunId: string }).draftRunId
      const tooEarly = await fetch(`${daemon.url}/api/crystallize/save-draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: runningDraftId, files: { 'SKILL.md': '# 抢写\n' } }),
      })
      assert.equal(tooEarly.status, 409, await tooEarly.text())
    } finally {
      fakeBackend.draftGate = null
      release()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })
})

describe('§10.5：审核者真执行草稿脚本', () => {
  /** 读开关当前值（界面上也用它渲染）。 */
  async function scriptRunAllowed(): Promise<boolean> {
    const id = (await (await fetch(`${daemon.url}/api/identity`)).json()) as {
      allowReviewerScriptRun?: boolean
    }
    return id.allowReviewerScriptRun ?? true
  }

  async function setScriptRun(allow: boolean): Promise<void> {
    const res = await fetch(`${daemon.url}/api/workspace/reviewer-script-run`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow }),
    })
    assert.equal(res.status, 200, await res.text())
  }

  /** 起一条审核并等它收口，返回审核那一路投递出去的第一句话。 */
  async function auditAndReadPrompt(draftRunId: string): Promise<string> {
    const before = fakeBackend.prompts.length
    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    const text = await res.text()
    assert.equal(res.status, 202, text)
    const { reviewRunId } = JSON.parse(text) as { reviewRunId: string }
    for (let i = 0; i < 80; i += 1) {
      const r = (await (await fetch(`${daemon.url}/api/runs/${reviewRunId}`)).json()) as {
        status: string
      }
      if (['completed', 'failed', 'cancelled'].includes(r.status)) {
        const prompts = fakeBackend.prompts.slice(before)
        const auditPrompt = prompts.find((p) => p.includes('审一条刚起草出来的 skill'))
        assert.ok(auditPrompt, '审核那一路必须真的被派了')
        return auditPrompt
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('审核 run 未在限时内终态')
  }

  test('★★ 开关开（默认）⇒ 提示词要它**真的跑一遍**脚本，且只在小屋里活动', async () => {
    assert.equal(await scriptRunAllowed(), true, '默认必须是开')
    const sourceRunId = await runReviewed('审完的流程（真跑脚本）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '真跑脚本' },
    })
    const prompt = await auditAndReadPrompt(draftRunId)
    assert.match(prompt, /把 `skill\/scripts\/` 里的脚本真的跑一遍/)
    assert.match(prompt, /只在这个工作目录里活动/, '越界那条约束必须一起给（钩子会拦）')
    assert.match(prompt, /不要猜它能跑/, '不许用"看着能跑"顶替"真的跑过"')
  })

  test('★★ 开关关 ⇒ 换成"不要执行脚本"，且要求如实写"未被执行"（不是静默不说）', async () => {
    await setScriptRun(false)
    try {
      assert.equal(await scriptRunAllowed(), false, '开关要真的读得回来')
      const sourceRunId = await runReviewed('审完的流程（不许跑脚本）')
      const draftRunId = await draftAndWait({
        runId: sourceRunId,
        target: { kind: 'new', purpose: '不许跑脚本' },
      })
      const prompt = await auditAndReadPrompt(draftRunId)
      assert.match(prompt, /不要执行脚本/)
      assert.match(prompt, /如实写明"脚本未被执行"/)
      // ★ 关掉之后**不许**再要它去跑 —— 只删掉那一段是不够的（权限还在，它可能照跑）
      assert.doesNotMatch(prompt, /把 `skill\/scripts\/` 里的脚本真的跑一遍/)
    } finally {
      await setScriptRun(true)
    }
  })

  test('★★ D76 的钩子：小屋内部相对路径跑脚本是**放行**的，越界的才拦', async () => {
    // 这一条是"审核者真能跑脚本"的**地基**：钩子拦的是越界，不是"执行"这件事本身。
    // 直接量那个脚本（不是相信"应该没问题"）——它是唯一决定 Bash 能不能落地的闸门。
    const { execFileSync } = await import('node:child_process')
    const hook = join(process.cwd(), 'apps/daemon/src/run-hooks/pre-tool-use.py')
    // ⚠️ 必须用 `execFileSync`（它支持 `input`）而不是 `promisify(execFile)`：
    //    `execFile` **没有** `input` 选项 ⇒ 钩子等 stdin 等到天荒地老，测试整个挂住
    //    （我第一次就是这么写的，跑了 60 秒没有任何输出）。`timeout` 也一起给上，
    //    免得以后再犯时表现为"测试卡住"而不是"这条测试失败"。
    const decide = (command: string): string => {
      const out = execFileSync('python3', [hook], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: workRoot }),
        encoding: 'utf8',
        timeout: 10_000,
      })
      return (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string } })
        .hookSpecificOutput.permissionDecision
    }

    assert.equal(decide('bash skill/scripts/check.sh'), 'allow', '小屋里的脚本要放行')
    assert.equal(decide('bash ../../etc/passwd'), 'deny', '越界仍然要拦')
  })

  test('★ 审核 run 的"卡住"有兜底：跑脚本的空闲上限走**平台默认**（30 分钟），且日志里说出来', async () => {
    // ⚠️ 判据不是"我给审核设了多长"——我第一版就是这么写的，还写了个 10 分钟的值，
    //    理由写的是"没有上限才是问题"。那是**没查就写的**：`limits.timeoutMs` 是**空闲**
    //    上限，而平台**本来就有默认**（`executor.ts` 的 `DEFAULT_IDLE_TIMEOUT_MS` = 30 分钟
    //    没有任何输出 ⇒ 判成 `idle_timeout` 收掉）。所以"脚本挂住会不会把审核永远吊着"
    //    的答案一直是"不会"，而我自己那个 10 分钟反而比默认更紧、会误杀合法但安静的脚本。
    //    这条测试量的是**真实生效的那个上限**：run 日志里那句"用平台默认"。
    const sourceRunId = await runReviewed('审完的流程（卡住有兜底）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '卡住有兜底' },
    })
    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    const text = await res.text()
    assert.equal(res.status, 202, text)
    const { reviewRunId } = JSON.parse(text) as { reviewRunId: string }

    for (let i = 0; i < 80; i += 1) {
      const msgs = (await (
        await fetch(`${daemon.url}/api/runs/${reviewRunId}/messages`)
      ).json()) as { messages?: Array<{ content?: string }> }
      const note = (msgs.messages ?? []).map((m) => m.content ?? '').join('\n')
      if (note.includes('空闲上限')) {
        assert.match(note, /空闲 30 分钟/, '日志要说出用的是哪个默认值（不是"没上限"）')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('审核 run 的日志里没有"空闲上限"那句（上限就说不清了）')
  })
})
