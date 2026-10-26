import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import type { Agent, WorkspaceId } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { planAgentLegacyCleanup, runAgentLegacyCleanupOnce } from './agent-legacy-cleanup.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 「不要遗留旧数据」——老 agent 记录里撤掉的字段要**真的**从库里消失（2026-10）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这个文件必须存在：这条要求有一个特别好用的假实现
 * ══════════════════════════════════════════════════════════════════
 *
 * 撤掉字段（`reviewerAgentId` 与行动权限那三个）之后，只要在读的时候把它们摘掉，
 * **界面看上去就完全干净了**：`GET /api/agents` 里没有那几个键、编辑页也不会显示
 * 它们。做到这一步很容易，而且很容易误以为"清完了"。
 *
 * 但使用者要的是**数据里也没有**（他原话："不要遗留旧数据。至少我重新保存智能体后，
 * 要移除旧数据"）——因为老键会继续出现在导出、快照与排查里，也会在
 * `{...老记录, ...patch}` 这类合并里被原样带回去。
 *
 * ⚠️ 这个文件的第一版自己就踩了"假实现"：清理读的是 `store.getAgent`，而那个方法
 *    **已经过读时兜底**⇒ 读回来"看起来本来就干净"⇒ 判据永远为空 ⇒ 整个启动清理是
 *    空转。所以下面每一条都同时钉两件事：
 *
 *     ① **前提**：老键真的在库里（用 `listAgentsRaw` 看，那是绕过总闸的原始读法）；
 *     ② **结论**：清理之后那个键不在库里了。
 *
 *    少了 ①，这个文件会在"清理没跑"和"老数据本来就没有"两种情况下**都**通过。
 */

/** 执行任何 run 都会立刻失败的后端：这个文件只关心库里的记录。 */
const deadBackend = {
  key: 'claude',
  protocol: 'stream-json',
  rejectDetectable: true,
  async probe() {
    return { available: false, command: 'claude', cliVersion: null }
  },
  async execute() {
    throw new Error('这个测试不该执行任何 run')
  },
} as never

/** 撤掉的四个键（与 `packages/protocol/src/agent-legacy.ts` 的清单一致）。 */
const DEAD_KEYS = ['reviewerAgentId', 'allowedActions', 'debugActions', 'actionParams']

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await cleanup(dir)
})

/** 起一个 daemon，并把它启动时打的日志收下来（"清理了谁"就在里面）。 */
async function boot(dataDir: string): Promise<{ daemon: DaemonHandle; logs: string[] }> {
  const logs: string[] = []
  const daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend: deadBackend,
    onWarn: () => {},
    onInfo: (m) => logs.push(m),
  })
  return { daemon, logs }
}

async function tempDataDir(tag: string): Promise<string> {
  const dir = await makeTempDir(tag)
  dirs.push(dir)
  return dir
}

async function firstWorkspace(d: DaemonHandle): Promise<WorkspaceId> {
  const ids = await d.store.listWorkspaceIds()
  assert.ok(ids.length > 0, '前提：启动后至少有一个工作区')
  return ids[0]!
}

/** 库里那条记录的**原始**形态（绕过读时兜底，所以能看见老键）。 */
async function rawAgent(d: DaemonHandle, id: string): Promise<Record<string, unknown>> {
  const ws = await firstWorkspace(d)
  const found = (await d.store.listAgentsRaw(ws)).find((a) => (a.id as string) === id)
  assert.ok(found, `前提：库里应当有 agent ${id}`)
  return found as unknown as Record<string, unknown>
}

async function createAgent(url: string, body: unknown): Promise<string> {
  const res = await fetch(`${url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // ⚠️ body 只能读一次：先读成文本，再 `.json()`（模板串里的 `await res.text()`
  //    是**求值就执行**的——即使断言通过也会把 body 吃掉，这条踩过一次）
  const text = await res.text()
  // 创建成功是 201（POST 造了新东西）
  assert.equal(res.status, 201, `造 agent 应当成功：${text}`)
  return (JSON.parse(text) as { id: string }).id
}

/**
 * 把一个 agent 改回**老形态**（模拟升级前留下的那类记录）。
 *
 * ⚠️ 只能直接落库：写入口已经不认识那几个键了（写了就是 400），这正是"三层"里的
 *    第三层。所以这里绕到 store 上，把老记录原样写回去——它就是磁盘上真实存在的
 *    那种记录。
 */
async function makeLegacy(d: DaemonHandle, id: string, extra: Record<string, unknown>): Promise<void> {
  const raw = await rawAgent(d, id)
  await d.store.insertAgent({ ...raw, ...extra } as unknown as Agent)
}

describe('★ 老记录清理：撤下的字段要从**库里**消失（不只是"看不见"）', () => {
  test('★★ 重启一次：读时兜底看不见的老键，在库里也真的没了', async () => {
    const dataDir = await tempDataDir('legacy-cleanup')
    const { daemon: d1 } = await boot(dataDir)
    // ★ 这两个 id 要在**重启之后**接着用（结论那几步），所以声明在两次 boot 之外
    let executorId: string
    let reviewerId: string
    /** 重启之前那一格「指令」的原值（分批第 47 批：清理前后必须一致）。 */
    let instructionsBefore = ''
    try {
      executorId = await createAgent(d1.url, {
        name: '老执行者',
        role: 'executor',
        instructions: '干活的。',
      })
      reviewerId = await createAgent(d1.url, {
        name: '老审核者',
        role: 'reviewer',
        reviewStandard: { name: '老标准', body: '# 老标准\n\n只看有没有写测试。' },
      })

      // 把这两条改成"升级前留下的样子"：执行者指着审核者、审核者身上带着行动权限
      await makeLegacy(d1, executorId, { reviewerAgentId: reviewerId })
      await makeLegacy(d1, reviewerId, {
        allowedActions: ['legacy-tool.act'],
        debugActions: ['legacy-tool.debug'],
        actionParams: { 'legacy-tool.act': { text: '嗯' } },
      })
      // 老数据里那三个键也内嵌在标准里过（同一个字段名，两层都出现过）
      const std = { name: '老标准', body: '# 老标准\n\n只看有没有写测试。', allowedActions: ['legacy-tool.act'] }
      await makeLegacy(d1, reviewerId, { reviewStandard: std })

      // ── ① 前提：库里真的有那几个键（否则下面全是空过） ──
      const rawExecutor = await rawAgent(d1, executorId)
      assert.equal(rawExecutor['reviewerAgentId'], reviewerId, '前提：老键真的写进去了')
      const rawReviewer = await rawAgent(d1, reviewerId)
      instructionsBefore = String(rawReviewer['instructions'] ?? '')
      for (const key of ['allowedActions', 'debugActions', 'actionParams']) {
        assert.equal(key in rawReviewer, true, `前提：${key} 真的写进去了`)
      }
      assert.equal(
        'allowedActions' in (rawReviewer['reviewStandard'] as Record<string, unknown>),
        true,
        '前提：标准内嵌的那一份也在',
      )

    } finally {
      await d1.close()
    }

    // ── ③ 重启：这一次启动会把库里的老键摘掉 ──
    const { daemon: d2, logs } = await boot(dataDir)
    try {
      // 日志要说清"清了谁、删了哪几个键"（这件事**不进通知中心**：字段下线不是
      // "需要你介入"的事，见 `agent-legacy-cleanup.ts` 的边界 2）
      const aboutExecutor = logs.find((m) => m.includes('老执行者') && m.includes('清掉了'))
      const aboutReviewer = logs.find((m) => m.includes('老审核者') && m.includes('清掉了'))
      assert.ok(aboutExecutor, `★ 启动日志要说清清了谁：\n${logs.join('\n')}`)
      assert.match(aboutExecutor!, /reviewerAgentId/, '要说清删了哪一个键')
      assert.ok(aboutReviewer, '★ 审核者那条也要有')
      assert.match(aboutReviewer!, /allowedActions/)
      assert.match(aboutReviewer!, /reviewStandard\.allowedActions/, '带路径的那种写法要说出来')
      assert.ok(
        logs.some((m) => /老 agent 记录清理完成：2 条记录/.test(m)),
        '★ 要有一句汇总（一条都没动也要能看出来，那是"库本来就干净"）',
      )

      // ── ④ 结论：**库里**没有老键了（原始读法，绕过读时兜底） ──
      const rawExecutor2 = await rawAgent(d2, executorId)
      assert.equal(
        'reviewerAgentId' in rawExecutor2,
        false,
        '★ 磁盘上那个键必须真的没了——这就是"不要遗留旧数据"',
      )
      const rawReviewer2 = await rawAgent(d2, reviewerId)
      for (const key of DEAD_KEYS) {
        assert.equal(key in rawReviewer2, false, `★ 磁盘上 ${key} 必须真的没了`)
      }
      assert.equal(
        'allowedActions' in (rawReviewer2['reviewStandard'] as Record<string, unknown>),
        false,
        '★ 标准内嵌的那一份也要摘掉',
      )

      // ── ⑤ 而**在用的字段一个都没丢**（清理越界是最贵的那种错） ──
      assert.equal(rawReviewer2['name'], '老审核者')
      assert.equal(rawReviewer2['role'], 'reviewer')
      /**
       * ⚠️ 分批第 47 批：这条原来断言 `instructions === ''`——那是"新建时指令为空"的
       * 副作用。现在新建会**预填默认工作守则**（使用者的要求），所以"空"不再是
       * 新 agent 的自然状态。改成**前后对比**：清理不许改动这一格（这才是本段的意图：
       * "在用的字段一个都没丢"，与它是空还是守则无关）。
       */
      assert.equal(
        rawReviewer2['instructions'],
        instructionsBefore,
        '★ 清理不许碰「指令」（前后必须一模一样）',
      )
      const std2 = rawReviewer2['reviewStandard'] as Record<string, unknown>
      assert.equal(std2['name'], '老标准', '★ 标准的正文与名字一个字都不能动')
      assert.equal(std2['body'], '# 老标准\n\n只看有没有写测试。')
      assert.equal(rawExecutor2['name'], '老执行者', '执行者那条除了那个键之外都照旧')
      assert.equal(rawExecutor2['role'], 'executor')
    } finally {
      await d2.close()
    }
  })

  test('★★ 读时兜底：老键刚写进库、还没重启，读出来也不带它们', async () => {
    // ⚠️ 这条是"三层"的第一层，也是最容易被忽略的一层：一个**还没重启**的旧
    //    daemon（或者重启之前的这一段时间）仍会读到老记录。总闸必须在读那一层。
    const dataDir = await tempDataDir('legacy-read-gate')
    const { daemon: d } = await boot(dataDir)
    try {
      const id = await createAgent(d.url, { name: '刚被写成老形态的人', role: 'reviewer' })
      await makeLegacy(d, id, {
        reviewerAgentId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
        allowedActions: ['legacy-tool.act'],
        debugActions: [],
        actionParams: {},
      })

      // 原始读法看得见（前提）
      assert.equal((await rawAgent(d, id))['allowedActions'] !== undefined, true)

      // 而**所有**读路径都看不见：两个 store 方法 + 两个 API 端点
      const got = (await d.store.getAgent(id as Agent['id']))!
      for (const key of DEAD_KEYS) {
        assert.equal(key in (got as unknown as Record<string, unknown>), false, `store 读出来不带 ${key}`)
      }
      const viaApi = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<Record<string, unknown>>
      }).agents.find((a) => a.id === id)!
      for (const key of DEAD_KEYS) {
        assert.equal(key in viaApi, false, `列表接口不带 ${key}`)
      }
      const one = ((await (
        await fetch(`${d.url}/api/agents/${encodeURIComponent(id)}`)
      ).json()) as Record<string, unknown>)
      for (const key of DEAD_KEYS) {
        assert.equal(key in one, false, `单条接口不带 ${key}`)
      }
    } finally {
      await d.close()
    }
  })

  test('★ 第三层：重新保存（PATCH）之后，库里那条记录也不带老键了', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 使用者的原话就是这一条：「至少我重新保存智能体后，要移除旧数据」
     * ══════════════════════════════════════════════════════════════════
     *
     * 保存那条路的实现是 `{...current, ...patch}`，而 `current` 来自 `getAgent`
     * （已过读时兜底）⇒ 老键在合并**之前**就没了 ⇒ 写回去的记录也是干净的。
     *
     * ⚠️ 这条不能靠"PATCH 之后 API 不带老键"来判——那是读时兜底在起作用，与保存
     *    无关（老键还在库里）。判据必须是**原始读法**：改完之后 `listAgentsRaw`
     *    里那个键也不在。
     */
    const dataDir = await tempDataDir('legacy-resave')
    const { daemon: d } = await boot(dataDir)
    try {
      const id = await createAgent(d.url, {
        name: '重新保存的人',
        role: 'reviewer',
        reviewStandard: { name: '标准', body: '# 标准\n\n判判看。' },
      })
      await makeLegacy(d, id, {
        reviewerAgentId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
        allowedActions: ['legacy-tool.act'],
        actionParams: { 'legacy-tool.act': {} },
      })
      assert.equal('allowedActions' in (await rawAgent(d, id)), true, '前提：老键真的在库里')

      // 重新保存（改一句指令）
      //
      // ⚠️ 这里**带上 `reviewStandard`**（界面上就是两个字段一起提交的）：
      //    不带它会被另一步"把老的内联标准并进指令"接走（`foldInOnSave`，2026-09
      //    的老数据迁移），那是另一件事——本条要验的是**撤掉的那几个键**在保存时
      //    进不来，混在一起会让失败时看不出是谁干的。
      const res = await fetch(`${d.url}/api/agents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instructions: '改一句。',
          reviewStandard: { body: '# 标准\n\n判判看。' },
        }),
      })
      assert.equal(res.status, 200, `保存应当成功：${await res.text()}`)

      const raw = await rawAgent(d, id)
      assert.equal(raw['instructions'], '改一句。', '前提：改动真的落库了（不是"没保存"）')
      for (const key of DEAD_KEYS) {
        assert.equal(
          key in raw,
          false,
          `★ 重新保存之后库里不该再有 ${key}——老键就是在这里被"原样带回去"的`,
        )
      }
      // 在用的字段照旧
      assert.equal(raw['name'], '重新保存的人')
      assert.equal((raw['reviewStandard'] as Record<string, unknown>)['body'], '# 标准\n\n判判看。')
    } finally {
      await d.close()
    }
  })
})

describe('★ 清理函数本身：计划与写库是分开的（便于单测，也便于说清"动了什么"）', () => {
  test('计划里逐条列出"谁、删哪几个键"，不写库', async () => {
    const dataDir = await tempDataDir('legacy-plan')
    const { daemon: d } = await boot(dataDir)
    try {
      const id = await createAgent(d.url, { name: '计划里的人', role: 'reviewer' })
      await makeLegacy(d, id, { allowedActions: ['a.b'] })

      const ws = await firstWorkspace(d)
      const plan = planAgentLegacyCleanup(await d.store.listAgentsRaw(ws))

      const item = plan.changed.find((c) => c.agentId === id)
      assert.ok(item, '计划里要有这一条')
      assert.equal(item!.agentName, '计划里的人', '要带上名字：启动日志是给人看的')
      assert.deepEqual(item!.removed, ['allowedActions'])
      assert.ok(plan.scanned >= 1, '扫过的条数也要报出来（"一条都没动"是要能看出来的）')

      // ★ 计划是**纯**的：算完之后库里还是老样子
      assert.equal('allowedActions' in (await rawAgent(d, id)), true, '只算不写')
    } finally {
      await d.close()
    }
  })

  test('库本来就是干净的 ⇒ 一条都不动，返回 0（汇总日志也不打）', async () => {
    const dataDir = await tempDataDir('legacy-noop')
    const { daemon: d } = await boot(dataDir)
    try {
      await createAgent(d.url, { name: '干净的人', role: 'reviewer' })
      const logs: string[] = []
      const result = await runAgentLegacyCleanupOnce({ store: d.store, info: (m) => logs.push(m) })

      assert.equal(result.changed, 0, '没有老字段就不该有"改动"')
      assert.ok(result.scanned >= 1, '但扫过的条数照旧报出来')
      assert.deepEqual(logs, [], '一条都没动时不该打"清理完成"（那句话会让人以为动过什么）')
    } finally {
      await d.close()
    }
  })
})