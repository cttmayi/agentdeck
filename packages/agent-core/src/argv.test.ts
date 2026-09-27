import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArgv } from './argv.ts'
import { describeDropped, filterBlockedArgs } from './blocked-args.ts'
import {
  CLAUDE_BLOCKED_ARGS,
  CLAUDE_DESCRIPTOR,
  getRuntimeDescriptor,
  knownRuntimeKeys,
  RUNTIMES,
} from './runtime-table.ts'

describe('runtime 描述表（FR-CLI-47 —— 把"支持新 runtime"变成填空题）', () => {
  test('★ 表里有三行：claude、generic 与 codex（service 形状）', () => {
    // 这条断言首版写的是 `['claude']`，第二个适配器落地时它**故意失败了一次**——
    // 那正是"填空题"想要的效果：改一行数据，就有一处守卫提醒你表变了。
    // 现在第三行（codex）是 **service 形状**，cli-only 字段对它不适用（见下）。
    assert.deepEqual(knownRuntimeKeys().sort(), ['claude', 'codex', 'generic'])

    for (const key of knownRuntimeKeys()) {
      const d = RUNTIMES[key]!
      // 一个新 runtime 要回答的问题永远同样几个
      assert.ok(d.kind === 'cli' || d.kind === 'service', '每个 runtime 都要声明形状')
      assert.ok(d.skills, '技能怎么投递：目录，或者明确"没有这个机制"')
      assert.ok(d.toolConfig)
      assert.ok(d.disableSwitch)
      assert.ok(d.protocol)
      assert.ok(d.family, '协议族决定用哪个解析器读输出')
      assert.ok(d.evidence, '证据等级：未验证的 runtime 不得冒充已验证')
      assert.ok(d.baseArgs.length > 0, 'baseArgs：cli 是协议参数，service 是启动参数——都必须非空')

      if (d.kind === 'cli') {
        assert.ok(d.managedFlags?.model && d.managedFlags.maxTurns, '受管旗标必须逐条声明（cli）')
        assert.ok(d.resume?.flag, '会话恢复旗标必须声明（cli）')
        assert.ok(d.promptDelivery, 'prompt 怎么送进去也是一条数据（cli）')
      } else {
        // service 形状：cli-only 字段**不填**——填占位值就是撒谎（见 kind 的说明）
        assert.equal(d.managedFlags, undefined, 'service 没有 run 级 argv，不得填受管旗标')
        assert.equal(d.resume, undefined, 'service 走协议恢复（如 thread/resume），不得填旗标')
        assert.equal(d.promptDelivery, undefined, 'service 走协议 input，不得填投递方式')
      }
    }
  })

  test('★ codex 是 service 形状的表行（设计稿 §6 的关键取值）', () => {
    const codex = RUNTIMES['codex']!
    assert.equal(codex.kind, 'service')
    assert.equal(codex.protocol, 'jsonrpc')
    assert.equal(codex.family, 'codex-app-server-jsonrpc')
    assert.equal(codex.sessionState, 'stateful')
    assert.equal(codex.systemPrompt, null, 'app-server 没有系统提示参数 ⇒ B 档')
    assert.deepEqual([...codex.baseArgs], ['app-server', '--stdio'], 'baseArgs 是启动参数')
    assert.deepEqual(codex.skills, { kind: 'directory', dir: '.codex/skills' })
    assert.equal(codex.evidence, 'verified')
    assert.deepEqual([...codex.versions!.verifiedWith], ['0.144.0-alpha.4', '0.157.1'], '实测过的版本要如实填')
    assert.equal(codex.versions!.range, '>=0.144.0-alpha.4 <0.158.0')
  })

  test('★ 两个 runtime 的答案不得处处相同（否则等于没填）', () => {
    const claude = RUNTIMES['claude']!
    const other = RUNTIMES['generic']!
    assert.notEqual(other.skills.kind, claude.skills.kind)
    assert.notEqual(other.family, claude.family)
    assert.notEqual(other.resume?.flag, claude.resume?.flag)
    assert.notDeepEqual([...other.baseArgs], [...claude.baseArgs])
  })

  test('★ 未启用的注入位必须写明原因——否则它会消失在"以后再说"里', () => {
    assert.equal(CLAUDE_DESCRIPTOR.toolConfig.enabled, false)
    assert.equal(CLAUDE_DESCRIPTOR.disableSwitch.enabled, false)
    assert.ok((CLAUDE_DESCRIPTOR.toolConfig.reason ?? '').length > 0)
    assert.ok((CLAUDE_DESCRIPTOR.disableSwitch.reason ?? '').length > 0)
  })

  test('基础参数包含协议三件套与无人值守权限', () => {
    const a = CLAUDE_DESCRIPTOR.baseArgs
    assert.ok(a.includes('-p'))
    assert.deepEqual(a.slice(a.indexOf('--output-format'), a.indexOf('--output-format') + 2), [
      '--output-format',
      'stream-json',
    ])
    assert.ok(a.includes('--permission-mode'))
    assert.ok(a.includes('bypassPermissions'))
  })

  test('★ 禁用了交互式提问工具（非交互模式下它会静默返回空答案）', () => {
    const a = CLAUDE_DESCRIPTOR.baseArgs
    const i = a.indexOf('--disallowedTools')
    assert.notEqual(i, -1)
    assert.equal(a[i + 1], 'AskUserQuestion')
  })

  test('未知 runtime 报错并列出已知的', () => {
    assert.throws(() => getRuntimeDescriptor('gemini'), /未知的 runtime.*claude/s)
  })
})

describe('禁改参数表过滤（FR-CLI-08~13）', () => {
  const B = CLAUDE_BLOCKED_ARGS

  test('standalone：只丢参数本身', () => {
    const r = filterBlockedArgs(['-p', '--model', 'x'], B)
    assert.deepEqual(r.kept, ['--model', 'x'])
    assert.deepEqual(r.dropped, [{ arg: '-p', mode: 'standalone' }])
  })

  test('withValue：连值一起丢', () => {
    const r = filterBlockedArgs(['--output-format', 'text', '--model', 'x'], B)
    assert.deepEqual(r.kept, ['--model', 'x'])
    assert.deepEqual(r.dropped, [{ arg: '--output-format', mode: 'withValue', value: 'text' }])
  })

  test('withValue：`--flag=value` 形式丢一个 token', () => {
    const r = filterBlockedArgs(['--permission-mode=default', '--model', 'x'], B)
    assert.deepEqual(r.kept, ['--model', 'x'])
    assert.deepEqual(r.dropped, [
      { arg: '--permission-mode', mode: 'withValue', value: 'default' },
    ])
  })

  test('★ 下一个 token 是另一个 flag 时不吞掉它', () => {
    const r = filterBlockedArgs(['--output-format', '--model', 'x'], B)
    assert.deepEqual(r.kept, ['--model', 'x'], '--model 不能被误删')
    assert.deepEqual(r.dropped, [{ arg: '--output-format', mode: 'withValue' }])
  })

  test('禁改参数在末尾（没有值）也能处理', () => {
    const r = filterBlockedArgs(['--model', 'x', '--input-format'], B)
    assert.deepEqual(r.kept, ['--model', 'x'])
    assert.deepEqual(r.dropped, [{ arg: '--input-format', mode: 'withValue' }])
  })

  test('不相干的参数原样保留，顺序不变', () => {
    const r = filterBlockedArgs(['--foo', 'bar', '--baz'], B)
    assert.deepEqual(r.kept, ['--foo', 'bar', '--baz'])
    assert.deepEqual(r.dropped, [])
  })

  test('丢弃说明是人可读的（用于警告日志，FR-CLI-12）', () => {
    const r = filterBlockedArgs(['--output-format', 'text', '-p'], B)
    assert.equal(describeDropped(r.dropped), '--output-format text, -p')
  })
})

describe('argv 组装（FR-CLI-04）', () => {
  test('顺序固定：基础 → 受管 → 使用者 → 受管追加', () => {
    const { argv } = buildArgv({
      runtime: CLAUDE_DESCRIPTOR,
      model: 'claude-sonnet-4-5',
      maxTurns: 12,
      resumeSessionId: 'sess-1',
      userArgs: ['--foo', 'bar'],
    })

    const iBase = 0
    const iModel = argv.indexOf('--model')
    const iMax = argv.indexOf('--max-turns')
    const iResume = argv.indexOf('--resume')
    const iUser = argv.indexOf('--foo')

    assert.equal(iBase, 0)
    assert.ok(iModel > 0)
    assert.ok(iMax > iModel)
    assert.ok(iResume > iMax)
    assert.ok(iUser > iResume, '使用者参数必须在平台受管参数之后')
  })

  test('★ 使用者参数里的禁改项被丢掉，且被报告', () => {
    const r = buildArgv({
      runtime: CLAUDE_DESCRIPTOR,
      userArgs: ['--output-format', 'text', '--foo'],
    })
    assert.equal(r.hadDropped, true)
    assert.ok(!r.argv.includes('text'), '被丢弃的值不应出现在 argv 里')
    assert.ok(r.argv.includes('--foo'))
    assert.equal(r.dropped.length, 1)
  })

  test('★ 平台受管追加参数写在最后——最后写的赢（纵深防御）', () => {
    const { argv } = buildArgv({
      runtime: CLAUDE_DESCRIPTOR,
      userArgs: ['--foo'],
      managedAppend: ['--settings', '/tmp/policy.json'],
    })
    assert.equal(argv[argv.length - 2], '--settings')
    assert.equal(argv[argv.length - 1], '/tmp/policy.json')
    assert.ok(argv.indexOf('--foo') < argv.indexOf('--settings'))
  })

  test('首版 managedAppend 为空也不影响', () => {
    const { argv } = buildArgv({ runtime: CLAUDE_DESCRIPTOR })
    assert.deepEqual(argv, [...CLAUDE_DESCRIPTOR.baseArgs])
  })

  test('maxTurns 为 0 / null 时不追加', () => {
    assert.ok(!buildArgv({ runtime: CLAUDE_DESCRIPTOR, maxTurns: 0 }).argv.includes('--max-turns'))
    assert.ok(
      !buildArgv({ runtime: CLAUDE_DESCRIPTOR, maxTurns: null }).argv.includes('--max-turns'),
    )
  })

  test('model 为空时不追加', () => {
    assert.ok(!buildArgv({ runtime: CLAUDE_DESCRIPTOR, model: null }).argv.includes('--model'))
    assert.ok(!buildArgv({ runtime: CLAUDE_DESCRIPTOR }).argv.includes('--model'))
  })

  test('★ 平台基础参数无法被使用者翻掉', () => {
    const { argv } = buildArgv({
      runtime: CLAUDE_DESCRIPTOR,
      userArgs: ['-p', '--permission-mode', 'default', '--output-format', 'json'],
    })
    // 基础参数里那一个 -p 仍在，且权限模式仍是 bypassPermissions
    assert.equal(argv.filter((a) => a === '-p').length, 1)
    const i = argv.indexOf('--permission-mode')
    assert.equal(argv[i + 1], 'bypassPermissions')
    assert.equal(argv.filter((a) => a === '--output-format').length, 1)
  })
})
