import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { renderText, webText } from '@agentdeck/i18n'
import {
  PIPELINE_COLUMNS,
  formatRunStamp,
  runsForIssue,
  stageOf,
  stageShortId,
  type Stage,
  type StageInfo,
} from './pipeline.ts'
import type { Issue, RunSummary } from './api.ts'

/**
 * ★ `note` / `warning` 已经是**文案键**（D39），所以这里先把它们按中文渲染出来
 * 再断言——两件事一起被守住：
 *
 *   1. 场景推导（该不该给提示、给哪一条）；
 *   2. **那句话本身怎么写**（"没有派审核 —— 检查这个 agent 的「由谁来审它」"
 *      里必须点出"去哪儿改"，`由谁来审它` 就是这条断言的抓手）。词条写坏了，
 *      这里照样红。
 */
const note = (info: StageInfo): string | null =>
  info.noteId ? renderText(webText, info.noteId, 'zh') : null
const warn = (info: StageInfo): string | null =>
  info.warningId ? renderText(webText, info.warningId, 'zh', info.warningParams) : null

/**
 * 任务流水线的阶段推导。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这段逻辑为什么值得单独测
 * ══════════════════════════════════════════════════════════════════
 *
 * 它的边界情况（重试、执行失败、没配审核者）都**很难手动复现**——
 * 要真的跑失败、真的造一条重试链。而它们恰恰是最容易判错的地方。
 *
 * 尤其要紧的是那条**链**：审核 run 的 subject 是**执行 run 的 id**，
 * 不是 issue。按 issue 直接找 review run 会一条也找不到。那个 bug 我犯过一次。
 */

/*
 * ⚠️ 2026-11（D123）：这里原来是 `action()` 助手——一条动作记录的夹具
 * （`{status, type, error}` + `result` / `params` / `finishedAt`）。
 * 动作能力退场 ⇒ `RunSummary` 不再有 `action`，夹具随之删。
 */


function run(over: Partial<RunSummary> & { runId: string; kind: string }): RunSummary {
  return {
    status: 'completed',
    agentId: 'a1',
    subject: { type: 'issue', id: 'i1' },
    workDir: '/w',
    queuedAt: 1000,
    finishedAt: 2000,
    failureReason: null,
    chainDepth: 0,
    ...over,
    // ⚠️ `exactOptionalPropertyTypes` 下不能直接展开 `Partial<RunSummary>` 再返回：
    //    可选属性（`groupId?`）展开后会带上 `| undefined`，而 `groupId?: string | null`
    //    不接受**显式** undefined。夹具的职责是"补默认值 + 让调用方覆盖"，不是再演
    //    一遍可选属性的语义，所以这里断言一次收口（比给每个可选字段写 `?? null` 诚实）。
  } as RunSummary
}

const ISSUE = 'i1'

/**
 * 造一个"够 `stageOf` 用"的任务：它只关心 id 与 status。
 *
 * `status` 默认 `'todo'`——那是新建任务的默认状态（daemon 侧 `POST /api/issues`），
 * 也就是**未放弃**。所以下面那几十条只关心 run 推导的用例读起来跟以前一样，
 * 而"放弃"那几条显式传 `'cancelled'`。
 */
function task(id: string, status: Issue['status'] = 'todo'): Pick<Issue, 'id' | 'status'> {
  return { id, status }
}

describe('★ 阶段推导：只看"最新那次执行走到哪了"（D125 之后只有执行）', () => {
  test('一条执行 run 都没有 ⇒ 第一列（还没开始）', () => {
    const info = stageOf(task(ISSUE), [])
    assert.equal(info.stage, 'executing')
    assert.equal(info.executeRun, null)
    assert.equal(note(info), '还没开始执行', '标签是"执行中"，可它一次都没跑过')
    assert.equal(warn(info), null)
  })

  test('执行中 ⇒ 第一列', () => {
    const info = stageOf(task(ISSUE), [run({ runId: 'e1', kind: 'execute', status: 'running' })])
    assert.equal(info.stage, 'executing')
    assert.equal(info.executeRun?.runId, 'e1')
    assert.equal(note(info), null, '标签已经说了"执行中"，不要再重复')
  })

  test('★ 等目录释放时说清楚，而不是含糊的"进行中"', () => {
    const info = stageOf(task(ISSUE), [
      run({ runId: 'e1', kind: 'execute', status: 'waiting_local_directory' }),
    ])
    assert.equal(info.stage, 'executing')
    assert.equal(note(info), '排队中（工作目录被占用）')
  })

  test('★ 执行正常跑完 ⇒ 「已完成」', () => {
    const info = stageOf(task(ISSUE), [run({ runId: 'e1', kind: 'execute', status: 'completed' })])
    assert.equal(info.stage, 'done')
    assert.equal(info.executeRun?.runId, 'e1')
    assert.equal(note(info), null)
    assert.equal(warn(info), null)
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来是十来条围着**审核 run** 的用例——
   *   「执行完成、审核未跑 ⇒ 待审查 + 指出『没有派审核』」、「审核进行中 ⇒ 待审查」、
   *   「审核完成 ⇒ 已审查」、「needs_human ⇒ 待人工（不是已审查）」、
   *   「escalated 同样算待人工」、「人工判通过挂在审核 run / 执行 run 上」、
   *   「不是人工做的判决不许当成人工裁决」、「审核还没跑完仍是待审查」，
   *   以及「那条链：审核的 subject 是执行 run 的 id」与「重试：以最新那次为准」
   *   两整组。
   *
   *   审核 run 与判决一起退场 ⇒ 全部失去对象，整块删。
   *
   *   ⚠️ 两条教训仍然成立，值得留给以后任何"从记录推阶段"的场合：
   *   · **归属要顺着链走**：审核 run 的 subject 是执行 run 的 id，不是 issue——
   *     按 issue 直接找会一条也找不到（那个 bug 犯过一次）；
   *   · **"还在做"与"做完了"必须长得不一样**：D40 那场事故的本质是判决一产出就
   *     显示成"已审查"，而动作还在跑。
   */

  test('★ 重试：以**最新**那次执行为锚点（旧的跑完、新的在跑 ⇒ 不是已完成）', () => {
    const info = stageOf(task(ISSUE), [
      run({ runId: 'e1', kind: 'execute', status: 'completed', queuedAt: 1000 }),
      run({ runId: 'e2', kind: 'execute', status: 'running', queuedAt: 2000 }),
    ])
    assert.equal(info.stage, 'executing')
    assert.equal(info.executeRun?.runId, 'e2')
  })

  test('★ 别的 issue 的执行 run 不参与', () => {
    const info = stageOf(task(ISSUE), [
      run({ runId: 'x1', kind: 'execute', subject: { type: 'issue', id: 'other' } }),
    ])
    assert.equal(info.stage, 'executing')
    assert.equal(info.executeRun, null)
  })
})

describe('★ 失败的执行要说清为什么（不能静静躺在"已完成"里）', () => {
  test('★ 执行失败 ⇒ 「失败」+ 明确的失败提示', () => {
    const info = stageOf(task(ISSUE), [
      run({
        runId: 'e1',
        kind: 'execute',
        status: 'failed',
        failureReason: 'cli 退出码 127（command not found）',
      }),
    ])
    assert.equal(info.stage, 'failed')
    assert.match(warn(info) ?? '', /执行失败了/)
    // ★ 原因要**带上**：只说"执行失败了"，人还得再去翻一次日志。
    assert.match(warn(info) ?? '', /command not found/)
  })

  test('被取消的执行说"被取消"，不说"失败"', () => {
    const info = stageOf(task(ISSUE), [
      run({ runId: 'e1', kind: 'execute', status: 'cancelled', failureReason: 'cancelled_by_user' }),
    ])
    assert.equal(info.stage, 'failed')
    assert.match(warn(info) ?? '', /执行被取消了/)
    assert.doesNotMatch(warn(info) ?? '', /执行失败了/)
  })

  /*
   * ⚠️ 2026-11（D125）：这里原来还有「执行成功但没派审核时，提示的是『没派审核』
   *   而不是『失败』」——`coverageWarning` 那一档。审核退场 ⇒ "没配审核者"不再
   *   是配置问题，用例删。
   */
})

describe('两列的定义', () => {
  test('★ 顺序就是流水线方向：进行中在已结束之前', () => {
    assert.deepEqual(
      PIPELINE_COLUMNS.map((c) => c.ids[0]),
      ['executing', 'done'],
    )
  })

  test('★ 每一档 stage **一个不漏**地落在某一列里（否则那一档的任务会凭空消失）', () => {
    const all: Stage[] = ['executing', 'done', 'failed', 'abandoned']
    for (const stage of all) {
      const cols = PIPELINE_COLUMNS.filter((c) => c.ids.includes(stage))
      assert.equal(cols.length, 1, `${stage} 该恰好落在一列里（实得 ${cols.length}）`)
    }
  })

  test('★ 「已结束」列同时收 done / failed / abandoned（三种都不再动了）', () => {
    const finished = PIPELINE_COLUMNS.find((c) => c.ids[0] === 'done')
    assert.ok(finished)
    for (const stage of ['done', 'failed', 'abandoned'] as const) {
      assert.ok(finished.ids.includes(stage), `${stage} 该在「已结束」列里`)
    }
  })

  test('每列各有标题与说明', () => {
    for (const col of PIPELINE_COLUMNS) {
      assert.notEqual(renderText(webText, col.titleId, 'zh'), col.titleId)
      assert.notEqual(renderText(webText, col.hintId, 'zh'), col.hintId)
    }
  })
})

describe('★ 任务名下的 run（D125 之后只有执行 run）', () => {
  test('按 issue 收执行 run，按时间先后排（最早的在前）', () => {
    const list = runsForIssue(ISSUE, [
      run({ runId: 'e2', kind: 'execute', queuedAt: 2000 }),
      run({ runId: 'e1', kind: 'execute', queuedAt: 1000 }),
    ])
    assert.deepEqual(
      list.map((r) => r.runId),
      ['e1', 'e2'],
    )
  })

  test('★ 排序是稳定的：同一毫秒入队的两条也有确定次序', () => {
    const list = runsForIssue(ISSUE, [
      run({ runId: 'b', kind: 'execute', queuedAt: 1000 }),
      run({ runId: 'a', kind: 'execute', queuedAt: 1000 }),
    ])
    assert.deepEqual(
      list.map((r) => r.runId),
      ['a', 'b'],
    )
  })

  test('formatRunStamp：今天只写时分秒，跨天带上月日', () => {
    const now = new Date(2026, 10, 2, 12, 0, 0).getTime()
    const today = new Date(2026, 10, 2, 9, 5, 7).getTime()
    assert.equal(formatRunStamp(today, now), '09:05:07')
    const older = new Date(2026, 9, 28, 9, 5, 0).getTime()
    assert.equal(formatRunStamp(older, now), '10/28 09:05')
  })

  test('别的 issue 的执行 run 不参与', () => {
    const list = runsForIssue(ISSUE, [
      run({ runId: 'x1', kind: 'execute', subject: { type: 'issue', id: 'other' } }),
    ])
    assert.deepEqual(list, [])
  })

  test('没有任何 run ⇒ 空数组（详情里显示"还没有执行过"）', () => {
    assert.deepEqual(runsForIssue(ISSUE, []), [])
  })

  test('★ `kind: review` 的老记录**不进**任务时间线', () => {
    // 老库里还躺着那种 run（subject 是执行 run 的 id）。它们不再是这个任务的时间线
    // 的一部分——时间线回答的是"这条任务被执行过几次"。
    const list = runsForIssue(ISSUE, [
      run({ runId: 'e1', kind: 'execute', queuedAt: 1000 }),
      run({ runId: 'r1', kind: 'review', queuedAt: 1500, subject: { type: 'run', id: 'e1' } }),
    ])
    assert.deepEqual(
      list.map((r) => r.runId),
      ['e1'],
    )
  })
})

describe('★ 短标签覆盖每个阶段，且够短（表格里要显示它）', () => {
  test('短标签覆盖每个阶段，且够短（表格里要显示它）', () => {
    for (const stage of PIPELINE_COLUMNS.flatMap((c) => [...c.ids])) {
      const id = stageShortId(stage)
      const zh = renderText(webText, id, 'zh')
      const en = renderText(webText, id, 'en')
      assert.notEqual(zh, id, `短标签词条缺失：${id}`)
      assert.ok(zh.length <= 5, `中文短标签别太长：${zh}`)
      assert.ok(en.length <= 14, `英文短标签别太长：${en}`)
    }
  })
})

describe('★ note：只给标签之外的信息（去掉重复字样）', () => {
  const noteOf = (over: Partial<RunSummary> & { runId: string; kind: string }): string | null =>
    note(stageOf(task(ISSUE), [run(over)]))

  test('★ 执行中（真的在跑）⇒ note 为空；排队中 ⇒ 说清是排队', () => {
    assert.equal(noteOf({ runId: 'e1', kind: 'execute', status: 'running' }), null)
    assert.equal(
      noteOf({ runId: 'e1', kind: 'execute', status: 'waiting_local_directory' }),
      '排队中（工作目录被占用）',
    )
  })

  test('★ 一次都没跑过 ⇒ note 说「还没开始执行」（否则标签会说谎）', () => {
    assert.equal(note(stageOf(task(ISSUE), [])), '还没开始执行')
  })

  test('★ 已完成 / 已放弃 ⇒ note 为空', () => {
    assert.equal(noteOf({ runId: 'e1', kind: 'execute', status: 'completed' }), null)
    const abandoned = stageOf(task(ISSUE, 'cancelled'), [
      run({ runId: 'e1', kind: 'execute', status: 'running' }),
    ])
    assert.equal(note(abandoned), null)
  })

  test('★ 没有 `detail` 这个字段：同一句话只准有一个出处', () => {
    // 使用者说「『待审查』下面『等待审核』重复了」。把界面上那句撤掉之后
    // 才发现 `detail` 在前端**一个消费者都没有**（看板列头用的是列定义里的
    // 静态 `col.hint`，卡片读的是 `note`）。它剩下唯一的作用，就是把刚被
    // 点掉的那句话继续养在数据层，等着哪次改动顺手渲染出来、重复原样长回来。
    //
    // 所以这里断言它**不存在**——这条断言就是防复发的闸门。（与
    // `RunSummary.lastSeq` 被删掉时留下的那两条断言同一个思路。）
    const info = stageOf(task(ISSUE), [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
    ])
    assert.equal(
      Object.hasOwn(info, 'detail'),
      false,
      '阶段说明只留 `note`；再加一个同义字段就等于把重复放回来',
    )
    assert.deepEqual(
      Object.keys(info).sort(),
      // D39 起 `note`/`warning` 是**文案键**（`noteId`/`warningId`）；
      // 这条断言的用意没变：**只有这两个出处，不许再多一个同义字段**。
      //
      // `warningParams` 不算第三个出处——它是 `warningId` 那句话的**插值**，
      // 自己不成句；所以它单独列在这里。
      // ⚠️ 2026-11（D123/D124）：`action`（"这次到底做了什么"）与 `reworked`
      //   （"返工 N 次"）都随各自的能力退场删了。
      // ⚠️ 2026-11（D125）：`reviewRun`（正在跑/已完成的审核 run）也删了——
      //   审核 run 退场。
      // `warningParams` 在**没有警告**时不出现（那条 run 是 `done`，没有需要
      // 插值的话）——它是警告的插值，不是第四个出处，所以这里不列它。
      ['executeRun', 'noteId', 'stage', 'warningId'],
    )
  })
})

describe('★ 放弃：任务级事实盖过一切由 run 推出来的阶段（D47）', () => {
  test('★ 放弃的任务一律是「已放弃」，与它卡在哪一档无关', () => {
    const cases: Array<[string, RunSummary[]]> = [
      ['一条都没有', []],
      ['正在跑', [run({ runId: 'e1', kind: 'execute', status: 'running' })]],
      ['跑完了', [run({ runId: 'e1', kind: 'execute', status: 'completed' })]],
      ['跑砸了', [run({ runId: 'e1', kind: 'execute', status: 'failed' })]],
    ]
    for (const [label, runs] of cases) {
      const info = stageOf(task(ISSUE, 'cancelled'), runs)
      assert.equal(info.stage, 'abandoned', `${label} 时也该是「已放弃」`)
      // 提示与警告都要清掉：放弃过的任务不该再进"需要你介入"那一拨
      assert.equal(info.warningId, null, `${label}：放弃之后不该再报警`)
      assert.equal(note(info), null, `${label}：放弃之后不该再提示"还没开始"`)
    }
  })

  test('★ 放弃不会丢掉 run 的事实（详情页还要用它）', () => {
    const info = stageOf(task(ISSUE, 'cancelled'), [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
    ])
    assert.equal(info.executeRun?.runId, 'e1', '锚点那条 run 还在')
  })

  test('★ 未放弃时（`todo`）推导结果与 D47 之前完全相同', () => {
    const runs = [run({ runId: 'e1', kind: 'execute', status: 'completed' })]
    assert.deepEqual(stageOf(task(ISSUE, 'todo'), runs), stageOf(task(ISSUE, 'in_progress'), runs))
  })
})
