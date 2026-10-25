/**
 * 内置起草者（§9）的对账纪律：**幂等 / 自愈 / 不覆盖使用者改动**。
 *
 * 为什么这三条要一起测：它们互相拉扯——"每次启动都跑"（不许删 + 自愈的前提）
 * 与"使用者改过的不许动"（第 ⑥ 条）之间只差一个判据：**是"损坏"还是"与默认不同"**。
 * 第一版最容易写成后者（"与默认不同就恢复默认"），那样每次启动都会把使用者的
 * 改动抹掉一次，而表现是"我改的指令过一会儿就变回去了"——很像是界面没保存。
 *
 * ⚠️ 用真 FileStore + 临时目录（仓库内 `.cache/test-tmp`），不碰任何 CLI（NFR-T-01）。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FileStore } from '@agentdeck/store-file'
import { wsId } from '@agentdeck/domain/testing'
import { ulid } from '@agentdeck/protocol'
import type { Agent } from '@agentdeck/protocol'
import {
  DRAFTER_INSTRUCTIONS,
  DRAFTER_INSTRUCTIONS_V1,
  DRAFTER_NAME,
  SKILL_REVIEWER_INSTRUCTIONS,
  SKILL_REVIEWER_INSTRUCTIONS_V1,
  SKILL_REVIEWER_INSTRUCTIONS_V2,
  SKILL_REVIEWER_INSTRUCTIONS_V3,
  SKILL_REVIEWER_NAME,
  ensureBuiltinAgents,
  ensureBuiltinDrafter,
  ensureBuiltinReviewer,
} from './builtin-drafter.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string
let store: FileStore
const WS = wsId('ws-drafter')

before(async () => {
  dir = await makeTempDir('builtin-drafter')
  store = await FileStore.open({ dataDir: dir, fsync: false })
})

after(async () => {
  await cleanup(dir)
})

describe('ensureBuiltinDrafter：建 / 幂等 / 自愈', () => {
  test('没有 ⇒ 建一条：角色是起草者、带内置标记、名字与指令是默认值、**不挂技能**', async () => {
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'created')
    const agents = await store.listAgents(WS)
    const drafter = agents.find((a) => a.builtin === true)
    assert.ok(drafter, '建完必须能在列表里按内置标记找到它')
    assert.equal(drafter.role, 'drafter')
    assert.equal(drafter.name, DRAFTER_NAME)
    assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS)
    // 第 ③ 条：它不挂技能——挂了会让人以为那些技能影响起草（它们不影响，
    // 起草 run 的技能集合是写死的）
    assert.deepEqual(drafter.skillIds, [])
  })

  test('★ 再跑一次 ⇒ 一字不动（幂等；否则每次启动都是"新建一条"）', async () => {
    const before = (await store.listAgents(WS)).filter((a) => a.builtin === true)
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'left-alone')
    const after = (await store.listAgents(WS)).filter((a) => a.builtin === true)
    assert.equal(after.length, before.length, '不许越跑越多')
  })

  /**
   * ★★★ 分批第 31 批：使用者问「当前是不是没有使用 智能体『起草者（内置）』」。
   *
   * 量下来不是"没用它"，是**它带的规则还停在旧版**：代码默认 462 字、盘上 288 字，
   * 逐字等于"当前默认去掉 3b 那条"——第 26 批加的「使用者的要求是默认约定」从没进过
   * 起草者的身份块。而起草者的升级只处理"指令被清空"，没有"还停在旧默认"这一支，
   * 所以它看起来一切正常（没坏、不报错、连自愈都不触发）。
   *
   * 审核者那一侧早在第 21 批就有这套（`REVIEWER_INSTRUCTIONS_HISTORY`），起草者漏了。
   */
  test('★★★ 盘上还是**旧默认**指令 ⇒ 升级成当前默认（否则新规则永远进不了起草者）', async () => {
    const mine = (await store.listAgents(WS)).find((a) => a.builtin === true)!
    await store.insertAgent({ ...mine, instructions: DRAFTER_INSTRUCTIONS_V1 })

    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed', '旧默认必须被认出来并升级')
    const after = (await store.listAgents(WS)).filter((a) => a.builtin === true)[0]!
    assert.equal(after.instructions, DRAFTER_INSTRUCTIONS, '升级后必须等于当前默认')
    assert.ok(
      after.instructions.includes('默认约定'),
      '当前默认里那条「使用者的要求是默认约定」必须真的在里面（它就是这次升级的目的）',
    )
  })

  test('★★★ 使用者改过的指令**必须活过**下一次对账（第 ⑥ 条：升级不许覆盖他的改动）', async () => {
    const mine = (await store.listAgents(WS)).find((a) => a.builtin === true)!
    const edited: Agent = { ...mine, instructions: '我们团队的规范：每条 skill 都要带一个检查清单。' }
    await store.insertAgent(edited)

    const result = await ensureBuiltinDrafter(store, WS)
    // ⚠️ 这一条就是这个设计的核心：判据是**损坏**，不是"与默认不同"。
    //    写成"与默认不同 ⇒ 恢复默认"的话，这里会量到 healed，而使用者看到的是
    //    "我改的指令过一会儿自己变回去了"（像界面没保存）。
    assert.equal(result.action, 'left-alone')
    const after = (await store.listAgents(WS)).find((a) => a.builtin === true)!
    assert.equal(after.instructions, '我们团队的规范：每条 skill 都要带一个检查清单。')
  })

  test('指令被清空 ⇒ 自愈回默认（那是"损坏"，起草 run 否则会拿到空身份）', async () => {
    const mine = (await store.listAgents(WS)).find((a) => a.builtin === true)!
    await store.insertAgent({ ...mine, instructions: '   ' })
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed')
    const after = (await store.listAgents(WS)).find((a) => a.builtin === true)!
    assert.equal(after.instructions, DRAFTER_INSTRUCTIONS)
  })

  test('内置标记丢了但角色还在 ⇒ 补标记，**不是**再造一条（否则每次启动多一条）', async () => {
    const mine = (await store.listAgents(WS)).find((a) => a.builtin === true)!
    const { builtin: _dropped, ...withoutFlag } = mine
    await store.insertAgent(withoutFlag as Agent)

    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed')
    if (result.action !== 'healed') return
    assert.match(result.why, /标记/)
    const drafters = (await store.listAgents(WS)).filter((a) => a.role === 'drafter')
    assert.equal(drafters.length, 1, '起草者只该有一条')
    assert.equal(drafters[0]!.builtin, true)
  })

  test('★★ 内置的 skill 审核者：角色是 `skill-reviewer`（**不是** `reviewer`）', async () => {
    const result = await ensureBuiltinReviewer(store, WS)
    assert.equal(result.action, 'created')
    const reviewer = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')
    assert.ok(reviewer)
    assert.equal(reviewer.builtin, true)
    assert.equal(reviewer.name, SKILL_REVIEWER_NAME)
    assert.equal(reviewer.instructions, SKILL_REVIEWER_INSTRUCTIONS)
    assert.equal(reviewer.runtimeKey, 'default')
    assert.deepEqual(reviewer.skillIds, [])
    // ★ 这一条是**为什么不能用 'reviewer'** 的判据：业务报告的路由按
    //   `role === 'reviewer'`（`packages/domain/src/routing/kind.ts`）挑人 ——
    //   给它 `'reviewer'` 它就会去审业务报告（进了闭环），而它的指令是"审 skill"。
    assert.notEqual(reviewer.role, 'reviewer')
  })

  test('★ 审核者同样：使用者改过的指令活过下一次对账、指令空 ⇒ 自愈', async () => {
    const mine = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!
    await store.insertAgent({ ...mine, instructions: '我们团队审 skill 的额外要求。' })
    assert.equal((await ensureBuiltinReviewer(store, WS)).action, 'left-alone')
    assert.equal(
      (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!.instructions,
      '我们团队审 skill 的额外要求。',
    )

    const emptied = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!
    await store.insertAgent({ ...emptied, instructions: '  ' })
    assert.equal((await ensureBuiltinReviewer(store, WS)).action, 'healed')
    assert.equal(
      (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!.instructions,
      SKILL_REVIEWER_INSTRUCTIONS,
  SKILL_REVIEWER_INSTRUCTIONS_V1,
    )
  })

  test('★★ 平台换了审核方向：**老默认**逐字在 ⇒ 升级；使用者自己写的 ⇒ 一个字都不动', async () => {
    // 为什么这两条必须成对测：升级与"不覆盖使用者改动"只差一个判据——"是不是**平台自己的**
    // 老文本"。写成"与当前默认不同就升级"，每次启动都会把使用者写的判据换成平台的
    // （表现："我改的指令过一会儿就变回去了"，很像界面没保存）；写成"只比对新旧常量"，
    // 老工作区又永远升不上来（表现："判据明明改了，审起来还是老样子"，而日志一个字都不提）。
    const mine = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!

    // ① 老默认 ⇒ 升级，且说清为什么
    await store.insertAgent({ ...mine, instructions: SKILL_REVIEWER_INSTRUCTIONS_V1 })
    const upgraded = await ensureBuiltinReviewer(store, WS)
    assert.equal(upgraded.action, 'healed')
    if (upgraded.action === 'healed') assert.match(upgraded.why, /旧版/)
    assert.equal(
      (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!.instructions,
      SKILL_REVIEWER_INSTRUCTIONS,
  SKILL_REVIEWER_INSTRUCTIONS_V1,
    )

    // ② 使用者在老默认上改过一个地方 ⇒ 从此不再动它（连升级也不许）
    const edited = SKILL_REVIEWER_INSTRUCTIONS_V1.replace('你只指出哪里不合格', '你还要给出改法')
    assert.notEqual(edited, SKILL_REVIEWER_INSTRUCTIONS_V1, '这个用例依赖"真的改了一个地方"')
    await store.insertAgent({ ...mine, instructions: edited })
    assert.equal((await ensureBuiltinReviewer(store, WS)).action, 'left-alone')
    assert.equal(
      (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!.instructions,
      edited,
    )
  })

  test('★★ `ensureBuiltinAgents` 两个都建，且**各一条**（不会按 `builtin` 一把抓）', async () => {
    const out = await ensureBuiltinAgents(store, WS)
    assert.equal(out.drafter.action, 'left-alone')
    assert.equal(out.reviewer.action, 'left-alone')
    const builtins = (await store.listAgents(WS)).filter((a) => a.builtin === true)
    assert.equal(builtins.filter((a) => a.role === 'drafter').length, 1)
    assert.equal(builtins.filter((a) => a.role === 'skill-reviewer').length, 1)
  })

  test('别的 agent（普通执行者/审核者）不受影响，也不会被当成起草者', async () => {
    // 普通执行者：以起草者为底、**摘掉内置标记**（`exactOptionalPropertyTypes`
    // ⇒ 不能写 `builtin: undefined`，字段在不在本身就是判据）。
    const mine = (await store.listAgents(WS)).find((a) => a.role === 'drafter')!
    const { builtin: _none, ...rest } = mine
    const plain: Agent = {
      ...(rest as Agent),
      id: ulid() as Agent['id'],
      name: '普通执行者',
      role: 'executor',
      reviewStandard: null,
    }
    await store.insertAgent(plain)
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'left-alone')
    const after = (await store.listAgents(WS)).find((a) => a.id === plain.id)!
    assert.equal(after.builtin, undefined, '普通 agent 不该被塞内置标记')
  })
})

describe('ensureBuiltinReviewer：同一套纪律 + 历史默认升级', () => {
  /**
   * ★★★ 分批第 31 批：审核者同一类陈旧（真机 838 字 = 第 20 批默认，不是使用者改的）。
   *
   * 这条用例钉的是"历史表要把**每一个**旧默认都记着"：只记 V1 的话，
   * 第 20 批之后的默认就成了"谁也认不出来的孤儿"，第 26 批加的第五件事永远到不了审核者。
   */
  /**
   * ★★ 分批第 35 批：历史表的第三个版本（1048 字，第 26 批之后那版）。
   *
   * 这条钉的是"每改一次默认指令都要把旧的那份记下来"这个纪律本身——第 31 批漏了 V2，
   * 结果真机上那 838 字的审核者永远升不上来。V3 是第 35 批改身份首句时冻进来的。
   */
  test('★★ 审核者停在**第 26 批默认**（1048 字）⇒ 也要升级（历史表要一路记着）', async () => {
    const all = await store.listAgents(WS)
    if (!all.some((a) => a.role === 'skill-reviewer')) {
      await ensureBuiltinReviewer(store, WS)
    }
    const mine = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!
    await store.insertAgent({ ...mine, instructions: SKILL_REVIEWER_INSTRUCTIONS_V3 })

    const result = await ensureBuiltinReviewer(store, WS)
    assert.equal(result.action, 'healed', '1048 字那版必须是已知历史版本')
    const after = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!
    assert.equal(after.instructions, SKILL_REVIEWER_INSTRUCTIONS)
  })

  test('★★★ 审核者停在**第 20 批默认** ⇒ 也要升级（历史表缺一个旧默认就等于永远不升级）', async () => {
    const all = await store.listAgents(WS)
    const reviewer = all.find((a) => a.role === 'skill-reviewer')
    if (!reviewer) {
      await ensureBuiltinReviewer(store, WS)
    }
    const mine = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!
    await store.insertAgent({ ...mine, instructions: SKILL_REVIEWER_INSTRUCTIONS_V2 })

    const result = await ensureBuiltinReviewer(store, WS)
    assert.equal(result.action, 'healed', '第 20 批默认必须是已知历史版本')
    const after = (await store.listAgents(WS)).find((a) => a.role === 'skill-reviewer')!
    assert.equal(after.instructions, SKILL_REVIEWER_INSTRUCTIONS)
  })
})
