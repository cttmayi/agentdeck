import { after, before, describe, test } from 'node:test'
import { deliveredText } from './testing/delivered.ts'
import assert from 'node:assert/strict'
import {
  AsyncQueue,
  buildBlocks,
  DEFAULT_TEMPLATES,
  MATERIAL_MARKERS,
  renderFirstSentence,
  SAMPLE_EXECUTE_INPUT,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import {
  ulid,
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type Agent,
} from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { createChainGroup } from './testing/chain.ts'
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
  /** 两块分开记（A 档下 ①② 在系统提示里，③ 在 prompt 里）。 */
  seenSystem: string[] = []
  seenUser: string[] = []

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
    this.seen.push(deliveredText(opts))
    this.seenSystem.push(opts.systemPrompt ?? '')
    this.seenUser.push(opts.prompt)
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
): Promise<{
  runId: string
  issueId: string
  /** 两块合起来（"它被交代了什么"）。 */
  delivered: string
  /** A 档下的两块：①② 与 ③。 */
  system: string
  user: string
}> {
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
  return {
    runId,
    issueId,
    delivered: backend.seen[backend.seen.length - 1]!,
    system: backend.seenSystem[backend.seenSystem.length - 1]!,
    user: backend.seenUser[backend.seenUser.length - 1]!,
  }
}

const setTemplates = async (patch: Record<string, unknown>): Promise<{ status: number; body: unknown }> =>
  json('/api/first-sentence/templates', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

const getTemplates = async (): Promise<{
  status: number
  body: { current: Record<string, Record<string, string>> }
}> => (await json('/api/first-sentence/templates')) as never

/**
 * 快捷方式：只设一个框（其余不传 = 不动）。例如
 * `setTemplates({ execute: { frame: '…' } })`。
 */
const setBlock = (kind: string, block: string, text: string) =>
  setTemplates({ [kind]: { [block]: text } })

describe('D32：第一句话模版是全局配置（接口与写入口）', () => {
  test('★ 变量表、默认模版、以及**当前生效的那几份**由接口给出（三框形状）', async () => {
    const { status, body } = await getTemplates()
    assert.equal(status, 200)
    const payload = body as unknown as {
      defaults: Record<string, Record<string, string>>
      variables: Array<{ name: string; block: string; kinds: string[]; label: string }>
      current: Record<string, Record<string, string>>
    }
    // 2026-10：默认模版按「链路 × 块」——框架框就是老的那份，身份/任务框默认是变量
    assert.equal(payload.defaults['execute']!['frame'], DEFAULT_TEMPLATES.execute.frame, '默认模版要与代码里那份一致')
    assert.equal(payload.defaults['review']!['frame'], DEFAULT_TEMPLATES.review.frame)
    assert.equal(payload.defaults['execute']!['identity'], '{{identity}}')
    assert.equal(payload.defaults['execute']!['task'], '{{task}}')
    assert.equal(payload.defaults['chat']!['frame'], DEFAULT_TEMPLATES.chat.frame)

    const names = payload.variables.map((v) => v.name)
    // 2026-09：六个变量退役（身份/任务/材料由平台放）；2026-10：加 {{identity}} / {{task}} 两条
    assert.deepEqual(names, [
      'runId',
      'subjectType',
      'subjectId',
      'language',
      'skills',
      'reportKind',
      'issueId',
      'previousContext',
      'verdict',
      'identity',
      'task',
    ])
    for (const v of payload.variables) {
      assert.ok(v.label.length > 0, `${v.name} 要有中文说明`)
      assert.ok(Array.isArray(v.kinds) && v.kinds.length > 0)
      assert.ok(['frame', 'identity', 'task'].includes(v.block), `${v.name} 要有块归属`)
    }

    // 一开始没人设过模版 ⇒ 三块都是空（= 平台默认）
    // （defaultAgentId 是 D36 的，首启会把它设成播种的执行者——这里只断言模版）
    assert.equal(payload.current['execute']!['frame'], '')
    assert.equal(payload.current['execute']!['identity'], '')
    assert.equal(payload.current['execute']!['task'], '')
    assert.equal(payload.current['review']!['frame'], '')
  })

  test('★ 预览走的是真渲染器：空模版就等于直接渲染默认那段（按块）', async () => {
    const custom = '# 干活单\n\n- run：`{{runId}}`\n\n## 干活\n\n（这是自定义模版）'
    const preview = await postJson('/api/first-sentence/preview', {
      kind: 'execute',
      block: 'frame',
      template: custom,
    })
    assert.equal(preview.status, 200)
    assert.match((preview.body as { text: string }).text, /这是自定义模版/)
    assert.match(
      (preview.body as { text: string }).text,
      /# 干活单/,
      '★ 模版里写的标题要真的出现（D35：标题归模版）',
    )
    // 预览只渲染这一块 ⇒ 任务正文（③ 的内容）不在这里——它在「任务框」的预览里（见下一条）

    const asDefault = await postJson('/api/first-sentence/preview', {
      kind: 'execute',
      block: 'frame',
      template: '',
    })
    assert.equal(asDefault.status, 200)
    assert.equal(
      (asDefault.body as { text: string }).text,
      buildBlocks(SAMPLE_EXECUTE_INPUT).frame,
      '空模版 = 默认框架那块（与真实投递同一台渲染器）',
    )
  })

  test('★ 预览 ② 身份框 / ③ 任务框：{{identity}} / {{task}} 展开成平台组装的那整块', async () => {
    const identity = await postJson('/api/first-sentence/preview', {
      kind: 'execute',
      block: 'identity',
      template: '## 你的角色\n\n{{identity}}',
    })
    assert.equal(identity.status, 200, JSON.stringify(identity.body))
    const identityText = (identity.body as { text: string }).text
    assert.match(identityText, /## 你的角色/)
    assert.match(identityText, /严谨的协作者/, '示例 agent 的指令要插进去')

    const task = await postJson('/api/first-sentence/preview', {
      kind: 'execute',
      block: 'task',
      template: '## 你要干的是\n\n{{task}}',
    })
    assert.equal(task.status, 200, JSON.stringify(task.body))
    const taskText = (task.body as { text: string }).text
    assert.match(taskText, /## 你要干的是/)
    assert.match(taskText, /冒泡排序/, '示例任务正文要插进去')
  })

  test('★ 非法模版在**预览**里就被拦下，错误与保存时是同一句', async () => {
    const bad = { kind: 'execute', block: 'frame', template: '{{runId}}\n{{nonsense}}' }
    const preview = await postJson('/api/first-sentence/preview', bad)
    assert.equal(preview.status, 400)
    const message = (preview.body as { error: string }).error
    assert.match(message, /不认识/)

    const saved = await setTemplates({ execute: { frame: bad.template } })
    assert.equal(saved.status, 400)
    assert.equal((saved.body as { error: string }).error, message, '预览与保存必须给同一句错')
  })

  test('★★ 聊天那一份模版**真的存得进去、读得回来、预览得了**（第三个页签不能是个摆设）', async () => {
    /**
     * ⚠️ 这条测试守着一个**静默失效**：设置里那个「聊天」页签把 `chatTemplate`
     *   放进 `PUT` 的请求体，而写入口原来只遍历它认识的那两个 key
     *   （`executeTemplate` / `reviewTemplate`）——于是界面照常提示"已保存"，
     *   库里那个键**一个字都没写**，聊天仍然用平台默认那份。
     *
     *    使用者看到的现象是"我改了聊天模版，它不生效"，而没有任何一处会报错。
     *    同类：预览接口原来只收 execute / review，点第三个页签的「预览」直接
     *    得到一句"kind 必须是 execute 或 review"。
     *
     * 2026-10 起写入口遍历 `ALL_KINDS × TEMPLATE_BLOCKS` 的完整叉积——加第三条链路
     * 或第三块时自动就认识它。这里守的是「聊天」这条链路、以及「任务框」这块。
     */
    const custom = '## 聊天框架\n\n- 语言：{{language}}\n\n（这是自定义的聊天模版）'
    const saved = await setTemplates({ chat: { frame: custom } })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(
      (await getTemplates()).body.current['chat']!['frame'],
      custom,
      '★ 存下去又读回来必须是同一份（原来它被静默丢掉）',
    )
    // 另外两份没被这次保存动到
    assert.equal((await getTemplates()).body.current['execute']!['frame'], '')

    const preview = await postJson('/api/first-sentence/preview', {
      kind: 'chat',
      block: 'frame',
      template: custom,
    })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.match((preview.body as { text: string }).text, /这是自定义的聊天模版/)

    // 聊天也有身份框/任务框：身份框存得进、任务框缺 {{task}} 会被拒
    const chatIdentity = await setTemplates({ chat: { identity: '## 聊天身份\n\n{{identity}}' } })
    assert.equal(chatIdentity.status, 200, JSON.stringify(chatIdentity.body))
    assert.equal(
      (await getTemplates()).body.current['chat']!['identity'],
      '## 聊天身份\n\n{{identity}}',
    )
    const chatTaskMissing = await setTemplates({ chat: { task: '## 聊\n\n没放变量' } })
    assert.equal(chatTaskMissing.status, 400, '聊天任务框缺 {{task}} 该被拒（三条链路都必需）')

    // 清空 = 回到平台默认（不是"存了一个空模版"）
    await setTemplates({ chat: { frame: '', identity: '', task: '' } })
    const cleared = (await getTemplates()).body.current['chat'] as Record<string, string>
    assert.equal(cleared['frame'], '')
    assert.equal(cleared['identity'], '')
    assert.equal(cleared['task'], '')
  })

  test('★ 缺必需变量 / 退役变量 / 用错链路的变量 ⇒ 400，且错误解释得清', async () => {
    // 执行那份现在**没有必需变量**（判决契约只在审核档）⇒ 一句没有变量的话也合法
    const executeOk = await setBlock('execute', 'frame', '## 干活\n\n干吧')
    assert.equal(executeOk.status, 200, JSON.stringify(executeOk.body))
    await setBlock('execute', 'frame', '')

    // 退役变量：**不再报错**，而是迁移（摘掉）——见下面那组专测
    const retired = await setBlock('execute', 'frame', '{{runId}}\n\n{{prompt}}')
    assert.equal(retired.status, 200, '老模版要能存进去（迁移后再存）')
    assert.doesNotMatch(
      (await getTemplates()).body.current['execute']!['frame']!,
      /\{\{prompt\}\}/,
      '存下去的是迁移后的那份',
    )
    await setBlock('execute', 'frame', '')

    // 用错链路：verdict 只属于审核模版
    const wrongKind = await setBlock('execute', 'frame', '{{verdict}}')
    assert.equal(wrongKind.status, 400)
    assert.match((wrongKind.body as { error: string }).error, /只属于审核模版/)

    // 用错块：{{identity}} / {{task}} 只属于各自的框（2026-10）
    const identityInFrame = await setBlock('execute', 'frame', '## 角色\n\n{{identity}}')
    assert.equal(identityInFrame.status, 400)
    assert.match((identityInFrame.body as { error: string }).error, /② 身份/)
    const taskInIdentity = await setBlock('execute', 'identity', '## 干活\n\n{{task}}')
    assert.equal(taskInIdentity.status, 400)
    assert.match((taskInIdentity.body as { error: string }).error, /③ 任务/)

    /**
     * ★ 聊天是**第三条链路**（2026-09）：它同样没有判决契约。
     *
     * ⚠️ 这条守着一句"错话"：判据原来是从当前 kind **反推**另一条链路
     *   （`kind === 'execute' ? 'review' : 'execute'`），于是聊天模版里写
     *   `{{verdict}}` 会被说成"只属于**执行**模版"——两条都不对，而使用者照着
     *   这句话去找，只会在两条链路之间来回试。
     */
    const chatWrongKind = await setBlock('chat', 'frame', '{{verdict}}')
    assert.equal(chatWrongKind.status, 400)
    assert.match(
      (chatWrongKind.body as { error: string }).error,
      /只属于审核模版/,
      '聊天里的 {{verdict}} 属于审核，不属于执行',
    )
    await setBlock('chat', 'frame', '')

    const nonString = await setTemplates({ execute: { frame: 42 } })
    assert.equal(nonString.status, 400)
    // 非对象 / 不认识的块：同样 400
    const notObject = await setTemplates({ execute: '## 直接一段' })
    assert.equal(notObject.status, 400)
    const unknownBlock = await setTemplates({ execute: { nope: 'x' } })
    assert.equal(unknownBlock.status, 200, '不认识的块被忽略（PATCH 语义：只动传了的键）')

    // 审核那份必须有判决契约（材料与标记现在由平台放，不在模版里）
    const reviewMissing = await setBlock('review', 'frame', '{{runId}}')
    assert.equal(reviewMissing.status, 400)
    assert.match((reviewMissing.body as { error: string }).error, /verdict/)
  })

  test('★ 被拒的写法不落库；设上之后读得回；清空 = 回到平台默认', async () => {
    const before = (await getTemplates()).body.current

    await setTemplates({ execute: { frame: '{{promt}}\n{{runId}}' } })
    assert.deepEqual((await getTemplates()).body.current, before, '被拒的写法不该落库')

    const ok = await setBlock('execute', 'frame', '{{runId}}\n\n（全局模版）')
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.match((await getTemplates()).body.current['execute']!['frame']!, /全局模版/)

    const cleared = await setBlock('execute', 'frame', '')
    assert.equal(cleared.status, 200)
    assert.equal((await getTemplates()).body.current['execute']!['frame'], '')
  })

  test('★ 老数据（加字段之前建的 workspace）读回来是空串，不是 undefined', async () => {
    // store 是"存什么读什么"，不做 schema 迁移。直接把 workspace 写成**没有那些键**
    // 的样子——这就是加字段那天之前库里那一行的形状。
    const id = (await daemon.store.listWorkspaceIds())[0]!
    const legacy = await daemon.store.getWorkspace(id)
    assert.ok(legacy)
    const stripped = { ...legacy } as Record<string, unknown>
    delete stripped['executeTemplate']
    delete stripped['reviewTemplate']
    delete stripped['chatTemplate']
    // 2026-10 后加的六个键（身份/任务框）老数据里也没有
    delete stripped['executeIdentityTemplate']
    delete stripped['executeTaskTemplate']
    delete stripped['reviewIdentityTemplate']
    delete stripped['reviewTaskTemplate']
    delete stripped['chatIdentityTemplate']
    delete stripped['chatTaskTemplate']
    // D36 那个字段也是同一类：加它之前建的 workspace 里根本没有这个键
    delete stripped['defaultAgentId']
    await daemon.store.insertWorkspace(stripped as never)

    const { body } = await getTemplates()
    const current = (body as { current: Record<string, Record<string, string>> }).current
    assert.equal(current['execute']!['frame'], '', '缺键要补成空串（空 = 平台默认）')
    assert.equal(current['execute']!['identity'], '')
    assert.equal(current['execute']!['task'], '')
    assert.equal(current['review']!['frame'], '')
    assert.equal(current['chat']!['frame'], '')
  })
})

describe('D32：全局模版真的被投递（所有 agent 都按它来）', () => {
  test('★ 两个**不同**的 agent 走同一条执行链路，用的是同一份模版', async () => {
    // 2026-09：模版**只是框架**（①）。身份（②）与任务（③）由平台放，
    // 所以这份模版里不再有 `{{instructions}}` / `{{prompt}}`——它们已经退役。
    const template = [
      '# 任务',
      '',
      '- run：`{{runId}}`',
      '- 对象：{{subjectType}} `{{subjectId}}`',
      '',
      '## 交活儿',
      '',
      '- 干完说一句「我的全局模版生效了」。',
    ].join('\n')

    const set = await setTemplates({ execute: { frame: template } })
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
      // ★ 2026-09：runtime 支持系统提示（claude 支持）⇒ 走 **A 档**：① 框架 + ② 身份
      //   在 `systemPrompt` 里，③ 任务在 `prompt` 里。块名（`===== ① 框架 =====`）只在
      //   B 档那一档才有——它是"三块共处一段"时的边界，A 档的边界就是两条通道本身。

      assert.match(first.delivered, /你是个木匠。/, '身份（②）随这次投递一起送到')
      assert.match(first.delivered, /打一张桌子/, '任务正文（③）也在')
      assert.doesNotMatch(first.delivered, /\{\{/, '不该有没展开的变量')

      // 逐字节：模版是同一份，逐次变化的只有"这一次"的东西
      // （run id、issue、以及**这个 agent 自己的指令**与任务正文——后两者分别在 ②③）
      // A 档逐字：system = ① 框架 + ② 身份（空行分隔），user = ③ 任务
      const systemFor = (r: { runId: string; issueId: string }, role: string): string =>
        [
          '# 任务',
          '',
          `- run：\`${r.runId}\``,
          `- 对象：issue \`${r.issueId}\``,
          '',
          '## 交活儿',
          '',
          '- 干完说一句「我的全局模版生效了」。',
          '',
          role,
        ].join('\n')

      assert.equal(first.system, systemFor(first, '你是个木匠。'))
      // ③ 任务块 = 任务正文 + **平台强制的任务边界**（2026-10，任务隔离）：
      // 边界是安全件，由平台无条件追加，不依赖这份模版写了什么。
      assert.ok(first.user.startsWith('打一张桌子'), '任务正文在前')
      assert.match(first.user, /## 任务边界/)
      assert.match(first.user, /只在自己的工作目录里活动/)
      assert.equal(second.system, systemFor(second, '你是个铁匠。'))
      assert.ok(second.user.startsWith('打一把刀'), '任务正文在前')
      assert.match(second.user, /## 任务边界/)
    } finally {
      await cleanup(workDir)
      await setBlock('execute', 'frame', '')
    }
  })

  test('★ ② 身份框 / ③ 任务框真的被投递：标题与包装按模版来，内容仍是平台组装', async () => {
    const workDir = await makeTempDir('template-blocks')
    try {
      // 身份框：自己写标题，指令照旧插进来；任务框：自己写标题，任务正文照旧
      const set = await setTemplates({
        execute: {
          identity: '## 你的角色\n\n{{identity}}',
          task: '## 你要干的是\n\n{{task}}',
        },
      })
      assert.equal(set.status, 200, JSON.stringify(set.body))

      const agent = await makeAgent({ name: '三框执行者', instructions: '你是个谨慎的木匠。' })
      const run = await runExecute(agent, '打一张桌子', workDir)

      assert.match(run.system, /## 你的角色/, '身份框的标题要投递出去')
      assert.match(run.system, /你是个谨慎的木匠。/, '指令（② 的内容）照旧在')
      assert.match(run.user, /## 你要干的是/, '任务框的标题要投递出去')
      assert.match(run.user, /打一张桌子/, '任务正文（③ 的内容）照旧在')
      assert.doesNotMatch(run.system, /\{\{/, '不该有没展开的变量')
    } finally {
      await cleanup(workDir)
      await setTemplates({ execute: { identity: '', task: '' } })
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

    const reviewer = await makeAgent({
      name: '自定义模版的审核者',
      role: 'reviewer',
      skillIds: [skillId],
    })
    const executor = await makeAgent({ name: '执行者' })
    // ⚠️ 2026-10：这里原来是 `makeAgent({ reviewerAgentId: reviewer.id })`——那个
    //    字段已从 `Agent` 上撤掉（写它就是 400「不认识的字段」）。同一件事现在
    //    由**组**表达，而提交那条 run 时要带上组的 id。
    const groupId = await createChainGroup(
      { url: daemon.url },
      { name: '模版用例组', members: [executor.id, reviewer.id] },
    )

    // ★ 全局：只设一次，执行与审核两份各一份
    const set = await setTemplates({
      // 2026-09：模版只剩框架——材料、标记、标准、任务分别由平台放在 ②③
      review: {
        frame: '# 审核任务\n\n- run：`{{runId}}`\n\n（全局审核模版生效了）\n\n{{verdict}}',
      },
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
        // ★ 带组 ⇒ 自动串出审核 run（本用例要的就是"执行 + 审核两次投递"）
        groupId,
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
      // ★ 判决契约是**必需变量**，自定义模版也删不掉它
      assert.match(reviewText, /<<<ALPHA_VERDICT>>>/, '判决契约必须在')
      // ★ §3.3b：文件式审核（执行 run 串出来的）平台放的是**文件引用**，
      //   不是内联材料标记——内联那段是截断的转述，有文件就别再内联。
      assert.match(reviewText, /## 完整材料（文件）/, '文件式审核要放文件引用（平台放，模版删不掉）')
      assert.match(
        reviewText,
        /- 执行结果：`[^`]+rounds\/1-result\.md`/,
        '结果文件引用要在',
      )
      assert.doesNotMatch(reviewText, /<<<ALPHA_MATERIAL>>>/, '文件式审核不再内联材料')
      // A 档：标准并进 ②，而 ② 与 ① 一起走系统提示 ⇒ 认"内容在"而不是块名。
      // ⚠️ 这个审核者**没写指令** ⇒ ② 里只有标准（这正是"空则跳过"的另一半：
      //    一块里有标准就照发，不会因为没写指令而整块丢掉）。
      assert.doesNotMatch(reviewText, /===== ② 身份 =====/, 'A 档没有块名（那是 B 档的边界）')
      assert.match(reviewText, /探针标准/, '审核标准正文要跟着进去（并进 ②）')
      assert.doesNotMatch(reviewText, /^# 任务$/m, '执行模版不该串到审核这条路上')
    } finally {
      await cleanup(workDir)
      await setTemplates({ review: { frame: '' }, chat: { frame: '' } })
    }
  })
})

/**
 * ★★ 老模版（写着退役变量的那份）必须**能用**：读出来就迁移，存进去也迁移。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这两条是"不许失败"的
 * ══════════════════════════════════════════════════════════════════
 *
 * 六个变量（`{{instructions}}` / `{{prompt}}` / `{{standards}}` / `{{tools}}` /
 * `{{material}}` / `{{materialTitle}}`）退役之后，模版里写它们会被 `validateTemplate`
 * 拒掉。而使用者**已经存下来**的模版里就写着它们——两种坏法都不能出现：
 *
 *   · 拒绝 ⇒ 他重启 daemon 之后所有任务当场跑不起来，而那不是他做错了什么；
 *   · 静默摘掉 ⇒ 他以为模版还生效，实际投递的是另一份。
 *
 * 所以：迁移 + **如实报告**（`adjustments` / 日志各一处）。
 */
describe('2026-09：老模版迁移（读出与写入两条路）', () => {
  const OLD_TEMPLATE = [
    '# 任务',
    '',
    '{{instructions}}',
    '',
    '## 要做的事',
    '',
    '{{prompt}}',
    '',
    '{{#tools}}',
    '## 干活时能用的工具包',
    '',
    '{{tools}}',
    '{{/tools}}',
    '',
    '请用{{language}}回答。',
  ].join('\n')

  test('★ 存老模版**不再被拒**：先迁移再校验，而且存的是迁移后的那份', async () => {
    const saved = await setBlock('execute', 'frame', OLD_TEMPLATE)
    assert.equal(saved.status, 200, `老模版该能存：${JSON.stringify(saved.body)}`)
    const stored = (await getTemplates()).body.current['execute']!['frame']!
    assert.doesNotMatch(stored, /\{\{instructions\}\}|\{\{prompt\}\}|\{\{tools\}\}/)
    assert.match(stored, /请用\{\{language\}\}回答。/, '没退役的变量原样留着')
    assert.match(stored, /## 要做的事/, '结构还在')
    await setBlock('execute', 'frame', '')
  })

  test('★★ 库里那份**升级前存下的**老模版，读出来时被迁移，并如实报告调了什么', async () => {
    // ⚠️ 必须**直接写库**来模拟"升级前存下的"：走 PUT 的话它已经被迁移过了，
    //    那样测到的只是"迁移是幂等的"，不是"老数据被迁移"。
    const id = (await daemon.store.listWorkspaceIds())[0]!
    const ws = await daemon.store.getWorkspace(id)
    assert.ok(ws)
    await daemon.store.insertWorkspace({
      ...ws,
      executeTemplate: OLD_TEMPLATE,
      updatedAt: Date.now(),
    })

    const { adjustments } = (await getTemplates()).body as unknown as {
      adjustments: {
        execute: {
          frame: { removed: string[]; orphanLines: string[] }
          identity: { removed: string[]; orphanLines: string[] }
          task: { removed: string[]; orphanLines: string[] }
        }
      }
    }
    assert.deepEqual(
      [...adjustments.execute.frame.removed].sort(),
      ['instructions', 'prompt', 'tools'],
      '要说出摘掉了哪几个变量',
    )
    // 身份/任务框是新字段（老数据里没有）⇒ 没摘任何东西
    assert.deepEqual(adjustments.execute.identity.removed, [])
    assert.deepEqual(adjustments.execute.task.removed, [])
    await setBlock('execute', 'frame', '')
  })
})
