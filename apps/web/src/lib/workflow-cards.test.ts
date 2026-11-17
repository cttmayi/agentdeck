import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  TERMINAL_RUN_STATUSES,
  buildCards,
  isRunTerminal,
  logExpanded,
  loopRounds,
  needsFetch,
  runCardBody,
  stepExpanded,
  stepPreview,
  stepSummaryRunId,
} from './workflow-cards.ts'

/**
 * 编排运行画面「每个 run 一张卡片」的判据。
 *
 * 这一组是为了钉住使用者 2026-11 那条要求：
 *   "Agent 已启动在卡片中显示出来，一直接受文字消息并显示，直到最后结束。
 *    不要 Agent 之间有依赖关系，这样就不存在相互影响。"
 *
 * 它挡的是**两个已经发生过的真缺陷**：
 *   ① 取数只看"最后一个 runId" ⇒ loop 前面几轮的 run 从来没取过数；
 *   ② 取过一次就短路 ⇒ 状态是死快照，把关者那一行（判据是"执行 run 已 completed"）
 *      永远不出现——使用者报的就是"loop 的审核 agent 显示不出来"。
 */

describe('编排运行画面：每个 run 一张卡片', () => {
  test('★ 终态那一列与协议逐项相同（抄了一份常量，就得钉住）', async () => {
    // ⚠️ 前端不 import protocol 包（`api.ts` 顶部写了理由），所以这里是**抄的一份**。
    //    抄一份不钉住 = 真正危险的那种抄：协议加了终态，这里不知道，卡片永远"正在跑"。
    // apps/web/src/lib → 仓库根是四层
    const src = await readFile(
      join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'protocol', 'src', 'enums.ts'),
      'utf8',
    )
    const m = /export const TERMINAL_RUN_STATUSES = \[([^\]]*)\]/.exec(src)
    assert.ok(m, '协议里找不到 TERMINAL_RUN_STATUSES')
    const theirs = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!)
    assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(), theirs.sort())
  })

  test('★ 非终态 ⇒ 一直重拉（「一直接受文字消息并显示」）', () => {
    for (const status of ['queued', 'dispatched', 'running', 'waiting_local_directory']) {
      assert.equal(needsFetch(status, false), true, `${status} 本身就要拉`)
      assert.equal(needsFetch(status, true), true, `${status} 有产出也要继续拉（文字会继续长）`)
    }
  })

  test('★ 终态 + 已有产出 ⇒ 不用再拉（跑完的产出不会变，别无限打接口）', () => {
    for (const status of ['completed', 'failed', 'cancelled']) {
      assert.equal(needsFetch(status, true), false, `${status} 且已有产出 ⇒ 不用再拉`)
      // ⚠️ 但终态而**没有**产出时要再拉一次：终态那一刻的全文常常还没抓到
      assert.equal(needsFetch(status, false), true, `${status} 但没有产出 ⇒ 补拉一次`)
    }
  })

  test('★ 还不知道状态 ⇒ 要拉（`undefined` 不算终态，宁可多拉一次）', () => {
    assert.equal(needsFetch(undefined, false), true)
    assert.equal(needsFetch(undefined, true), true)
    assert.equal(needsFetch(null, true), true)
    assert.equal(isRunTerminal(undefined), false)
  })

  test('★ loop 的 runIds 两两配对；奇数按半轮如实渲染（不硬凑空把关者）', () => {
    assert.deepEqual(loopRounds(['e1', 'g1', 'e2', 'g2']), [
      { exec: 'e1', guard: 'g1' },
      { exec: 'e2', guard: 'g2' },
    ])
    assert.deepEqual(loopRounds(['e1', 'g1', 'e2']), [
      { exec: 'e1', guard: 'g1' },
      { exec: 'e2', guard: null },
    ])
    assert.deepEqual(loopRounds([]), [])
  })

  test('★★ 卡片正文只看**这条 run 自己**：已启动就显示（不是"没有产出"）', () => {
    // 已启动、还没吐字 ⇒ "正在跑"（这就是使用者要的"已启动就显示出来"）
    assert.equal(runCardBody('running', undefined), 'running')
    assert.equal(runCardBody('queued', undefined), 'running')
    assert.equal(runCardBody('dispatched', undefined), 'running')
    // 有文字 ⇒ 画原文（哪怕还在跑）
    assert.equal(runCardBody('running', '第一版草稿'), 'text')
    assert.equal(runCardBody('completed', '最终稿'), 'text')
    // 跑完了、确实没产出 ⇒ 说"没有产出"（这时候才说得出口）
    assert.equal(runCardBody('completed', undefined), 'empty')
    assert.equal(runCardBody('failed', '   '), 'empty')
    // ⚠️ 反过来：**非终态的空产出绝不能说"没有产出"**——那是假话，与"已启动"矛盾
    assert.notEqual(runCardBody('running', ''), 'empty')
  })

  test('★★ 卡头摘要取「往下交的那份」：loop 是执行者，不是把关者', () => {
    // 两轮都跑完：[执行1, 把关1, 执行2, 把关2] ⇒ 往下交的是**执行2**
    assert.equal(stepSummaryRunId({ kind: 'loop', runIds: ['e1', 'g1', 'e2', 'g2'] }), 'e2')
    // 正在跑第二轮执行：[执行1, 把关1, 执行2] ⇒ 还是执行者的那条
    assert.equal(stepSummaryRunId({ kind: 'loop', runIds: ['e1', 'g1', 'e2'] }), 'e2')
    // 第一轮刚跑完执行、把关刚提交：[执行1, 把关1] ⇒ 执行1
    assert.equal(stepSummaryRunId({ kind: 'loop', runIds: ['e1', 'g1'] }), 'e1')
    // 只有一条 ⇒ 它自己（刚提交、还没有把关）
    assert.equal(stepSummaryRunId({ kind: 'loop', runIds: ['e1'] }), 'e1')
    // flow / parallel 分支：流水线最后一级
    assert.equal(stepSummaryRunId({ kind: 'flow', runIds: ['a', 'b', 'c'] }), 'c')
    assert.equal(stepSummaryRunId({ kind: 'parallel', runIds: ['only'] }), 'only')
    // gate 没有 run ⇒ 由调用方改显示等确认的文案
    assert.equal(stepSummaryRunId({ kind: 'gate', runIds: [] }), null)
  })

  test('★★ 日志默认只展开「正在跑」的那条；人点过的以人为准', () => {
    assert.equal(logExpanded(undefined, 'running'), true)
    assert.equal(logExpanded(undefined, 'queued'), true)
    assert.equal(logExpanded(undefined, undefined), true, '还没取到状态 ⇒ 当成在跑，亮出来')
    assert.equal(logExpanded(undefined, 'completed'), false)
    assert.equal(logExpanded(undefined, 'failed'), false)
    // 人点过：一律听人的（刷新轮询不许把它收回去，也不许悄悄展开）
    assert.equal(logExpanded(true, 'completed'), true)
    assert.equal(logExpanded(false, 'running'), false)
  })

  test('★★ 收起态卡头预览**多行、可换行**（不是第一行 + 省略号）', () => {
    const out = [
      '# 周报（第 2 版）',
      '',
      '本周完成：编排页按规范重排、运行画面按 run 渲染。',
      '',
      '## 风险',
      '1. 编排页规范重排与 run 视图改动同一天合并可能互相踩。',
    ].join('\n')
    const p = stepPreview(out, 3)
    // 前 3 行（含空行——Markdown 靠它分段），且没有"只取第一行"
    assert.equal(p.text.split('\n')[0], '# 周报（第 2 版）')
    // 第三行也在（多行预览），末尾补一个省略号表示"后面还有"
    assert.ok(p.text.split('\n')[2]!.startsWith('本周完成：编排页按规范重排'))
    assert.equal(p.truncated, true, '还有后面的行 ⇒ 如实标"截了"')
    assert.ok(p.text.endsWith('…'))
    // 默认给得多（靠滚动条看）——十几行都留着，只截超出部分
    const many = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join('\n')
    const bulk = stepPreview(many)
    assert.equal(bulk.text.split('\n').length, 12, '默认留 12 行（其余靠滚动条看更多）')
    assert.equal(bulk.truncated, true)
    // 短输出：原样、不截
    assert.deepEqual(stepPreview('短'), { text: '短', truncated: false })
    // 单行超长：按字数截（按行数限不住体量）
    const long = 'x'.repeat(2000)
    const cut = stepPreview(long)
    assert.equal(cut.truncated, true)
    assert.equal(cut.text.length, 1201, '1200 字 + 一个省略号')
    // 没有产出 / 只有空白
    assert.deepEqual(stepPreview(undefined), { text: '', truncated: false })
    assert.deepEqual(stepPreview('\n\n  \n'), { text: '', truncated: false })
  })

  test('★★ 步骤展开状态按步骤各存各的（不是一个全局值）', () => {
    // 没点过：正在跑 / 等人确认的自动展开，终态收起
    assert.equal(stepExpanded(undefined, 'running'), true)
    assert.equal(stepExpanded(undefined, 'waiting-human'), true)
    assert.equal(stepExpanded(undefined, 'done'), false)
    assert.equal(stepExpanded(undefined, 'failed'), false)
    assert.equal(stepExpanded(undefined, 'pending'), false)
    assert.equal(stepExpanded(undefined, 'skipped'), false)
    // 人点过：一律听人的（展开一个**不许**影响别的步骤）
    assert.equal(stepExpanded(true, 'done'), true)
    assert.equal(stepExpanded(false, 'waiting-human'), false)
  })

  test('★★ 卡片树：loop 的两轮 → 两个 RoundCard，各含执行/把关；gate 把关挂 GateCard', () => {
    const st = (id: string) => ({ e1: 'completed', g1: 'completed', e2: 'running' })[id]
    const look = {
      statusOf: st as (id: string) => string | undefined,
      outputOf: (id: string) => `out-${id}`,
      nameOf: (id: string) => `agent-${id}`,
      text: {
        stepWorking: '跑着', noOutput: '没产出', loopReviewing: '把关中',
        stepWaitingHuman: '等你确认',
        roundTitle: (n: number) => `第${n}轮`,
        execMeta: (n: number) => `E${n}`, guardMeta: (n: number) => `G${n}`,
        stageMeta: (i: number, t: number) => `${i}/${t}`,
        execLabel: '执行者', guardLabel: '把关者',
      },
    }
    // 三个 run：[执行1, 把关1, 执行2] ⇒ 两轮；第二轮把关还没提交
    const loop = buildCards(
      { seq: 0, kind: 'loop', label: '把关循环', status: 'running', gateText: null, runIds: ['e1', 'g1', 'e2'] },
      look,
    )
    assert.equal(loop.kind, 'step')
    // ⚠️ `CardNode` 是联合类型：断言成容器再取 children（类型层面也不许瞎取）
    const step = loop as Extract<typeof loop, { children: unknown[] }>
    assert.equal((loop as any).children.length, 2, '两个轮次卡')
    const r1: any = (step as any).children[0]
    assert.equal(r1.kind, 'round')
    assert.deepEqual(r1.children.map((c: any) => c.kind), ['run', 'run'])
    assert.equal(r1.children[0].meta, 'E1')
    assert.equal(r1.children[1].meta, 'G1')
    const r2: any = (step as any).children[1]
    assert.equal(r2.status, 'running', '最后一轮跟随步骤状态')
    assert.equal(r2.children.length, 1, '第二轮的把关还没提交 ⇒ 只有执行')

    // gate 把关（人不产生 run）：[exec] + gateText ⇒ 一轮 + 一张 GateCard
    const withGate = buildCards(
      { seq: 1, kind: 'loop', label: '把关循环', status: 'waiting-human', gateText: '可以发了吗', runIds: ['e1'] },
      look,
    )
    const round: any = ((withGate as any).children ?? [])[0]
    assert.deepEqual(round.children.map((c: any) => c.kind), ['run', 'gate'])
    assert.equal(round.children[1].text, '可以发了吗')

    // flow：每条 run 一张卡（流水线的每一级）
    const flow = buildCards(
      { seq: 2, kind: 'flow', label: '流水线', status: 'done', gateText: null, runIds: ['a', 'b', 'c'] },
      look,
    )
    const flowKids: any[] = (flow as any).children ?? []
    assert.equal(flowKids.length, 3)
    assert.equal(flowKids[1].meta, '2/3')

    // gate 步骤：只有一张 GateCard
    const gate = buildCards(
      { seq: 3, kind: 'gate', label: '确认', status: 'waiting-human', gateText: '好了吗', runIds: [] },
      look,
    )
    assert.deepEqual(((gate as any).children ?? []).map((c: any) => c.kind), ['gate'])
  })

  test('★★ loop 没跑完就不许贴产出（卡头只给"进行中 / 等你确认"）', () => {
    const look = {
      statusOf: (id: string) => ({ e1: 'completed' }[id] ?? 'running'),
      // 注意：**有产出**（第 1 轮写完了），但 loop 还没完
      outputOf: (id: string) => (id === 'e1' ? '# 周报（第 1 轮草稿）' : ''),
      nameOf: () => '小周',
      text: {
        stepWorking: '（正在跑…）', noOutput: '（还没有产出）', loopReviewing: '（把关中…）',
        stepWaitingHuman: '等你确认',
        roundTitle: (n: number) => `第${n}轮`,
        execMeta: (n: number) => '执行', guardMeta: (n: number) => '把关',
        stageMeta: (i: number, t: number) => `${i}/${t}`,
        execLabel: '执行者', guardLabel: '把关者',
      },
    }
    // 还在跑（第 2 轮进行中）⇒ 卡头**不许**出现草稿正文
    const running = buildCards(
      { seq: 0, kind: 'loop', label: '把关循环', status: 'running', gateText: null, runIds: ['e1', 'g1', 'e2'] },
      look,
    ) as any
    assert.equal(running.preview, '（正在跑…）')
    assert.ok(!running.preview.includes('草稿'), '未终结的 loop 卡头不许贴产出')
    // 跑完了 ⇒ 才贴最后那份产出
    const done = buildCards(
      { seq: 0, kind: 'loop', label: '把关循环', status: 'done', gateText: null, runIds: ['e1', 'g1'] },
      look,
    ) as any
    assert.ok(done.preview.includes('草稿'))
    // 等人确认 ⇒ 只给"等你确认"那句（不是产出）
    const waiting = buildCards(
      { seq: 1, kind: 'loop', label: '把关循环', status: 'waiting-human', gateText: '可以发了吗', runIds: ['e1'] },
      look,
    ) as any
    assert.equal(waiting.preview, '"可以发了吗"')
  })
})
