import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ★★ 2026-11（D164）：**名字唯一**（新建 / 改名都查）+ 复制所需的 `rawInstructions`。
 *
 * ⚠️ 这个文件原来是 D160 的"复制接口"用例。**那条接口已经删掉**（使用者："复制智能体，
 *   属于新建状态，点保存才保存"）——复制现在是"用那条的配置预填一张新建表单"，
 *   落库仍走 `POST /api/agents`。所以这里改为钉"复制这条路上真正在服务端发生的事"：
 *
 *   ① **名字唯一**：新建撞名 / 改名撞名都拒（点名是哪一条）；
 *   ② 改成**自己那个名字**是 no-op（不该报重复）；
 *   ③ 详情给的 `rawInstructions` 是**原文**（复制预填必须用它，不能用组装后全文）。
 *
 * 内置助手 / 老工作区认领那几组判据（D161/D162 加的）保持原样——它们与本轮的改动无关。
 *
 * 它替掉了原来两颗按钮（「恢复成默认值」与「改为普通智能体」）：想改内置智能体的口吻，
 * 就**复制一条自建的去改**——平台那条原样不动。所以这组判据钉的是"复制得对、不越界"：
 *
 *   ① 配置抄全了（指令是**原文**、CLI/模型/环境变量/技能都对）；
 *   ② 副本是**你自己的**（`owner: user` + 三项入口全开），不继承 `action:` 入口；
 *   ③ **不抄**记忆条目、**不抄**独有技能（那是它的经验与文件资产）；
 *   ④ 平台那条**一个字都没变**（复制不是"搬走"）；
 *   ⑤ 名字重了会补序号（两条一模一样的名字没人分得清）。
 */

type AgentRow = {
  id: string
  name: string
  instructions: string
  owner?: string
  entries?: string[]
  skillIds: string[]
  memoryEnabled?: boolean
  runtimeKey?: string
  slot?: string | null
}

async function withDaemon<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('agent-copy')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    backend: {
      key: 'claude',
      protocol: 'stream-json',
      rejectDetectable: true,
      async probe() {
        return { available: false, command: 'claude', cliVersion: null }
      },
      async execute() {
        throw new Error('这个测试不该执行任何 run')
      },
    } as never,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn(d.url)
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

async function json<T>(url: string): Promise<T> {
  return (await (await fetch(url)).json()) as T
}

async function agentsOf(url: string): Promise<AgentRow[]> {
  return (await json<{ agents: AgentRow[] }>(`${url}/api/agents`)).agents
}


describe('★★ 名字唯一：新建与改名都查（点名是哪一条）', () => {
  test('★★ 新建撞名 ⇒ 400 agent_name_taken，并点名撞的是哪一条', async () => {
    await withDaemon(async (url) => {
      const first = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '重名的人' }),
      })
      assert.equal(first.status, 201)

      const again = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '重名的人' }),
      })
      assert.equal(again.status, 400)
      const body = (await again.json()) as { code?: string; error: string }
      assert.equal(body.code, 'agent_name_taken')
      assert.match(body.error, /已经有同名的智能体/)
      assert.match(body.error, /你自己的（/, '要点名是哪一条')
    })
  })

  test('★★ 改名撞名 ⇒ 400；但改成**自己那个名字**是 no-op（不该报重复）', async () => {
    await withDaemon(async (url) => {
      const mk = async (name: string): Promise<string> => {
        const res = await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        return ((await res.json()) as { id: string }).id
      }
      const a = await mk('甲')
      await mk('乙')
      const patch = (id: string, body: unknown) =>
        fetch(`${url}/api/agents/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      const collide = await patch(a, { name: '乙' })
      assert.equal(collide.status, 400)
      assert.equal(((await collide.json()) as { code?: string }).code, 'agent_name_taken')

      // 改成自己那个名字（比如只改了别的字段、名字原样发回来）⇒ 放行
      const same = await patch(a, { name: '甲' })
      assert.equal(same.status, 200, '改成自己那个名字是 no-op，不是冲突')
    })
  })

  test('★ 空名字/纯空白在新建就被拒（不参与重名判断）', async () => {
    await withDaemon(async (url) => {
      const res = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })
      assert.equal(res.status, 400)
    })
  })

  test('★★ 详情带 rawInstructions：是**原文**（复制预填要用它，不能拿组装后的全文）', async () => {
    await withDaemon(async (url) => {
      const drafter = (await agentsOf(url)).find((a) => a.slot === 'drafter')!
      const detail = (await json<{ instructions: string; rawInstructions?: string }>(
        `${url}/api/agents/${drafter.id}`,
      )) as never as { instructions: string; rawInstructions?: string }
      assert.ok(detail.rawInstructions, '详情要给原文')
      assert.equal(
        detail.rawInstructions!.includes('## 工作守则'),
        false,
        '原文里没有平台守则那一段',
      )
      assert.equal(
        detail.instructions.includes('## 工作守则'),
        true,
        '（对照）`instructions` 是组装后的全文',
      )
    })
  })
})

/*
 * ⚠️ 2026-11（D164）：这里原来还有一组"复制时滤掉悬空 skill id"的用例——那条接口
 *   删掉之后它失去了对象。**该性质现在由前端预填这一侧保证**：预填抄的是详情里的
 *   `skillIds`，而落库走 `POST /api/agents` 的老校验（挂载的 skill 必须真的存在，
 *   不存在就 400）——那道闸一直在，且有它自己的用例。
 */

/**
 * ★ 2026-11（D161）：**内置「助手」**——平台唯一一个三项接入点全开的成员，而且**是默认**。
 */
describe('★ 内置助手：三项入口 + 默认智能体', () => {
  test('★★ 启动之后它在，接入点是 chat + task + workflow，而且它就是默认', async () => {
    await withDaemon(async (url) => {
      const agents = await agentsOf(url)
      const assistant = agents.find((a) => a.slot === 'assistant')
      assert.ok(assistant, '启动对账要建出内置「助手」')
      assert.equal(assistant.name, '助手', '名字不带「（内置）」后缀（D161）')
      assert.equal(assistant.owner, 'platform')
      assert.deepEqual(
        [...(assistant.entries ?? [])].sort(),
        ['chat', 'task', 'workflow'],
        '三项入口全开（其余平台成员只有自己那一件事）',
      )
      const list = await json<{ defaultAgentId: string | null }>(`${url}/api/agents`)
      assert.equal(list.defaultAgentId, assistant.id, '它就是默认智能体')
    })
  })

  test('★★ 名字里不再有「（内置）」后缀，但"哪条是内置的"仍认得出来（槽位）', async () => {
    await withDaemon(async (url) => {
      const agents = await agentsOf(url)
      assert.equal(
        agents.some((a) => String(a.name).includes('（内置）')),
        false,
        '所有内置成员的名字都不再带后缀',
      )
      const platform = agents.filter((a) => a.owner === 'platform')
      assert.equal(platform.length, 5)
      assert.ok(
        platform.every((a) => typeof a.slot === 'string' && a.slot !== ''),
        '每一条都有槽位（名字变了，身份没变）',
      )
    })
  })
})

/**
 * ★ 2026-11（D162）：**默认智能体可以换成平台成员**（使用者："内置助手不能被设置默认呢"）。
 *
 * 界面那颗按钮原来被 `!readOnly` 挡着——而"设成默认"改的是**工作区设置**，不是这条
 * 智能体本身，与它只读与否无关。接口层从来没有这条限制（只要求 chat + task）。
 */
describe('★ 平台成员（含内置助手）可以被设成默认', () => {
  test('★★ 建一条自建执行者设为默认，再把它换回内置助手', async () => {
    await withDaemon(async (url) => {
      const assistant = (await agentsOf(url)).find((a) => a.slot === 'assistant')!
      const mine = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '我的执行者', instructions: '' }),
        })
      ).json()) as AgentRow

      const setDefault = (id: string) =>
        fetch(`${url}/api/agents/default`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: id }),
        })

      assert.equal((await setDefault(mine.id)).status, 200)
      assert.equal(
        (await json<{ defaultAgentId: string | null }>(`${url}/api/agents`)).defaultAgentId,
        mine.id,
      )
      assert.equal((await setDefault(assistant.id)).status, 200)
      assert.equal(
        (await json<{ defaultAgentId: string | null }>(`${url}/api/agents`)).defaultAgentId,
        assistant.id,
        '内置助手可以被设回默认（只读与否与这件事无关）',
      )
    })
  })
})

/**
 * ★ 2026-11（D162）：**老工作区里"早就在"的成员也要被认领进槽位表**。
 *
 * `claimSlot()` 原来只在**新建**那一支调用，而老工作区的成员是 `resolveSlot()` 用老字段
 * 兜底找到的 —— 找到了却**从不写进表**。于是：① 名字迁移（去「（内置）」后缀）遍历表
 * ⇒ 那几条永远不改名；② `alignMemberEntries` 同理；③ 每次启动都靠老字段兜底。
 */
describe('★ 老工作区：已有的成员被认领进槽位表，名字与接入点随之对齐', () => {
  test('★★ 四条老形态记录 + 无默认 ⇒ 对账后：名字去后缀、槽位全在、默认是助手', async () => {
    const dir = await makeTempDir('agent-legacy-slot-claim')
    const now = Date.now()
    const { FileStore } = await import('@agentdeck/store-file')
    const { wsId } = await import('@agentdeck/domain/testing')
    const WS = wsId('ws-legacy-claim')
    const seed = await FileStore.open({ dataDir: dir, fsync: false })
    await seed.insertWorkspace({ id: WS, name: '老工作区', createdAt: now, updatedAt: now } as never)
    for (const [id, name, kind] of [
      ['legacy-drafter', '沉淀起草者（内置）', 'drafter'],
      ['legacy-tidy', '记忆整理者（内置）', 'memory-tidy'],
      ['legacy-maker', '智能体生成者（内置）', 'agent-maker'],
      ['legacy-wf', '编排生成者（内置）', 'workflow-maker'],
    ] as const) {
      await seed.insertAgent({
        id,
        workspaceId: WS,
        name,
        instructions: '旧身份',
        memoryEnabled: false,
        model: null,
        runtimeKey: 'default',
        workDir: null,
        skillIds: [],
        env: {},
        reviewStandard: null,
        builtin: true,
        builtinKind: kind,
        createdAt: now,
        updatedAt: now,
      } as never)
    }
    await seed.close()

    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: {
        key: 'claude',
        protocol: 'stream-json',
        rejectDetectable: true,
        async probe() {
          return { available: false, command: 'claude', cliVersion: null }
        },
        async execute() {
          throw new Error('这个测试不该执行任何 run')
        },
      } as never,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const { agents, defaultAgentId } = await json<{
        agents: AgentRow[]
        defaultAgentId: string | null
      }>(`${d.url}/api/agents`)

      assert.equal(
        agents.some((a) => String(a.name).includes('（内置）')),
        false,
        `所有内置成员的名字都不该再带后缀（实际：${agents.map((a) => a.name).join('、')}）`,
      )
      for (const [name, slot] of [
        ['沉淀起草者', 'drafter'],
        ['记忆整理者', 'memory-tidy'],
        ['智能体生成者', 'agent-maker'],
        ['编排生成者', 'workflow-maker'],
      ] as const) {
        assert.equal(agents.find((a) => a.name === name)?.slot, slot, `${name} 的槽位`)
      }
      const assistant = agents.find((a) => a.slot === 'assistant')
      assert.ok(assistant, '老工作区也要补建内置助手')
      assert.equal(defaultAgentId, assistant.id, '还没有默认 ⇒ 对账把它设成助手')
    } finally {
      await d.close()
      await cleanup(dir)
    }
  })
})
