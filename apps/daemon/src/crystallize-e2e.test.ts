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
import { ulid, type Issue, type RunId } from '@agentdeck/protocol'
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
  // ★ 分批第 137 批：`draftReviewVerdict`（起草审核的假判决）随审核一起删掉。

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

  /**
   * ★ 分批第 211 批（前身是分批第 172 批的 `draftAskQuestions`）：让起草者**只说话、不交
   * 产出**（`skill/` 一个字不写，回话就是它要说的话）。
   *
   * 真机上的形状就是"它说了句'我想先确认两件事…'、`skill/` 是空的"——假后端要能复现这一轮，
   * 否则"这一轮没交 skill"这条分支永远测不到。⚠️ 不再需要任何协议文件：从前这里要写
   * `material/QUESTIONS.md`，现在"没交"这件事靠 `skill/SKILL.md` 不在就够了。
   */
  draftSayOnly: string | null = null

  /** 每一轮开工时工作目录里**真的落了哪些技能文件**（钉"选中即注入"，看磁盘不看请求）。 */
  readonly injectedSkills: Array<Record<string, string>> = []

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
    // ★ 分批第 137 批：沉淀线的评审整条删除之后，草稿小屋里**只有起草 run** 会跑——
    //   "这是审核 run 吗"的判据（原来钉在审核者身份的第一句上）连同审核一起删除。
    //   历史教训留在文档里（§12.46）：那条判据曾经漏认审核 run、把 `skill/` 重写回夹具。
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
    // ★ 注入是否生效，看**磁盘**：技能是被 executor 落进工作目录的（claude 是 `.claude/skills/`），
    //   `ExecOptions` 上没有"技能"这个字段——只量请求侧的话，"写了但没落盘"测不出来。
    this.injectedSkills.push(await readDirRecursive(join(opts.workDir, '.claude', 'skills')))
    if (opts.workDir.includes('skill-draft-') && this.draftSayOnly !== null) {
      // ★ 分批第 211 批：这一轮只说话——`skill/` 一个字不写（"没交"就是没交）
    } else if (opts.workDir.includes('skill-draft-')) {
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
    // ★ 分批第 137 批：草稿小屋里的 run 永远是起草 run（审核已被删）⇒ 不再有"按审核者身份
    //   产出判决"的分支。`draftReviewVerdict` 这个夹具开关也随之删除。
    const text = this.draftSayOnly ?? '报告：任务已完成。'
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
/** 假后端的引用（测试要换起草产出：写目录 / 只说话不写文件）。 */
let fakeBackend: FakeBackend
let agentId: string
let reviewerId: string
let issueId: string
/**
 * ★ 分批第 176 批（使用者定："没装 distilly 之前不能沉淀"）：起草**必须**注入「沉淀用技能」。
 * 夹具在 `before()` 里造一条，助手 `draftPost` 自动带上它——与真机上"先在沉淀设置里安装"同一件事。
 */
let draftSkillId = ''

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

  const createdSkill = await fetch(`${daemon.url}/api/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // ⚠️ `POST /api/skills` 收的是**一批 payload**（`{skills: [...]}`），不是单个技能
    body: JSON.stringify({
      skills: [
        {
          // ★ 分批第 207 批：起草 run 的技能集合来自**起草者的挂载**（`Agent.skillIds`），
          //   而平台按 slug 自动挂 `distilly` ⇒ 夹具技能必须叫这个名字，否则门禁不通过。
          slug: 'distilly',
          name: '起草夹具技能（distilly）',
          source: 'mine',
          sourceRef: 'mine:distilly',
          body:
            '---\nname: distilly\ndescription: 起草用的夹具技能\n---\n\n# 怎么起草\n\n## Procedure\n\n1. 先读索引。\n',
          files: {},
          verdictSchemaVersion: 1,
        },
      ],
    }),
  })
  // `POST /api/skills` 回的是 `{installed, skipped}`（不是 `{skills}`）
  const createdSkillBody = (await createdSkill.json()) as { installed?: Array<{ id: string }> }
  draftSkillId = createdSkillBody.installed?.[0]?.id ?? ''
  assert.notEqual(
    draftSkillId,
    '',
    `起草门禁要求技能 ⇒ 夹具技能必须造出来（回执：${JSON.stringify(createdSkillBody).slice(0, 200)}）`,
  )
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

async function draftAndWait(payload: Record<string, unknown>): Promise<string> {
  const res = await draftPost(payload)
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
 * ★ 分批第 176 批：**发起起草**（唯一入口）。
 *
 * 为什么收成一个助手：起草现在必须带 `skillIds`（门禁），而"每条用例自己去拼一遍"
 * 正是刚才那 19 处红灯的成因。要断言"不带技能会被拒"的用例，显式传 `skillIds: []`
 * 或用 `rawDraftPost`。
 */
async function draftPost(payload: Record<string, unknown>): Promise<Response> {
  // ★ 分批第 207 批：**不再拼 `skillIds`**——起草 run 注入的技能来自起草者这条智能体的挂载
  //   （daemon 按 slug `distilly` 自动对齐）。夹具只要保证库里有一条 `distilly` 即可。
  return fetch(`${daemon.url}/api/crystallize/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 原样的起草请求（给"不带技能应当被拒"这类用例用）。 */
async function rawDraftPost(payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${daemon.url}/api/crystallize/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
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
      // ⚠️ 读到**半写的文件**是可能的（写方第 204 批起已改成原子替换，但这条等待仍然不该
      //    因为一次坏读就整条红——它本来就是个轮询）。坏读 ⇒ 这一轮跳过，下一轮再来。
      let parsed: { versions: Array<{ runId: string }> }
      try {
        parsed = JSON.parse(raw) as { versions: Array<{ runId: string }> }
      } catch {
        continue
      }
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
    const res = await draftPost({
        runId,
        target: { kind: 'new', purpose: '沉淀这段报告流程' },
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

  /**
   * ★ 分批第 211 批：这里原来钉"写了 `REFUSED.md` ⇒ `mode: 'refused'`"。
   *   使用者定的口径是「人之间在对话框里看 AI 的回答就好了」——拒绝不再是平台需要认的
   *   一种**协议**，它只是"这一轮没交 skill"的一种说法。于是判据改成**事实**：
   *   没有 `skill/SKILL.md` ⇒ `mode: 'none'`（哪怕它顺手写了点别的文件）。
   */
  /**
   * ★ 分批第 217 批（使用者定："可以是 skill 目录，也可以是 skill 下的子目录，动态侦测"）：
   * 起草者可能调它自己的写入器写进 `skill/<dir>/`（distilly 的 writer 就是这种落点）。
   * 这一条钉**整条链**：跑完自动搬、接口给 files、磁盘上是根上的 SKILL.md、并且能入库。
   */
  test('★★ 产出落在 skill/<dir>/ 里也认：跑完搬上来、接口是 files、能入库', async () => {
    const runId = await runReviewed('子目录落点的流程')
    const previous = fakeBackend.draftFiles
    // 模拟"它调了写入器"：把文件写在子目录里，根上没有 SKILL.md
    fakeBackend.draftFiles = {
      'colleague-flow/SKILL.md':
        '---\nname: colleague-flow\ndescription: 子目录落点也能收\n---\n\n# 子目录\n\n## When to Use\n- x\n\n## Procedure\n1. y\n',
      'colleague-flow/work.md': '# Work\n',
    }
    let draftRunId = ''
    try {
      draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
    } finally {
      fakeBackend.draftFiles = previous
    }
    // ① 接口：files（不是 none），路径已经归一到根
    const art = (await getJsonFile<{ mode: string; files: Record<string, string> }>(
      `/api/crystallize/artifacts?draftRunId=${draftRunId}`,
    ))
    assert.equal(art.mode, 'files', '子目录里的 SKILL.md 也要认')
    assert.ok('SKILL.md' in art.files, '归一到根')
    assert.ok(!('colleague-flow/SKILL.md' in art.files), '不再带子目录前缀')
    // ② 磁盘：真的搬上来了（搬完磁盘与逻辑一致，人改稿/差异/快照才看得对）
    const skillDir = join(workRoot, `skill-draft-${draftRunId}`, 'skill')
    assert.ok(await readFile(join(skillDir, 'SKILL.md'), 'utf8').catch(() => null), '根上有 SKILL.md')
    assert.equal(
      await readFile(join(skillDir, 'colleague-flow', 'SKILL.md'), 'utf8').catch(() => null),
      null,
      '原子目录搬完就删掉（否则磁盘上是两份）',
    )
    // ③ 入库：照常走
    const done = await commit({
      draftRunId,
      target: { kind: 'new' },
      slug: 'colleague-flow',
      files: { 'SKILL.md': art.files['SKILL.md']!, 'work.md': art.files['work.md'] ?? '' },
    })
    assert.equal(done.status, 201, JSON.stringify(done.body))
  })

  test('★ 没交 SKILL.md ⇒ artifacts 是 none；它写过的东西仍然带着', async () => {
    const runId = await runReviewed('不可沉淀的任务')
    const previous = fakeBackend.draftFiles
    // 它只写了说明、没写 SKILL.md（真机上就是"它说了句这段不值得沉淀"）
    fakeBackend.draftFiles = { 'REFUSED.md': '全是环境问题，没有可复用做法。' }
    try {
      const draftRunId = await draftAndWait({ runId, target: { kind: 'new' } })
      const res = (await (
        await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${draftRunId}`)
      ).json()) as { mode: string; files: Record<string, string> }
      assert.equal(res.mode, 'none')
      assert.ok('REFUSED.md' in res.files, '写过的文件仍然看得到（右栏要能显示它写了什么）')
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

describe('四轮：没写出目录的草稿更新时不删支持文件', () => {
  test('★ 只说话没交 skill（原"文本兜底"）+ 更新 ⇒ 现有支持文件被保留（不是"整目录替换"）', async () => {
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
    // ★ 分批第 211 批：`text` 兜底删了——没写 `skill/SKILL.md` 就是"这一轮没交东西"（`none`），
    //   不再把它的回话冒充成一份 SKILL.md。下面要钉的事（入库时别把支持文件整目录替换掉）
    //   与草的产出形态无关：`commit` 的内容一直由界面显式给。
    assert.equal(art.mode, 'none', '没写出目录 ⇒ 这一轮没交 skill')

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
describe('§10.11 追加材料：daemon 写接口 + 校验（分批第 130 批）', () => {
  /** 起一条可审阅的草稿（走"审过的源 run"这条正常路）。 */
  async function newDraft(purpose: string): Promise<string> {
    return draftAndWait({
      runId: await runReviewed(`审完的流程（${purpose}）`),
      target: { kind: 'new', purpose },
    })
  }

  const append = async (
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${daemon.url}/api/crystallize/material`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const materialOf = async (
    draftRunId: string,
  ): Promise<Array<{ relPath: string; text: string }>> =>
    (await getJsonFile<{ items: Array<{ relPath: string; text: string }> }>(
      `/api/crystallize/material?draftRunId=${draftRunId}`,
    )).items

  test('★★ 追加一段文本 ⇒ 落进 appended/ + 登记进 00-README + 下一版草稿读得到', async () => {
    const draftRunId = await newDraft('追加材料')
    const text = '# 上周的复盘\n\n- 先看日志再动手\n- 结论必须带证据\n'
    const r = await append({ draftRunId, text, name: '复盘' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.relPath, 'appended/复盘.md')
    assert.equal(r.body.bytes, Buffer.byteLength(text, 'utf8'))

    const items = await materialOf(draftRunId)
    const piece = items.find((i) => i.relPath === 'appended/复盘.md')
    assert.ok(piece, 'GET material 里要能看到这份追加的材料')
    assert.ok(piece!.text.includes('先看日志再动手'), '追加的正文原样在文件里')

    // ★ 落点 ②：索引页登记（起草者的入口）。没有这一条，这份材料就只是一份没人读的文件。
    const index = items.find((i) => i.relPath === '00-README.md')
    assert.ok(index, '索引页要在')
    assert.match(index!.text, /appended\/复盘\.md/)
    assert.match(index!.text, /使用者后来追加的材料/)

    // ★ 落点 ③：下一版草稿仍然带着它（素材是任务级的，返工在原地改）
    const revised = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, feedback: '把第一步写清从哪个目录跑' }),
    })
    assert.equal(revised.status, 202, await revised.clone().text())
    const v2 = await waitRevisedFrom(draftRunId)
    const itemsV2 = await materialOf(v2)
    assert.ok(
      itemsV2.some((i) => i.relPath === 'appended/复盘.md'),
      '下一版草稿的素材里必须仍然有追加的那份（否则"追加"只对旧版有效）',
    )
  })

  test('★★ 同名不覆盖、名字里的路径被剥掉（API 公开，不能靠"界面不会这么传"）', async () => {
    const draftRunId = await newDraft('追加材料去重')
    const first = await append({ draftRunId, text: '第一份', name: '同名' })
    const second = await append({ draftRunId, text: '第二份', name: '同名' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(first.body.relPath, 'appended/同名.md')
    assert.notEqual(second.body.relPath, first.body.relPath, '同名不许覆盖（覆盖会静默丢一份材料）')

    const evil = await append({ draftRunId, text: '穿越', name: '../../../evil.md' })
    assert.equal(evil.status, 200, JSON.stringify(evil.body))
    assert.equal(evil.body.relPath, 'appended/evil.md', '路径被剥到只剩文件名')
    const materialDir = join(workRoot, `skill-draft-${draftRunId}`, 'material')
    assert.equal(
      await readFile(join(materialDir, 'evil.md'), 'utf8').catch(() => null),
      null,
      '路径穿越不许写到 material/ 根上',
    )
  })

  test('★★ 校验：空文本 / 超限 / 非草稿 / 不存在 / 没跑完 / 已入库 各自如实拒绝', async () => {
    const draftRunId = await newDraft('追加材料校验')

    const empty = await append({ draftRunId, text: '   \n' })
    assert.equal(empty.status, 400, JSON.stringify(empty.body))
    assert.equal(empty.body.code, 'material_empty')

    const big = await append({ draftRunId, text: 'x'.repeat(100 * 1024 + 1) })
    assert.equal(big.status, 400, JSON.stringify(big.body))
    assert.equal(big.body.code, 'material_too_large')

    const missing = await append({ draftRunId: ulid(), text: 'hi' })
    assert.equal(missing.status, 404, JSON.stringify(missing.body))
    assert.equal(missing.body.code, 'draft_run_not_found')

    const sourceRunId = await runOnce('不是草稿的 run（追加材料）')
    const notDraft = await append({ draftRunId: sourceRunId, text: 'hi' })
    assert.equal(notDraft.status, 400, JSON.stringify(notDraft.body))
    assert.equal(notDraft.body.code, 'not_a_draft')

    // ★ 起草没跑完 ⇒ 409：起草者开工时读的素材已经定了，跑着的时候追加只会让
    //   "它读到的"和"磁盘上的"不是一份。用 `draftGate` 把它卡在跑完之前（不是抢时序）。
    let release!: () => void
    fakeBackend.draftGate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const res = await draftPost({
          runId: await runReviewed('审过的流程（起草中追加材料）'),
          target: { kind: 'new', purpose: '起草中追加材料' },
        })
      const draftText = await res.text()
      assert.equal(res.status, 202, draftText)
      const runningDraftId = (JSON.parse(draftText) as { draftRunId: string }).draftRunId
      const tooEarly = await append({ draftRunId: runningDraftId, text: 'hi' })
      assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body))
      assert.equal(tooEarly.body.code, 'draft_not_completed')
    } finally {
      fakeBackend.draftGate = null
      release()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // 已入库 ⇒ 409：那一版已经落进技能库，材料再变只会在以后的「重新沉淀」里造成误会
    const doneDraft = await daemon.store.getRun(draftRunId as RunId)
    assert.ok(doneDraft, '草稿得在')
    await daemon.store.insertRun({ ...doneDraft!, crystallized: true })
    const afterCommit = await append({ draftRunId, text: '入库之后还想补' })
    assert.equal(afterCommit.status, 409, JSON.stringify(afterCommit.body))
    assert.equal(afterCommit.body.code, 'already_crystallized')
  })
})

/**
 * §10.13 删掉一条材料（分批第 147 批，§12.14「删掉错的」）。
 *
 * 为什么"删"必须有写接口、而且必须一起改索引页：素材是起草者唯一的依据，索引页是它读的
 * **第一个**文件（"先读这一页，再决定读哪些"）。只把文件删掉、索引还指着它 ⇒ 起草者去读、
 * 读不到、然后以为素材坏了——这种半截功能比"不能删"更糟。
 *
 * 判据为什么落在"索引里没有它"而不只是"API 返回 200"：返回 200 只说明 unlink 成功，
 * 说明不了**起草者读到的依据**已经变成删后的样子。
 */
describe('§10.13 删除材料：只有使用者给的（appended/）能删，索引页跟着改（分批第 147 批）', () => {
  const draftOf = async (purpose: string): Promise<string> =>
    draftAndWait({
      runId: await runReviewed(`审完的流程（${purpose}）`),
      target: { kind: 'new', purpose },
    })

  const append = async (draftRunId: string, text: string, name: string): Promise<string> => {
    const res = await fetch(`${daemon.url}/api/crystallize/material`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, text, name }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    return ((await res.json()) as { relPath: string }).relPath
  }

  const remove = async (
    draftRunId: string,
    relPath: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(
      `${daemon.url}/api/crystallize/material?draftRunId=${encodeURIComponent(draftRunId)}` +
        `&relPath=${encodeURIComponent(relPath)}`,
      { method: 'DELETE' },
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const materialOf = async (
    draftRunId: string,
  ): Promise<Array<{ relPath: string; text: string }>> =>
    (await getJsonFile<{ items: Array<{ relPath: string; text: string }> }>(
      `/api/crystallize/material?draftRunId=${draftRunId}`,
    )).items

  test('★★★ 删掉一份追加的材料 ⇒ 文件没了、索引页不再提它、下一版草稿也读不到', async () => {
    const draftRunId = await draftOf('删除材料')
    const keep = await append(draftRunId, '这一份要留着：先看日志再动手', '留着')
    const drop = await append(draftRunId, '这一份是给错的，删掉', '删掉')

    const before = await materialOf(draftRunId)
    assert.ok(before.some((i) => i.relPath === drop), '前提：这份材料在')
    const indexBefore = before.find((i) => i.relPath === '00-README.md')!.text
    assert.match(indexBefore, /删掉\.md/, '前提：追加时登记进了索引页')

    const r = await remove(draftRunId, drop)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.removed ?? r.body.relPath, drop)
    assert.equal(r.body.remaining, 1, '还剩一份（同一份材料删了两次也不行）')

    const after = await materialOf(draftRunId)
    assert.equal(after.some((i) => i.relPath === drop), false, '文件要从清单里消失')
    assert.ok(after.some((i) => i.relPath === keep), '别的那份不许连带删掉')
    const indexAfter = after.find((i) => i.relPath === '00-README.md')!.text
    assert.equal(
      indexAfter.includes('删掉.md'),
      false,
      '索引页是起草者读的第一个文件：还指着已删的文件，等于让它去读一份不存在的素材',
    )
    assert.match(indexAfter, /留着\.md/, '保留下来的那份仍要在索引里')

    // 下一版草稿读的是同一个任务目录：删掉的那份不该再出现
    const revised = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, feedback: '顺手再改一版' }),
    })
    assert.equal(revised.status, 202, await revised.clone().text())
    const itemsV2 = await materialOf(await waitRevisedFrom(draftRunId))
    assert.equal(itemsV2.some((i) => i.relPath === drop), false, '下一版不许再读到已删的材料')
    assert.ok(itemsV2.some((i) => i.relPath === keep))
  })

  test('★★ 空白起的材料也能删：索引里那一行与"规模 N 份"跟着改', async () => {
    const draftRunId = await draftAndWait({
      startFrom: 'blank',
      target: { kind: 'new', purpose: '空白起删材料' },
      materials: [
        { name: '笔记甲', text: '# 甲\n' },
        { name: '笔记乙', text: '# 乙\n' },
      ],
    })
    const indexBefore = (await materialOf(draftRunId)).find((i) => i.relPath === '00-README.md')!.text
    assert.match(indexBefore, /使用者给的材料 2 份/, '前提：索引写着两份')
    assert.match(indexBefore, /appended\/笔记甲\.md/)

    const r = await remove(draftRunId, 'appended/笔记甲.md')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.remaining, 1)

    const items = await materialOf(draftRunId)
    assert.equal(items.some((i) => i.relPath === 'appended/笔记甲.md'), false)
    const indexAfter = items.find((i) => i.relPath === '00-README.md')!.text
    assert.equal(
      indexAfter.includes('笔记甲'),
      false,
      '空白起的索引把材料列成一行：那一行也要去掉（否则起草者去读一份不存在的文件）',
    )
    assert.match(indexAfter, /使用者给的材料 1 份/, '"规模 N 份"数的是还有几份，不同步就是撒谎')
  })

  test('★★★ 上传的文件落在 **`uploads/`**（与聊天页同一落点），素材索引里指得出它', async () => {
    const draftRunId = await draftOf('上传材料')
    const up = await fetch(`${daemon.url}/api/crystallize/drafts/${draftRunId}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ name: '上传的笔记.md', base64: Buffer.from('# 上传\n').toString('base64') }],
      }),
    })
    const upText = await up.clone().text()
    assert.equal(up.status, 200, upText)
    const uploaded = (JSON.parse(upText) as { files: Array<{ relPath: string }> }).files[0]!
    // ★ 使用者定（第 206 批）：与聊天页**完全一致**，落在 `<工作目录>/uploads/`
    assert.equal(uploaded.relPath, 'uploads/上传的笔记.md')

    // 它不在 `material/` 里（不是"素材"），但索引页要**指得出它**（相对 material/ 的路径）
    const items = await materialOf(draftRunId)
    assert.equal(items.some((i) => i.relPath === '上传的笔记.md'), false)
    const index = items.find((i) => i.relPath === '00-README.md')!.text
    assert.match(index, /\.\.\/uploads\/上传的笔记/, '索引要给相对 material/ 的路径，否则起草者按索引找不到')

    // 文件本身在（走工作目录树的 file 路由读回来）
    const got = await fetch(
      `${daemon.url}/api/crystallize/drafts/${draftRunId}/file?path=${encodeURIComponent('uploads/上传的笔记.md')}`,
    )
    assert.equal(got.status, 200, await got.clone().text())
    assert.equal(await got.text(), '# 上传\n')
  })

  test('★★ 校验：只许删 appended/（平台证据与 uploads/ 都不在 material 里）；没这份 404；非草稿 / 没跑完 / 已入库各自如实拒绝', async () => {
    const draftRunId = await draftOf('删除材料校验')

    // 平台从来源 run 切出来的证据一律不给删（删了"依据"就和来源对不上，且下次起草会切回来）
    for (const rel of ['00-README.md', 'meta.json', 'turns/001.md']) {
      const r = await remove(draftRunId, rel)
      assert.equal(r.status, 400, `${rel}：${JSON.stringify(r.body)}`)
      assert.equal(r.body.code, 'material_not_removable')
    }
    // 路径穿越不许落到 `appended/` 之外
    const evil = await remove(draftRunId, 'appended/../00-README.md')
    assert.equal(evil.status, 400, JSON.stringify(evil.body))
    assert.equal(evil.body.code, 'material_not_removable')

    const missing = await remove(draftRunId, 'appended/没有这份.md')
    assert.equal(missing.status, 404, JSON.stringify(missing.body))
    assert.equal(missing.body.code, 'material_not_found')

    const noPath = await remove(draftRunId, '')
    assert.equal(noPath.status, 400, JSON.stringify(noPath.body))
    assert.equal(noPath.body.code, 'rel_path_required')

    const noRun = await remove(ulid(), 'appended/x.md')
    assert.equal(noRun.status, 404, JSON.stringify(noRun.body))
    assert.equal(noRun.body.code, 'draft_run_not_found')

    const sourceRunId = await runOnce('不是草稿的 run（删除材料）')
    const notDraft = await remove(sourceRunId, 'appended/x.md')
    assert.equal(notDraft.status, 400, JSON.stringify(notDraft.body))
    assert.equal(notDraft.body.code, 'not_a_draft')

    // 起草跑着的时候删（403 那条纪律同追加）：它读的素材已经定了
    let release!: () => void
    fakeBackend.draftGate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const res = await draftPost({
          runId: await runReviewed('审过的流程（起草中删材料）'),
          target: { kind: 'new', purpose: '起草中删材料' },
        })
      const draftText = await res.text()
      assert.equal(res.status, 202, draftText)
      const runningDraftId = (JSON.parse(draftText) as { draftRunId: string }).draftRunId
      const tooEarly = await remove(runningDraftId, 'appended/x.md')
      assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body))
      assert.equal(tooEarly.body.code, 'draft_not_completed')
    } finally {
      fakeBackend.draftGate = null
      release()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // 入库之后：材料是"这份技能依据什么生成"的证据，不再改
    const doneDraft = await daemon.store.getRun(draftRunId as RunId)
    assert.ok(doneDraft, '草稿得在')
    await daemon.store.insertRun({ ...doneDraft!, crystallized: true })
    const afterCommit = await remove(draftRunId, 'appended/x.md')
    assert.equal(afterCommit.status, 409, JSON.stringify(afterCommit.body))
    assert.equal(afterCommit.body.code, 'already_crystallized')
  })
})

describe('§10.17 起草门禁：没装「沉淀用技能」不许沉淀（分批第 176 批；第 207 批改判据来源）', () => {
  /**
   * ★ 分批第 207 批：门禁的**来源变了**——不再是"请求里没带 `skillIds`"，而是
   *   "**起草者这条智能体没挂上可解析的「沉淀用技能」**"（技能集合现在来自 agent 的挂载）。
   *   判据的意图没变（没装 distilly 就不许沉淀），只是把那条技能**从库里删掉**再试，
   *   然后装回去。
   */
  test('★★★ 库里没有 distilly ⇒ 400 draft_skill_required；装回去就受理', async () => {
    const runId = await runReviewed('审过的流程（门禁）')
    // 前提：夹具装了一条 slug=distilly 的技能（见 `before`）
    const installed = (await (await fetch(`${daemon.url}/api/skills`)).json()) as {
      skills: Array<{ id: string; slug: string; source: string }>
    }
    const distilly = installed.skills.find((sk) => sk.slug === 'distilly')
    assert.ok(distilly, '前提：夹具里装着 distilly')
    // 只装了一份夹具技能 ⇒ 删掉它就是"没装 distilly"
    const removed = await fetch(`${daemon.url}/api/skills/${distilly.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200, await removed.clone().text())

    // 删掉之后：起草者的**挂载**也空了（平台侧摘挂，否则它会一直挂着一条不存在的技能）
    const drafterAfterDelete = (
      (await (await fetch(`${daemon.url}/api/agents`)).json()) as {
        agents: Array<{ role: string; skillIds: string[] }>
      }
    ).agents.find((a) => a.role === 'drafter')
    assert.deepEqual(drafterAfterDelete?.skillIds ?? ['?'], [], '起草者不该还挂着已删的技能')

    const blocked = await draftPost({ runId, target: { kind: 'new', purpose: '门禁' } })
    assert.equal(blocked.status, 400, await blocked.clone().text())
    assert.equal(((await blocked.json()) as { code?: string }).code, 'draft_skill_required')

    // 装回去（同 slug，会复用原 id）⇒ 起草者的挂载由 daemon 自动对齐
    const reinstalled = await fetch(`${daemon.url}/api/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          kind: 'payload',
          slug: 'distilly',
          body: '---\nname: distilly\ndescription: 起草用的夹具技能\n---\n\n# 怎么起草\n\n## Procedure\n\n1. 先读索引。\n',
          files: {},
        },
      }),
    })
    assert.ok([200, 201].includes(reinstalled.status), await reinstalled.clone().text())
    const ok = await draftPost({ runId, target: { kind: 'new', purpose: '门禁' } })
    assert.equal(ok.status, 202, await ok.clone().text())
    // 装回来之后：挂载**自动对齐**（这就是"挂在 Agent 上"的全部机制）
    const drafterAfterInstall = (
      (await (await fetch(`${daemon.url}/api/agents`)).json()) as {
        agents: Array<{ role: string; skillIds: string[] }>
      }
    ).agents.find((a) => a.role === 'drafter')
    assert.equal(drafterAfterInstall?.skillIds.length, 1, '装回来之后起草者要自动挂上它')
  })
})

/**
 * §10.18 起草 = 跟一个装着 distilly 的智能体说话（分批第 210 批）。
 *
 * 使用者读完第一句话后的两点：
 *   ① 「框架、身份、任务，直接使用"聊天"的模版，不应该是单独的」
 *   ② 「怎么还在用 writing-skill，不是应该用安装的 distilly 吗」
 *
 * 量到的根因**不是话术**：技能集合从第 207 批起就已经按起草者的挂载解析了，但
 * `executor.submit` 那一行仍然是 `skills: []` ⇒ 起草者手里根本没有 distilly，
 * 平台只好把内置的 `writing-skills` 内联进 prompt 当写法权威（2785 字里 1740 是它）。
 * 两条"写法权威"就是这么来的。这一节钉住修好之后的三件事：注入真的到了、改一版也到、
 * 三块就是聊天那一份。
 */
describe('§10.18 起草用的是装着 distilly 的那个智能体（分批第 210 批）', () => {
  /** 读一条 run 记录（`skillRefs` 是"这次用了哪几条技能"的权威，FR-REVIEW-06）。 */
  const runOf = async (
    runId: string,
  ): Promise<{ status?: string; skillRefs?: Array<{ slug: string }> }> =>
    await getJsonFile(`/api/runs/${runId}`)

  test('★★★ 起草 run 真的注入了起草者挂着的 distilly（`skillRefs` 里有它）', async () => {
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的流程（注入实证）'),
      target: { kind: 'new', purpose: '注入实证' },
    })
    const run = await runOf(draftRunId)
    const slugs = (run.skillRefs ?? []).map((s) => s.slug)
    assert.deepEqual(
      slugs,
      ['distilly'],
      '★ 这一轮拿到的技能就是起草者挂的那一条——在此之前这里是空的（`skills: []`），' +
        '于是它只能照 prompt 里内联的规范写',
    )
  })

  test('★★★ 「按意见改一版」也注入同一份（这条路以前是 `skills: []`）', async () => {
    const v1 = await draftAndWait({
      runId: await runReviewed('审过的流程（改版注入）'),
      target: { kind: 'new', purpose: '改版注入' },
    })
    const res = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1, feedback: '把 Procedure 补全' }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const v2 = ((await res.json()) as { draftRunId: string }).draftRunId
    await waitRunStatus(v2, ['completed', 'failed', 'cancelled'])
    const run = await runOf(v2)
    assert.deepEqual(
      (run.skillRefs ?? []).map((s) => s.slug),
      ['distilly'],
      '改一版同样是"按那份技能改"——否则它只能凭记忆重写',
    )
  })

  /**
   * ★ 分批第 212 批（使用者："第一句话显示「新建一份技能」，是否可以把它完整的『任务』输入
   *   写出来"）：中栏第一条要显示**这一轮真的投递出去的那段 ③**。
   *
   * 判据两半，缺一不可：
   *   ① 接口给的是 **run 日志里那段原文**（`===== ③ 任务 =====` 之后的内容），不是现拼的——
   *      现拼会让历史草稿显示成"按今天文案生成"的字；
   *   ② 那段里确实有平台硬事实（`skill/SKILL.md`、装着的那份技能），也就是"完整的任务输入"。
   */
  test('★★ 第一条要显示的任务原文 = run 日志里那段 ③（原样，不重新拼）', async () => {
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的流程（任务原文）'),
      target: { kind: 'new', purpose: '任务原文' },
    })
    const { task } = await getJsonFile<{ task: string | null }>(
      `/api/crystallize/request?draftRunId=${draftRunId}`,
    )
    assert.ok(task !== null && task.trim() !== '', '要读得到这一轮的任务原文')
    // 与日志里那一块**逐字一致**（接口不许重新组装）
    const messages = await getJsonFile<{
      messages: Array<{ type: string; content: string | null }>
    }>(`/api/runs/${draftRunId}/messages`)
    const note = messages.messages
      .map((m) => m.content ?? '')
      .find((c) => c.startsWith('===== ③ 任务 ====='))
    assert.ok(note !== undefined, '日志里要有 ③ 那一块')
    assert.equal(task, note!.slice('===== ③ 任务 ====='.length).trim(), '逐字取自日志')
    // "完整的任务输入"里要有平台硬事实
    assert.match(task!, /skill\/SKILL\.md/, '产出契约在里面')
    assert.match(task!, /distilly/, '点名装着的那份技能')
  })

  test('★★ 三块就是聊天那一份：① 没有任务头，③ 点名 distilly 且不再内联写作规范', async () => {
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的流程（三块）'),
      target: { kind: 'new', purpose: '三块' },
    })
    const { messages } = await getJsonFile<{
      messages: Array<{ type: string; content: string | null }>
    }>(`/api/runs/${draftRunId}/messages`)
    const notes = messages.map((m) => m.content ?? '')
    const lead = notes.find((c) => c.includes('这一轮是沉淀'))
    assert.ok(lead !== undefined, '沉淀那条引导语要在，且说的是"跟智能体说话"')
    const frameNote = notes.find((c) => c.startsWith('===== ① 框架 ====='))
    assert.ok(frameNote !== undefined, '① 框架要分开记一条')
    assert.match(frameNote, /聊天窗口/, '★ ① 就是聊天那一份（不是任务那份）')
    assert.doesNotMatch(
      frameNote,
      /^# 任务$|run：/m,
      '★ 任务那份的 run/对象头不许灌进沉淀（那会把它拧回"交报告"的姿势）',
    )
    const taskNote = notes.find((c) => c.startsWith('===== ③ 任务 ====='))
    assert.ok(taskNote !== undefined, '③ 任务要分开记一条')
    assert.match(taskNote, /`distilly`/, '★ ③ 点名这一轮真的注入的那份技能')
    assert.doesNotMatch(
      taskNote,
      /【写作规范】|When to Use/,
      '★ 平台不再自带第二份写法权威（那一段连同标题一起删了，分批第 210 批）',
    )
  })
})

/**
 * §10.16 起草者「只说了话、没交 skill」→ 人接着说（分批第 211 批；前身是分批第 172 批的
 * 「提问 → 回答」）。
 *
 * 使用者的原话（172 批）：「沉淀者就是一个智能体…如果这个智能体有疑问，就可以发问，类似
 * 聊天窗口那样」；211 批又把它推到底：「人之间在对话框里看 AI 的回答就好了，应该不需要
 * REFUSED 的特殊处理才对」。于是这一节钉三件事：**没交 skill** 是一个可判定的状态
 * （`mode: 'none'`、`skill/` 空）、**人能接着说**（起新 run + 接会话 + 那句话进素材）、
 * **交出东西之后就不该再走这条**（409，改它请用「这里不对：…」）。
 */
describe('§10.16 只说话没交 skill → 人接着说（分批第 211 批）', () => {
  /** 让这一轮"只说话"：`skill/` 空，回话就是给定的那段话。 */
  const sayAndWait = async (purpose: string, words: string): Promise<string> => {
    const previous = fakeBackend.draftSayOnly
    fakeBackend.draftSayOnly = words
    try {
      return await draftAndWait({
        runId: await runReviewed(`审完的流程（${purpose}）`),
        target: { kind: 'new', purpose },
      })
    } finally {
      fakeBackend.draftSayOnly = previous
    }
  }

  test('★★★ 它只说话时：`skill/` 是空的，artifacts 是 `none`（不是"交了坏东西"）', async () => {
    const words = '# 想先确认两件事\n\n1. 这条 skill 主要给哪类任务用？\n2. 要不要带 persona 那一轨？\n'
    const draftRunId = await sayAndWait('只说话轮', words)
    // ① 磁盘：`skill/` 一个字都没有
    const skillDir = join(workRoot, `skill-draft-${draftRunId}`, 'skill')
    assert.deepEqual(Object.keys(await readDirRecursive(skillDir)), [], '没交就是没交')
    // ② 接口：mode = none（界面据此显示"它说的话"+出口，不给入库）
    const res = (await getJsonFile<{ mode: string }>(
      `/api/crystallize/artifacts?draftRunId=${draftRunId}`,
    ))
    assert.equal(res.mode, 'none')
    // ③ 它说的话在**消息流**里（界面就显示这一条，不需要任何协议文件）
    const messages = await getJsonFile<{ messages: Array<{ type: string; content: string | null }> }>(
      `/api/runs/${draftRunId}/messages`,
    )
    assert.ok(
      messages.messages.some((m) => (m.content ?? '').includes('哪类任务用')),
      '它说的话必须能读到（那才是"回答它"的依据）',
    )
  })

  test('★★★ 接着说：起新 run + 接上会话；那句话进素材；交出东西之后再接着说就是 409', async () => {
    const draftRunId = await sayAndWait('接着说轮', '我想先确认一下口径。')
    const before = fakeBackend.resumeRequests.length
    const res = await fetch(`${daemon.url}/api/crystallize/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, text: '给小型的发布任务用；不要 persona 那一轨。' }),
    })
    assert.equal(res.status, 202, await res.clone().text())
    const newRunId = ((await res.json()) as { draftRunId: string }).draftRunId
    assert.notEqual(newRunId, draftRunId, '接着说也是"起一条新 run"（run 是终态机）')

    // ① 素材：人这句话进了 `material/appended/`（与「追加材料」同一个落点），并登记进索引
    const materialDir = join(workRoot, `skill-draft-${draftRunId}`, 'material')
    const appended = await readDirRecursive(join(materialDir, 'appended'))
    const joined = Object.values(appended).join('\n')
    assert.match(joined, /小型的发布任务用/, '人的话要原样进素材（起草者靠它往下写）')
    assert.match(
      await readFile(join(materialDir, '00-README.md'), 'utf8'),
      /appended\//,
      '追加的话要登记进素材索引（否则它读索引时看不见）',
    )

    // ② 会话：接上了刚才那条（它得记得自己说过什么）——先等新 run 真的起来
    for (let i = 0; i < 40; i += 1) {
      const r = (await (await fetch(`${daemon.url}/api/runs/${newRunId}`)).json()) as { status: string }
      if (r.status === 'completed' || r.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const resumed = fakeBackend.resumeRequests.slice(before).filter((x) => x !== null)
    assert.equal(resumed.length >= 1, true, '接着说那一轮要 resume 上一轮的会话')

    // ③ 这一轮交了东西（假后端恢复正常）⇒ 再"接着说"就该被拒：改它请用「这里不对：…」
    const again = await fetch(`${daemon.url}/api/crystallize/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: newRunId, text: '再补一句' }),
    })
    assert.equal(again.status, 409, await again.clone().text())
    assert.equal(((await again.json()) as { code?: string }).code, 'draft_has_output')
  })

  test('★★★ 选中的技能真的被注入到工作目录（"不要预置在仓库里、让用户自己装"那条的前半段）', async () => {
    const skill = (await (await fetch(`${daemon.url}/api/skills`)).json()) as {
      skills: Array<{ id: string; slug: string }>
    }
    // ★ 207 批：注入的是**起草者挂的那条**（slug = distilly），不是"列表里第一条"
    const skillId = skill.skills.find((sk) => sk.slug === 'distilly')?.id
    assert.ok(skillId, '夹具里要先有一条 distilly')
    const runId = await runReviewed('审过的流程（注入技能）')
    // ★ 207 批：注入的技能集合来自**起草者的挂载**（daemon 按 slug 自动对齐），请求里不再带。
    const res = await draftPost({ runId, target: { kind: 'new', purpose: '注入技能' } })
    assert.equal(res.status, 202, await res.clone().text())
    const draftRunId = ((await res.json()) as { draftRunId: string }).draftRunId
    for (let i = 0; i < 40; i += 1) {
      const r = (await (await fetch(`${daemon.url}/api/runs/${draftRunId}`)).json()) as { status: string }
      if (['completed', 'failed', 'cancelled'].includes(r.status)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    /**
     * 注入落点**不是工作目录**：D78 的隔离把技能写进受管 home
     * （`<dataDir>/claude-config/skills`），工作目录里没有 `.claude/skills/`。
     * 所以这里钉平台自己的记录：这条 run 的 `skillRefs`（FR-REVIEW-06）——它是"这次用了哪几条
     * 技能"的权威，日志与审核都按它算。
     */
    const recorded = await readFile(
      join(workRoot, `skill-draft-${draftRunId}`, 'material', 'injected-skills.json'),
      'utf8',
    ).catch(() => '')
    assert.match(
      recorded,
      new RegExp(JSON.stringify(skillId).slice(1, -1)),
      `选中的技能要被记下来（后续每轮读它）：${recorded}`,
    )
  })
})

// ★ 分批第 201 批：§10.15「从仓库拉材料：路由层的边界」整组删掉——功能下线
//   （使用者："直接删掉这个功能"）。真拉取那条链所在的 `crystallize-repo.test.ts` 同时删除。


/**
 * §10.12 「从空白/材料起」：**无源 run 的草稿**（分批第 133 批，U3d 第三半）。
 *
 * 不是每次沉淀都有一条跑过的 run 可以当素材——"把我知道的做法写成一个技能"本来就没跑过。
 * 这一节钉的是 daemon 侧那条新路：`startFrom: 'blank'` ⇒ 起草 run 的 `subject` **不带**
 * `sourceRunId`、素材只有使用者给的那几份（可以零份）、索引页如实写"没有轨迹可回查"。
 * 界面入口（目标屏的起点选项）是下一批的事——这一批先把"能造出来"钉住。
 */
describe('§10.12 从空白/材料起：无源 run 的草稿（分批第 133 批）', () => {
  const blankDraft = async (
    materials: Array<{ name?: string; text: string }>,
    purpose = '空白起夹具',
  ): Promise<string> =>
    draftAndWait({
      startFrom: 'blank',
      target: { kind: 'new', purpose },
      materials,
    })

  test('★★ 空白起 + 两份材料 ⇒ 没有来源 run、素材落在 appended/、索引如实说"空白起"', async () => {
    const draftRunId = await blankDraft([
      { name: '外部笔记', text: '# 笔记\n\n- 先看日志再动手\n' },
      { text: '# 另一份\n\n没有名字的材料也要能落盘。\n' },
    ])
    const run = (await (await fetch(`${daemon.url}/api/runs/${draftRunId}`)).json()) as {
      subject: { type: string; id: string; sourceRunId?: string }
      crystallizeTarget?: { kind: string }
    }
    assert.equal(run.subject.type, 'skill-draft')
    assert.equal(run.subject.sourceRunId, undefined, '空白起的草稿不许带来源 run')
    assert.equal(run.crystallizeTarget?.kind, 'new')

    const items = await getJsonFile<{ items: Array<{ relPath: string; text: string }> }>(
      `/api/crystallize/material?draftRunId=${draftRunId}`,
    )
    const appended = items.items.filter((i) => i.relPath.startsWith('appended/'))
    assert.equal(appended.length, 2, '两份材料都要落在 appended/ 下')
    assert.ok(appended.some((i) => i.text.includes('先看日志再动手')))
    const index = items.items.find((i) => i.relPath === '00-README.md')
    assert.ok(index, '索引页要在')
    assert.match(index!.text, /空白起/, '索引必须说清这次没有来源 run')
    assert.match(index!.text, /没有轨迹可回查/)

    // 列表里这一行要能认出"空白起"（界面据此给不同的来源文案）
    const list = await getJsonFile<{ items: Array<{ runId: string; startFromBlank: boolean }> }>(
      '/api/crystallize/drafts',
    )
    assert.equal(list.items.find((r) => r.runId === draftRunId)?.startFromBlank, true)
  })

  test('★★ 一份材料都不给也能起（"先按作用描述写一版"是正常用法）', async () => {
    const draftRunId = await blankDraft([], '什么都没有先写一版')
    const items = await getJsonFile<{ items: Array<{ relPath: string; text: string }> }>(
      `/api/crystallize/material?draftRunId=${draftRunId}`,
    )
    assert.equal(items.items.filter((i) => i.relPath.startsWith('appended/')).length, 0)
    const index = items.items.find((i) => i.relPath === '00-README.md')
    assert.match(index!.text, /这次没有材料/, '索引要如实说"既没有来源 run，也没给材料"')
  })

  test('★★★ 空白起 + 更新已有技能：把那条技能的整份原文摆进素材（existing-skill/），索引说清是空白起', async () => {
    // 先造一条技能（走正规入库那条路，确保它是"库里真有的"）
    const draftRunId = await blankDraft([{ name: '改动依据', text: '把启动流程写细一点' }], '空白起更新夹具')
    const commit = await fetch(`${daemon.url}/api/crystallize/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRunId,
        target: { kind: 'new' },
        slug: 'blank-update-fixture',
        files: {
          'SKILL.md':
            '---\nname: blank-update-fixture\ndescription: 空白起更新的夹具\n---\n\n## When to Use\n\n当需要夹具时。\n\n## Procedure\n\n1. 跑。\n',
        },
      }),
    })
    assert.equal(commit.status, 201, await commit.clone().text())
    const skillId = ((await commit.json()) as { skill: { id: string } }).skill.id

    // 空白起 + update：**没有来源 run**，但"上一版"是库里那条技能
    const updated = await draftAndWait({
      startFrom: 'blank',
      target: { kind: 'update', skillId },
      materials: [{ name: '改动依据', text: '把启动流程写细一点' }],
    })
    const items = await getJsonFile<{ items: Array<{ relPath: string; text: string }> }>(
      `/api/crystallize/material?draftRunId=${updated}`,
    )
    const existing = items.items.find((i) => i.relPath === 'existing-skill/SKILL.md')
    assert.ok(existing, '要更新的技能原文必须摆进素材（否则起草者只能重写一份）')
    assert.match(existing!.text, /当需要夹具时/, '摆的是**内容本身**，不是一句"去库里看"')
    const index = items.items.find((i) => i.relPath === '00-README.md')!
    assert.match(index.text, /更新现有 skill「blank-update-fixture」/, '索引要写清这次是改哪一份')
    assert.match(index.text, /空白起/, '同时又如实说"没有来源 run"')
  })

  test('★★ 边界：空白起不许同时带 runId、不能优化智能体指令、材料超限拒绝', async () => {
    const withRun = await draftPost({
        startFrom: 'blank',
        runId: await runOnce('不该被用上的 run'),
        target: { kind: 'new', purpose: 'x' },
      })
    assert.equal(withRun.status, 400, await withRun.clone().text())
    assert.equal(((await withRun.json()) as { code?: string }).code, 'blank_with_run')

    // ★ 分批第 165 批：空白起**不再**一律拒更新——"上一版"是技能库里那条技能，跟来源 run 无关。
    //   这里给一个不存在的 skillId，应当走到 404（而不是像以前那样被 `blank_requires_new` 挡在门口）。
    const updateMissing = await draftPost({ startFrom: 'blank', target: { kind: 'update', skillId: 'nope' } })
    assert.equal(updateMissing.status, 404, await updateMissing.clone().text())
    assert.equal(((await updateMissing.json()) as { code?: string }).code, 'skill_not_found')

    // ★ 分批第 191 批：「优化智能体指令」整条目标删了 ⇒ 两个入口（空白起 / 有来源）都回同一个拒因。
    //   这里钉"空白起"这一侧，有来源那一侧见下面的 `agent_target_removed` 用例。
    const agentTarget = await draftPost({ startFrom: 'blank', target: { kind: 'agent', agentId: agentId } })
    assert.equal(agentTarget.status, 400, await agentTarget.clone().text())
    assert.equal(((await agentTarget.json()) as { code?: string }).code, 'agent_target_removed')

    const tooBig = await draftPost({
        startFrom: 'blank',
        target: { kind: 'new', purpose: 'x' },
        materials: [{ text: 'x'.repeat(100 * 1024 + 1) }],
      })
    assert.equal(tooBig.status, 400, await tooBig.clone().text())
    assert.equal(((await tooBig.json()) as { code?: string }).code, 'material_too_large')
  })

  test('★★ 空白起的草稿能「按意见改一版」：不再 409「没记来源」，素材跟着新版', async () => {
    const v1 = await blankDraft([{ name: '材料', text: '这份材料要一直在。' }], '空白起再改一版')
    const revised = await fetch(`${daemon.url}/api/crystallize/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId: v1, feedback: '这里不对：把第一步写清' }),
    })
    const revisedText = await revised.text()
    assert.equal(revised.status, 202, revisedText)
    const v2 = await waitRevisedFrom(v1)
    const run2 = (await (await fetch(`${daemon.url}/api/runs/${v2}`)).json()) as {
      subject: { sourceRunId?: string }
      revisedFrom?: string
    }
    assert.equal(run2.revisedFrom, v1)
    assert.equal(run2.subject.sourceRunId, undefined, '新版同样没有来源 run')
    const items = await getJsonFile<{ items: Array<{ relPath: string; text: string }> }>(
      `/api/crystallize/material?draftRunId=${v2}`,
    )
    assert.ok(
      items.items.some((i) => i.relPath === 'appended/材料.md'),
      '改版之后素材（使用者一开始给的）必须还在',
    )
  })
})

/**
 * §10.6 人改草稿（2026-10-21 分批第 8 批；分批第 137 批改口径）。
 *
 * 使用者原话：「缺少一个可以改的地方」。编辑器一直都在（审阅屏每个文本文件都能改），
 * 缺的是**改完算不算数**：改动只活在浏览器内存里。
 * 这一块钉住那条路：**写回落盘 → 体检跟着重算**。
 * ★ 分批第 137 批（§12.42 第 ③ 步）：沉淀线的评审删掉之后，"结论过期 / 重新审核"这半
 *   整段随之删除——没有结论，也就没有"过期"。剩下的体检由 `artifacts` 现算。
 */
describe('§10.6 人改草稿：落盘到磁盘 + 体检跟着重算', () => {
  test('★★ 人改草稿 → 落盘到磁盘 + 体检跟着重算（不再有"结论过期"这回事）', async () => {
    const draftRunId = await draftAndWait({
      runId: await runReviewed('审过的流程（人要手改一版）'),
      target: { kind: 'new', purpose: '人改草稿流程' },
    })

    // 改之前：体检通过（夹具是合规的 SKILL.md）
    const before = (await (
      await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${draftRunId}`)
    ).json()) as { validation: { ok: boolean } }
    assert.equal(before.validation.ok, true, '夹具草稿应当体检通过')

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

    // ② 体检跟着重算（§12.42 第 ③ 步之后，界面的结论条只剩机械体检）
    //    ⚠️ 分批第 177 批（使用者定："不需要检查 when to use 等标签"）：**章节名不再是体检项**
    //    ⇒ 这一条从"缺 Procedure 就红"改成"**缺 frontmatter 的 name** 才红"（那是平台真需要的
    //    字段：名字来自它；而章节名是我们的口味，不是 skill 的通用形态）。
    const broken = `---\ndescription: 人手改过的描述\n---\n\n# 人手改过的正文\n`
    const saved2 = await fetch(`${daemon.url}/api/crystallize/save-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftRunId, files: { 'SKILL.md': broken } }),
    })
    assert.equal(saved2.status, 200, await saved2.clone().text())
    const after = (await (
      await fetch(`${daemon.url}/api/crystallize/artifacts?draftRunId=${draftRunId}`)
    ).json()) as { validation: { ok: boolean; problems: Array<{ message: string }> } }
    assert.equal(after.validation.ok, false, '缺 frontmatter 的 name ⇒ 体检不能再说通过')
    assert.ok(
      after.validation.problems.some((p) => p.message.includes('name')),
      '要给出具体问题（人能照着改）',
    )
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
      const res = await draftPost({
          runId: await runReviewed('审过的流程（起草中保存）'),
          target: { kind: 'new', purpose: '起草中保存' },
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
 * ★ 分批第 191 批：「沉淀成 Agent」**整条功能下线**（使用者："去掉起草智能体指令的功能，
 *   只需要起草新建或者更新现有 skill"）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这里原来是 §10.9 的七个用例（起草 / 素材 / 入库 / 快照 / 恢复 / 对比 / 返工）。那些路径
 * 连同服务端的两个分支（`POST /draft` 的 agent 目标、`POST /commit` 的覆盖指令）一起删掉了，
 * **留着它们等于钉一条已经不存在的行为**——所以整组删掉，只留一条"门口确实拒了"。
 *
 * 为什么还要留这一条：老界面（缓存里的旧 bundle）与旧深链还会发 `{kind:'agent'}`。
 * 静默成功才是危险的——那会写出一条谁都看不懂的 skill 草稿。拒因要能被认出来、
 * 文案要指路（要改指令去「智能体」页）。
 */
describe('§10.9 沉淀不再产出智能体指令（分批第 191 批改口径）', () => {
  test('★★ 有来源的 run 也拒（agent_target_removed），且文案指路智能体页', async () => {
    const runId = await runOnce('这条 run 只想沉淀技能')
    const res = await draftPost({ runId, target: { kind: 'agent', agentId: agentId } })
    assert.equal(res.status, 400, await res.clone().text())
    const body = (await res.json()) as { code?: string; error?: string }
    assert.equal(body.code, 'agent_target_removed')
    assert.match(body.error ?? '', /智能体/, '拒因必须说清"要改指令去哪做"')
    assert.doesNotMatch(body.error ?? '', /target_required/, '不能退化成一句"请求写错了"')
  })
})


