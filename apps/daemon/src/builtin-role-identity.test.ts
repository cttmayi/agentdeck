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
  AGENT_MAKER_INSTRUCTIONS_BODY,
  AGENT_MAKER_NAME,
  builtinDefaultsOf,
  builtinKindOf,
  DRAFTER_INSTRUCTIONS_BODY,
  DRAFTER_NAME,
  ensureBuiltinAgentMaker,
  ensureBuiltinAgents,
  ensureBuiltinDrafter,
} from './builtin-drafter.ts'

/**
 * ★ 分批第 137 批（§12.42 第 ③ 步）：内置审核者随沉淀线的评审一起**下线**。
 *
 * 老工作区里那条 `role: 'skill-reviewer'` 的智能体仍是使用者的数据（平台不悄悄删），
 * 所以这一组用例仍然要覆盖"它还在盘上时会发生什么"——只是现在用本地常量造出它的旧形状，
 * 不再从 `builtin-drafter.ts` 导出一份已经删掉的默认身份。
 */
const LEGACY_REVIEWER_NAME = 'Skill 审核者（内置）'
const LEGACY_REVIEWER_INSTRUCTIONS = '你是平台内置的审核者：只指出哪里不合格，不要重写产出。'
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
  test('★ 起草者/审核者/生成者各认各的；普通 agent 与"标记+怪角色"都返回 null（不猜）', () => {
    assert.equal(builtinKindOf({ builtin: true, role: 'drafter' }), 'drafter')
    assert.equal(builtinKindOf({ builtin: true, role: 'skill-reviewer' }), 'skill-reviewer')
    // ★ 2026-11：智能体生成者（生成智能体那条链的执行者）
    assert.equal(builtinKindOf({ builtin: true, role: 'agent-maker' }), 'agent-maker')
    // 普通执行者：不是内置
    assert.equal(builtinKindOf({ builtin: false, role: 'executor' }), null)
    assert.equal(builtinKindOf({ role: 'executor' }), null)
    // 挂着内置标记但角色是业务角色（老记录/被手改过）：**不替它猜一套默认值**
    // ——猜错就是把起草者指令写进审核者（见下面 ② 那条）
    assert.equal(builtinKindOf({ builtin: true, role: 'reviewer' }), null)
    assert.equal(builtinKindOf({ builtin: true, role: 'executor' }), null)
  })

  test('★ 审核者已下线 ⇒ **没有默认值可恢复**（指令是空串，界面/路由据此拒绝）', () => {
    const drafter = builtinDefaultsOf('drafter')
    assert.equal(drafter.name, DRAFTER_NAME)
    assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS_BODY)
    // ★ 2026-11：智能体生成者有默认身份（与起草者同一套，可查看/编辑/恢复默认）
    const maker = builtinDefaultsOf('agent-maker')
    assert.equal(maker.name, AGENT_MAKER_NAME)
    assert.ok(maker.instructions.length > 0, '生成者的默认指令不能是空的')
    assert.match(maker.label, /智能体生成者/)
    const retired = builtinDefaultsOf('skill-reviewer')
    // ★ 分批第 137 批：它的默认身份已随评审删除。"恢复成默认值"若拿空串写库，
    //   那条智能体会被清空——比不恢复更坏，所以路由层（下一组用例）直接拒绝。
    assert.equal(retired.instructions, '', '已下线的内置不该有可写的默认指令')
    assert.match(retired.label, /已下线/, '说给人听的叫法要如实说我下线了')
    assert.match(retired.label, /不再评审/)
  })
})

describe('智能体生成者（agent-maker）的对账（2026-11 设计定稿 §3.1）', () => {
  test('★ 没有 ⇒ 建出来；再跑一遍 ⇒ 一字不动（幂等）；角色撞上就补标记（自愈）', async () => {
    await withStore(async (store) => {
      const first = await ensureBuiltinAgentMaker(store, WS)
      assert.equal(first.action, 'created')
      const after = await store.listAgents(WS)
      const maker = after.find((a) => a.role === 'agent-maker')!
      assert.equal(maker.name, AGENT_MAKER_NAME)
      assert.equal(maker.instructions, AGENT_MAKER_INSTRUCTIONS_BODY)
      assert.equal(maker.builtin, true)
      assert.deepEqual(maker.skillIds, [], '挂载由 syncAgentMakerSkillMount 管，对账不挂')

      // 幂等：再跑一遍不动任何东西
      const again = await ensureBuiltinAgentMaker(store, WS)
      assert.equal(again.action, 'left-alone')

      // 自愈：标记丢了但角色还在 ⇒ 补标记，不另建一条
      const damaged = await store.listAgents(WS)
      await store.insertAgent({ ...damaged.find((a) => a.role === 'agent-maker')!, builtin: false })
      const healed = await ensureBuiltinAgentMaker(store, WS)
      assert.equal(healed.action, 'healed')
      const final = await store.listAgents(WS)
      assert.equal(final.filter((a) => a.role === 'agent-maker').length, 1, '不许造第二条')
      assert.equal(final.find((a) => a.role === 'agent-maker')!.builtin, true)
    })
  })

  test('★ 指令被清空 ⇒ 补回默认（空指令的"问岗位"没有任何规矩）', async () => {
    await withStore(async (store) => {
      await ensureBuiltinAgentMaker(store, WS)
      const all = await store.listAgents(WS)
      await store.insertAgent({ ...all.find((a) => a.role === 'agent-maker')!, instructions: '   ' })
      const result = await ensureBuiltinAgentMaker(store, WS)
      assert.equal(result.action, 'healed')
      const after = await store.listAgents(WS)
      assert.equal(after.find((a) => a.role === 'agent-maker')!.instructions, AGENT_MAKER_INSTRUCTIONS_BODY)
    })
  })

  test('★ 使用者改过的指令是资产：一字不动（判据是"损坏"不是"与默认不同"）', async () => {
    await withStore(async (store) => {
      await ensureBuiltinAgentMaker(store, WS)
      const all = await store.listAgents(WS)
      const edited = '你是我的私人生成者。'
      await store.insertAgent({ ...all.find((a) => a.role === 'agent-maker')!, instructions: edited })
      const result = await ensureBuiltinAgentMaker(store, WS)
      assert.equal(result.action, 'left-alone')
      const after = await store.listAgents(WS)
      assert.equal(after.find((a) => a.role === 'agent-maker')!.instructions, edited)
    })
  })

  test('★ 全量对账三件套都建出来（ensureBuiltinAgents 的返回形状）', async () => {
    await withStore(async (store) => {
      const result = await ensureBuiltinAgents(store, WS)
      assert.equal(result.drafter.action, 'created')
      assert.equal(result.memoryTidy.action, 'created')
      assert.equal(result.agentMaker.action, 'created')
      const all = await store.listAgents(WS)
      assert.ok(all.some((a) => a.role === 'agent-maker'), '智能体生成者要在')
      assert.ok(all.some((a) => a.role === 'memory-tidy'), '记忆整理者要在')
      assert.ok(all.some((a) => a.role === 'drafter'), '起草者要在')
    })
  })
})

describe('起草者的自愈：撞上审核者时必须**认角色**，不能按标记一把抓', () => {  test('★★★ 起草者的 `builtin` 标记丢了、而审核者排在前面 ⇒ 补的是**起草者**的标记', async () => {
    await withStore(async (store) => {
      // 顺序就是这条用例的全部意义：审核者先入库 ⇒ 从前 `find(builtin)` 直接撞上它
      const reviewer = mkAgent('skill-reviewer', LEGACY_REVIEWER_NAME, LEGACY_REVIEWER_INSTRUCTIONS, true)
      const drafter = mkAgent('drafter', DRAFTER_NAME, DRAFTER_INSTRUCTIONS_BODY, false)
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
        LEGACY_REVIEWER_INSTRUCTIONS,
        '审核者的指令一个字都不许动',
      )
      assert.equal(after.length, 2, '不许"补不出来就再建一条"（那样每次启动多一条）')
    })
  })

  test('★★★ 审核者指令被清空 ⇒ 起草者的自愈**不许**把起草者指令写进审核者', async () => {
    await withStore(async (store) => {
      const reviewer = mkAgent('skill-reviewer', LEGACY_REVIEWER_NAME, '   ', true)
      await store.insertAgent(reviewer)

      const result = await ensureBuiltinDrafter(store, WS)
      // 审核者坏了是**审核者那条对账**的事；起草者这条只该管好自己。
      assert.equal(result.action, 'created')
      const afterCreate = await store.listAgents(WS)
      const reviewerAfter = afterCreate.find((a) => a.id === reviewer.id)!
      assert.notEqual(
        reviewerAfter.instructions,
        DRAFTER_INSTRUCTIONS_BODY,
        '审核者拿到起草者指令 = 它以后按"你是 skill 作者"去审，而看起来一切正常',
      )
      const drafter = afterCreate.find((a) => a.role === 'drafter')
      assert.ok(drafter, '起草者必须被建出来')
      assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS_BODY)

      // 然后内置对账再跑一遍：★ 分批第 137 批之后**只剩起草者**那条——
      //   已下线的审核者**不会**再被"修"（它的默认身份已删；平台也不悄悄删/改使用者数据）。
      await ensureBuiltinAgents(store, WS)
      const final = await store.listAgents(WS)
      assert.equal(
        final.find((a) => a.role === 'skill-reviewer')!.instructions,
        '   ',
        '已下线的审核者不该被内置对账重新填指令（它没有默认指令了）',
      )
      assert.equal(final.find((a) => a.role === 'drafter')!.instructions, DRAFTER_INSTRUCTIONS_BODY)
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

describe('接口层：内置条目各按各的角色回答（审核者已下线）', () => {
  /** 造一个带"老审核者"的工作区目录（模拟从旧版本升上来的使用者）。 */
  async function seedLegacyReviewer(): Promise<{ dir: string; id: string }> {
    const dir = await makeTempDir('builtin-role-retired')
    const seed = await FileStore.open({ dataDir: dir, fsync: false })
    const now = Date.now()
    await seed.insertWorkspace({
      id: WS as Workspace['id'],
      name: '老工作区',
      executeTemplate: '',
      reviewTemplate: '',
      chatTemplate: '',
      defaultAgentId: null,
      locale: 'zh',
      createdAt: now,
      updatedAt: now,
    })
    const reviewer = mkAgent('skill-reviewer', LEGACY_REVIEWER_NAME, LEGACY_REVIEWER_INSTRUCTIONS, true)
    await seed.insertAgent(reviewer)
    await seed.close()
    return { dir, id: reviewer.id }
  }

  test('★★★ 「恢复成默认值」按在**已下线的审核者**上 ⇒ 409 说清它下线了，一个字节都不写', async () => {
    const seeded = await seedLegacyReviewer()
    await withDaemon(seeded.dir, async (url) => {
      const res = await fetch(`${url}/api/agents/${seeded.id}/restore-default`, { method: 'POST' })
      const text = await res.text()
      // ★ 分批第 137 批：它的默认身份已随评审删除。"恢复成默认值"若写空串就是清空它——
      //   那比不恢复更坏，所以如实拒绝并给出去处（可在智能体页删掉）。
      assert.equal(res.status, 409, text)
      const body = JSON.parse(text) as { code?: string; error: string }
      assert.equal(body.code, 'builtin_retired')
      assert.match(body.error, /已下线/)
      assert.match(body.error, /不再评审/)
      // 指令与名字一个字都没动。
      // ★ 2026-11（D111）：列表接口返回的是**组装后**指令（内置会附上运行时守则），
      //   所以这里断言的是**正文原样**（`startsWith`）——追加的守则是平台运行时拼的，
      //   不是一次写入；若正文被覆盖过，开头对不上。
      const after = (await agentsOf(url)).find((a) => a.id === seeded.id)!
      assert.ok(
        after.instructions.startsWith(LEGACY_REVIEWER_INSTRUCTIONS),
        `正文必须原样保留（拿到的组装后指令：${after.instructions.slice(0, 60)}…）`,
      )
      assert.equal(after.name, LEGACY_REVIEWER_NAME)
    })
  })

  test('★★★ 已下线的内置审核者**可以删**；起草者仍然铁律不可删', async () => {
    // ★ 分批第 192 批（使用者：「审核者（内置）是否已经没有用了」）。
    //   实测它当时是**走不掉的一行**：内置 ⇒ 只读（改不了）、`skill-reviewer` ⇒ 没有默认值
    //   （恢复 409）、内置 ⇒ 删不了（400），而 409 那句文案还写着"可以在智能体页删掉"。
    //   这一条钉住新的口径：按 `builtinKindOf` 分开——retired 放行，起草者照旧。
    const seeded = await seedLegacyReviewer()
    await withDaemon(seeded.dir, async (url) => {
      const drafter = (await agentsOf(url)).find((a) => a.role === 'drafter')!
      const refused = await fetch(`${url}/api/agents/${drafter.id}`, { method: 'DELETE' })
      const refusedText = await refused.text()
      assert.equal(refused.status, 400, refusedText)
      assert.equal(
        (JSON.parse(refusedText) as { code?: string }).code,
        'builtin_agent_not_deletable',
        '起草者必须仍然不可删（沉淀这条路永远要有它）',
      )

      const ok = await fetch(`${url}/api/agents/${seeded.id}`, { method: 'DELETE' })
      const okText = await ok.text()
      assert.equal(ok.status, 200, okText)
      assert.ok(
        !(await agentsOf(url)).some((a) => a.id === seeded.id),
        '删掉之后列表里不该再有它',
      )
      // 起草者还在（删一条不能顺手影响另一条内置）
      assert.ok((await agentsOf(url)).some((a) => a.role === 'drafter'))
    })
  })

  test('★★ 拒绝文案按**这条自己**的角色说（起草者 / 已下线的审核者各说各的）', async () => {
    const seeded = await seedLegacyReviewer()
    await withDaemon(seeded.dir, async (url) => {
      const agents = await agentsOf(url)
      const reviewer = agents.find((a) => a.id === seeded.id)!
      const drafter = agents.find((a) => a.role === 'drafter')!
      assert.ok(drafter, '启动时内置起草者要被建出来')

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
      // 一条字都不许写进去（猜错的后果比"没恢复"严重得多）。
      // ★ 2026-11（D111）：列表返回组装后指令 ⇒ 断言正文原样（startsWith），
      //   追加的守则是运行时拼的，不是写入。
      const after = (await agentsOf(url)).find((a) => a.id === weird.id)!
      assert.ok(after.instructions.startsWith('它是谁？'), `正文必须原样：${after.instructions.slice(0, 60)}…`)
      assert.equal(after.name, '奇怪的内置')
    })
  })
})
