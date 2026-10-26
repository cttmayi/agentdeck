import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
} from '@agentdeck/agent-core'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { CONDUCT_MAX_CHARS, GENERAL_WORK_CONDUCT, withConduct } from './agent-conduct.ts'
import { DRAFTER_INSTRUCTIONS, SKILL_REVIEWER_INSTRUCTIONS } from './builtin-drafter.ts'

/** 这份测试不跑 run（只读 identity / 建 agent），后端给个立刻成功的假货即可。 */
class QuietBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true
  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }
  async execute(): Promise<AgentSession> {
    const queue = new AsyncQueue<AgentMessage>()
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '',
        durationMs: 1,
        sessionId: 'conduct',
        usage: { inputTokens: 0, outputTokens: 0, costUsdMicros: 0, costSource: 'provider' },
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
 * 分批第 47 批：把「与岗位无关的工作纪律」从 ① 框架 / ② 岗位里抽成**一份**守则。
 *
 * 使用者原话：「我看起草者这3部分的信息，发现有很多原则放在了框架和任务中。
 * 但我想尽量往身份去放，让它尽量和执行者通用」——并且在"只让内置 agent 共用常量(A)"
 * 与"新建 agent 也带上(B)"之间选了「A、B 都做」。
 *
 * 这一份测试钉的是**"通用"这个词到底成立不成立**：
 *   ① 守则里不许出现任何岗位词（skill / 审核 / 起草 / 素材目录 …）——
 *      否则它就不是"通用"，只是"换了个地方的岗位纪律"；
 *   ② 守则里不许出现**任务契约**（数字上限、产出路径、验收判据）——那些留在任务书；
 *   ③ 起草者与审核者的身份里**都**含同一份守则（同一常量、逐字相同）。
 */
describe('★ 分批第 47 批：通用工作守则', () => {
  test('★★★ 守则里没有岗位词（"通用"的定义就在这一条上）', () => {
    const forbidden = ['skill', 'SKILL', '审核', '起草', '沉淀', '判决']
    const hit = forbidden.filter((w) => GENERAL_WORK_CONDUCT.includes(w))
    assert.deepEqual(
      hit,
      [],
      `通用守则里不该出现岗位词（${hit.join('、')}）——出现了就说明它只是岗位纪律换了个地方`,
    )
  })

  test('★★★ 守则里没有任务契约（数字上限 / 产出路径 / 验收判据）', () => {
    const forbidden = ['6000', 'material/', 'skill/', 'agent/', '## When to Use', '## Procedure', 'SKILL.md']
    const hit = forbidden.filter((w) => GENERAL_WORK_CONDUCT.includes(w))
    assert.deepEqual(hit, [], `任务契约要留在任务书里，不该进守则：${hit.join('、')}`)
  })

  test('★★ 四条都在，且长度克制（它每次都随第一句话发出去，也会填进使用者的指令框）', () => {
    for (const key of ['只做被要求的事', '依据必须来自素材', '回原文取', '产出落到文件里']) {
      assert.ok(GENERAL_WORK_CONDUCT.includes(key), `守则里缺「${key}」`)
    }
    assert.ok(
      GENERAL_WORK_CONDUCT.length <= 400,
      `守则要短（现在 ${String(GENERAL_WORK_CONDUCT.length)} 字符）——它是给模型和人都一眼读完的东西`,
    )
    assert.ok(CONDUCT_MAX_CHARS > GENERAL_WORK_CONDUCT.length, '上限要大于默认正文')
  })

  test('★★ withConduct：一句话岗位 + 守则；岗位为空就只返回守则（新建 agent 的情形）', () => {
    assert.equal(withConduct('你是谁', '守则A'), '你是谁\n\n守则A')
    assert.equal(withConduct('', '守则A'), '守则A')
    assert.equal(withConduct('你是谁', ''), '你是谁')
    assert.equal(withConduct('  ', '  '), '')
  })

  test('★★★ 起草者与审核者的身份里用的是**同一份**守则（逐字相同 ⇒ 真的"通用"）', () => {
    assert.ok(DRAFTER_INSTRUCTIONS.includes(GENERAL_WORK_CONDUCT), '起草者身份要含守则原文')
    assert.ok(SKILL_REVIEWER_INSTRUCTIONS.includes(GENERAL_WORK_CONDUCT), '审核者身份要含守则原文')
    // 两份身份的第一段都是"一句话岗位"，第二段起是同一份守则 —— 顺序也必须一致
    assert.ok(DRAFTER_INSTRUCTIONS.startsWith('你是 skill 起草者'))
    assert.ok(SKILL_REVIEWER_INSTRUCTIONS.startsWith('你是平台内置的审核者'))
  })

  test('★ 岗位专属的判据仍在身份里（守则负责通用、身份负责岗位，两者都不能空）', () => {
    assert.ok(DRAFTER_INSTRUCTIONS.includes('起草者专属'), '起草者的专属三条要有明确小标题')
    assert.ok(DRAFTER_INSTRUCTIONS.includes('不值得沉淀就说出来'))
    assert.ok(SKILL_REVIEWER_INSTRUCTIONS.includes('审 skill 时你审的五件事'))
    assert.ok(SKILL_REVIEWER_INSTRUCTIONS.includes('脚本能不能跑'))
  })
})

/**
 * ★ 分批第 47 批第二部分（B）：「默认工作守则」这个**工作区设定**要真的影响新建的 agent。
 *
 * 判据只有三条，但每条都对应一种"看起来生效了"：
 *   ① 存进去能读回来（identity 是设置页与新建表单的**同一个**数据源）；
 *   ② 新建时**指令为空** ⇒ 真的被预填（不是只在界面上显示）；
 *   ③ 请求里**给了**指令 ⇒ 一个字都不许动（否则使用者手打的身份会被守则覆盖）。
 */
describe('★ 默认工作守则作为工作区设定（真 daemon + 真 HTTP）', () => {
  let dataDir = ''
  let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null

  const json = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${daemon!.url}${path}`, init)
    const text = await res.text()
    try {
      return { status: res.status, body: JSON.parse(text) as unknown }
    } catch {
      return { status: res.status, body: text }
    }
  }
  const putJson = (path: string, payload: unknown) =>
    json(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  const postJson = (path: string, payload: unknown) =>
    json(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

  before(async () => {
    dataDir = await makeTempDir('conduct-data')
    daemon = await startDaemon({
      dataDir,
      workRoot: join(dataDir, 'work'),
      port: 0,
      fsync: false,
      backend: new QuietBackend(),
      onWarn: () => {},
      onInfo: () => {},
    })
  })

  after(async () => {
    if (daemon) await daemon.close()
    await cleanup(dataDir)
  })

  test('★★★ 缺省 = 平台默认守则（老 workspace 也要有值，否则新建表单会是空框）', async () => {
    const { body } = await json('/api/identity')
    assert.equal(
      (body as { defaultAgentConduct?: string }).defaultAgentConduct,
      GENERAL_WORK_CONDUCT,
      '没设过的时候 identity 必须给出平台默认守则',
    )
  })

  test('★★★ 存进去能读回来；空串 = 不预填（不是"存了个空看起来像没保存"）', async () => {
    const mine = '## 工作守则\n\n1. 我们团队：先写测试再改代码。\n'
    const saved = await putJson('/api/workspace/agent-conduct', { conduct: mine })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const after = await json('/api/identity')
    assert.equal((after.body as { defaultAgentConduct?: string }).defaultAgentConduct, mine)

    const empty = await putJson('/api/workspace/agent-conduct', { conduct: '' })
    assert.equal(empty.status, 200)
    const afterEmpty = await json('/api/identity')
    assert.equal((afterEmpty.body as { defaultAgentConduct?: string }).defaultAgentConduct, '')
  })

  test('★★★ 新建 agent（指令为空）⇒ 真的被预填；给了指令 ⇒ 一个字不动', async () => {
    await putJson('/api/workspace/agent-conduct', { conduct: GENERAL_WORK_CONDUCT })

    const prefilled = await postJson('/api/agents', { name: '预填验证', role: 'executor' })
    assert.equal(prefilled.status, 201, JSON.stringify(prefilled.body))
    assert.equal(
      (prefilled.body as { instructions: string }).instructions,
      GENERAL_WORK_CONDUCT,
      '★ 指令为空的新建必须预填守则（使用者要的"执行者也通用"就落在这里）',
    )

    const mine = '这名执行者只写 SQL。'
    const explicit = await postJson('/api/agents', {
      name: '自带指令',
      role: 'executor',
      instructions: mine,
    })
    assert.equal(explicit.status, 201)
    assert.equal(
      (explicit.body as { instructions: string }).instructions,
      mine,
      '★ 请求里给了指令 ⇒ 不许被守则覆盖（那是使用者手打的身份）',
    )

    // 存空 ⇒ 之后的"空指令新建"不再预填
    await putJson('/api/workspace/agent-conduct', { conduct: '' })
    const bare = await postJson('/api/agents', { name: '空身份', role: 'executor' })
    assert.equal(bare.status, 201)
    assert.equal(
      (bare.body as { instructions: string }).instructions,
      '',
      '★ 守则设成空 ⇒ 新建的 agent 就是空身份（"我要空身份"必须做得到）',
    )
  })

  test('★★ 守则太长 ⇒ 400（它会整份进每条新 agent 的身份块，进而每轮都发出去）', async () => {
    const tooLong = 'x'.repeat(CONDUCT_MAX_CHARS + 1)
    const bad = await putJson('/api/workspace/agent-conduct', { conduct: tooLong })
    assert.equal(bad.status, 400)
    assert.equal((bad.body as { code?: string }).code, 'conduct_too_long')
    const notString = await putJson('/api/workspace/agent-conduct', { conduct: 42 })
    assert.equal(notString.status, 400)
    assert.equal((notString.body as { code?: string }).code, 'invalid_conduct')
  })
})
