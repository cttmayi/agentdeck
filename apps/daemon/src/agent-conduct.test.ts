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

  test('★★★ 起草者与审核者的身份里用的是**同一份**守则（逐字相同 ⇒ 真的"通用"）', () => {
    assert.ok(DRAFTER_INSTRUCTIONS.includes(GENERAL_WORK_CONDUCT), '起草者身份要含守则原文')
    assert.ok(SKILL_REVIEWER_INSTRUCTIONS.includes(GENERAL_WORK_CONDUCT), '审核者身份要含守则原文')
    // 两份身份的第一段都是"一句话岗位"，第二段起是同一份守则 —— 顺序也必须一致
    assert.ok(DRAFTER_INSTRUCTIONS.startsWith('你是 skill 起草者'))
    assert.ok(SKILL_REVIEWER_INSTRUCTIONS.startsWith('你是平台内置的审核者'))
  })

  test('★★★ 起草者的身份**不再单薄**：岗位专属 ≥ 7 条，且搬进来的都是"岗位长期做法"', () => {
    /**
     * 使用者的两次反馈：「发现有很多原则放在了框架和任务中。但我想尽量往身份去放」
     * → ��47 批搬了通用守则；然后「我看起草者的身份内容还是很少呢」→ 第 48 批把
     * 任务书里那几条**岗位长期做法**也搬了进来。
     *
     * 这条判据钉的就是"别再缩回去"：身份里必须能数出这七件事，而且每一件的措辞都得在
     * （它们各自对应一个真实的失败面：读法不对=贵且抓不住重点、凭印象写命令=照敲跑不起来、
     * 不写两节=入库被拒、不自检=带着坏引用交上去、硬凑=垃圾技能冻结错误行为）。
     */
    const must = [
      '只写可复用的步骤',
      '先看素材索引，再按需读',
      '写 Procedure 前回查原始命令',
      '交付要过入库闸门',
      '写法以任务书给的写作规范为准',
      '交付前自检一遍',
      '使用者的要求是默认约定',
      '不值得沉淀就说出来',
    ]
    const missing = must.filter((k) => !DRAFTER_INSTRUCTIONS.includes(k))
    assert.deepEqual(missing, [], `起草者身份里缺这些岗位规矩：${missing.join('、')}`)
    assert.ok(
      DRAFTER_INSTRUCTIONS.length >= 700,
      `身份不能又缩回单薄形态（现在 ${String(DRAFTER_INSTRUCTIONS.length)} 字符）——` +
        '上一批缩到 419 时使用者立刻发现了',
    )
    // 数字型闸门（6000）**不进身份**：它属于任务书里的契约，两处写会漂
    assert.ok(!DRAFTER_INSTRUCTIONS.includes('6000'), '6000 上限留在任务书里，身份里不许重复')
  })

  test('★★★ 写作规范全文**不许**粘进身份（它只对"写 skill"这一件事成立）', async () => {
    /**
     * 使用者的疑问：「『写作规范全文 1731 字』什么不放『身份』里面呢」。
     *
     * 答案在代码里，而且很硬：**同一条起草者还要干另一件事**——沉淀成 Agent
     * （`buildAgentInstructionsPrompt`，判据是"指令五项 + 6000 上限"）。
     * 写作规范只对"写 skill"成立；放进身份的话，每一条"改智能体指令"的 run 都会
     * 带上 1731 字完全无关的 skill 写法规范，还会跟指令五项抢注意力。
     *
     * 另外两条：① 规范是**随代码走的内置 skill**（`writing-skills`），③ 每次拿最新的；
     * 而身份是**每条 agent 的私人副本**（可编辑、"存着 === 已知历史"才升级）⇒
     * 粘进去就是第二份，规范一改它就跟不上（"内置指令停在旧版"那族缺陷）；
     * ② 身份使用者可以删改（第 ⑥ 条），规范是平台权威，不该被手滑改掉。
     *
     * 所以这条判据盯的是：**别把规范正文搬进身份**（片段比对，不用整篇相等）。
     */
    const spec = await loadBuiltinSkill(WRITING_SKILLS)
    assert.ok(spec !== null, '内置写作规范必须加载得到（它随代码走）')
    if (spec === null) return
    /**
     * ⚠️ 第一版按固定字符位置切片（0/600/1200）→ **红检时没抓到**：粘进去的那句
     * 恰好落在切片的缝里（切片头是 frontmatter 与空行）。按**行**取探针才不会漏：
     * 规范里的每一行只要够长，就当作一个"这段文字属于规范"的指纹。
     */
    const probes = spec.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 40)
      .map((line) => line.slice(0, 40))
    assert.ok(probes.length >= 5, `写作规范里长行太少（${String(probes.length)}），探针不够用`)
    const hit = probes.find((needle) => DRAFTER_INSTRUCTIONS.includes(needle))
    assert.equal(
      hit,
      undefined,
      `起草者身份里出现了写作规范的原文片段（"${hit ?? ''}"）——` +
        '规范必须在任务书那一处（`buildDraftPrompt` 的【写作规范】），身份里只留"以它为准"',
    )
    // 但"以它为准"这句话要在（身份不是完全不提规范）
    assert.ok(
      DRAFTER_INSTRUCTIONS.includes('写作规范为准'),
      '身份里要有一句"写法以任务书给的写作规范为准"（否则它不知道规范在哪）',
    )
  })

  test('★★★ 同一个起草者服务「写 skill」与「改智能体指令」两个任务 ⇒ 专属条款必须带限定语', () => {
    /**
     * 事实（使用者问「起草者 是 起草skill 和起草agent 通用的吗？」）：**同一个 agent、
     * 同一份身份**。两次的差别只在任务书（`buildDraftPrompt` vs `buildAgentInstructionsPrompt`）
     * 与产出目录（`skill/` vs `agent/`）——`server.ts` 起起草 run 时只用一份
     * `drafter.instructions`。
     *
     * 于是身份里那些**只对 skill 成立**的条款（`## When to Use` 两节、frontmatter、
     * `## 约定` 一节）在"改智能体指令"时是错的：那边的产出是 `instructions.md`
     * （纯文本、有字符上限），没有 frontmatter 也没有那两节。
     * 加了限定语，模型才不会拿 skill 的结构去套指令。
     */
    assert.ok(
      DRAFTER_INSTRUCTIONS.includes('写 skill 时，交付要过入库闸门'),
      '★ 入库闸门那条必须限定"写 skill 时"（改指令没有 frontmatter / 两节）',
    )
    assert.ok(
      DRAFTER_INSTRUCTIONS.includes('改智能体指令时'),
      '★ 要明说改指令时交付什么由任务书定（instructions.md + 字符上限）',
    )
    assert.ok(
      DRAFTER_INSTRUCTIONS.includes('改智能体指令时把它落成指令里的硬约束'),
      '★ 「使用者的要求是默认约定」这条也要说明在改指令时怎么落',
    )
    // 通用的那几条**不需要**限定语（两个任务都成立），所以它们保持原样：
    for (const generic of ['先看素材索引，再按需读', '写 Procedure 前回查原始命令']) {
      assert.ok(DRAFTER_INSTRUCTIONS.includes(generic), `通用条款不该被改坏：${generic}`)
    }
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
