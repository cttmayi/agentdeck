import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  TERMINAL_RUN_STATUSES,
  applyChoice,
  chatFilesState,
  executorChoices,
  isTurnRunning,
  skillsHeldBackByDaemon,
  type DraftPick,
} from './chat.ts'
import type { Agent, Skill } from './api.ts'

describe('聊天的纯逻辑', () => {
  test('★ 终态那一列必须与协议里的终态逐项相同（抄一份不钉住，才是最危险的那种抄）', () => {
    // 前端不 import protocol（`api.ts` 顶部写着理由），所以终态在这边是抄的一列
    // 常量。抄的东西会腐烂——这条测试读**协议源码**把它对上，腐烂当场变红。
    const path = fileURLToPath(new URL('../../../../packages/domain/src/state/run.ts', import.meta.url))
    const source = readFileSync(path, 'utf8')
    const expected = [...source.matchAll(/^\s{2}(\w+): \[\],?$/gm)].map((m) => m[1]!)
    assert.ok(expected.length >= 3, `没能从 ${path} 里抠出终态，检查那条正则`)
    assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(), expected.sort())
  })

  test('"正在跑"看状态，不看界面记没记住那条 run（刷新回来的页面也得对）', () => {
    assert.equal(isTurnRunning({ runId: 'r1', status: 'running' }), true)
    assert.equal(isTurnRunning({ runId: 'r1', status: 'waiting_local_directory' }), true)
    assert.equal(isTurnRunning({ runId: 'r1', status: 'queued' }), true)
    assert.equal(isTurnRunning({ runId: 'r1', status: 'completed' }), false)
    assert.equal(isTurnRunning({ runId: 'r1', status: 'failed' }), false)
    assert.equal(isTurnRunning({ runId: 'r1', status: 'cancelled' }), false)
    // 没跑起来的那一轮（没抢到并发位）不是"正在跑"
    assert.equal(isTurnRunning({ runId: null, status: null }), false)
  })

})

describe('新对话的下拉：skill 是执行者的另一条入口', () => {
  // Agent / Skill 的字段都很多，这里只填判据用得到的，其余按类型断言放过。
  const agent = (id: string, name: string, skillIds: string[] = [], role = 'executor'): Agent =>
    ({ id, name, skillIds, role }) as unknown as Agent
  const skill = (id: string, slug: string): Skill => ({ id, slug, name: slug }) as unknown as Skill

  const executors = [agent('a1', '助手'), agent('a2', '算法艺术', ['s1']), agent('a3', '文章写作')]
  const skills = [skill('s1', 'algorithmic-art'), skill('s2', 'skill-creator')]
  const choices = executorChoices(executors, skills, null, true)
  const none: DraftPick = { agentId: '', skillId: '' }

  test('先列执行者，再列**每一条** skill——包括没人挂的那条（顺序稳定）', () => {
    assert.deepEqual(
      choices.map((c) => c.value),
      ['agent:a1', 'agent:a2', 'agent:a3', 'skill:s1', 'skill:s2'],
    )
  })

  test('★ 有主的 skill：选它 = 绑挂着它的那个执行者', () => {
    assert.deepEqual(applyChoice('skill:s1', choices, none, 'a1'), { agentId: 'a2', skillId: 's1' })
  })

  test('★★ 没人挂的 skill 也能选：绑**你当前那个人**，skill 跟着这个对话走', () => {
    // 当前是"文章写作" ⇒ 就该是文章写作 + skill-creator，不许被换成默认的助手
    assert.deepEqual(
      applyChoice('skill:s2', choices, { agentId: 'a3', skillId: '' }, 'a1'),
      { agentId: 'a3', skillId: 's2' },
    )
    // 还没选过谁 ⇒ 用平台默认执行者
    assert.deepEqual(applyChoice('skill:s2', choices, none, 'a2'), { agentId: 'a2', skillId: 's2' })
  })

  test('★ 换成执行者时把 skill 清掉（"我以为在跟 A 说话，其实还带着 B 的 skill"）', () => {
    assert.deepEqual(
      applyChoice('agent:a3', choices, { agentId: 'a2', skillId: 's1' }, null),
      { agentId: 'a3', skillId: '' },
    )
  })

  test('挂在审核者身上的 skill 算"没人挂"——审核者不能被选来聊天', () => {
    const withReviewer = [...executors, agent('r1', '助手审核员', ['s2'], 'reviewer')]
    const out = executorChoices(withReviewer, skills, null, true)
    assert.equal(out.some((c) => c.value === 'agent:r1'), false, '审核者不能出现在下拉里')
    // s2 仍然没有执行者挂 ⇒ 它的选项不带主人，选的时候落到当前那个人身上
    assert.deepEqual(
      applyChoice('skill:s2', out, { agentId: 'a1', skillId: '' }, null),
      { agentId: 'a1', skillId: 's2' },
    )
  })

  test('多个执行者挂了同一个 skill：优先平台默认执行者，否则取列表里第一个', () => {
    const both = [agent('a1', '助手', ['s1']), agent('a2', '算法艺术', ['s1'])]
    const val = (preferred: string | null) =>
      executorChoices(both, skills, preferred, true).find((c) => c.value === 'skill:s1')!.agentId
    assert.equal(val(null), 'a1')
    assert.equal(val('a2'), 'a2')
    assert.equal(val('a3'), 'a1')
  })

  test('认不出来的值：**原样不动**（不偷偷把选中状态改成别人）', () => {
    for (const bad of ['', 'agent:', 'skill:', 'skill:不存在', 'a1', 'agent:a1 ']) {
      assert.deepEqual(applyChoice(bad, choices, { agentId: 'a3', skillId: 's2' }, 'a1'), {
        agentId: 'a3',
        skillId: 's2',
      })
    }
  })

  test('执行者与 skill 的 id 恰好相同时，两个前缀各走各的（不能互相串）', () => {
    // skill 的 id 撞上执行者 x，但它挂的是 y ⇒ 两个前缀必须各走各的
    const collide = [agent('x', '助手'), agent('y', '算法艺术', ['x'])]
    const out = executorChoices(collide, [skill('x', 'lucky')], null, true)
    assert.equal(out.length, 3)
    assert.deepEqual(applyChoice('agent:x', out, none, null), { agentId: 'x', skillId: '' })
    assert.deepEqual(applyChoice('skill:x', out, none, null), { agentId: 'y', skillId: 'x' })
  })

  test('一个执行者都没有 ⇒ 连 skill 也不给选（那些选项最后都要落到某个人身上）', () => {
    assert.deepEqual(executorChoices([], skills, null, true), [])
  })

  /**
   * ★ 旧 daemon：它不认识 `Conversation.skillIds`（请求体没有 zod 校验，未知字段
   * 被**静默忽略**）。
   *
   * 这是这一页很容易真踩上的一档："只重建前端、刷新页面"是日常做法，而那时候
   * 界面会写着"将使用 助手 + skill-creator"，实际那一轮根本没带上它——两边都不
   * 报错。所以旧 daemon 上**没人挂的 skill 干脆不出现**：少一个选项，胜过一个
   * 兑现不了的承诺。
   */
  test('★ 旧 daemon（不认 skillIds）：没人挂的 skill 不进选项，有主的照旧', () => {
    const old = executorChoices(executors, skills, null, false)
    assert.deepEqual(
      old.map((c) => c.value),
      ['agent:a1', 'agent:a2', 'agent:a3', 'skill:s1'],
      '没人挂的 s2 不出现；挂在算法艺术身上的 s1 照旧能选（它走"选它 = 选那个人"）',
    )
    assert.deepEqual(
      applyChoice('skill:s1', old, none, null),
      { agentId: 'a2', skillId: 's1' },
      '有主的 skill 在新旧 daemon 上行为一致',
    )
  })

  test('★ 被旧 daemon 挡住的是哪几条，要用名字报出来（否则列表看起来像坏了）', () => {
    assert.deepEqual(
      skillsHeldBackByDaemon(executors, skills, false).map((s) => s.slug),
      ['skill-creator'],
    )
    // 新 daemon 上一条都不挡
    assert.deepEqual(skillsHeldBackByDaemon(executors, skills, true), [])
    // 一个执行者都没有时，页面说的是"先去建一个执行者"，不是"被挡住了"
    assert.deepEqual(skillsHeldBackByDaemon([], skills, false), [])
  })
})

/**
 * 聊天右栏底部那一栏「工作目录的文件」该不该画。
 *
 * 三种情况长得像、处理却不一样，而这里出过一次"看起来像没数据"的事故
 * （任务页那一栏把"取不到"画成了骨架屏 ⇒ 与"还在加载"长得一模一样）。
 */
describe('聊天里的「工作目录的文件」这一栏', () => {
  const base = { drafting: false, conversationId: 'c1', capability: true }

  test('正常：对话在、daemon 认那条接口 ⇒ 交给 WorkDirTree 去取', () => {
    assert.equal(chatFilesState(base), 'ready')
  })

  test('★ 草稿态不画：还没有对话，也就还没有目录（画个空壳会让人以为本来该有东西）', () => {
    assert.equal(chatFilesState({ ...base, drafting: true }), 'hidden')
    assert.equal(chatFilesState({ ...base, conversationId: null }), 'hidden')
    assert.equal(chatFilesState({ ...base, conversationId: '' }), 'hidden')
  })

  test('★ 草稿态优先于能力：那时连目录都没有，谈不上"这个 daemon 支不支持"', () => {
    assert.equal(chatFilesState({ ...base, drafting: true, capability: false }), 'hidden')
  })

  test('★ 旧 daemon（没有 conversation-files）⇒ 说明原因，不去撞 404', () => {
    assert.equal(chatFilesState({ ...base, capability: false }), 'unsupported')
  })
})
