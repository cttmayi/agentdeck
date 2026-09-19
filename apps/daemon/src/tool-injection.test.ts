import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@alpha-helper/agent-core'
import { ulid, type RunId } from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { setupToolFixture } from './testing/tool-fixture.ts'

/**
 * D42 接线：执行者挂载的工具包 → 工作目录（`syncInjectedTools` 的端到端落点）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么值得一整个文件
 * ══════════════════════════════════════════════════════════════════
 *
 * D42 之前，"执行者挂载工具"只被**存下来**（挂载接口、角色防呆、卸载提醒都在），
 * 运行时**从来没有**把它送进干活时的会话——skill 会注入工作目录，工具不会。
 * 这一条 gap 单测看不见：纯函数只知道"`syncInjectedTools` 会写文件"，而使用者
 * 遇到的问题是"**在真的跑一次 run 的时候**，挂了的工具到底有没有出现在工作目录
 * 里、第一句话里、日志里，跑完有没有被清掉"。那四站只能靠真链路钉住。
 *
 * 用什么跑的：照抄 `task-action-whitelist.test.ts` 的夹具（真 daemon + 假后端 +
 * 真工具包）。**NFR-T-01：绝不调用使用者真实安装的 agent CLI。**
 */

/**
 * 假 CLI：执行**那一刻**抓两样东西——
 *
 *   · `seenToolFiles`：工作目录里 `.alpha-helper/tools/<slug>/` 下的全部文件。
 *     必须**在执行时**抓，不能等 run 结束再去看磁盘：注入是临时的，run 收尾会
 *     把工具目录删掉（跑完再看永远是"不存在"，会以"没写下去"的假象失败）。
 *   · `seenPrompt`：这次 run 的第一句话（断言"工具被列给模型了"）。
 */
class ToolBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = false

  seenPrompt: string | null = null
  seenToolFiles: Record<string, string> = {}

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seenPrompt = opts.prompt

    this.seenToolFiles = {}
    const root = join(opts.workDir, '.alpha-helper', 'tools')
    for (const slug of await readdir(root).catch(() => [] as string[])) {
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = join(dir, entry.name)
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) await walk(full, rel)
          else this.seenToolFiles[`${slug}/${rel}`] = await readFile(full, 'utf8').catch(() => '')
        }
      }
      await walk(join(root, slug), '')
    }

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '我做完了这件事。' })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed' as const,
        output: '我做完了这件事。',
        error: null,
        durationMs: 3,
        sessionId: 'exec-session',
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' as const },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

interface Harness {
  daemon: DaemonHandle
  backend: ToolBackend
  url: string
  newWorkDir(prefix?: string): Promise<string>
  close(): Promise<void>
}

async function startHarness(prefix: string): Promise<Harness> {
  const dir = await makeTempDir(prefix)
  const backend = new ToolBackend()
  const daemon = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    workRoot: join(dir, 'workroot'),
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })
  const dirs = [dir]
  return {
    daemon,
    backend,
    url: daemon.url,
    async newWorkDir(p = `${prefix}-work`) {
      const made = await makeTempDir(p)
      dirs.push(made)
      return made
    },
    async close() {
      await daemon.close()
      for (const d of dirs) await cleanup(d)
    },
  }
}

/** 提交一条执行 run，返回 runId；断言受理成功。 */
async function submitExecute(
  h: Harness,
  input: { agentId: string; agentName: string; workDir: string; prompt?: string },
): Promise<RunId> {
  const runId = ulid() as RunId
  const res = await fetch(`${h.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'execute',
      agentRef: { id: input.agentId, name: input.agentName, instructions: '' },
      // ★ 这次明确不自动审核：夹具的执行者默认挂着审核者，若让它自动派生一条
      //   审核 run，那条审核 run 会在同一个假后端上执行，把 execute() 快照
      //   （seenToolFiles / seenPrompt）盖成审核侧的空值——断言读到的就不是
      //   执行 run 的了。
      reviewerAgentId: null,
      skills: [],
      subject: { type: 'issue', id: 'issue-tool-inj' },
      prompt: input.prompt ?? '把这次任务做完',
      workDir: input.workDir,
      limits: { maxTurns: null, timeoutMs: null },
    }),
  })
  assert.equal(res.status, 202, `受理必须返回 202，实际 ${res.status}`)
  return runId
}

/** 等到日志里出现某句话。 */
async function waitForText(h: Harness, runId: string, pattern: RegExp): Promise<string> {
  const timeout = Date.now() + 10_000
  let last = ''
  for (;;) {
    const res = await fetch(`${h.url}/api/runs/${runId}/messages`)
    const body = (await res.json()) as { messages?: Array<{ content: string }> }
    const lines = (body.messages ?? []).map((m) => m.content).join('\n')
    last = lines
    if (pattern.test(lines)) return lines
    if (Date.now() > timeout) {
      assert.fail(`日志里没等到 ${pattern}；最后看到：\n${last.slice(-800)}`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 等 run 跑到终态。 */
async function readUntilTerminal(url: string): Promise<void> {
  const res = await fetch(url)
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
      if (!raw.startsWith('data: ')) continue
      const event = JSON.parse(raw.slice(6)) as { t: string; status?: string }
      if (event.t === 'terminal') return
    }
  }
  assert.fail('流结束都没等到终态')
}

let h: Harness

before(async () => {
  h = await startHarness('tool-inj')
})

after(async () => {
  await h.close()
})

describe('★ D42：执行者挂载的工具包，真的被送进干活时的会话', () => {
  test('★ 包内容出现在工作目录、第一句话列出、日志说明注入、跑完清掉', async () => {
    // 造包 + 装 + 建执行者并挂上工具（夹具一步到位）
    const fx = await setupToolFixture(h, {
      slug: 'exec-tool',
      files: {
        'TOOL.md': '# exec-tool\n\n往工作目录写一个结果文件。',
        'extra/readme.txt': '附属说明',
      },
    })
    const workDir = await h.newWorkDir()

    const runId = await submitExecute(h, {
      agentId: fx.executor.id,
      agentName: fx.executor.name,
      workDir,
    })

    // ① 日志说清了"注入进去了"
    const text = await waitForText(h, runId, /已注入 1 个工具包/)
    assert.match(text, /已注入 1 个工具包：exec-tool/, '必须说出注入的是哪个包')
    assert.match(text, /写入 \.alpha-helper\/tools\//, '也要说清写到哪儿了')

    // ② 执行那一刻，工作目录里**真的有**这个包（含脚本、tool.json、TOOL.md、子目录）。
    //    快照是假后端在 execute() 那一刻抓的，所以等终态即可（快照留在内存里，
    //    不会随 run 收尾的清理消失）。
    await readUntilTerminal(`${h.url}/api/runs/${runId}/events`)
    const files = h.backend.seenToolFiles
    assert.ok(
      'exec-tool/index.mjs' in files && (files['exec-tool/index.mjs']?.length ?? 0) > 0,
      '入口脚本要在工作目录里',
    )
    assert.equal(JSON.parse(files['exec-tool/tool.json'] ?? 'null')?.slug, 'exec-tool')
    assert.equal(files['exec-tool/TOOL.md'], '# exec-tool\n\n往工作目录写一个结果文件。')
    assert.equal(files['exec-tool/extra/readme.txt'], '附属说明', '包里的子目录也要一起进来')

    // ③ 第一句话**列出了**这个工具（模型得知道它在哪、干什么用）
    assert.match(h.backend.seenPrompt ?? '', /## 干活时能用的工具包/)
    assert.match(h.backend.seenPrompt ?? '', /`exec-tool`（exec-tool 夹具）/)
    assert.match(
      h.backend.seenPrompt ?? '',
      /包在 `\.alpha-helper\/tools\/exec-tool`，先读里面的 TOOL\.md 再决定怎么用/,
    )

    // ④ 跑完收尾：工具目录从工作目录里消失（只留 agent 的产出）
    const afterRun = await readdir(join(workDir, '.alpha-helper')).catch(() => [] as string[])
    assert.ok(
      !afterRun.includes('tools'),
      '★ 注入是临时的：run 结束工具目录要收掉，工作目录只留 agent 的产出',
    )
  })

  test('★ 没挂工具的执行者：日志明说"没有注入任何工具包"，第一句话没有工具节', async () => {
    // 不挂任何工具的普通执行者（agentRef 指向一个不存在的 agent ⇒ toolIds 为空）
    const workDir = await h.newWorkDir()
    const runId = await submitExecute(h, {
      agentId: 'bare-executor',
      agentName: '没挂工具的',
      workDir,
    })
    const text = await waitForText(h, runId, /没有注入任何工具包/)
    assert.match(text, /只用自己的内置能力干活/, '要说清后果')
    await readUntilTerminal(`${h.url}/api/runs/${runId}/events`)
    assert.doesNotMatch(h.backend.seenPrompt ?? '', /干活时能用的工具包/, '没工具就不该有那一节')
  })

  test('★ 撞上使用者自己的同名工具目录 ⇒ run 失败，记 injection_failed', async () => {
    // 使用者自己放的 `.alpha-helper/tools/exec-tool` 不该被平台覆盖
    const ownDir = await makeTempDir('tool-inj-collide-data')
    const ownBackend = new ToolBackend()
    const own = await startDaemon({
      dataDir: ownDir,
      port: 0,
      fsync: false,
      backend: ownBackend,
      onWarn: () => {},
      onInfo: () => {},
    })
    const fx = await setupToolFixture(own, { slug: 'exec-tool' })
    const workDir = await h.newWorkDir('tool-inj-collide')
    await mkdir(join(workDir, '.alpha-helper', 'tools', 'exec-tool'), { recursive: true })
    await writeFile(
      join(workDir, '.alpha-helper', 'tools', 'exec-tool', 'mine.txt'),
      '使用者的东西',
      'utf8',
    )
    try {
      const runId = ulid() as RunId
      const res = await fetch(`${own.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: fx.executor.id, name: fx.executor.name, instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'issue-tool-collide' },
          prompt: '把这次任务做完',
          workDir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)
      await readUntilTerminal(`${own.url}/api/runs/${runId}/events`)
      const run = (await (await fetch(`${own.url}/api/runs/${runId}`)).json()) as {
        status: string
        failureReason: string | null
      }
      assert.equal(run.status, 'failed')
      assert.equal(
        run.failureReason,
        'injection_failed',
        '★ 撞车是使用者能自己修的，不该报成"环境坏了"',
      )
      // 使用者的文件一个字都没变
      assert.equal(
        await readFile(join(workDir, '.alpha-helper', 'tools', 'exec-tool', 'mine.txt'), 'utf8'),
        '使用者的东西',
      )
    } finally {
      await own.close()
      await cleanup(ownDir)
    }
  })
})
