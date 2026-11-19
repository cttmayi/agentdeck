/**
 * 内置起草者（§9）的对账纪律：**幂等 / 自愈 / 不覆盖使用者改动**。
 *
 * 为什么这三条要一起测：它们互相拉扯——"每次启动都跑"（不许删 + 自愈的前提）
 * 与"使用者改过的不许动"（第 ⑥ 条）之间只差一个判据：**是"损坏"还是"与默认不同"**。
 * 第一版最容易写成后者（"与默认不同就恢复默认"），那样每次启动都会把使用者的
 * 改动抹掉一次，而表现是"我改的指令过一会儿就变回去了"——很像是界面没保存。
 *
 * ⚠️ 用真 FileStore + 临时目录（仓库内 `.cache/test-tmp`），不碰任何 CLI（NFR-T-01）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 2026-11（D154）：认人**只走槽位表**
 * ══════════════════════════════════════════════════════════════════
 *
 * 这些用例原来靠记录上的 `builtin` / `builtinKind` 找"我那条起草者"。现在那两件事
 * 分开了："是不是平台的"= `owner`，"是哪一条"= 工作区的槽位表（`platformSlots`）。
 * 所以找人都改成 `platformMemberOf(store, WS, 'drafter')`——判据的**意图没变**
 * （"找到的是那一条起草者"），变的只是"到哪里找"。
 *
 * ⚠️ 槽位表挂在工作区上 ⇒ 每个用到的 WS 都得先存在（`ensureTestWorkspace`）；
 *    否则 `saveSlotTable` 会抛（那是刻意的：静默丢掉槽位 = 下次启动多建一条）。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FileStore } from '@agentdeck/store-file'
import { wsId } from '@agentdeck/domain/testing'
import { ulid } from '@agentdeck/protocol'
import type { Agent, WorkspaceId } from '@agentdeck/protocol'
import {
  DRAFTER_INSTRUCTIONS_BODY,
  DRAFTER_INSTRUCTIONS_V1,
  DRAFTER_NAME,
  DRAFTER_NAME_LEGACY,
  ensureBuiltinAgents,
  ensureBuiltinDrafter,
  ensureBuiltinMemoryTidy,
  syncDrafterSkillMount,
  MEMORY_TIDY_INSTRUCTIONS_BODY,
  MEMORY_TIDY_INSTRUCTIONS_V1,
  MEMORY_TIDY_NAME,
} from './builtin-drafter.ts'
import { loadSlotTable, platformMemberOf, saveSlotTable } from './platform-slots.ts'
import { ensureTestWorkspace } from './testing/test-workspace.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let dir: string
let store: FileStore
const WS = wsId('ws-drafter')

before(async () => {
  dir = await makeTempDir('builtin-drafter')
  store = await FileStore.open({ dataDir: dir, fsync: false })
  await ensureTestWorkspace(store, WS)
})

after(async () => {
  await cleanup(dir)
})

/** 这个工作区里"我那条起草者"（找不到就是 null）。 */
async function drafterOf(workspaceId: WorkspaceId = WS): Promise<Agent | null> {
  return await platformMemberOf(store, workspaceId, 'drafter')
}

describe('ensureBuiltinDrafter：建 / 幂等 / 自愈', () => {
  test('没有 ⇒ 建一条：平台成员、名字与指令是默认值、**不挂技能**', async () => {
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'created')
    const drafter = await drafterOf()
    assert.ok(drafter, '建完必须能在槽位表里认回去')
    assert.equal(drafter.owner, 'platform', '新记录只写 owner')
    assert.equal(
      (drafter as { builtin?: boolean }).builtin,
      undefined,
      'D154：记录上不再有 builtin / builtinKind（那是"写坏一半"的来源）',
    )
    assert.deepEqual(drafter.entries, ['action:skill-draft'], '它的接入点是注册表派生的')
    assert.equal(drafter.name, DRAFTER_NAME)
    // ★ 2026-11（D111）：存储的是**组装前**正文（平台守则运行时拼）
    assert.equal(drafter.instructions, DRAFTER_INSTRUCTIONS_BODY)
    // 第 ③ 条：它不挂技能
    assert.deepEqual(drafter.skillIds, [])
  })

  test('★ 再跑一次 ⇒ 一字不动（幂等；否则每次启动都是"新建一条"）', async () => {
    const before = (await store.listAgents(WS)).length
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'left-alone')
    const after = (await store.listAgents(WS)).length
    assert.equal(after, before, '不许越跑越多')
  })

  /**
   * ★★★ 分批第 31 批：使用者问「当前是不是没有使用 智能体『起草者（内置）』」。
   *
   * 量下来不是"没用它"，是**它带的规则还停在旧版**。而升级只处理"指令被清空"，
   * 没有"还停在旧默认"这一支 ⇒ 它看起来一切正常（没坏、不报错、连自愈都不触发）。
   */
  test('★★★ 盘上还是**旧默认**指令 ⇒ 升级成当前默认（否则新规则永远进不了起草者）', async () => {
    const mine = (await drafterOf())!
    // 老工作区里存的是**组装后**全文（老记录/迁移）⇒ 带 `instructionsAssembled: true`
    await store.insertAgent({
      ...mine,
      instructions: DRAFTER_INSTRUCTIONS_V1,
      instructionsAssembled: true,
    })

    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed', '旧默认必须被认出来并升级')
    const after = (await drafterOf())!
    assert.equal(after.instructions, DRAFTER_INSTRUCTIONS_BODY, '升级后必须等于当前默认')
    assert.ok(
      after.instructions.includes('照着你被注入的那份技能'),
      '当前默认必须点出"按注入的技能干"（规则已经交给技能）',
    )
  })

  test('★★★ 使用者改过的指令**必须活过**下一次对账（第 ⑥ 条：升级不许覆盖他的改动）', async () => {
    const mine = (await drafterOf())!
    await store.insertAgent({
      ...mine,
      instructions: '我们团队的规范：每条 skill 都要带一个检查清单。',
    })

    const result = await ensureBuiltinDrafter(store, WS)
    // ⚠️ 这一条就是这个设计的核心：判据是**损坏**，不是"与默认不同"。
    assert.equal(result.action, 'left-alone')
    const after = (await drafterOf())!
    assert.equal(after.instructions, '我们团队的规范：每条 skill 都要带一个检查清单。')
  })

  test('★★★ 名字还是旧默认「起草者（内置）」⇒ 同步成「沉淀起草者（内置）」', async () => {
    const mine = (await drafterOf())!
    await store.insertAgent({ ...mine, name: DRAFTER_NAME_LEGACY })

    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed', '旧默认名字必须被认出来并同步')
    const after = (await drafterOf())!
    assert.equal(after.name, DRAFTER_NAME)
  })

  test('★★★ 使用者改过的名字必须活过对账（判据是"旧默认"，不是"与默认不同"）', async () => {
    const mine = (await drafterOf())!
    await store.insertAgent({ ...mine, name: '我改的起草者' })

    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'left-alone')
    const after = (await drafterOf())!
    assert.equal(after.name, '我改的起草者', '使用者改过的名字不许被覆盖')
  })

  test('指令被清空 ⇒ 自愈回默认（那是"损坏"，起草 run 否则会拿到空身份）', async () => {
    const mine = (await drafterOf())!
    await store.insertAgent({ ...mine, instructions: '   ' })
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'healed')
    const after = (await drafterOf())!
    assert.equal(after.instructions, DRAFTER_INSTRUCTIONS_BODY)
  })

  /**
   * ★ 2026-11（D154）改写：原来这条守的是"标记丢了但角色还在 ⇒ 补标记"。
   *
   * 现在"是哪一条"只在槽位表里说，所以等价的坏法是**表丢了那一行**（手改文件 /
   * 从备份恢复）。这时候平台认不出原来那条 ⇒ 建一条新的，**旧记录原样留着**
   * （那是使用者的数据，不悄悄删）。
   */
  test('★★ 槽位表丢了那一行 ⇒ 认不出 ⇒ 另建一条，旧记录原样留着', async () => {
    const old = (await drafterOf())!
    await saveSlotTable(store, WS, {})
    assert.equal(await drafterOf(), null, '表里没有了 ⇒ 认不出来')

    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'created', '认不出旧的那条 ⇒ 建一条新的')
    const fresh = (await drafterOf())!
    assert.notEqual(fresh.id, old.id)
    const stillThere = (await store.listAgents(WS)).find((a) => a.id === old.id)
    assert.ok(stillThere, '使用者的旧记录不许被平台悄悄删掉')
    assert.equal(stillThere.name, old.name)
  })

  test('别的 agent（普通执行者）不受影响，也不会被当成起草者', async () => {
    const mine = (await drafterOf())!
    const plain: Agent = {
      ...mine,
      id: ulid() as Agent['id'],
      name: '普通执行者',
      owner: 'user',
      entries: ['chat', 'task', 'workflow'],
      reviewStandard: null,
    }
    await store.insertAgent(plain)
    const result = await ensureBuiltinDrafter(store, WS)
    assert.equal(result.action, 'left-alone')
    const after = (await store.listAgents(WS)).find((a) => a.id === plain.id)!
    assert.equal(after.owner, 'user', '普通 agent 的归属不许被改')
    assert.equal((after as { builtin?: boolean }).builtin, undefined)
  })
})

/**
 * 内置「记忆整理者」（分批第 244 批）。
 *
 * 使用者原话：「要和沉淀技能一样，也有一个智能体显示在智能体页面列表中，方便我查看其 prompt」。
 * 于是它必须是**一条真的智能体**：能被列出来、它的指令里就是那套挑记忆的规矩（可看可改）、
 * 而且与起草者共用同一套对账纪律（幂等 / 自愈 / 不覆盖使用者的改动）。
 */
describe('ensureBuiltinMemoryTidy：建 / 幂等 / 自愈', () => {
  const WS2 = wsId('ws-memory-tidy')

  before(async () => {
    await ensureTestWorkspace(store, WS2)
  })

  async function tidyOf(workspaceId: WorkspaceId = WS2): Promise<Agent | null> {
    return await platformMemberOf(store, workspaceId, 'memory-tidy')
  }

  test('没有 ⇒ 建一条：平台成员、指令里就是那套挑记忆的规矩', async () => {
    const result = await ensureBuiltinMemoryTidy(store, WS2)
    assert.equal(result.action, 'created')
    const found = await tidyOf()
    assert.ok(found, '建完必须能在槽位表里认回去')
    assert.equal(found.owner, 'platform')
    assert.deepEqual(found.entries, ['action:memory-tidy'])
    assert.equal(found.name, MEMORY_TIDY_NAME)
    assert.equal(found.instructions, MEMORY_TIDY_INSTRUCTIONS_BODY)
    assert.deepEqual(found.skillIds, [], '它不挂技能（规矩在身份里）')
    // ★ 使用者要看的正是这段：规矩必须写在这条智能体的指令里，而不是藏在代码里
    assert.match(found.instructions, /只派活或提问时输出/)
    assert.match(found.instructions, /逐字/)
  })

  test('★ 再跑一次 ⇒ 一字不动（幂等）', async () => {
    const before = await tidyOf()
    const countBefore = (await store.listAgents(WS2)).length
    await ensureBuiltinMemoryTidy(store, WS2)
    const after = await tidyOf()
    assert.equal((await store.listAgents(WS2)).length, countBefore, '不许越跑越多')
    assert.equal(after?.id, before?.id, '认的还是那一条')
    assert.deepEqual(after?.instructions, before?.instructions)
  })

  test('★★ 使用者改过指令 ⇒ **不覆盖**（那是他的资产，要恢复靠那个按钮）', async () => {
    const found = (await tidyOf())!
    await store.insertAgent({ ...found, instructions: '我自己写的规矩', updatedAt: Date.now() })
    const result = await ensureBuiltinMemoryTidy(store, WS2)
    assert.equal(result.action, 'left-alone')
    const after = await tidyOf()
    assert.equal(after?.instructions, '我自己写的规矩')
  })

  test('★★ 指令被清空 ⇒ 补回默认（空指令会让它开始记"这次做了什么"）', async () => {
    const found = (await tidyOf())!
    await store.insertAgent({ ...found, instructions: '   ', updatedAt: Date.now() })
    const result = await ensureBuiltinMemoryTidy(store, WS2)
    assert.equal(result.action, 'healed')
    const after = await tidyOf()
    assert.equal(after?.instructions, MEMORY_TIDY_INSTRUCTIONS_BODY)
  })

  test('★ 槽位表丢了那一行 ⇒ 认不出 ⇒ 另建一条', async () => {
    const before = (await tidyOf())!
    await saveSlotTable(store, WS2, {})
    const result = await ensureBuiltinMemoryTidy(store, WS2)
    assert.equal(result.action, 'created')
    const after = (await tidyOf())!
    assert.notEqual(after.id, before.id)
  })

  test('★★★ 老工作区里是**旧版**默认指令 ⇒ 升级成当前默认（第 248 批补的自愈）', async () => {
    /**
     * 这条对应一次真实事故：第 248 批我改了规矩（"要泛化"），代码/测试/文档全改了，
     * 但使用者那边的整理结果**一点没变**——因为规矩是 agent 的身份、身份在 store 里，
     * 而自愈只处理"标记丢了"与"指令空了"。
     */
    const WS_OLD = wsId('ws-memory-tidy-old')
    await ensureTestWorkspace(store, WS_OLD)
    await ensureBuiltinMemoryTidy(store, WS_OLD)
    const found = (await tidyOf(WS_OLD))!
    await store.insertAgent({
      ...found,
      instructions: MEMORY_TIDY_INSTRUCTIONS_V1,
      instructionsAssembled: true,
      updatedAt: Date.now(),
    })
    const result = await ensureBuiltinMemoryTidy(store, WS_OLD)
    assert.equal(result.action, 'healed')
    const after = (await tidyOf(WS_OLD))!
    assert.equal(after.instructions, MEMORY_TIDY_INSTRUCTIONS_BODY, '升级成当前默认')
    assert.match(after.instructions, /要泛化/)
  })

  test('★★ 但**使用者自己写的**指令绝不升级（判据是"逐字等于历史默认"）', async () => {
    const WS_MINE = wsId('ws-memory-tidy-mine')
    await ensureTestWorkspace(store, WS_MINE)
    await ensureBuiltinMemoryTidy(store, WS_MINE)
    const found = (await tidyOf(WS_MINE))!
    await store.insertAgent({
      ...found,
      instructions: `${MEMORY_TIDY_INSTRUCTIONS_V1}\n\n（我自己加的一条：报告要短）`,
      instructionsAssembled: true,
      updatedAt: Date.now(),
    })
    const result = await ensureBuiltinMemoryTidy(store, WS_MINE)
    assert.equal(result.action, 'left-alone')
    const after = (await tidyOf(WS_MINE))!
    assert.match(after.instructions, /我自己加的一条/)
  })

  test('★★ `ensureBuiltinAgents` 四条一起对账，并把槽位表写回去', async () => {
    const WS3 = wsId('ws-both')
    await ensureTestWorkspace(store, WS3)
    const table = await loadSlotTable(store, WS3)
    const out = await ensureBuiltinAgents(store, WS3, table)
    await saveSlotTable(store, WS3, table)
    assert.equal(out.drafter.action, 'created')
    assert.equal(out.memoryTidy.action, 'created')
    assert.equal(out.agentMaker.action, 'created')
    assert.equal(out.workflowMaker.action, 'created')
    // 四个槽位都认领上了
    assert.equal(Object.keys(table).length, 4)
    assert.equal((await platformMemberOf(store, WS3, 'drafter'))?.name, DRAFTER_NAME)
    assert.equal((await platformMemberOf(store, WS3, 'memory-tidy'))?.name, MEMORY_TIDY_NAME)
    // 平台上正好四条（没有多出来的）
    const platform = (await store.listAgents(WS3)).filter((a) => a.owner === 'platform')
    assert.equal(platform.length, 4)
  })
})

/**
 * ★★★ 2026-11（D154）：**反复调用 `ensure*` / `syncDrafterSkillMount` 不会越建越多**。
 *
 * 这条判据来自一次**真机上量到的事故**：改成槽位表之后，`syncDrafterSkillMount(store, ws)`
 * 的第三个参数被写成了默认值 `= {}`（空表）。于是每次"起草前对齐挂载"都拿着**空表**
 * 去认人 ⇒ `resolveSlot` 回退老字段 ⇒ 新记录根本没有老字段 ⇒ **认不出 ⇒ 建一条新的**。
 * crystallize-e2e 当场红了一条 `还有 48 个智能体挂着「distilly」：沉淀起草者（内置）…`
 * ——48 个同名起草者并存的画面，比任何断言都清楚。
 *
 * 判据落在**库里的条数**上（不是"函数返回了什么"）：跑五遍，平台上永远只有那四条。
 */
describe('★★★ 幂等：反复对齐挂载 / 反复对账，平台上永远只有四条', () => {
  test('syncDrafterSkillMount 跑五遍 ⇒ 起草者仍然只有一条', async () => {
    const WS_MOUNT = wsId('ws-mount-idempotent')
    await ensureTestWorkspace(store, WS_MOUNT)
    for (let i = 0; i < 5; i += 1) {
      await syncDrafterSkillMount(store, WS_MOUNT)
    }
    const drafters = (await store.listAgents(WS_MOUNT)).filter((a) => a.name === DRAFTER_NAME)
    assert.equal(drafters.length, 1, `起草者只该有一条，实际 ${drafters.length} 条`)
  })

  test('ensureBuiltinAgents 跑五遍 ⇒ 四个槽位指向同四条记录，且没有多出来的', async () => {
    const WS_MANY = wsId('ws-many-idempotent')
    await ensureTestWorkspace(store, WS_MANY)
    const first = await ensureBuiltinAgents(store, WS_MANY)
    const firstIds = Object.values(first.slots).sort()
    for (let i = 0; i < 4; i += 1) {
      const again = await ensureBuiltinAgents(store, WS_MANY)
      assert.equal(again.drafter.action, 'left-alone')
      assert.deepEqual(Object.values(again.slots).sort(), firstIds, '槽位指向的 id 不许变')
    }
    const platform = (await store.listAgents(WS_MANY)).filter((a) => a.owner === 'platform')
    assert.equal(platform.length, 4, `平台上正好四条，实际 ${platform.length} 条`)
  })

  test('★ 槽位表被清空再跑一次 ⇒ 只补**缺的那四条**（旧记录原样留着，不重复建）', async () => {
    const WS_RESET = wsId('ws-reset-idempotent')
    await ensureTestWorkspace(store, WS_RESET)
    await ensureBuiltinAgents(store, WS_RESET)
    await saveSlotTable(store, WS_RESET, {})
    await ensureBuiltinAgents(store, WS_RESET)
    const platform = (await store.listAgents(WS_RESET)).filter((a) => a.owner === 'platform')
    // 表清空 = 认不出 ⇒ 每条各建一条新的（4 旧 + 4 新）。旧的不删（使用者的数据）。
    assert.equal(platform.length, 8, '新补四条；旧的四条原样留着')
    // 再跑一遍就不再增长（表已经认领好了）
    await ensureBuiltinAgents(store, WS_RESET)
    assert.equal(
      (await store.listAgents(WS_RESET)).filter((a) => a.owner === 'platform').length,
      8,
      '认领之后就稳住，不再增长',
    )
  })
})
