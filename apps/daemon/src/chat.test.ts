import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Store } from '@agentdeck/domain'
import {
  makeAgent,
  makeConversation,
  makeChatTurn,
  makeRun,
  makeSkill,
  skillId,
  wsId,
} from '@agentdeck/domain/testing'
import type { ChatTurn, Conversation, Run, Skill, SubmitRunRequest } from '@agentdeck/protocol'
import { submitChatTurn, titleFromText, TITLE_MAX } from './chat.ts'
import type { RunExecutor } from './executor.ts'

// ══════════════════════════════════════════════════════════════════
// 标题
// ══════════════════════════════════════════════════════════════════

describe('对话标题从第一句话来', () => {
  test('只取第一个非空行——第一行常常是寒暄，第二行才是正题', () => {
    assert.equal(titleFromText('帮我看看\n\nbuild 为什么挂了'), '帮我看看')
    assert.equal(titleFromText('\n\n  \n真正的第一行\n第二行'), '真正的第一行')
  })

  test('压掉行内连续空白：标题不是原文，是索引', () => {
    assert.equal(titleFromText('  build   为什么   挂了  '), 'build 为什么 挂了')
    assert.equal(titleFromText('a\t\tb'), 'a b')
  })

  test('超长截断并留省略号——不留痕的话"标题"和"我说的话"看起来是同一个东西', () => {
    const long = 'x'.repeat(TITLE_MAX + 40)
    const out = titleFromText(long)
    assert.equal(out.length, TITLE_MAX + 1)
    assert.ok(out.endsWith('…'))
    // 正好等于上限时不截断（少一个字的边界最容易写错）
    const exact = 'y'.repeat(TITLE_MAX)
    assert.equal(titleFromText(exact), exact)
  })

  test('全是空白时给一个能点的名字，不给空串', () => {
    assert.equal(titleFromText(''), '对话')
    assert.equal(titleFromText('   \n\n  '), '对话')
  })
})

// ══════════════════════════════════════════════════════════════════
// 一轮对话
// ══════════════════════════════════════════════════════════════════

interface FakeOptions {
  /** 已经存在的轮次（用来验"接上文"）。 */
  turns?: ChatTurn[]
  /** 上一次带 run 的轮次对应的那条 run。 */
  previousRun?: Run | null
  submit?: (req: SubmitRunRequest) => Promise<unknown>
  conversationWorkDir?: string | null
  /** 技能库里的东西（用来验"谁挂的 + 对话带的"）。 */
  skills?: Skill[]
  /** 执行者身上挂的 skill id。 */
  agentSkillIds?: string[]
  /** 对话自己带的 skill id。`null` = 老记录，键根本不存在。 */
  conversationSkillIds?: string[] | null
}

/** 只实现这条路径真正用到的那几个方法——不是为了模拟存储，是为了钉住调用顺序。 */
function makeFakes(opts: FakeOptions = {}) {
  const calls: string[] = []
  const inserted: ChatTurn[] = []
  const patches: Array<Record<string, unknown>> = []
  let submitted: SubmitRunRequest | null = null

  const agent = makeAgent({
    id: 'a1',
    name: '助手',
    instructions: '你是助手',
    role: 'executor',
    ...(opts.agentSkillIds ? { skillIds: opts.agentSkillIds.map((id) => skillId(id)) } : {}),
  })
  const conversation = makeConversation({
    id: 'c1',
    agentId: agent.id,
    workDir: opts.conversationWorkDir ?? null,
    ...(opts.conversationSkillIds ? { skillIds: opts.conversationSkillIds.map((id) => skillId(id)) } : {}),
  })
  if (opts.conversationSkillIds === null) {
    // 老记录：这个键在 JSON 里根本不存在（`Conversation.skillIds` 是后加的）
    delete (conversation as { skillIds?: unknown }).skillIds
  }

  const store = {
    listChatTurns: async () => opts.turns ?? [],
    lastChatTurnWithRun: async () =>
      [...(opts.turns ?? [])].reverse().find((t) => t.runId !== null) ?? null,
    getRun: async () => opts.previousRun ?? null,
    insertChatTurn: async (t: ChatTurn) => {
      calls.push(`insert:${t.seq}`)
      inserted.push(t)
    },
    updateConversation: async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch)
      return { ...conversation, ...patch } as Conversation
    },
    listSkills: async () => opts.skills ?? [],
  } as unknown as Store

  const executor = {
    submit: async (req: SubmitRunRequest) => {
      calls.push('submit')
      submitted = req
      return opts.submit ? await opts.submit(req) : { kind: 'accepted', runId: req.runId }
    },
  } as unknown as RunExecutor

  return {
    agent,
    conversation,
    store,
    executor,
    calls,
    inserted,
    patches,
    get submitted() {
      return submitted
    },
  }
}

const WORK_ROOT = '/tmp/work'

describe('说一轮：一轮 = 一条 run', () => {
  test('★ 先记下"我说了这句话"，再去建 run（顺序是刻意的）', async () => {
    const f = makeFakes()
    const out = await submitChatTurn(
      f.store, f.executor, f.conversation, f.agent, '你好', 1_700_000_000_000, WORK_ROOT,
    )
    // 两次 insert 是**同一条**轮次（upsert：先落一条只有使用者那句话的，跑起来了再补 runId），
    // 关键是第一次 insert 必须排在 submit 前面——中途崩了才不会出现"说了却消失"。
    assert.deepEqual(f.calls, ['insert:1', 'submit', 'insert:1'])
    assert.equal(f.calls.indexOf('submit'), 1, '★ 轮次落盘必须早于建 run')
    assert.equal(f.inserted[0]!.runId, null, '落盘那一刻还没有 run')
    assert.equal(f.inserted[1]!.runId, f.submitted!.runId)
    assert.equal(out.runId, f.submitted!.runId)
    assert.equal(out.failure, null)
  })

  test('★ 这一轮不自动审：reviewerAgentId 必须是显式的 null，不是省略', async () => {
    const f = makeFakes()
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.equal(f.submitted!.reviewerAgentId, null)
    assert.ok('reviewerAgentId' in f.submitted!, '省略它等于"按 agent 配置走"，会弹出一条审核 run')
  })

  test('★ subject 是对话：报告那条路只认 issue/report/run，所以这条 run 到不了判决', async () => {
    const f = makeFakes()
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.deepEqual(f.submitted!.subject, { type: 'conversation', id: 'c1' })
    assert.equal(f.submitted!.kind, 'execute')
  })

  test('目录：没设过就自动分配 chat-<对话 id>（**通过 `workDir` 字段，不写进正文**）', async () => {
    const f = makeFakes()
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.equal(f.submitted!.workDir, `${WORK_ROOT}/chat-c1`)
    // ⚠️ 这条断言原来量的是"正文里写着那个目录"，那是模版时代的形状。
    //    现在目录走 `workDir` 字段（= CLI 的 cwd），正文里**没有**它——
    //    所以这里反过来钉住"正文里不该再出现目录"：出现就说明模版又回来了。
    assert.equal(f.submitted!.prompt, '你好')
  })

  test('设过目录就用设过的（"把它接进我的仓库"）', async () => {
    const f = makeFakes({ conversationWorkDir: '/Users/x/proj' })
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.equal(f.submitted!.workDir, '/Users/x/proj')
    assert.ok(!f.submitted!.prompt.includes('/Users/x/proj'))
  })

  test('★ 投递的就是使用者那句话：逐字相同，没有任何包装', async () => {
    const f = makeFakes()
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '看下 build', 1, WORK_ROOT)
    // ★★ 投递的就是那句话本身——**逐字相同**，不是"包含"。
    //    这里刻意用 `equal`：`includes` 放得过"套了一层模版但有那段原文"，
    //    而"不套模版"正是这条用例要钉的事（执行器那一侧还有端到端的一份）。
    assert.equal(f.submitted!.prompt, '看下 build')
  })

  test('第二轮接上文：resumeFromRunId 指向最近一条**带 run**的轮次', async () => {
    const previous = makeRun({ id: 'r1', agentId: 'a1' })
    const f = makeFakes({
      turns: [
        makeChatTurn({ id: 't1', conversationId: 'c1', seq: 1, runId: previous.id }),
        // ⚠️ 尾轮没有 run（上一轮没抢到并发位）——**必须被跳过**，
        //    否则一次失败会把整个对话的上文切断
        makeChatTurn({ id: 't2', conversationId: 'c1', seq: 2, runId: null, error: '没跑起来' }),
      ],
      previousRun: previous,
    })
    const out = await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '继续说', 2, WORK_ROOT)
    assert.equal(f.submitted!.resumeFromRunId, 'r1')
    assert.equal(out.turn.seq, 3, '新轮次的序号是"最大值 + 1"，不是 length + 1')
  })

  test('没抢到并发位：轮次留下来并写明原因，runId 留空，但"我说过"这件事不丢', async () => {
    const f = makeFakes({
      submit: async () => ({ kind: 'rejected', reason: 'no_capacity', retryAfterMs: 2000 }),
    })
    const out = await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 5, WORK_ROOT)
    assert.equal(out.failure, 'no_capacity')
    assert.equal(out.runId, null)
    assert.equal(out.turn.runId, null)
    assert.match(out.turn.error ?? '', /没有空闲的执行位/)
    assert.equal(out.retryAfterMs, 2000)
    // 说话这件事仍然要计入"最近说过话"——否则它在列表里会被当成没动过的对话
    assert.equal(f.patches.at(-1)!.lastTurnAt, 5)
    assert.equal(f.patches.at(-1)!.turnCount, 1)
  })

  test('执行器直接抛错也要落成一条看得见的轮次，不能让异常吃掉它', async () => {
    const f = makeFakes({
      submit: async () => {
        throw new Error('工作目录建不出来')
      },
    })
    const out = await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 5, WORK_ROOT)
    assert.equal(out.failure, 'error')
    assert.equal(out.turn.error, '工作目录建不出来')
    assert.equal(f.inserted.length, 2, '落一条 + 改成带错误的同一条（upsert，不会多出一条记录）')
  })

  test('agent 的 skill 必须显式带下去——省略会被执行器当成"一个都没有"', async () => {
    const f = makeFakes()
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.ok(Array.isArray(f.submitted!.skills), 'skills 不能是 undefined')
  })

  test('★★ 对话自己带的 skill 与执行者挂的**相加**，不是替换', async () => {
    // 「新对话」里选了一条没人挂的 skill ⇒ 它记在这个对话上，而执行者身上那些
    // 仍然是它的一部分——凭空丢掉等于使用者只挑了一条 skill 就把执行者削了。
    const f = makeFakes({
      skills: [makeSkill({ id: 's1', slug: 'one' }), makeSkill({ id: 's2', slug: 'two' })],
      agentSkillIds: ['s1'],
      conversationSkillIds: ['s2'],
    })
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.deepEqual(
      (f.submitted!.skills ?? []).map((s) => s.slug),
      ['one', 'two'],
    )
  })

  test('★ 同一条 skill 既挂在执行者身上又被对话带上时，只注入一次', async () => {
    // 选的是"挂着它的那个执行者"那种情况：两边会出现同一条，注入两遍等于那份
    // SKILL.md 在上下文里出现两次。
    const f = makeFakes({
      skills: [makeSkill({ id: 's1', slug: 'one' })],
      agentSkillIds: ['s1'],
      conversationSkillIds: ['s1'],
    })
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.deepEqual(
      (f.submitted!.skills ?? []).map((s) => s.slug),
      ['one'],
    )
  })

  test('★ 记录里留着一条早就卸掉的 skill ⇒ 跳过它，不报错（那条对话该照常能说话）', async () => {
    const f = makeFakes({
      skills: [makeSkill({ id: 's1', slug: 'one' })],
      agentSkillIds: ['s1'],
      conversationSkillIds: ['已经卸载了'],
    })
    const out = await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.equal(out.failure, null)
    assert.deepEqual(
      (f.submitted!.skills ?? []).map((s) => s.slug),
      ['one'],
    )
  })

  test('★ 老记录没有 skillIds 这个键（后加的字段）⇒ 按"没有"处理，照常跑', async () => {
    const f = makeFakes({
      skills: [makeSkill({ id: 's1', slug: 'one' })],
      agentSkillIds: ['s1'],
      conversationSkillIds: null,
    })
    const out = await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.equal(out.failure, null)
    assert.deepEqual(
      (f.submitted!.skills ?? []).map((s) => s.slug),
      ['one'],
    )
  })

  test('limits 两个都不设上限（超时管的是"多久没动静"，不是墙钟）', async () => {
    const f = makeFakes()
    await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.deepEqual(f.submitted!.limits, { maxTurns: null, timeoutMs: null })
  })

  test('撞上别的 workspace 的对话也不会写错地方（seq 按对话算）', async () => {
    const f = makeFakes({ turns: [makeChatTurn({ id: 'x', conversationId: 'c1', seq: 7 })] })
    const out = await submitChatTurn(f.store, f.executor, f.conversation, f.agent, '你好', 1, WORK_ROOT)
    assert.equal(out.turn.seq, 8)
    assert.equal(out.turn.conversationId, 'c1')
    assert.equal(out.turn.workspaceId, wsId())
  })
})
