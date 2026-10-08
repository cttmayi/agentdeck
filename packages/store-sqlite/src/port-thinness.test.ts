import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Page, Store } from '@agentdeck/domain'
import {
  agentId,
  makeAgent,
  makeIssue,
  makeReport,
  makeRun,
  makeSkill,
  makeTool,
  runId,
  skillId,
  toolId,
  wsId,
} from '@agentdeck/domain/testing'
import type {
  ActionId,
  BlobRef,
  RunMessage,
  VerdictId,
  WorkspaceId,
} from '@agentdeck/protocol'
import { FileStore } from '../../store-file/src/file-store.ts'
import { SqliteStore } from './sqlite-store.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { loosePatch } from './testing/patches.ts'

/**
 * 端口纯洁性（FR-STOR-03）—— 守护"换存储不用改业务代码"。
 *
 * 这个文件做两件事：
 *
 * 1. **静态守卫**：端口本身不许出现存储实现词汇；SQL 适配器必须实现端口的
 *    每一个方法；状态机与"活动状态"必须来自领域层而不是适配器自己抄一份。
 * 2. **差分契约**：把同一串操作分别在文件适配器与 SQLite 适配器上跑一遍，
 *    逐项对比可观测结果。这是"两个适配器行为一致"最直接的证据——比对着
 *    文档逐条核对可靠得多，因为它会在任一边悄悄走样时立刻失败。
 *
 * ⚠️ 这里用相对路径 import 文件适配器，且**只在测试里**：`store-sqlite` 的
 * 运行期依赖只有 protocol 与 domain，两个适配器之间不允许互相依赖（否则
 * "换存储"就变成"换一半还要拖着另一半"）。测试需要同时持有两者才能做差分，
 * 这份耦合到此为止。
 */

const ADAPTER_PATH = fileURLToPath(new URL('./sqlite-store.ts', import.meta.url))
const PORT_PATH = fileURLToPath(new URL('../../domain/src/ports/store.ts', import.meta.url))

/** 从端口源码里抠出接口方法名（缩进两格的 `name(`）。 */
async function portMethodNames(): Promise<string[]> {
  const src = await readFile(PORT_PATH, 'utf8')
  return [...src.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]!)
}

describe('端口纯洁性（FR-STOR-03）', () => {
  test('★ 端口里不得出现 file / json / line / path 这类存储实现词汇', async () => {
    const methodNames = await portMethodNames()
    assert.ok(methodNames.length > 20, `应检出接口方法，实际只有 ${methodNames.length} 个`)

    const offenders = methodNames.filter((n) => /file|json|line|path|readall/i.test(n))
    assert.deepEqual(offenders, [], `端口方法名泄漏了存储实现：${offenders.join(', ')}`)
  })

  test('★ SQL 适配器实现了端口的每一个方法（少一个就编译不过的只有类型，运行期还得有）', async () => {
    const dir = await makeTempDir('thinness-impl')
    const store = await SqliteStore.open({ dataDir: dir, fsync: false })
    try {
      const names = await portMethodNames()
      const missing = names.filter(
        (n) => typeof (store as unknown as Record<string, unknown>)[n] !== 'function',
      )
      assert.deepEqual(missing, [], `SQL 适配器没有实现这些端口方法：${missing.join(', ')}`)
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })

  test('★ 状态机与"活动状态"必须来自领域层，适配器不得自带一份', async () => {
    /**
     * 抄一份转移表的后果是**静默不一致**：领域层改了状态机，存储层却继续
     * 放行旧规则，直到某天从数据里发现一个非法状态。所以这里从源码层面
     * 钉住"依赖领域层"这件事。
     */
    const src = await readFile(ADAPTER_PATH, 'utf8')

    for (const dep of [
      'assertRunTransition',
      'assertVerdictTransition',
      'assertActionTransition',
      'ACTIVE_RUN_STATUSES',
    ]) {
      assert.match(src, new RegExp(`\\b${dep}\\b`), `适配器必须使用领域层的 ${dep}`)
    }

    // 出现"状态 → 可去状态列表"这种字面量表就是抄了一份状态机
    assert.doesNotMatch(
      src,
      /'(queued|pending_verdict|proposed)'\s*:\s*\[/,
      '适配器里出现了转移表字面量——状态机只应存在于领域层',
    )
  })

  test('★ CAS 必须由 SQL 的 WHERE 承担，不能靠"先读出来再判断"', async () => {
    const src = await readFile(ADAPTER_PATH, 'utf8')
    for (const table of ['run', 'issue', 'verdict', 'action']) {
      assert.ok(
        src.includes(`UPDATE ${table} SET json = ? WHERE id = ? AND status = ?`),
        `${table} 的 CAS 必须写成 UPDATE ... WHERE id = ? AND status = ?`,
      )
    }
    // 校验前态与写入是同一条语句，所以要真的读 changes 才知道自己赢没赢
    assert.match(src, /\.changes/, 'CAS 之后必须检查 changes，否则并发下会误报成功')
  })

  test('★ open() 必须急切建表 / 预热语句 / 逐表读一遍（否则会重演"数据看起来丢了"）', async () => {
    const src = await readFile(ADAPTER_PATH, 'utf8')
    assert.match(
      src,
      /#createSchema\(\)[\s\S]*#prepare\(\)[\s\S]*#warmUp\(\)/,
      'open() 里必须依次建表、预热语句、逐表校验，且不能留成懒加载',
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 差分契约：同一串操作，两个适配器必须给出同样的结果
// ─────────────────────────────────────────────────────────────

const WS_A = wsId('ws-a')
const WS_B = wsId('ws-b')

function msg(seq: number, content: string): RunMessage {
  return {
    seq,
    type: 'text',
    tool: null,
    content,
    input: null,
    output: null,
    outputTruncated: false,
    // ★ 同一个时间戳：补齐只能靠 seq，两个适配器都不许拿时间当顺序
    at: 1000,
  }
}

/**
 * 把一次调用记进日志：正常返回记结果，抛错只记**错误类型**。
 *
 * 只记类型是有意的：两个适配器的错误措辞不必逐字相同（也不该被迫相同），
 * 但"该抛的地方必须抛、抛的是同一类错"是契约的一部分。
 */
async function record(
  log: unknown[],
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    log.push([label, await fn()])
  } catch (err) {
    log.push([label, { threw: (err as Error).constructor.name }])
  }
}

/**
 * 差分脚本。
 *
 * 写成一条直线而不是一堆断言，是为了让"两个适配器结果相同"这件事一次性
 * 覆盖几十个语义点；哪一步走样了，日志里会直接指出是哪个 label。
 */
async function scenario(store: Store): Promise<unknown[]> {
  const log: unknown[] = []
  const rec = (label: string, fn: () => Promise<unknown>) => record(log, label, fn)

  await rec('formatVersion', () => store.formatVersion())

  // ── Workspace / Device ──
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS_A, name: 'A', createdAt: 10, updatedAt: 10 })
  await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: WS_B, name: 'B', createdAt: 20, updatedAt: 20 })
  await rec('listWorkspaceIds', () => store.listWorkspaceIds())
  await rec('getWorkspace', () => store.getWorkspace(WS_A))
  await rec('getWorkspace.missing', () => store.getWorkspace(wsId('nope')))
  await rec('getDevice.empty', () => store.getDevice())
  await store.upsertDevice({ id: 'dev-1' as never, name: '本机', createdAt: 1, lastSeenAt: 1 })
  await store.upsertDevice({ id: 'dev-1' as never, name: '本机', createdAt: 1, lastSeenAt: 9 })
  await rec('getDevice.afterUpsert', () => store.getDevice())

  // ── Agent / Skill ──
  await store.insertAgent(makeAgent({ id: 'a1', workspaceId: WS_A }))
  await store.insertAgent(makeAgent({ id: 'a2', workspaceId: WS_A }))
  await store.insertAgent(makeAgent({ id: 'a3', workspaceId: WS_B }))
  await rec('getAgent', () => store.getAgent(agentId('a1')))
  await rec('getAgent.crossWorkspace', () => store.getAgent(agentId('a3')))
  await rec('listAgents.A', async () => (await store.listAgents(WS_A)).map((a) => a.id))
  await rec('listAgents.B', async () => (await store.listAgents(WS_B)).map((a) => a.id))
  // ★ 删 agent（第二轮：组删除时级联删私有成员）——删得掉、幂等、别的 workspace 不受影响
  await rec('deleteAgent.ok', () => store.deleteAgent(agentId('a2')))
  await rec('deleteAgent.again', () => store.deleteAgent(agentId('a2')))
  await rec('getAgent.afterDelete', () => store.getAgent(agentId('a2')))
  await rec('listAgents.A.afterDelete', async () =>
    (await store.listAgents(WS_A)).map((a) => a.id),
  )
  await rec('listAgents.B.untouched', async () =>
    (await store.listAgents(WS_B)).map((a) => a.id),
  )

  await store.insertSkill(makeSkill({ id: 's1', workspaceId: WS_A, slug: 'sec-vuln' }))
  await store.insertSkill(makeSkill({ id: 's2', workspaceId: WS_A, slug: 'style' }))
  await store.insertSkill(makeSkill({ id: 's3', workspaceId: WS_B, slug: 'other' }))
  await rec('listSkills.A', async () => (await store.listSkills(WS_A)).map((s) => s.slug))
  // ★ 卸载（D38）：删得掉、幂等、删完取不到、别的 workspace 不受影响
  await rec('deleteSkill.ok', () => store.deleteSkill(skillId('s1')))
  await rec('deleteSkill.again', () => store.deleteSkill(skillId('s1')))
  await rec('getSkill.afterDelete', () => store.getSkill(skillId('s1')))
  await rec('listSkills.A.afterDelete', async () =>
    (await store.listSkills(WS_A)).map((s) => s.slug),
  )
  await rec('listSkills.B.untouched', async () =>
    (await store.listSkills(WS_B)).map((s) => s.slug),
  )
  await rec('listSkillsByIds', async () =>
    (await store.listSkillsByIds(['s2', 's3', 's1'] as never)).map((s) => s.id),
  )
  await rec('listSkillsByIds.empty', () => store.listSkillsByIds([]))

  /**
   * ── Tool（工具包 / 组，D40）──
   *
   * 与 skill 那一组逐条对齐，外加**两条工具特有的语义**：
   *
   *   ★ `getToolBySlug` 只在**给定的 workspace 内**唯一。所以这里在两边各放
   *     一个同 slug 的包：如果哪个适配器跨着找，`getToolBySlug.otherWorkspace`
   *     就会拿到 A 的那个包——判决里写 `<slug>.<动作名>`，取错包等于执行了
   *     别人没声明过的动作。
   *   ★ `listToolsByIds` 一次要解析出多个"动作属于哪个包"，所以顺带验一下
   *     里面夹着一个**已被卸载**的 id 时，其余照常返回而不是整体失败。
   */
  await store.insertTool(makeTool({ id: 't1', workspaceId: WS_A, slug: 'deploy' }))
  await store.insertTool(makeTool({ id: 't2', workspaceId: WS_A, slug: 'lint' }))
  await store.insertTool(makeTool({ id: 't3', workspaceId: WS_B, slug: 'deploy' }))
  await rec('getTool', async () => (await store.getTool(toolId('t1')))?.slug ?? null)
  await rec('getTool.missing', () => store.getTool(toolId('nope')))
  await rec('listTools.A', async () => (await store.listTools(WS_A)).map((t) => t.slug))
  await rec('listTools.B', async () => (await store.listTools(WS_B)).map((t) => t.slug))
  await rec('getToolBySlug.hit', async () => (await store.getToolBySlug(WS_A, 'deploy'))?.id ?? null)
  await rec('getToolBySlug.miss', () => store.getToolBySlug(WS_A, 'nope'))
  await rec(
    'getToolBySlug.otherWorkspace',
    async () => (await store.getToolBySlug(WS_B, 'deploy'))?.id ?? null,
  )
  // ★ 卸载：删得掉、幂等、删完取不到、别的 workspace 不受影响
  await rec('deleteTool.ok', () => store.deleteTool(toolId('t1')))
  await rec('deleteTool.again', () => store.deleteTool(toolId('t1')))
  await rec('getTool.afterDelete', () => store.getTool(toolId('t1')))
  await rec('getToolBySlug.afterDelete', () => store.getToolBySlug(WS_A, 'deploy'))
  await rec('listTools.A.afterDelete', async () => (await store.listTools(WS_A)).map((t) => t.slug))
  await rec('listTools.B.untouched', async () => (await store.listTools(WS_B)).map((t) => t.slug))
  await rec('listToolsByIds', async () =>
    (await store.listToolsByIds(['t2', 't3', 't1'] as never)).map((t) => t.id),
  )
  await rec('listToolsByIds.empty', () => store.listToolsByIds([]))

  // ── Issue ──
  await store.insertIssue(
    makeIssue({
      id: 'i1',
      workspaceId: WS_A,
      title: '依赖漏洞',
      description: '描述',
      status: 'todo',
    }),
  )
  await store.insertIssue(
    makeIssue({
      id: 'i2',
      workspaceId: WS_A,
      title: '文档错别字',
      status: 'done',
      assignee: { type: 'agent', id: 'a1' },
    }),
  )
  await store.insertIssue(makeIssue({ id: 'i3', workspaceId: WS_A, title: '第三个' }))
  await store.insertIssue(makeIssue({ id: 'i9', workspaceId: WS_B, title: '别的空间' }))

  await rec('listIssues.A', async () => (await store.listIssues({ workspaceId: WS_A })).items.map((i) => i.id))
  await rec('listIssues.status', async () =>
    (await store.listIssues({ workspaceId: WS_A, status: ['todo'] })).items.map((i) => i.id),
  )
  await rec('listIssues.status.multi', async () =>
    (await store.listIssues({ workspaceId: WS_A, status: ['todo', 'done'] })).items.map((i) => i.id),
  )
  await rec('listIssues.search', async () =>
    (await store.listIssues({ workspaceId: WS_A, search: '漏洞' })).items.map((i) => i.id),
  )
  await rec('listIssues.assignee', async () =>
    (await store.listIssues({ workspaceId: WS_A, assigneeId: 'a1' })).items.map((i) => i.id),
  )
  await rec('getIssue', () => store.getIssue('i1' as never))

  /**
   * 记一页：**条目与游标本身都记**。
   *
   * 只记"有没有游标"会让对比变松——两边返回的下一跳指向不同位置时，
   * `true === true` 也能通过。
   */
  const pageLog = <T extends { id: string }>(label: string, p: Page<T>): void => {
    log.push([label, { ids: p.items.map((i) => i.id), nextCursor: p.nextCursor }])
  }

  {
    const p1 = await store.listIssues({ workspaceId: WS_A, limit: 2 })
    pageLog('listIssues.page1', p1)
    pageLog('listIssues.page2', await store.listIssues({ workspaceId: WS_A, limit: 2, cursor: p1.nextCursor }))
  }
  {
    // 带过滤的翻页：nextCursor 必须基于**过滤后**的结果集算，不然第二页会漏条目
    const p1 = await store.listIssues({ workspaceId: WS_A, status: ['todo'], limit: 1 })
    pageLog('listIssues.filteredPage1', p1)
    pageLog(
      'listIssues.filteredPage2',
      await store.listIssues({ workspaceId: WS_A, status: ['todo'], limit: 1, cursor: p1.nextCursor }),
    )
  }
  /**
   * ★ 游标那条**不在结果集里**的所有情形。端口里没有删除操作，所以"游标条目
   * 被删掉"在可观测层面等价于"游标不在这一页的候选集里"——用状态过滤把游标
   * 排除掉、或拿别的 workspace 的 id 当游标，就是这条路径的真实来源。
   *
   * 期望（两个适配器都必须一样）：
   *   大于全部 ⇒ 空页 + `nextCursor = null`，**必须终止**而不是回头重放；
   *   小于全部 ⇒ 从头返回；
   *   恰好是最后一条 ⇒ 空页 + null。
   */
  pageLog(
    'listIssues.cursorFilteredOut',
    await store.listIssues({ workspaceId: WS_A, status: ['todo'], cursor: 'i2', limit: 2 }),
  )
  pageLog(
    'listIssues.cursorOtherWorkspace',
    await store.listIssues({ workspaceId: WS_A, cursor: 'i9', limit: 2 }),
  )
  pageLog('listIssues.cursorBeyondAll', await store.listIssues({ workspaceId: WS_A, cursor: 'zzzz', limit: 2 }))
  pageLog('listIssues.cursorBeforeAll', await store.listIssues({ workspaceId: WS_A, cursor: '0', limit: 2 }))
  pageLog('listIssues.cursorLast', await store.listIssues({ workspaceId: WS_A, cursor: 'i3', limit: 2 }))
  pageLog(
    'listIssues.cursorEmptyString',
    await store.listIssues({ workspaceId: WS_A, cursor: '', limit: 2 }),
  )
  pageLog('listIssues.limit0', await store.listIssues({ workspaceId: WS_A, limit: 0 }))

  // ── Run ──
  await store.insertRun(makeRun({ id: 'r1', workspaceId: WS_A, agentId: 'a1' })) // queued
  await store.insertRun(
    makeRun({
      id: 'r2',
      workspaceId: WS_A,
      agentId: 'a1',
      status: 'running',
      workDir: '/repo',
      subject: { type: 'issue', id: 'i2' },
    }),
  )
  await store.insertRun(
    makeRun({
      id: 'r3',
      workspaceId: WS_A,
      agentId: 'a2',
      status: 'running',
      workDir: '/repo',
      subject: { type: 'issue', id: 'i3' },
    }),
  )
  await store.insertRun(
    makeRun({
      id: 'r4',
      workspaceId: WS_B,
      agentId: 'a1',
      status: 'running',
      workDir: '/other',
      subject: { type: 'issue', id: 'i2' },
    }),
  )
  await store.insertRun(makeRun({ id: 'r5', workspaceId: WS_A, agentId: 'a1', status: 'completed' }))

  await rec('listRuns.A', async () => (await store.listRuns({ workspaceId: WS_A })).items.map((r) => r.id))
  await rec('listRuns.status', async () =>
    (await store.listRuns({ workspaceId: WS_A, status: ['running'] })).items.map((r) => r.id),
  )
  await rec('listRuns.agent', async () =>
    (await store.listRuns({ workspaceId: WS_A, agentId: agentId('a2') })).items.map((r) => r.id),
  )
  {
    const p1 = await store.listRuns({ workspaceId: WS_A, limit: 2 })
    pageLog('listRuns.page1', p1)
    pageLog('listRuns.page2', await store.listRuns({ workspaceId: WS_A, limit: 2, cursor: p1.nextCursor }))
  }
  // run 这边同样把"游标不在候选集里"的三种来源都过一遍
  pageLog(
    'listRuns.cursorFilteredOut',
    await store.listRuns({ workspaceId: WS_A, status: ['running'], cursor: 'r1', limit: 2 }),
  )
  pageLog('listRuns.cursorOtherWorkspace', await store.listRuns({ workspaceId: WS_A, cursor: 'r4', limit: 2 }))
  pageLog('listRuns.cursorBeyondAll', await store.listRuns({ workspaceId: WS_A, cursor: 'zzzz', limit: 2 }))
  pageLog('listRuns.cursorBeforeAll', await store.listRuns({ workspaceId: WS_A, cursor: '0', limit: 2 }))
  pageLog('listRuns.cursorLast', await store.listRuns({ workspaceId: WS_A, cursor: 'r5', limit: 2 }))
  await rec('findRunHoldingWorkDir', async () => (await store.findRunHoldingWorkDir('/repo'))?.id ?? null)
  await rec(
    'findRunHoldingWorkDir.exclude',
    async () => (await store.findRunHoldingWorkDir('/repo', runId('r2')))?.id ?? null,
  )
  await rec('findRunHoldingWorkDir.none', () => store.findRunHoldingWorkDir('/nope'))
  await rec(
    'findActiveRunForSubjectAgent',
    async () =>
      (
        await store.findActiveRunForSubjectAgent({ type: 'issue', id: 'i2' }, agentId('a1'))
      )?.id ?? null,
  )
  await rec('findActiveRunForSubjectAgent.otherAgent', async () =>
    (await store.findActiveRunForSubjectAgent({ type: 'issue', id: 'i2' }, agentId('a9')))?.id ?? null,
  )

  // ── CAS ──
  await rec('cas.ok', () => store.transitionRun(runId('r1'), 'queued', 'dispatched'))
  await rec('cas.stale', () => store.transitionRun(runId('r1'), 'queued', 'dispatched'))
  await rec('cas.missing', () => store.transitionRun(runId('ghost'), 'queued', 'dispatched'))
  await rec('cas.illegal', () => store.transitionRun(runId('r1'), 'dispatched', 'queued'))
  await rec('cas.illegalWithStaleExpect', () => store.transitionRun(runId('r1'), 'queued', 'queued'))
  await rec('cas.patch', () =>
    store.transitionRun(runId('r1'), 'dispatched', 'running', {
      workDir: '/w',
      waitReason: '被占用',
      startedAt: 5,
    }),
  )
  await rec('cas.patch.undefined', () =>
    store.transitionRun(
      runId('r1'),
      'running',
      'completed',
      loosePatch({ waitReason: undefined, finishedAt: 9 }),
    ),
  )
  await rec('run.afterPatch', async () => {
    const r = await store.getRun(runId('r1'))
    return { status: r?.status, workDir: r?.workDir, waitReason: r?.waitReason, startedAt: r?.startedAt, finishedAt: r?.finishedAt }
  })
  await rec('cas.patch.null', async () => {
    await store.insertRun(makeRun({ id: 'r6', workspaceId: WS_A, agentId: 'a1' }))
    await store.transitionRun(runId('r6'), 'queued', 'dispatched', { waitReason: 'x' })
    await store.transitionRun(runId('r6'), 'dispatched', 'running', { waitReason: null })
    return (await store.getRun(runId('r6')))?.waitReason
  })

  // ── Issue 的 CAS ──
  await rec('issueCas.ok', () =>
    store.transitionIssue(
      'i1' as never,
      'todo',
      'in_progress',
      loosePatch({ priority: 'high', title: undefined }),
    ),
  )
  await rec('issueCas.stale', () => store.transitionIssue('i1' as never, 'todo', 'done'))
  await rec('issueCas.after', async () => {
    // ⚠️ 不比 updatedAt：它是 Date.now()，两次调用必然不同。这不是契约差异，
    //    而是"时间会走"——所以要挑出真正需要一致的字段来比。
    const i = await store.getIssue('i1' as never)
    return { status: i?.status, title: i?.title, priority: i?.priority, assignee: i?.assignee }
  })
  await rec('issueCas.null', () => store.transitionIssue('i2' as never, 'done', 'todo', { assignee: null }))
  await rec('issueCas.null.after', async () => (await store.getIssue('i2' as never))?.assignee ?? null)

  // ── Verdict / Action ──
  const VID = 'v-1' as VerdictId
  await store.insertVerdict({
    id: VID,
    workspaceId: WS_A,
    runId: runId('r2'),
    subject: { type: 'issue', id: 'i2' },
    status: 'pending_verdict',
    conclusion: 'pass',
    reasonCode: 'ok',
    confidence: 0.9,
    findings: [],
    action: null,
    escalateReason: null,
    invalidResolution: null,
    skillRefs: [],
    modelId: null,
    promptHash: null,
    createdAt: 3,
  } as never)
  await rec('verdictCas.ok', () =>
    store.transitionVerdict(VID, 'pending_verdict', 'invalid', { invalidResolution: 'retry' }),
  )
  await rec('verdictCas.stale', () => store.transitionVerdict(VID, 'pending_verdict', 'emitted'))
  await rec('verdictCas.illegal', () => store.transitionVerdict(VID, 'invalid', 'emitted'))
  await rec('getVerdict', async () => {
    const v = await store.getVerdict(VID)
    return { status: v?.status, invalidResolution: v?.invalidResolution }
  })
  await rec('listVerdictsByRun', async () =>
    (await store.listVerdictsByRun(runId('r2'))).map((v) => v.id),
  )

  await store.insertAction({
    id: 'act-1' as ActionId,
    workspaceId: WS_A,
    verdictId: VID,
    type: 'comment.create',
    plane: 'local',
    params: { body: 'x' },
    status: 'proposed',
    idempotencyKey: 'v-1:comment.create:{"body":"x"}',
    dryRun: false,
    result: null,
    error: null,
    rollbackRef: null,
    createdAt: 4,
    finishedAt: null,
  } as never)
  await rec('findActionByIdempotencyKey', async () =>
    (await store.findActionByIdempotencyKey('v-1:comment.create:{"body":"x"}'))?.id ?? null,
  )
  await rec('findActionByIdempotencyKey.missing', () =>
    store.findActionByIdempotencyKey('nope'),
  )
  await rec('actionCas.ok', () =>
    store.transitionAction('act-1' as ActionId, 'proposed', 'auto_approved'),
  )
  await rec('actionCas.stale', () =>
    store.transitionAction('act-1' as ActionId, 'proposed', 'executing'),
  )
  await rec('actionCas.illegal', () =>
    store.transitionAction('act-1' as ActionId, 'auto_approved', 'executed'),
  )
  await rec('listActionsByVerdict', async () =>
    (await store.listActionsByVerdict(VID)).map((a) => a.id),
  )

  // ── 消息流 ──
  await store.appendRunMessage(runId('r2'), msg(0, 'm0'))
  await store.appendRunMessage(runId('r2'), msg(1, 'm1'))
  await store.appendRunMessage(runId('r2'), msg(2, 'm2'))
  await rec('messages.lastSeq', () => store.lastRunMessageSeq(runId('r2')))
  await rec('messages.all', async () =>
    (await store.listRunMessages(runId('r2'))).map((m) => [m.seq, m.content]),
  )
  await rec('messages.since', async () =>
    (await store.listRunMessages(runId('r2'), 1)).map((m) => m.content),
  )
  await rec('messages.empty', () => store.lastRunMessageSeq(runId('r5')))
  // 同 seq 重复追加：两个适配器都必须接受，并都按 seq（相同则按追加顺序）返回
  await rec('messages.duplicateSeq', async () => {
    await store.appendRunMessage(runId('r2'), msg(0, '重复的 0 号'))
    return (await store.listRunMessages(runId('r2'))).map((m) => [m.seq, m.content])
  })
  await rec('messages.unknownRun', () => store.listRunMessages(runId('ghost')))
  await rec('messages.appendUnknownRun', () =>
    store.appendRunMessage(runId('ghost'), msg(0, 'x')),
  )

  // ── Report 去重 ──
  await rec('report.first', () =>
    store.insertReport(makeReport({ id: 'rep-1', workspaceId: WS_A, kind: 'ci', dedupKey: 'd1' })),
  )
  await rec('report.duplicate', () =>
    store.insertReport(makeReport({ id: 'rep-2', workspaceId: WS_A, kind: 'ci', dedupKey: 'd1' })),
  )
  await rec('report.otherKey', () =>
    store.insertReport(makeReport({ id: 'rep-3', workspaceId: WS_A, kind: 'ci', dedupKey: 'd2' })),
  )
  await rec('report.find', async () => (await store.findReportByDedupKey('d1'))?.id ?? null)
  await rec('report.find.missing', () => store.findReportByDedupKey('nope'))
  await rec('report.get', async () => (await store.getReport('rep-1' as never))?.kind ?? null)

  // ── Blob ──
  const enc = new TextEncoder()
  await rec('blob.put', () => store.putBlob(enc.encode('hello')))
  await rec('blob.put.idempotent', () => store.putBlob(enc.encode('hello')))
  await rec('blob.put.other', () => store.putBlob(enc.encode('world')))
  await rec('blob.get', async () => {
    const ref = await store.putBlob(enc.encode('内容 ✨'))
    const bytes = await store.getBlob(ref)
    return { ref, text: bytes ? Buffer.from(bytes).toString('utf8') : null }
  })
  await rec('blob.has', () => store.hasBlob(`sha256:${'0'.repeat(64)}` as BlobRef))

  // ── Audit / Artifact / Comment ──
  const audit = (id: string, queuedAt: number) => ({
    id: id as never,
    workspaceId: WS_A,
    runId: runId('r2'),
    subject: { type: 'issue' as const, id: 'i2' },
    inputBlobRefs: [],
    skillRefs: [],
    runtimeDescriptorKey: 'claude',
    cliVersion: null,
    modelId: null,
    promptHash: null,
    argvRedacted: ['claude'],
    verdictId: null,
    actionIds: [],
    queuedAt,
    startedAt: null,
    finishedAt: null,
    usage: null,
  })
  await store.appendAudit(audit('aud-late', 200) as never)
  await store.appendAudit(audit('aud-early', 100) as never)
  await rec('listAuditsByRun', async () =>
    (await store.listAuditsByRun(runId('r2'))).map((a) => a.id),
  )

  const artifact = (id: string, createdAt: number) => ({
    id: id as never,
    workspaceId: WS_A,
    runId: runId('r2'),
    kind: 'document' as const,
    summary: id,
    blobRef: `sha256:${'a'.repeat(64)}` as BlobRef,
    createdAt,
  })
  await store.insertArtifact(artifact('art-late', 20) as never)
  await store.insertArtifact(artifact('art-early', 10) as never)
  await rec('listArtifactsByRun', async () =>
    (await store.listArtifactsByRun(runId('r2'))).map((a) => a.summary),
  )

  const comment = (id: string, issueId: string, createdAt: number) => ({
    id: id as never,
    workspaceId: WS_A,
    issueId: issueId as never,
    authorType: 'member' as const,
    authorId: 'me',
    type: 'comment' as const,
    content: id,
    createdAt,
  })
  await store.insertComment(comment('c-late', 'i1', 200) as never)
  await store.insertComment(comment('c-early', 'i1', 100) as never)
  await store.insertComment(comment('c-other', 'i2', 50) as never)
  await rec('listComments', async () =>
    (await store.listComments('i1' as never)).map((c) => c.content),
  )

  // ── 通知中心 ──
  const inbox = (id: string, createdAt: number) => ({
    id,
    workspaceId: WS_A,
    type: 'review.needs_decision',
    severity: 'action_required' as const,
    title: id,
    body: '',
    issueId: null,
    runId: null,
    read: false,
    createdAt,
  })
  await store.appendInboxItem(inbox('n1', 100) as never)
  await store.appendInboxItem(inbox('n2', 200) as never)
  await rec('inbox.unread', async () =>
    (await store.listInboxItems({ workspaceId: WS_A })).map((i) => i.id),
  )
  await rec('inbox.all', async () =>
    (await store.listInboxItems({ workspaceId: WS_A, unreadOnly: false })).map((i) => i.id),
  )
  await rec('inbox.limit', async () =>
    (await store.listInboxItems({ workspaceId: WS_A, limit: 1 })).map((i) => i.id),
  )
  await rec('inbox.markRead', () => store.markInboxItemRead('n2'))
  await rec('inbox.markRead.missing', () => store.markInboxItemRead('nope'))
  await rec('inbox.afterRead', async () =>
    (await store.listInboxItems({ workspaceId: WS_A })).map((i) => i.id),
  )

  await rec('formatVersion.last', () => store.formatVersion())
  await rec('listWorkspaceIds.last', () => store.listWorkspaceIds())

  return log
}

/** 在两个适配器上各跑一遍，返回两边各自的日志（外加数据目录，便于清理）。 */
async function runBoth(): Promise<{ file: unknown[]; sqlite: unknown[]; dirs: string[] }> {
  const fileDir = await makeTempDir('diff-file')
  const sqliteDir = await makeTempDir('diff-sqlite')
  const fileStore = await FileStore.open({ dataDir: fileDir, fsync: false })
  const sqliteStore = await SqliteStore.open({ dataDir: sqliteDir, fsync: false })
  try {
    const fileLog = await scenario(fileStore)
    const sqliteLog = await scenario(sqliteStore)
    return { file: fileLog, sqlite: sqliteLog, dirs: [fileDir, sqliteDir] }
  } finally {
    await fileStore.close()
    await sqliteStore.close()
    for (const d of [fileDir, sqliteDir]) await cleanup(d)
  }
}

describe('差分契约：SQLite 适配器与文件适配器行为一致（FR-STOR-03）', () => {
  test('★ 同一串操作在两个适配器上逐项结果相同', async () => {
    const { file, sqlite } = await runBoth()

    // 先保证脚本真的跑过东西，避免"两边都空"这种假通过
    assert.ok(file.length > 60, `差分脚本应覆盖足够多的操作，实际只有 ${file.length} 步`)

    // 逐步对比，失败时直接指出是哪一步走样了
    for (let i = 0; i < Math.max(file.length, sqlite.length); i++) {
      assert.deepEqual(
        sqlite[i],
        file[i],
        `第 ${i} 步 ${JSON.stringify((file[i] as [string])?.[0])} 两边结果不一致`,
      )
    }
    assert.deepEqual(sqlite, file)
  })

  test('★ 差分脚本覆盖到关键语义（不是只验了个空壳）', async () => {
    const { file } = await runBoth()
    const labels = new Set(file.map((entry) => (entry as [string])[0]))
    for (const required of [
      'cas.ok',
      'cas.stale',
      'listIssues.cursorFilteredOut',
      'listIssues.cursorBeyondAll',
      'listIssues.cursorBeforeAll',
      'listRuns.cursorBeyondAll',
      'cas.illegal',
      'cas.patch.undefined',
      'cas.patch.null',
      'findRunHoldingWorkDir.exclude',
      'findActiveRunForSubjectAgent',
      'report.duplicate',
      'messages.since',
      'messages.duplicateSeq',
      'messages.unknownRun',
      'blob.put.idempotent',
      'deleteSkill.ok',
      'deleteSkill.again',
      'deleteAgent.ok',
      'deleteAgent.again',
      'deleteTool.ok',
      'deleteTool.again',
      'getToolBySlug.hit',
      'getToolBySlug.miss',
      'getToolBySlug.otherWorkspace',
      'listTools.B.untouched',
      'inbox.markRead',
      'listWorkspaceIds',
      'issueCas.ok',
      'verdictCas.illegal',
      'actionCas.stale',
    ]) {
      assert.ok(labels.has(required), `差分脚本缺少关键步骤：${required}`)
    }
  })

  test('★ 关键步骤有确定的答案——否则"两边都返回 null"也会被差分测试放过', async () => {
    /**
     * 差分测试有个天生的盲点：如果两边**都错成一样**（比如都返回 null），
     * 它会安静地通过。所以这里把几个语义点的正确答案单独钉死：
     * 差分负责"一致"，这条负责"正确"。
     */
    const { sqlite } = await runBoth()
    const got = new Map<string, unknown>(
      sqlite.map((entry) => {
        const [label, value] = entry as [string, unknown]
        return [label, value]
      }),
    )

    assert.deepEqual(got.get('cas.ok'), true)
    assert.deepEqual(got.get('cas.stale'), false, '前态不匹配必须返回 false')
    assert.deepEqual(got.get('cas.illegal'), { threw: 'IllegalTransitionError' })
    assert.deepEqual(got.get('cas.illegalWithStaleExpect'), false, '前态不匹配时不该抛')
    assert.deepEqual(got.get('report.duplicate'), false, '重复去重键必须被拒')
    assert.deepEqual(got.get('findRunHoldingWorkDir.exclude'), 'r3')
    assert.deepEqual(got.get('findActiveRunForSubjectAgent'), 'r2')
    assert.deepEqual(got.get('messages.since'), ['m2'], 'since 取的是"不含该序号"之后的消息')
    assert.deepEqual(got.get('messages.empty'), -1, '没有消息时是 -1，不是 0')
    assert.deepEqual(got.get('run.afterPatch'), {
      status: 'completed',
      workDir: '/w',
      waitReason: '被占用',
      startedAt: 5,
      finishedAt: 9,
    })
    assert.deepEqual(got.get('listWorkspaceIds'), ['ws-a', 'ws-b'], '按创建顺序，不是按 id 排序')
    assert.deepEqual(got.get('inbox.afterRead'), ['n1'], '默认只列未读')

    // ── 工具包（D40）：卸载的语义与"slug 只在 workspace 内唯一" ──
    assert.deepEqual(got.get('deleteTool.ok'), true)
    assert.deepEqual(got.get('deleteTool.again'), false, '删第二次是 false，**不是错误**')
    assert.deepEqual(got.get('getTool.afterDelete'), null)
    assert.deepEqual(
      got.get('getToolBySlug.hit'),
      't1',
      '同一 workspace 内 slug 唯一 ⇒ 命中那一个包',
    )
    assert.deepEqual(got.get('getToolBySlug.miss'), null)
    assert.deepEqual(
      got.get('getToolBySlug.otherWorkspace'),
      't3',
      '★ 另一个 workspace 里有同 slug 的包：必须返回**它那个**，不能跨 workspace 拿成 t1',
    )
    assert.deepEqual(
      got.get('getToolBySlug.afterDelete'),
      null,
      '包卸载后按 slug 也应当查不到，而不是留着一个悬空引用',
    )
    assert.deepEqual(got.get('listTools.A.afterDelete'), ['lint'])
    assert.deepEqual(
      got.get('listTools.B.untouched'),
      ['deploy'],
      '★ 删 A 的包不能动到 B 的（哪怕两者同名）',
    )
    assert.deepEqual(
      got.get('listToolsByIds'),
      ['t2', 't3'],
      '批量取要跳过已被卸载的 id，而不是整体失败',
    )
    assert.deepEqual(got.get('listToolsByIds.empty'), [])

    // ── 游标：所有情形都要有确定的答案，不能只说"两边一样" ──
    assert.deepEqual(got.get('listIssues.page1'), { ids: ['i1', 'i2'], nextCursor: 'i2' })
    assert.deepEqual(got.get('listIssues.page2'), { ids: ['i3'], nextCursor: null })
    assert.deepEqual(
      got.get('listIssues.cursorFilteredOut'),
      { ids: ['i3'], nextCursor: null },
      '游标被状态过滤排掉后，必须从它原本的位置继续，而不是回头重放',
    )
    assert.deepEqual(
      got.get('listIssues.cursorOtherWorkspace'),
      { ids: [], nextCursor: null },
      '游标来自别的 workspace 且大于全部 ⇒ 空页并终止',
    )
    assert.deepEqual(
      got.get('listIssues.cursorBeyondAll'),
      { ids: [], nextCursor: null },
      '★ 垃圾游标（大于全部）必须返回空 + null：回头重放第一页会让客户端永远打转',
    )
    assert.deepEqual(
      got.get('listIssues.cursorBeforeAll'),
      { ids: ['i1', 'i2'], nextCursor: 'i2' },
      '垃圾游标（小于全部）⇒ 全部都在它之后',
    )
    assert.deepEqual(got.get('listIssues.cursorLast'), { ids: [], nextCursor: null })
    assert.deepEqual(
      got.get('listIssues.cursorEmptyString'),
      { ids: ['i1', 'i2'], nextCursor: 'i2' },
      '空字符串游标与"没有游标"同义（端口用 falsy 判断）',
    )
    assert.deepEqual(got.get('listIssues.limit0'), { ids: [], nextCursor: null })
    assert.deepEqual(got.get('listRuns.cursorFilteredOut'), { ids: ['r2', 'r3'], nextCursor: null })
    assert.deepEqual(got.get('listRuns.cursorBeyondAll'), { ids: [], nextCursor: null })
    assert.deepEqual(got.get('listRuns.cursorBeforeAll'), { ids: ['r1', 'r2'], nextCursor: 'r2' })
  })
})

// before/after 只为让文件级清理有个落点；每个用例自己建目录并清理
let scratch: string | null = null
before(async () => {
  scratch = await makeTempDir('thinness')
})
after(async () => {
  if (scratch) await cleanup(scratch)
})

describe('适配器自身的卫生', () => {
  test('数据目录里只写自己的文件（不与文件适配器的目录布局打架）', async () => {
    const dir = await makeTempDir('layout')
    try {
      const store = await SqliteStore.open({ dataDir: dir, fsync: false })
      await store.insertWorkspace({ executeTemplate: '', reviewTemplate: '', chatTemplate: '', defaultAgentId: null, locale: 'zh', id: 'ws-x' as WorkspaceId,
        name: 'x',
        createdAt: 1,
        updatedAt: 1,
      })
      await store.close()

      const { readdir } = await import('node:fs/promises')
      const files = await readdir(dir)
      assert.ok(
        files.every((f) => f.startsWith('store.sqlite')),
        `SQLite 适配器不该往数据目录里写别的文件，实际有：${files.join(', ')}`,
      )
    } finally {
      await cleanup(dir)
    }
  })
})
