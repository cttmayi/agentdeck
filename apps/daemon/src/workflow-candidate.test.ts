import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { MATERIAL_DIR, materialPackForSlot, seedMaterial } from './material-seed.ts'
import { checkCandidateCode, readCandidate, readCandidates, AGENT_SOFT_LIMIT } from './workflow-candidate.ts'

/**
 * **资料落盘 + 候选编排预检**（2026-11，D255）。
 *
 * 这两件事共同回答使用者那两个要求：
 *   · 「编排写法以资料的形式动态输入到工作目录」⇒ `seedMaterial`（每次覆盖写）；
 *   · 「在聊天的工作目录生成存储的格式」⇒ `readCandidate`（读那个目录 + 四条校验）。
 *
 * 判据的选择理由：
 *   · **落盘**要钉"覆盖写"（同一目录第二次落盘是新版，不是追加）与"只落这一包"；
 *   · **预检**要钉住"确定错的一定拒"（语法 / 不存在的内建人 / 不在原语里的调用）
 *     与"数不清的只提示不拒"（`agent(变量)`）——后者拒掉会误伤正常代码。
 */

const wsDir = (dir: string) => join(dir, 'work')

/**
 * ★★ D261（使用者贴出生成结果的疑问："感觉有问题，记得没有返回值呢"）：
 * `main.js` 的 `return` 是**死代码**——引擎 `await fn(...)` 之后把返回值丢了。
 * 生成者却总用它来拼"最后给人看的一段话"（失败提示、汇总），于是那句话谁也没看到。
 *
 * 判据分两半：顶层的 `return` 要提示；**判定函数体里的 `return` 不要提示**
 * （那是函数自己的返回值，正常写法）——两边都要钉，否则会误伤真机上那一整类编排。
 */
describe('顶层 return：提示"返回值没人用"（D261）', () => {
  test('★★ 顶层 return 记成 warn（不拦入库），且不误伤判定函数里的 return', () => {
    const code = [
      "const 调研 = agent('AI调研者')",
      "const 审校 = agent('稿件审校员', (意见) => ({",
      "  result: /^通过/.test(String(意见).trim()) ? 'pass' : 'fail',",
      '}))',
      "const 结果 = await loop(调研, 审校, '{{task}}', { maxRounds: 2 })",
      "if (结果.result === 'fail') {",
      "  return '两轮未通过'",
      '}',
      'return 结果.message',
    ].join('\n')
    const check = checkCandidateCode(code, new Set(['AI调研者', '稿件审校员']))
    assert.equal(check.syntaxError, null)
    assert.equal(check.topLevelReturns, 2, '两处顶层 return')

    // 判定函数体里的 return（带花括号那种）不算
    const inner = checkCandidateCode(
      "const 甲 = agent('甲', (意见) => { return { result: 'pass' } })",
      new Set(['甲']),
    )
    assert.equal(inner.topLevelReturns, 0, '函数内部的 return 是正常的')
  })

  test('★ 候选卡片上确实带着这条提示（warn 级：能入库，但会写着）', async () => {
    const { workDir } = await makeCandidate({
      mainJs: "const 甲 = agent('甲')\nawait 甲\nreturn '一段没人看的话'\n",
      agents: [{ name: '甲' }],
    })
    const candidate = await readCandidate(workDir, '周报流水线')
    const warn = candidate.problems.find((p) => p.level === 'warn' && p.message.includes('return'))
    assert.ok(warn, `要有一条"return 没用"的提示（现在：${JSON.stringify(candidate.problems)}）`)
    assert.ok(
      candidate.problems.every((p) => p.level !== 'error'),
      '这是提示不是拦截：代码本身能跑',
    )
  })
})

describe('资料落盘（material）', () => {
  test('★★ 覆盖写：第二次落盘是新版，且只换这一包', async () => {
    const root = await makeTempDir('material-seed')
    const workDir = join(root, 'work')
    await mkdir(workDir, { recursive: true })

    assert.equal(await seedMaterial({ workDir, packs: ['orchestration'] }), true)
    const target = join(workDir, MATERIAL_DIR)
    const api = await readFile(join(target, 'orchestration/api.md'), 'utf8')
    assert.ok(api.includes('agent'), '资料里要有原语说明')
    const index = await readFile(join(target, 'README.md'), 'utf8')
    assert.ok(index.includes('orchestration'), '索引里要写清这次是哪几包')

    // 覆盖写：把资料里的文件改花，再落一次 ⇒ 回到仓库那份（不是追加、不是"保留使用者改动"）
    await writeFile(join(target, 'orchestration/api.md'), '被改花了', 'utf8')
    assert.equal(await seedMaterial({ workDir, packs: ['orchestration'] }), true)
    const again = await readFile(join(target, 'orchestration/api.md'), 'utf8')
    assert.equal(again, api, '第二批落盘把上一版整份换掉')

    // 只换这几包：没点到的包不动（同一对话里换过生成者时留下的那份还在）
    await seedMaterial({ workDir, packs: ['agent'] })
    assert.ok(existsSync(join(target, 'agent/README.md')), 'agent 包也在')
    assert.ok(existsSync(join(target, 'orchestration/api.md')), 'orchestration 包还在（没被删）')
    await cleanup(root)
  })

  test('★ 沉淀起草 run 的资料：material/skill 落盘（含 format/checklist/例子）', async () => {
    const root = await makeTempDir('material-drafter')
    const workDir = join(root, 'skill-draft-x')
    await mkdir(join(workDir, 'material'), { recursive: true })
    const { seedDrafterMaterial } = await import('./material-seed.ts')
    assert.equal(await seedDrafterMaterial({ workDir }), true)
    const base = join(workDir, MATERIAL_DIR, 'skill')
    assert.ok(existsSync(join(base, 'format.md')), 'format.md 要在')
    assert.ok(existsSync(join(base, 'checklist.md')), 'checklist.md 要在')
    assert.ok(
      existsSync(join(base, 'examples', 'meeting-notes-format', 'SKILL.md')),
      '例子要在（照着改的那一份）',
    )
    // 素材目录里的其它文件不受影响（`00-README.md` 是沉淀素材的索引）
    await writeFile(join(workDir, 'material', '00-README.md'), '素材索引', 'utf8')
    await seedDrafterMaterial({ workDir })
    assert.equal(await readFile(join(workDir, 'material', '00-README.md'), 'utf8'), '素材索引')
    await cleanup(root)
  })

  /**
   * ★ D259（使用者问：「编排生成者不需要生成 Agent 的资料吗？为什么没有呢」）：
   * 资料要按**它写什么**发，不是按它的名字发——编排生成者也自己写内建智能体与技能，
   * 所以它要三包；智能体生成者也写配套技能，所以它要两包。
   */
  test('★★ 哪几类生成者读哪几包：按"它写什么"发（编排生成者三包）', () => {
    assert.deepEqual(materialPackForSlot('workflow-maker'), ['orchestration', 'agent', 'skill'])
    assert.deepEqual(materialPackForSlot('agent-maker'), ['agent', 'skill'])
    // 起草者的素材归沉淀那条链（`crystallize-material.ts` + `seedDrafterMaterial`），不在这里发
    assert.deepEqual(materialPackForSlot('drafter'), [])
    assert.deepEqual(materialPackForSlot('memory-tidy'), [])
    assert.deepEqual(materialPackForSlot(null), [])
  })

  test('★★ 编排生成者一轮落三包：内建智能体与技能的写法都在工作目录里', async () => {
    const root = await makeTempDir('material-maker')
    const workDir = join(root, 'work')
    await mkdir(workDir, { recursive: true })
    assert.equal(await seedMaterial({ workDir, packs: materialPackForSlot('workflow-maker') }), true)
    const base = join(workDir, MATERIAL_DIR)
    // 编排：代码与原语
    assert.ok(existsSync(join(base, 'orchestration/api.md')))
    // 智能体：内建人的形状与岗位卡写法（没有它只能从 api.md 目录树那两行猜）
    assert.ok(existsSync(join(base, 'agent/shape.md')), 'agent 的形状要在')
    assert.ok(existsSync(join(base, 'agent/norms.md')), '岗位卡写法要在')
    // 技能：内建人自带技能的格式与体检项
    assert.ok(existsSync(join(base, 'skill/format.md')))

    const index = await readFile(join(base, 'README.md'), 'utf8')
    for (const pack of ['orchestration', 'agent', 'skill']) {
      assert.match(index, new RegExp(`\`${pack}/\``), `索引要列出 ${pack}`)
    }
    await cleanup(root)
  })
})

/** 铺一个候选（返回工作目录）。 */
async function makeCandidate(
  mutate: {
    workflowJson?: string | null
    mainJs?: string | null
    agents?: Array<{ name: string; instructions?: string; agentJson?: string }>
  } = {},
): Promise<{ root: string; workDir: string }> {
  const root = await makeTempDir('wf-candidate')
  const workDir = join(root, 'chat-x')
  const dir = join(workDir, 'workflow-draft', '周报流水线')
  await mkdir(dir, { recursive: true })
  const json =
    mutate.workflowJson === undefined
      ? JSON.stringify({ name: '周报流水线', summary: '取数→成稿→你过目' })
      : mutate.workflowJson
  if (json !== null) await writeFile(join(dir, 'workflow.json'), json, 'utf8')
  const code =
    mutate.mainJs === undefined
      ? "const 写作 = agent('写作员')\nconst r = await flow([写作], '{{task}}')\nreturn r.message\n"
      : mutate.mainJs
  if (code !== null) await writeFile(join(dir, 'main.js'), code, 'utf8')
  for (const a of mutate.agents ?? [{ name: '写作员', instructions: '你是写作员。' }]) {
    const base = join(dir, 'agents', a.name)
    await mkdir(base, { recursive: true })
    if (a.agentJson !== null) {
      await writeFile(join(base, 'agent.json'), a.agentJson ?? JSON.stringify({ name: a.name }), 'utf8')
    }
    if (a.instructions !== null) {
      await writeFile(join(base, 'instructions.md'), a.instructions ?? '你是写作员。', 'utf8')
    }
  }
  return { root, workDir }
}

describe('候选编排预检（workflow-candidate）', () => {
  test('★ 正常的候选：名字 / 人 / 没有 error', async () => {
    const { root, workDir } = await makeCandidate()
    const out = await readCandidate(workDir, '周报流水线')
    assert.equal(out.name, '周报流水线')
    assert.equal(out.summary, '取数→成稿→你过目')
    assert.deepEqual(out.agents.map((a) => a.name), ['写作员'])
    assert.equal(out.problems.filter((p) => p.level === 'error').length, 0, JSON.stringify(out.problems))
    assert.ok(out.codeLines > 0)
    assert.ok(out.absDir.endsWith('workflow-draft/周报流水线'))
    await cleanup(root)
  })

  test('★★ 四条硬错各拒一条，并把话说清', async () => {
    // ① 引用了 agents/ 下没有的人
    {
      const { root, workDir } = await makeCandidate({
        mainJs: "await agent('数据员').run('x')\n",
      })
      const out = await readCandidate(workDir, '周报流水线')
      assert.ok(
        out.problems.some((p) => p.level === 'error' && p.message.includes('数据员')),
        '要点名那个不存在的人',
      )
      await cleanup(root)
    }
    // ② 语法错
    {
      const { root, workDir } = await makeCandidate({ mainJs: 'await flow([', })
      const out = await readCandidate(workDir, '周报流水线')
      assert.ok(out.problems.some((p) => p.level === 'error' && p.message.includes('语法')))
      await cleanup(root)
    }
    // ③ 不在原语里的调用（`inline` 不存在）
    {
      const { root, workDir } = await makeCandidate({ mainJs: "await inline('写作员', 'x')\n" })
      const out = await readCandidate(workDir, '周报流水线')
      assert.ok(
        out.problems.some((p) => p.level === 'error' && p.message.includes('inline')),
        'inline 不是原语，要拦',
      )
      await cleanup(root)
    }
    // ④ 缺 workflow.json / 名字空
    {
      const { root, workDir } = await makeCandidate({ workflowJson: null })
      const out = await readCandidate(workDir, '周报流水线')
      assert.ok(out.problems.some((p) => p.level === 'error' && p.message.includes('workflow.json')))
      await cleanup(root)
    }
  })

  test('★ 数不清的引用只提示不拒；人数超软上限只提示', async () => {
    const { root, workDir } = await makeCandidate({
      mainJs: "const who = '写作员'\nawait agent(who).run('x')\n",
    })
    const out = await readCandidate(workDir, '周报流水线')
    assert.equal(out.problems.filter((p) => p.level === 'error').length, 0, '拼出来的引用不许被拒')
    assert.ok(out.problems.some((p) => p.level === 'warn' && p.message.includes('拼出来')))
    await cleanup(root)

    const many = await makeCandidate({
      mainJs: 'return 1\n',
      agents: Array.from({ length: AGENT_SOFT_LIMIT + 1 }, (_, i) => ({
        name: `人${i}`,
        instructions: '干活。',
      })),
    })
    const out2 = await readCandidate(many.workDir, '周报流水线')
    assert.equal(out2.problems.filter((p) => p.level === 'error').length, 0, '超人数不拒')
    assert.ok(out2.problems.some((p) => p.level === 'warn' && p.message.includes('拆成两条')))
    await cleanup(many.root)
  })

  test('★ 自带的技能：SKILL.md 缺 frontmatter 要拦', async () => {
    const { root, workDir } = await makeCandidate()
    const dir = join(workDir, 'workflow-draft', '周报流水线')
    await mkdir(join(dir, 'agents', '写作员', 'skills', '文风'), { recursive: true })
    await writeFile(join(dir, 'agents', '写作员', 'skills', '文风', 'SKILL.md'), '# 没有 frontmatter', 'utf8')
    const out = await readCandidate(workDir, '周报流水线')
    assert.ok(out.problems.some((p) => p.level === 'error' && p.message.includes('frontmatter')))
    assert.deepEqual(out.agents[0]?.skills, ['文风'], '技能名要列出来（缺 frontmatter 也算写了一次）')
    await cleanup(root)
  })

  test('★ 一个候选都没有 ⇒ 空数组（不是报错）', async () => {
    const root = await makeTempDir('wf-candidate-empty')
    await mkdir(join(root, 'chat-x'), { recursive: true })
    assert.deepEqual(await readCandidates(join(root, 'chat-x')), [])
    await cleanup(root)
  })

  test('★★ 代码检查的口径：同一名字用两次不算"数不清"', () => {
    const check = checkCandidateCode(
      "await agent('写作员').run('a')\nawait agent('写作员').run('b')\n",
      new Set(['写作员']),
    )
    assert.equal(check.unknownAgents.length, 0)
    assert.equal(check.unverifiable, 0, '字面量出现两次不是"拼出来的"')
    assert.equal(check.syntaxError, null)
  })
})
