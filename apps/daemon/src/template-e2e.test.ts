import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AsyncQueue,
  DEFAULT_TEMPLATES,
  renderFirstSentence,
  SAMPLE_EXECUTE_INPUT,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@alpha-helper/agent-core'
import {
  ulid,
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type Agent,
} from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * D32 端到端：第一句话模版是**全局配置**，一次设定所有 agent 生效
 * ══════════════════════════════════════════════════════════════════
 *
 * 这一份盯的是**接线**，不是渲染（渲染在 agent-core 里自己有一份）：
 *
 *   - 写入口过校验，坏模版进不了库（错误还要说清后果）；
 *   - 设定之后，**任何一个** agent 的两条链路都按它来（而不是被默认模版盖掉——
 *     `agent.instructions` 当年就是这么"填了、存了、运行时丢掉"的）；
 *   - 界面上读到的那份与执行器投递的那份**是同一份**（同一个读函数）；
 *   - 老数据（加字段之前建的 workspace）读回来是空串，不是 `undefined`。
 *
 * ⚠️ 最初做成了"每个 agent 一份"，使用者当场纠正：**那是通用配置**。
 *    所以这一份里特意有两个不同的 agent 用同一份模版的用例。
 */

/** 只记录"这次被交代了什么"，其余按最小可用返回。 */
class RecordingBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 每次 run 投递出去的「第一句话」。 */
  seen: string[] = []

  /**
   * 产出。
   *
   * ★ 里面**带一份合法的判决**，这不是装饰：审核 run 拿不到判决时
   *   `decideReview` 会派一条**重试 run**，于是"执行 + 审核 = 两次投递"
   *   这条断言会数到三次。测试里数投递次数时，先让判决合法最省事
   *   （重试那条链路自己在 review-e2e 里另有专门的用例）。
   *   执行 run 的产出里多这几行也没关系——那边不解析判决。
   */
  output =
    '报告：我做完了。\n' +
    VERDICT_FENCE_BEGIN +
    '\n' +
    JSON.stringify({
      schemaVersion: 1,
      conclusion: 'pass',
      reasonCode: 'meets_criteria',
      confidence: 0.9,
      findings: [],
      action: null,
      escalateReason: null,
    }) +
    '\n' +
    VERDICT_FENCE_END

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seen.push(opts.prompt)
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: this.output })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: this.output,
        durationMs: 2,
        sessionId: 'template-session',
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

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

let dataDir: string
let daemon: DaemonHandle
let backend: RecordingBackend

before(async () => {
  dataDir = await makeTempDir('template-data')
  backend = new RecordingBackend()
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
})

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

const patchJson = (path: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  json(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function makeIssue(title: string): Promise<string> {
  const { body } = await postJson('/api/issues', { title })
  return (body as { id: string }).id
}

async function makeAgent(fields: Record<string, unknown>): Promise<Agent> {
  const { status, body } = await postJson('/api/agents', {
    role: 'executor',
    ...fields,
  })
  assert.equal(status, 201, `建 agent 失败了：${JSON.stringify(body)}`)
  return body as Agent
}

/** 起一条执行 run 并等它结束，返回 runId 与投递出去的那句话。 */
async function runExecute(
  agent: Agent,
  prompt: string,
  workDir: string,
): Promise<{ runId: string; issueId: string; delivered: string }> {
  const issueId = await makeIssue(`任务 ${ulid().slice(-6)}`)
  const runId = ulid()
  const before = backend.seen.length
  const { status, body } = await postJson('/api/runs', {
    runId,
    kind: 'execute',
    agentRef: { id: agent.id, name: agent.name, instructions: '' },
    skills: [],
    subject: { type: 'issue', id: issueId },
    prompt,
    workDir,
    limits: { maxTurns: null, timeoutMs: null },
  })
  assert.equal(status, 202, `起 run 失败了：${JSON.stringify(body)}`)
  await waitFor(async () => {
    const { body: run } = await json(`/api/runs/${runId}`)
    return TERMINAL.has((run as { status: string }).status) ? true : null
  })
  assert.equal(backend.seen.length, before + 1, '这次 run 应当恰好投递一句话')
  return { runId, issueId, delivered: backend.seen[backend.seen.length - 1]! }
}

const setTemplates = async (patch: Record<string, unknown>): Promise<{ status: number; body: unknown }> =>
  json('/api/first-sentence/templates', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

const getTemplates = async (): Promise<{ status: number; body: { current: Record<string, string> } }> =>
  (await json('/api/first-sentence/templates')) as never

describe('D32：第一句话模版是全局配置（接口与写入口）', () => {
  test('★ 变量表、默认模版、以及**当前生效的那两份**由接口给出', async () => {
    const { status, body } = await getTemplates()
    assert.equal(status, 200)
    const payload = body as unknown as {
      defaults: Record<string, string>
      variables: Array<{ name: string; kinds: string[]; label: string }>
      current: Record<string, string>
    }
    assert.equal(payload.defaults['execute'], DEFAULT_TEMPLATES.execute, '默认模版要与代码里那份一致')
    assert.equal(payload.defaults['review'], DEFAULT_TEMPLATES.review)

    const names = payload.variables.map((v) => v.name)
    assert.ok(names.includes('prompt') && names.includes('material') && names.includes('verdict'))
    for (const v of payload.variables) {
      assert.ok(v.label.length > 0, `${v.name} 要有中文说明`)
      assert.ok(Array.isArray(v.kinds) && v.kinds.length > 0)
    }

    // 一开始没人设过 ⇒ 两份都是空（= 平台默认）
    assert.deepEqual(payload.current, { executeTemplate: '', reviewTemplate: '' })
  })

  test('★ 预览走的是真渲染器：空模版就等于直接渲染默认那段', async () => {
    const custom = '{{header}}\n\n## 干活\n\n{{prompt}}\n\n（这是自定义模版）'
    const preview = await postJson('/api/first-sentence/preview', { kind: 'execute', template: custom })
    assert.equal(preview.status, 200)
    assert.match((preview.body as { text: string }).text, /这是自定义模版/)
    assert.match((preview.body as { text: string }).text, /冒泡排序/, '示例任务正文要插进去')

    const asDefault = await postJson('/api/first-sentence/preview', { kind: 'execute', template: '' })
    assert.equal(asDefault.status, 200)
    assert.equal(
      (asDefault.body as { text: string }).text,
      renderFirstSentence(SAMPLE_EXECUTE_INPUT),
    )
  })

  test('★ 非法模版在**预览**里就被拦下，错误与保存时是同一句', async () => {
    const bad = { kind: 'execute', template: '{{prompt}}\n{{nonsense}}' }
    const preview = await postJson('/api/first-sentence/preview', bad)
    assert.equal(preview.status, 400)
    const message = (preview.body as { error: string }).error
    assert.match(message, /不认识/)

    const saved = await setTemplates({ executeTemplate: bad.template })
    assert.equal(saved.status, 400)
    assert.equal((saved.body as { error: string }).error, message, '预览与保存必须给同一句错')
  })

  test('★ 缺必需变量 / 用错链路的变量 ⇒ 400，且错误解释得清', async () => {
    const missing = await setTemplates({ executeTemplate: '## 干活\n\n干吧' })
    assert.equal(missing.status, 400)
    assert.match((missing.body as { error: string }).error, /\{\{prompt\}\}/)

    const wrongKind = await setTemplates({ executeTemplate: '{{prompt}}\n{{material}}' })
    assert.equal(wrongKind.status, 400)
    assert.match((wrongKind.body as { error: string }).error, /只属于审核模版/)

    const nonString = await setTemplates({ executeTemplate: 42 })
    assert.equal(nonString.status, 400)

    // 审核那份同样要过（缺 material / verdict）
    const reviewMissing = await setTemplates({ reviewTemplate: '{{prompt}}\n{{material}}' })
    assert.equal(reviewMissing.status, 400)
    assert.match((reviewMissing.body as { error: string }).error, /verdict/)
  })

  test('★ 被拒的写法不落库；设上之后读得回；清空 = 回到平台默认', async () => {
    const before = (await getTemplates()).body.current

    await setTemplates({ executeTemplate: '{{promt}}\n{{prompt}}' })
    assert.deepEqual((await getTemplates()).body.current, before, '被拒的写法不该落库')

    const ok = await setTemplates({ executeTemplate: '{{header}}\n\n{{prompt}}\n\n（全局模版）' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.match((await getTemplates()).body.current['executeTemplate']!, /全局模版/)

    const cleared = await setTemplates({ executeTemplate: '' })
    assert.equal(cleared.status, 200)
    assert.equal((await getTemplates()).body.current['executeTemplate'], '')
  })

  test('★ 老数据（加字段之前建的 workspace）读回来是空串，不是 undefined', async () => {
    // store 是"存什么读什么"，不做 schema 迁移。直接把 workspace 写成**没有那两个键**
    // 的样子——这就是加字段那天之前库里那一行的形状。
    const id = (await daemon.store.listWorkspaceIds())[0]!
    const legacy = await daemon.store.getWorkspace(id)
    assert.ok(legacy)
    const stripped = { ...legacy } as Record<string, unknown>
    delete stripped['executeTemplate']
    delete stripped['reviewTemplate']
    await daemon.store.insertWorkspace(stripped as never)

    const { body } = await getTemplates()
    assert.deepEqual(
      (body as { current: Record<string, string> }).current,
      { executeTemplate: '', reviewTemplate: '' },
      '缺键要补成空串（空 = 平台默认 = 与加这个功能之前一样）',
    )
  })
})

describe('D32：全局模版真的被投递（所有 agent 都按它来）', () => {
  test('★ 两个**不同**的 agent 走同一条执行链路，用的是同一份模版', async () => {
    const template = [
      '{{header}}',
      '',
      '## 你的角色',
      '',
      '{{instructions}}',
      '',
      '## 活儿',
      '',
      '{{prompt}}',
      '',
      '## 交活儿',
      '',
      '- 干完说一句「我的全局模版生效了」。',
    ].join('\n')

    const set = await setTemplates({ executeTemplate: template })
    assert.equal(set.status, 200, JSON.stringify(set.body))

    const workDir = await makeTempDir('template-exec')
    try {
      // 两个 agent：名字、指令都不同 ⇒ 模版是**共用**的，agent 只贡献 {{instructions}}
      const a = await makeAgent({ name: '甲', instructions: '你是个木匠。' })
      const b = await makeAgent({ name: '乙', instructions: '你是个铁匠。' })

      const first = await runExecute(a, '打一张桌子', workDir)
      const second = await runExecute(b, '打一把刀', workDir)

      assert.match(first.delivered, /我的全局模版生效了/)
      assert.match(second.delivered, /我的全局模版生效了/)
      assert.doesNotMatch(first.delivered, /## 护栏/, '默认模版那两段护栏不该出现')
      assert.doesNotMatch(first.delivered, /\{\{/, '不该有没展开的变量')

      // 逐字节：模版是同一份，逐次变化的只有"这一次"的东西
      // （run id、issue、以及**这个 agent 自己的指令**与任务正文）
      const expectedFor = (
        r: { runId: string; issueId: string },
        role: string,
        task: string,
      ): string =>
        [
          '# 任务',
          '',
          `- run：\`${r.runId}\``,
          `- 对象：issue \`${r.issueId}\``,
          '',
          '## 你的角色',
          '',
          role,
          '',
          '## 活儿',
          '',
          task,
          '',
          '## 交活儿',
          '',
          '- 干完说一句「我的全局模版生效了」。',
        ].join('\n')

      assert.equal(first.delivered, expectedFor(first, '你是个木匠。', '打一张桌子'))
      assert.equal(second.delivered, expectedFor(second, '你是个铁匠。', '打一把刀'))
    } finally {
      await cleanup(workDir)
      await setTemplates({ executeTemplate: '' })
    }
  })

  test('★ 审核链路用的是**全局审核模版**，而且材料标记与判决契约仍在', async () => {
    // 审核者必须挂 skill（没标准的审核不算审核），所以先装一个
    const { body: installed } = await postJson('/api/skills', {
      skills: [
        {
          slug: 'template-probe-review',
          name: '模版探针标准',
          body: '# 探针标准\n\n只看一件事：产出里有没有写测试。',
        },
      ],
    })
    const skillId = (installed as { installed: Array<{ id: string }> }).installed[0]!.id

    const reviewer = await makeAgent({ name: '自定义模版的审核者', role: 'reviewer', skillIds: [skillId] })
    const executor = await makeAgent({ name: '执行者', reviewerAgentId: reviewer.id })

    // ★ 全局：只设一次，执行与审核两份各一份
    const set = await setTemplates({
      reviewTemplate:
        '{{header}}\n\n（全局审核模版生效了）\n\n## 这次要你做什么\n\n{{prompt}}\n\n{{material}}\n\n{{standards}}\n\n{{verdict}}',
    })
    assert.equal(set.status, 200, JSON.stringify(set.body))

    const workDir = await makeTempDir('template-review')
    try {
      const before = backend.seen.length
      const issueId = await makeIssue('走一遍自动串接')
      const runId = ulid()
      const started = await postJson('/api/runs', {
        runId,
        kind: 'execute',
        agentRef: { id: executor.id, name: executor.name, instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: '写点东西',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      })
      assert.equal(started.status, 202)

      // 执行 + 自动串接的审核 = 两次投递
      await waitFor(async () => {
        const { body } = await json('/api/runs')
        const runs = (body as { runs: Array<{ status: string }> }).runs
        return runs.length >= 2 && runs.every((r) => TERMINAL.has(r.status)) ? true : null
      })
      const delivered = backend.seen.slice(before)
      assert.equal(delivered.length, 2, `应当恰好两次投递（执行 + 审核），实际 ${delivered.length}`)

      const reviewText = delivered[1]!
      assert.match(reviewText, /全局审核模版生效了/, '★ 审核那条路必须用全局审核模版')
      assert.doesNotMatch(reviewText, /## 输出要求/, '默认模版的标题不该出现（被自定义模版换掉了）')
      // ★ 这两样是**必需变量**，自定义模版也删不掉它们
      assert.match(reviewText, /<<<ALPHA_MATERIAL>>>/, '材料标记必须在')
      assert.match(reviewText, /<<<ALPHA_VERDICT>>>/, '判决契约必须在')
      assert.match(reviewText, /探针标准/, '审核标准正文要跟着进去')
    } finally {
      await cleanup(workDir)
      await setTemplates({ reviewTemplate: '' })
    }
  })
})
