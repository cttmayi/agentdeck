import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArgv, getRuntimeDescriptor, knownRuntimeKeys, loadCliRuntimeDescriptor, loadRuntimeDescriptor } from '@agentdeck/agent-core'
import {
  GENERIC_BLOCKED_ARGS,
  GENERIC_CLI_FACTS,
  GENERIC_DESCRIPTOR,
  genericDescriptor,
  genericEvidence,
  genericPromptDelivery,
  unverifiedFields,
} from './generic-descriptor.ts'

/**
 * 描述符的测试。
 *
 * 这一组测试的价值不在"字段都有值"（那种断言谁都会写），而在**守住诚实**：
 * 第二个 runtime 没有真实 CLI 可对照，最容易发生的事就是它被写成一副
 * "已经支持了"的样子。所以这里断言的是「未验证这件事有没有被记下来」。
 */

describe('第二个 runtime 的描述符（FR-CLI-47 的填空作业）', () => {
  test('★ 已编译进 runtime 表，getRuntimeDescriptor 能取到（不是插件注册表）', () => {
    const viaKey = getRuntimeDescriptor('generic')
    assert.equal(viaKey.key, 'generic')
    assert.ok(knownRuntimeKeys().includes('generic'), '表里必须有这一行')
    assert.ok(knownRuntimeKeys().includes('claude'), '第一个 runtime 不得被挤掉')
    assert.deepEqual(genericDescriptor(), loadRuntimeDescriptor(viaKey), '两份视图必须一致')
  })

  test('一个新 runtime 要回答的问题，一个都不少', () => {
    const d = GENERIC_DESCRIPTOR
    assert.equal(typeof d.command, 'string')
    assert.ok(d.command.length > 0)
    assert.ok(d.skills, '技能怎么投递（这个 CLI 声明为"没有"）')
    assert.ok(d.protocol)
    assert.ok(d.family)
    assert.ok(d.resume.flag)
    assert.ok(d.promptDelivery)
    assert.ok(d.toolConfig)
    assert.ok(d.disableSwitch)
    assert.ok(d.baseArgs.length > 0)
    assert.ok(Object.keys(d.blockedArgs).length > 0)
  })

  test('★ 证据等级是 provisional —— 未验证的 runtime 不得冒充已验证', () => {
    assert.equal(genericEvidence(), 'provisional')
    assert.equal(getRuntimeDescriptor('claude').evidence, 'verified', 'claude 是唯一样本')
    assert.ok((GENERIC_DESCRIPTOR.evidenceNote ?? '').length > 20, '必须说清缺什么证据')
  })

  test('★ 未验证字段清单非空且逐条可读 —— 首次接入真实 CLI 时它是一份勾选清单', () => {
    const fields = unverifiedFields()
    assert.ok(fields.length >= 8)
    // ⚠️ 清单里是**字段路径**（`managedFlags.model` 这种），不是中文描述。
    //    一开始想把描述也塞进同一份清单，后来放弃了：一份数据只承担一件事，
    //    既要机器可读又要人可读，最后会变成两边都不好用。所以：
    //    清单给机器（逐条可勾选），`evidenceNote` 给人（说明缺什么证据）。
    assert.ok(fields.some((f) => f === 'command'))
    assert.ok(fields.some((f) => f.includes('managedFlags')), '旗标拼写是最容易错的')
    assert.ok(fields.some((f) => f.includes('stream-parser')), '事件名与字段名都要核对')
    for (const field of fields) {
      assert.ok(field.trim().length > 0, '清单条目不得是空串')
      assert.equal(field.includes(' '), false, '条目是字段路径，不该有空格')
    }
  })

  test('★ evidenceNote 用中文说清缺什么证据（给人看的那一半）', () => {
    const note = GENERIC_DESCRIPTOR.evidenceNote ?? ''
    assert.match(note, /未对照真实 CLI 验证/)
    assert.match(note, /命令名/)
    assert.match(note, /NDJSON/)
    assert.match(note, /假可执行文件/, '要说清"代码已验证"与"字段名未验证"是两件事')
  })

  test('★ 未启用的注入位必须写明原因，且标注为未验证', () => {
    assert.equal(GENERIC_DESCRIPTOR.toolConfig.enabled, false)
    assert.equal(GENERIC_DESCRIPTOR.disableSwitch.enabled, false)
    assert.ok((GENERIC_DESCRIPTOR.toolConfig.reason ?? '').length > 0)
    assert.ok((GENERIC_DESCRIPTOR.disableSwitch.reason ?? '').length > 0)
    assert.equal(GENERIC_DESCRIPTOR.toolConfig.evidence, 'provisional')
    assert.equal(GENERIC_DESCRIPTOR.disableSwitch.evidence, 'provisional')
  })

  test('★ rejectDetectable 为 false —— 测不出"恢复被拒"时不许声明能测', () => {
    assert.equal(GENERIC_DESCRIPTOR.resume.rejectDetectable, false)
    assert.equal(loadCliRuntimeDescriptor('claude').resume.rejectDetectable, true)
  })

  test('基础参数包含非交互与 NDJSON 输出，且禁用交互式提问', () => {
    const a = GENERIC_DESCRIPTOR.baseArgs
    assert.ok(a.includes('--non-interactive'))
    assert.deepEqual(a.slice(a.indexOf('--output'), a.indexOf('--output') + 2), ['--output', 'ndjson'])
    assert.ok(a.includes('--no-ask-user'), '与 claude 同源的理由：非交互下提问只会得到空答案')
  })

  test('★ 禁改表覆盖任务输入与输出格式 —— 使用者不得替换整个任务的 prompt', () => {
    assert.equal(GENERIC_BLOCKED_ARGS['--prompt'], 'withValue')
    assert.equal(GENERIC_BLOCKED_ARGS['--output'], 'withValue')
    assert.equal(GENERIC_BLOCKED_ARGS['--non-interactive'], 'standalone')
    assert.equal(GENERIC_BLOCKED_ARGS['-y'], 'standalone')
  })

  test('受管旗标名与 claude 不同 —— 证明 argv 组装没有写死某一个 CLI', () => {
    const flags = loadRuntimeDescriptor(GENERIC_DESCRIPTOR).managedFlags!
    assert.equal(flags.model, '-m')
    assert.equal(flags.maxTurns, '--max-steps')
    assert.equal(flags.resume, GENERIC_DESCRIPTOR.resume.flag, 'resume 两个视图必须对齐')
    assert.equal(loadRuntimeDescriptor('claude').managedFlags!.model, '--model')
  })

  test('prompt 投递方式是一条数据（argv），不是后端里的 if', () => {
    assert.equal(genericPromptDelivery(), 'argv')
    assert.equal(getRuntimeDescriptor('claude').promptDelivery, 'stdin-ndjson')
  })

  test('凭据只走环境变量名，不进表、不进 argv', () => {
    assert.equal(GENERIC_CLI_FACTS.apiKeyEnv, 'AGENT_CLI_API_KEY')
    // 描述表里不得出现任何"密钥"类的旗标——命令行参数会出现在进程列表与审计记录里
    const allArgs = [...GENERIC_DESCRIPTOR.baseArgs, ...Object.keys(GENERIC_BLOCKED_ARGS)]
    assert.equal(
      allArgs.some((a) => /key|token|secret/i.test(a)),
      false,
      '凭据不得出现在命令行',
    )
  })

  test('★ 第二个 runtime 的基础参数是真实的：buildArgv 用它的旗标名拼参数', () => {
    const { argv } = buildArgv({
      runtime: GENERIC_DESCRIPTOR,
      model: 'gpt-5',
      maxTurns: 4,
      resumeSessionId: 'sess-1',
      userArgs: [],
    })
    assert.ok(argv.includes('-m'))
    assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5')
    assert.equal(argv[argv.indexOf('--max-steps') + 1], '4')
    assert.equal(argv[argv.indexOf('--resume-session') + 1], 'sess-1')
  })

  test('★ 同一个 buildArgv 在 claude 上仍然拼出 --model / --max-turns（行为不变）', () => {
    const { argv } = buildArgv({
      runtime: getRuntimeDescriptor('claude'),
      model: 'claude-sonnet-4-5',
      maxTurns: 4,
      resumeSessionId: 'sess-1',
      userArgs: [],
    })
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-sonnet-4-5')
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '4')
    assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-1')
  })
})
