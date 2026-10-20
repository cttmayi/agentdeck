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
  DRAFTER_NAME,
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
