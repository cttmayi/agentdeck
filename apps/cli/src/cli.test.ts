import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { COMMANDS, findCommand, renderHuman } from './commands.ts'
import { UsageError, parseArgs } from './args.ts'

/**
 * 命令行（FR-INTEG-02）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 需求里那半句决定了这里要测什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 「提供 CLI，覆盖主要操作，**且 agent 可通过同一 CLI 驱动本系统**」。
 *
 * "agent 可驱动"意味着输出必须是**机器可解析**、**退出码有含义**的。
 * 所以最要紧的一组测试不是"命令能用"，而是：
 *
 *   - 默认输出是 JSON（而不是给人看的表格）；
 *   - 不提供"提交任意 run"这类会变成代码执行入口的命令。
 */

describe('参数解析', () => {
  test('命令 + 位置参数 + 旗标', () => {
    const p = parseArgs(['issue-create', '标题', '--desc', '描述'])
    assert.equal(p.command, 'issue-create')
    assert.deepEqual(p.positionals, ['标题'])
    assert.equal(p.flags.get('desc'), '描述')
  })

  test('布尔旗标（后面没跟值）', () => {
    const p = parseArgs(['inbox', '--all'])
    assert.equal(p.flags.get('all'), true)
  })

  test('★ 出现 `--` 时报用法错误，而不是静默吞掉后面所有选项', () => {
    // `pnpm run cli -- status` 这种写法极其常见，而 `--` 之后的一切
    // 都会被当成位置参数，选项静默失效。daemon 的 CLI 为此专门加了一道拒绝，
    // 这里保持一致——一个被忽略的选项比一个报错的选项危险得多。
    assert.throws(() => parseArgs(['--', 'status']), UsageError)
    assert.throws(() => parseArgs(['--', 'status']), /去掉那个 `--`/)
  })

  test('`--flag=value` 形式也会被当成旗标名，不会误判为位置参数', () => {
    const p = parseArgs(['issues', '--status=todo'])
    assert.equal(p.command, 'issues')
    // 这条写下来是为了固定现状：`--flag=value` 目前会被当作名字里带 `=`
    // 的布尔旗标。它不是错误，但也不是"解析对了"——真要支持得显式切分。
    // 与其假装支持，不如让行为在这里可见。
    assert.equal(p.flags.has('status=todo'), true)
  })
})

describe('★ 命令集的范围：不提供代码执行入口', () => {
  test('★ 没有任何命令能直接提交 run', () => {
    const names = COMMANDS.map((c) => c.name)
    for (const forbidden of ['run-submit', 'submit-run', 'exec', 'run-create']) {
      assert.ok(
        !names.includes(forbidden),
        `${forbidden} 会接受任意 workDir 并启动子进程——CLI 是给脚本用的，` +
          `一个能提交任意 run 的 CLI 就是一条现成的代码执行入口`,
      )
    }
  })

  test('★ 没有任何命令能写 skill 或改 agent 配置', () => {
    const names = COMMANDS.map((c) => c.name)
    for (const forbidden of ['skill-install', 'skill-write', 'agent-create', 'agent-update']) {
      assert.ok(!names.includes(forbidden), `${forbidden} 不该被暴露`)
    }
  })

  test('reports 命令的说明里写明它本身不执行任何命令', () => {
    const spec = findCommand('reports')
    assert.ok(spec)
    assert.match(spec.summary, /不执行任何命令/)
  })

  test('覆盖了需求说的"主要操作"', () => {
    const names = new Set(COMMANDS.map((c) => c.name))
    for (const required of [
      'status', // 看状态
      'issues', // 看任务
      'issue-create', // 建任务
      'runs', // 看执行
      'run-verdicts', // 看判决
      'reports', // 投递报告
      'inbox', // 通知
      'costs', // 成本
      'audits-export', // 审计导出
    ]) {
      assert.ok(names.has(required), `缺少命令：${required}`)
    }
  })

  test('需要位置参数的命令都声明了 needsPositional（否则会以难懂的方式失败）', () => {
    for (const name of ['run', 'run-verdicts', 'run-audits', 'run-cancel', 'inbox-read', 'issue-create']) {
      assert.equal(findCommand(name)?.needsPositional, true, `${name} 应当声明需要位置参数`)
    }
  })
})

describe('人类可读渲染', () => {
  test('嵌套对象缩进，空值有明确表示', () => {
    const text = renderHuman({ a: 1, b: null, c: { d: 'x' } })
    assert.match(text, /a: 1/)
    assert.match(text, /b: null/)
    assert.match(text, /c:/)
    assert.match(text, /d: x/)
  })

  test('空列表与空值有区分（"没有"和"空数组"不是一回事）', () => {
    assert.equal(renderHuman([]), '(空列表)')
    assert.equal(renderHuman(null), '(空)')
  })
})
