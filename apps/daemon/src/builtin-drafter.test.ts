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
  // ⚠️ 这里用 `builtinKindOf`（`builtin` + 角色）而不是 `builtin === true`：
  //    第 70 批量出来"按标记一把抓"会抓到**先出现的那条内置**（起草者/审核者都有标记），
  //    于是用例在"审核者排在前面"时测的根本不是起草者——而它照样是绿的。
  builtinKindOf,
  DRAFTER_INSTRUCTIONS,
  DRAFTER_INSTRUCTIONS_V1,
  DRAFTER_NAME,
  ensureBuiltinAgents,
  ensureBuiltinDrafter,
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
    const drafter = agents.find((a) => builtinKindOf(a) === 'drafter')
    assert.ok(drafter, '建完必须能在列表里按内置标记找到它')
    assert.equal(drafter.role, 'drafter')
    assert.equal(drafter.name, DRAFTER_NAME)
    assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS)
    // 第 ③ 条：它不挂技能——挂了会让人以为那些技能影响起草（它们不影响，
    // 起草 run 的技能集合是写死的）
    assert.deepEqual(drafter.skillIds, [])
  })

  test('★ 再跑一次 ⇒ 一字不动（幂等；否则每次启动都是"新建一条"）', async () => {
    const before = (await store.listAgents(WS)).filter((a) => builtinKindOf(a) === 'drafter')
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'left-alone')
    const after = (await store.listAgents(WS)).filter((a) => builtinKindOf(a) === 'drafter')
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
    const mine = (await store.listAgents(WS)).find((a) => builtinKindOf(a) === 'drafter')!
    await store.insertAgent({ ...mine, instructions: DRAFTER_INSTRUCTIONS_V1 })

    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed', '旧默认必须被认出来并升级')
    const after = (await store.listAgents(WS)).filter((a) => builtinKindOf(a) === 'drafter')[0]!
    assert.equal(after.instructions, DRAFTER_INSTRUCTIONS, '升级后必须等于当前默认')
    assert.ok(
      after.instructions.includes('默认约定'),
      '当前默认里那条「使用者的要求是默认约定」必须真的在里面（它就是这次升级的目的）',
    )
  })

  test('★★★ 使用者改过的指令**必须活过**下一次对账（第 ⑥ 条：升级不许覆盖他的改动）', async () => {
    const mine = (await store.listAgents(WS)).find((a) => builtinKindOf(a) === 'drafter')!
    const edited: Agent = { ...mine, instructions: '我们团队的规范：每条 skill 都要带一个检查清单。' }
    await store.insertAgent(edited)

    const result = await ensureBuiltinDrafter(store, WS)
    // ⚠️ 这一条就是这个设计的核心：判据是**损坏**，不是"与默认不同"。
    //    写成"与默认不同 ⇒ 恢复默认"的话，这里会量到 healed，而使用者看到的是
    //    "我改的指令过一会儿自己变回去了"（像界面没保存）。
    assert.equal(result.action, 'left-alone')
    const after = (await store.listAgents(WS)).find((a) => builtinKindOf(a) === 'drafter')!
    assert.equal(after.instructions, '我们团队的规范：每条 skill 都要带一个检查清单。')
  })

  test('指令被清空 ⇒ 自愈回默认（那是"损坏"，起草 run 否则会拿到空身份）', async () => {
    const mine = (await store.listAgents(WS)).find((a) => builtinKindOf(a) === 'drafter')!
    await store.insertAgent({ ...mine, instructions: '   ' })
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed')
    const after = (await store.listAgents(WS)).find((a) => builtinKindOf(a) === 'drafter')!
    assert.equal(after.instructions, DRAFTER_INSTRUCTIONS)
  })

  test('内置标记丢了但角色还在 ⇒ 补标记，**不是**再造一条（否则每次启动多一条）', async () => {
    const mine = (await store.listAgents(WS)).find((a) => builtinKindOf(a) === 'drafter')!
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

  test('★★ `ensureBuiltinAgents` 建起草者（分批第 137 批起只剩这一条内置）', async () => {
    const out = await ensureBuiltinAgents(store, WS)
    assert.equal(out.drafter.action, 'left-alone')
    // ★ 分批第 137 批：内置审核者随沉淀线的评审一起删除 ⇒ 这里不再断言它被建出来。
    const builtins = (await store.listAgents(WS)).filter((a) => a.builtin === true)
    assert.equal(builtins.filter((a) => a.role === 'drafter').length, 1)
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

// ★ 分批第 137 批（§12.42 第 ③ 步）：`ensureBuiltinReviewer` 与审核者的默认指令一起删除
//   （沉淀线不再评审）。这一整组"审核者自愈 / 历史默认升级"用例随之删掉——被删的代码路径
//   留着测试只会变成"测一个不会发生的函数"。
