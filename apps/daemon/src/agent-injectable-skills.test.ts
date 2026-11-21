import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FileStore } from '@agentdeck/store-file'
import type { SkillPayload } from '@agentdeck/protocol'
import { loadInjectableSkills, skillSourcesOfAgent, type SkillSources } from './agent-injectable-skills.ts'
import { agentExclusiveSkillsDir } from '@agentdeck/store-file'
import { workflowAgentExclusiveSkillsDir } from './workflows-dirs.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * **技能来源的三元组**（D228）。
 *
 * 这一轮改的是"独有技能放哪"这件事的**归属**：从 `AgentId` 换成来源描述符
 * （`ExclusiveSkillOwner`），好处是**编排内建智能体**（不在库里、没有 AgentId）
 * 也能带独有技能，而注入实现只有一份。
 *
 * 所以这里最要紧的判据只有一条：**两种来源读出来的技能逐字同形**——
 * 只要两边有一天开始"各有各的拼法"，这条就红。
 */

const WS = 'ws-1'
const BODY = '# 私有参考\n\n## When to Use\n\n这条只属于它的主人。\n'

/** 按 daemon 装配时**一模一样**的解析函数开一个 store（两条来源都认得）。 */
async function openStore(dir: string): Promise<FileStore> {
  return FileStore.open({
    dataDir: dir,
    fsync: false,
    exclusiveSkillsDir: (owner) =>
      owner.kind === 'agent'
        ? agentExclusiveSkillsDir(dir, owner.agentId)
        : workflowAgentExclusiveSkillsDir(dir, owner.workflowId, owner.agentId),
  })
}

/** 修一条最小可用的 workspace + 一条库技能，返回 store。 */
async function seed(dir: string): Promise<FileStore> {
  const store = await openStore(dir)
  await store.insertWorkspace({
    executeTemplate: '',
    reviewTemplate: '',
    chatTemplate: '',
    defaultAgentId: null,
    locale: 'zh',
    id: WS as never,
    name: '测试工作区',
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await store.insertSkill({
    id: 'lib-1' as never,
    workspaceId: WS as never,
    slug: 'house-style',
    name: '写作规范',
    description: '',
    body: '# 写作规范\n\n## When to Use\n\n库里的共享技能。\n',
    source: 'local',
    sourceRef: null,
    verdictSchemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  } as never)
  return store
}

describe('★ D228：独有技能按"来源"定位，两种来源同一份实现', () => {
  test('★★ 账号智能体 与 编排内建智能体：写同样的东西 ⇒ 注入出来的 payload 逐字相同', async () => {
    const dir = await makeTempDir('skill-sources')
    try {
      const store = await seed(dir)

      // ① 账号智能体那条：agents/<id>/SKILL/<slug>/SKILL.md
      await store.writeExclusiveSkill({ kind: 'agent', agentId: 'a-1' as never }, 'private-notes', BODY)
      const agentSources: SkillSources = {
        workspaceId: WS as never,
        libraryIds: ['lib-1'],
        exclusive: { kind: 'agent', agentId: 'a-1' as never },
      }
      const fromAgent = await loadInjectableSkills(store, agentSources)

      // ② 编排内建智能体那条：workflows/<wid>/agents/<aid>/SKILL/<slug>/SKILL.md
      await store.writeExclusiveSkill(
        { kind: 'workflow-agent', workflowId: 'wf-1', agentId: 'wa-1' },
        'private-notes',
        BODY,
      )
      const workflowSources: SkillSources = {
        workspaceId: WS as never,
        libraryIds: ['lib-1'],
        exclusive: { kind: 'workflow-agent', workflowId: 'wf-1', agentId: 'wa-1' },
      }
      const fromWorkflow = await loadInjectableSkills(store, workflowSources)

      /*
       * ★ 这条是整轮改动的判据：**除了"归谁"之外，什么都没变**。
       *   payload 里不含 owner（它本来就不该进 payload：模型看到的是"一份技能"，
       *   不是"这份技能属于谁"），所以两份必须逐字相同。
       */
      assert.deepEqual(fromWorkflow, fromAgent)
      assert.equal(fromAgent.length, 2, '一个库技能 + 一个独有技能')
      const exclusive = fromAgent.find((p: SkillPayload) => p.slug === 'private-notes')
      assert.ok(exclusive, '独有技能要在里面')
      assert.equal(exclusive.body, BODY)
      // 独有技能**没有库 id**（D111 的口径不变）
      assert.deepEqual(exclusive.ref, { id: null, slug: 'private-notes', source: 'agent' })
      // 库技能照旧
      const lib = fromAgent.find((p: SkillPayload) => p.slug === 'house-style')
      assert.equal(lib?.ref.id, 'lib-1')

      // ③ 两边落在**不同目录**（真实落盘位置不能撞）
      assert.match(
        agentExclusiveSkillsDir(dir, 'a-1'),
        /agents[/\\]a-1[/\\]SKILL$/,
      )
      assert.match(
        workflowAgentExclusiveSkillsDir(dir, 'wf-1', 'wa-1'),
        /workflows[/\\]wf-1[/\\]agents[/\\]wa-1[/\\]SKILL$/,
      )
      await store.close()
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 只有编排那边有这个技能时，账号智能体读不到（来源是隔离的）', async () => {
    const dir = await makeTempDir('skill-sources-isolated')
    try {
      const store = await seed(dir)
      await store.writeExclusiveSkill(
        { kind: 'workflow-agent', workflowId: 'wf-2', agentId: 'wa-2' },
        'only-in-workflow',
        BODY,
      )
      const asAgent = await loadInjectableSkills(store, {
        workspaceId: WS as never,
        libraryIds: [],
        exclusive: { kind: 'agent', agentId: 'a-2' as never },
      })
      assert.deepEqual(asAgent, [], '账号智能体那边没有独有技能，也不该看见编排的')

      const asWorkflow = await loadInjectableSkills(store, {
        workspaceId: WS as never,
        libraryIds: [],
        exclusive: { kind: 'workflow-agent', workflowId: 'wf-2', agentId: 'wa-2' },
      })
      assert.equal(asWorkflow.length, 1)
      assert.equal(asWorkflow[0]!.slug, 'only-in-workflow')
      await store.close()
    } finally {
      await cleanup(dir)
    }
  })

  test('★★ 没注入"来源 → 目录"的解析函数就明确报错（不许静默当没有技能）', async () => {
    const dir = await makeTempDir('skill-sources-unwired')
    try {
      // 故意**不传** exclusiveSkillsDir
      const store = await FileStore.open({ dataDir: dir, fsync: false })
      /*
       * `agent` 那一种自带缺省解析（形状归 store-file），`workflow-agent` 没有——
       * 因为那个形状归 daemon。漏装配时必须**喊**：静默返回空数组会让
       * "编排自带的技能坏了"表现成"它本来就没有技能"。
       */
      assert.equal((await store.listExclusiveSkills({ kind: 'agent', agentId: 'a-9' as never })).length, 0)
      await assert.rejects(
        () => store.listExclusiveSkills({ kind: 'workflow-agent', workflowId: 'wf', agentId: 'wa' }),
        /exclusiveSkillsDir/,
      )
      await store.close()
    } finally {
      await cleanup(dir)
    }
  })

  test('★ skillSourcesOfAgent：账号智能体那一条路的便捷构造（库 id 会相加）', () => {
    const sources = skillSourcesOfAgent(
      { id: 'a-3' as never, workspaceId: WS as never, skillIds: ['lib-1' as never] },
      ['lib-2'],
    )
    assert.deepEqual(sources.libraryIds, ['lib-1', 'lib-2'])
    assert.deepEqual(sources.exclusive, { kind: 'agent', agentId: 'a-3' })
    assert.equal(sources.workspaceId, WS)
  })
})
