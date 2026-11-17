import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKFLOW_TEMPLATES } from './workflows.ts'

/**
 * 「从模板」那一批模板的质量关（2026-11）。
 *
 * 使用者："『单组流程，顺序流水线，并行派活，评审返工，路由分流，协调者，人机把关』
 * 这些都是简单编排，并没有实际用途，建议给实际有用的编排。"
 *
 * 复查旧的那批还发现两条**是坏的**：`flow('inline:协调智能体')` 传字符串，而 `flow`
 * 的入参是 `Handle[]`（内部 `agents.map`）⇒ 一跑就炸。所以这里钉三件事：
 *   ① 每条都**语法合法**（用与引擎同一条构造路径 `AsyncFunction` 只编译不执行）；
 *   ② 不许出现**已经退场的写法**（`inline:` 字符串参数、组名、`groupA` 占位）；
 *   ③ 每条都得说清"它是干什么的"（`summary` 非空）——模板是给人挑的，不是给人读的。
 */

/** 与引擎同一个构造方式：只编译，不执行（不产生任何 run，NFR-T-01）。 */
function compiles(code: string): { ok: true } | { ok: false; error: string } {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as new (...args: string[]) => unknown
    // eslint-disable-next-line no-new -- 只构造不调用：语法错误在这一步抛
    new AsyncFunction('agent', 'gate', 'flow', 'parallel', 'loop', 'route', code)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

describe('编排模板：能跑、说人话、没有退场写法', () => {
  test('至少三条（少了不像"可选模板"，多了没人看）', () => {
    assert.ok(WORKFLOW_TEMPLATES.length >= 3, `只有 ${WORKFLOW_TEMPLATES.length} 条`)
  })

  test('★ 每条都语法合法（与引擎同一条构造路径，只编译不执行）', () => {
    for (const tpl of WORKFLOW_TEMPLATES) {
      const r = compiles(tpl.code)
      assert.equal(r.ok, true, `模板「${tpl.name}」语法不合法：${r.ok ? '' : r.error}`)
    }
  })

  test('★★ 不许出现已经退场的写法：`inline:` 字符串参数 / 组名占位', () => {
    for (const tpl of WORKFLOW_TEMPLATES) {
      assert.ok(
        !/flow\(\s*['"]inline:/.test(tpl.code) && !/['"]inline:[^'"]*['"]/.test(tpl.code),
        `模板「${tpl.name}」用了 inline: 字符串——那会被当成字符串传给 flow（agents.map 炸）`,
      )
      assert.ok(
        !/group[AB]|组A|组B|allowedActions/.test(tpl.code),
        `模板「${tpl.name}」里还有已退场的概念（组 / 动作权限）`,
      )
    }
  })

  test('★ 每条都得说清它做什么（summary 非空、name 不重复）', () => {
    const names = new Set<string>()
    for (const tpl of WORKFLOW_TEMPLATES) {
      assert.ok(tpl.summary.trim() !== '', `模板「${tpl.name}」没有 summary`)
      assert.ok(!names.has(tpl.name), `模板名重复：${tpl.name}`)
      names.add(tpl.name)
    }
  })

  test('★ 至少一条演示「人放行用 reuseOutput」（那是我们最想让人看到的写法）', () => {
    assert.ok(
      WORKFLOW_TEMPLATES.some((t) => t.code.includes('reuseOutput')),
      '没有人放行的真实写法，模板就不算"有用"',
    )
  })
})
