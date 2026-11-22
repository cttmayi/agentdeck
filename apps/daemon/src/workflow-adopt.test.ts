import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { adoptCandidate } from './workflow-adopt.ts'
import type { WorkspaceId } from '@agentdeck/protocol'

/**
 * **把候选编排收进库**（2026-11，D255）。
 *
 * 使用者：「在聊天的工作目录生成存储的格式，等人点确认后再入库」——
 * 所以入库那一支只做"校验 + 整目录搬 + 补字段"，没有中间格式。这条测试钉：
 *   ① 搬完之后**库里那条的形状**对（`workflow.json` 不含代码/不含内建人清单，
 *      代码在 `main.js`，内建人在 `agents/<名字>/`，含他自带的技能）；
 *   ② `source: 'ai'` / `apiVersion` / `origin` 三项补上了（生成来源是事实，要落盘）；
 *   ③ 覆盖 = 原地替换（id 不变、旧的人被删掉）；校验不过 = 一条都不写。
 */

const WS = '01WSD255ADOPT00000000000001' as unknown as WorkspaceId

/** 铺一个候选（工作目录 → `workflow-draft/<名字>/`）。 */
async function staging(root: string): Promise<{ workDir: string; dataDir: string }> {
  const workDir = join(root, 'chat-x')
  const dataDir = join(root, 'data')
  const dir = join(workDir, 'workflow-draft', '周报流水线')
  const agent = join(dir, 'agents', '写作员')
  await mkdir(join(agent, 'skills', '文风'), { recursive: true })
  await writeFile(
    join(dir, 'workflow.json'),
    JSON.stringify({ name: '周报流水线', summary: '取数→成稿→你过目' }),
    'utf8',
  )
  await writeFile(
    join(dir, 'main.js'),
    "const 写作 = agent('写作员')\nconst r = await flow([写作], '{{task}}')\nreturn r.message\n",
    'utf8',
  )
  await writeFile(join(agent, 'agent.json'), JSON.stringify({ name: '写作员' }), 'utf8')
  await writeFile(join(agent, 'instructions.md'), '你是写作员：按要点写周报。', 'utf8')
  await writeFile(
    join(agent, 'skills', '文风', 'SKILL.md'),
    '---\nname: 文风\ndescription: 这个人的文风要求\n---\n\n短句为主。\n',
    'utf8',
  )
  await mkdir(dataDir, { recursive: true })
  return { workDir, dataDir }
}

describe('入库：候选 → workflows/<id>/', () => {
  test('★★ 搬库后的形状：json 不含代码/不含人清单，代码在 main.js，人在 agents/，技能跟着搬', async () => {
    const root = await makeTempDir('wf-adopt')
    const { workDir, dataDir } = await staging(root)
    const out = await adoptCandidate({
      dataDir,
      workDir,
      dir: '周报流水线',
      workspaceId: WS,
      conversationId: 'conv-1',
      apiVersion: 'v5',
      now: 1_700_000_000_000,
    })
    assert.equal(out.ok, true, JSON.stringify(out))
    if (!out.ok) return

    const wfDir = join(dataDir, 'workflows', out.workflow.id)
    const json = JSON.parse(await readFile(join(wfDir, 'workflow.json'), 'utf8')) as Record<string, unknown>
    assert.equal(json['name'], '周报流水线')
    assert.equal(json['summary'], '取数→成稿→你过目')
    assert.equal(json['source'], 'ai')
    assert.equal(json['apiVersion'], 'v5')
    assert.equal(json['origin'], 'conversation:conv-1')
    assert.equal(json['code'], undefined, 'workflow.json 不许存代码（D234：目录是真相）')
    assert.equal(json['inlineAgents'], undefined, 'workflow.json 不许存内建人清单')

    const code = await readFile(join(wfDir, 'main.js'), 'utf8')
    assert.ok(code.includes("agent('写作员')"), '代码原样搬过去')

    const agentFiles = await readdir(join(wfDir, 'agents'))
    assert.deepEqual(agentFiles, ['写作员'], '内建智能体目录名 = 名字（允许中文）')
    const agentBase = join(wfDir, 'agents', '写作员')
    const agentJson = JSON.parse(await readFile(join(agentBase, 'agent.json'), 'utf8')) as Record<string, unknown>
    assert.equal(agentJson['name'], '写作员')
    assert.deepEqual(agentJson['skillIds'], [], '内建智能体不挂外围技能（使用者拍板）')
    assert.equal(agentJson['runtimeKey'], 'default')
    assert.equal(typeof agentJson['id'], 'string', '每个内建人补一个 id（身份）')
    assert.ok((await readFile(join(agentBase, 'instructions.md'), 'utf8')).includes('周报'))
    assert.ok(
      existsSync(join(agentBase, 'skills', '文风', 'SKILL.md')),
      '自生成的技能跟着搬过去',
    )
    await cleanup(root)
  })

  test('★★ 覆盖：id 不变、旧的内建人被删掉（整份替换）', async () => {
    const root = await makeTempDir('wf-adopt-overwrite')
    const { workDir, dataDir } = await staging(root)
    const first = await adoptCandidate({
      dataDir,
      workDir,
      dir: '周报流水线',
      workspaceId: WS,
      conversationId: 'conv-1',
    })
    assert.equal(first.ok, true)
    if (!first.ok) return

    // 候选改成"只有审稿员"（把写作员从**暂存目录**里也删掉——候选就是那个目录的全部内容），
    // 然后覆盖
    const dir = join(workDir, 'workflow-draft', '周报流水线')
    await rm(join(dir, 'agents', '写作员'), { recursive: true, force: true })
    await writeFile(join(dir, 'main.js'), "await agent('审稿员').run('x')\n", 'utf8')
    await mkdir(join(dir, 'agents', '审稿员'), { recursive: true })
    await writeFile(join(dir, 'agents', '审稿员', 'agent.json'), JSON.stringify({ name: '审稿员' }), 'utf8')
    await writeFile(join(dir, 'agents', '审稿员', 'instructions.md'), '你挑毛病。', 'utf8')

    const second = await adoptCandidate({
      dataDir,
      workDir,
      dir: '周报流水线',
      workspaceId: WS,
      conversationId: 'conv-1',
      existingId: first.workflow.id,
    })
    assert.equal(second.ok, true, JSON.stringify(second))
    if (!second.ok) return
    assert.equal(second.workflow.id, first.workflow.id, '覆盖时 id 不变（引用不失效）')
    const agentDirs = await readdir(join(dataDir, 'workflows', second.workflow.id, 'agents'))
    assert.deepEqual(agentDirs, ['审稿员'], '旧的人（写作员）被整份替换掉')
    await cleanup(root)
  })

  test('★ 校验不过 ⇒ 一条都不写（不留半个目录）', async () => {
    const root = await makeTempDir('wf-adopt-invalid')
    const { workDir, dataDir } = await staging(root)
    await writeFile(
      join(workDir, 'workflow-draft', '周报流水线', 'main.js'),
      "await agent('不存在的人').run('x')\n",
      'utf8',
    )
    const out = await adoptCandidate({
      dataDir,
      workDir,
      dir: '周报流水线',
      workspaceId: WS,
      conversationId: 'conv-1',
    })
    assert.equal(out.ok, false)
    if (out.ok) return
    assert.equal(out.reason, 'invalid')
    assert.ok(out.candidate.problems.some((p) => p.level === 'error' && p.message.includes('不存在的人')))
    assert.equal(existsSync(join(dataDir, 'workflows')), false, '拒绝了就不该建出 workflows/')
    await cleanup(root)
  })
})
