/**
 * 内置的有**两条**（起草者 + skill 审核者）：判据必须是 `builtin` **+ 角色**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一批修的是什么（都是量出来的，不是想出来的）
 * ══════════════════════════════════════════════════════════════════
 *
 * 从前的判据是 `listAgents(...).find((a) => a.builtin === true)` —— 写它的时候内置
 * 只有起草者一条，所以"内置的那条"= "起草者"还成立。第 34–38 批加进 skill 审核者
 * （也是 `builtin: true`）之后，这句话就变成了"列表里**先出现的那条内置**"，
 * 而列表顺序是**日志里的写入顺序**，不是"起草者一定在前"。
 *
 * 我先写了个探针，把顺序反过来（审核者先入库）量，三种坏法全都复现：
 *   ① 起草者的 `builtin` 标记丢了（历史迁移过/盘上被改过）⇒ 撞上的是审核者，
 *      返回 `left-alone` 且指向**审核者**，起草者的标记**永远修不回来**：
 *      那条"按角色认出来补标记"的自愈分支成了死代码，而那条起草者从此可删、可进组。
 *   ② 审核者的指令被清空 ⇒ 起草者指令被写进**审核者**（我把指令整块换成起草者的，
 *      于是审核者去起草、起草者去审核）；随后审核者自己的对账看到"非空且不在历史里"
 *      ⇒ `left-alone`，**永久静默损坏**，重启也不会修。
 *   ③ 对审核者按「恢复成默认值」⇒ 200，名字变「起草者（内置）」、指令变起草者文本，
 *      而角色还是 `skill-reviewer`。界面上那个按钮对**两条内置都出现**
 *      （`AgentDetail.svelte` 的 `{#if agent.builtin}`），所以这是一点就中的坑。
 *
 * 为什么这些必须钉在测试里：三种坏法全都不报错、不抛异常，界面看着只是"名字有点怪"，
 * 而后果是沉淀这条链的**身份**错位（身份决定了产出结构）。靠人看是看不出来的。
 *
 * ⚠️ 真 FileStore + 临时目录（仓库内 `.cache/test-tmp`），不碰任何 CLI（NFR-T-01）。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FileStore } from '@agentdeck/store-file'
import { wsId } from '@agentdeck/domain/testing'
import { ulid } from '@agentdeck/protocol'
import type { Agent, Workspace } from '@agentdeck/protocol'
import {
  builtinDefaultsOf,
  builtinKindOf,
  DRAFTER_INSTRUCTIONS,
  DRAFTER_NAME,
  ensureBuiltinAgents,
  ensureBuiltinDrafter,
  SKILL_REVIEWER_INSTRUCTIONS,
  SKILL_REVIEWER_NAME,
} from './builtin-drafter.ts'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

const WS = wsId('ws-builtin-role')

/** 造一条 agent（只为把"顺序"和"损坏状态"摆出来，不走接口）。 */
function mkAgent(
  role: Agent['role'],
  name: string,
  instructions: string,
  builtin: boolean,
): Agent {
  const now = Date.now()
  return {
    id: ulid() as Agent['id'],
    workspaceId: WS as Agent['workspaceId'],
    name,
    instructions,
    model: null,
    runtimeKey: 'default',
    workDir: null,
    skillIds: [],
    env: {},
    role,
    builtin,
    reviewStandard: null,
    createdAt: now,
    updatedAt: now,
  }
}

/** 每个用例一个独立数据目录：内置的对账是**有状态**的，共用会让前一条的修复污染后一条。 */
async function withStore<T>(fn: (store: FileStore, dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir('builtin-role')
  const store = await FileStore.open({ dataDir: dir, fsync: false })
  try {
    return await fn(store, dir)
  } finally {
    await store.close()
    await cleanup(dir)
  }
}

describe('判据本身：`builtin` 只是"是平台的"，`role` 才是"是哪一条"', () => {
  test('★ 起草者/审核者各认各的；普通 agent 与"标记+怪角色"都返回 null（不猜）', () => {
    assert.equal(builtinKindOf({ builtin: true, role: 'drafter' }), 'drafter')
    assert.equal(builtinKindOf({ builtin: true, role: 'skill-reviewer' }), 'skill-reviewer')
    // 普通执行者：不是内置
    assert.equal(builtinKindOf({ builtin: false, role: 'executor' }), null)
    assert.equal(builtinKindOf({ role: 'executor' }), null)
    // 挂着内置标记但角色是业务角色（老记录/被手改过）：**不替它猜一套默认值**
    // ——猜错就是把起草者指令写进审核者（见下面 ② 那条）
    assert.equal(builtinKindOf({ builtin: true, role: 'reviewer' }), null)
    assert.equal(builtinKindOf({ builtin: true, role: 'executor' }), null)
  })

  test('★ 两条内置的默认值**不是同一套**（否则"恢复成默认值"就是把一条变成另一条）', () => {
    const drafter = builtinDefaultsOf('drafter')
    const reviewer = builtinDefaultsOf('skill-reviewer')
    assert.equal(drafter.name, DRAFTER_NAME)
    assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS)
    assert.equal(reviewer.name, SKILL_REVIEWER_NAME)
    assert.equal(reviewer.instructions, SKILL_REVIEWER_INSTRUCTIONS)
    assert.notEqual(drafter.name, reviewer.name)
    assert.notEqual(drafter.instructions, reviewer.instructions)
    // 说给人听的叫法也得分开：三处错误信息（不能进组/字段被锁/不能删）都拼它
    assert.notEqual(drafter.label, reviewer.label)
  })
})

describe('起草者的自愈：撞上审核者时必须**认角色**，不能按标记一把抓', () => {
  test('★★★ 起草者的 `builtin` 标记丢了、而审核者排在前面 ⇒ 补的是**起草者**的标记', async () => {
    await withStore(async (store) => {
      // 顺序就是这条用例的全部意义：审核者先入库 ⇒ 从前 `find(builtin)` 直接撞上它
      const reviewer = mkAgent('skill-reviewer', SKILL_REVIEWER_NAME, SKILL_REVIEWER_INSTRUCTIONS, true)
      const drafter = mkAgent('drafter', DRAFTER_NAME, DRAFTER_INSTRUCTIONS, false)
      await store.insertAgent(reviewer)
      await store.insertAgent(drafter)

      const result = await ensureBuiltinDrafter(store, WS)
      assert.equal(result.action, 'healed')
      if (result.action !== 'healed') return
      assert.equal(result.agentId, drafter.id, '被修好的必须是起草者，不是列表里先出现的那条内置')
      assert.match(result.why, /标记/)

      const after = await store.listAgents(WS)
      assert.equal(after.find((a) => a.id === drafter.id)!.builtin, true, '起草者的标记要真的补上')
      assert.equal(
        after.find((a) => a.id === reviewer.id)!.instructions,
        SKILL_REVIEWER_INSTRUCTIONS,
        '审核者的指令一个字都不许动',
      )
      assert.equal(after.length, 2, '不许"补不出来就再建一条"（那样每次启动多一条）')
    })
  })

  test('★★★ 审核者指令被清空 ⇒ 起草者的自愈**不许**把起草者指令写进审核者', async () => {
    await withStore(async (store) => {
      const reviewer = mkAgent('skill-reviewer', SKILL_REVIEWER_NAME, '   ', true)
      await store.insertAgent(reviewer)

      const result = await ensureBuiltinDrafter(store, WS)
      // 审核者坏了是**审核者那条对账**的事；起草者这条只该管好自己。
      assert.equal(result.action, 'created')
      const afterCreate = await store.listAgents(WS)
      const reviewerAfter = afterCreate.find((a) => a.id === reviewer.id)!
      assert.notEqual(
        reviewerAfter.instructions,
        DRAFTER_INSTRUCTIONS,
        '审核者拿到起草者指令 = 它以后按"你是 skill 作者"去审，而看起来一切正常',
      )
      const drafter = afterCreate.find((a) => a.role === 'drafter')
      assert.ok(drafter, '起草者必须被建出来')
      assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS)

      // 然后两条对账各修各的：审核者回到**它自己**的默认
      await ensureBuiltinAgents(store, WS)
      const final = await store.listAgents(WS)
      assert.equal(
        final.find((a) => a.role === 'skill-reviewer')!.instructions,
        SKILL_REVIEWER_INSTRUCTIONS,
      )
      assert.equal(final.find((a) => a.role === 'drafter')!.instructions, DRAFTER_INSTRUCTIONS)
    })
  })
})

/** 起一个 daemon（假后端：这些用例不该产生任何 run）。 */
async function withDaemon<T>(
  dataDir: string | null,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const dir = dataDir ?? (await makeTempDir('builtin-role-http'))
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
        throw new Error('这些用例不该执行任何 run')
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

interface AgentRow {
  id: string
  name: string
  instructions: string
  role: string
  builtin?: boolean
}

async function agentsOf(url: string): Promise<AgentRow[]> {
  const body = (await (await fetch(`${url}/api/agents`)).json()) as { agents: AgentRow[] }
  return body.agents
}

describe('接口层：内置的两条各按各的角色回答', () => {
  test('★★★ 「恢复成默认值」按在那条**审核者**上 ⇒ 回到审核者的默认（不是变成起草者）', async () => {
    await withDaemon(null, async (url) => {
      const before = await agentsOf(url)
      const reviewer = before.find((a) => a.role === 'skill-reviewer')
      const drafter = before.find((a) => a.role === 'drafter')
      assert.ok(reviewer && drafter, '启动之后两条内置都该在')

      // 使用者把审核者的名字和指令都改坏了（第 ⑥ 条允许他改）
      const patched = await fetch(`${url}/api/agents/${reviewer.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '我自己改的审核者', instructions: '改坏了' }),
      })
      assert.equal(patched.status, 200, await patched.text())

      const res = await fetch(`${url}/api/agents/${reviewer.id}/restore-default`, { method: 'POST' })
      const text = await res.text()
      assert.equal(res.status, 200, text)
      const body = JSON.parse(text) as { agent: AgentRow }
      assert.equal(body.agent.role, 'skill-reviewer', '角色不许被这条路由改掉')
      assert.equal(body.agent.name, SKILL_REVIEWER_NAME, '恢复成**它自己**的默认名字')
      assert.equal(body.agent.instructions, SKILL_REVIEWER_INSTRUCTIONS)
      assert.notEqual(
        body.agent.instructions,
        DRAFTER_INSTRUCTIONS,
        '恢复成起草者的指令 = 把审核者变成第二个起草者，而角色还写着 skill-reviewer',
      )

      // 起草者那边一个字都不该动
      assert.equal((await agentsOf(url)).find((a) => a.role === 'drafter')!.instructions, DRAFTER_INSTRUCTIONS)
    })
  })

  test('★★ 拒绝文案按**这条自己**的角色说（从前两处都硬写"起草者"）', async () => {
    await withDaemon(null, async (url) => {
      const agents = await agentsOf(url)
      const reviewer = agents.find((a) => a.role === 'skill-reviewer')!
      const drafter = agents.find((a) => a.role === 'drafter')!

      // ① 进智能体组
      for (const [agent, mustSay, mustNotSay] of [
        [reviewer, /审核者/, /起草者/],
        [drafter, /起草者/, /审核者/],
      ] as const) {
        const res = await fetch(`${url}/api/agent-groups`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '试图组', members: [agent.id] }),
        })
        const text = await res.text()
        assert.equal(res.status, 400, text)
        const { error } = JSON.parse(text) as { error: string }
        assert.match(error, /不能进智能体组/)
        assert.match(error, mustSay, `文案该说清拦下的是「${agent.role}」：${error}`)
        assert.doesNotMatch(error, mustNotSay, `不许把另一条的名字安在它身上：${error}`)
      }

      // ② 删除
      const del = await fetch(`${url}/api/agents/${reviewer.id}`, { method: 'DELETE' })
      const delText = await del.text()
      assert.equal(del.status, 400, delText)
      assert.match((JSON.parse(delText) as { error: string }).error, /审核者/)
      assert.doesNotMatch((JSON.parse(delText) as { error: string }).error, /起草者/)
    })
  })

  test('★★ 挂着内置标记但角色是业务角色 ⇒ 「恢复成默认值」**明说不知道**，不猜一套写进去', async () => {
    // 先按盘上的样子摆一条坏记录（角色既不是起草者也不是审核者），再起 daemon 读它。
    //
    // ⚠️ 光插 agent 不够：store 的 `#stores` 是**按 workspace 索引**建起来的
    //    （`listWorkspaceIds()` 读 `wsIndex`），没有 workspace 记录的目录根本不会被打开。
    //    我第一版只插了 agent，接口回的是 404「agent 不存在」——看起来像接口坏了。
    const dir = await makeTempDir('builtin-role-unknown')
    const seed = await FileStore.open({ dataDir: dir, fsync: false })
    const now = Date.now()
    await seed.insertWorkspace({
      id: WS as Workspace['id'],
      name: '探针工作区',
      executeTemplate: '',
      reviewTemplate: '',
      chatTemplate: '',
      defaultAgentId: null,
      locale: 'zh',
      createdAt: now,
      updatedAt: now,
    })
    const weird = mkAgent('reviewer', '奇怪的内置', '它是谁？', true)
    await seed.insertAgent(weird)
    await seed.close()

    await withDaemon(dir, async (url) => {
      const res = await fetch(`${url}/api/agents/${weird.id}/restore-default`, { method: 'POST' })
      const text = await res.text()
      assert.equal(res.status, 400, text)
      const body = JSON.parse(text) as { code?: string; error: string }
      assert.equal(body.code, 'builtin_role_unknown')
      assert.match(body.error, /reviewer/, '文案要把它实际的角色说出来，否则使用者不知道去改哪条')
      // 一条字都不许写进去（猜错的后果比"没恢复"严重得多）
      const after = (await agentsOf(url)).find((a) => a.id === weird.id)!
      assert.equal(after.instructions, '它是谁？')
      assert.equal(after.name, '奇怪的内置')
    })
  })
})
