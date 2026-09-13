import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  CONTEXT_BLOCK_BEGIN,
  CONTEXT_BLOCK_END,
  hasContextBlock,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@alpha-helper/agent-core'
import { ulid, type Issue, type RunId } from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { makeTempDir } from './testing/tmp.ts'

/**
 * 上下文块清理的**身份判据**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条测试是为一个"看起来不可能发生"的竞态写的
 * ══════════════════════════════════════════════════════════════════
 *
 * 审核与执行**共用同一个工作目录**之后（workdir.ts 的 `inheritFrom`），
 * 同一个 `CLAUDE.md` 会被两次 run 先后使用：
 *
 *   执行 run 跑完 → 自动串接审核（审核 run 并发开始）→ 审核 run 把块**原地
 *   替换**成它自己的 → 这时执行 run 才走到 `cleanup()`。
 *
 * 而 `removeContextBlock` 摘的是"当前内容里找到的第一个块"——它不知道那个块
 * 是不是自己写的。于是执行 run 的收尾会把**审核 run 的上下文摘掉**：审核者
 * 手里就没了审核标准与判决 schema，而且**不会有任何报错**。
 *
 * 修法是清理前先认身份（看块里的 `- run：`）。两件事都钉住：
 *   ① 不是自己的块 ⇒ 原样留着，并且在日志里说明；
 *   ② 是自己的块 ⇒ 照旧逐字节还原（这条由下面第二个用例覆盖）。
 */

/** 扮演"同一目录里另一次 run"：执行期间把块换成别人的。 */
class ForeignBlockBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 换上去的那个"别人的" run id。 */
  foreignRunId = '01M2OTHER00000000000000000'
  /** 使用者自己写在文件里的内容（块之外，必须原样保留）。 */
  userText = '使用者自己的一段话。\n'

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    if (this.foreignRunId !== '') {
      // 模拟"另一次 run 刚刚把块换成它自己的"：块在原地被替换 + 块外还有
      // 使用者自己的内容（正是"清理会真的写回文件"的那个分支）
      await writeFile(
        join(opts.workDir, 'CLAUDE.md'),
        `${CONTEXT_BLOCK_BEGIN}\n# 任务（由 alpha-helper 自动管理）\n\n` +
          `- run：\`${this.foreignRunId}\`\n${CONTEXT_BLOCK_END}\n\n${this.userText}`,
        'utf8',
      )
    }

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '报告：做完了。' })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '报告：做完了。',
        durationMs: 1,
        sessionId: 'exec-1',
        usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 1, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('★ 上下文块清理：只摘自己写的那个块', () => {
  let dataDir: string
  let workDir: string
  let daemon: DaemonHandle
  let backend: ForeignBlockBackend
  let issueId: Issue['id']
  let agentId: string
  let reviewerId: string

  before(async () => {
    dataDir = await makeTempDir('ctxclean-data')
    workDir = await makeTempDir('ctxclean-work')
    backend = new ForeignBlockBackend()
    daemon = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend,
      onWarn: () => {},
      onInfo: () => {},
    })

    const res = await fetch(`${daemon.url}/api/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '随便一个任务' }),
    })
    issueId = ((await res.json()) as Issue).id

    const agents = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as {
      agents: Array<{ id: string; role: string; reviewerAgentId: string | null }>
    }).agents
    agentId = agents.find((a) => a.role === 'executor')!.id
    reviewerId = agents.find((a) => a.role === 'reviewer')!.id
    assert.ok(agentId && reviewerId)
  })

  after(async () => {
    await daemon.close()
  })

  test('★ 别人正在用的块不许摘掉（否则那次 run 就没了依据）', async () => {
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
        prompt: '随便做点什么',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    assert.equal(res.status, 202)

    // 等这次执行收尾（终态事件之后 cleanup 一定已经跑完）
    await waitFor(async () => {
      const list = ((await (await fetch(`${daemon.url}/api/runs`)).json()) as {
        runs: Array<{ runId: string; kind: string; status: string }>
      }).runs
      const r = list.find((x) => x.runId === runId)
      return r && r.status !== 'queued' && r.status !== 'running' && r.status !== 'dispatched'
        ? r
        : null
    })

    const content = await readFile(join(workDir, 'CLAUDE.md'), 'utf8')

    // ① 别人的块还在（这是修复的核心：不再"见到块就摘"）
    assert.ok(
      content.includes(backend.foreignRunId),
      '★ 不是本次 run 写的块必须原样留着 —— 摘掉它会让还在跑的那次 run 失去上下文',
    )
    // ② 块外使用者自己的内容一个字节都没被动过
    assert.ok(content.includes(backend.userText), '块外的内容不许改动')
    assert.ok(hasContextBlock(content), '块本身应当还在')

    // ③ 这件事必须**看得见**：日志里要说清为什么没动它
    const messages = ((await (
      await fetch(`${daemon.url}/api/runs/${runId}/messages?all=1`)
    ).json()) as { messages: Array<{ content: string }> }).messages
    assert.ok(
      messages.some((m) => (m.content ?? '').includes('另一次 run')),
      '★ 跳过清理这件事要写进 run 日志，否则"文件没被还原"看起来像 bug',
    )
  })
})
