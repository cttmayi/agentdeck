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
  parseUserEntries,
  platformMemberRefsInWorkflows,
  workflowReferenceableNames,
} from './platform-member.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { ensureTestWorkspace } from './testing/test-workspace.ts'

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

    /*
     * 多选的最小证据：生成者**既是聊天入口**，又有一个动作。
     * ⚠️ 2026-11（D155）：原来这里还断言 `action:agent-draft`——那是**死接口**（没有任何
     *   代码产出 `agent-draft` 这种 run，"写岗位卡"发生在普通聊天 run 里），已删。
     *   于是两个生成者都只有**一个**动作（各自的"采纳"）。
     */
    const maker = member({ name: 'm', builtin: true, builtinKind: 'agent-maker' })
    assert.equal(canChat(maker), true)
    assert.equal(canBeCalledByAction(maker, 'agent-commit'), true)
    assert.deepEqual(entriesOf(maker), ['chat', 'action:agent-commit'])
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
    // ★ 2026-11（D154）：槽位表挂在工作区上 ⇒ 用 store 的用例必须先有工作区
    await ensureTestWorkspace(store, WS)
    try {
      await ensureBuiltinAgents(store, WS)
      /*
       * ⚠️ 2026-11（D154）：出厂成员是**新建的**，它们一出生就有 `owner` + `entries`
       *   （不再写老字段）⇒ 迁移对它们是空转。所以这里要造**老形态**的记录来测迁移：
       *   一条 `builtin + builtinKind` 且没有 owner（老工作区里的样子），
       *   一条半内置（`builtin: true` 但岗位缺）。
       */
      await store.insertAgent(
        member({ name: '老起草者', builtin: true, builtinKind: 'drafter', instructions: '旧身份' }),
      )
      await store.insertAgent(member({ name: '坏掉的', builtin: true }))

      const first = await migratePlatformMemberFields(store, WS)
      assert.deepEqual(
        first.migrated.slice().sort(),
        ['坏掉的', '老起草者'],
        `只有"还没有 owner 的记录"需要迁移（实际 ${JSON.stringify(first.migrated)}）`,
      )
      assert.deepEqual(first.halfBuiltin, ['坏掉的'], '半内置要**点名**')

      const legacy = (await store.listAgents(WS)).find((a) => a.name === '老起草者')!
      assert.equal(legacy.owner, 'platform', '老形态按老字段推出归属')
      assert.deepEqual(legacy.entries, ['action:skill-draft'], '并按老字段推出接入点')
      assert.equal(legacy.builtin, true, '⚠️ 老字段保留（回滚只需发旧版代码）')
      assert.equal(legacy.builtinKind, 'drafter', '同上——迁移只补新字段，不删旧的')

      const half = (await store.listAgents(WS)).find((a) => a.name === '坏掉的')!
      assert.equal(half.owner, 'user', '半内置按用户记录处理（可修可删）')
      assert.deepEqual(half.entries, ['chat', 'task', 'workflow'])

      const again = await migratePlatformMemberFields(store, WS)
      assert.deepEqual(again.migrated, [], '第二遍不再写')
      assert.deepEqual(again.halfBuiltin, [], '也不该再点名（它已经有 owner 了）')

      // ★ 出厂成员本身不带老字段（新记录只写 owner + entries）
      const fresh = (await store.listAgents(WS)).find((a) => a.name === '沉淀起草者')!
      assert.equal(fresh.owner, 'platform')
      assert.equal(
        (fresh as { builtin?: boolean }).builtin,
        undefined,
        'D154：新建的成员不写 builtin / builtinKind',
      )
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
    // ★ 2026-11（D154）：槽位表挂在工作区上 ⇒ 用 store 的用例必须先有工作区
    await ensureTestWorkspace(store, WS)
    try {
      await ensureBuiltinAgents(store, WS)
      await store.insertAgent(member({ name: '撰稿员' }))
      const workflows = [
        { name: '好的', code: "await flow([agent('撰稿员')], '{{task}}')" },
        { name: '坏的', code: "await flow([agent('沉淀起草者')], '{{task}}')" },
        { name: '拼出来的', code: 'await flow(名单.map((n) => agent(n)), "{{task}}")' },
      ]
      const stale = await platformMemberRefsInWorkflows(store, WS, workflows)
      assert.equal(stale.length, 1, `只该有"坏的"那一条：${JSON.stringify(stale)}`)
      assert.match(stale[0]!, /坏的/)
      assert.match(stale[0]!, /沉淀起草者/, '要点名是谁')

      // 采纳校验用的名单与引擎同一句判据：平台成员不在里面
      const names = workflowReferenceableNames(await store.listAgents(WS))
      assert.ok(names.includes('撰稿员'))
      assert.ok(!names.includes('沉淀起草者'))
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })
})

/**
 * ★ 2026-11（D146）：`parseUserEntries` —— 新建 / 编辑共用的那一道校验。
 *
 * 它是**纯函数**，所以在这里逐条钉住"值域封闭"这件事实；接口层的用例
 * （`agents-create.test.ts`）另外钉"它真的被接在两条路上"。
 */
describe('★ 入口校验：值域封闭、action 不给自定义智能体、一个都不留要拒', () => {
  test('不传 ⇒ 三项全开（与 entriesOf 对用户记录的回退一致）', () => {
    for (const raw of [undefined, null]) {
      const r = parseUserEntries(raw)
      assert.equal(r.ok, true)
      assert.deepEqual(r.ok && r.value, ['chat', 'task', 'workflow'])
    }
  })

  test('★ 次序规范化 + 去重：同一份配置不该因为勾选先后长得不一样', () => {
    const r = parseUserEntries(['workflow', 'chat', 'workflow'])
    assert.deepEqual(r.ok && r.value, ['chat', 'workflow'])
  })

  test('★ action:* 一律拒（那是平台发起的动作，勾上也没有东西会叫它）', () => {
    for (const id of MEMBER_ACTION_IDS) {
      const r = parseUserEntries([`action:${id}`])
      assert.equal(r.ok, false, `action:${id} 不该被收下`)
      assert.match(r.ok === false ? r.error : '', /平台动作/)
    }
  })

  test('★ 空数组 / 类型不对 / 拼错的名字 ⇒ 各自一句能照做的话', () => {
    const empty = parseUserEntries([])
    assert.equal(empty.ok, false)
    assert.match(empty.ok === false ? empty.error : '', /至少要有一个入口/)

    const notArray = parseUserEntries('chat')
    assert.match(notArray.ok === false ? notArray.error : '', /必须是数组/)

    const wrong = parseUserEntries(['chats'])
    assert.match(wrong.ok === false ? wrong.error : '', /不认识的入口：chats/)

    const blank = parseUserEntries([''])
    assert.match(blank.ok === false ? blank.error : '', /非空字符串/)
  })

  test('★ 校验通过的值一定过得了 isMemberEntry（两处判据不许分叉）', () => {
    const r = parseUserEntries(['task', 'chat'])
    assert.equal(r.ok, true)
    for (const e of r.ok ? r.value : []) assert.equal(isMemberEntry(e), true)
  })
})
