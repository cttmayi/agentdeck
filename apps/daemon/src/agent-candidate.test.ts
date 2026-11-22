import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { readAgentCandidate, readAgentCandidates } from './agent-candidate.ts'

/**
 * **候选智能体预检**（2026-11，D256）。
 *
 * 与候选编排同一张图纸：产物写成存储形状（`agent-draft/<岗位名>/`），平台读它、校验它，
 * 界面据此画卡片。判据的选择理由：
 *   · **确定错的一定拒**：缺正文 / 名字不合法 / 技能 frontmatter 缺项 / 技能名不是 kebab-case
 *     —— 这些到了落库那一步只会换成一句更难懂的错误；
 *   · **正常形态一律放行**：没有 `agent.json`（名字 = 目录名）、没有 `skills/`（0 条配套技能）
 *     都是合法写法，不许拦（"不值得抽就 0 条"是使用者拍板的口径）。
 */

/** 铺一个候选；`mutate` 里给 `null` 表示"这个文件不要"。 */
async function makeCandidate(mutate: {
  dir?: string
  agentJson?: string | null
  instructions?: string | null
  skills?: Array<{ name: string; body: string | null }>
} = {}): Promise<{ root: string; workDir: string; dir: string }> {
  const root = await makeTempDir('agent-candidate')
  const workDir = join(root, 'chat-x')
  const dir = mutate.dir ?? '会议纪要助理'
  const base = join(workDir, 'agent-draft', dir)
  await mkdir(base, { recursive: true })
  const json = mutate.agentJson === undefined ? JSON.stringify({ name: dir, runtimeKey: 'default' }) : mutate.agentJson
  if (json !== null) await writeFile(join(base, 'agent.json'), json, 'utf8')
  const instructions = mutate.instructions === undefined ? '你是会议纪要助理。\n\n## 边界（不能碰）\n- 只在工作目录写。\n' : mutate.instructions
  if (instructions !== null) await writeFile(join(base, 'instructions.md'), instructions, 'utf8')
  for (const s of mutate.skills ?? []) {
    await mkdir(join(base, 'skills', s.name), { recursive: true })
    if (s.body !== null) await writeFile(join(base, 'skills', s.name, 'SKILL.md'), s.body, 'utf8')
  }
  return { root, workDir, dir }
}

const GOOD_SKILL = [
  '---',
  'name: meeting-notes-format',
  'description: 会议纪要的固定形状（探针）',
  '---',
  '',
  '# 纪要格式',
  '',
  '结论 → 待办 → 未决。',
].join('\n')

describe('候选智能体预检（agent-candidate）', () => {
  test('★ 正常形态：没有 agent.json 也可以（名字 = 目录名），没有配套技能也可以', async () => {
    const { root, workDir, dir } = await makeCandidate({ agentJson: null })
    const out = await readAgentCandidate(workDir, dir)
    assert.equal(out.name, dir)
    assert.equal(out.runtimeKey, 'default')
    assert.deepEqual(out.skills, [])
    assert.equal(out.problems.filter((p) => p.level === 'error').length, 0, JSON.stringify(out.problems))
    assert.ok(out.instructionsChars > 0)
    assert.ok(out.absDir.endsWith(`agent-draft/${dir}`))
    await cleanup(root)
  })

  test('★★ 四条硬错各拒一条：缺正文 / 名字与目录不一致 / 技能缺 frontmatter / 技能名不是 kebab', async () => {
    {
      const { root, workDir, dir } = await makeCandidate({ instructions: null })
      const out = await readAgentCandidate(workDir, dir)
      assert.ok(out.problems.some((p) => p.level === 'error' && p.message.includes('instructions.md')))
      await cleanup(root)
    }
    {
      const { root, workDir, dir } = await makeCandidate({ agentJson: JSON.stringify({ name: '别的名字' }) })
      const out = await readAgentCandidate(workDir, dir)
      assert.ok(out.problems.some((p) => p.level === 'error' && p.message.includes('两者要一致')))
      await cleanup(root)
    }
    {
      const { root, workDir, dir } = await makeCandidate({
        skills: [{ name: 'meeting-notes-format', body: '# 没有 frontmatter' }],
      })
      const out = await readAgentCandidate(workDir, dir)
      assert.ok(out.problems.some((p) => p.level === 'error' && p.message.includes('frontmatter')))
      await cleanup(root)
    }
    {
      const { root, workDir, dir } = await makeCandidate({
        skills: [
          {
            name: '纪要格式',
            body: '---\nname: 纪要格式\ndescription: 中文名字\n---\n\n正文。\n',
          },
        ],
      })
      const out = await readAgentCandidate(workDir, dir)
      assert.ok(out.problems.some((p) => p.level === 'error' && p.message.includes('kebab-case')))
      await cleanup(root)
    }
  })

  test('★ 合格的配套技能会被列出来（名字 / 描述 / 正文）', async () => {
    const { root, workDir, dir } = await makeCandidate({
      skills: [{ name: 'meeting-notes-format', body: GOOD_SKILL }],
    })
    const out = await readAgentCandidate(workDir, dir)
    assert.equal(out.problems.filter((p) => p.level === 'error').length, 0, JSON.stringify(out.problems))
    assert.equal(out.skills.length, 1)
    assert.equal(out.skills[0]?.name, 'meeting-notes-format')
    assert.ok((out.skills[0]?.description ?? '').includes('会议纪要'))
    await cleanup(root)
  })

  test('★ 一个候选都没有 ⇒ 空数组（不是报错）', async () => {
    const root = await makeTempDir('agent-candidate-empty')
    await mkdir(join(root, 'chat-x'), { recursive: true })
    assert.deepEqual(await readAgentCandidates(join(root, 'chat-x')), [])
    await cleanup(root)
  })
})
