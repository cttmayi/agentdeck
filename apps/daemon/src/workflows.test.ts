import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  WORKFLOW_TEMPLATES,
  checkReviewable,
  legacyWorkflowRunsPath,
  legacyWorkflowsPath,
  loadWorkflowRuns,
  loadWorkflows,
  removeWorkflow,
  saveWorkflow,
  saveWorkflowRun,
  workflowDirPath,
} from './workflows.ts'
import type { Workflow, WorkflowRun } from './workflows.ts'

/**
 * 编排存储/模板测试（引擎测试在 @agentdeck/orchestration 包内——
 * 那里的 15 个用例覆盖惰性/嵌套/Reply/超轮/位置检查/幂等）。
 *
 * ★ 测试临时目录必须建在仓库内 `.cache/test-tmp`（硬约束：测试不许用系统 tmpdir）。
 */
const TMP = join(process.cwd(), '.cache', 'test-tmp', `workflows-${process.pid}`)

function freshRun(): WorkflowRun {
  return {
    id: 'run-1',
    issueId: 'iss-1',
    workflowId: 'wf-1',
    workDir: null,
    status: 'queued',
    steps: [],
    gateFeedback: null,
    taskAppend: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

test('★ 模板清单：换成"真实场景"那一批（UI「从模板」入口的数据源）', () => {
  /*
   * ⚠️ 2026-11 使用者："『单组流程…人机把关』这些都是简单编排，并没有实际用途" ⇒ 七个
   *   语法演示模板换成五个真实场景。这条原来钉的是旧 key 列表，现在钉新的一批——
   *   更细的质量关（语法是否合法 / 有没有退场写法 / summary 是否齐全）在
   *   `workflow-templates.test.ts` 里逐条量。
   */
  const keys = WORKFLOW_TEMPLATES.map((t) => t.key)
  for (const k of ['weekly-report', 'review-rework', 'research-brief', 'batch-refactor', 'release-check']) {
    assert.ok(keys.includes(k), `模板 ${k} 必须存在`)
  }
  // 模板代码用 v5 原语（agent 句柄 + flow/parallel/loop/route），并且都有人放行的写法
  const loopTpl = WORKFLOW_TEMPLATES.find((t) => t.key === 'review-rework')!
  assert.match(loopTpl.code, /agent\(/)
  assert.match(loopTpl.code, /loop\(/)
  assert.ok(WORKFLOW_TEMPLATES.some((t) => t.code.includes('reuseOutput')), '至少一条用人放行')
})

/** 一条编排夹具（字段与 `Workflow` 一致；代码里那句是**它自己**的标记，便于断言落点）。 */
function freshWorkflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    workspaceId: 'ws-1' as never,
    name: '测试编排',
    code: 'await flow([agent("A")], "{{task}}")',
    source: 'manual',
    templateKey: null,
    inlineAgents: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

test('★★ 编排落成目录：结构化进 workflow.json（**不含代码**）、代码进 main.js', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflow(TMP, freshWorkflow())

  // 目录形状：<dataDir>/workflows/<id>/
  const json = await readFile(join(workflowDirPath(TMP, 'wf-1'), 'workflow.json'), 'utf8')
  const structured = JSON.parse(json) as Record<string, unknown>
  assert.equal(structured['name'], '测试编排')
  assert.equal(structured['id'], 'wf-1')
  /*
   * ★ 这一条是这次改存储的**核心判据**：代码不再塞进 json 的字符串里。
   *   塞进去的话，"看代码"这件事就只能在界面里做（json 里那串 `\n` 没法读）。
   */
  assert.equal('code' in structured, false, 'workflow.json 里不许出现 code')

  const code = await readFile(join(workflowDirPath(TMP, 'wf-1'), 'main.js'), 'utf8')
  assert.match(code, /await flow/)

  // 读回：两份拼成一条完整记录
  const loaded = await loadWorkflows(TMP)
  assert.equal(loaded.errors.length, 0)
  assert.equal(loaded.workflows.length, 1)
  assert.equal(loaded.workflows[0]!.name, '测试编排')
  assert.match(loaded.workflows[0]!.code, /await flow/)
})

test('★ 删一条编排 = 删它自己的目录（不牵连别的）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflow(TMP, freshWorkflow({ id: 'wf-a', name: '甲', createdAt: 1 }))
  await saveWorkflow(TMP, freshWorkflow({ id: 'wf-b', name: '乙', createdAt: 2 }))
  await removeWorkflow(TMP, 'wf-a')
  const loaded = await loadWorkflows(TMP)
  assert.deepEqual(
    loaded.workflows.map((w) => w.id),
    ['wf-b'],
  )
})

test('★★ 一条坏掉**不毁全部**，而且要报出来（旧的"读成空数组"已删）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflow(TMP, freshWorkflow({ id: 'wf-ok', name: '好的', createdAt: 1 }))
  // 造一条坏的：目录在、workflow.json 是坏 JSON
  const badDir = workflowDirPath(TMP, 'wf-bad')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(badDir, { recursive: true })
  await writeFile(join(badDir, 'workflow.json'), '{坏', 'utf8')

  const loaded = await loadWorkflows(TMP)
  assert.deepEqual(
    loaded.workflows.map((w) => w.id),
    ['wf-ok'],
    '好的那条照常读出来',
  )
  assert.equal(loaded.errors.length, 1, '坏的那条必须报一条错误')
  assert.match(loaded.errors[0]!, /wf-bad/)
})

test('★★ 缺 main.js：这条**照样列出**（代码空），但要说出来', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflow(TMP, freshWorkflow({ id: 'wf-x', name: '代码丢了' }))
  await rm(join(workflowDirPath(TMP, 'wf-x'), 'main.js'))
  const loaded = await loadWorkflows(TMP)
  /*
   * ★ 为什么不是"跳过它"：跳过 = 使用者在编排页看到"我那条没了"，而真相是
   *   "代码文件被删了、标题还在"。列出来他才知道该把代码贴回去。
   */
  assert.equal(loaded.workflows.length, 1)
  assert.equal(loaded.workflows[0]!.code, '')
  assert.equal(loaded.errors.length, 1)
  assert.match(loaded.errors[0]!, /main\.js/)
})

test('★ 运行实例：一条一个文件（`workflow-runs/<runId>.json`）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflowRun(TMP, freshRun())
  const files = await readdir(join(TMP, 'workflow-runs'))
  assert.deepEqual(files, ['run-1.json'])
  const loaded = await loadWorkflowRuns(TMP)
  assert.equal(loaded.errors.length, 0)
  assert.equal(loaded.runs.length, 1)
  assert.equal(loaded.runs[0]!.id, 'run-1')
})

test('★★ 老的两个大 JSON 一次迁进目录；老文件改名留档、不删', async () => {
  await rm(TMP, { recursive: true, force: true })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(TMP, { recursive: true })
  await writeFile(
    legacyWorkflowsPath(TMP),
    JSON.stringify([freshWorkflow({ id: 'old-1', name: '老编排' })]),
    'utf8',
  )
  await writeFile(legacyWorkflowRunsPath(TMP), JSON.stringify([freshRun()]), 'utf8')

  const first = await loadWorkflows(TMP)
  assert.equal(first.migrated?.migrated, 1)
  assert.equal(first.workflows.length, 1)
  assert.equal(first.workflows[0]!.name, '老编排')
  assert.match(first.workflows[0]!.code, /await flow/, '代码也迁过去了（在 main.js 里）')

  // 老文件改名留档：原名不再存在（否则下次启动会再迁一次）
  await assert.rejects(() => readFile(legacyWorkflowsPath(TMP), 'utf8'))
  const archived = await readFile(`${legacyWorkflowsPath(TMP)}.migrated`, 'utf8')
  assert.match(archived, /老编排/)

  const runs = await loadWorkflowRuns(TMP)
  assert.equal(runs.migrated?.migrated, 1)
  assert.equal(runs.runs.length, 1)

  // ★ 幂等：再跑一次不重复迁、也不报错
  const second = await loadWorkflows(TMP)
  assert.equal(second.migrated, null, '老文件已经归档 ⇒ 这次不迁')
  assert.equal(second.workflows.length, 1)
})

test('★ 老文件是坏的 JSON：报错、且**不改名不删**（迁移不许掩盖坏数据）', async () => {
  await rm(TMP, { recursive: true, force: true })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(TMP, { recursive: true })
  await writeFile(legacyWorkflowsPath(TMP), '{坏', 'utf8')
  const loaded = await loadWorkflows(TMP)
  assert.equal(loaded.migrated?.errors.length, 1)
  assert.equal(loaded.workflows.length, 0)
  // 原样还在（人还能自己去修/去救）
  assert.equal(await readFile(legacyWorkflowsPath(TMP), 'utf8'), '{坏')
})

/* ══════════════════════════════════════════════════════════════════
 * 审核前置判据（真机缺陷固化：拿失败 run 去审）
 * ══════════════════════════════════════════════════════════════════ */

test('★★ 被审 run 没跑成 ⇒ 不提交审核（错误带状态与失败原因）', () => {
  const verdict = checkReviewable(
    { status: 'failed', failureMessage: 'codex 对话阶段失败：thread/resume 超时' },
    '有产出也没用——这条 run 自己失败了',
  )
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.error : '', /没有正常完成/)
  assert.match(verdict.ok === false ? verdict.error : '', /thread\/resume/, '失败原因带出来')
})

test('★★ 跑完但零产出 ⇒ 不提交审核（模型端空响应不能当成"没什么可挑的"）', () => {
  const blank = checkReviewable({ status: 'completed' }, '  \n\t ')
  assert.equal(blank.ok, false)
  assert.match(blank.ok === false ? blank.error : '', /没有产出/)
})

test('★ 跑完且有产出 ⇒ 放行', () => {
  assert.equal(checkReviewable({ status: 'completed' }, '文章正文').ok, true)
})
