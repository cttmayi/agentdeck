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
import { DRAFTER_INSTRUCTIONS } from './builtin-drafter.ts'
import { loadBuiltinSkill, WRITING_SKILLS } from './builtin-skills.ts'

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

  /**
   * ★ 分批第 190 批（使用者："起草者的身份把规则都去掉，让它遵照 skill 来进行即可"）：
   * 原来这一组钉的是"身份里必须有 6~8 条岗位规矩、必须带限定语、不许粘写作规范"——
   * 全部**随这次简化作废**。现在钉三条新的、也是唯一还需要保证的语义：
   */
  test('★★★ 起草者的身份是**极简的**：只说"照着注入的技能写"，不再带守则清单', () => {
    assert.ok(
      DRAFTER_INSTRUCTIONS.includes('照着你被注入的那份技能'),
      '身份必须说清"按技能干"——那是它现在唯一的写法来源（平台不再规定章节与守则）',
    )
    assert.ok(
      DRAFTER_INSTRUCTIONS.includes('可能是一条 skill') &&
        DRAFTER_INSTRUCTIONS.includes('智能体的指令'),
      '两个产出对象仍要点出来（同一条起草者接两种活）',
    )
    assert.ok(
      !DRAFTER_INSTRUCTIONS.includes('| 1. |') && DRAFTER_INSTRUCTIONS.length < 400,
      `身份要短（现在 ${String(DRAFTER_INSTRUCTIONS.length)} 字符）——规则已经交给技能与任务书`,
    )
    assert.ok(
      !DRAFTER_INSTRUCTIONS.includes('When to Use') && !DRAFTER_INSTRUCTIONS.includes('Procedure'),
      '不再要求章节名（分批第 177 批定过）',
    )
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
/**
 * ★ 分批第 189 批（使用者："移除「默认工作守则」，新建的智能体不该自动带任何守则"）：
 * 这一组（工作区设定 + 新建预填 + 长度上限）**整组删除**——功能没了，判据也不该留。
 * 删掉的是：`PUT /api/workspace/agent-conduct`、`POST /api/agents` 的预填、
 * 以及设置页那一块 UI。内置 agent 的 `withConduct`（代码常量）不受影响。
 */
