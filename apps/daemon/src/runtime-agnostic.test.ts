import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import {
  ulid,
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type AuditRecord,
  type Issue,
  type RunId,
} from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ★ 换一个 runtime：不许再有任何地方写死 claude
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条用例是为一个真实提问写的
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者问：「如果我换 opencode，是否就会不正常？」
 *
 * 查下来：**数据驱动的部分是好的**（技能目录、上下文文件名、状态目录、prompt
 * 投递方式、受管旗标全都从描述表取）。但皮上有四处 claude 形状，而且**都不报错**：
 *
 *   1. 审计里的 `runtimeDescriptorKey` 写死 `'claude'`（外加 `cliVersion` 与
 *      `cliVersion` 恒为 `null`），argv 还是按描述表拼的**大概样子**；
 *   2. 技能投递能力表达不出"这个 CLI 没有技能发现机制"，只能填一个"它不读"的目录；
 *   3. 界面的 runtime 选项写死两项、"未验证"提示按 `=== 'generic'` 判；
 *   4. 文件清单的 `isManaged` 只认 `CLAUDE.md` / `.claude/**`。
 *
 * 前两条已经改了，这条用例是它们的守卫：**整个 daemon 跑在第二个 runtime 上**
 * （`runtimeKey: 'generic'`），然后断言没有任何一处还认为自己在跑 claude。
 *
 * ⚠️ 用第二个 runtime 跑之前，必须把播种出来的 agent 全部改成 generic：
 *    那些 agent 的 `runtimeKey` 是 `'claude'`，而注入的假后端只对**daemon 级
 *    runtime** 生效（见 `server.ts` 的 `resolveRuntime`）——不改的话，它们的 run
 *    会去找真的 `claude` 可执行文件。那既是 NFR-T-01 禁止的，也会让用例挂住。
 */

/** 扮演第二个 CLI：它**没有**技能发现机制（描述表就是这么声明的）。 */
class SecondRuntimeBackend implements AgentBackend {
  readonly key = 'generic'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = false

  /** 假后端照样要**如实上报命令行**——审计记的是这条，不是按描述表拼的。 */
  readonly argv = ['/usr/local/bin/agent-cli', '--non-interactive', '--output', 'ndjson']
  calls = 0

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'agent-cli', cliVersion: '9.9.9-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.calls += 1
    opts.onCommandLine?.({ argv: this.argv, sandboxDescription: '未启用沙箱（测试）' })

    const text = [
      '我的审核结论如下：',
      VERDICT_FENCE_BEGIN,
      JSON.stringify({
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        confidence: 0.9,
        findings: [],
        action: null,
        escalateReason: null,
      }),
      VERDICT_FENCE_END,
      '以上。',
    ].join('\n')

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: text,
        durationMs: 1,
        sessionId: 'second-runtime-session',
        usage: { inputTokens: 5, outputTokens: 3, costUsdMicros: 7, costSource: 'provider' },
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

describe('★ 第二个 runtime：审计、技能投递、日志都不许写死 claude', () => {
  let dataDir: string
  let workRoot: string
  let daemon: DaemonHandle
  let backend: SecondRuntimeBackend

  // 用函数声明而不是泛型箭头：本仓库开 `erasableSyntaxOnly`，而 node 的类型
  // 剥离对 `.ts` 里的泛型箭头写法挑食（`<T,>` 那种）。
  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${daemon.url}${path}`, init)
    return (await res.json()) as T
  }

  before(async () => {
    dataDir = await makeTempDir('agnostic-data')
    workRoot = await makeTempDir('agnostic-work')
    backend = new SecondRuntimeBackend()
    daemon = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend,
      // ★ daemon 级 runtime 就是第二个：注入的假后端因此对它生效
      runtimeKey: 'generic',
      workRoot,
      onWarn: () => {},
      onInfo: () => {},
    })

    // 播种出来的 agent 是 claude 的，全部改成第二个 runtime
    const { agents } = await api<{ agents: Array<{ id: string; runtimeKey: string }> }>('/api/agents')
    for (const a of agents) {
      if (a.runtimeKey === 'generic') continue
      const res = await fetch(`${daemon.url}/api/agents/${a.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeKey: 'generic' }),
      })
      assert.equal(res.status, 200, `把 agent ${a.id} 改成 generic 失败`)
    }
  })

  after(async () => {
    await daemon.close()
    await cleanup(dataDir)
    await cleanup(workRoot)
  })

  test('★ 审计记的是**它自己的** runtime、真版本、真命令行、真块哈希', async () => {
    // 走报告摄取那条路：它会按"所有 role=reviewer 的 agent"起审核 run
    const res = await fetch(`${daemon.url}/api/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'agnostic-test',
        items: [{ externalId: 'x1', kind: 'run-output', title: '随便一份报告', body: '正文' }],
      }),
    })
    assert.equal(res.status, 202)
    const summary = (await res.json()) as { runIds: string[] }
    assert.ok(summary.runIds.length > 0, '应当起了审核 run')

    const runId = summary.runIds[0]!
    await waitFor(async () => {
      const { runs } = await api<{ runs: Array<{ runId: string; status: string }> }>('/api/runs')
      const r = runs.find((x) => x.runId === runId)
      return r && r.status === 'completed' ? r : null
    })

    const { audits } = await api<{ audits: AuditRecord[] }>(`/api/runs/${runId}/audits`)
    assert.equal(audits.length, 1)
    const audit = audits[0]!

    // ① runtime 描述表的键：**这一条以前恒为 'claude'**
    assert.equal(
      audit.runtimeDescriptorKey,
      'generic',
      '★ 审计必须记它真的用的那个 runtime —— 写死的「claude」会让审计在事后说谎',
    )
    // ② CLI 版本来自探测（假后端声明 9.9.9-fake），不是恒 null
    assert.equal(audit.cliVersion, '9.9.9-fake', '★ 版本要来自探测，不是写死的 null')
    // ③ 命令行来自后端**如实上报**的那条（含沙箱状态），不是按描述表拼的大概样子
    assert.deepEqual(
      audit.argvRedacted,
      backend.argv,
      '★ 审计记的必须是实际执行的那条命令行',
    )
    // ④ 输入哈希是真算出来的（受管块删掉之后，输入只剩一处，哈希也只剩一个）
    assert.match(
      String(audit.promptHash),
      /^[0-9a-f]{64}$/,
      '★ 输入哈希要么是真算的，要么是 null；以前 `contextBlockHash` 恒为 null 等于"我们没记"',
    )
  })

  test('★ 声明"没有技能发现机制"⇒ 一个文件都不写，并在日志里明说', async () => {
    const dir = await makeTempDir('agnostic-run')
    try {
      // ⚠️ 夹具自己装一条 skill：D38 之后首启**不再播种** skill（技能库是空的），
      //    而这条用例要测的正是"挂了 skill 但那个 runtime 没有技能发现机制"。
      const installed = await api<{ installed: Array<{ id: string; slug: string }> }>('/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          skills: [{ slug: 'agnostic-skill', name: '夹具技能', body: '# 夹具', source: 'local' }],
        }),
      })
      const skill = installed.installed[0]
      assert.ok(skill, '夹具 skill 要装得上')

      // 不指向审核者的执行者：这条用例只要一个写入者
      const agent = await api<{ id: string }>('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '第二个 runtime 的执行者',
          role: 'executor',
          runtimeKey: 'generic',
          skillIds: [skill.id],
        }),
      })

      const issue = await api<Issue>('/api/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '技能投递能力用例' }),
      })

      const runId = ulid() as RunId
      const res = await fetch(`${daemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agent.id, name: '第二个 runtime 的执行者', instructions: '' },
          // ★ 不传 skills：让 daemon 按 agent 的配置解析（挂了一个 skill）
          subject: { type: 'issue', id: issue.id },
          prompt: '随便做点什么',
          workDir: dir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)

      await waitFor(async () => {
        const { runs } = await api<{ runs: Array<{ runId: string; status: string }> }>('/api/runs')
        const r = runs.find((x) => x.runId === runId)
        return r && r.status === 'completed' ? r : null
      })

      // ① 一个技能文件都没写（描述表说这个 CLI 没有这个机制）
      assert.deepEqual(
        await readdir(join(dir, '.agent')).catch(() => [] as string[]),
        [],
        '★ 声明"没有技能发现机制"时不许往工作目录里写技能文件',
      )
      // ② 而且必须**说出来**：挂了技能却注入不了，是要让人知道的事
      const { messages } = await api<{ messages: Array<{ content: string }> }>(
        `/api/runs/${runId}/messages?since=-1`,
      )
      const text = messages.map((m) => m.content ?? '').join('\n')
      assert.match(text, /没有技能发现机制/, '★ 不写文件这件事必须在 run 日志里说清')
      assert.match(text, /挂了 1 个 skill/, '要说清"不是没挂，而是这个 runtime 送不进去"')
      assert.match(text, new RegExp(skill.slug), '并点名是哪个 skill')
    } finally {
      await cleanup(dir)
    }
  })
})

/**
 * ★ service 形状的 runtime：整条 daemon 跑在 codex 上
 *
 * generic 那组用例证明"换一个 **CLI**（cli 形状）不写死 claude"；这组证明
 * **换一种 runtime 形状**（service：常驻服务 + JSON-RPC）也不写死——codex
 * 没有 run 级 argv、没有受管旗标，差异全在描述表（`kind:'service'`）里。
 * 假后端 `CodexServiceBackend` 只声明 `protocol: 'jsonrpc'`：执行 / 审计 /
 * 技能注入路径不该关心这些（FR-CLI-47：差异在表里，不在调用点）。
 *
 * ⚠️ 与 generic 那组同样的规矩：播种出来的 agent 都是 claude 的，必须全部
 *    改成 codex——注入的假后端只对 daemon 级 runtime 生效，不改的话它们的
 *    run 会去找真的 `codex` 可执行文件（NFR-T-01 禁止 + 用例挂住）。
 */
class CodexServiceBackend implements AgentBackend {
  readonly key = 'codex'
  readonly protocol = 'jsonrpc' as const
  readonly rejectDetectable = false

  /** 假后端照样要**如实上报命令行**——service 形状下它就是 app-server 启动行。 */
  readonly argv = ['/usr/local/bin/codex', 'app-server', '--stdio']
  calls = 0
  /**
   * execute 那一刻工作目录 `.codex/skills/` 里的目录名。
   *
   * ★ 注入发生在 execute **之前**、run 结束后的清理在 execute **之后**——
   *    run 完成后再去看文件系统，技能已经按设计被收掉了（"工作目录只留
   *    agent 的产出"）。所以"文件确实写到了描述表声明的目录"只能由假后端
   *    在 execute 时当场快照来证明。
   */
  skillsDirsAtExecute: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'codex', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.calls += 1
    opts.onCommandLine?.({ argv: this.argv, sandboxDescription: '未启用沙箱（测试）' })
    this.skillsDirsAtExecute = await readdir(join(opts.workDir, '.codex', 'skills')).catch(
      () => [] as string[],
    )

    const text = [
      '我的审核结论如下：',
      VERDICT_FENCE_BEGIN,
      JSON.stringify({
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        confidence: 0.9,
        findings: [],
        action: null,
        escalateReason: null,
      }),
      VERDICT_FENCE_END,
      '以上。',
    ].join('\n')

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: text,
        durationMs: 1,
        // service 形状的会话凭据 = thread id（描述表 sessionState:'stateful'）
        sessionId: 'codex-thread-fake',
        usage: { inputTokens: 5, outputTokens: 3, costUsdMicros: 7, costSource: 'estimated' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

describe('★ 第三个 runtime（service 形状）：整条 daemon 跑在 codex 上', () => {
  let dataDir: string
  let workRoot: string
  let daemon: DaemonHandle
  let backend: CodexServiceBackend

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${daemon.url}${path}`, init)
    return (await res.json()) as T
  }

  before(async () => {
    dataDir = await makeTempDir('service-data')
    workRoot = await makeTempDir('service-work')
    backend = new CodexServiceBackend()
    daemon = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend,
      // ★ daemon 级 runtime 就是 codex：注入的假后端因此对它生效
      runtimeKey: 'codex',
      workRoot,
      onWarn: () => {},
      onInfo: () => {},
    })

    // 播种出来的 agent 是 claude 的，全部改成 codex
    const { agents } = await api<{ agents: Array<{ id: string; runtimeKey: string }> }>('/api/agents')
    for (const a of agents) {
      if (a.runtimeKey === 'codex') continue
      const res = await fetch(`${daemon.url}/api/agents/${a.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtimeKey: 'codex' }),
      })
      assert.equal(res.status, 200, `把 agent ${a.id} 改成 codex 失败`)
    }
  })

  after(async () => {
    await daemon.close()
    await cleanup(dataDir)
    await cleanup(workRoot)
  })

  test('★ 审计记的是 codex 自己的 runtime、真版本、真命令行（service 形状也没有例外）', async () => {
    // 走报告摄取那条路：它会按"所有 role=reviewer 的 agent"起审核 run
    const res = await fetch(`${daemon.url}/api/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'service-test',
        items: [{ externalId: 'x1', kind: 'run-output', title: '一份报告', body: '正文' }],
      }),
    })
    assert.equal(res.status, 202)
    const summary = (await res.json()) as { runIds: string[] }
    assert.ok(summary.runIds.length > 0, '应当起了审核 run')

    const runId = summary.runIds[0]!
    await waitFor(async () => {
      const { runs } = await api<{ runs: Array<{ runId: string; status: string }> }>('/api/runs')
      const r = runs.find((x) => x.runId === runId)
      return r && r.status === 'completed' ? r : null
    })

    const { audits } = await api<{ audits: AuditRecord[] }>(`/api/runs/${runId}/audits`)
    assert.equal(audits.length, 1)
    const audit = audits[0]!

    assert.equal(
      audit.runtimeDescriptorKey,
      'codex',
      '★ 审计必须记它真的用的那个 runtime——service 形状也没有例外',
    )
    assert.equal(audit.cliVersion, '0.0.0-fake', '★ 版本要来自探测，不是写死的 null')
    assert.deepEqual(
      audit.argvRedacted,
      backend.argv,
      '★ 审计记的必须是实际执行的那条命令行（service 形状 = app-server 启动行）',
    )
    assert.match(
      String(audit.promptHash),
      /^[0-9a-f]{64}$/,
      '★ 输入哈希要么是真算的，要么是 null',
    )
  })

  test('★ 技能注入走描述表声明的目录：codex 是 .codex/skills，文件写下去 + 日志明说', async () => {
    const dir = await makeTempDir('service-run')
    try {
      const installed = await api<{ installed: Array<{ id: string; slug: string }> }>('/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          skills: [{ slug: 'service-skill', name: '夹具技能', body: '# 夹具', source: 'local' }],
        }),
      })
      const skill = installed.installed[0]
      assert.ok(skill, '夹具 skill 要装得上')

      const agent = await api<{ id: string }>('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'codex 的执行者',
          role: 'executor',
          runtimeKey: 'codex',
          skillIds: [skill.id],
        }),
      })

      const issue = await api<Issue>('/api/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '技能注入（service 形状）' }),
      })

      const runId = ulid() as RunId
      const res = await fetch(`${daemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agent.id, name: 'codex 的执行者', instructions: '' },
          subject: { type: 'issue', id: issue.id },
          prompt: '随便做点什么',
          workDir: dir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)

      await waitFor(async () => {
        const { runs } = await api<{ runs: Array<{ runId: string; status: string }> }>('/api/runs')
        const r = runs.find((x) => x.runId === runId)
        return r && r.status === 'completed' ? r : null
      })

      // ① 注入发生在 execute 之前：假后端当场快照到了 `.codex/skills/<slug>/`
      assert.ok(
        backend.skillsDirsAtExecute.includes(skill.slug),
        `★ execute 时 .codex/skills/ 里应该有 ${skill.slug}（实际：${backend.skillsDirsAtExecute.join('、')}）`,
      )
      // ② 日志明说完整生命周期：注入到哪（CLI 自己会扫）、跑完收掉
      const { messages } = await api<{ messages: Array<{ content: string }> }>(
        `/api/runs/${runId}/messages?since=-1`,
      )
      const text = messages.map((m) => m.content ?? '').join('\n')
      assert.match(text, /已注入 1 个 skill/, '★ 写下去了就要在日志里说清楚')
      assert.match(text, /写入 \.codex\/skills\//, '★ 说清写进哪个目录（来自描述表，不是写死的 .claude）')
      assert.match(text, new RegExp(skill.slug), '并点名是哪个 skill')
      assert.match(text, /已移除本次注入的 skill/, '★ 跑完要收掉：工作目录只留 agent 的产出')
      // ③ 收尾之后盘上是干净的（这是"跑完即清"的设计，不是没写）
      assert.deepEqual(
        await readdir(join(dir, '.codex', 'skills')).catch(() => [] as string[]),
        [],
        '★ 清理后 .codex/skills/ 应为空（清的理由在日志里）',
      )
    } finally {
      await cleanup(dir)
    }
  })
})
