import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Agent, Device, Workspace } from '@agentdeck/protocol'
import type { Page, Store } from '../ports/store.ts'
import { checksumOf } from './export.ts'
import { exportData, importData } from './snapshot.ts'
import { makeAgent, makeTool, toolId, wsId } from '../testing/fixtures.ts'

/**
 * 快照里的**工具包**（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么加 tools 这件事值得单独一组用例
 * ══════════════════════════════════════════════════════════════════
 *
 * 审计导出要求自包含（FR-AUDIT-02）。agent 上挂着 `toolIds`、判决与审计里写着
 * `<slug>.<动作名>`——这些都是**引用**。被引用的包不在同一份文件里，导出物就
 * 变成了"引用了一个不存在的工具包"：拿到别处打开时，你分不清是"当时没导"，
 * 还是"这个包当时就不在"。这类缺失不会报错，只会在很久以后被人当成事实。
 *
 * 本文件只验 domain 自己的这两件事：
 *
 *   ① 导出时 tools **进去了**，而且 agent 引用到的包一个不缺；
 *   ② 导入一份**没有 tools 段**的旧快照时不炸、也不凭空造出包来。
 *
 * 跨适配器的整链验证（真 store、导出→导入到另一个库）在组合根
 * （`apps/daemon/src/snapshot.test.ts`）——`packages/domain` 不允许依赖任何
 * 适配器（design §3.1 的依赖方向），所以这里用一个最小的假 store：它反而
 * 更准，因为真适配器会把"某个端口方法没实现"这类失败混进来。
 */

/** 一个只实现本文件用到的那几个方法的假 store。 */
function stubStore(seed: { workspace: Workspace; agents: Agent[]; tools: ReturnType<typeof makeTool>[] }): {
  store: Store
  tools: Map<string, ReturnType<typeof makeTool>>
} {
  const tools = new Map(seed.tools.map((t) => [t.id as string, t]))
  const empty = <T,>(): Page<T> => ({ items: [], nextCursor: null })
  const store = {
    getWorkspace: async (id: string) => (id === (seed.workspace.id as string) ? seed.workspace : null),
    getDevice: async (): Promise<Device | null> => null,
    listAgents: async () => seed.agents,
    listSkills: async () => [],
    listTools: async () => [...tools.values()],
    listIssues: async () => empty(),
    listReports: async () => empty(),
    listRuns: async () => empty(),
    listInboxItems: async () => [],
    // 聊天：这个假 store 只实现本文件用到的方法，而导出会取**全部**实体
    // （漏一个就是 `TypeError: store.listXxx is not a function`——比"导少了一部分"
    // 响得多，所以这里宁可多两行）。
    listConversations: async () => [],
    listChatTurns: async () => [],
    listComments: async () => [],
    listVerdictsByRun: async () => [],
    listArtifactsByRun: async () => [],
    listAuditsByRun: async () => [],
    listActionsByVerdict: async () => [],
    getTool: async (id: string) => tools.get(id) ?? null,
    insertTool: async (tool: never) => {
      tools.set((tool as { id: string }).id, tool)
    },
  } as unknown as Store
  return { store, tools }
}

const WS = wsId('ws-tools')

function makeWorkspace(): Workspace {
  return {
    executeTemplate: '',
    reviewTemplate: '', chatTemplate: '',
    defaultAgentId: null,
    locale: 'zh',
    id: WS,
    name: '工具快照',
    createdAt: 1,
    updatedAt: 1,
  } as Workspace
}

describe('快照：工具包（D40）', () => {
  test('★ 导出里带着 tools，且 agent 引用到的包一个不缺（FR-AUDIT-02 自包含）', async () => {
    const deploy = makeTool({ id: 'tool-deploy', workspaceId: WS, slug: 'deploy' })
    const lint = makeTool({ id: 'tool-lint', workspaceId: WS, slug: 'lint' })
    // ★ "引用"的来源：审核者的动作权限写的是 `<包 slug>.<动作名>`，所以它按
    //   **slug** 指着 deploy 这个包。（原来是"agent 挂着这个工具包"——挂载能力
    //   撤掉之后那条引用不存在了，但这条还在，判据因此仍然成立。）
    const agent = makeAgent({
      id: 'ag-1',
      workspaceId: WS,
      allowedActions: ['deploy.push'],
    })
    const { store } = stubStore({ workspace: makeWorkspace(), agents: [agent], tools: [deploy, lint] })

    const snap = await exportData(store, { workspaceId: WS })

    assert.deepEqual(
      snap.data.tools.map((t) => t.id),
      ['tool-deploy', 'tool-lint'],
      '工具包必须与 skills 并排出现在快照里',
    )
    assert.equal(snap.counts['tools'], 2)

    // ★ 真正的判据：`allowedActions` 里引用到的每一个包都能在这份快照里找到
    const availableSlugs = new Set(snap.data.tools.map((t) => t.slug))
    for (const action of agent.allowedActions ?? []) {
      const slug = action.split('.')[0] ?? ''
      assert.ok(availableSlugs.has(slug), `快照里缺少被动作权限引用到的工具包 ${slug}`)
    }
  })

  test('清单与包内文件被逐字带过去（不是只剩 id 与 slug）', async () => {
    const tool = makeTool({ id: 'tool-1', workspaceId: WS, slug: 'deploy' })
    const { store } = stubStore({ workspace: makeWorkspace(), agents: [], tools: [tool] })

    const snap = await exportData(store, { workspaceId: WS })
    assert.deepEqual(snap.data.tools[0]?.manifest.actions.map((a) => a.name), ['run'])
    assert.deepEqual(snap.data.tools[0]?.files, { 'index.mjs': '// 空实现\n' })
    assert.equal(snap.data.tools[0]?.source, 'local')
  })

  test('★ 导出 → 导入到空库：包真的落进去了，且重复导入是幂等的', async () => {
    const tool = makeTool({ id: 'tool-1', workspaceId: WS, slug: 'deploy' })
    const source = stubStore({ workspace: makeWorkspace(), agents: [], tools: [tool] })
    const target = stubStore({ workspace: makeWorkspace(), agents: [], tools: [] })

    const snap = await exportData(source.store, { workspaceId: WS })
    const first = await importData(target.store, snap)
    assert.equal(first.imported['tools'], 1)
    assert.equal(target.tools.size, 1)
    assert.equal((await target.store.getTool(toolId('tool-1')))?.slug, 'deploy')

    // 只增不改：第二次同 id 一律跳过，**不是错误**，也不能插出第二份
    const second = await importData(target.store, snap)
    assert.equal(second.imported['tools'] ?? 0, 0, '第二次不该再写入')
    assert.equal(second.skipped['tools'], 1)
    assert.equal(target.tools.size, 1, '不能变成两个包')
  })

  test('★ 没有 tools 段的旧快照仍然能导入（格式版本没变 ⇒ 旧文件是正常的）', async () => {
    /**
     * `DATA_SNAPSHOT_FORMAT_VERSION` 没有因为加 tools 而升版，所以使用者手上
     * 那份旧版本导出的文件**必须**还能导进来。这里按旧文件的真实形状构造：
     * 删掉 `data.tools` 与 `counts.tools`，再按新内容重算校验和（旧文件本来就
     * 没有这一段，它的校验和也是照旧内容算的）。
     */
    const tool = makeTool({ id: 'tool-1', workspaceId: WS, slug: 'deploy' })
    const source = stubStore({ workspace: makeWorkspace(), agents: [], tools: [tool] })
    const snap = await exportData(source.store, { workspaceId: WS })

    const legacy = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>
    delete (legacy['data'] as Record<string, unknown>)['tools']
    delete (legacy['counts'] as Record<string, unknown>)['tools']
    const { checksum: _drop, ...rest } = legacy
    legacy['checksum'] = checksumOf(rest)

    const target = stubStore({ workspace: makeWorkspace(), agents: [], tools: [] })
    const result = await importData(target.store, legacy)

    assert.equal(result.imported['tools'] ?? 0, 0, '旧快照里没有工具包 ⇒ 一个都不该被造出来')
    assert.equal(target.tools.size, 0)
    assert.deepEqual(result.warnings, [], '这不是"损坏"，不该报任何警告')
  })
})
