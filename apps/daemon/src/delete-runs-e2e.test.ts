import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import type { Action, Artifact, Conversation, Run, VerdictRecord } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * DELETE /api/runs/:id（任务列表每项右侧的「删除」按钮）端到端。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么数据用 store 直写、不走 POST /api/runs
 * ══════════════════════════════════════════════════════════════════
 *
 * 删除路由关心的是"删得对不对"，不是"run 是怎么跑出来的"。终态 run 用
 * `handle.store` 直写（与 loop-closure.test.ts 同一套做法），HTTP 层只走
 * DELETE 与 GET——两条都验证了：删除成功（200 + 之后 GET 404）与删除的
 * 连带（对话轮次消失、turnCount 重算）。
 *
 * 连带范围本身（verdict/action/artifact/messages、审计保留）由 store 层
 * 的单元测试钉住（file-store.test.ts / sqlite-store.test.ts），这里不重复。
 */

/** 最小假后端：启动需要它，但本文件不投递任何 run。 */
class NullBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '好。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '好。',
        durationMs: 1,
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

let daemon: DaemonHandle
let dataDir: string

/** server 侧的 workspaceId = 第一个 workspace（`bootstrap`），运行时取它。 */
let WS: Run['workspaceId']

/** 造一条终态 run（直接进 store，不走 HTTP 投递）。 */
async function putTerminalRun(id: string): Promise<Run> {
  const now = Date.now()
  const run: Run = {
    id: id as Run['id'],
    workspaceId: WS,
    kind: 'execute',
    status: 'completed',
    agentId: 'agent-x' as Run['agentId'],
    subject: { type: 'issue', id: 'issue-1' as never },
    trigger: 'assignment',
    derivedFrom: null,
    chainDepth: 0,
    skillRefs: [],
    workDir: null,
    waitReason: null,
    sessionId: null,
    attempt: 1,
    maxAttempts: 2,
    failureReason: null,
    usage: null,
    queuedAt: now,
    dispatchedAt: now,
    startedAt: now,
    finishedAt: now,
  }
  await daemon.store.insertRun(run)
  return run
}

before(async () => {
  dataDir = await makeTempDir('delete-runs')
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend: new NullBackend(),
    onWarn: () => {},
    onInfo: () => {},
  })
  // 取 daemon 自举出来的那个默认 workspace（server 对所有请求都认它）
  WS = (await daemon.store.listWorkspaceIds())[0] as Run['workspaceId']
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
})

async function del(url: string): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  const res = await fetch(`${daemon.url}${url}`, { method: 'DELETE' })
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } }
}

describe('DELETE /api/runs/:id', () => {
  test('★ 删一条终态 run：200，再 GET 就是 404', async () => {
    await putTerminalRun('r-del-1')
    const res = await del('/api/runs/r-del-1')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })

    const gone = await fetch(`${daemon.url}/api/runs/r-del-1`)
    assert.equal(gone.status, 404)
  })

  test('★ 别的 workspace 的 run 一律当"不存在"（404，不是 403）', async () => {
    const now = Date.now()
    await daemon.store.insertRun({
      id: 'r-other-ws' as Run['id'],
      workspaceId: 'ws_other' as Run['workspaceId'],
      kind: 'execute',
      status: 'completed',
      agentId: 'agent-x' as Run['agentId'],
      subject: { type: 'issue', id: 'i' as never },
      trigger: 'assignment',
      derivedFrom: null,
      chainDepth: 0,
      skillRefs: [],
      workDir: null,
      waitReason: null,
      sessionId: null,
      attempt: 1,
      maxAttempts: 2,
      failureReason: null,
      usage: null,
      queuedAt: now,
      dispatchedAt: now,
      startedAt: now,
      finishedAt: now,
    })
    const res = await del('/api/runs/r-other-ws')
    assert.equal(res.status, 404)
    // 那条 run 还在（只是"看不见"）
    assert.ok(await daemon.store.getRun('r-other-ws' as Run['id']))
  })

  test('★ 运行中的 run 不能删：409 且原文提示先取消', async () => {
    const now = Date.now()
    await daemon.store.insertRun({
      id: 'r-running' as Run['id'],
      workspaceId: WS,
      kind: 'execute',
      status: 'running',
      agentId: 'agent-x' as Run['agentId'],
      subject: { type: 'issue', id: 'i' as never },
      trigger: 'assignment',
      derivedFrom: null,
      chainDepth: 0,
      skillRefs: [],
      workDir: null,
      waitReason: null,
      sessionId: null,
      attempt: 1,
      maxAttempts: 2,
      failureReason: null,
      usage: null,
      queuedAt: now,
      dispatchedAt: now,
      startedAt: now,
      finishedAt: null,
    })
    const res = await del('/api/runs/r-running')
    assert.equal(res.status, 409)
    assert.match(res.body.error ?? '', /还在执行中/)
    // run 安然无恙
    assert.ok(await daemon.store.getRun('r-running' as Run['id']))
  })

  test('★ 删除会连带删掉引用它的对话轮次，turnCount 重算（回看时看不到半条）', async () => {
    const run = await putTerminalRun('r-del-chat')
    const convId = 'c-del' as Conversation['id']
    await daemon.store.insertConversation({
      id: convId,
      workspaceId: WS,
      agentId: run.agentId,
      skillIds: [],
      title: '删除测试对话',
      workDir: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastTurnAt: Date.now(),
      turnCount: 2,
    })
    await daemon.store.insertChatTurn({
      id: 't-del-1' as never,
      workspaceId: WS,
      conversationId: convId,
      seq: 1,
      userText: '第一轮（引用被删的 run）',
      runId: run.id,
      createdAt: Date.now(),
      error: null,
    })
    await daemon.store.insertChatTurn({
      id: 't-del-2' as never,
      workspaceId: WS,
      conversationId: convId,
      seq: 2,
      userText: '第二轮（不引用）',
      runId: null,
      createdAt: Date.now(),
      error: null,
    })

    const res = await del('/api/runs/r-del-chat')
    assert.equal(res.status, 200)

    // 回看这个对话：引用被删 run 的那一轮没了，剩第二轮；turnCount 也更新了
    const detail = await fetch(`${daemon.url}/api/conversations/${convId}`)
    assert.equal(detail.status, 200)
    const body = (await detail.json()) as {
      conversation: { turnCount: number }
      turns: Array<{ seq: number; userText: string; runId: string | null }>
    }
    assert.equal(body.conversation.turnCount, 1)
    assert.deepEqual(
      body.turns.map((t) => t.seq),
      [2],
    )
    assert.equal(body.turns[0]!.runId, null)
  })
})

describe('DELETE /api/issues/:id', () => {
  test('★ 删任务：200，issue 没了，它名下的 run（含审核链）与评论一起没了', async () => {
    // 任务 + 评论
    await daemon.store.insertIssue({
      id: 'i-del' as never,
      workspaceId: WS,
      title: '要删的任务',
      description: '',
      status: 'todo',
      assignee: null,
      labels: [],
      priority: 'none',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await daemon.store.insertComment({
      id: 'c-del' as never,
      workspaceId: WS,
      issueId: 'i-del' as never,
      authorType: 'member' as const,
      authorId: 'me',
      type: 'comment' as const,
      content: '评论',
      createdAt: Date.now(),
    })
    // 执行 run + 审核 run
    const now = Date.now()
    await daemon.store.insertRun({
      id: 'r-iexec' as Run['id'],
      workspaceId: WS,
      kind: 'execute',
      status: 'completed',
      agentId: 'agent-x' as Run['agentId'],
      subject: { type: 'issue', id: 'i-del' },
      trigger: 'assignment',
      derivedFrom: null,
      chainDepth: 0,
      skillRefs: [],
      workDir: null,
      waitReason: null,
      sessionId: null,
      attempt: 1,
      maxAttempts: 2,
      failureReason: null,
      usage: null,
      queuedAt: now,
      dispatchedAt: now,
      startedAt: now,
      finishedAt: now,
    })
    await daemon.store.insertRun({
      id: 'r-ireview' as Run['id'],
      workspaceId: WS,
      kind: 'review',
      status: 'completed',
      agentId: 'agent-x' as Run['agentId'],
      subject: { type: 'run', id: 'r-iexec' },
      trigger: 'assignment',
      derivedFrom: null,
      chainDepth: 0,
      skillRefs: [],
      workDir: null,
      waitReason: null,
      sessionId: null,
      attempt: 1,
      maxAttempts: 2,
      failureReason: null,
      usage: null,
      queuedAt: now,
      dispatchedAt: now,
      startedAt: now,
      finishedAt: now,
    })

    const res = await del('/api/issues/i-del')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })

    assert.equal(await daemon.store.getIssue('i-del' as never), null)
    assert.deepEqual(await daemon.store.listComments('i-del' as never), [])
    assert.equal(await daemon.store.getRun('r-iexec' as Run['id']), null)
    assert.equal(await daemon.store.getRun('r-ireview' as Run['id']), null)
  })

  test('★ 别的 workspace 的任务一律当"不存在"（404）', async () => {
    await daemon.store.insertIssue({
      id: 'i-other' as never,
      workspaceId: 'ws_other' as never,
      title: '别的空间的任务',
      description: '',
      status: 'todo',
      assignee: null,
      labels: [],
      priority: 'none',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const res = await del('/api/issues/i-other')
    assert.equal(res.status, 404)
    assert.ok(await daemon.store.getIssue('i-other' as never))
  })
})
