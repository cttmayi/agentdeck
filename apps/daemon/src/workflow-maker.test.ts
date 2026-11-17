import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkflowDraft, validateWorkflowCode } from './workflow-maker.ts'

/**
 * 编排生成者：草稿解析 + 采纳前校验（2026-11，设计 `docs/tmp/workflow-maker-design.md`）。
 *
 * 使用者拍板"校验力度：语法 + 节点名"。这一组钉的就是那两道：
 *   · 语法错了 ⇒ 采纳时当场拒（而不是等他点「运行」才看见 SyntaxError）；
 *   · `agent('名字')` 引用了不存在的智能体 ⇒ 点名拒（引擎在提交那一步找不到人，
 *     代价是已经烧掉一条 run）；
 *   · 拼出来的引用（`agent(变量)`）⇒ **放行**并如实报"有 N 处数不清"。
 */

const AGENTS = ['数据员', '撰稿员', '代码审查员']

describe('编排草稿：解析', () => {
  test('★ name + 正文=代码（可带 ```js 围栏，解析时剥掉）', () => {
    const text = [
      '---',
      'name: 周报流水线',
      'summary: 取数 → 成稿 → 人确认',
      '---',
      '',
      '```js',
      "await flow([agent('数据员')], '{{task}}')",
      '```',
    ].join('\n')
    const p = parseWorkflowDraft(text)
    assert.equal(p.ok, true)
    if (!p.ok) return
    assert.equal(p.name, '周报流水线')
    assert.equal(p.summary, '取数 → 成稿 → 人确认')
    assert.equal(p.code, "await flow([agent('数据员')], '{{task}}')", '围栏剥掉、内容原样')
  })

  test('★ 不带围栏也认（正文直接就是代码）', () => {
    const p = parseWorkflowDraft('---\nname: 最小\n---\nawait gate("好了吗")')
    assert.equal(p.ok, true)
    if (p.ok) assert.equal(p.code, 'await gate("好了吗")')
  })

  test('几种该拒的都拒，并说清哪里不对', () => {
    assert.equal(parseWorkflowDraft('name: x').ok, false, '没有 frontmatter')
    assert.equal(parseWorkflowDraft('---\nname: x').ok, false, 'frontmatter 没闭合')
    assert.equal(parseWorkflowDraft('---\nsummary: 只有说明\n---\ncode').ok, false, '缺 name')
    assert.equal(parseWorkflowDraft('---\nname: 空代码\n---\n').ok, false, '没有代码')
    const long = parseWorkflowDraft(`---\nname: ${'x'.repeat(101)}\n---\nawait gate('go')`)
    assert.equal(long.ok, false, '名字太长')
  })
})

describe('编排代码：采纳前校验（语法 + 节点名）', () => {
  test('★ 语法合法 + 名字都在 ⇒ 通过', () => {
    const r = validateWorkflowCode(
      "const 写 = agent('撰稿员')\nawait loop(写, gate('请过目'), { maxRounds: 2, reuseOutput: true })",
      AGENTS,
    )
    assert.equal(r.ok, true)
    assert.equal(r.syntaxError, null)
    assert.deepEqual(r.unknownAgents, [])
  })

  test('★★ 语法错 ⇒ 拒，并带上原始错误（只编译不执行，不产生 run）', () => {
    const r = validateWorkflowCode("await flow([agent('数据员'), '{{task}}'", AGENTS)
    assert.equal(r.ok, false)
    assert.notEqual(r.syntaxError, null)
    assert.match(String(r.syntaxError), /./)
  })

  test('★★ 引用了不存在的智能体 ⇒ 拒，并**点名**是哪几个', () => {
    const r = validateWorkflowCode(
      "await flow([agent('数据员'), agent('不存在的甲'), agent('不存在的乙')], '{{task}}')",
      AGENTS,
    )
    assert.equal(r.ok, false)
    assert.deepEqual(r.unknownAgents, ['不存在的甲', '不存在的乙'])
  })

  test('★ 拼出来的引用（agent(变量)）⇒ 放行，但如实报"有 N 处数不清"', () => {
    const r = validateWorkflowCode(
      "const 模块 = ['数据员']\nconst 改 = (m) => agent(m)\nawait flow([改(模块[0])], '{{task}}')",
      AGENTS,
    )
    assert.equal(r.ok, true, '拼出来的引用不许拒（宁可少校验）')
    assert.equal(r.unverifiable, 1, '`agent(m)` 这一处数不清')
  })
})
