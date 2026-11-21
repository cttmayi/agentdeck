import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FileStore } from '@agentdeck/store-file'
import type { SkillPayload } from '@agentdeck/protocol'
import { loadInjectableSkills, skillSourcesOfAgent, type SkillSources } from './agent-injectable-skills.ts'
import { agentExclusiveSkillsDir } from '@agentdeck/store-file'
import { workflowAgentExclusiveSkillsDir, writeWorkflowAgent } from './workflows-dirs.ts'
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
    /*
     * 与 `server.ts` 的装配逐字同形（D235：解析是异步的，`agent` 那种根本不进来）。
     * 这里故意保留一个显式抛错分支——解析函数要是被人改成"两种都归我"，
     * 这条测试当场红，而不是悄悄拼出 `agents/<agentId>` 那种错路径。
     */
    exclusiveSkillsDir: (owner) => {
      if (owner.kind !== 'workflow-agent') {
        throw new Error(`测试装配只解析 workflow-agent，收到了 ${owner.kind}`)
      }
      return workflowAgentExclusiveSkillsDir(dir, owner.workflowId, owner.agentId)
    },
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
    name: 'house-style',
    description: '',
    body: '# 写作规范\n\n## When to Use\n\n库里的共享技能。\n',
    source: 'local',
    sourceRef: null,
    verdictSchemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  } as never)
  /*
   * ★ D231：写独有技能要**智能体存在**（目录名 = 名字的 name，索引里没有它就写不了，
   *   否则会造出一个没有 agent.json 的孤儿目录）。所以夹具里先把人建出来。
   */
  for (const [id, name] of [
    ['a-1', '甲'],
    ['a-2', '乙'],
  ] as const) {
    await store.insertAgent({
      id: id as never,
      workspaceId: WS as never,
      name,
      instructions: '',
      model: null,
      runtimeKey: 'default',
      workDir: null,
      skillIds: [],
      env: {},
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }
  /*
   * ★ D235：编排内建智能体也有同样的门槛——**实体目录不在就写不了它自己的技能**，
   *   否则又会造出一个没有 `agent.json` 的孤儿目录（改之前正是这个毛病：
   *   `workflows/<wid>/agents/<agentId>/skills/` 与实体目录 `<名字>/` 各存一份）。
   */
  for (const [wid, id, name] of [
    ['wf-1', 'wa-1', '内建甲'],
    ['wf-2', 'wa-2', '内建乙'],
  ] as const) {
    await writeWorkflowAgent(dir, wid, {
      id,
      name,
      instructions: '',
      skillIds: [],
      createdAt: 1,
      updatedAt: 1,
    })
  }
  return store
}

describe('★ D228：独有技能按"来源"定位，两种来源同一份实现', () => {
  test('★★ 账号智能体 与 编排内建智能体：写同样的东西 ⇒ 注入出来的 payload 逐字相同', async () => {
    const dir = await makeTempDir('skill-sources')
    try {
      const store = await seed(dir)

      // ① 账号智能体那条：agents/<id>/skills/<name>/SKILL.md
      await store.writeExclusiveSkill({ kind: 'agent', agentId: 'a-1' as never }, 'private-notes', BODY)
      const agentSources: SkillSources = {
        workspaceId: WS as never,
        libraryIds: ['lib-1'],
        exclusive: { kind: 'agent', agentId: 'a-1' as never },
      }
      const fromAgent = await loadInjectableSkills(store, agentSources)

      // ② 编排内建智能体那条：workflows/<wid>/agents/<名字>/skills/<name>/SKILL.md
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
      const exclusive = fromAgent.find((p: SkillPayload) => p.ref.name === 'private-notes')
      assert.ok(exclusive, '独有技能要在里面')
      assert.equal(exclusive.body, BODY)
      // 独有技能**没有库 id**（D111 的口径不变）
      assert.deepEqual(exclusive.ref, { id: null, name: 'private-notes', source: 'agent' })
      // 库技能照旧
      const lib = fromAgent.find((p: SkillPayload) => p.ref.name === 'house-style')
      assert.equal(lib?.ref.id, 'lib-1')

      // ③ 两边落在**不同目录**（真实落盘位置不能撞）
      assert.match(
        agentExclusiveSkillsDir(dir, '甲'),
        /agents[/\\]甲[/\\]skills$/,
        '账号智能体：目录名是名字的 name（D231）',
      )
      /*
       * ★ D235：内建智能体的技能目录**就在它自己的实体目录里面**
       *   （`workflows/<wid>/agents/<名字>/skills`），不是旁边一个 `<agentId>/`。
       *   这条是整轮的判据：改之前这里会拼出 `agents/wa-1/skills`——
       *   实体在 `agents/内建甲/`、技能在 `agents/wa-1/`，一个实体两个目录。
       */
      assert.equal(
        await workflowAgentExclusiveSkillsDir(dir, 'wf-1', 'wa-1'),
        join(dir, 'workflows', 'wf-1', 'agents', '内建甲', 'skills'),
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
      assert.equal(asWorkflow[0]!.ref.name, 'only-in-workflow')
      await store.close()
    } finally {
      await cleanup(dir)
    }
  })

  /*
   * ★★ D235 的回归判据：这条内建智能体**不存在**时——
   *   · 读 ⇒ 空列表（不该抛：定时任务/编排被删掉后残留的引用不该炸整页）；
   *   · 写 ⇒ 抛错（往不存在的实体写技能只会造出一个没有 `agent.json` 的孤儿目录）；
   *   · 而且**盘上不许出现以 id 命名的目录**——那正是改之前的毛病。
   */
  test('★★ 内建智能体不存在 ⇒ 读空、写抛，且盘上不留以 id 命名的目录', async () => {
    const dir = await makeTempDir('skill-sources-ghost')
    try {
      const store = await seed(dir)
      const ghost = { kind: 'workflow-agent', workflowId: 'wf-1', agentId: 'wa-不存在' } as const
      assert.deepEqual(await store.listExclusiveSkills(ghost), [], '读不许抛，也不许编出技能')
      assert.equal(await store.getExclusiveSkill(ghost, 'private-notes'), null)
      assert.equal(await store.removeExclusiveSkill(ghost, 'private-notes'), false)
      await assert.rejects(
        () => store.writeExclusiveSkill(ghost, 'private-notes', BODY),
        /不存在/,
        '写要抛，而不是悄悄造目录',
      )
      assert.deepEqual(await readdir(join(dir, 'workflows', 'wf-1', 'agents')), ['内建甲'])
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
