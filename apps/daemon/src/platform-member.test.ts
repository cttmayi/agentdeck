import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FileStore } from '@agentdeck/store-file'
import { wsId } from '@agentdeck/domain/testing'
import type { Agent } from '@agentdeck/protocol'
import { ensureBuiltinAgents } from './builtin-drafter.ts'
import {
  MEMBER_ACTION_IDS,
  PLATFORM_MEMBER_ENTRIES,
  canBeCalledByAction,
  canBeDispatched,
  canBeReferencedByWorkflow,
  canChat,
  entriesOf,
  isHalfBuiltin,
  isMemberEntry,
  migratePlatformMemberFields,
  ownerOf,
  platformMemberRefsInWorkflows,
  workflowReferenceableNames,
} from './platform-member.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

const WS = wsId('ws-platform-member')

/** 造一条最小记录（只填判据关心的字段）。 */
function member(patch: Partial<Agent> & { name: string }): Agent {
  return {
    id: patch.name as Agent['id'],
    workspaceId: WS,
    instructions: 'x',
    model: null,
    runtimeKey: 'default',
    workDir: null,
    skillIds: [],
    env: {},
    reviewStandard: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as Agent
}

describe('归属 owner：只读 / 可删的**唯一**判据（D145）', () => {
  test('★★ 新字段优先；老字段能回退（迁移没跑也不会错）', () => {
    assert.equal(ownerOf(member({ name: 'a', owner: 'user' })), 'user')
    assert.equal(ownerOf(member({ name: 'a', owner: 'platform' })), 'platform')
    // 老数据：builtin + 岗位值都在 ⇒ platform
    assert.equal(
      ownerOf(member({ name: 'a', builtin: true, builtinKind: 'drafter' })),
      'platform',
    )
    // 半内置（builtin 在、岗位缺）⇒ 按用户记录处理（可修可删，而**不是**被锁成僵尸）
    assert.equal(ownerOf(member({ name: 'a', builtin: true })), 'user')
    assert.equal(ownerOf(member({ name: 'a' })), 'user')
  })

  test('★★★ 半内置会被**点名**（`isHalfBuiltin`），但不会被静默当成平台成员', () => {
    const half = member({ name: '半', builtin: true })
    assert.equal(isHalfBuiltin(half), true)
    assert.equal(ownerOf(half), 'user', '它不是任何一条已声明的成员')
    // 迁移过（有 owner）的一律不再算半内置
    assert.equal(isHalfBuiltin(member({ name: 'x', builtin: true, owner: 'user' })), false)
  })

  test('★ 已下线的 skill-reviewer 按用户记录处理（可删、可改）', () => {
    const retired = member({ name: 'r', builtin: true, builtinKind: 'skill-reviewer' })
    assert.equal(ownerOf(retired), 'user')
    assert.deepEqual(entriesOf(retired), ['chat', 'task', 'workflow'])
  })
})

describe('接入点 entries：谁能叫它（多选）', () => {
  test('★★ 平台成员按出厂表；用户记录三项全开', () => {
    const user = member({ name: 'u' })
    assert.deepEqual(entriesOf(user), ['chat', 'task', 'workflow'])
    assert.equal(canChat(user) && canBeDispatched(user) && canBeReferencedByWorkflow(user), true)

    const drafter = member({ name: 'd', builtin: true, builtinKind: 'drafter' })
    assert.deepEqual(entriesOf(drafter), ['action:skill-draft'])
    assert.equal(canChat(drafter), false)
    assert.equal(canBeDispatched(drafter), false, '平台成员默认不接业务任务')
    assert.equal(canBeReferencedByWorkflow(drafter), false, '平台成员默认不进编排候选')
    assert.equal(canBeCalledByAction(drafter, 'skill-draft'), true)

    // ★ 多选的最小证据：生成者**既是聊天入口**，又有两个动作
    const maker = member({ name: 'm', builtin: true, builtinKind: 'agent-maker' })
    assert.equal(canChat(maker), true)
    assert.equal(canBeCalledByAction(maker, 'agent-draft'), true)
    assert.equal(canBeCalledByAction(maker, 'agent-commit'), true)
    assert.equal(canBeDispatched(maker), false)
  })

  test('★ 显式 entries 覆盖出厂表；值域外的值被丢掉（封闭值域）', () => {
    const custom = member({ name: 'c', owner: 'platform', entries: ['chat', 'action:nope', '乱写'] })
    assert.deepEqual(entriesOf(custom), ['chat'])
    assert.equal(isMemberEntry('action:skill-draft'), true)
    assert.equal(isMemberEntry('action:不存在的'), false)
    assert.equal(isMemberEntry('dispatch'), false)
    for (const id of MEMBER_ACTION_IDS) assert.equal(isMemberEntry(`action:${id}`), true)
  })

  test('★ 四条出厂成员都有声明（加一条成员时表里必须有）', () => {
    for (const kind of ['drafter', 'memory-tidy', 'agent-maker', 'workflow-maker'] as const) {
      assert.ok(Array.isArray(PLATFORM_MEMBER_ENTRIES[kind]), `${kind} 要有声明`)
    }
  })
})

describe('迁移：把推导结果写进数据（幂等、不删老字段、半内置点名）', () => {
  test('★★★ 迁移一次就位；再跑一遍什么都不写；半内置被点名', async () => {
    const dir = await makeTempDir('platform-member-migrate')
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    try {
      await ensureBuiltinAgents(store, WS)
      // 造一条半内置（builtin 在、岗位缺）
      await store.insertAgent(member({ name: '坏掉的', builtin: true }))

      const first = await migratePlatformMemberFields(store, WS)
      assert.ok(first.migrated.length >= 5, `至少要迁移 4 条出厂成员 + 那条坏的（实际 ${first.migrated.length}）`)
      assert.deepEqual(first.halfBuiltin, ['坏掉的'], '半内置要**点名**')

      const drafter = (await store.listAgents(WS)).find((a) => a.name === '沉淀起草者（内置）')!
      assert.equal(drafter.owner, 'platform')
      assert.deepEqual(drafter.entries, ['action:skill-draft'])
      assert.equal(drafter.builtin, true, '⚠️ 老字段保留（回滚只需发旧版代码）')

      const half = (await store.listAgents(WS)).find((a) => a.name === '坏掉的')!
      assert.equal(half.owner, 'user', '半内置按用户记录处理（可修可删）')
      assert.deepEqual(half.entries, ['chat', 'task', 'workflow'])

      const again = await migratePlatformMemberFields(store, WS)
      assert.deepEqual(again.migrated, [], '第二遍不再写')
      assert.deepEqual(again.halfBuiltin, [], '也不该再点名（它已经有 owner 了）')
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })
})

describe('上线前的体检：现有编排里引用平台成员的，启动时点名（D145）', () => {
  test('★★ 只报"名字存在但不能被编排引用"的那些；拼出来的引用不算', async () => {
    const dir = await makeTempDir('platform-member-scan')
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    try {
      await ensureBuiltinAgents(store, WS)
      await store.insertAgent(member({ name: '撰稿员' }))
      const workflows = [
        { name: '好的', code: "await flow([agent('撰稿员')], '{{task}}')" },
        { name: '坏的', code: "await flow([agent('沉淀起草者（内置）')], '{{task}}')" },
        { name: '拼出来的', code: 'await flow(名单.map((n) => agent(n)), "{{task}}")' },
      ]
      const stale = await platformMemberRefsInWorkflows(store, WS, workflows)
      assert.equal(stale.length, 1, `只该有"坏的"那一条：${JSON.stringify(stale)}`)
      assert.match(stale[0]!, /坏的/)
      assert.match(stale[0]!, /沉淀起草者（内置）/, '要点名是谁')

      // 采纳校验用的名单与引擎同一句判据：平台成员不在里面
      const names = workflowReferenceableNames(await store.listAgents(WS))
      assert.ok(names.includes('撰稿员'))
      assert.ok(!names.includes('沉淀起草者（内置）'))
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })
})
