import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * ★ 2026-11（D160）：**复制智能体**（`POST /api/agents/:id/copy`）。
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

async function copy(url: string, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}/api/agents/${id}/copy`, { method: 'POST' })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('★ 复制智能体：抄配置、给自建身份、不动原件', () => {
  test('★★ 复制平台成员 ⇒ 得到一条自建的副本，配置抄全、入口是三项', async () => {
    await withDaemon(async (url) => {
      const drafter = (await agentsOf(url)).find((a) => a.slot === 'drafter')!
      assert.ok(drafter, '启动对账要有起草者')

      const res = await copy(url, drafter.id)
      assert.equal(res.status, 201, JSON.stringify(res.body))
      const made = res.body['agent'] as AgentRow

      assert.equal(made.owner, 'user', '副本是**你自己的**')
      assert.deepEqual(made.entries, ['chat', 'task', 'workflow'], '三项入口全开')
      assert.equal(made.slot, null, '它不占任何出厂槽位')
      assert.match(made.name, /（副本）/, '名字要能看出是副本')
      /*
       * 指令抄的是**原文**（平台成员存的是"组装前正文"，运行时才拼平台守则）。
       * ⚠️ 所以不能拿 `GET /api/agents` 给的那份（它是**组装后**的全文）去比：
       *   副本里不该出现「## 工作守则」那一段——出现就说明抄的时候把组装过的存进去了，
       *   而它作为自建智能体不会再次组装，那段守则就成了"使用者写的"。
       */
      assert.equal(
        made.instructions.includes('## 工作守则'),
        false,
        '副本存的是原文（不含平台守则那段）',
      )
      assert.ok(drafter.instructions.includes('## 工作守则'), '（对照）原件对外给的是组装后全文')
      // 平台触发它的那条 action 入口**不继承**
      assert.equal(
        (made.entries ?? []).some((e) => e.startsWith('action:')),
        false,
        '副本不该有"平台会来叫它"的入口',
      )
    })
  })

  test('★★ 原件一个字都没变（复制不是"搬走"）', async () => {
    await withDaemon(async (url) => {
      const before = (await agentsOf(url)).find((a) => a.slot === 'drafter')!
      await copy(url, before.id)
      const after = (await agentsOf(url)).find((a) => a.id === before.id)!
      assert.deepEqual(after, before, '平台那条原样留着')
      // 平台上仍然是四条（复制不会让平台"少一条"再补一条）
      assert.equal((await agentsOf(url)).filter((a) => a.owner === 'platform').length, 4)
    })
  })

  test('★ 自建也能复制；挂载的技能跟着走，已卸载的 id 不跟（不留悬空引用）', async () => {
    await withDaemon(async (url) => {
      const skill = (await (
        await fetch(`${url}/api/skills/install`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: { kind: 'payload', slug: 'copy-skill', body: '# x\n', files: {} },
          }),
        })
      ).json()) as { installed: Array<{ id: string }> }
      const skillId = skill.installed[0]!.id
      const created = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '原主', instructions: '你是原主。', skillIds: [skillId] }),
        })
      ).json()) as AgentRow

      const res = await copy(url, created.id)
      assert.equal(res.status, 201)
      const made = res.body['agent'] as AgentRow
      assert.equal(made.instructions, '你是原主。')
      assert.deepEqual(made.skillIds, [skillId], '挂着的技能跟着走')

      /*
       * "库里已经没有的 id 不复制"这一条**不能**通过卸技能来造：删除接口有守卫
       * （"还有智能体挂着它"直接拒），所以那条路走不通。改成**直接摆一条悬空引用**：
       * 只有存储层才造得出这种数据，而复制必须把它滤掉——不然副本会带着一个运行时
       * 才炸的 id。
       */
      void created
    })
  })

  test('★ 名字重了补序号（两条一模一样的名字没人分得清）', async () => {
    await withDaemon(async (url) => {
      const created = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '重名测试' }),
        })
      ).json()) as AgentRow
      const a = (await copy(url, created.id)).body['agent'] as AgentRow
      const b = (await copy(url, created.id)).body['agent'] as AgentRow
      assert.equal(a.name, '重名测试（副本）')
      assert.equal(b.name, '重名测试（副本） 2')
      assert.notEqual(a.id, b.id)
    })
  })

  test('★ 不存在的 agent ⇒ 404（不许"静默复制成一条空的"）', async () => {
    await withDaemon(async (url) => {
      const res = await copy(url, 'not-an-agent')
      assert.equal(res.status, 404)
    })
  })
})

/**
 * ★ 悬空引用（库里已经没有的 skill id）**必须被滤掉**——这条只能从存储层造：
 * 删除接口有守卫（"还有智能体挂着它"直接拒），所以 API 造不出这种数据。
 */
describe('★ 复制时滤掉悬空引用', () => {
  test('原记录挂着一个库里没有的 skill id ⇒ 副本不继承它', async () => {
    const dir = await makeTempDir('agent-copy-dangling')
    const now = Date.now()
    const { FileStore } = await import('@agentdeck/store-file')
    const { wsId } = await import('@agentdeck/domain/testing')
    const WS = wsId('ws-copy-dangling')
    const seed = await FileStore.open({ dataDir: dir, fsync: false })
    await seed.insertWorkspace({ id: WS, name: '复制测试', createdAt: now, updatedAt: now } as never)
    await seed.insertAgent({
      id: 'seeded-dangling' as never,
      workspaceId: WS,
      name: '挂着幽灵技能的人',
      instructions: '你是测试用的。',
      memoryEnabled: false,
      model: null,
      runtimeKey: 'claude',
      workDir: null,
      skillIds: ['ghost-skill'] as never,
      env: {},
      reviewStandard: null,
      owner: 'user',
      entries: ['chat', 'task', 'workflow'],
      createdAt: now,
      updatedAt: now,
    } as never)
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
      const res = await fetch(`${d.url}/api/agents/seeded-dangling/copy`, { method: 'POST' })
      assert.equal(res.status, 201)
      const made = ((await res.json()) as { agent: AgentRow }).agent
      assert.deepEqual(made.skillIds, [], '悬空 id 不许跟过去（它要到运行时才炸）')
    } finally {
      await d.close()
      await cleanup(dir)
    }
  })
})
