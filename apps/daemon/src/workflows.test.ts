import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  WORKFLOW_TEMPLATES,
  checkReviewable,
  loadWorkflowRuns,
  loadWorkflows,
  saveWorkflowRuns,
  saveWorkflows,
} from './workflows.ts'
import type { WorkflowRun } from './workflows.ts'

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

test('★ 编排存储往返（save → load）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflows(TMP, [
    {
      id: 'wf-1',
      workspaceId: 'ws-1' as never,
      name: '测试编排',
      code: 'await flow([agent("A")], "{{task}}")',
      source: 'manual',
      templateKey: null,
      inlineAgents: [],
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  const loaded = await loadWorkflows(TMP)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.name, '测试编排')
})

test('★ 运行实例存储往返（save → load）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflowRuns(TMP, [freshRun()])
  const loaded = await loadWorkflowRuns(TMP)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.id, 'run-1')
})

test('★ 坏 JSON 不炸（读成空数组）', async () => {
  await rm(TMP, { recursive: true, force: true })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(TMP, { recursive: true })
  await writeFile(join(TMP, 'workflows.json'), '{坏', 'utf8')
  const loaded = await loadWorkflows(TMP)
  assert.deepEqual(loaded, [])
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
