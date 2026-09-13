import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  PIPELINE_COLUMNS,
  STAGE_SHORT,
  formatRunStamp,
  runsForIssue,
  splitByAttention,
  stageOf,
} from './pipeline.ts'
import type { RunSummary } from './api.ts'

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
  }
}

const ISSUE = 'i1'

describe('★ 阶段推导：以**最新一次执行**为锚点', () => {
  test('一条执行 run 都没有 ⇒ 第一列（还没开始）', () => {
    const info = stageOf(ISSUE, [])
    assert.equal(info.stage, 'executing')
    assert.equal(info.note, '还没开始执行')
    assert.equal(info.executeRun, null)
  })

  test('执行中 ⇒ 第一列', () => {
    const info = stageOf(ISSUE, [run({ runId: 'e1', kind: 'execute', status: 'running' })])
    assert.equal(info.stage, 'executing')
    // 标签就写着"执行中"，note 必须为空——否则就是使用者点掉的那种重复
    assert.equal(info.note, null)
  })

  test('★ 等目录释放时说清楚，而不是含糊的"进行中"', () => {
    // 这个状态可能停很久，而"进行中"会让人以为在跑
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'waiting_local_directory' }),
    ])
    assert.match(String(info.note), /排队中/)
    assert.match(String(info.note), /目录被占用/)
  })

  test('★ 执行完成、审核未跑 ⇒ 第二列，并指出"没有派审核"', () => {
    // 这是**配置问题**（agent 没配「由谁审它」），不是运行故障。
    // 只显示"等待审核"会让人一直等一个不会来的东西。
    const info = stageOf(ISSUE, [run({ runId: 'e1', kind: 'execute', status: 'completed' })])
    assert.equal(info.stage, 'awaiting_review')
    assert.equal(info.note, null, '★ 标签已经是"待审查"，不能再写一遍"等待审核"')
    assert.match(String(info.warning), /没有派审核/)
    assert.match(String(info.warning), /由谁来审它/, '要指出去哪里改')
  })

  test('审核进行中 ⇒ 第二列，不报警', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'running', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.stage, 'awaiting_review')
    assert.equal(info.note, '审核中', '标签"待审查"之外，说清它正在被审')
    assert.equal(info.warning, null)
  })

  test('★ 审核完成 ⇒ 第三列', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.stage, 'reviewed')
    assert.equal(info.reviewRun?.runId, 'r1')
  })
})

describe('★ 那条链：审核的 subject 是**执行 run 的 id**，不是 issue', () => {
  test('★ 按 issue 找 review run 会一条也找不到 —— 必须顺着链走', () => {
    // 审核 run 的 subject 是 `{type:'run', id: 执行runId}`。
    // 如果实现里写成"按 issue 过滤 review run"，这里就会判成"没有派审核"，
    // 而实际上审核已经完成了。症状是卡片永远停在第二列。
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.stage, 'reviewed', '★ 顺着 issue→执行run→审核run 这条链才找得到')
  })

  test('审核 run 指向**别的**执行时不算数', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      // 这条审核是审另一次执行的，与 e1 无关
      run({ runId: 'r9', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e99' } }),
    ])
    assert.equal(info.stage, 'awaiting_review', '不能把无关的审核算到这条执行头上')
  })

  test('别的 issue 的执行 run 不参与', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'other', kind: 'execute', status: 'running', subject: { type: 'issue', id: 'i2' } }),
    ])
    assert.equal(info.executeRun, null, '只看这个 issue 的执行')
  })
})

describe('★ 重试：以**最新**那次为准', () => {
  test('★ 旧执行已完成、新执行在跑 ⇒ 第一列（不是第二列）', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed', queuedAt: 1000 }),
      run({ runId: 'e2', kind: 'execute', status: 'running', queuedAt: 5000 }),
    ])
    assert.equal(info.stage, 'executing', '新的那次还在跑，就不该显示成"待审查"')
  })

  test('★ 最新执行已有完成的审核 ⇒ 第三列，即使更早有失败的执行', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'failed', queuedAt: 1000 }),
      run({ runId: 'e2', kind: 'execute', status: 'completed', queuedAt: 5000 }),
      run({ runId: 'r2', kind: 'review', status: 'completed', queuedAt: 6000, subject: { type: 'run', id: 'e2' } }),
    ])
    assert.equal(info.stage, 'reviewed')
  })

  test('旧执行有审核、新执行没有 ⇒ 第二列（新那次的审核还没跑）', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed', queuedAt: 1000 }),
      run({ runId: 'r1', kind: 'review', status: 'completed', queuedAt: 2000, subject: { type: 'run', id: 'e1' } }),
      run({ runId: 'e2', kind: 'execute', status: 'completed', queuedAt: 5000 }),
    ])
    assert.equal(info.stage, 'awaiting_review')
  })
})

describe('★ 失败的执行要说明，不能静静躺在"待审查"里', () => {
  test('★ 执行失败 ⇒ 第二列 + 明确的失败提示', () => {
    // 失败的执行**不会**有审核结果——没有产出可审。只显示"等待审核"
    // 会让人一直等。
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'failed', failureReason: 'infra_error' }),
    ])
    assert.equal(info.stage, 'awaiting_review')
    assert.match(String(info.warning), /执行失败/)
    assert.match(String(info.warning), /infra_error/, '原因要带出来')
  })

  test('被取消的执行说"被取消"，不说"失败"', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'cancelled' }),
    ])
    assert.match(String(info.warning), /被取消/)
  })

  test('执行成功但没派审核时，提示的是"没派审核"而不是"失败"', () => {
    const info = stageOf(ISSUE, [run({ runId: 'e1', kind: 'execute', status: 'completed' })])
    assert.match(String(info.warning), /没有派审核/)
    assert.ok(!String(info.warning).includes('失败'))
  })
})

describe('三列的定义', () => {
  test('顺序就是流水线方向', () => {
    assert.deepEqual(
      PIPELINE_COLUMNS.map((c) => c.id),
      ['executing', 'awaiting_review', 'reviewed'],
    )
  })

  test('三列各有标题与说明', () => {
    for (const col of PIPELINE_COLUMNS) {
      assert.ok(col.title.length > 0)
      assert.ok(col.hint.length > 0)
    }
  })
})

describe('★ 任务名下的 run：执行 + 审它的 review（审查结论才读得到）', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条测试对应的真实投诉
   * ══════════════════════════════════════════════════════════════════
   *
   * "我是从『已完成审查』那一列点进去的……框里只有『结束：completed』，
   *  但我想看执行的输出结论。"
   *
   * 看板知道这个任务审查完了（`stageOf` 顺着链找到了 review run），可任务
   * 详情原来只按 `subject.id === issue.id` 过滤 —— 而 review run 的 subject
   * 是那条**执行 run 的 id**，不是 issue。于是：
   *
   *   - 审查 run 一条都不显示（没有它的标签页）；
   *   - 判决是挂在 review run 上的，所以也读不出来
   *     （`/api/runs/<执行run>/verdicts` 返回 0 条）。
   *
   * 结果就是"那一列说审查完成，点进去看不到任何审查结论"。
   */
  test('★ review run 也要算在这个任务名下（它挂在执行 run 上）', () => {
    const list = runsForIssue(ISSUE, [
      run({ runId: 'e1', kind: 'execute' }),
      run({ runId: 'r1', kind: 'review', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.deepEqual(list.map((r) => r.runId), ['e1', 'r1'])
  })

  test('★ 时间线：按发生先后排（最早的在前），执行与审核混在一起', () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条断言改过一次——改的是"按什么排"
    // ══════════════════════════════════════════════════════════════════
    //
    // 原来是"执行一组（新的在前）+ 审核一组（新的在前）"，于是
    // "执行 → 审核 → 又执行 → 又审核"排成 `e2, e1, r2, r1`：
    // **后一次审核排在第一次审核前面**，而 e1 还出现在 e2 之后。
    // 使用者就是这么发现问题的：「任务的记录貌似不是按时间顺序排列的，
    // 发现审查了 2 次，后面的审查在前面」。
    const list = runsForIssue(ISSUE, [
      run({ runId: 'e1', kind: 'execute', queuedAt: 1000 }),
      run({ runId: 'e2', kind: 'execute', queuedAt: 3000 }),
      run({ runId: 'r1', kind: 'review', queuedAt: 2000, subject: { type: 'run', id: 'e1' } }),
      run({ runId: 'r2', kind: 'review', queuedAt: 4000, subject: { type: 'run', id: 'e2' } }),
    ])
    assert.deepEqual(
      list.map((r) => r.runId),
      ['e1', 'r1', 'e2', 'r2'],
      '★ 从左往右就是发生顺序；"审了两次"的先后要一眼看得出来',
    )
  })

  test('★ 排序是稳定的：同一毫秒入队的两条也有确定次序', () => {
    // 不稳定排序会让每次渲染顺序都可能变，看起来像"记录自己在跳"。
    const rows = [
      run({ runId: 'b', kind: 'execute', queuedAt: 1000 }),
      run({ runId: 'a', kind: 'execute', queuedAt: 1000 }),
    ]
    const once = runsForIssue(ISSUE, rows).map((r) => r.runId)
    const twice = runsForIssue(ISSUE, [...rows].reverse()).map((r) => r.runId)
    assert.deepEqual(once, ['a', 'b'])
    assert.deepEqual(twice, ['a', 'b'], '输入顺序不同也必须得到同一个结果')
  })

  test('formatRunStamp：今天只写时分秒，跨天带上月日', () => {
    const at = new Date(2026, 4, 20, 14, 3, 9).getTime()
    assert.equal(formatRunStamp(at, new Date(2026, 4, 20, 23, 0, 0).getTime()), '14:03:09')
    assert.equal(formatRunStamp(at, new Date(2026, 4, 21, 1, 0, 0).getTime()), '5/20 14:03')
  })

  test('审**别条**执行的 review 不算这个任务的', () => {
    const list = runsForIssue(ISSUE, [
      run({ runId: 'e1', kind: 'execute' }),
      run({ runId: 'r9', kind: 'review', subject: { type: 'run', id: 'e99' } }),
    ])
    assert.deepEqual(list.map((r) => r.runId), ['e1'])
  })

  test('别的 issue 的执行 run 不参与', () => {
    const list = runsForIssue(ISSUE, [
      run({ runId: 'e1', kind: 'execute' }),
      run({ runId: 'other', kind: 'execute', subject: { type: 'issue', id: 'i2' } }),
    ])
    assert.deepEqual(list.map((r) => r.runId), ['e1'])
  })

  test('没有任何 run ⇒ 空数组（详情里显示"还没有执行过"）', () => {
    assert.deepEqual(runsForIssue(ISSUE, []), [])
  })

  test('★ 归属规则与看板一致：同一个任务，两处看到的是同一批 run', () => {
    // 这条是防"两条路各写一遍"：看板说"已审查"，任务详情就必须能看到
    // 那条审查 run。只要两边共用 `runsForIssue`，就不可能不一致。
    const all = [
      run({ runId: 'e1', kind: 'execute', queuedAt: 1000 }),
      run({ runId: 'r1', kind: 'review', queuedAt: 2000, subject: { type: 'run', id: 'e1' } }),
    ]
    const info = stageOf(ISSUE, all)
    assert.equal(info.stage, 'reviewed')
    assert.equal(info.reviewRun?.runId, 'r1')
    assert.ok(
      runsForIssue(ISSUE, all).some((r) => r.runId === info.reviewRun?.runId),
      '★ 看板认定的那条审查 run，任务详情里也必须能找到',
    )
  })
})

describe('★ 「需要注意」单独一拨（不是重排全部）', () => {
  /**
   * 使用者的心理模型是"列表大致按时间"。整体重排会让人找不到刚才那条，
   * 所以只把**真的要人看一眼**的置顶，其余保持原序。
   */
  function staged(
    id: string,
    runs: Array<Partial<RunSummary> & { runId: string; kind: string }>,
  ) {
    // ⚠️ 夹具要自己把 subject 接对：`stageOf` 是按 `subject.id === issueId`
    //    找执行 run 的。第一版直接用 `run()` 的默认 subject（`i1`），于是
    //    每条都"找不到执行 run" ⇒ 全被判成"还没开始执行"，测试红得莫名其妙。
    const list = runs.map((r) =>
      run({
        ...r,
        subject:
          r.kind === 'execute'
            ? { type: 'issue', id }
            : (r.subject ?? { type: 'run', id: 'unknown' }),
      }),
    )
    return { issue: { id }, info: stageOf(id, list) }
  }

  test('★ 执行失败的任务进「需要注意」，并带原因', () => {
    const list = [
      staged('ok', [
        { runId: 'e-ok', kind: 'execute', status: 'completed' },
        { runId: 'r-ok', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e-ok' } },
      ]),
      staged('bad', [
        { runId: 'e-bad', kind: 'execute', status: 'failed', failureReason: 'agent_error' },
      ]),
    ]
    const { attention, rest } = splitByAttention(list)
    assert.deepEqual(attention.map((x) => x.issue.id), ['bad'])
    assert.deepEqual(rest.map((x) => x.issue.id), ['ok'])
    assert.match(attention[0]!.info.warning ?? '', /执行失败/)
  })

  test('★ 没派审核（配置问题）也进「需要注意」', () => {
    const list = [staged('noreviewer', [{ runId: 'e1', kind: 'execute', status: 'completed' }])]
    const { attention } = splitByAttention(list)
    assert.equal(attention.length, 1)
    assert.match(attention[0]!.info.warning ?? '', /没有派审核/)
  })

  test('被取消的执行同样进「需要注意」（它也不会有审核结果）', () => {
    const list = [staged('c', [{ runId: 'e1', kind: 'execute', status: 'cancelled' }])]
    const { attention } = splitByAttention(list)
    assert.equal(attention.length, 1)
    assert.match(attention[0]!.info.warning ?? '', /被取消/)
  })

  test('正在跑 / 待审查 / 已审查都**不算**需要注意（那是正常流转）', () => {
    const list = [
      staged('running', [{ runId: 'e1', kind: 'execute', status: 'running' }]),
      staged('awaiting', [
        { runId: 'e2', kind: 'execute', status: 'completed' },
        { runId: 'r2', kind: 'review', status: 'running', subject: { type: 'run', id: 'e2' } },
      ]),
      staged('done', [
        { runId: 'e3', kind: 'execute', status: 'completed' },
        { runId: 'r3', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e3' } },
      ]),
    ]
    const { attention, rest } = splitByAttention(list)
    assert.deepEqual(attention, [])
    assert.deepEqual(
      rest.map((x) => x.issue.id),
      ['running', 'awaiting', 'done'],
      '其余保持原序',
    )
  })

  test('都有警告时全部进 attention，rest 为空', () => {
    const list = [
      staged('a', [{ runId: 'e1', kind: 'execute', status: 'failed' }]),
      staged('b', [{ runId: 'e2', kind: 'execute', status: 'cancelled' }]),
    ]
    const { attention, rest } = splitByAttention(list)
    assert.equal(attention.length, 2)
    assert.equal(rest.length, 0)
  })

  test('一个任务都没有时不炸', () => {
    const { attention, rest } = splitByAttention([])
    assert.deepEqual(attention, [])
    assert.deepEqual(rest, [])
  })

  test('短标签覆盖三个阶段，且够短（表格里要显示它）', () => {
    for (const col of PIPELINE_COLUMNS) {
      assert.equal(typeof STAGE_SHORT[col.id], 'string')
      assert.ok(STAGE_SHORT[col.id].length <= 5, `短标签别太长：${STAGE_SHORT[col.id]}`)
    }
  })
})

describe('★ note：只给标签之外的信息（去掉重复字样）', () => {
  /**
   * 使用者的反馈：「阶段里面去掉『待审查』下面『等待审核』的字样，重复了」。
   * 所以这里逐种情况钉住"该说什么、不该说什么"。
   */
  test('★ 待审查 + 还没开始审 / 审核在排队 ⇒ note 为空（标签已经说了）', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'queued', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.stage, 'awaiting_review')
    assert.equal(info.note, null, '★ 不能在「待审查」后面再写「等待审核」')
  })

  test('★ 待审查 + 审核正在跑 ⇒ note 说「审核中」（这是额外信息）', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'running', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.note, '审核中')
  })

  test('★ 执行中（真的在跑）⇒ note 为空；排队中 ⇒ 说清是排队', () => {
    const running = stageOf(ISSUE, [run({ runId: 'e1', kind: 'execute', status: 'running' })])
    assert.equal(running.stage, 'executing')
    assert.equal(running.note, null, '★ 不能在「执行中」后面再写「执行中」')

    const queued = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'waiting_local_directory' }),
    ])
    assert.match(queued.note ?? '', /排队中/, '排队是标签之外的信息，要留着')
  })

  test('★ 一次都没跑过 ⇒ note 说「还没开始执行」（否则标签会说谎）', () => {
    const info = stageOf(ISSUE, [])
    assert.equal(info.stage, 'executing')
    assert.equal(info.note, '还没开始执行')
  })

  test('★ 已审查 ⇒ note 为空', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.note, null)
  })

  test('★ 没有 `detail` 这个字段：同一句话只准有一个出处', () => {
    // 使用者说「『待审查』下面『等待审核』重复了」。把界面上那句撤掉之后
    // 才发现 `detail` 在前端**一个消费者都没有**（看板列头用的是列定义里的
    // 静态 `col.hint`，卡片读的是 `note`）。它剩下唯一的作用，就是把刚被
    // 点掉的那句话继续养在数据层，等着哪次改动顺手渲染出来、重复原样长回来。
    //
    // 所以这里断言它**不存在**——这条断言就是防复发的闸门。（与
    // `RunSummary.lastSeq` 被删掉时留下的那两条断言同一个思路。）
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
    ])
    assert.equal(
      Object.hasOwn(info, 'detail'),
      false,
      '阶段说明只留 `note`；再加一个同义字段就等于把重复放回来',
    )
    assert.deepEqual(
      Object.keys(info).sort(),
      ['executeRun', 'note', 'reviewRun', 'stage', 'warning'],
    )
  })
})
