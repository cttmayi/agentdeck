/**
 * crystallize（D80）素材打包与目标面板信息的单元测试。
 *
 * 用真 FileStore（临时目录）+ 夹具，不碰任何 CLI（NFR-T-01）。
 * 覆盖：
 *   · targets：conversation 场景的加载 skill（执行者挂的 ∪ 对话额外带的）；
 *     task 场景的 reviewed 判定（有 completed 审核 run 才算）。
 *   · material：conversation 多轮拼接（保留工具调用）；task 附审核判决 + 用户反馈。
 *   · draft prompt：含作用描述 / 现有 SKILL.md 基线 / 不结晶清单 / 现有技能列表。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FileStore } from '@agentdeck/store-file'
import {
  makeAgent,
  makeRun,
  makeSkill,
  wsId,
} from '@agentdeck/domain/testing'
import type { Agent, Run } from '@agentdeck/protocol'
import { buildDraftPrompt, buildMaterial, crystallizeTargets } from './crystallize.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string
let store: FileStore

const WS = wsId('ws-crystal')

before(async () => {
  dir = await makeTempDir('crystallize')
  store = await FileStore.open({ dataDir: dir, fsync: false })
  await store.insertWorkspace({
    executeTemplate: '',
    reviewTemplate: '',
    chatTemplate: '',
    defaultAgentId: null,
    locale: 'zh',
    id: WS,
    name: 'w',
    createdAt: 1,
    updatedAt: 1,
  })
})

after(async () => {
  await store.close()
  await cleanup(dir)
})

/** 往 store 里放一条 run 和它的消息，返回 run。 */
async function seedRun(
  over: Omit<Partial<Run>, 'id' | 'agentId'> & { id: string; agentId: string },
): Promise<Run> {
  const run = makeRun(over)
  await store.insertRun(run)
  return run
}

async function appendMessage(runId: string, m: { type: 'text' | 'tool_use' | 'tool_result' | 'status' | 'thinking' | 'error' | 'log'; content?: string; tool?: string | null; input?: Record<string, unknown> | null; output?: string | null }): Promise<void> {
  const messages = await store.listRunMessages(runId as never)
  const seq = messages.length + 1
  await store.appendRunMessage(runId as never, {
    seq,
    type: m.type,
    tool: m.tool ?? null,
    content: m.content ?? '',
    input: m.input ?? null,
    output: m.output ?? null,
    outputTruncated: false,
    at: Date.now(),
  })
}

async function seedAgent(over: Omit<Partial<Agent>, 'id'> & { id: string }): Promise<Agent> {
  const agent = makeAgent({ ...over, workspaceId: WS })
  await store.insertAgent(agent)
  return agent
}

describe('crystallizeTargets：目标面板信息', () => {
  test('conversation：加载 skill = 执行者挂的 ∪ 对话额外带的', async () => {
    const mine = makeSkill({ id: 'm1', workspaceId: WS, slug: 'my-flow', source: 'mine' })
    const installed = makeSkill({ id: 'i1', workspaceId: WS, slug: 'general-review', source: 'remote' })
    await store.insertSkill(mine)
    await store.insertSkill(installed)

    const agent = await seedAgent({ id: 'exec1', skillIds: [mine.id] })
    // 对话（conversation subject）：agent 挂 mine，对话额外带 installed
    const conversationId = 'conv-1'
    await store.insertConversation({
      id: conversationId as never,
      workspaceId: WS,
      agentId: agent.id,
      skillIds: [installed.id],
      title: '对话一',
      workDir: null,
      createdAt: 1,
      updatedAt: 1,
      lastTurnAt: null,
      turnCount: 1,
    })
    const run = await seedRun({
      id: 'run-conv',
      agentId: agent.id as string,
      subject: { type: 'conversation', id: conversationId },
    })
    const targets = await crystallizeTargets(store, run)
    assert.equal(targets.scope, 'conversation')
    const slugs = targets.loadedSkills.map((s) => s.slug).sort()
    assert.deepEqual(slugs, ['general-review', 'my-flow'], '执行者挂的 ∪ 对话带的')
    const mineEntry = targets.loadedSkills.find((s) => s.slug === 'my-flow')
    assert.equal(mineEntry?.source, 'mine', '提炼的来源如实带出（可进化）')
    assert.equal(targets.reviewed, false, '聊天没有审核')
    assert.equal(targets.materialStats, null, '没有消息 = 素材为空（早失败判据）')
    assert.equal(targets.activeDraft, null, '还没有起草过')
  })

  test('conversation：素材统计起草前可见；activeDraft 按会话全部轮次匹配', async () => {
    const agent = await seedAgent({ id: 'exec1b' })
    const conversationId = 'conv-1b'
    await store.insertConversation({
      id: conversationId as never,
      workspaceId: WS,
      agentId: agent.id,
      skillIds: [],
      title: '对话一b',
      workDir: null,
      createdAt: 1,
      updatedAt: 1,
      lastTurnAt: null,
      turnCount: 2,
    })
    await store.insertChatTurn({
      id: 'turn-b1' as never,
      workspaceId: WS,
      conversationId: conversationId as never,
      seq: 1,
      userText: '第一步',
      runId: 'run-conv-b1' as never,
      createdAt: 1,
      error: null,
    })
    await store.insertChatTurn({
      id: 'turn-b2' as never,
      workspaceId: WS,
      conversationId: conversationId as never,
      seq: 2,
      userText: '第二步',
      runId: 'run-conv-b2' as never,
      createdAt: 2,
      error: null,
    })
    await seedRun({ id: 'run-conv-b1', agentId: agent.id as string, subject: { type: 'conversation', id: conversationId } })
    await seedRun({ id: 'run-conv-b2', agentId: agent.id as string, subject: { type: 'conversation', id: conversationId } })
    await appendMessage('run-conv-b1', { type: 'text', content: '做 A' })
    await appendMessage('run-conv-b1', { type: 'tool_use', tool: 'Bash' })

    // 草稿从**另一轮**（run-conv-b1）发起——用 run-conv-b2 打开流程页也要能找回
    const draft = makeRun({
      id: 'draft-b1',
      agentId: agent.id as string,
      kind: 'execute',
      subject: { type: 'skill-draft', id: 'draft-b1', sourceRunId: 'run-conv-b1' },
      crystallizeTarget: { kind: 'new' },
    })
    await store.insertRun(draft)

    const runB2 = await store.getRun('run-conv-b2' as never)
    const targets = await crystallizeTargets(store, runB2!)
    assert.deepEqual(targets.materialStats, { turns: 2, toolCalls: 1 }, '起草前就显示素材统计')
    assert.deepEqual(
      targets.activeDraft,
      { runId: 'draft-b1', status: draft.status, target: { kind: 'new' } },
      '跨轮次找回进行中的草稿，带目标',
    )
  })

  test('task：activeDraft = 最近一条未入库的 skill-draft run（已入库的跳过）', async () => {
    const agent = await seedAgent({ id: 'exec2' })
    const taskRun = await seedRun({
      id: 'run-task',
      agentId: agent.id as string,
      subject: { type: 'issue', id: 'issue-1' },
    })
    const targets1 = await crystallizeTargets(store, taskRun)
    assert.equal(targets1.scope, 'task')
    assert.equal(targets1.reviewed, false, '还没有审核 run')
    assert.equal(targets1.activeDraft, null, '还没有起草')

    // 加一条 completed 的审核 run（subject 指向任务 run）
    const reviewRun = makeRun({
      id: 'run-review',
      agentId: agent.id as string,
      kind: 'review',
      status: 'completed',
      subject: { type: 'run', id: taskRun.id as string },
    })
    await store.insertRun(reviewRun)
    const targets2 = await crystallizeTargets(store, taskRun)
    assert.equal(targets2.reviewed, true, '审核过 ⇒ reviewed')

    // 未完成的审核 run 不算
    const pendingRun = makeRun({
      id: 'run-review-pending',
      agentId: agent.id as string,
      kind: 'review',
      status: 'running',
      subject: { type: 'run', id: taskRun.id as string },
    })
    await store.insertRun(pendingRun)
    const targets3 = await crystallizeTargets(store, taskRun)
    assert.equal(targets3.reviewed, true, '已完成的那条仍然成立')
  })

  test('task：activeDraft 的恢复语义（起草中 / 已完成待审阅 / 已入库跳过 / 最近优先）', async () => {
    const agent = await seedAgent({ id: 'exec2b' })
    const taskRun = await seedRun({
      id: 'run-task2b',
      agentId: agent.id as string,
      subject: { type: 'issue', id: 'issue-2b' },
    })
    await appendMessage('run-task2b', { type: 'text', content: '有内容' })

    // ① 起草中（非终态）→ 找回（带起草时落库的目标）
    const running = makeRun({
      id: 'draft-running',
      agentId: agent.id as string,
      kind: 'execute',
      status: 'running',
      subject: { type: 'skill-draft', id: 'draft-running', sourceRunId: 'run-task2b' },
      crystallizeTarget: { kind: 'new' },
      queuedAt: 100,
    })
    await store.insertRun(running)
    let t = await crystallizeTargets(store, taskRun)
    assert.deepEqual(t.activeDraft, { runId: 'draft-running', status: 'running', target: { kind: 'new' } })

    // ② 已入库（crystallized）→ 跳过
    await store.insertRun({ ...running, crystallized: true })
    t = await crystallizeTargets(store, taskRun)
    assert.equal(t.activeDraft, null, '已入库的草稿不恢复')

    // ③ 已完成待审阅 + 更新的起草中 → 取最近（queuedAt 大）
    const completed = makeRun({
      id: 'draft-completed',
      agentId: agent.id as string,
      kind: 'execute',
      status: 'completed',
      subject: { type: 'skill-draft', id: 'draft-completed', sourceRunId: 'run-task2b' },
      crystallizeTarget: { kind: 'new' },
      queuedAt: 200,
    })
    await store.insertRun(completed)
    const newer = makeRun({
      id: 'draft-newer',
      agentId: agent.id as string,
      kind: 'execute',
      status: 'running',
      subject: { type: 'skill-draft', id: 'draft-newer', sourceRunId: 'run-task2b' },
      crystallizeTarget: { kind: 'update', skillId: 's1' },
      queuedAt: 300,
    })
    await store.insertRun(newer)
    t = await crystallizeTargets(store, taskRun)
    assert.deepEqual(
      t.activeDraft,
      { runId: 'draft-newer', status: 'running', target: { kind: 'update', skillId: 's1' } },
      '取最近一条，目标随行',
    )
  })
})

describe('buildMaterial：素材打包', () => {
  test('conversation：多轮拼接，保留工具调用与结果', async () => {
    const agent = await seedAgent({ id: 'exec3' })
    await store.insertConversation({
      id: 'conv-2' as never,
      workspaceId: WS,
      agentId: agent.id,
      skillIds: [],
      title: '对话二',
      workDir: null,
      createdAt: 1,
      updatedAt: 1,
      lastTurnAt: null,
      turnCount: 2,
    })
    await store.insertChatTurn({
      id: 'turn-1' as never,
      workspaceId: WS,
      conversationId: 'conv-2' as never,
      seq: 1,
      userText: '帮我打包这个脚本',
      runId: 'run-t1' as never,
      createdAt: 1,
      error: null,
    })
    await store.insertChatTurn({
      id: 'turn-2' as never,
      workspaceId: WS,
      conversationId: 'conv-2' as never,
      seq: 2,
      userText: '加个参数',
      runId: 'run-t2' as never,
      createdAt: 2,
      error: null,
    })
    await seedRun({ id: 'run-t1', agentId: agent.id as string, subject: { type: 'conversation', id: 'conv-2' } })
    await seedRun({ id: 'run-t2', agentId: agent.id as string, subject: { type: 'conversation', id: 'conv-2' } })
    await appendMessage('run-t1', { type: 'text', content: '先看文件' })
    await appendMessage('run-t1', { type: 'tool_use', tool: 'Bash', input: { command: 'ls' } })
    await appendMessage('run-t1', { type: 'tool_result', content: 'a.sh b.sh' })
    await appendMessage('run-t2', { type: 'text', content: '用 tar 打包' })

    const run = await store.getRun('run-t2' as never)
    const material = await buildMaterial(store, run!)
    assert.equal(material.stats.turns, 2, '两轮都进素材')
    assert.equal(material.stats.toolCalls, 1, '工具调用计数')
    assert.match(material.text, /第 1 轮｜使用者说：帮我打包这个脚本/)
    assert.match(material.text, /\[工具调用\] Bash/)
    assert.match(material.text, /\[工具结果\] a\.sh b\.sh/, '工具结果原样保留')
    assert.match(material.text, /第 2 轮｜使用者说：加个参数/)
  })

  test('task：附审核判决 + 用户反馈', async () => {
    const agent = await seedAgent({ id: 'exec4' })
    const taskRun = await seedRun({
      id: 'run-task2',
      agentId: agent.id as string,
      subject: { type: 'issue', id: 'issue-2' },
    })
    await appendMessage('run-task2', { type: 'text', content: '产出报告' })
    const reviewRun = makeRun({
      id: 'run-review2',
      agentId: agent.id as string,
      kind: 'review',
      status: 'completed',
      subject: { type: 'run', id: taskRun.id as string },
    })
    await store.insertRun(reviewRun)
    await appendMessage('run-review2', { type: 'text', content: '结论：fail\n理由码：no_evidence' })

    const material = await buildMaterial(store, taskRun, '第 3 步不对，应该先校验')
    assert.match(material.text, /产出报告/)
    assert.match(material.text, /【审核判决】/)
    assert.match(material.text, /结论：fail/, '判决文本进素材')
    assert.match(material.text, /【使用者的反馈】/)
    assert.match(material.text, /第 3 步不对/, '用户反馈进素材')
  })
})

describe('buildDraftPrompt：起草指令', () => {
  test('新建：含作用描述、不结晶清单、现有技能列表', () => {
    const prompt = buildDraftPrompt({
      material: '素材正文',
      purpose: '用来审核 xx 类报告',
      existingSkill: null,
      existingSkills: [{ slug: 'general-review', name: '通用审核', description: '审报告' }],
      scope: 'conversation',
    })
    assert.match(prompt, /【使用者的作用描述】/)
    assert.match(prompt, /用来审核 xx 类报告/)
    assert.match(prompt, /【不结晶清单】/, '质量门在')
    assert.match(prompt, /general-review/, '现有技能列表在')
    assert.match(prompt, /## When to Use/, 'SKILL.md 结构约束在')
    assert.match(prompt, /素材正文/)
  })

  test('更新：带现有 SKILL.md 基线，作用描述可缺', () => {
    const prompt = buildDraftPrompt({
      material: '新经验',
      existingSkill: { name: 'my-flow', body: '旧版全文', description: '旧描述' },
      existingSkills: [],
      scope: 'task',
    })
    assert.match(prompt, /【要更新的现有 skill：my-flow】/)
    assert.match(prompt, /旧版全文/, '旧 SKILL.md 进素材作基线')
    assert.doesNotMatch(prompt, /【使用者的作用描述】/, '更新时没有作用描述块')
  })
})
