import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FileStore } from '@agentdeck/store-file'
import { agentSkillOwner } from '@agentdeck/domain'
import { wsId } from '@agentdeck/domain/testing'
import { ensureBuiltinAgents } from './builtin-drafter.ts'
import { platformMemberOf } from './platform-slots.ts'
import { loadInjectableSkills, skillSourcesOfAgent } from './agent-injectable-skills.ts'
import {
  WORKFLOW_MAKER_SKILL_SLUGS,
  checkSkillSamples,
  ensureBuiltinWorkflowMakerSkills,
  jsBlocksOf,
  missingPrimitives,
} from './workflow-maker-skills.ts'
import { WORKFLOW_PRIMITIVES } from './workflow-maker.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { ensureTestWorkspace } from './testing/test-workspace.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * 编排生成者的**平台技能**（D143）——"它怎么会知道怎么写编排"这件事的答案。
 *
 * 起因（使用者）：「"编排生成者" 里面并没有描述 API 的细节，它怎么会知道怎么写编排呢」。
 * 原来的指令只有五行伪代码：**签名**（`parallel` 返回数组、`loop` 第三个参数可以是 opts）、
 * `{{task}}` 的含义、Reply 的形状、**把关者必须会判**、人判要配 `reuseOutput`——全都没有。
 *
 * 所以照智能体生成者那条分工（D111）把 API 细节交给**独有技能**。这份测试钉三件事：
 *   ① 播种：一份、幂等、**不进技能库**、走同一条注入通道；
 *   ② 与引擎一致：六个原语一个不少、正文里每段 ```js 都能被 `validateWorkflowCode` 编译过；
 *   ③ 关键语义真的写在正文里（把关者要会判 / reuseOutput / parallel 是数组 / {{task}}）。
 * ② 是最要紧的：**写进规范里的例子跑不起来**是最坏的一种失真——模型会照着抄。
 */

const WS = wsId('ws-workflow-maker-skills')

/** 读随仓库分发的那份正文（与播种读的是同一个文件）。 */
async function skillBody(): Promise<string> {
  const path = fileURLToPath(
    new URL('../catalog/platform-skills/orchestration-authoring/SKILL.md', import.meta.url),
  )
  return await readFile(path, 'utf8')
}

describe('编排生成者的平台技能：播种', () => {
  test('★ 播种一次就位；再跑一遍什么都不写（幂等）；**不进技能库**', async () => {
    const dir = await makeTempDir('wf-maker-skills')
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    // ★ 2026-11（D154）：槽位表挂在工作区上 ⇒ 用 store 的用例必须先有工作区
    await ensureTestWorkspace(store, WS)
    try {
      await ensureBuiltinAgents(store, WS)
      const first = await ensureBuiltinWorkflowMakerSkills(store, WS)
      assert.deepEqual([...first.seeded].sort(), [...WORKFLOW_MAKER_SKILL_SLUGS].sort())

      const maker = (await platformMemberOf(store, WS, 'workflow-maker'))!
      assert.ok(maker, '启动对账里要有编排生成者')
      const exclusive = await store.listExclusiveSkills(agentSkillOwner(maker.id))
      assert.equal(exclusive.length, WORKFLOW_MAKER_SKILL_SLUGS.length)
      assert.ok(exclusive[0]!.body.includes('## When to Use'), '正文要完整（含 When to Use）')

      // ★ 不进技能库：技能页看不到、也没有卸载入口（与生成者那三份同一口径）
      assert.deepEqual(await store.listSkills(WS), [])
      assert.deepEqual(maker.skillIds, [], '生成者不挂库技能')

      const again = await ensureBuiltinWorkflowMakerSkills(store, WS)
      assert.deepEqual(again.seeded, [], '第二遍不再写')
      assert.equal((await store.listExclusiveSkills(agentSkillOwner(maker.id))).length, 1)
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })

  test('★★ 走同一条注入通道：编排生成者的一轮 run 里带着它（source: agent）', async () => {
    const dir = await makeTempDir('wf-maker-inject')
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    // ★ 2026-11（D154）：槽位表挂在工作区上 ⇒ 用 store 的用例必须先有工作区
    await ensureTestWorkspace(store, WS)
    try {
      await ensureBuiltinAgents(store, WS)
      await ensureBuiltinWorkflowMakerSkills(store, WS)
      const maker = (await platformMemberOf(store, WS, 'workflow-maker'))!
      const payloads = await loadInjectableSkills(store, skillSourcesOfAgent(maker))
      const refs = payloads.map((p) => ({ slug: p.ref.slug, source: p.ref.source, id: p.ref.id }))
      assert.deepEqual(refs, [{ slug: 'orchestration-authoring', source: 'agent', id: null }])
      assert.ok(payloads[0]!.body.includes('## When to Use'))
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })
})

describe('编排生成者的平台技能：与引擎一致（这份技能不能教错）', () => {
  test('★★★ 六个原语一个不少（与 `WORKFLOW_PRIMITIVES` 逐个对上）', async () => {
    const body = await skillBody()
    assert.deepEqual(missingPrimitives(body), [], '正文里必须出现引擎的全部原语')
    assert.deepEqual([...WORKFLOW_PRIMITIVES].sort(), ['agent', 'flow', 'gate', 'loop', 'parallel', 'route'])
  })

  test('★★★ 正文里每一段 ```js 都能被 `validateWorkflowCode` 编译通过', async () => {
    const body = await skillBody()
    assert.ok(jsBlocksOf(body).length >= 5, '示例不能被删光——它们是这份技能的主体')
    assert.deepEqual(checkSkillSamples(body), [], '规范里的例子必须真能跑（模型会照着抄）')
  })

  test('★★ 关键语义写在正文里：把关者要会判 / 人判配 reuseOutput / parallel 是数组 / {{task}} 的含义', async () => {
    const body = await skillBody()
    // 这几条是"照猜写会错"的地方——每一条都对应一次真机踩坑
    for (const needle of [
      '判定函数', // 不带判定函数的 agent 不能当把关者
      'reuseOutput', // 人判不重跑执行者
      'Reply 数组', // parallel 返回数组，不是 Handle
      '{{task}}', // 运行时人填的那句话
      '名字必须真存在', // 名字错了采纳会被拒
    ]) {
      assert.ok(body.includes(needle), `正文里缺少「${needle}」这一条`)
    }
  })

  test('★★★ 老工作区能升到新版：旧默认收在 HISTORY 里（否则会被判成"使用者改过"）', async () => {
    /*
     * `ensureBuiltinWorkflowMaker` 的三条纪律里，第三条是"指令还是旧版 ⇒ 换回默认"，
     * 而"旧版"是靠 `WORKFLOW_MAKER_INSTRUCTIONS_HISTORY` **逐字比对**认出来的。
     * 改了默认却不把旧的那份记进去 ⇒ 已经装过的工作区永远停在旧指令上
     * （界面上看是"内置那个没更新"，而代码里一切正常）。
     */
    const { WORKFLOW_MAKER_INSTRUCTIONS_HISTORY, WORKFLOW_MAKER_INSTRUCTIONS_BODY } = await import(
      './builtin-drafter.ts'
    )
    assert.ok(WORKFLOW_MAKER_INSTRUCTIONS_HISTORY.length >= 1, '至少记着一个旧默认')
    assert.ok(
      !WORKFLOW_MAKER_INSTRUCTIONS_HISTORY.includes(WORKFLOW_MAKER_INSTRUCTIONS_BODY),
      '当前默认不该出现在历史里',
    )
    // 旧默认里那句"没有 API 细节"的特征句必须还在历史里（证明收的是**旧的那版**）
    assert.ok(
      WORKFLOW_MAKER_INSTRUCTIONS_HISTORY.some((h) => !h.includes('orchestration-authoring')),
      '历史里要有"没有指向 skill"的那一版',
    )
  })

  test('★ 指令里指向这份技能（"动笔之前照它写"）——两份各管一段，不许重复写 API', async () => {
    const dir = await makeTempDir('wf-maker-instructions')
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    // ★ 2026-11（D154）：槽位表挂在工作区上 ⇒ 用 store 的用例必须先有工作区
    await ensureTestWorkspace(store, WS)
    try {
      await ensureBuiltinAgents(store, WS)
      const maker = (await platformMemberOf(store, WS, 'workflow-maker'))!
      assert.match(maker.instructions, /orchestration-authoring/)
      assert.match(maker.instructions, /动笔之前先照它写/)
      // 签名细节留在技能里：指令中不写 "Reply 数组" 这种 API 术语（避免两份各说一半）
      assert.ok(!maker.instructions.includes('Reply 数组'), '指令里不该重复技能里的 API 细节')
    } finally {
      await store.close()
      await cleanup(dir)
    }
  })
})
