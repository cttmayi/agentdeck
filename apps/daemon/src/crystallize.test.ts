/**
 * crystallize（D80）素材打包与目标面板信息的单元测试。
 *
 * 用真 FileStore（临时目录）+ 夹具，不碰任何 CLI（NFR-T-01）。
 * 覆盖：
 *   · targets：conversation 场景的加载 skill（执行者挂的 ∪ 对话额外带的）；
 *     task 场景的 reviewed 判定（有 completed 审核 run 才算）。
 *   · material（四轮起落盘成目录）：conversation 一轮一文件且保留工具调用；task 的
 *     判决与反馈各一份；writeMaterial 的索引 / meta / 更新基线。
 *   · draft prompt（四轮起是指针式）：只给素材目录、产出契约与本次目标，"怎么写 skill"
 *     交给内置技能 writing-skills。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileStore } from '@agentdeck/store-file'
import {
  makeAgent,
  makeConversation,
  makeIssue,
  makeRun,
  makeSkill,
  wsId,
} from '@agentdeck/domain/testing'
import type { Agent, Run } from '@agentdeck/protocol'
import {
  buildDraftPrompt,
  crystallizeTargets,
  listCrystallizeDrafts,
  listCrystallizeSources,
  resolveSourceRun,
} from './crystallize.ts'
import { collectMaterial, writeMaterial } from './crystallize-material.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string
let store: FileStore

/**
 * 夹具里的"写作规范"正文（真身是内置 `writing-skills`，这里只要一段**可辨认的**文字，
 * 用来断言"规范真的进了 prompt"）。
 */
const SPEC = '## 写 skill 的规范（探针夹具）\n\n- 正文必须有 When to Use 与 Procedure 两节。\n'

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

describe('collectMaterial / writeMaterial：素材落盘（四轮）', () => {
  test('conversation：一轮一个文件，保留工具调用与结果', async () => {
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
    const collected = await collectMaterial(store, run!)
    assert.equal(collected.stats.turns, 2, '两轮都进素材')
    assert.equal(collected.stats.toolCalls, 1, '工具调用计数')

    const round1 = collected.pieces.find((p) => p.relPath === 'turns/001.md')
    assert.ok(round1, '一轮一个文件（agent 可以只读某轮）')
    assert.match(round1.text, /帮我打包这个脚本/, '使用者原话')
    assert.match(round1.text, /\[工具调用\] Bash/, '工具调用在')
    assert.match(round1.text, /\[工具结果\] a\.sh b\.sh/, '工具结果原样保留')
    const round2 = collected.pieces.find((p) => p.relPath === 'turns/002.md')
    assert.match(round2!.text, /加个参数/)
  })

  test('task：审核判决与用户反馈各成一份文件', async () => {
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

    const collected = await collectMaterial(store, taskRun, '第 3 步不对，应该先校验')
    const byPath = new Map(collected.pieces.map((p) => [p.relPath, p.text]))
    assert.match(byPath.get('task-run.md')!, /产出报告/)
    assert.match(byPath.get('verdict.md')!, /结论：fail/, '判决单独一份')
    assert.match(byPath.get('feedback.md')!, /第 3 步不对/, '反馈单独一份')
  })

  test('writeMaterial：索引 + meta + 现有技能清单都落盘，更新场景带基线', async () => {
    const materialDir = join(dir, 'material-ctx')
    const written = await writeMaterial(
      materialDir,
      {
        pieces: [{ relPath: 'task-run.md', text: '# 任务执行记录\n\n[消息] 干活' }],
        stats: { turns: 1, toolCalls: 3 },
      },
      {
        scope: 'task',
        sourceLabel: '修复构建',
        target: {
          kind: 'update',
          skill: {
            slug: 'my-flow',
            name: '我的流程',
            description: '旧描述',
            body: '---\nname: my-flow\n---\n旧版全文',
            files: { 'references/x.md': '参考' },
          },
        },
        existingSkills: [{ slug: 'general-review', name: '通用审核', description: '审报告' }],
      },
    )
    assert.ok(written.includes('00-README.md'), '索引在')
    assert.ok(written.includes('meta.json'), '元信息在')
    assert.ok(written.includes('skills-index.md'), '现有技能清单在')
    assert.ok(written.includes('existing-skill/SKILL.md'), '更新基线（正文）在')
    assert.ok(written.includes('existing-skill/references/x.md'), '更新基线（支持文件）也在')

    const read = async (rel: string): Promise<string> => readFile(join(materialDir, rel), 'utf8')
    const index = await read('00-README.md')
    assert.match(index, /修复构建/, '索引里有来源标题')
    assert.match(index, /更新现有 skill「my-flow」/, '索引里说明本次是更新')
    assert.match(index, /skill\/SKILL\.md/, '索引里说明产出写在哪（与素材目录同级）')
    assert.match(await read('meta.json'), /"turns": 1/)
    assert.match(await read('skills-index.md'), /general-review/)
  })
})

describe('buildDraftPrompt：起草指令（四轮：只留本次任务）', () => {
  test('指针式：给素材目录与产出契约，不再内联素材正文', () => {
    const prompt = buildDraftPrompt({
      scope: 'conversation',
      materialDir: 'material',
      outputDir: 'skill',
      target: 'new',
      writingSpec: SPEC,
    })
    assert.match(prompt, /material\/00-README\.md/, '先读索引')
    assert.match(prompt, /skill\/SKILL\.md/, '产出契约')
    // ★ 2026-10（定稿第 ③ 条）：**规范改成进 prompt**，不再靠"注入技能 + 提示里点名
    //   writing-skills"。判据也跟着换：既要**真的见到规范正文**，又不能再说
    //   "你去读那个技能文件"（那句话现在指向一个不存在的东西——技能不再注入了）。
    assert.match(prompt, /写 skill 的规范（探针夹具）/, '规范正文进了 prompt')
    assert.doesNotMatch(
      prompt,
      /你加载了 \`writing-skills\` 技能/,
      '不许再让起草者去找技能文件（第 ③ 条之后它没有被注入）',
    )
    assert.match(prompt, /不结晶清单/, '不结晶清单由内置技能承载（提示里点了名）')
    assert.match(prompt, /作用描述/, '新建时说明作用描述的用法')
    assert.doesNotMatch(prompt, /【素材】/, '素材不再内联')
  })

  test('更新：指向 existing-skill/，不再塞全文', () => {
    const prompt = buildDraftPrompt({
      scope: 'task',
      materialDir: 'material',
      outputDir: 'skill',
      target: 'update',
      writingSpec: SPEC,
    })
    assert.match(prompt, /material\/existing-skill\//, '更新基线在素材里')
    assert.match(prompt, /修订/, '要求修订而不是重写')
    assert.doesNotMatch(prompt, /作用描述/, '更新时没有作用描述那段')
  })
})

describe('listCrystallizeDrafts：沉淀任务列表', () => {
  test('只列未入库的起草 run，倒序，带来源标签', async () => {
    const agent = await seedAgent({ id: 'exec3' })
    // 来源 1：对话
    const conv = makeConversation({ id: 'conv-3' })
    await store.insertConversation(conv)
    const convRun = await seedRun({
      id: 'run-conv3',
      agentId: agent.id as string,
      workspaceId: WS,
      subject: { type: 'conversation', id: conv.id },
    })
    // 来源 2：任务（带标题）
    const issue = makeIssue({ id: 'issue-3' })
    await store.insertIssue(issue)
    const taskRun = await seedRun({
      id: 'run-task3',
      agentId: agent.id as string,
      workspaceId: WS,
      subject: { type: 'issue', id: issue.id },
    })

    // 起草 run：对话来源（旧）、任务来源（新）、已入库（跳过）
    await store.insertRun(
      makeRun({
        id: 'draft-old',
        agentId: agent.id as string,
        kind: 'execute',
        status: 'completed',
        workspaceId: WS,
        subject: { type: 'skill-draft', id: 'draft-old', sourceRunId: 'run-conv3' },
        crystallizeTarget: { kind: 'new' },
        queuedAt: 100,
      }),
    )
    await store.insertRun(
      makeRun({
        id: 'draft-new',
        agentId: agent.id as string,
        kind: 'execute',
        status: 'running',
        workspaceId: WS,
        subject: { type: 'skill-draft', id: 'draft-new', sourceRunId: 'run-task3' },
        crystallizeTarget: { kind: 'update', skillId: 's1' },
        queuedAt: 300,
      }),
    )
    await store.insertRun(
      makeRun({
        id: 'draft-committed',
        agentId: agent.id as string,
        kind: 'execute',
        status: 'completed',
        workspaceId: WS,
        subject: { type: 'skill-draft', id: 'draft-committed', sourceRunId: 'run-task3' },
        crystallizeTarget: { kind: 'new' },
        crystallized: true,
        queuedAt: 200,
      }),
    )

    const items = await listCrystallizeDrafts(store, taskRun.workspaceId as string)
    assert.deepEqual(
      items.map((i) => i.runId),
      ['draft-new', 'draft-old'],
      '倒序（最新在前），已入库的不出现',
    )
    assert.equal(items[0]!.source?.kind, 'issue')
    assert.equal(items[0]!.source?.label, issue.title)
    assert.deepEqual(items[0]!.target, { kind: 'update', skillId: 's1' })
    assert.equal(items[1]!.source?.kind, 'conversation')
    assert.equal(items[1]!.source?.label, conv.title)
  })

  test('放弃的（discarded: true）不出现——没入库的草稿要能收尾，否则左栏只增不减', async () => {
    const agent = await seedAgent({ id: 'exec3c' })
    const conv = makeConversation({ id: 'conv-3c', workspaceId: WS })
    await store.insertConversation(conv)
    const convRun = await seedRun({
      id: 'run-conv3c',
      agentId: agent.id as string,
      workspaceId: WS,
      subject: { type: 'conversation', id: conv.id },
    })
    await store.insertRun(
      makeRun({
        id: 'draft-discarded',
        agentId: agent.id as string,
        kind: 'execute',
        status: 'completed',
        workspaceId: WS,
        subject: { type: 'skill-draft', id: 'draft-discarded', sourceRunId: 'run-conv3c' },
        crystallizeTarget: { kind: 'new' },
        discarded: true,
        queuedAt: 400,
      }),
    )
    const items = await listCrystallizeDrafts(store, convRun.workspaceId as string)
    assert.ok(
      !items.some((i) => i.runId === 'draft-discarded'),
      '放弃过的那条不该再出现在沉淀列表里',
    )
  })

  test('源 run 已丢失：source 为 null，行仍列出（靠 runId 兜底）', async () => {
    const agent = await seedAgent({ id: 'exec3b' })
    const orphan = makeRun({
      id: 'draft-orphan',
      agentId: agent.id as string,
      kind: 'execute',
      status: 'failed',
      workspaceId: WS,
      subject: { type: 'skill-draft', id: 'draft-orphan', sourceRunId: 'run-gone' },
      crystallizeTarget: { kind: 'new' },
      queuedAt: 50,
    })
    await store.insertRun(orphan)
    const items = await listCrystallizeDrafts(store, orphan.workspaceId as string)
    const row = items.find((i) => i.runId === 'draft-orphan')
    assert.ok(row, '失败的草稿也列出（未入库）')
    assert.equal(row!.source, null, '源 run 没了 → source null，不硬编标题')
  })
})

describe('listCrystallizeSources：新建沉淀的来源选择器', () => {
  test('对话=最后一轮没报错；任务=终态且审核过（未审核不列出）', async () => {
    const agent = await seedAgent({ id: 'exec4' })
    // 对话 A：最后一轮正常 → 列出
    const convA = makeConversation({ id: 'conv-4a', workspaceId: WS })
    await store.insertConversation(convA)
    const convARun = makeRun({
      id: 'run-4a1',
      agentId: agent.id as string,
      workspaceId: WS,
      subject: { type: 'conversation', id: convA.id },
      queuedAt: 10,
    })
    await store.insertRun(convARun)
    await store.insertChatTurn({
      id: 'turn-4a1' as never,
      workspaceId: WS,
      conversationId: convA.id,
      seq: 1,
      userText: '聊了',
      runId: 'run-4a1' as never,
      createdAt: 1,
      error: null,
    })
    // 对话 B：最后一轮带 error → 不列出（与聊天页「沉淀成 skill」同一判据）
    const convB = makeConversation({ id: 'conv-4b', workspaceId: WS })
    await store.insertConversation(convB)
    await store.insertRun(
      makeRun({
        id: 'run-4b1',
        agentId: agent.id as string,
        workspaceId: WS,
        subject: { type: 'conversation', id: convB.id },
        queuedAt: 20,
      }),
    )
    await store.insertChatTurn({
      id: 'turn-4b1' as never,
      workspaceId: WS,
      conversationId: convB.id,
      seq: 1,
      userText: '聊了但报错',
      runId: 'run-4b1' as never,
      createdAt: 1,
      error: 'boom',
    })
    await store.appendRunMessage('run-4b1' as never, {
      seq: 1,
      type: 'error',
      content: 'x',
      tool: null,
      input: null,
      output: null,
      outputTruncated: false,
      at: 1,
    })

    // 任务 X：终态 + 审核过 → 列出
    const issueX = makeIssue({ id: 'issue-4x', workspaceId: WS })
    await store.insertIssue(issueX)
    await store.insertRun(
      makeRun({
        id: 'run-4x',
        agentId: agent.id as string,
        workspaceId: WS,
        status: 'completed',
        subject: { type: 'issue', id: issueX.id },
        queuedAt: 30,
      }),
    )
    await store.insertRun(
      makeRun({
        id: 'rev-4x',
        agentId: agent.id as string,
        workspaceId: WS,
        kind: 'review',
        status: 'completed',
        subject: { type: 'run', id: 'run-4x' },
        queuedAt: 40,
      }),
    )
    // 任务 Y：终态但没审核 → 不列出（点了进不去）
    const issueY = makeIssue({ id: 'issue-4y', workspaceId: WS })
    await store.insertIssue(issueY)
    await store.insertRun(
      makeRun({
        id: 'run-4y',
        agentId: agent.id as string,
        workspaceId: WS,
        status: 'completed',
        subject: { type: 'issue', id: issueY.id },
        queuedAt: 50,
      }),
    )

    const items = await listCrystallizeSources(store, WS)
    const convRows = items.filter((i) => i.kind === 'conversation')
    const taskRows = items.filter((i) => i.kind === 'task')
    const conv4a = convRows.find((i) => i.id === 'conv-4a')
    assert.ok(conv4a, '正常轮出的对话列出')
    assert.equal(conv4a!.runId, 'run-4a1')
    assert.equal(conv4a!.turns, 1, '轮数 = 对话的 ChatTurn 条数（1 条）——仍然列出，素材统计会早失败')
    assert.ok(!convRows.some((i) => i.id === 'conv-4b'), '最后一轮报错的对话不列出')
    const taskX = taskRows.find((i) => i.id === 'issue-4x')
    assert.ok(taskX, '审核过的终态任务列出')
    assert.equal(taskX!.runId, 'run-4x')
    assert.ok(!taskRows.some((i) => i.id === 'issue-4y'), '未审核的任务不列出（§4.3 门槛）')
  })
})

describe('resolveSourceRun：起草 run 归一成源 run（三轮）', () => {
  test('草稿 id → 它的 sourceRunId；源 run 丢了就原样返回', async () => {
    const agent = await seedAgent({ id: 'exec5' })
    const conv = makeConversation({ id: 'conv-5', workspaceId: WS })
    await store.insertConversation(conv)
    const source = makeRun({
      id: 'run-5src',
      agentId: agent.id as string,
      workspaceId: WS,
      subject: { type: 'conversation', id: conv.id },
    })
    await store.insertRun(source)
    const draft = makeRun({
      id: 'draft-5',
      agentId: agent.id as string,
      workspaceId: WS,
      subject: { type: 'skill-draft', id: 'draft-5', sourceRunId: 'run-5src' },
    })
    await store.insertRun(draft)

    const resolved = await resolveSourceRun(store, draft)
    assert.equal(resolved.id, 'run-5src', '草稿归一成源 run（不拿草稿产出当素材）')
    // 源 run 不是草稿时原样返回
    assert.equal((await resolveSourceRun(store, source)).id, 'run-5src')

    // 源 run 已被清理：原样返回（调用方走"素材为空"的正常分支）
    const orphan = makeRun({
      id: 'draft-5b',
      agentId: agent.id as string,
      workspaceId: WS,
      subject: { type: 'skill-draft', id: 'draft-5b', sourceRunId: 'run-gone-5' },
    })
    await store.insertRun(orphan)
    assert.equal((await resolveSourceRun(store, orphan)).id, 'draft-5b')
  })
})
