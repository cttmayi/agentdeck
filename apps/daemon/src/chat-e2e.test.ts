import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { ulid } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * 聊天那一轮**不套第一句话模版**（端到端）
 * ══════════════════════════════════════════════════════════════════
 *
 * 为什么要有这一份：模版是在**执行器**里套上去的（`executor.ts` 里那个
 * `renderFirstSentence`），所以"聊天不套模版"这件事在服务端那一侧的任何单元
 * 测试里都量不到——`chat.ts` 交给执行器的 `prompt` 本来就只有使用者那句话，
 * 套不套是下一站的事。只有把整条链跑起来、看假后端**真正收到的那段文本**，
 * 才证明得了。
 *
 * 这份里有一个**对照组**：同一条链上、同一台 daemon，任务那条路**照旧套模版**。
 * 少了它，一个"把模版整个关掉"的实现会让上面所有断言全绿——而那是在拆产品
 * 的主干，不是在做聊天。
 *
 * ⚠️ 判据是"**逐字相同**"，不是"包含"。`includes` 放得过"套了一层模版但那句话
 *    还在里面"，而套没套模版正是这条用例唯一要问的事。
 */

/** 只记录"这次被交代了什么"，其余按最小可用返回。 */
class RecordingBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 每次 run 投递出去的那段文本（= CLI 收到的全部内容）。 */
  seen: string[] = []
  /** 每次投递的系统提示（①②）——任务那条路有，聊天那条路是空串。 */
  seenSystem: string[] = []
  seenWorkDirs: Array<string | undefined> = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seen.push(opts.prompt)
    // 2026-09：任务那条路走 A 档 ⇒ ① 框架在系统提示里；聊天那条路逐字、没有系统提示
    this.seenSystem.push(opts.systemPrompt ?? '')
    this.seenWorkDirs.push(opts.workDir)
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '好。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '好。',
        durationMs: 2,
        sessionId: 'chat-session',
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

async function waitForTerminal(runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { body } = await json(`/api/runs/${runId}`)
    // `GET /api/runs/{id}` 直接返回那条 run（外面没有再包一层）
    const status = (body as { status?: string } | null)?.status
    if (status !== undefined && ['completed', 'failed', 'cancelled'].includes(status)) return
    if (Date.now() > deadline) throw new Error(`run ${runId} 一直没到终态`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

let dataDir: string
let daemon: DaemonHandle
let backend: RecordingBackend
let agentId: string

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

before(async () => {
  dataDir = await makeTempDir('chat-e2e-data')
  backend = new RecordingBackend()
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })
  const agents = await json('/api/agents')
  const list = (agents.body as { agents: Array<{ id: string; role: string }> }).agents
  agentId = list.find((a) => a.role === 'executor')!.id
  // ★ 给这个执行者写一段"指令"：任务那条路上它由模版的 {{instructions}} 送出去，
  //   而聊天那条路上没有模版——这条用例要把"它确实不在聊天里出现"也钉住。
  const patched = await json(`/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instructions: '你是一个严谨的协作者。先理解任务，再动手。' }),
  })
  assert.equal(patched.status, 200, '夹具：执行者的指令要写得进去')
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
})

describe('D49 端到端：聊天投递的就是那句话', () => {
  test('★★ 交给 CLI 的**逐字**就是使用者那句话：没有 # 任务、没有护栏、没有元信息', async () => {
    const text = '看下 build 为什么挂了？\n第二行原样保留'
    const created = await postJson('/api/conversations', { agentId, text })
    assert.equal(created.status, 201)
    const turn = (created.body as { turn: { runId: string } }).turn
    await waitForTerminal(turn.runId)

    const sent = backend.seen.at(-1)!
    assert.equal(sent, text, '★ 逐字相同——多一个字符都说明又被包了一层')

    // 逐条点名：这些都是模版的东西，任何一个出现都说明那条路又回来了
    for (const artifact of ['# 任务', '## 护栏', '## 要做的事', '第一句话', '请用简体中文回答']) {
      assert.ok(!sent.includes(artifact), `正文里不该出现 ${artifact}`)
    }
    // 智能体自己的「指令」也不在这条路上（它按任务场景写的，套进来正好把要去掉的语气带回来）
    /**
     * ⚠️ 这一条**被决定推翻了**（2026-09）：聊天里**也发** agent 的「指令」（②）。
     *
     * 原话是"①② 在聊天里也发"。在此之前聊天里技能注入照旧、指令却静默失效——
     * 同一个 agent 在两条路上"性格"不同，而使用者感觉不到为什么。
     * 现在 ② 在**系统提示**里（A 档），所以逐字投递的性质不变（见上面那条断言）：
     * `prompt` 里仍然只有使用者那句话。
     */
    // ⚠️ 注意：**逐字那一条断言仍然成立**（`sent` 就是使用者那句话，一个字不多）。
    //    ② 走的是**系统提示**那一半，所以它不在 `sent` 里、也不该在。
    assert.equal(
      backend.seenSystem.at(-1)?.includes('你是一个严谨的协作者'),
      true,
      '★ ② 走系统提示（在此之前聊天里它静默失效）',
    )
    // ⚠️ 判据用**任务那份框架独有的东西**：`# 任务` 标题、`## 护栏` 段、判决契约的
    //    围栏标记。别用"判决"这种词——聊天自己的框架里就有（"不要产出判决"），
    //    那是一条正确的否定句，不是任务模版串味。（第一版就是这么写错的。）
    assert.doesNotMatch(
      backend.seenSystem.at(-1) ?? '',
      /^# 任务$|^## 护栏$|ALPHA_VERDICT/m,
      '★ 聊天用的是**自己那份 ① 框架**——任务那份的标题、护栏与判决契约不该灌进聊天',
    )
  })

  test('★ 工作目录走的是 `workDir` 字段（CLI 的 cwd），**不写进正文**', async () => {
    const created = await postJson('/api/conversations', { agentId, text: '你好' })
    const turn = (created.body as { turn: { runId: string } }).turn
    await waitForTerminal(turn.runId)
    const dir = backend.seenWorkDirs.at(-1)
    assert.ok(dir !== undefined && dir.includes('chat-'), `目录要真的传下去，实际：${String(dir)}`)
    assert.ok(!backend.seen.at(-1)!.includes(dir!), '正文里不该写目录——它在 cwd 上')
  })

  test('★ 日志里如实说明这是对话（不是"第一句话"），字符数也不说谎', async () => {
    const text = '日志这一条'
    const created = await postJson('/api/conversations', { agentId, text })
    const turn = (created.body as { turn: { runId: string } }).turn
    await waitForTerminal(turn.runId)
    const { body } = await json(`/api/runs/${turn.runId}/messages`)
    const messages = (body as { messages: Array<{ type: string; content: string | null }> }).messages
    const lead = messages.find((m) => (m.content ?? '').includes('交给 CLI'))
    assert.ok(lead !== undefined, '那条引导语要在')
    assert.match(lead.content!, /这一轮是对话/)
    assert.ok(!lead.content!.includes('第一句话'), '对话不该被说成"第一句话"')
    // ⚠️ A 档下引导语后面是**三块各自带名**的日志（2026-09：①②③ 分开记、
    //    带 `===== N =====` 块名）——所以"逐字"要认 ③ 那一块，而不是紧邻的一条。
    const idx = messages.indexOf(lead)
    const frameNote = messages[idx + 1]!.content ?? ''
    assert.match(frameNote, /===== ① 框架 =====/, '第一条是 ① 框架（带块名）')
    assert.match(frameNote, /聊天窗口|派活|护栏/, '① 框架是聊天那份（不是任务那份）')
    const taskNote = messages
      .slice(idx + 1)
      .map((m) => m.content ?? '')
      .find((c) => c.startsWith('===== ③ 任务 ====='))
    assert.equal(taskNote, `===== ③ 任务 =====\n\n${text}`, '★ 使用者那句话仍然逐字（在 ③ 那一块）')
  })

  test('★★ 对话自己带的 skill（没人挂的那种）真的被注入——执行日志里那一行说了', async () => {
    // 「新对话」里选了没人挂的 skill ⇒ 记在对话上 ⇒ 这一轮的注入里必须真有它。
    // 判据用**执行日志那一行**（它就是为"看得出来注入了什么"而存在的），
    // 而不是照着请求对象自己念一遍。
    const made = await postJson('/api/skills', {
      skills: [
        { slug: 'chat-e2e-carried', name: '对话自带的夹具', body: '# 夹具\n', source: 'local' },
      ],
    })
    assert.equal(made.status, 201, `造夹具 skill 失败：${JSON.stringify(made.body)}`)
    const all = await json('/api/skills')
    const skillId = (all.body as { skills: Array<{ id: string; slug: string }> }).skills.find(
      (s) => s.slug === 'chat-e2e-carried',
    )!.id

    const created = await postJson('/api/conversations', {
      agentId,
      text: '带着 skill 说话',
      skillIds: [skillId],
    })
    assert.equal(created.status, 201, `建对话失败：${JSON.stringify(created.body)}`)
    const body = created.body as { conversation: { skillIds?: string[] }; turn: { runId: string } }
    assert.deepEqual(body.conversation.skillIds, [skillId], '对话要把这条 skill 记下来')

    await waitForTerminal(body.turn.runId)
    const { body: log } = await json(`/api/runs/${body.turn.runId}/messages`)
    const messages = (log as { messages: Array<{ type: string; content: string | null }> }).messages
    const line = messages.find((m) => (m.content ?? '').includes('skill'))
    assert.ok(line !== undefined, '日志里要有说明注入了哪些 skill 的那一行')
    assert.match(line.content!, /chat-e2e-carried/, `那一行要点名这条 skill，实际：${line.content}`)
  })

  test('★ 不存在的 skill id ⇒ 400（静默少给一条 skill 是最难查的一类）', async () => {
    const res = await postJson('/api/conversations', {
      agentId,
      text: '你好',
      skillIds: ['01NOTASKILL0000000000000000'],
    })
    assert.equal(res.status, 400)
    assert.equal((res.body as { code?: string }).code, 'skill_not_found')
  })

  test('★★ 对照组：任务那条路**照旧套模版**（同一台 daemon、同一个执行者）', async () => {
    const issue = await postJson('/api/issues', { title: `对照组 ${ulid().slice(-6)}` })
    const runId = ulid()
    // ⚠️ 按**下标**取，不按 `at(-1)`：任务那条路跑完还会自动串一条审核 run
    //    （而且我的假后端不吐合法判决，它还会再重试一次），所以"最后一次投递"
    //    早就不是这次执行了。上面那几条聊天用例可以放心用 `at(-1)`——那条路上
    //    没有审核，那正是它们要证明的事。
    const before = backend.seen.length
    const created = await postJson('/api/runs', {
      // ⚠️ `runId` 由**调用方**生成（这个接口的既有形状），不是服务端发的
      runId,
      kind: 'execute',
      agentRef: { id: agentId, name: '夹具执行者', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: (issue.body as { id: string }).id },
      prompt: '写一份关于依赖漏洞的报告',
      workDir: await makeTempDir('chat-e2e-task'),
      limits: { maxTurns: null, timeoutMs: null },
    })
    assert.equal(created.status, 202, `起 run 失败了：${JSON.stringify(created.body)}`)
    await waitForTerminal(runId)

    const sent = backend.seen[before]!
    const sysBefore = backend.seenSystem[before] ?? ''
    const all = [sysBefore, sent].filter((x) => x !== '').join('\n\n')
    // ★ 任务那条路走 A 档：① 框架（含护栏）在**系统提示**里；聊天那条路没有它。
    assert.match(sysBefore, /## 护栏/, '任务那条路必须还是有模版的（① 框架走系统提示）')
    assert.match(all, /# 任务/, '有框架那一段标题')
    assert.match(sent, /写一份关于依赖漏洞的报告/, '任务正文要在（③ 走用户消息）')
  })
})
