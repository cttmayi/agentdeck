import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentResult,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { ulid, type RunId } from '@agentdeck/protocol'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 关停屏障（NFR-P-05 的补全）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这些测试的由来：一个约 40% 概率复现的偶发失败
 * ══════════════════════════════════════════════════════════════════
 *
 * 早先 `close()` 只关 HTTP server 与 store，**不等执行中的 run**。测试里
 * 紧接着清理数据目录，就撞上：
 *
 *     ENOTEMPTY: directory not empty, rmdir '.../runs/<ulid>'
 *
 * 表面看像测试写得不严谨（"谁让你不等一等"），但它其实是**产品缺陷**：
 *
 *   - 真实使用中按 Ctrl-C，子进程还在跑、还在改工作目录里的文件——
 *     使用者以为停了，其实没有；
 *   - "已停止"这句话在没有屏障时是假的。
 *
 * 所以修的是产品，不是测试。
 */

/** 慢后端：模拟一个长时间不说话、只能被取消的 agent。 */
class SlowBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  started = 0
  cancelled = 0

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-slow' }
  }

  async execute(_opts: ExecOptions): Promise<AgentSession> {
    this.started += 1
    const queue = new AsyncQueue<AgentMessage>()
    const self = this

    // 一个只有"结束"或"被取消"两种出口的结果 Promise。
    // ★ 它必须**一定会 resolve**：执行器会 await 它，漏了就是永久挂起。
    let settle!: (r: AgentResult) => void
    const result = new Promise<AgentResult>((res) => {
      settle = res
    })

    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      queue.close()
      settle({ status: 'failed', output: '', error: '关停时被取消', durationMs: 1 })
    }
    // 兜底上限：正常路径应当由 cancel() 提前结束，这里是防止永久挂起。
    const timer = setTimeout(finish, 3_000)

    return {
      messages: queue,
      result,
      async cancel() {
        self.cancelled += 1
        finish()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

async function submitSlowRun(url: string, workDir: string): Promise<RunId> {
  const runId = ulid() as RunId
  const res = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'execute',
      agentRef: { id: 'agent-a', name: 'A', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: 'issue-1' },
      prompt: '随便做点什么（这个后端会一直不说话）',
      workDir,
      limits: { maxTurns: null, timeoutMs: null },
    }),
  })
  assert.equal(res.status, 202, `run 应被受理，实得 ${res.status}`)
  return runId
}

describe('★ 关停屏障：close() 必须等执行中的 run 真的结束', () => {
  test('★ 关停必须真的取消执行中的 run，而不是只关掉 HTTP server', async () => {
    const dir = await makeTempDir('shutdown-data')
    const work = await makeTempDir('shutdown-work')
    const backend = new SlowBackend()
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      await submitSlowRun(d.url, work)
      // 稍等一下，确保 run 真的进到"执行中"而不是还在排队
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(backend.started, 1, 'run 确实被执行过')
    } finally {
      await d.close()
    }

    assert.ok(
      backend.cancelled >= 1,
      '★ 关停必须去取消执行中的 run —— 否则 Ctrl-C 之后子进程还在改文件',
    )
    // 关停是屏障：此刻目录树已经稳定，清理不会再撞 ENOTEMPTY
    await cleanup(dir)
    await cleanup(work)
  })

  test('★ 关停后数据目录可以被干净删除（早先会 ENOTEMPTY）', async () => {
    const dir = await makeTempDir('shutdown-clean')
    const work = await makeTempDir('shutdown-clean-work')
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: new SlowBackend(),
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      await submitSlowRun(d.url, work)
      await new Promise((r) => setTimeout(r, 150))
    } finally {
      await d.close()
    }

    // 早先这里会因为"run 还在往 runs/<ulid> 里写"而偶发 ENOTEMPTY
    await cleanup(dir)
    await cleanup(work)
    const gone = await readdir(dir).catch(() => null)
    assert.equal(gone, null, '数据目录应已完全删除')
  })

  test('关停后再提交 run 会被明确拒绝，而不是静默受理', async () => {
    const dir = await makeTempDir('shutdown-late')
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: new SlowBackend(),
      onWarn: () => {},
      onInfo: () => {},
    })
    await d.close()

    // HTTP server 已关，连接会失败——这本身就是"明确拒绝"。
    await assert.rejects(
      () => fetch(`${d.url}/api/runs`, { method: 'POST', body: '{}' }),
      '关停后不该还能提交',
    )
    await cleanup(dir)
  })
})

describe('★ 起不来时必须给可读理由，并且把资源还回去', () => {
  test('★ 端口被占用 ⇒ 抛出可读错误（而不是未捕获的 error 事件 + 栈）', async () => {
    const dirA = await makeTempDir('port-a')
    const dirB = await makeTempDir('port-b')
    const first = await startDaemon({
      dataDir: dirA,
      port: 0,
      fsync: false,
      backend: new SlowBackend(),
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      // 早先这里是 `listen(port, host, resolve)`——没挂 error 处理器。
      // 端口被占用时 Node 会 emit 'error'，没人接 ⇒ 未捕获异常 + 栈 + 进程退出，
      // 同时那个 Promise **永不 settle**，于是 cli.ts 里写好的提示一行都跑不到。
      // 单测都用 port: 0，所以这个缺陷在测试里完全看不见。
      await assert.rejects(
        () =>
          startDaemon({
            dataDir: dirB,
            port: first.port,
            fsync: false,
            backend: new SlowBackend(),
            onWarn: () => {},
            onInfo: () => {},
          }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          assert.match(message, /已被占用/, '要说清是什么问题')
          assert.match(message, new RegExp(String(first.port)), '要说清是哪个端口')
          assert.match(message, /--port/, '要给出下一步怎么做')
          assert.match(message, /不自动换端口/, '要解释为什么不自动换')
          // 不该是一串栈
          assert.ok(!message.includes('at Server.'), '不该把原始栈丢给使用者')
          return true
        },
      )
    } finally {
      await first.close()
    }

    // ★ 失败的那次也必须把数据目录的单进程锁还回去。
    //   不还的话，使用者改个端口重启会撞上"数据已被另一个进程占用"，
    //   而那个"另一个进程"其实正是刚刚失败的自己——错误信息把人带偏。
    const retry = await startDaemon({
      dataDir: dirB,
      port: 0,
      fsync: false,
      backend: new SlowBackend(),
      onWarn: () => {},
      onInfo: () => {},
    })
    await retry.close()

    await cleanup(dirA)
    await cleanup(dirB)
  })
})

describe('★ 取消要记成"使用者取消"，不是"环境坏了"', () => {
  test('★ 取消后状态是 cancelled、原因不指向环境', async () => {
    // 取消会让会话以"失败"收场，于是失败分级把它归到 `infra_error`——
    // 而那是"环境坏了"的意思。**错误原因指向完全错误的地方**：
    // 有人会去查 CLI 装没装好，而真相是"有人点了取消"。
    const dir = await makeTempDir('cancel-semantics')
    const work = await makeTempDir('cancel-work')
    const backend = new SlowBackend()
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = await submitSlowRun(d.url, work)
      await new Promise((r) => setTimeout(r, 200))

      const res = await fetch(`${d.url}/api/runs/${runId}/cancel`, { method: 'POST' })
      assert.equal(res.status, 200)
      await new Promise((r) => setTimeout(r, 300))

      const run = (await (await fetch(`${d.url}/api/runs/${runId}`)).json()) as {
        status: string
        failureReason: string | null
      }
      assert.equal(run.status, 'cancelled', '取消是使用者的动作，就该记成使用者的动作')
      assert.notEqual(
        run.failureReason,
        'infra_error',
        '★ 记成 infra_error 会让人去查环境——而环境没问题',
      )
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(work)
    }
  })
})
