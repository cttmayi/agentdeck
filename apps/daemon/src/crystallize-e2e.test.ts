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
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
// ★ 分批第 21 批：假后端靠"审核者身份的第一句"认出审核 run ⇒ 必须用**常量**，
//   不能把文案抄一份进测试（抄一份的话，判据一改它就悄悄失效，见 `isDraftReview` 的注释）。
import { SKILL_REVIEWER_INSTRUCTIONS } from './builtin-drafter.ts'

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

  /**
   * 起草 run **开工那一刻**产出目录里的内容（分批第 10 批加）。
   *
   * 为什么非要在"开工那一刻"拍：跑完之后 `skill/` 里当然有文件（起草者写的），
   * 那样量不出"这一版是从上一版开始改的"还是"从空的开始重写"。
   *
   * ⚠️ 分批第 16 批改成**按目录存一个列表**：一个任务一个目录之后，同一个目录会开工好几次
   *    （每一版一次），按目录存单个值会被后一版覆盖——我第一版就是这么量错的：读到的其实是
   *    第三版开工时的内容（它已经含着第二版补的那一行），于是断言"等于上一版"当场红，
   *    而红的原因是**假后端存错了**，不是产品错了。
   */
  readonly draftStartSkill: Record<string, Array<Record<string, string>>> = {}

  /** 改版这一路只动一行（模拟"按意见只改点到的地方"的起草者）。 */
  minimalEditOnRevise = false

  /** 投递出去的全部第一句话（审核那一路的提示词判据从这里读，与 run 日志互为对照）。 */
  readonly prompts: string[] = []

  /**
   * 每次执行时要求的"接哪个会话"（分批第 14 批：返工默认接上一版的会话）。
   *
   * 为什么要记这个：resume 是**请求侧**的决定，run 日志里那句"恢复自 run X"只有在真的恢复时
   * 才出现；而"daemon 到底有没有把 resumeSessionId 传下来"只有后端看得见。两处都要量。
   */
  readonly resumeRequests: Array<string | null> = []

  /**
   * 模拟"恢复被拒"（真机上的形状已实测：`thread/resume` 对不存在的线程回 JSON-RPC error）。
   *
   * 为什么要能模拟：被拒之后**这一版仍然要能正确地改出来**（依据是磁盘上的上一版）。
   * 只测"恢复成功"这条顺路，等于把"会话丢了怎么办"留给线上。
   */
  rejectResume = false
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
    this.resumeRequests.push(opts.resumeSessionId ?? null)
    /**
     * "这是审核 run 吗"的判据：**审核者身份里的第一句**（用常量，不用短语）。
     *
     * ⚠️ 这里踩过一次，值得记下来：原来写的是 `delivered.includes('审一条刚起草出来的 skill')`，
     *    那句短语当时活在**审核者的身份**（旧判据第一行）里。分批第 21 批把身份改写成
     *    「只审这条 skill **能不能被照着执行**」之后，短语没了 ⇒ **审核的重试轮**
     *    （`上一次你的输出没能通过格式校验…`，它的 prompt 里没有任务说明）就被当成了**起草 run**
     *    ⇒ 假后端顺手把 `skill/` 重写回夹具 ⇒ 人手工保存的内容被抹掉 ⇒
     *    红的是"返工起点不对"，而真正的原因是这条判据认不出审核者。
     *    ⇒ 判据必须钉在**平台常量**上：身份文案怎么改都跟着走，改不动就不会静默失效。
     */
    const isDraftReview = delivered.includes(SKILL_REVIEWER_INSTRUCTIONS.split('\n')[0] ?? '\u0000')

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
      // ★ 分批第 10 批：记下**开工那一刻**产出目录里已经有什么。
      //   这是"改版是从上一版开始改的"唯一的证据——跑完之后 `skill/` 里当然有文件
      //   （起草者写的），看不出它开始时是不是空的。
      const started = await readDirRecursive(join(opts.workDir, 'skill'))
      const log = this.draftStartSkill[opts.workDir] ?? []
      log.push(started)
      this.draftStartSkill[opts.workDir] = log
      // `minimalEditOnRevise`：模拟"只改意见点到的地方"的起草者（改版时在上一版末尾加一行）。
      // 不给它设开关的话，假后端每次都把整份夹具重写一遍 ⇒ 返工版的差异永远是"整份重写"，
      // 而那正是这一批要改掉的行为 ⇒ 断言就测不出"差异变小了"。
      const files =
        this.minimalEditOnRevise && Object.keys(started).length > 0
          ? { 'SKILL.md': `${started['SKILL.md'] ?? ''}- 补上：按意见补的一行\n` }
          : this.draftFiles
      for (const [rel, text] of Object.entries(files)) {
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
        // 被要求接会话、又被拒 ⇒ 如实上报（真机上适配器就是这个语义：回退新线程 + rejected）
        ...(this.rejectResume && opts.resumeSessionId ? { resumeRejected: true } : {}),
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
/** 递归读一个目录下的文本文件（相对路径 ⇒ 内容）。目录不存在 ⇒ `{}`。 */
async function readDirRecursive(dir: string, prefix = ''): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises')
  const out: Record<string, string> = {}
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) Object.assign(out, await readDirRecursive(join(dir, e.name), rel))
    else out[rel] = await readFile(join(dir, e.name), 'utf8')
  }
  return out
}

/**
 * 把自动返工轮数设成 n，返回"恢复默认"的函数。
 *
 * 为什么要有：分批第 23 批把上限从**硬编码 2** 改成了工作区设置（默认 10）。
 * 那之后"额度用尽才停"这类用例必须**显式**把轮数钉成 2，否则它会按 10 跑——
 * 第一次全量 `check` 里那条链跑了 76 分钟才收头，而 `+10 行` 那个断言等的其实是第 10 版。
 *
 * ⚠️ 必须是模块级：它被两个不同的 `describe` 用（§10.7、§10.8）。第一版写在 §10.5 的
 *    describe 里 ⇒ 另一块里 `ReferenceError: useReworkRounds is not defined`。
 */
const useReworkRounds = async (rounds: number): Promise<(() => Promise<void>)> => {
  const put = async (n: number): Promise<void> => {
    await fetch(`${daemon.url}/api/workspace/auto-rework`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rounds: n }),
    })
  }
  await put(rounds)
  return () => put(10)
}

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

/**
 * 读 JSON（连接层失败重试一次；见 §10.7 里 `getJson` 的注释）。
 */
async function getJsonFile<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${daemon.url}${path}`)
      const text = await res.text()
      assert.equal(res.status, 200, text)
      return JSON.parse(text) as T
    } catch (err) {
      if (attempt >= 1 || !String(err).includes('fetch failed')) throw err
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

/**
 * 等"按这一版改出来的下一版"出现（`revisedFrom === parentId` 的那条草稿 run）。
 *
 * ⚠️ **不许靠"目录里多出来一间小屋"来认**（第一版就是这么认的，全量跑时认错了）：
 *    第 9 批之后"改版来的新草稿自己会接着审"，于是整份文件里每条用例的链都会在后台继续跑，
 *    `workRoot` 是整份文件共用的 ⇒ "新出现的小屋"随时可能是**别的用例**那条链的产物。
 *    认错的后果不是"红"，而是**断言看错了对象**（拿别条链的小屋去断言"开工时里面是上一版"），
 *    那种绿比红更坏。判据必须是**这条链自己**的关系：run 记录里的 `revisedFrom`。
 */
async function waitRevisedFrom(parentId: string, budgetMs = 120_000): Promise<string> {
  // ⚠️ 分批第 17 批改实现（历史上这是**第二次**改它）：原来翻 `/api/crystallize/drafts`
  //    找"哪条 run 的 `revisedFrom` 指着我"，那在当时是对的（一版一行）。列表按**任务**聚合之后，
  //    每行给的是**最新那一版**的 id ⇒ 链中间那些版本压根不在列表里 ⇒ 这条等待永远等不到
  //    （表现是超时 120 秒，而不是一条清楚的断言失败——又一次"判据读错了地方"）。
  //    现在读**版本表**（`.versions.json`）：它就是这个任务的账，链的先后关系写在那里。
  //    扫全部任务目录而不是拼路径：`parentId` 可能是链中间的某一版，而任务目录以**首版**命名。
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    for (const name of await readdir(workRoot)) {
      if (!name.startsWith('skill-draft-')) continue
      const raw = await readFile(join(workRoot, name, '.versions.json'), 'utf8').catch(() => null)
      if (raw === null) continue
      const parsed = JSON.parse(raw) as { versions: Array<{ runId: string }> }
      const ids = parsed.versions.map((v) => v.runId)
      const at = ids.indexOf(parentId)
      if (at >= 0 && at + 1 < ids.length) return ids[at + 1]!
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`没等到"按 ${parentId.slice(-6)} 改出来的下一版"`)
}

/**
 * 这个任务目录里的版本表（按顺序的 run id 列表）。
 *
 * 分批第 16 批之后，"一个任务的第几版"只在这里有账（`listCrystallizeDrafts` 的行给的是聚合后的
 * 一行，`/api/runs/<id>` 也只说单条 run 的事）。
 */
async function readDraftVersionsFor(firstRunId: string): Promise<string[]> {
  const raw = await readFile(join(workRoot, `skill-draft-${firstRunId}`, '.versions.json'), 'utf8')
  const parsed = JSON.parse(raw) as { versions: Array<{ runId: string }> }
  return parsed.versions.map((v) => v.runId)
}

/**
 * 等一条 run 走到终态，返回它的 status。
 *
 * 为什么单独写一个：会话被拒那条用例要量的是"**这一版照样跑完**"——而它不是审核链的一环
 * （不产判决），所以 `waitSettled`（等判决状态）用不上。
 */
async function waitRunStatus(
  runId: string,
  wanted: readonly string[],
  budgetMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + budgetMs
  let last = ''
  while (Date.now() < deadline) {
    const run = await getJsonFile<{ status?: string }>(`/api/runs/${runId}`)
    last = String(run.status)
    if (run.status !== undefined && wanted.includes(run.status)) return run.status
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId.slice(-6)} 没在限时内走到 ${wanted.join('/')}（最后看到：${last}）`)
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

  test('★★★ 入库要标记**整条链**：多版任务的旧版不许在"重新沉淀"时被拉回来', async () => {
    /**
     * 使用者报的：「在沉淀页面中沉淀任务没有了（比如删除或者提交了），但没有被完全删除。
     * 我重新沉淀的时候，被重新拉出来了」。
     *
     * 量到的根因：入库原来只给**被入库的那一版**打 `crystallized`，而「恢复进行中的起草」
     * 是**逐版**判标记的 ⇒ 同一任务里更早的版本还活着 ⇒ 从同一来源再进沉淀页，它们被当成
     * "进行中的起草"复活。真机 store 里现成两个受害者：链 `1SJ4XF`（5 版，最新已入库、
     * **4 版漏标**）与 `SXFQP8`（2 版，最新已入库、**1 版漏标**）。
     *
     * 「放弃」那条路早就按整条链标（分批第 17 批），只有入库这一路有洞。
     */
    const runId = await runReviewed('多版任务入库')
    const v1 = await draftAndWait({ runId, target: { kind: 'new', purpose: '链入库' } })
    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1, feedback: '把 Procedure 补全' }),
    })
    assert.equal(res.status, 202, JSON.stringify(await res.clone().text()))
    const v2 = ((await res.json()) as { draftRunId: string }).draftRunId
    await waitRunStatus(v2, ['completed', 'failed', 'cancelled'])

    // 入库**最新那一版**
    const done = await commit({
      draftRunId: v2,
      target: { kind: 'new' },
      slug: 'chain-commit',
      files: {
        'SKILL.md':
          '---\nname: chain-commit\ndescription: 链入库\n---\n\n# 链入库\n\n## When to Use\nX。\n\n## Procedure\n1. Y。\n',
      },
    })
    assert.equal(done.status, 201, JSON.stringify(done.body))

    // ① 旧版也被标成已入库（写侧修复）
    const old = (await (await fetch(`${daemon.url}/api/runs/${v1}`)).json()) as {
      crystallized?: boolean
    }
    assert.equal(old.crystallized, true, '整条链都要标：旧版还活着就会被"重新沉淀"拉回来')

    // ② 从来源进沉淀页 ⇒ 没有"进行中的起草"
    const t2 = (await (await fetch(`${daemon.url}/api/crystallize/targets?runId=${runId}`)).json()) as {
      activeDraft: { runId: string } | null
    }
    assert.equal(t2.activeDraft, null, '入库后该来源不该再冒出任何一版')

    // ③ 列表里也没有这一行
    const list = (await (await fetch(`${daemon.url}/api/crystallize/drafts`)).json()) as {
      items: Array<{ taskRunId: string }>
    }
    assert.equal(
      list.items.some((r) => r.taskRunId === v1),
      false,
      '已入库的任务不许留在沉淀列表里',
    )
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

    // ★ 分批第 17 批：放弃的是**整个任务**（列表一行 = 一个任务，只打被点那一版会留下半死不活的链）
    const versionsAfterDiscard = await readDraftVersionsFor(draftRunId).catch(() => [draftRunId])
    if (versionsAfterDiscard.length > 1) {
      for (const id of versionsAfterDiscard) {
        const r = await daemon.store.getRun(id as RunId)
        assert.equal(r?.discarded, true, `链上第 ${id.slice(-6)} 版也要一起放弃（否则它还能被别处捡起来）`)
      }
    }
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
  test('★ 新 run 复用同一份素材 + 上一版产出进 skill/ + 意见进 feedback.md', async () => {
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

    // 素材：上一版素材被复制过来 + 新的 feedback.md
    const mat = (await (
      await fetch(`${daemon.url}/api/crystallize/material?draftRunId=${created.draftRunId}`)
    ).json()) as { items: Array<{ relPath: string; text: string }> }
    const rels = mat.items.map((i) => i.relPath)
    assert.ok(rels.includes('00-README.md'))
    assert.ok(rels.includes('feedback.md'), JSON.stringify(rels))
    assert.match(mat.items.find((i) => i.relPath === 'feedback.md')!.text, /写全命令参数/)
    assert.match(
      mat.items.find((i) => i.relPath === '00-README.md')!.text,
      /按意见改一版/,
      '索引要告诉起草者这一版在改上一版',
    )
    // ★ 分批第 10 批改判据（**不是**放宽）：上一版的产出不再放 `material/previous-draft/`，
    //   而是**放进产出目录 `skill/`**——"基于上一版改"要能成立，它就得在产出目录里。
    //   原来那条 `rels.some(r => r.startsWith('previous-draft/'))` 在当时是对的
    //   （上一版只当参考材料），现在它与新契约直接冲突（同一份内容放两处 ⇒ 改了一处另一处是旧的）。
    assert.ok(
      !rels.some((r) => r.startsWith('previous-draft/')),
      `素材里不该再有 previous-draft：${JSON.stringify(rels)}`,
    )
    assert.match(
      mat.items.find((i) => i.relPath === '00-README.md')!.text,
      /产出目录 `skill\/` 里就是上一版/,
      '索引要告诉起草者"在产出目录里改"（不是"参考一下再重写"）',
    )
    // ★ 分批第 16 批加：这一版**不是新开的小屋**（原来每版一间）。不写清的话，起草者会按
    //   前几版的记忆去找一个"新目录"，而真正的产出目录就在它脚下。
    assert.match(
      mat.items.find((i) => i.relPath === '00-README.md')!.text,
      /仍在\*\*同一个任务目录\*\*里/,
      '索引要说清"这是同一个任务目录，路径没变"',
    )
    // ★ 分批第 16 批：产出在**任务目录**里（= 首版那间小屋），不再是"新一版自己的小屋"
    const revisedSkill = await readDirRecursive(join(workRoot, `skill-draft-${first}`, 'skill'))
    assert.deepEqual(
      Object.keys(revisedSkill).sort(),
      Object.keys(fakeBackend.draftFiles).sort(),
      '上一版的产出（含支持文件）要原样出现在新一版的产出目录里',
    )
    // 上一版自己的 feedback.md 不会被一层层套进来
    assert.equal(rels.filter((r) => r === 'feedback.md').length, 1)
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

  test('★★ 起审核之前平台先跑了**定检**：`material/exec-check.md` 落盘，且措辞不把"没查"说成"通过"', async () => {
    // 为什么值得钉在 e2e 而不是只测 `skill-exec-check.ts`：定检的**位置**与**时机**才是
    // 这一批的重点——它必须在"起审核之前"写进**草稿小屋**的 `material/`（审核者读那里），
    // 而且**每轮覆盖**。放错地方（比如写进审核者自己的工作目录）时，单元测试全绿，
    // 审核者却永远读不到它——那正是本仓库第 5 条纪律说的"字段都在，就是没有路径让它发生"。
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的定检流程'),
      target: { kind: 'new', purpose: '定检流程' },
    })
    const draftRun = (await (await fetch(`${daemon.url}/api/runs/${draftRunId}`)).json()) as {
      workDir: string
    }
    const checkPath = join(draftRun.workDir, 'material', 'exec-check.md')

    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    const text = await res.text()
    assert.equal(res.status, 202, text)

    const md = await readFile(checkPath, 'utf8')
    assert.match(md, /平台定检/, '定检报告落在草稿小屋的 material/ 里（审核者读得到的地方）')
    assert.match(md, /SKILL\.md/, '定检至少看了骨架（SKILL.md 的 frontmatter 与两节标题）')
    // 这两句是"不许含糊"的落点：机器上缺 python3 时，它必须说"没查"，而不是沉默或算通过。
    assert.match(md, /没有结论/, '标"没查"的项必须写明它没有结论')
    assert.match(md, /不要把"没查"当成"通过"/, '读到它的人（审核者）必须被告知这个坑')
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
    let settled: Record<string, unknown> | null = null
    for (let i = 0; i < 200; i += 1) {
      const vs = (await (
        await fetch(`${daemon.url}/api/runs/${reviewRunId}/verdicts`)
      ).json()) as { verdicts?: Record<string, unknown>[] }
      const v = (vs.verdicts ?? [])[0]
      if (v && v.status !== 'validated') {
        settled = v
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (settled === null) throw new Error('审核判决没在限时内收口')
    /**
     * ★ 分批第 31 批：还要等**审核 run 自己**走到终态。
     *
     * 判决收口与 run 落终态是**两步**（先落库 `validated`，再 transition）。接口那侧有个
     * 刻意的廉价分支：审核还没收口时不算 `stopped`/`stalled`（那是结论，不是实时量，
     * 见 `autoReworkSummary` 的注释）。只等判决就回来读，会读到"审核还没收口"那一支
     * ⇒ `stopped` 读到 false。**单跑这个文件时侥幸通过，全量跑就红**（机器忙、两步之间的
     * 窗口变宽）——第 31 批全量跑时红了两条（「停止循环」「只标注不停循环」），单跑全绿。
     */
    for (let i = 0; i < 200; i += 1) {
      const run = (await (await fetch(`${daemon.url}/api/runs/${reviewRunId}`)).json()) as {
        status?: string
      }
      if (!['queued', 'deferred', 'waiting_local_directory', 'dispatched', 'running'].includes(String(run.status))) {
        return settled
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('审核 run 没在限时内落终态')
  }

  /**
   * 这个任务的版本表（runId 列表）——"多出一版"现在的表现。
   *
   * 分批第 16 批之前"多一版" = 多一间小屋（`skill-draft-<新 runId>`），所以判据是数目录；
   * 一个任务一个目录之后目录数**永远不会变**，再数它就是一条永远绿的判据（最坏的那种测试）。
   */
  async function draftVersionIds(firstRunId: string): Promise<string[]> {
    const file = join(workRoot, `skill-draft-${firstRunId}`, '.versions.json')
    const raw = await readFile(file, 'utf8').catch(() => null)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as { versions: Array<{ runId: string }> }
    return parsed.versions.map((v) => v.runId)
  }

  /**
   * 分批第 16 批删掉了两个 helper（`draftHuts` / `waitForNewHut`）。
   *
   * 它们量的是"返工会在旁边**多开一间小屋**"——那正是使用者判定为错的行为（"给意见后点重新起草，
   * 新增加了一个沉淀任务，而不是在原沉淀任务中执行"）。现在一个任务一个目录，"返工发生了没"
   * 的信号是**多了一条 `revisedFrom` 指过来的新 run**（`waitRevisedFrom`），不是多了一个目录。
   */
  /**
   * 自动返工的两道闸门（分批第 23 批，使用者：「设定可以 N 次，直到 PASS」）。
   *
   * 这两条量的是"闸门真的拦得住"：
   *   · 轮数设成 0 ⇒ 一轮都不自动起（`escalated`，交给人）；
   *   · 循环中点「停止循环」⇒ 这一轮之后不再自动起，且**正在跑的审核也取消**。
   */

  const failVerdict = (): Record<string, unknown> => ({
    schemaVersion: 1,
    conclusion: 'fail',
    reasonCode: 'style_violation',
    confidence: 0.8,
    findings: [
      {
        severity: 'high',
        summary: '正文里没有 `## When to Use` 一节',
        evidence: [{ blobRef: null, locator: 'SKILL.md', excerpt: '# 报告流程' }],
        detail: {},
      },
    ],
    action: null,
    escalateReason: null,
  })

  test('★★ 轮数设成 0 ⇒ 不通过也不自动起下一版（"关"必须是真的关）', async () => {
    // ⚠️ 设置不在 `/api/workspace/settings`（那个路径不存在），而是随 `/api/identity` 一起发的
    const settings = (await (
      await fetch(`${daemon.url}/api/identity`)
    ).json()) as { autoReworkRounds: number }
    assert.equal(settings.autoReworkRounds, 10, '默认必须是使用者定的 10')
    const put = await fetch(`${daemon.url}/api/workspace/auto-rework`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rounds: 0 }),
    })
    assert.equal(put.status, 200, await put.clone().text())
    const sourceRunId = await runReviewed('审完的流程（关掉自动返工）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '关掉自动返工' },
    })
    fakeBackend.draftReviewVerdict = failVerdict()
    try {
      const verdict = await reviewDraftAndWait(draftRunId)
      assert.equal(verdict.conclusion, 'fail')
      assert.equal(
        verdict.status,
        'escalated',
        '轮数 0 ⇒ 额度为 0 ⇒ 必须交给人（rework_requested 说明它还是自动起了下一版）',
      )
    } finally {
      fakeBackend.draftReviewVerdict = null
      // 恢复默认，别影响后面的用例（这个 daemon 是共享的）
      await fetch(`${daemon.url}/api/workspace/auto-rework`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rounds: 10 }),
      })
    }
  })

  test('★★★ 点「停止循环」⇒ 落标记文件、下一轮不再自动起（使用者:循环中唯一的入口）', async () => {
    const sourceRunId = await runReviewed('审完的流程（停止循环）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '停止循环' },
    })
    const stop = await fetch(`${daemon.url}/api/crystallize/stop-loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    assert.equal(stop.status, 200, await stop.clone().text())
    // 标记文件真的落盘（不然"停止"只是个界面状态）
    const stamp = JSON.parse(
      await readFile(join(workRoot, `skill-draft-${draftRunId}`, '.auto-rework.json'), 'utf8'),
    ) as { stoppedAt: number; stoppedBy: string }
    assert.equal(stamp.stoppedBy, 'human')
    assert.ok(stamp.stoppedAt > 0)

    fakeBackend.draftReviewVerdict = failVerdict()
    try {
      const verdict = await reviewDraftAndWait(draftRunId)
      assert.equal(verdict.conclusion, 'fail')
      assert.equal(
        verdict.status,
        'escalated',
        '人按过停止 ⇒ 这一轮必须交给人（rework_requested 说明它又自动起了一版）',
      )
      // 接口要如实报"停了"（界面据此不再显示"自动循环中"）
      const info = (await (
        await fetch(`${daemon.url}/api/crystallize/review?draftRunId=${draftRunId}`)
      ).json()) as { autoRework: { stopped: boolean; current: number; max: number } }
      assert.equal(info.autoRework.stopped, true)
      assert.equal(info.autoRework.current, 1, '这条链只起草过 1 版')
      assert.equal(info.autoRework.max, 10, '上限就是设置里那个数')
    } finally {
      fakeBackend.draftReviewVerdict = null
    }
  })

  test('★★★ 返工版被判「重写」⇒ **只标注、不停循环**（使用者定过：无进展不早停）', async () => {
    /**
     * 真机现场：那条链第 4 版改了 41%（阈值 40%）就被判「重写」——而我上一版（分批第 25 批）
     * 让它**直接停掉自动循环**：使用者看到的是「这轮明明还在跑，怎么就不动了」，
     * 而它既没有 PASS、也没用完轮数。
     *
     * 使用者 2026-10-25 的纠正：「没搞懂，不是要 PASS 才停止吗」——对，分批第 23 批他早就定过
     * 「无进展**不早停**，只标注」。所以闸门现在只写 `material/rework-guard.md` +
     * `rework-guard.json` 给界面看，**循环照常继续**。
     */
    const restoreRounds = await useReworkRounds(2)
    const sourceRunId = await runReviewed('审完的流程（闸门只标注）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '闸门只标注' },
    })
    fakeBackend.draftReviewVerdict = failVerdict()
    fakeBackend.minimalEditOnRevise = false // 假后端整篇重写 ⇒ 必然被判 rewrite
    try {
      const verdict = await reviewDraftAndWait(draftRunId)
      assert.equal(verdict.status, 'rework_requested', '有额度就必须派返工')
      const v2 = await waitRevisedFrom(draftRunId, 45_000)
      const taskDir = join(workRoot, `skill-draft-${draftRunId}`)

      // ① 标注必须落盘（人可读 + 机器可读）
      //
      // ⚠️ 分批第 33 批：这里原来**直接读**，于是全量跑时偶发 ENOENT。
      //    原因不是闸门没写，是**等错了对象**：`waitRevisedFrom` 只等"v2 这条 run 出现了"，
      //    而闸门报告是 v2 **开始审核**那一刻才算出来的（`startDraftAudit` 里数改动量）。
      //    两者之间有一个窗口，机器一忙就露出来。改成等文件出现（30s 预算，够跑一轮审核）。
      const reportPath = join(taskDir, 'material', 'rework-guard.md')
      const guardDeadline = Date.now() + 30_000
      let report = ''
      while (Date.now() < guardDeadline) {
        const got = await readFile(reportPath, 'utf8').catch(() => null)
        if (got !== null) {
          report = got
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.notEqual(report, '', `闸门报告没在限时内落盘：${reportPath}`)
      assert.match(report, /返工收敛判定/)
      const json = JSON.parse(
        await readFile(join(taskDir, 'material', 'rework-guard.json'), 'utf8'),
      ) as { kind: string; reasons: string[] }
      assert.notEqual(json.kind, 'ok', `整篇重写必须被判出来，实际 ${json.kind}`)
      assert.ok(json.reasons.length > 0)

      // ② **不许**写停止标记：那是我上一版违背口径的做法
      const stopFile = join(taskDir, '.auto-rework.json')
      const wrote = await readFile(stopFile, 'utf8').catch(() => null)
      assert.equal(wrote, null, '闸门只标注 ⇒ 不许落停止标记（否则循环就停了）')

      // ③ 循环真的继续：第 2 版之后还会自动起第 3 版（轮数钉成 2 ⇒ 到这里刚好用完）
      const v3 = await waitRevisedFrom(v2, 45_000)
      assert.ok(v3 !== '', '被判重写之后循环必须继续')

      // ④ 界面读得到这条标注
      const info = (await (
        await fetch(`${daemon.url}/api/crystallize/review?draftRunId=${v3}`)
      ).json()) as { autoRework: { stopped: boolean; guard: { kind: string } | null } }
      assert.equal(info.autoRework.stopped, false, '循环没有停')
      assert.ok(info.autoRework.guard !== null, '闸门标注要能被界面读到')
      assert.notEqual(info.autoRework.guard.kind, 'ok')
    } finally {
      fakeBackend.draftReviewVerdict = null
      fakeBackend.minimalEditOnRevise = false
      await restoreRounds()
    }
  })

  test('★★ 历史遗留的 `regressed` 停止标记一律忽略（那是被误停的两条链）', async () => {
    /**
     * 分批第 25 批我让闸门写 `stoppedBy: 'regressed'` 的停止标记，真机上已经误停了两条链。
     * 第 27 批作废了那个理由，但**不删使用者的文件**：读到就按"没停"处理。
     *
     * 否则那两条链会永远起不来（标记还在盘上），而界面上什么都不会说。
     */
    const sourceRunId = await runReviewed('审完的流程（遗留标记）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '遗留标记' },
    })
    const taskDir = join(workRoot, `skill-draft-${draftRunId}`)
    await writeFile(
      join(taskDir, '.auto-rework.json'),
      `${JSON.stringify({ stoppedAt: Date.now(), stoppedBy: 'regressed', draftRunId }, null, 2)}\n`,
      'utf8',
    )
    fakeBackend.draftReviewVerdict = failVerdict()
    fakeBackend.minimalEditOnRevise = true
    try {
      const verdict = await reviewDraftAndWait(draftRunId)
      assert.equal(
        verdict.status,
        'rework_requested',
        '遗留的 regressed 标记不许再拦着循环（它已被作废）',
      )
    } finally {
      fakeBackend.draftReviewVerdict = null
      fakeBackend.minimalEditOnRevise = false
    }
  })

  test('★★★ 邻链有很多版**不许**吃掉本链的返工额度（真机上因此一次都没自动返工）', async () => {
    /**
     * 真机现场（2026-10-23）：来源 run `Q2SQ16` 下挂着两条不相干的链
     * （`H5YM0E` 4 版 + `9D67DN` 10 版，目标都是 `{"kind":"new"}`）。额度原来按
     * "**同一来源**下已起草几版"算 ⇒ `usedReworks = 17` > 上限 2 ⇒ 每一轮都判"额度用尽
     * ⇒ 交给人"、`createReworkRun` 一次都没被调用 —— 使用者的体感就是"自动返工不存在"，
     * 于是手动点了 10 次「反馈」（$29.81）。
     *
     * 这条用例造一条**邻链**（同来源、同目标，但 `revisedFrom` 自成一根），再让本链第 1 版
     * 被判 fail：额度必须只数本链（= 0），所以返工必须真的派出去。
     */
    const sourceRunId = await runReviewed('审完的流程（邻链撑额度）')
    const srcRun = await daemon.store.getRun(sourceRunId as RunId)
    assert.ok(srcRun, '来源 run 得在（下面照它复制出邻链的几版）')
    // 邻链：3 版，根是 sib1（`revisedFrom` 为空 ⇒ 自成一根）
    let prev: string | null = null
    for (let i = 1; i <= 3; i += 1) {
      const sibId = ulid() as string
      await daemon.store.insertRun({
        ...srcRun!,
        id: sibId as RunId,
        kind: 'execute',
        status: 'completed',
        subject: {
          type: 'skill-draft',
          id: sibId,
          // 同来源（这就是旧口径会数进来的原因）
          sourceRunId: sourceRunId as never,
        },
        crystallizeTarget: { kind: 'new' },
        revisedFrom: (prev ?? null) as never,
        queuedAt: srcRun!.queuedAt + 100 * i,
        workDir: join(workRoot, `skill-draft-${sibId}`),
        finishedAt: srcRun!.queuedAt + 100 * i,
      })
      prev = sibId
    }

    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '本站额度的流程' },
    })
    fakeBackend.draftReviewVerdict = {
      schemaVersion: 1,
      conclusion: 'fail',
      reasonCode: 'style_violation',
      confidence: 0.8,
      findings: [
        {
          severity: 'high',
          summary: '正文里没有 `## When to Use` 一节',
          evidence: [{ blobRef: null, locator: 'SKILL.md', excerpt: '# 报告流程' }],
          detail: {},
        },
      ],
      action: null,
      escalateReason: null,
    }
    try {
      const verdict = await reviewDraftAndWait(draftRunId)
      assert.equal(
        verdict.status,
        'rework_requested',
        '本链只起草过 1 版 ⇒ 额度是满的；邻链那 3 版不许把额度吃掉（否则这里是 escalated）',
      )
      // 落点：真的多出一版（`revisedFrom` 指回被审的那一版）
      const v2 = await waitRevisedFrom(draftRunId)
      assert.notEqual(v2, draftRunId, '返工必须真的产出一版新的')
      // 而且这一版属于**本链**：它的根仍然是被审的那一版
      const v2Run = await daemon.store.getRun(v2 as RunId)
      assert.equal(v2Run?.revisedFrom, draftRunId, '新版的父必须是本链那一版（不是邻链）')
    } finally {
      fakeBackend.draftReviewVerdict = null
    }
  })

  test('★★ 判决 fail ⇒ 返工派得出去（判决状态 rework_requested）且意见落进新一版素材', async () => {
    const sourceRunId = await runReviewed('审完的流程（要触发自动返工）')
    const draftRunId = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '自动返工流程' },
    })
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

      // ★ 分批第 16 批：返工的信号是**新一条 run**（`revisedFrom` 指过来），不是新一间小屋——
      //   产出仍在同一个任务目录里改（使用者要的"在原任务中执行"）。
      const v2 = await waitRevisedFrom(draftRunId)
      const taskDir = join(workRoot, `skill-draft-${draftRunId}`)
      const feedback = await readFile(join(taskDir, 'material', 'feedback.md'), 'utf8')
      assert.match(feedback, /style_violation/, '理由码要交下去')
      assert.match(feedback, /正文里没有 `## When to Use` 一节/, '审核者的条目要交下去')
      assert.match(feedback, /SKILL\.md/, '位置要交下去（否则起草者不知道改哪儿）')
      // 被审的那一版**不许消失**：它的内容进了任务目录里的快照（`history/<runId>/skill/`）
      const snapshot = await readFile(join(taskDir, 'history', draftRunId, 'skill', 'SKILL.md'), 'utf8')
      assert.ok(snapshot.length > 0, '被审的那一版必须有快照（差异对比与回退都读它）')
      const versions = JSON.parse(await readFile(join(taskDir, '.versions.json'), 'utf8')) as {
        versions: Array<{ runId: string }>
      }
      // 前两版必须在表里、且按时间排好（这条链会继续自动往下跑：判决 fail + 有额度 ⇒ 还要返工，
      // 所以表里后面可能还有第三、四版——判据只钉前两版，别把"链会自己往下走"当成失败）
      assert.deepEqual(
        versions.versions.slice(0, 2).map((v) => v.runId),
        [draftRunId, v2],
        '版本表要按顺序记着这两版（同一个任务的两版，不是两个任务）',
      )
      // ★★ 使用者的原话就是这条：**不许再多出一个沉淀任务**。返工的那几版**不能**有自己的小屋。
      const huts = (await readdir(workRoot)).filter((n) => n.startsWith('skill-draft-'))
      for (const v of versions.versions) {
        if (v.runId === draftRunId) continue
        assert.ok(
          !huts.includes(`skill-draft-${v.runId}`),
          `第 ${v.runId.slice(-6)} 版不该有自己的小屋（那就是"多出来一个沉淀任务"）：${JSON.stringify(huts.filter((h) => h.includes(v.runId.slice(-6))))}`,
        )
      }
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
    // ★ 分批第 16 批改判据（**不是**放宽）：在新模型里"多出一版"的表现是**版本表被追加**，
    //   而不再可能"多出一间小屋"（一个任务一个目录）——只数小屋的话，这条判据会永远绿。
    const before = await draftVersionIds(draftRunId)

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
      assert.deepEqual(await draftVersionIds(draftRunId), before, '通过不该多出草稿小屋')
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
    // ★ 分批第 16 批改判据（**不是**放宽）：在新模型里"多出一版"的表现是**版本表被追加**，
    //   而不再可能"多出一间小屋"（一个任务一个目录）——只数小屋的话，这条判据会永远绿。
    const before = await draftVersionIds(draftRunId)

    // `draftReviewVerdict` 保持 null ⇒ 假后端给的是普通产出（没有判决围栏）
    const verdict = await reviewDraftAndWait(draftRunId)
    assert.equal(verdict.conclusion, 'needs_human', '不合规要如实降级，不许伪装成通过')
    assert.notEqual(verdict.status, 'rework_requested', '审核没跑成不是"活没干好"，不返工')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await draftVersionIds(draftRunId), before, '不合规时一版都不该多')
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
 * §10.8 返工契约：**基于上一版改**，不是重写一版（2026-10-21 分批第 10 批）。
 *
 * 使用者问「为什么是按意见重新起草呢，而不是基于意见修改」。查下来的事实是：返工这条路
 * **物理上做不到"基于上一版改"**——上一版被放进 `material/previous-draft/`（只当参考材料），
 * 产出目录 `skill/` 是**空的**，而产出契约明写「整份产出，不是补丁」⇒ 起草者只能从头重写。
 * 真机上的表现是返工版差异 `+80 −25`（几乎整份重写）：贵、慢，而且上一版里已经对的地方
 * 每改一版都要重新冒一次被改坏的风险。
 *
 * 这一条钉两件事：① 改版小屋**开工那一刻**产出目录里已经是上一版（这是"能在上面改"的前提）；
 * ② 产出的差异因此是**一行**，不是整份。
 */
describe('§10.8 返工契约：基于上一版改（不是重写一版）', () => {
  test('★★ 改版开工时 skill/ 里已是上一版、意见带位置与原文、差异是一行', async () => {
    // 这条量的是"返工契约"（改哪里、意见带没带位置），与跑几轮无关 ⇒ 钉成 2 轮图个快
    const restoreRounds = await useReworkRounds(2)
    const base = fakeBackend.draftFiles
    fakeBackend.minimalEditOnRevise = true
    fakeBackend.draftReviewVerdict = {
      schemaVersion: 1,
      conclusion: 'fail',
      reasonCode: 'style_violation',
      confidence: 0.8,
      findings: [
        {
          severity: 'high',
          summary: '正文里没有 `## When to Use` 一节',
          evidence: [{ blobRef: null, locator: 'SKILL.md:12', excerpt: '# 报告流程' }],
          detail: {},
        },
      ],
      action: null,
      escalateReason: null,
    }
    try {
      const { readdir } = await import('node:fs/promises')
      const sourceRunId = await runReviewed('审完的流程（返工契约）')
      const v1 = await draftAndWait({
        runId: sourceRunId,
        target: { kind: 'new', purpose: '返工契约流程' },
      })

      const started = await fetch(`${daemon.url}/api/crystallize/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: v1 }),
      })
      assert.equal(started.status, 202, await started.text())

      // 等"按 v1 改出来的那一版"（**不是**"目录里多了一间小屋"——那会认到别条链的产物）
      const v2 = await waitRevisedFrom(v1)
      // ★ 分批第 16 批：任务目录是**首版**那间小屋（v2 没有自己的小屋了）
      const hut = `skill-draft-${v1}`
      assert.ok(
        !(await readdir(workRoot)).includes(`skill-draft-${v2}`),
        '第 2 版不许另开一间小屋（使用者要的"在原任务中执行"）',
      )

      // ① 开工那一刻产出目录里**已经是上一版**（含支持文件）——这是"能在上面改"的前提
      const starts = fakeBackend.draftStartSkill[join(workRoot, hut)] ?? []
      assert.ok(
        starts.length >= 2,
        `这个任务目录该开工至少两次（首版 + 至少一版返工），实际 ${starts.length} 次`,
      )
      // 首版开工时目录是**空的**（它是从零起草的）——先量这一条，后面那条"有内容"才有意义：
      // 不量的话，"开工时有文件"可能只是因为上一版恰好没被清掉（那时候判据是空的）
      assert.deepEqual(
        Object.keys(starts[0]!),
        [],
        `首版开工时 skill/ 该是空的，实际 ${JSON.stringify(Object.keys(starts[0]!))}`,
      )
      for (const atStart of starts.slice(1)) {
        assert.ok(
          Object.keys(atStart).includes('SKILL.md'),
          `改版开工时 skill/ 里就该有上一版的 SKILL.md（实际：${JSON.stringify(Object.keys(atStart))}）`,
        )
        assert.ok(
          Object.keys(atStart).includes('references/checklist.md'),
          '支持文件也要在（上一版有的东西不许凭空消失）',
        )
      }
      // 第一次返工开工时那一份 = 首版的内容（原样，逐字）
      assert.equal(
        starts[1]!['SKILL.md'],
        base['SKILL.md'],
        '第一次返工开工时，产出目录里必须**逐字**就是上一版',
      )

      // ② 上一版**不再**在素材里出现第二份（同一份内容放两处 ⇒ 改了一处另一处就是旧的）
      const material = await readdir(join(workRoot, hut, 'material'))
      assert.ok(!material.includes('previous-draft'), `素材里不该再有 previous-draft（实际 ${material.join(',')}）`)
      assert.ok(material.includes('feedback.md'), '意见必须在')

      // ③ 意见是**能直接照做**的形状：位置 + 原文 + "只改写过的文件"
      const feedback = await readFile(join(workRoot, hut, 'material', 'feedback.md'), 'utf8')
      assert.match(feedback, /SKILL\.md:12/, '位置要交下去（含行号）')
      assert.match(feedback, /# 报告流程/, '那一处的原文要交下去')
      assert.match(feedback, /产出目录 `skill\/` 里已经是上一版/, '要告诉起草者"在哪儿改"')
      assert.match(feedback, /写回 `skill\/`（完整文件，不是补丁）/, '要告诉起草者"改完怎么写回"')

      // ④ 第一句话里的契约是"只改点到的地方"（不是"整份产出"）
      const revisePrompt = fakeBackend.prompts.find((p) => p.includes('这一版是**在上一版基础上按意见改**'))
      assert.ok(revisePrompt !== undefined, '改版那一路的第一句话要有"按意见改"这一段')
      assert.match(revisePrompt, /只改意见点到的地方/, '契约要写成增量修改')
      assert.ok(
        !revisePrompt.includes('不是补丁。'),
        '旧的"整份产出，不是补丁"那句必须撤掉（它才是"重写一版"的根源）',
      )

      // ⑤ ★ 差异因此是一行，不是整份（这一条就是使用者那句话的答卷）
      const diff = (await (
        await fetch(`${daemon.url}/api/crystallize/diff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draftRunId: v2, against: 'previous' }),
        })
      ).json()) as { baselineLabel: string; totals: { added: number; removed: number; changed: number } }
      assert.equal(diff.baselineLabel, '上一版草稿', '基线必须是上一版草稿')
      assert.ok(
        diff.totals.added <= 2 && diff.totals.removed === 0,
        `返工版相对上一版只该多一行（实际 +${diff.totals.added} −${diff.totals.removed}）`,
      )
      assert.equal(diff.totals.changed, 1, '只动一个文件')
    } finally {
      fakeBackend.minimalEditOnRevise = false
      fakeBackend.draftReviewVerdict = null
      await restoreRounds()
    }
  })
})

/**
 * §10.7 自动再审：**改版来的新草稿跑完 ⇒ 自动接一轮审核**（2026-10-21 分批第 9 批）。
 *
 * 起因是使用者的一句话：「为什么是按意见重新起草呢，而不是基于意见修改」——顺着查"返工"这条链
 * 时发现：**自动返工只做到"产一版新的"就停了**，新版停在待审核等人点一次「开始审核」。
 * 也就是"自动返工"是半截链子，与使用者心里的"自动改进直到过审"差着一整轮审核。
 *
 * 这一条钉的是**整条链跑到头**：初版不自动审 → 人点一次 → fail ⇒ 返工 ⇒ 新版**自动**审
 * ⇒ fail ⇒ 返工 ⇒ 新版自动审 ⇒ 额度用尽（escalated）才停，且**不许多产一版**。
 * 终止性靠返工额度（`SKILL_DRAFT_REWORK_LIMIT` = 2），不是靠这个钩子——所以这条用例
 * 同时是"这条链不会无限烧钱"的证明。
 */
describe('§10.7 自动再审：改版来的新草稿跑完自动接一轮审核', () => {
  async function huts(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    return (await readdir(workRoot)).filter((n) => n.startsWith('skill-draft-'))
  }


  /** 读一条草稿的审核现场（判决没落库时 `review` 是 null）。 */
  /**
   * 读 JSON（**连接层失败重试一次**）。
   *
   * ⚠️ 这是量出来的：全量跑（`pnpm run check` 会把所有测试文件并行起来，机器很忙）时，
   *    轮询里偶尔撞到 `TypeError: fetch failed / ECONNRESET`——机器忙的时候这个 daemon 的
   *    HTTP 连接会空闲超过 keep-alive 时限，服务端把 socket 关掉，而客户端正好在这个瞬间
   *    复用了它。这是 HTTP 既有行为，**不是产品缺陷**（单跑从不出现，全量跑偶发）。
   *    原来那次红被误读成"链有问题"；重试一次就能把"观察方式的问题"和"链的问题"分开。
   */
  async function getJson<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await fetch(`${daemon.url}${path}`)
        const text = await res.text()
        assert.equal(res.status, 200, text)
        return JSON.parse(text) as T
      } catch (err) {
        if (attempt >= 1 || !String(err).includes('fetch failed')) throw err
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  async function draftReview(draftRunId: string): Promise<{
    review: { status?: string; conclusion?: string } | null
    reviewRunId: string | null
    reviewRunStatus: string | null
    versions: number
  }> {
    return getJson(`/api/crystallize/review?draftRunId=${draftRunId}`)
  }

  /**
   * 等一条草稿的判决走到**某个终态**（返回它）。
   *
   * ⚠️ 第一版是"判决行一出现就返回"，全量跑时读到的是**半成品**：那条判决的 `status` 是
   *    `validated`，而 `conclusion` 已经是 `fail`——判决行先落、返工决定后落，这是
   *    `decideReview` 内部的中间态。表现是断言"该返工"却拿到 `validated`
   *    （单跑这条用例时窗口没撞上，全量跑才撞上——同一个"全量才红"的坑）。
   *    所以等**预期的那个终态**，不等"有判决了"。
   */
  async function waitSettled(
    draftRunId: string,
    wanted: readonly string[],
  ): Promise<{ status?: string; conclusion?: string }> {
    // ⚠️ 预算是 60 秒，不是 10 秒——**量出来的**：第 9 批之后"改版来的新草稿自己会接着审"，
    //    于是整份文件里每条用例的链都会在后台继续跑（审核 + 判决不合规的自动重试都占着 daemon 的
    //    并发额度）。单跑这条用例时 10 秒足够，全量跑时第 2 版等不到返工决定。
    //    ⚠️ 报错里带上**最后看到的现场**（判决状态 / 审核 run 状态）：只说"超时"的话，
    //    下一次红的人得从头再查一遍是"链没起来"还是"链卡住了"。
    let last = ''
    for (let i = 0; i < 2400; i += 1) {
      const info = await draftReview(draftRunId)
      const st = info.review?.status
      last = `判决=${String(st)} 审核run=${String(info.reviewRunId?.slice(-6))}/${String(info.reviewRunStatus)} 版本=${info.versions}`
      if (st !== undefined && wanted.includes(st)) return info.review as { status?: string }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`草稿 ${draftRunId.slice(-6)} 的判决没在限时内走到 ${wanted.join('/')}（最后看到：${last}）`)
  }

  test('★★ 整条链跑到头：初版等人点，之后每一版都自动接着审，额度用尽才停', async () => {
    // 分批第 23 批起上限来自设置（默认 10）⇒ 这条"跑满就停"的用例把轮数钉成 2
    const restoreRounds = await useReworkRounds(2)
    /**
     * ★ 分批第 25 批：这条必须让假后端**只改点到的地方**。
     *
     * 假后端默认把整份夹具重写一遍 ⇒ 返工版和上一版几乎完全不同 ⇒ 新加的收敛闸门
     * 会判 `rewrite` 并**停掉自动循环**（那正是闸门的职责）⇒ 这条用例等第 3 版会等到超时
     * （第一次全量 check 里就是它红：「没等到"按 0SF1XX 改出来的下一版"」）。
     * ⚠️ 所以改的是**夹具的起草者行为**，不是放宽闸门：真机上"收敛"的起草者本来就是
     *    只改点名处（第 15 批量过：整篇重写的那条链 15 版还在震荡）。
     */
    fakeBackend.minimalEditOnRevise = true
    // 这份判决照合规形状写（理由码与严重度都是平台枚举）——不合规的判决不会返工，
    // 那条坑 §10.5 已经记过（第一版随手写的 reasonCode/severity 让整条链一次都没触发）。
    fakeBackend.draftReviewVerdict = {
      schemaVersion: 1,
      conclusion: 'fail',
      reasonCode: 'style_violation',
      confidence: 0.8,
      findings: [
        {
          severity: 'high',
          summary: '正文里没有 `## When to Use` 一节',
          evidence: [{ blobRef: null, locator: 'SKILL.md', excerpt: '# 自动再审流程' }],
          detail: {},
        },
      ],
      action: null,
      escalateReason: null,
    }
    try {
      const sourceRunId = await runReviewed('审完的流程（自动再审链）')
      const v1 = await draftAndWait({
        runId: sourceRunId,
        target: { kind: 'new', purpose: '自动再审流程' },
      })

      // ① **初版不自动审**：第一次审核是"要不要花这笔钱"的决定，该由人做
      await new Promise((resolve) => setTimeout(resolve, 300))
      const first = await draftReview(v1)
      assert.equal(first.reviewRunId, null, '初版跑完不许自己起审核（那笔钱要人决定）')
      assert.equal(first.versions, 1)

      // ② 人点一次「开始审核」⇒ fail ⇒ 返工 ⇒ 第 2 版
      const started = await fetch(`${daemon.url}/api/crystallize/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: v1 }),
      })
      assert.equal(started.status, 202, await started.text())
      const verdict1 = await waitSettled(v1, ['rework_requested'])
      assert.equal(verdict1.status, 'rework_requested', '有额度 ⇒ 返工派得出去')

      // 第 2 版 = "按 v1 改出来的那一版"（**关系**，不是"目录里多数出来一间"——见 `waitRevisedFrom`）
      const v2 = await waitRevisedFrom(v1)

      // ③ ★★ 第 2 版**没有人点过审核**，它必须自己接上——这一条就是这一批的全部意义。
      //
      // ⚠️ 这里断言的是**不变量**（"它自己挂上了一条审核 run"），**不是**判决的中间态。
      //    第一版抓的是"等到 rework_requested"，而整条链可能在一两个轮询之间就跑到了头
      //    （实测报错现场：`判决=escalated 审核run=.../completed 版本=3`）——那是**观察窗口**
      //    太窄，不是链的错。终端态由 ④ 那一步按额度钉住（那里等的是稳定状态）。
      let audited = false
      for (let i = 0; i < 600 && !audited; i += 1) {
        audited = (await draftReview(v2)).reviewRunId !== null
        if (!audited) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(audited, true, '第 2 版必须自己接上审核（没有人点过任何按钮）')

      // ④ 第 3 版同样自动审；此时额度用尽 ⇒ escalated ⇒ 链停在这里
      const v3 = await waitRevisedFrom(v2)
      const third = await waitSettled(v3, ['escalated'])
      assert.equal(third.status, 'escalated', '额度用尽 ⇒ 交给人（不再返工）')
      // 第 2 版那份判决（链跑到头之后再读，读的是稳定值）：它是**自动接上的那轮审核**给的，
      // 结论是 fail —— 于是才有第 3 版
      assert.equal(
        (await draftReview(v2)).review?.conclusion,
        'fail',
        '第 2 版的判决来自"自动接上的那一轮审核"（没人点过任何按钮）',
      )

      // ⑤ 停下来之后**不许再产第 4 版**（这条链不会自己烧下去）
      //
      // ⚠️ 判据用"**有没有按 v3 改出来的下一版**"（关系），不用"小屋总数"：
      //    `workRoot` 是整份文件共用的，别的用例的链随时在开新小屋（第一版数总数 ⇒ 全量跑时
      //    数出来 37）。这里还要给链一点时间——额度用尽到"确定不再开"之间隔着一次收尾。
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const list = await getJsonFile<{ items: Array<{ runId: string }> }>('/api/crystallize/drafts')
      const next: string[] = []
      for (const item of list.items) {
        const run = await getJsonFile<{ revisedFrom?: string }>(`/api/runs/${item.runId}`)
        if (run.revisedFrom === v3) next.push(item.runId)
      }
      assert.deepEqual(next, [], '额度用尽之后不许再自动开新版')
      assert.equal((await draftReview(v3)).versions, 3, '版本数停在 3')
    } finally {
      fakeBackend.draftReviewVerdict = null
      fakeBackend.minimalEditOnRevise = false
      await restoreRounds()
    }
  })
})

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

/**
 * ══════════════════════════════════════════════════════════════════
 * 返工：**默认接上一版的会话**，但人改过就不接（分批第 14 批）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这一块改过一次，两次的差别值得记下来：
 *
 *   · **第 13 批**（我做的）：返工起全新进程、不接会话。理由是"产出契约以文件为准"——
 *     而文件确实是依据（第 10 批把上一版放进了产出目录）。但我把这条当成"必须全新进程"，
 *     其实它只说明"不需要会话"。
 *   · **第 14 批**（使用者判断"resume 更合适"，我复核后同意）：接上一版的会话。
 *     起草者刚写过这一版——素材、规范、为什么这么组织都在它的上下文里，接上就省一遍重读，
 *     风格也连得上；而且这条能力平台本来就有（codex 走 app-server 的 `thread/resume`，
 *     已实测；被拒时适配器回退新线程 + `resumeRejected=true`，daemon 落一条 inbox 提醒）。
 *
 * ⚠️ 但有一个**真实风险**必须结构上挡住，而不是指望模型听话：第 8 批起人可以在编辑器里改草稿
 *    并落盘（`save-draft`）。那条被改过的草稿如果走 resume，起草者记忆里的"上一版"和人手上的
 *    "上一版"不是一个东西 ⇒ 它按记忆去改，会把人改的地方**改回去**，且没有任何提示。
 *    ⇒ **人改过（`.human-edits.json` 在）就不接会话**：全新进程 + 以磁盘为准。
 *
 * 所以下面三条用例是一组：① 没人改过 ⇒ 接；② 人改过 ⇒ 不接；③ 被拒 ⇒ 仍然改得对。
 */
describe('返工：默认接上一版的会话，人改过就不接', () => {
  test('★ 没人改过 ⇒ 接上一版的会话（run 日志「恢复自 run …」+ 后端真收到 resumeSessionId）', async () => {
    const sourceRunId = await runReviewed('审完的流程（量接不接会话）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '量会话' },
    })
    // ① 先量清"接得上"：上一版自己留下了会话 id（假后端与真 codex 一样如实上报）
    const v1Run = await daemon.store.getRun(v1 as RunId)
    assert.equal(
      v1Run?.sessionId,
      'fake-session-1',
      '上一版必须留下 sessionId——不留的话，"接上了"这句话是空的',
    )

    fakeBackend.resumeRequests.length = 0
    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1, feedback: '把第一步的命令说全' }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const created = (await res.json()) as { draftRunId: string; revisedFrom: string }
    assert.equal(created.revisedFrom, v1, '新 run 要记着"它是从哪一版改出来的"')
    // ①b 起草者读到的那份索引页要说明"这一版接上了会话 + 以磁盘为准"
    //     （判据读它而不是读接口字段：字段只有测试在看，而索引页是起草者真读的东西）
    const indexForResume = await readFile(
      join(workRoot, `skill-draft-${v1}`, 'material', '00-README.md'),
      'utf8',
    )
    assert.match(indexForResume, /接上了你上次写这一版的会话/)
    assert.match(indexForResume, /以磁盘上的内容为准/, 'resume 的那一版必须点明"记忆可能过时，以磁盘为准"')

    // ② run 日志要说清"接的是哪一条 run 的会话"（出问题时这是唯一线索）
    const want = `会话：恢复 fake-session-1——恢复自 run ${v1}`
    let logged = ''
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const messages = await daemon.store.listRunMessages(created.draftRunId as RunId, -1)
      logged = messages.map((m) => m.content).join('\n')
      if (logged.includes('会话：')) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.ok(logged.includes(want), `run 日志该说清接的是谁的会话，实际：\n${logged.slice(0, 400)}`)

    // ③ 后端那一侧要真收到（日志是"平台以为"，这条是"真传下去了"）
    assert.ok(
      fakeBackend.resumeRequests.includes('fake-session-1'),
      `后端没收到 resumeSessionId（收到的是 ${JSON.stringify(fakeBackend.resumeRequests)}）⇒ 日志会说谎`,
    )
  })

  test('★★ 人改过这一版 ⇒ **不接**会话（免得按记忆把人改的覆盖回去）', async () => {
    const sourceRunId = await runReviewed('审完的流程（人改过再返工）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '人改过' },
    })
    // ① 模拟人在编辑器里改一句并保存（第 8 批那条路）
    const saved = await fetch(`${daemon.url}/api/crystallize/save-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRunId: v1,
        files: { 'SKILL.md': '# 报告流程（人手改过）\n\n## Procedure\n1. 我改的\n' },
      }),
    })
    assert.equal(saved.status, 200, await saved.clone().text())
    // 标记真的落盘了（不然下面"不接"只是因为别的原因）
    const stamp = JSON.parse(
      await readFile(join(workRoot, `skill-draft-${v1}`, '.human-edits.json'), 'utf8'),
    ) as { files: string[] }
    assert.deepEqual(stamp.files, ['SKILL.md'], '人改过哪些文件要记下来（进索引页，起草者要知道）')

    fakeBackend.resumeRequests.length = 0
    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1, feedback: '再改一处' }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const created = (await res.json()) as { draftRunId: string }

    // ② 确实没把上一版的会话传下去
    assert.ok(
      !fakeBackend.resumeRequests.includes('fake-session-1'),
      '人改过还接会话 ⇒ 起草者会按记忆把人改的地方改回去',
    )
    // ③ 而"依据"仍然在磁盘上：**开工那一刻**产出目录里就是我改过的那一份。
    //    ⚠️ 分批第 16 批改判据（**不是**放宽）：原来量的是"新小屋里的 SKILL.md"——那时每一版
    //    自己一间小屋、上一版被复制过去；现在原地改 ⇒ 跑完之后那份内容**应该**被这一版覆盖
    //    （那才是"改一版"本来的意思）。真正要保证的是**起草者开工时看到的**就是人改过的那份：
    //    这正是"不接会话"要达到的效果——它读磁盘，读到的就是人的改动。
    //    ⚠️ 也正因为改成了"读捕获"，这里必须**等这一版跑完**再读：原来读目录时，daemon 在
    //    submit 之前就把上一版复制进新小屋了（同步可见），而捕获要等假后端真被调起来才有
    //    ——我第一版没等，读到 `undefined`，于是红的原因变成了"判据读早了"，而不是产品不对。
    await waitRunStatus(created.draftRunId, ['completed', 'failed'])
    const starts = fakeBackend.draftStartSkill[join(workRoot, `skill-draft-${v1}`)] ?? []
    assert.equal(
      (starts[starts.length - 1] ?? {})['SKILL.md'],
      '# 报告流程（人手改过）\n\n## Procedure\n1. 我改的\n',
      '人改过的内容必须是新一版的起点（不接会话，但内容照样带过去）',
    )
    // ④ 索引页要说清这一版为什么是全新会话（起草者得知道"以磁盘为准"）
    const index = await readFile(
      join(workRoot, `skill-draft-${v1}`, 'material', '00-README.md'),
      'utf8',
    )
    assert.match(index, /全新.*会话/, '索引页要说明这是全新会话')
    assert.match(index, /SKILL\.md/, '要点出哪几份是人改过的')
  })

  test('★★ 一个沉淀任务 = 一个目录：返工在同目录里改，上一版进不可变快照', async () => {
    // 这一批（第 16 批）**推翻**了上一批的"每版一间小屋"，所以这条用例是重写的：
    // 使用者判定"给意见后点重新起草，新增加了一个沉淀任务，而不是在原沉淀任务中执行"，
    // 而且他自己机器上真有一条 7 版的链（`9D67DN → … → B3R0ST`）＝列表里 7 个条目。
    //
    // 新模型下要同时成立三件事，缺一条都算没做到：
    //   ① 目录不变：返工 run 的 workDir = 任务目录（首版那间小屋），且**没有**多出新目录；
    //   ② 上一版不丢：它的内容进了 `history/<上一版 runId>/skill/`（不可变、只写一次）；
    //   ③ 版本有账：`.versions.json` 按顺序记着每一版（谁跑的、有没有人改过、快照在哪）。
    //     ⚠️ ②③ 是 ① 的**代价**：原地改会覆盖上一版，不把这三样补上就是"改一版丢一版"。
    const sourceRunId = await runReviewed('审完的流程（量一个任务一个目录）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '同目录返工' },
    })
    const taskDir = join(workRoot, `skill-draft-${v1}`)
    const v1Skill = await readFile(join(taskDir, 'skill', 'SKILL.md'), 'utf8')
    const hutsBefore = (await readdir(workRoot)).filter((n) => n.startsWith('skill-draft-'))

    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1, feedback: '改一句' }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const created = (await res.json()) as { draftRunId: string }
    const v2 = created.draftRunId
    await waitRunStatus(v2, ['completed', 'failed'])

    // ① 目录不变 + 不多出小屋
    const v2Run = (await (await fetch(`${daemon.url}/api/runs/${v2}`)).json()) as {
      workDir: string
    }
    assert.equal(
      v2Run.workDir,
      taskDir,
      `返工必须在**原任务目录**里干活，实际 ${v2Run.workDir}（那就是"多出来一个沉淀任务"）`,
    )
    const hutsAfter = (await readdir(workRoot)).filter((n) => n.startsWith('skill-draft-'))
    assert.deepEqual(hutsAfter.sort(), hutsBefore.sort(), '返工不该多出任何小屋')

    // ② 上一版进快照，且逐字等于它当时的产出
    assert.equal(
      await readFile(join(taskDir, 'history', v1, 'skill', 'SKILL.md'), 'utf8'),
      v1Skill,
      '上一版的内容必须原样进快照（差异对比与回退都读它）',
    )
    assert.ok(
      (await readdir(join(taskDir, 'history', v1, 'skill'))).includes('references'),
      '支持文件也要一起快照（不然"上一版"只剩半份）',
    )

    // ③ 版本表：两版按顺序、当前那一版没有快照（它就是任务目录里的内容）
    const versions = JSON.parse(await readFile(join(taskDir, '.versions.json'), 'utf8')) as {
      versions: Array<{ runId: string; snapshot: string | null }>
    }
    assert.deepEqual(
      versions.versions.map((v) => [v.runId, v.snapshot]),
      [
        [v1, `history/${v1}`],
        [v2, null],
      ],
      '版本表要记着"上一版在快照里、当前版就在任务目录里"',
    )
  })

  test('★★ 差异基线「原 skill」= 这个任务开始时的那一份（新建场景 = 第一版快照）', async () => {
    // 使用者的定稿：「skill 差异对比也应该是**原 skill** 变化」。这条判据必须能**分得开**两条基线，
    // 否则"改成 original"这种改动测不出来：造三版，每版按意见在末尾补一行 ⇒
    //   上一版（v2）vs 现在 = 1 行；原 skill（v1）vs 现在 = 2 行。
    const sourceRunId = await runReviewed('审完的流程（量原 skill 基线）')
    const v1 = await draftAndWait({ runId: sourceRunId, target: { kind: 'new' } })
    fakeBackend.minimalEditOnRevise = true
    let v3 = ''
    try {
      let prev = v1
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draftRunId: prev, feedback: `第 ${i + 2} 次反馈` }),
        })
        assert.equal(res.status, 202, await res.clone().text())
        prev = ((await res.json()) as { draftRunId: string }).draftRunId
        await waitRunStatus(prev, ['completed', 'failed'])
      }
      v3 = prev
    } finally {
      fakeBackend.minimalEditOnRevise = false
    }
    assert.equal((await readDraftVersionsFor(v1)).length, 3, '这条链该有三版')

    const ask = async (against: string): Promise<{ against: string; baselineLabel: string; totals: { added: number; removed: number } }> =>
      (await (
        await fetch(`${daemon.url}/api/crystallize/diff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draftRunId: v3, against }),
        })
      ).json()) as never
    const original = await ask('original')
    assert.equal(original.against, 'original', '请求原 skill 基线时不该被悄悄换成别的')
    assert.match(original.baselineLabel, /第一版/, `新建场景的原 skill = 第一版（实际标签 ${original.baselineLabel}）`)
    assert.equal(original.totals.added, 2, '两版之间各补了一行 ⇒ 相对第一版该量到 2 行')
    const previous = await ask('previous')
    assert.equal(previous.totals.added, 1, '相对上一版只有 1 行——两条基线必须量得出差别，否则这条判据是空的')
  })

  test('★ 差异基线「原 skill」在更新场景 = 任务开始时库里那一份（`material/existing-skill/`）', async () => {
    const runId = await runReviewed('更新基线任务（原 skill）')
    const firstDraft = await draftAndWait({ runId, target: { kind: 'new' } })
    const created = await commit({
      draftRunId: firstDraft,
      target: { kind: 'new' },
      slug: 'original-baseline',
      files: {
        'SKILL.md':
          '---\nname: original-baseline\ndescription: 原 skill 基线用\n---\n\n# 原来的标题\n\n' +
          '## When to Use\n- 量原 skill 基线时\n\n## Procedure\n1. 原来的一步\n',

      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const skillId = (created.body['skill'] as { id: string }).id

    const runId2 = await runReviewed('基于它起草更新（原 skill）')
    const draft = await draftAndWait({ runId: runId2, target: { kind: 'update', skillId } })
    const res = (await (
      await fetch(`${daemon.url}/api/crystallize/diff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: draft, against: 'original' }),
      })
    ).json()) as { against: string; baselineLabel: string; totals: { removed: number } }
    assert.equal(res.against, 'original')
    assert.match(res.baselineLabel, /原 skill/, `标签要说清这是原 skill（实际 ${res.baselineLabel}）`)
    assert.ok(
      res.totals.removed > 0,
      '原 skill 的正文与草稿不同 ⇒ 该有删除行（量到 0 说明基线取空了，而"取空"会让界面显示"整份新增"）',
    )
  })

  test('★ 取不到「原 skill」时退回当前版本，并且**如实回报**实际用了哪条基线', async () => {
    // 首版（还没有历史版本）请求 original ⇒ 没有"原来那一份"可比。这时不能假装比过了：
    // 若 `against` 还回 'original'，结论条会写着"对比原 skill"、数字却来自另一条基线
    // ——第 8 批"结论与内容分叉"那类毛病。
    const runId = await runReviewed('审完的流程（量基线回退）')
    const draft = await draftAndWait({ runId, target: { kind: 'new' } })
    const res = (await (
      await fetch(`${daemon.url}/api/crystallize/diff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: draft, against: 'original' }),
      })
    ).json()) as { against: string; baselineLabel: string }
    assert.equal(res.against, 'current', '取不到就如实退回当前版本（不能假装是原 skill）')
  })

  test('★★ 沉淀列表：一个任务**一行**（行上带第 N 版），不再是一版一行', async () => {
    // 使用者的原话：「给意见后，点"重新起草"，逻辑不好。新增加了一个沉淀任务，而不是在原沉淀任务中执行。」
    // 列表原来是**一条 run 一行**（他自己机器上有一条 7 版的链 ⇒ 7 个条目、像 7 个任务）。
    // 这条用例量两件事：① 这条链在列表里只有**一行**；② 那一行说的是"第几版"+ 点进去落在最新那一版。
    const sourceRunId = await runReviewed('审完的流程（量列表聚合）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '列表聚合' },
    })
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: i === 0 ? v1 : await waitRevisedFrom(i === 0 ? v1 : v1), feedback: `第 ${i + 2} 次反馈` }),
      })
      assert.equal(res.status, 202, await res.clone().text())
      const created = (await res.json()) as { draftRunId: string }
      await waitRunStatus(created.draftRunId, ['completed', 'failed'])
    }
    const v3 = (await readDraftVersionsFor(v1)).at(-1)!
    assert.equal((await readDraftVersionsFor(v1)).length, 3, '这条链该有三版（首版 + 两次反馈）')

    const rows = (await (await fetch(`${daemon.url}/api/crystallize/drafts`)).json()) as {
      items: Array<{ runId: string; taskRunId: string; version: number; source: { label: string } | null }>
    }
    const mine = rows.items.filter((r) => r.taskRunId === v1)
    assert.equal(
      mine.length,
      1,
      `一个任务在列表里该只有一行（实际 ${mine.length} 行：${JSON.stringify(mine.map((r) => r.runId.slice(-6)))}）——多于一行就是"多出来几个沉淀任务"`,
    )
    assert.equal(mine[0]!.version, 3, '那一行要说清这是第几版')
    assert.equal(mine[0]!.runId, v3, '那一行点进去要落在**最新**那一版（否则点开看到的是旧内容）')
    assert.equal(mine[0]!.taskRunId, v1, '任务身份 = 第一版那条 run（磁盘上的目录以它命名）')
  })

  test('★★ 内容按"你问的那一版"给：问旧版拿到旧版（快照），问最新版拿到最新版', async () => {
    // 第 16 批把"一版一间小屋"改成"一个任务一个目录"之后，目录里躺着的是**最新**那一版；
    // 而界面可以停在旧版本上（深链指名）⇒ 一律读任务目录就会"标题写着第 1 版、内容是第 3 版"。
    // 这是第 16 批留下的不一致，**量出来**才发现（`?draftRunId=<v1>` 与 `<v3>` 返回一样）。
    const sourceRunId = await runReviewed('审完的流程（量版本内容）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '版本内容' },
    })
    const v1Skill = await readFile(join(workRoot, `skill-draft-${v1}`, 'skill', 'SKILL.md'), 'utf8')
    // ⚠️ 这一条必须让两版**内容真的不同**：假后端默认每次写同一份夹具 ⇒ 我第一版断言"两版内容
    //    不同"时当场红，而红的原因是夹具没差异、不是产品读错了地方。用它的"只改一行"开关造差异。
    fakeBackend.minimalEditOnRevise = true
    let v2 = ''
    try {
      const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: v1, feedback: '改一句' }),
      })
      assert.equal(res.status, 202, await res.clone().text())
      v2 = ((await res.json()) as { draftRunId: string }).draftRunId
      await waitRunStatus(v2, ['completed', 'failed'])
    } finally {
      fakeBackend.minimalEditOnRevise = false
    }

    const ask = async (id: string): Promise<Record<string, string>> =>
      ((await (await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${id}`)).json()) as {
        files: Record<string, string>
      }).files
    const snapshot = await readFile(
      join(workRoot, `skill-draft-${v1}`, 'history', v1, 'skill', 'SKILL.md'),
      'utf8',
    )
    assert.equal((await ask(v1))['SKILL.md'], v1Skill, '问旧版 ⇒ 必须是**旧版**的内容（来自快照）')
    assert.equal(
      snapshot,
      v1Skill,
      '快照里就是首版那一刻的产出（下面那条"两版不同"才有意义：比的是两版，不是同一份内容）',
    )
    const latest = await readFile(join(workRoot, `skill-draft-${v1}`, 'skill', 'SKILL.md'), 'utf8')
    assert.notEqual(latest, v1Skill, '假后端这次确实改了一行（否则这条用例测不出"按版本给内容"）')
    assert.equal((await ask(v2))['SKILL.md'], latest, '问最新版 ⇒ 任务目录里的当前内容')
  })

  test('★ 审核只对当前那一版成立：停在旧版点审核 ⇒ 明确拒绝（不审错东西）', async () => {
    // 审核者读的是任务目录（= 最新那一版）⇒ 允许"停在旧版上点审核"就会审到别的内容，
    // 而屏上显示的是旧版 ⇒ 结论与现场错配、还没有任何提示。与"内容按你问的那一版给"成对。
    const sourceRunId = await runReviewed('审完的流程（量审核版本守卫）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '审核守卫' },
    })
    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1, feedback: '改一句' }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const v2 = ((await res.json()) as { draftRunId: string }).draftRunId
    await waitRunStatus(v2, ['completed', 'failed'])

    const stale = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1 }),
    })
    assert.equal(stale.status, 409, '旧版本不许审')
    assert.equal(
      ((await stale.json()) as { code: string }).code,
      'draft_not_current',
      '要给出可判别的理由码（不是笼统的 409）',
    )
  })

  test('★★ 老数据（一版一间小屋）自愈：问老的那一版，读到的必须是**它自己**的内容', async () => {
    // 为什么要这条：分批第 16 批改成"一个任务一个目录"之后，**使用者机器上已经存在**的链还是老形状
    // ——他自己那条 7 版的链（`9D67DN → … → B3R0ST`）每一版都住在自己的小屋里（真机上量的）。
    // 不自愈的话：问 v7 的产出，daemon 会把首版那间小屋当成"任务目录"⇒ 静默返回 **v1 的内容**。
    // 那种错最坏：目录在、文件在、接口 200，只是内容旧了七版。
    //
    // 这条用例按老形状**手工造**一条链（v1 走真接口，v2 直接写 run 记录 + 小屋目录），
    // 然后量四件：① 问 v2 得到 v2 的内容；② 迁移动过的东西都在（首版快照 + 版本表 + healedAt）；
    // ③ 迁移只做一次（再问一次，磁盘不变）。
    const sourceRunId = await runReviewed('审完的流程（老数据自愈）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '老链自愈' },
    })
    const taskDir = join(workRoot, `skill-draft-${v1}`)
    const v1Content = await readFile(join(taskDir, 'skill', 'SKILL.md'), 'utf8')

    // ── 造一条"老形状"的第 2 版：run 记录 + 自己那间小屋（分批第 16 批之前就是这么落的）──
    const v1Run = await daemon.store.getRun(v1 as RunId)
    assert.ok(v1Run, '首版 run 得在（下面照它复制一份）')
    const legacyId = ulid() as string
    const legacyDir = join(workRoot, `skill-draft-${legacyId}`)
    const legacyContent = '# 报告流程（老形状的第 2 版）\n\n## Procedure\n1. 老链写的\n'
    await mkdir(join(legacyDir, 'skill'), { recursive: true })
    await writeFile(join(legacyDir, 'skill', 'SKILL.md'), legacyContent, 'utf8')
    await mkdir(join(legacyDir, 'material'), { recursive: true })
    await writeFile(join(legacyDir, 'material', '00-README.md'), '# 老版的索引\n', 'utf8')
    await daemon.store.insertRun({
      ...v1Run!,
      id: legacyId as RunId,
      revisedFrom: v1 as RunId,
      queuedAt: v1Run!.queuedAt + 1000,
      workDir: legacyDir,
    })

    // ── ① 问老的那一版 ⇒ 得到它自己的内容（而不是首版那间小屋里的旧内容）──
    const res = (await (
      await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${legacyId}`)
    ).json()) as { files: Record<string, string>; status: string }
    assert.equal(
      res.files['SKILL.md'],
      legacyContent,
      '问到老的那一版时，读到的必须是**它自己**的内容（自愈没做的话这里会是首版的内容）',
    )

    // ── ② 迁移的四样都在 ──
    assert.equal(
      await readFile(join(taskDir, 'skill', 'SKILL.md'), 'utf8'),
      legacyContent,
      '任务目录里的"当前内容"要变成最新那一版',
    )
    assert.equal(
      await readFile(join(taskDir, 'history', v1, 'skill', 'SKILL.md'), 'utf8'),
      v1Content,
      '首版的内容要先被快照下来再覆盖（它的名字还在版本表里，内容不能丢）',
    )
    const versions = JSON.parse(await readFile(join(taskDir, '.versions.json'), 'utf8')) as {
      versions: Array<{ runId: string; snapshot: string | null }>
      healedAt: number | null
    }
    assert.deepEqual(
      versions.versions.map((v) => v.runId),
      [v1, legacyId],
      '版本表要按时间记着老链的两版',
    )
    assert.equal(versions.versions[1]!.snapshot, null, '最新那一版就是任务目录里的内容')
    assert.equal(typeof versions.healedAt, 'number', '迁移要留痕（改过使用者的目录，必须能查）')

    // ── ③ 只做一次：再问一次，磁盘不变（`healedAt` 与版本表都不动）──
    const versionsBefore = await readFile(join(taskDir, '.versions.json'), 'utf8')
    await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${legacyId}`)
    assert.equal(
      await readFile(join(taskDir, '.versions.json'), 'utf8'),
      versionsBefore,
      '自愈是幂等的：第二次问不许再动一次目录',
    )
  })

  test('★ 会话被拒（线程没了）⇒ 这一版仍然改得对：回退新线程 + 说清缺了上文', async () => {
    const sourceRunId = await runReviewed('审完的流程（会话丢了）')
    const v1 = await draftAndWait({
      runId: sourceRunId,
      target: { kind: 'new', purpose: '会话丢了' },
    })
    fakeBackend.rejectResume = true
    try {
      const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: v1, feedback: '改一句' }),
      })
      assert.equal(res.status, 202, await res.clone().text())
      const created = (await res.json()) as { draftRunId: string }
      // ① 这一版照样跑完、产出照样在（依据是磁盘上的上一版，不是会话）
      const status = await waitRunStatus(created.draftRunId, ['completed', 'failed'])
      assert.equal(status, 'completed', '会话丢了不该让这一版跑不完')
      const produced = await readFile(
        join(workRoot, `skill-draft-${v1}`, 'skill', 'SKILL.md'),
        'utf8',
      ).catch(() => null)
      assert.ok(produced !== null, '产出目录里仍然有 SKILL.md（依据在磁盘上，不在会话里）')
      // ② 平台要把"这次缺了上文"说出来（FR-CLI-06：被拒与"测不出来"必须分开报）
      const inbox = (await (await fetch(`${daemon.url}/api/inbox`)).json()) as {
        items: Array<{ type: string; title: string; runId: string | null }>
      }
      const hit = inbox.items.find(
        (i) => i.runId === created.draftRunId && i.type === 'run.resume_rejected',
      )
      assert.ok(hit, `没落"恢复被拒"的提醒（inbox 里 ${JSON.stringify(inbox.items.slice(0, 5))}）`)
      assert.match(hit.title, /恢复/)
    } finally {
      fakeBackend.rejectResume = false
    }
  })
})


/**
 * ══════════════════════════════════════════════════════════════════
 * ★ 分批第 34 批：「沉淀成 Agent」的起草前半段（目标 + 素材 + 契约）
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的口径（2026-10-25）：agent 指执行者或审核者；**只优化它的指令**、
 * 不碰它挂的 skill、**不新建 agent，只更新当前这一条**。
 *
 * 这一批只做到"起草能跑、素材摆对、契约指向 agent/instructions.md"；
 * 审核口径（第 35 批）与入库覆盖指令（第 36 批）各自单独一批。
 */
describe('§10.9 沉淀成 Agent：优化一条已有智能体的指令（分批第 34 批）', () => {
  /** 起一条**带审核者**的任务 run 并审过（过 task_gate），返回 runId。 */
  async function runWithReviewer(): Promise<string> {
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
        prompt: '把这次的活干完',
        limits: { maxTurns: null, timeoutMs: null },
        // ★ 这条 run 上要有审核者，`agentTargets.reviewer` 才不是 null
        reviewerAgentId: reviewerId,
      }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    for (let i = 0; i < 40; i += 1) {
      const r = (await (await fetch(`${daemon.url}/api/runs/${runId}`)).json()) as { status: string }
      if (['completed', 'failed', 'cancelled'].includes(r.status)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await reviewOnce(runId)
    return runId as string
  }

  test('★★★ 目标面板给出「执行者 / 审核者」两个候选（就是这条 run 上真实用过的那两条）', async () => {
    const runId = await runWithReviewer()
    const targets = (await (
      await fetch(`${daemon.url}/api/crystallize/targets?runId=${runId}`)
    ).json()) as {
      agentTargets: {
        executor: { id: string; name: string; role: string; instructionsChars: number }
        reviewer: { id: string; role: string } | null
      }
    }
    assert.equal(targets.agentTargets.executor.id, agentId, '执行者 = 这条 run 的执行者')
    assert.equal(targets.agentTargets.executor.role, 'executor')
    assert.ok(
      targets.agentTargets.executor.instructionsChars >= 0,
      '要带当前指令长度——界面据此提示"已经 5.8k/6k"的风险',
    )
    assert.equal(targets.agentTargets.reviewer?.id, reviewerId, '审核者 = 这条 run 的审核者')
  })

  test('★★★ 起草一条「优化审核者指令」的草稿：素材里有它现在的指令全文，契约写的是 agent/instructions.md', async () => {
    const runId = await runWithReviewer()
    const res = await fetch(`${daemon.url}/api/crystallize/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, target: { kind: 'agent', agentId: reviewerId } }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const { draftRunId } = (await res.json()) as { draftRunId: string }

    // ① 素材里必须是**它现在的指令全文**（没有这份，"在它上面改"无从谈起）
    const taskDir = join(workRoot, `skill-draft-${draftRunId}`)
    const existing = await readFile(join(taskDir, 'material', 'existing-agent.md'), 'utf8')
    const reviewerNow = (await (
      await fetch(`${daemon.url}/api/agents`)
    ).json()) as { agents: Array<{ id: string; name: string; instructions: string }> }
    const reviewer = reviewerNow.agents.find((a) => a.id === reviewerId)!
    assert.ok(existing.includes(reviewer.instructions.trim().slice(0, 60)), '指令正文要摆进素材')
    assert.match(existing, /角色：reviewer/, '要写清它是审核者（写法与执行者不同）')

    // ② 沉淀目标随 run 落库（恢复/返工/入库都按它走）
    for (let i = 0; i < 40; i += 1) {
      const run = (await (await fetch(`${daemon.url}/api/runs/${draftRunId}`)).json()) as {
        status: string
        crystallizeTarget?: { kind: string; agentId?: string }
      }
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        assert.deepEqual(run.crystallizeTarget, { kind: 'agent', agentId: reviewerId })
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // ③ 投递给起草者的契约：产出 agent/instructions.md、有 6000 字符上限、不许新建 agent
    const delivered = fakeBackend.prompts.at(-1) ?? ''
    assert.ok(delivered.includes('agent/instructions.md'), '产出路径必须是 agent/instructions.md')
    assert.ok(delivered.includes('6000'), '指令长度上限要写进契约')
    assert.ok(delivered.includes('不许新建智能体'), '使用者定过：不新建 agent，只更新当前这条')
    assert.ok(
      delivered.includes('existing-agent.md'),
      '要指名让起草者读"它现在的指令"',
    )
  })

  /**
   * 起一轮审核，返回审核 run 的 id，并**把投递给审核者的那段话取出来**。
   *
   * 为什么要取那段话：这一批改的正是"判据"，而判据只以**任务书**的形式存在——
   * 断言服务端某个变量等于什么，改坏了判据也测不出来。
   */
  async function auditAgentDraft(draftRunId: string): Promise<string> {
    // ⚠️ 必须记下"审核开始前"投递了几段：假后端这次的回答不合判决格式 ⇒ 执行器会**重试**
    //    一轮，而重试那一轮的 prompt 里只有"格式纠正"、没有任务书（`at(-1)` 会拿到它，
    //    于是"任务书里有没有判据"这条断言永远假——我第一次就是这么写的）。
    const before = fakeBackend.prompts.length
    const res = await fetch(`${daemon.url}/api/crystallize/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const { reviewRunId } = (await res.json()) as { reviewRunId: string }
    for (let i = 0; i < 60; i += 1) {
      const r = (await (await fetch(`${daemon.url}/api/runs/${reviewRunId}`)).json()) as {
        status: string
      }
      if (!['queued', 'deferred', 'waiting_local_directory', 'dispatched', 'running'].includes(r.status)) {
        return fakeBackend.prompts[before] ?? ''
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('审核 run 没在限时内收口')
  }

  test('★★★ 审核一条指令草稿：判据换成"指令五项"、6000 是硬闸门、无证据时只许收敛措辞', async () => {
    const runId = await runWithReviewer()
    // 假后端在起草时写的是 `skill/SKILL.md`；这里手动补一份 `agent/instructions.md`
    // （第 36 批会把它变成入库的唯一来源，本批先用来量"审核者读的是哪一种产出"）
    const draft = await draftAndWait({ runId, target: { kind: 'agent', agentId: reviewerId } })
    const taskDir = join(workRoot, `skill-draft-${draft}`)
    await mkdir(join(taskDir, 'agent'), { recursive: true })
    await writeFile(
      join(taskDir, 'agent', 'instructions.md'),
      '# 身份\n\n你是对账执行者。\n\n# 边界\n\n只读文件，不写。\n',
      'utf8',
    )
    /**
     * ★ 这一条测的是**无证据**那支：任务来源的素材里本来有判决（`verdict.md`），
     * 把判决与反馈都拿掉，才等于"这次跑得很顺、没有可改的证据"。
     * （任务门槛要求"审核过或有反馈"才允许沉淀 ⇒ 无证据只在**素材被清掉**这种情形出现，
     *  但契约必须为它准备好——使用者选的是"允许，但审核更保守"。）
     */
    await rm(join(taskDir, 'material', 'verdict.md'), { force: true })
    await rm(join(taskDir, 'material', 'feedback.md'), { force: true })

    const delivered = await auditAgentDraft(draft)
    assert.ok(delivered.includes('审一条**智能体的指令**'), '任务书要说清这次审的是指令')
    assert.ok(delivered.includes('6000'), '长度上限要进任务书（使用者定的硬闸门）')
    assert.ok(delivered.includes('material/instructions-check.md'), '要指名机械定检那一页')
    assert.ok(
      delivered.includes('只许**收敛措辞**') && delivered.includes('没有证据支撑的重构'),
      '无证据时的保守口径必须写进任务书：只许收敛措辞，重构口径要判不通过',
    )
    assert.ok(
      delivered.includes('不要重写这份指令'),
      '审核者只指出问题，不重写（重写是起草者的事）',
    )
    assert.ok(
      !delivered.includes('读 `skill/SKILL.md`'),
      '审指令时不该再让审核者去读 skill——第一版就是照抄了 skill 的任务书，两个对象会打架',
    )
  })

  test('★★ 超限的指令：机械定检明写"必须判不通过"，任务书里带上超了几个字', async () => {
    const runId = await runWithReviewer()
    const draft = await draftAndWait({ runId, target: { kind: 'agent', agentId: reviewerId } })
    const taskDir = join(workRoot, `skill-draft-${draft}`)
    await mkdir(join(taskDir, 'agent'), { recursive: true })
    const tooLong = `# 身份\n\n${'这一行是为了把指令撑到超限。\n'.repeat(400)}`
    assert.ok(tooLong.length > 6000, '夹具本身要真的超限')
    await writeFile(join(taskDir, 'agent', 'instructions.md'), tooLong, 'utf8')

    const delivered = await auditAgentDraft(draft)
    const check = await readFile(join(taskDir, 'material', 'instructions-check.md'), 'utf8')
    assert.match(check, /\*\*是，超 \d+ 字符\*\*/, '定检要量出超了多少')
    assert.ok(delivered.includes('必须判不通过'), '超限是硬闸门，任务书要这么说')
    assert.ok(delivered.includes(String(tooLong.length)), '要把量到的字符数交给审核者')
  })

  test('★★ 指向这次没参与的智能体 ⇒ 400（素材与它无关，改出来的指令只会按别人的错误改自己的规矩）', async () => {
    const runId = await runWithReviewer()
    const all = (await (await fetch(`${daemon.url}/api/agents`)).json()) as {
      agents: Array<{ id: string; role: string }>
    }
    const drafter = all.agents.find((a) => a.role === 'drafter')!
    const res = await fetch(`${daemon.url}/api/crystallize/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, target: { kind: 'agent', agentId: drafter.id } }),
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, 'agent_not_in_run')
  })
})
