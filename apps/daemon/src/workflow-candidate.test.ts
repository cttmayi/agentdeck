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

describe('资料落盘（material）', () => {
  test('★★ 覆盖写：第二次落盘是新版，且只换这一包', async () => {
    const root = await makeTempDir('material-seed')
    const workDir = join(root, 'work')
    await mkdir(workDir, { recursive: true })

    assert.equal(await seedMaterial({ workDir, pack: 'orchestration' }), true)
    const target = join(workDir, MATERIAL_DIR)
    const api = await readFile(join(target, 'orchestration/api.md'), 'utf8')
    assert.ok(api.includes('agent'), '资料里要有原语说明')
    const index = await readFile(join(target, 'README.md'), 'utf8')
    assert.ok(index.includes('orchestration'), '索引里要写清这次是哪一包')

    // 覆盖写：把资料里的文件改花，再落一次 ⇒ 回到仓库那份（不是追加、不是"保留使用者改动"）
    await writeFile(join(target, 'orchestration/api.md'), '被改花了', 'utf8')
    assert.equal(await seedMaterial({ workDir, pack: 'orchestration' }), true)
    const again = await readFile(join(target, 'orchestration/api.md'), 'utf8')
    assert.equal(again, api, '第二批落盘把上一版整份换掉')

    // 只换这一包：另一包的目录不受影响
    await seedMaterial({ workDir, pack: 'agent' })
    assert.ok(existsSync(join(target, 'agent/README.md')), 'agent 包也在')
    assert.ok(existsSync(join(target, 'orchestration/api.md')), 'orchestration 包还在（没被删）')
    await cleanup(root)
  })

  test('★ 哪一类生成者读哪一包；普通对话不落', () => {
    assert.equal(materialPackForSlot('workflow-maker'), 'orchestration')
    assert.equal(materialPackForSlot('agent-maker'), 'agent')
    // 起草者的素材归沉淀那条链（`crystallize-material.ts`），不在这里发
    assert.equal(materialPackForSlot('drafter'), null)
    assert.equal(materialPackForSlot('memory-tidy'), null)
    assert.equal(materialPackForSlot(null), null)
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
