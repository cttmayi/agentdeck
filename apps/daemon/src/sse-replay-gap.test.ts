/**
 * ★ 分批第 75 批：SSE 的"补历史"与"挂订阅"之间**不许丢事件**。
 *
 * 这个洞一直在（顺序是"先补历史、再挂订阅"），只是很难撞上：窗口是
 * `await store.listRunMessages(...)` 与 `registry.subscribe(...)` 之间的几毫秒。
 * 第 75 批把隔离那条 note 挪到了紧跟"工作目录"之后，于是它正好落进这个窗口——
 * 全量跑时那条 note **十次有十次丢**，而页面与测试都只看到"少了一条日志"，
 * 既不报错也不告警（`e2e.test.ts` 里"日志里要有'隔离未生效'的说明"就是这么红的）。
 *
 * 判据：连着开 SSE 若干次，每次收到的 `seq` 必须是**从 since 开始连续无洞**。
 * 丢一条就说明那段时间里的事件被吞了。
 *
 * ⚠️ 用假后端 + 真 daemon（NFR-T-01）；每轮 run 立刻连流，尽量踩在那个窗口上。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { ulid, type RunId, type RunEvent } from '@agentdeck/protocol'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

class QuietBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true
  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }
  async execute(_opts: ExecOptions): Promise<AgentSession> {
    const queue = new AsyncQueue<AgentMessage>()
    // 稍等一下再说话：让"早期 note 已经落盘、SSE 正在补历史"这个窗口真的出现
    await new Promise((r) => setTimeout(r, 5))
    queue.push({ type: 'text', content: '好。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed' as const,
        output: '好。',
        error: null,
        durationMs: 1,
        sessionId: 's',
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

/** 读整条 SSE 流到结束，返回收到的事件。 */
async function drain(url: string): Promise<RunEvent[]> {
  const res = await fetch(url)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: RunEvent[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
      if (!frame.startsWith('data: ')) continue // 心跳注释
      const parsed = JSON.parse(frame.slice(6)) as RunEvent
      events.push(parsed)
      if (parsed.t === 'terminal') {
        await reader.cancel().catch(() => {})
        return events
      }
    }
  }
  return events
}

describe('★★★ SSE：补历史与挂订阅之间不许丢事件（分批第 75 批）', () => {
  test('★★★ 连开 8 条流：每次收到的 seq 都连续无洞（含最早那几条 note）', async () => {
    const dataDir = await makeTempDir('sse-gap')
    const d = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend: new QuietBackend(),
      // 不给受管目录 ⇒ 隔离跳过（这条用例只关心 SSE 的事件顺序，不关心隔离）
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      for (let round = 0; round < 8; round += 1) {
        const runId = ulid() as RunId
        const created = await fetch(`${d.url}/api/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId,
            kind: 'execute',
            agentRef: { id: 'a-sse', name: '助手', instructions: '' },
            skills: [],
            subject: { type: 'issue', id: `i-sse-${String(round)}` },
            prompt: '干活',
            limits: { maxTurns: null, timeoutMs: null },
          }),
        })
        assert.equal(created.status, 202, await created.text())

        // ⚠️ 立刻连流：这一刻 daemon 正在写最早的几条 note（工作目录等），
        //    正是"补历史 ↔ 挂订阅"那个窗口最容易露出丢事件的时刻。
        const events = await drain(`${d.url}/api/runs/${runId}/events`)
        const seqs = events.map((e) => e.seq).sort((a, b) => a - b)
        const unique = [...new Set(seqs)]
        assert.equal(unique.length, seqs.length, `第 ${String(round)} 轮有重复事件：${seqs.join(',')}`)
        for (let i = 0; i < unique.length; i += 1) {
          assert.equal(
            unique[i],
            i,
            `第 ${String(round)} 轮 seq 有洞（丢了事件）：${unique.join(',')}`,
          )
        }
        // 再钉一条具体的：最早那条 note（工作目录）必须在
        assert.ok(
          events.some((e) => e.t === 'message' && e.message.content.startsWith('工作目录')),
          `第 ${String(round)} 轮没收到最早的"工作目录"那条 note：${JSON.stringify(events.slice(0, 3))}`,
        )
      }
    } finally {
      await d.close()
      await cleanup(dataDir)
    }
  })
})
