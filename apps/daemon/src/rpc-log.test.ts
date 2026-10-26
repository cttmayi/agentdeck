import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { verifySentText } from './rpc-log.ts'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 一个**service 形状**的假后端：它在 `execute` 里主动报 JSON-RPC 帧。
 *
 * 为什么需要它：真实 codex 适配器在测试里不能起（NFR-T-01），而这批要量的是
 * "执行器有没有把帧摘要写进运行日志"——那段接线在 executor 里，与被注入的后端无关。
 * 所以假后端按 codex 的样子报几帧（出站 + 入站 + turn/start 的正文），
 * 再由测试去 run 日志里找那几行。
 */
class RpcShapedBackend implements AgentBackend {
  readonly key = 'codex-shaped'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'codex', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    opts.onRpcFrame?.({ direction: 'out', method: 'initialize', headline: '→ initialize（clientInfo）' })
    opts.onRpcFrame?.({ direction: 'in', method: 'initialize', headline: '← initialize 成功（3ms）' })
    opts.onRpcFrame?.({ direction: 'out', method: 'turn/start', headline: '→ turn/start（input 1 项）' })
    opts.onRpcFrame?.({ direction: 'out', method: 'turn/start', headline: '（正文）', sentText: opts.prompt })
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '读完了。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '读完了。',
        durationMs: 1,
        sessionId: 'rpc-shaped',
        usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 0, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

/**
 * 分批第 44 批：「发给 CLI 的内容」与「日志里记的第一句话」是不是同一份。
 *
 * 使用者报的原话：「我在日志中有看到『命令行：/opt/homebrew/bin/codex app-server --stdio』，
 * 后面应该有发给它的命令，没有打印出来」。
 *
 * 这个函数是那条反馈的落点：`turn/start` 的 input 原文与日志里的第一句话**逐字比对**，
 * 一致就一行话钉住，不一致才打全文。
 *
 * 为什么"不一致"这一支必须有正文：那时使用者要判断"哪一份才是它真收到的"，
 * 而答案只能是线上那一份。只报"不一致"等于把判断责任推回去、又不给材料。
 */
describe('★ 分批第 44 批：发给 CLI 的正文与日志里那份的比对', () => {
  test('★★ 逐字相同 ⇒ 一行话钉住（不重复打印几十 KB 的原文）', () => {
    const text = '===== 任务 =====\n\n把 a.txt 读完\n'
    const v = verifySentText(text, text)
    assert.equal(v.identical, true)
    assert.match(v.headline, /逐字相同/)
    assert.match(v.headline, new RegExp(String(text.length)), '长度要写出来，便于一眼核对')
  })

  test('★★★ 不一致 ⇒ 打**线上那一份**的全文，并指出第几个字符起不同', () => {
    const declared = '把 a.txt 读完'
    const sent = '把 a.txt 读完了（多了两个字）'
    const v = verifySentText(declared, sent)
    assert.equal(v.identical, false)
    assert.match(v.headline, /不一致/)
    assert.match(v.headline, /以\*\*上面那份原文\*\*为准/, '要指明哪一份是可信的（它真收到的那份）')
    // `declared` 是 `sent` 的前缀 ⇒ 不同的位置就是 declared 的末尾之后那一格。
    // 「把 a.txt 读完」= 10 个 JS 字符（汉字算一个），所以是第 11 个字符起不同。
    assert.match(v.headline, /第 11 个字符/, '要指出第一个不同的位置')
  })

  test('★ 长度不同但前缀相同 ⇒ 位置是"较短那一份的末尾"', () => {
    const v = verifySentText('abc', 'abcdef')
    assert.equal(v.identical, false)
    assert.match(v.headline, /第 4 个字符/)
  })

  test('★ 空串对空串算一致（对话首轮可能没有正文）', () => {
    assert.equal(verifySentText('', '').identical, true)
  })
})


/**
 * ★ 第二批：**执行器真的把摘要写进运行日志**（这才是使用者要的那一行）。
 *
 * 前半段量的是"比对函数对不对"，这一半量的是"接线通不通"——
 * 这个仓库最常见的缺陷是"函数写好了、没人调"（死接口）。
 * 用假后端在 `execute` 里主动调 `onRpcFrame`，再从 `GET /api/runs/:id/messages`
 * 把日志读回来：两端都在真链路上。
 */
describe('★ 分批第 44 批：帧摘要真的进了运行日志（不是死接口）', () => {
  test('★★★ 假后端报帧 ⇒ 日志里能看到方法名、耗时、以及"与第一句话逐字相同"', async () => {
    const dataDir = await makeTempDir('rpc-log-data')
    const workRoot = await makeTempDir('rpc-log-work')
    const backend = new RpcShapedBackend()
    const daemon = await startDaemon({
      dataDir,
      workRoot,
      port: 0,
      fsync: false,
      backend,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const runId = `run-rpclog-${String(Date.now())}`
      const created = await fetch(`${daemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a-rpclog', name: '助手', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i-rpclog' },
          prompt: '把 a.txt 读完',
          workDir: workRoot,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(created.status, 202, await created.text())
      for (let i = 0; i < 200; i += 1) {
        const r = (await (await fetch(`${daemon.url}/api/runs/${runId}`)).json()) as { status?: string }
        if (['completed', 'failed', 'cancelled'].includes(r.status ?? '')) break
        await new Promise((res) => setTimeout(res, 25))
      }
      const msgs = (await (await fetch(`${daemon.url}/api/runs/${runId}/messages`)).json()) as {
        messages: Array<{ content: string }>
      }
      const text = msgs.messages.map((m) => m.content).join('\n---\n')
      assert.match(text, /→ initialize/u, `日志里要有出站帧摘要：${text.slice(0, 400)}`)
      assert.match(text, /← initialize 成功/u, '入站也要有（分得清"没回"与"回了错"）')
      assert.match(text, /→ turn\/start/u, 'turn/start 这一帧最关键：它是"内容真的发出去了"的证据')
      assert.match(
        text,
        /逐字相同/u,
        '★ 必须有一行把"日志里的第一句话"与"线上真的发出去的"钉在一起',
      )
      /**
       * ★ 分批第 45 批：**原文本身**必须进日志。
       *
       * 上一批只打了"逐字相同"这一行结论，使用者当场说「我还是没有看到第一个命令
       * 到底是什么给到 codex 的」——结论行是给校对用的，他要的是内容。
       */
      assert.match(text, /===== 发给 CLI 的原文（turn\/start，/u, '原文要带标题打出来')
      assert.match(text, /把 a\.txt 读完/u, '★ 送出去的**那一段正文**要真的在日志里')
    } finally {
      await daemon.close()
      await cleanup(dataDir)
      await cleanup(workRoot)
    }
  })
})
