import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { startDaemon, type DaemonHandle } from './server.ts'
import { WORKFLOW_DRAFT_DIR, WORKFLOW_DRAFT_FILE } from './workflow-maker.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 编排生成者的**接口层牙齿**（D135）：读草稿 / 采纳两道口，以及它们各自的拒绝。
 *
 * 为什么要走 HTTP 而不是只在模块层测：模块层（`workflow-maker.test.ts`）只保证
 * "解析得对、校验得对"。真正会出事的是**入口**——一个不是生成者的对话能不能把
 * 一份草稿变成编排、语法错的代码能不能被采纳、引用了不存在智能体的代码能不能
 * 被采纳。这三件事都发生在路由里，使用者的表现也在这里（"按钮点了之后报什么"）。
 *
 * ⚠️ 假后端（NFR-T-01）：不碰任何真实 CLI。真机上草稿是生成者在聊天里写的，
 *    这里由夹具在 execute 时写进工作目录——两条路落在同一个位置，所以"按钮出现
 *    条件"与"采纳时读哪个文件"都被真实地走了一遍。
 */

const AGENT_NAME = '记账员'

/** 假后端：把草稿写进这次 run 的工作目录（真机上这一步是编排生成者干的）。 */
class DraftWritingBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 下一次 execute 要不要写草稿（写什么由 `draft` 决定）。 */
  writeDraft = false
  draft = ''
  seen: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seen.push(opts.prompt)
    if (this.writeDraft && (opts.workDir ?? '') !== '') {
      const dir = join(opts.workDir!, WORKFLOW_DRAFT_DIR)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, WORKFLOW_DRAFT_FILE), this.draft, 'utf8')
      // 写完就关掉：后续（编排运行那几次 run）不许再改写它
      this.writeDraft = false
    }
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '好了。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '好了。',
        durationMs: 2,
        sessionId: 'wf-maker-session',
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

let dataDir: string
let daemon: DaemonHandle
let backend: DraftWritingBackend
let makerId: string
let otherAgentId: string

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

async function waitForTerminal(runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { body } = await json(`/api/runs/${runId}`)
    const status = (body as { status?: string } | null)?.status
    if (status !== undefined && ['completed', 'failed', 'cancelled'].includes(status)) return
    if (Date.now() > deadline) throw new Error(`run ${runId} 一直没到终态`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function waitForWorkflowRun(
  runId: string,
  timeoutMs = 15000,
): Promise<{ status: string; steps: Array<{ status: string }> }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { body } = await json(`/api/workflow-runs/${runId}`)
    const run = (body as { run?: { status: string; steps: Array<{ status: string }> } }).run
    if (run && ['done', 'failed', 'cancelled'].includes(run.status)) return run
    if (Date.now() > deadline) throw new Error(`编排运行 ${runId} 一直没到终态`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 起一条对话（用假后端把那一轮跑完），返回对话 id 与工作目录。 */
async function openConversation(agentId: string): Promise<{ convId: string; workDir: string }> {
  const created = await postJson('/api/conversations', { agentId, text: '帮我编排一段流程' })
  assert.equal(created.status, 201, `建对话失败：${JSON.stringify(created.body)}`)
  const body = created.body as { conversation: { id: string }; turn: { runId: string } }
  await waitForTerminal(body.turn.runId)
  const detail = await json(`/api/conversations/${body.conversation.id}`)
  const workDir = (detail.body as { workDir?: string | null }).workDir
  assert.ok(workDir, '对话必须有一个工作目录（草稿就落在它下面）')
  return { convId: body.conversation.id, workDir: workDir! }
}

before(async () => {
  dataDir = await makeTempDir('workflow-maker-routes')
  backend = new DraftWritingBackend()
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })
  /*
   * ★ 2026-11（D154）：认人改成读接口算好发下来的 `slot`（记录上不再有 `builtinKind`）。
   */
  const agents = (await json('/api/agents')).body as {
    agents: Array<{ id: string; name: string; slot?: string | null }>
  }
  const maker = agents.agents.find((a) => a.slot === 'workflow-maker')
  assert.ok(maker, '启动之后必须有一条内置「编排生成者」')
  makerId = maker!.id
  // 编排代码里 `agent('记账员')` 要能找到一个真人（节点名校验就是查这个名字）
  const made = await postJson('/api/agents', { name: AGENT_NAME, instructions: '你记账。' })
  assert.equal(made.status, 201, `建智能体失败：${JSON.stringify(made.body)}`)
  // ⚠️ 这条接口直接返回 agent 本身（不是 `{ agent }`）
  otherAgentId = (made.body as { id: string }).id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
})

describe('启动：内置「编排生成者」在，而且**能聊天**', () => {
  test('★ 能建对话（不是 agent_builtin_no_chat）——这条岗位的活就是在聊天里问清楚', async () => {
    const created = await postJson('/api/conversations', { agentId: makerId, text: '我想做个周报流程' })
    assert.equal(created.status, 201, `编排生成者必须能聊天：${JSON.stringify(created.body)}`)
    const runId = (created.body as { turn: { runId: string } }).turn.runId
    await waitForTerminal(runId)
  })
})

describe('读草稿：没有就是没有，有就读出来', () => {
  test('★ 还没有草稿 ⇒ hasWorkflowDraft=false，GET 404 workflow_draft_missing（按钮按它出不出来）', async () => {
    const { convId } = await openConversation(makerId)
    const detail = await json(`/api/conversations/${convId}`)
    assert.equal((detail.body as { hasWorkflowDraft?: boolean }).hasWorkflowDraft, false)
    const draft = await json(`/api/conversations/${convId}/workflow-draft`)
    assert.equal(draft.status, 404)
    assert.equal((draft.body as { code?: string }).code, 'workflow_draft_missing')
    // 与岗位卡那条同构：两个标记各自独立，互不串味
    assert.equal((detail.body as { hasAgentDraft?: boolean }).hasAgentDraft, false)
  })

  test('★★ 生成者写完草稿 ⇒ hasWorkflowDraft 翻 true，GET 给出 name/summary/code（围栏剥掉）', async () => {
    const { convId } = await openConversation(makerId)
    backend.draft =
      '---\nname: 记账流水线\nsummary: 两天一次对账\n---\n\n```js\n' +
      `await flow([agent('${AGENT_NAME}')], '{{task}}')\n` +
      '```\n'
    backend.writeDraft = true
    // 再说一句话让假后端把草稿落到这个对话的工作目录里
    const turn = await postJson(`/api/conversations/${convId}/turns`, { text: '写草稿吧' })
    // ⚠️ 追加一轮是 **202**（与新建对话的 201 不同）：那一轮是后台跑的
    assert.equal(turn.status, 202, `发消息失败：${JSON.stringify(turn.body)}`)
    await waitForTerminal((turn.body as { turn: { runId: string } }).turn.runId)

    const detail = await json(`/api/conversations/${convId}`)
    assert.equal((detail.body as { hasWorkflowDraft?: boolean }).hasWorkflowDraft, true)

    const draft = await json(`/api/conversations/${convId}/workflow-draft`)
    assert.equal(draft.status, 200)
    const parsed = draft.body as {
      workflowDraft: string
      name: string
      summary: string
      code: string
      parseError: string | null
    }
    assert.equal(parsed.parseError, null)
    assert.equal(parsed.name, '记账流水线')
    assert.equal(parsed.summary, '两天一次对账')
    assert.ok(
      parsed.code.startsWith('await flow('),
      `代码要剥掉 \`\`\`js 围栏：${JSON.stringify(parsed.code.slice(0, 20))}`,
    )
    assert.ok(!parsed.code.includes('```'), '围栏不许留在代码里（留着就是语法错）')
    assert.ok(parsed.workflowDraft.includes('name: 记账流水线'), '原文也要如实带出去（人可能还要改）')
  })

  test('★ 草稿写坏了 ⇒ GET 仍然 200，但 parseError 说得出哪里不对（界面据此报错，不猜）', async () => {
    const { convId, workDir } = await openConversation(makerId)
    await mkdir(join(workDir, WORKFLOW_DRAFT_DIR), { recursive: true })
    await writeFile(join(workDir, WORKFLOW_DRAFT_DIR, WORKFLOW_DRAFT_FILE), '没有 frontmatter', 'utf8')

    const detail = await json(`/api/conversations/${convId}`)
    assert.equal((detail.body as { hasWorkflowDraft?: boolean }).hasWorkflowDraft, true, '文件在 = 按钮出现')
    const draft = await json(`/api/conversations/${convId}/workflow-draft`)
    assert.equal(draft.status, 200)
    const body = draft.body as { parseError: string | null; code: string; name: string }
    assert.ok(body.parseError, '坏草稿要带出 parseError')
    assert.equal(body.code, '')
    assert.equal(body.name, '')
  })
})

describe('采纳：校验三道（语法 / 节点名 / 名字）', () => {
  const goodDraft = `---
name: 记账流水线
summary: 两天一次对账
---

await flow([agent('${AGENT_NAME}')], '{{task}}')
`

  test('★ 正常草稿 ⇒ 201，source=ai，代码原样落库，能查出详情', async () => {
    const { convId } = await openConversation(makerId)
    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft: goodDraft,
    })
    assert.equal(res.status, 201, `采纳失败：${JSON.stringify(res.body)}`)
    const out = res.body as {
      workflow: { id: string; name: string; code: string; source: string }
      unverifiable: number
    }
    assert.equal(out.workflow.name, '记账流水线')
    assert.equal(out.workflow.source, 'ai', '采纳是 `source: ai` 唯一的生产者')
    assert.equal(out.workflow.code, `await flow([agent('${AGENT_NAME}')], '{{task}}')`, '代码不许被改写')
    assert.equal(out.unverifiable, 0, '全是字面量名字 ⇒ 没有数不清的引用')

    // 写动作成功后界面要重拉列表 ⇒ 列表里必须有它
    const list = (await json('/api/workflows')).body as {
      items: Array<{ id: string; source: string }>
    }
    assert.ok(list.items.some((w) => w.id === out.workflow.id && w.source === 'ai'))
    const detail = await json(`/api/workflows/${out.workflow.id}`)
    assert.equal((detail.body as { workflow: { name: string } }).workflow.name, '记账流水线')
  })

  test('★★ 采纳的代码**真能跑起来**（采纳校验与引擎用同一条构造路径，这里实测一遍）', async () => {
    const { convId } = await openConversation(makerId)
    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft: goodDraft,
    })
    assert.equal(res.status, 201)
    const wfId = (res.body as { workflow: { id: string } }).workflow.id

    const launched = await postJson(`/api/workflows/${wfId}/run`, { prompt: '对一下这两天的账' })
    assert.equal(launched.status, 201, `发起运行失败：${JSON.stringify(launched.body)}`)
    const runId = (launched.body as { run: { id: string } }).run.id
    const run = await waitForWorkflowRun(runId)
    assert.equal(run.status, 'done', '采纳的编排要能跑完（不是只过校验）')
    assert.ok(run.steps.length > 0, '至少一步')
    assert.ok(
      run.steps.every((s) => s.status === 'done'),
      `每一步都要完成：${JSON.stringify(run.steps.map((s) => s.status))}`,
    )
  })

  test('★ 坏草稿 ⇒ 400 workflow_draft_invalid（说得出哪里不对）', async () => {
    const { convId } = await openConversation(makerId)
    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft: '没有 frontmatter 的一段代码',
    })
    assert.equal(res.status, 400)
    assert.equal((res.body as { code?: string }).code, 'workflow_draft_invalid')
  })

  test('★ 语法错 ⇒ 400 workflow_code_syntax（不当成"能跑但会挂"放过去）', async () => {
    const { convId } = await openConversation(makerId)
    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft: '---\nname: 坏的\n---\nawait flow([',
    })
    assert.equal(res.status, 400)
    assert.equal((res.body as { code?: string }).code, 'workflow_code_syntax')
  })

  test('★★ 引用了不存在的智能体 ⇒ 400 workflow_code_unknown_agent + 点名是谁', async () => {
    const { convId } = await openConversation(makerId)
    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft: `---\nname: 缺人\n---\nawait flow([agent('查无此人')], '{{task}}')`,
    })
    assert.equal(res.status, 400)
    const body = res.body as { code?: string; unknownAgents?: string[] }
    assert.equal(body.code, 'workflow_code_unknown_agent')
    assert.deepEqual(body.unknownAgents, ['查无此人'], '要点名，不能只说"有人不存在"')
  })

  test('★ 空草稿 ⇒ 400 workflow_draft_required', async () => {
    const { convId } = await openConversation(makerId)
    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft: '   ',
    })
    assert.equal(res.status, 400)
    assert.equal((res.body as { code?: string }).code, 'workflow_draft_required')
  })

  test('★★ 不是编排生成者的对话 ⇒ 400 workflow_commit_not_maker（不替别人的草稿背书）', async () => {
    const { convId, workDir } = await openConversation(otherAgentId)
    // 就算把草稿摆进它的工作目录，这条接口也不认
    await mkdir(join(workDir, WORKFLOW_DRAFT_DIR), { recursive: true })
    await writeFile(join(workDir, WORKFLOW_DRAFT_DIR, WORKFLOW_DRAFT_FILE), goodDraft, 'utf8')

    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft: goodDraft,
    })
    assert.equal(res.status, 400)
    assert.equal((res.body as { code?: string }).code, 'workflow_commit_not_maker')
  })

  test('★ 对话不存在 ⇒ 404（两条都拒绝，不是 500）', async () => {
    const draft = await json('/api/conversations/不存在/workflow-draft')
    assert.equal(draft.status, 404)
    const commit = await postJson('/api/conversations/不存在/workflow-commit', {
      workflowDraft: goodDraft,
    })
    assert.equal(commit.status, 404)
  })

  test('★ 拼出来的引用（agent(变量)）不拒绝，但如实报 unverifiable', async () => {
    const { convId } = await openConversation(makerId)
    const res = await postJson(`/api/conversations/${convId}/workflow-commit`, {
      workflowDraft:
        '---\nname: 拼名字\n---\n' +
        `const 名单 = ['${AGENT_NAME}']\n` +
        'await parallel(名单.map((n) => agent(n)), "{{task}}")',
    })
    assert.equal(res.status, 201, `拼出来的引用要放行：${JSON.stringify(res.body)}`)
    assert.equal((res.body as { unverifiable: number }).unverifiable, 1)
  })
})

/*
 * ⚠️ 2026-11（D164）：这里原来有一条"造两条同名智能体 ⇒ 采纳时 400 `workflow_code_ambiguous`"。
 *   **D164 起新建/改名都会查重**，所以"两条同名"再也造不出来了——这条用例的对象消失了。
 *   检测本身（重名 ⇒ 歧义）仍由 `workflow-agents.test.ts` 的单元用例钉着；老数据里的重名
 *   （升级之前就有的）仍会在采纳与运行时被拦，走的是同一条 `resolveWorkflowAgent()`。
 */
