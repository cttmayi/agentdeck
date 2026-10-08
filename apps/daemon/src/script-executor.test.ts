import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  toolActionDefinitions,
  mergeActionParams,
  type ActionFacts,
  type Store,
  type ToolActionDefinition,
} from '@agentdeck/domain'
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type Action,
  type Run,
  type Tool,
  type ToolId,
  type WorkspaceId,
} from '@agentdeck/protocol'
import { ActionRunner } from './actions.ts'
import { ReviewCoordinator } from './review.ts'
import {
  ScriptExecutor,
  buildScriptEnv,
  findExecutable,
  missingInterpreterMessage,
  resolveCommand,
  type ScriptActionSpec,
  type ScriptExecutionRequest,
  type SpawnScript,
  type SpawnScriptInput,
} from './script-executor.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { resolveLocalToolPath, toToolRecord } from './tool-source.ts'

/**
 * 工具脚本执行器（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件里最重要的不是"happy path"
 * ══════════════════════════════════════════════════════════════════
 *
 * 执行器**所有**难查的问题都在异常路径上：超时留下的孤儿进程、stdout 不是
 * JSON 时那句无用的报错、把 daemon 的密钥顺手传给了第三方脚本、工作目录为
 * null 时脚本把文件写到 daemon 的安装目录里。所以这里的用例绝大多数是
 * "坏输入 ⇒ 明确的失败"，每条都钉住**失败原因里的那句话**。
 *
 * 起进程分两层：
 *   · **假 spawn** 覆盖每条异常路径（快、稳、不需要真的等超时）；
 *   · **一条真跑** `examples/tools/example-note` 的集成测试，钉住"约定真的
 *     能跑通"——它是唯一会真的启动 node 的地方。
 *
 * ⚠️ 临时目录一律走 `.cache/test-tmp`（`./testing/tmp.ts`），**不用
 *    `tmpdir()`**：仓库有一条机器检查守这条（`tests/test-safety.test.ts`）。
 */

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const WORKSPACE = 'ws-1' as WorkspaceId

interface FakeBehavior {
  stdout?: string
  stderr?: string
  code?: number | null
  /** 永不退出（测超时）。 */
  hang?: boolean
  /** 连 SIGKILL 都不理（测"等不到确认也必须返回"）。 */
  ignoreKill?: boolean
  /** 启动失败（ENOENT 之类）。 */
  error?: Error
}

interface FakeSpawn {
  spawn: SpawnScript
  calls: SpawnScriptInput[]
  stdin: () => string
  terminated: () => number
}

function fakeSpawn(behavior: FakeBehavior = {}): FakeSpawn {
  const calls: SpawnScriptInput[] = []
  let stdin = ''
  let terminated = 0

  const spawn: SpawnScript = (input) => {
    calls.push(input)
    let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
      resolveExit = r
    })

    if (behavior.error) {
      const err = behavior.error
      queueMicrotask(() => {
        input.onError(err)
        resolveExit({ code: null, signal: null })
      })
    } else if (!behavior.hang) {
      queueMicrotask(() => {
        if (behavior.stdout !== undefined) input.onStdout(behavior.stdout)
        if (behavior.stderr !== undefined) input.onStderr(behavior.stderr)
        resolveExit({ code: behavior.code ?? 0, signal: null })
      })
    }

    return {
      pid: 4242,
      writeStdin: (data) => {
        stdin += data
      },
      endStdin: () => {},
      terminate: () => {
        terminated += 1
        if (behavior.ignoreKill !== true) resolveExit({ code: null, signal: 'SIGKILL' })
      },
      exited,
    }
  }

  return {
    spawn,
    calls,
    stdin: () => stdin,
    terminated: () => terminated,
  }
}

const okStdout = JSON.stringify({ ok: true, detail: '做完了' })

function request(over: Partial<ScriptExecutionRequest> = {}): ScriptExecutionRequest {
  return {
    action: {
      type: 'example-note.append-note',
      slug: 'example-note',
      runtime: 'node',
      entry: 'scripts/note.mjs',
      timeoutMs: 5_000,
      dryRun: 'supported',
    },
    params: { text: '一句话', dir: '/work/x' },
    dryRun: false,
    context: { workdir: null, runId: 'run-1', workspaceId: String(WORKSPACE) },
    files: { 'scripts/note.mjs': '// 假脚本\n' },
    ...over,
  }
}

/** 起一个"什么都找不到"的 PATH 查询——用来断言 node 那条路**不查 PATH**。 */
const noLookup = async (): Promise<string | null> => {
  throw new Error('不该查 PATH')
}

// ─────────────────────────────────────────────────────────────
// 假 spawn：命令 / 参数 / cwd / env / stdin
// ─────────────────────────────────────────────────────────────

describe('传给脚本的东西：命令、参数、cwd、env、stdin', () => {
  test('★ node runtime 用 process.execPath（不查 PATH），入口作为单个参数', async () => {
    const tempRoot = await makeTempDir('exec-node')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())

      assert.equal(result.ok, true, result.detail)
      assert.equal(fake.calls.length, 1)
      const call = fake.calls[0]!
      assert.equal(call.command, process.execPath)
      assert.equal(call.args.length, 1)
      assert.match(call.args[0]!, /package[/\\]scripts[/\\]note\.mjs$/)
      assert.equal(result.exitCode, 0)
      // 这次 run 没有工作目录 ⇒ 原因里会补一句说明（同一句也解释了 cwd 落在哪）
      assert.match(result.detail, /^做完了/)
      assert.ok(result.durationMs >= 0)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ cwd 是这次 run 的工作目录（脚本往相对路径写东西要落在任务目录里）', async () => {
    const tempRoot = await makeTempDir('exec-cwd')
    const workdir = await makeTempDir('exec-work')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(
        request({ context: { workdir, runId: 'run-1', workspaceId: String(WORKSPACE) } }),
      )

      assert.equal(result.ok, true, result.detail)
      assert.equal(fake.calls[0]!.cwd, workdir)
      // 有工作目录时**不**加那句"退到临时目录"的说明
      assert.doesNotMatch(result.detail, /没有工作目录/)
    } finally {
      await cleanup(tempRoot)
      await cleanup(workdir)
    }
  })

  test('★ 没有工作目录 ⇒ 退到临时目录，并在结果里**说明**（不悄悄用 daemon 的 cwd）', async () => {
    const tempRoot = await makeTempDir('exec-noworkdir')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())

      const cwd = fake.calls[0]!.cwd
      assert.ok(cwd.startsWith(tempRoot), `cwd 应当落在临时目录里，实际 ${cwd}`)
      assert.match(result.detail, /还没有工作目录/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 工作目录不存在 ⇒ 明确失败，且**不换一个目录**硬跑', async () => {
    const tempRoot = await makeTempDir('exec-badworkdir')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(
        request({
          context: { workdir: join(tempRoot, '不存在'), runId: 'run-1', workspaceId: String(WORKSPACE) },
        }),
      )

      assert.equal(result.ok, false)
      assert.match(result.detail, /工作目录不可用/)
      assert.match(result.detail, /不会替它换一个目录/)
      assert.equal(fake.calls.length, 0, '工作目录不可用时不该起进程')
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 环境走白名单：daemon 的密钥与 NODE_OPTIONS 不下传，HOME 指到临时目录', async () => {
    const tempRoot = await makeTempDir('exec-env')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({
        tempRoot,
        spawn: fake.spawn,
        findExecutable: noLookup,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'zh_CN.UTF-8',
          TZ: 'Asia/Shanghai',
          // 这三样**一个都不该**出现在脚本的环境里
          AGENTDECK_GITHUB_TOKEN: 'ghp_secret',
          NODE_OPTIONS: '--require /tmp/evil.js',
          HOME: '/Users/someone',
        },
      })

      await executor.execute(request())

      const env = fake.calls[0]!.env
      assert.equal(env['PATH'], '/usr/bin:/bin')
      assert.equal(env['LANG'], 'zh_CN.UTF-8')
      assert.equal(env['TZ'], 'Asia/Shanghai')
      assert.equal(env['AGENTDECK_GITHUB_TOKEN'], undefined)
      assert.equal(env['NODE_OPTIONS'], undefined)
      assert.notEqual(env['HOME'], '/Users/someone')
      assert.ok(env['HOME']!.startsWith(tempRoot), 'HOME 应当指到本次执行的临时目录')
      assert.ok(env['TMPDIR']!.startsWith(tempRoot))
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('stdin 是一份 JSON：{ action, params, dryRun, context }（与示例脚本的约定一致）', async () => {
    const tempRoot = await makeTempDir('exec-stdin')
    const workdir = await makeTempDir('exec-stdin-work')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      await executor.execute(
        request({
          params: { text: '你好', dir: workdir },
          context: { workdir, runId: 'run-42', workspaceId: String(WORKSPACE) },
        }),
      )

      const sent = JSON.parse(fake.stdin()) as Record<string, unknown>
      assert.equal(sent['action'], 'example-note.append-note')
      assert.deepEqual(sent['params'], { text: '你好', dir: workdir })
      assert.equal(sent['dryRun'], false)
      assert.deepEqual(sent['context'], {
        workdir,
        runId: 'run-42',
        workspaceId: String(WORKSPACE),
      })
    } finally {
      await cleanup(tempRoot)
      await cleanup(workdir)
    }
  })

  test('决定的环境不含 NODE_OPTIONS（它可以 --require 任意模块）', () => {
    const env = buildScriptEnv({
      source: { PATH: '/bin', NODE_OPTIONS: '--require /tmp/x.js', LD_PRELOAD: '/tmp/y.so' },
      tempDir: '/tmp/exec',
      runtime: 'node',
    })
    assert.equal(env['NODE_OPTIONS'], undefined)
    assert.equal(env['LD_PRELOAD'], undefined)
    assert.equal(env['HOME'], '/tmp/exec')
  })
})

// ─────────────────────────────────────────────────────────────
// 假 spawn：物化与路径安全
// ─────────────────────────────────────────────────────────────

describe('物化：包内容进临时目录，且不许跑出目录', () => {
  test('保持包的相对结构；HOME 与 scratch 目录都在本次执行的目录里', async () => {
    const tempRoot = await makeTempDir('exec-materialize')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({
        tempRoot,
        spawn: fake.spawn,
        findExecutable: noLookup,
        keepTempDir: true,
      })

      const result = await executor.execute(
        request({
          files: {
            'scripts/note.mjs': '// 入口\n',
            'lib/helper.txt': '支持文件\n',
          },
        }),
      )
      assert.equal(result.ok, true, result.detail)

      const entry = fake.calls[0]!.args[0]!
      const packageDir = dirname(dirname(entry))
      const execDir = dirname(packageDir)
      assert.ok(execDir.startsWith(tempRoot))
      assert.equal(await readFile(entry, 'utf8'), '// 入口\n')
      assert.equal(await readFile(join(packageDir, 'lib/helper.txt'), 'utf8'), '支持文件\n')
      assert.ok((await stat(join(execDir, 'home'))).isDirectory())
      assert.ok((await stat(join(execDir, 'work'))).isDirectory())

      await rm(execDir, { recursive: true, force: true })
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('默认跑完就把临时目录删掉（里面既有第三方代码也有脚本的 HOME）', async () => {
    const tempRoot = await makeTempDir('exec-cleanup')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })
      await executor.execute(request())

      const entry = fake.calls[0]!.args[0]!
      await assert.rejects(() => stat(entry), '临时目录应当已经被删掉')
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 文件路径里有 `..` ⇒ 拒，且不起进程（纵深防御）', async () => {
    const tempRoot = await makeTempDir('exec-traversal')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(
        request({ files: { 'scripts/note.mjs': '// ok\n', '../evil.mjs': '// 越界\n' } }),
      )

      assert.equal(result.ok, false)
      assert.match(result.detail, /不许跑出包目录/)
      assert.equal(fake.calls.length, 0)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 入口写成绝对路径 ⇒ 拒', async () => {
    const tempRoot = await makeTempDir('exec-absentry')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(
        request({
          action: { ...request().action, entry: '/etc/passwd' },
          files: { '/etc/passwd': 'x' },
        }),
      )
      assert.equal(result.ok, false)
      assert.match(result.detail, /必须是\*\*相对\*\*包根的路径/)
      assert.equal(fake.calls.length, 0)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 清单声明的入口不在包里 ⇒ 说清"包是坏的"（而不是让 spawn 报 ENOENT）', async () => {
    const tempRoot = await makeTempDir('exec-missingentry')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request({ files: { 'other.mjs': '// 别的文件\n' } }))
      assert.equal(result.ok, false)
      assert.match(result.detail, /没有清单声明的入口文件/)
      assert.equal(fake.calls.length, 0)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 临时目录的父目录必须是绝对路径', async () => {
    const fake = fakeSpawn({ stdout: okStdout })
    const executor = new ScriptExecutor({
      tempRoot: 'relative/tmp',
      spawn: fake.spawn,
      findExecutable: noLookup,
    })
    const result = await executor.execute(request())
    assert.equal(result.ok, false)
    assert.match(result.detail, /必须是绝对路径/)
    assert.equal(fake.calls.length, 0)
  })
})

// ─────────────────────────────────────────────────────────────
// 假 spawn：每一条失败路径
// ─────────────────────────────────────────────────────────────

describe('失败路径：非 0 退出 / 不是 JSON / 超时 / 起不来', () => {
  test('★ stdout 不是 JSON ⇒ 失败，并把 stdout 的尾部放进原因里', async () => {
    const tempRoot = await makeTempDir('exec-badjson')
    try {
      const fake = fakeSpawn({ stdout: '这不是 JSON\n' })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())
      assert.equal(result.ok, false)
      assert.match(result.detail, /stdout 不是合法 JSON/)
      assert.match(result.detail, /这不是 JSON/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ stdout 很长时只贴尾部若干字符（原因不能变成一整篇输出）', async () => {
    const tempRoot = await makeTempDir('exec-longstdout')
    try {
      const fake = fakeSpawn({ stdout: `${'x'.repeat(5_000)}尾巴标记` })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())
      assert.equal(result.ok, false)
      assert.match(result.detail, /尾巴标记/)
      assert.ok(result.detail.length < 3_000, `原因不该超过约 2000 字符，实际 ${result.detail.length}`)
      assert.equal(result.detail.includes('x'.repeat(2_500)), false)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('stdout 是 JSON 但不是对象 / 是空的 ⇒ 失败并说清约定', async () => {
    const tempRoot = await makeTempDir('exec-shape')
    try {
      const cases: Array<[string, RegExp]> = [
        ['[1,2,3]', /必须是一个 JSON 对象/],
        ['"一句话"', /必须是一个 JSON 对象/],
        ['   \n', /没有往 stdout 写任何东西/],
      ]
      for (const [stdout, pattern] of cases) {
        const fake = fakeSpawn({ stdout })
        const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })
        const result = await executor.execute(request())
        assert.equal(result.ok, false, `${stdout} 应当失败`)
        assert.match(result.detail, pattern)
      }
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 非 0 退出码 ⇒ 失败；脚本自己的话与 stderr 尾部都带上', async () => {
    const tempRoot = await makeTempDir('exec-exitcode')
    try {
      const fake = fakeSpawn({
        code: 3,
        stdout: JSON.stringify({ ok: false, detail: '目录不存在' }),
        stderr: 'ENOENT: no such dir\n',
      })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())
      assert.equal(result.ok, false)
      assert.equal(result.exitCode, 3)
      assert.equal(result.timedOut, undefined)
      assert.match(result.detail, /非 0 退出码结束/)
      assert.match(result.detail, /exitCode=3/)
      assert.match(result.detail, /目录不存在/)
      assert.match(result.detail, /ENOENT/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('脚本说 ok:false ⇒ 失败（退出码是 0 也一样）', async () => {
    const tempRoot = await makeTempDir('exec-okfalse')
    try {
      const fake = fakeSpawn({ stdout: JSON.stringify({ ok: false, detail: 'text 是空的' }) })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())
      assert.equal(result.ok, false)
      assert.match(result.detail, /脚本报告失败：text 是空的/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('stdout 里没有 ok 字段 ⇒ 失败（约定是 { ok, detail }）', async () => {
    const tempRoot = await makeTempDir('exec-nook')
    try {
      const fake = fakeSpawn({ stdout: JSON.stringify({ detail: '我做了' }) })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())
      assert.equal(result.ok, false)
      assert.match(result.detail, /没有 ok 字段/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 超时 ⇒ 杀掉整个进程组，结果里 timedOut=true 且原因明确', async () => {
    const tempRoot = await makeTempDir('exec-timeout')
    try {
      const fake = fakeSpawn({ hang: true })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(
        request({ action: { ...request().action, timeoutMs: 30 } }),
      )

      assert.equal(result.ok, false)
      assert.equal(result.timedOut, true)
      assert.equal(fake.terminated(), 1, '超时必须终止进程组（否则留下孤儿进程）')
      assert.match(result.detail, /执行超时/)
      assert.match(result.detail, /已终止整个进程组/)
      assert.match(result.detail, /30ms/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 连 SIGKILL 都不理的进程：平台也必须返回，不把判决卡死', async () => {
    const tempRoot = await makeTempDir('exec-stubborn')
    try {
      const fake = fakeSpawn({ hang: true, ignoreKill: true })
      const executor = new ScriptExecutor({
        tempRoot,
        spawn: fake.spawn,
        findExecutable: noLookup,
        terminateGraceMs: 20,
      })

      const result = await executor.execute(
        request({ action: { ...request().action, timeoutMs: 10 } }),
      )

      assert.equal(result.timedOut, true)
      assert.equal(result.ok, false)
      assert.match(result.detail, /尚未确认它已退出/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 进程起不来 ⇒ 报出真正的病因（哪个命令、为什么），而不是含糊的失败', async () => {
    const tempRoot = await makeTempDir('exec-spawnfail')
    try {
      const fake = fakeSpawn({ error: new Error('spawn ENOENT') })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request())
      assert.equal(result.ok, false)
      assert.match(result.detail, /无法启动/)
      assert.match(result.detail, /ENOENT/)
      assert.equal(result.exitCode, null)
    } finally {
      await cleanup(tempRoot)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// dry-run 语义
// ─────────────────────────────────────────────────────────────

describe('dry-run：照样跑脚本，但不支持的动作一步都不许跑', () => {
  test('★ dryRun: true 时**仍然运行脚本**，并把 dryRun: true 交给它', async () => {
    const tempRoot = await makeTempDir('exec-dryrun')
    try {
      const fake = fakeSpawn({ stdout: JSON.stringify({ ok: true, detail: '会写一行（dry-run）' }) })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(request({ dryRun: true }))

      assert.equal(result.ok, true, result.detail)
      assert.equal(fake.calls.length, 1, 'dry-run 也要真的跑脚本（约定是脚本自己保证不改）')
      assert.equal((JSON.parse(fake.stdin()) as Record<string, unknown>)['dryRun'], true)
      assert.match(result.detail, /dry-run/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('★ 动作声明 dryRun: "unsupported" ⇒ 平台拒绝，且**不起进程**', async () => {
    const tempRoot = await makeTempDir('exec-dryrun-unsupported')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })

      const result = await executor.execute(
        request({
          dryRun: true,
          action: { ...request().action, dryRun: 'unsupported' },
        }),
      )

      assert.equal(result.ok, false)
      assert.match(result.detail, /不支持 dry-run/)
      assert.equal(fake.calls.length, 0, '不支持 dry-run 的动作在演练模式下一步都不该跑')
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('非演练时可以跑一个不支持 dry-run 的动作（拒绝只针对 dry-run）', async () => {
    const tempRoot = await makeTempDir('exec-unsupported-real')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({ tempRoot, spawn: fake.spawn, findExecutable: noLookup })
      const result = await executor.execute(
        request({ dryRun: false, action: { ...request().action, dryRun: 'unsupported' } }),
      )
      assert.equal(result.ok, true, result.detail)
      assert.equal(fake.calls.length, 1)
    } finally {
      await cleanup(tempRoot)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// runtime 解析
// ─────────────────────────────────────────────────────────────

describe('runtime → 解释器（只有白名单里的三种）', () => {
  test('node 用 process.execPath，不查 PATH', async () => {
    const resolved = await resolveCommand('node', noLookup)
    assert.deepEqual(resolved, { ok: true, command: process.execPath })
  })

  test('可以钉死 node 可执行文件（部署/测试要换解释器时不用改 PATH）', async () => {
    const tempRoot = await makeTempDir('exec-nodepath')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({
        tempRoot,
        spawn: fake.spawn,
        findExecutable: noLookup,
        nodePath: '/opt/other/bin/node',
      })
      await executor.execute(request())
      assert.equal(fake.calls[0]!.command, '/opt/other/bin/node')
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('shell / python3 从 PATH 找；找不到时说清**装什么**', async () => {
    const missing = await resolveCommand('python3', async () => null)
    assert.equal(missing.ok, false)
    assert.ok(!missing.ok)
    assert.match(missing.detail, /没找到 python3/)
    assert.match(missing.detail, /apt install python3|brew install python3/)

    const shell = await resolveCommand('shell', async () => null)
    assert.ok(!shell.ok)
    assert.match(shell.detail, /没找到 bash/)

    const found = await resolveCommand('shell', async (c) => `/usr/local/bin/${c}`)
    assert.deepEqual(found, { ok: true, command: '/usr/local/bin/bash' })
  })

  test('★ Windows：python3 找不到时退一步找 python（官方安装器给的就是 python.exe）', async () => {
    const looked: string[] = []
    const found = await resolveCommand(
      'python3',
      async (c) => {
        looked.push(c)
        return c === 'python' ? 'C:\\Python312\\python.exe' : null
      },
      process.execPath,
      'win32',
    )
    assert.deepEqual(looked, ['python3', 'python'], '两个都要找，顺序是先 python3 再 python')
    assert.deepEqual(found, { ok: true, command: 'C:\\Python312\\python.exe' })
  })

  test('★ 非 Windows 上**不会**去试 python（行为与改动前一致）', async () => {
    const looked: string[] = []
    const missing = await resolveCommand('python3', async (c) => {
      looked.push(c)
      return null
    }, process.execPath, 'darwin')
    assert.deepEqual(looked, ['python3'])
    assert.ok(!missing.ok)
  })

  test('★ 失败文案按平台给能照做的指令（Windows 上要提 winget/Git Bash）', () => {
    const winShell = missingInterpreterMessage('shell', 'win32')
    assert.match(winShell, /winget install Git\.Git/)
    assert.match(winShell, /Git Bash|WSL/)
    assert.ok(!/apt install/.test(winShell), '别给 Windows 使用者一条 Debian 的命令')

    const winPy = missingInterpreterMessage('python3', 'win32')
    assert.match(winPy, /winget install Python/)
    assert.match(winPy, /python\.exe/, '要说清 Windows 上那个可执行文件叫什么')
    assert.match(winPy, /也试过 python/, '要说明平台已经退一步找过 python 了')

    // 非 Windows 的老文案保持（有既有判据盯着它）
    assert.match(missingInterpreterMessage('python3', 'linux'), /apt install python3/)
    assert.match(missingInterpreterMessage('shell', 'darwin'), /macOS 自带/)
  })

  test('shell 的动作：命令是 bash，入口作为单个参数（不拼命令行）', async () => {
    const tempRoot = await makeTempDir('exec-shell')
    try {
      const fake = fakeSpawn({ stdout: okStdout })
      const executor = new ScriptExecutor({
        tempRoot,
        spawn: fake.spawn,
        findExecutable: async (c) => `/fake/bin/${c}`,
      })
      const result = await executor.execute(
        request({ action: { ...request().action, runtime: 'shell', entry: 'run.sh' }, files: { 'run.sh': 'echo hi\n' } }),
      )
      assert.equal(result.ok, true, result.detail)
      assert.equal(fake.calls[0]!.command, '/fake/bin/bash')
      assert.equal(fake.calls[0]!.args.length, 1, '入口只能是一个参数，不许拼进命令行')
      assert.match(fake.calls[0]!.args[0]!, /run\.sh$/)
    } finally {
      await cleanup(tempRoot)
    }
  })

  test('findExecutable 真的按 PATH 找可执行文件', async () => {
    const dir = await makeTempDir('exec-path')
    const empty = await makeTempDir('exec-path-empty')
    try {
      await writeFile(join(dir, 'my-tool'), '#!/bin/sh\necho hi\n', 'utf8')
      await chmod(join(dir, 'my-tool'), 0o755)

      assert.equal(await findExecutable('my-tool', { PATH: dir }), join(dir, 'my-tool'))
      assert.equal(await findExecutable('my-tool', { PATH: empty }), null)
      // 存在但不可执行 ⇒ 不算找到
      await chmod(join(dir, 'my-tool'), 0o644)
      assert.equal(await findExecutable('my-tool', { PATH: dir }), null)
    } finally {
      await cleanup(dir)
      await cleanup(empty)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// 真跑：examples/tools/example-note
// ─────────────────────────────────────────────────────────────

/** 真跑那条要用的动作规格（与 daemon 侧装配时取的是同一组字段）。 */
function specOf(definition: ToolActionDefinition): ScriptActionSpec {
  return {
    type: definition.type,
    slug: definition.provider.slug,
    runtime: definition.runtime,
    entry: definition.entry,
    timeoutMs: definition.timeoutMs,
    dryRun: definition.dryRun,
  }
}

describe('★ 真跑示例工具包 examples/tools/example-note', () => {
  test('append-note 真的写了 NOTES.md；dry-run 时没有写；clean-notes 用第二个入口真的删了', async () => {
    const tempRoot = await makeTempDir('example-exec')
    const workdir = await makeTempDir('example-work')
    try {
      // 走**安装时的那条读包路径**（`tool-source.ts`）：这样这条测试同时钉住了
      // "清单声明的入口真的在包里"与"物化出来的包真的能跑"。
      const pkgDir = resolve(import.meta.dirname, '..', '..', '..', 'examples', 'tools', 'example-note')
      const pkg = await resolveLocalToolPath(pkgDir)
      const tool = toToolRecord(pkg, {
        id: 'tool-1' as ToolId,
        workspaceId: WORKSPACE,
        createdAt: 1,
        updatedAt: 1,
      })

      const definitions = toolActionDefinitions([tool])
      const append = definitions['example-note.append-note']
      const clean = definitions['example-note.clean-notes']
      assert.ok(append && clean, '示例包应当声明这两个动作')

      const facts: ActionFacts = {
        issueId: 'issue-1',
        runId: 'run-1',
        workspaceId: String(WORKSPACE),
        workdir,
      }
      const context = { workdir, runId: 'run-1', workspaceId: String(WORKSPACE) }
      const executor = new ScriptExecutor({ tempRoot }) // ★ 默认 spawn：真的启动 node

      const notesPath = join(workdir, 'NOTES.md')

      // ── ① 真跑：文件真的被写了 ──
      const appended = mergeActionParams(append, facts, { text: '第一条' })
      assert.ok(appended.ok, appended.ok ? '' : appended.issues.join('；'))
      const first = await executor.execute({
        action: specOf(append),
        params: appended.params,
        dryRun: false,
        context,
        files: tool.files,
      })
      assert.equal(first.ok, true, first.detail)
      assert.equal(first.exitCode, 0)
      assert.match(await readFile(notesPath, 'utf8'), /第一条/)

      // ── ② dry-run：脚本被跑了，但**没有**写 ──
      const dryMerged = mergeActionParams(append, facts, { text: '第二条' })
      assert.ok(dryMerged.ok)
      const dry = await executor.execute({
        action: specOf(append),
        params: dryMerged.params,
        dryRun: true,
        context,
        files: tool.files,
      })
      assert.equal(dry.ok, true, dry.detail)
      assert.match(dry.detail, /dry-run/)
      assert.match(dry.detail, /没有真的写/)
      const afterDry = await readFile(notesPath, 'utf8')
      assert.doesNotMatch(afterDry, /第二条/, 'dry-run 不许改文件')
      assert.match(afterDry, /第一条/)

      // ── ③ 另一个动作用它**自己的入口**（scripts/clean.mjs）──
      const cleaned = mergeActionParams(clean, facts, {})
      assert.ok(cleaned.ok)
      const removed = await executor.execute({
        action: specOf(clean),
        params: cleaned.params,
        dryRun: false,
        context,
        files: tool.files,
      })
      assert.equal(removed.ok, true, removed.detail)
      await assert.rejects(() => stat(notesPath), 'clean-notes 应当真的把文件删掉了')
    } finally {
      await cleanup(tempRoot)
      await cleanup(workdir)
    }
  })

  test('真跑：脚本自己的失败也如实传出来（空 text ⇒ 脚本说 ok:false）', async () => {
    const tempRoot = await makeTempDir('example-fail')
    const workdir = await makeTempDir('example-fail-work')
    try {
      const pkgDir = resolve(import.meta.dirname, '..', '..', '..', 'examples', 'tools', 'example-note')
      const pkg = await resolveLocalToolPath(pkgDir)
      const tool = toToolRecord(pkg, {
        id: 'tool-1' as ToolId,
        workspaceId: WORKSPACE,
        createdAt: 1,
        updatedAt: 1,
      })
      const append = toolActionDefinitions([tool])['example-note.append-note']!
      const executor = new ScriptExecutor({ tempRoot })

      const merged = mergeActionParams(
        append,
        { issueId: null, runId: 'run-1', workspaceId: String(WORKSPACE), workdir },
        { text: '   ' },
      )
      assert.ok(merged.ok)

      const result = await executor.execute({
        action: specOf(append),
        params: merged.params,
        dryRun: false,
        context: { workdir, runId: 'run-1', workspaceId: String(WORKSPACE) },
        files: tool.files,
      })

      assert.equal(result.ok, false)
      assert.match(result.detail, /脚本报告失败：text 是空的/)
    } finally {
      await cleanup(tempRoot)
      await cleanup(workdir)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// ActionRunner：工具动作走脚本执行器（D41 之后**只有**这一条路）
// ─────────────────────────────────────────────────────────────
//
// 这几条用例**故意**放在这个文件里：它是这次工作面上唯一归属明确的
// daemon 侧测试文件（`e2e.test.ts` 等由别的工作面在用）。它们守的是
// `apps/daemon/src/actions.ts` 里的执行路径——解析定义 → 校验 → 幂等 →
// 绑定参数 → 脚本执行器 → 记状态与通知。
//
// ⚠️ D41 之前这里叫"内置走 switch、第三方走执行器"：**分派**本身已经没了，
//    内置动作（`comment.create` / `issue.update_status` / …）连同那六个 `case`
//    一起删除，所以现在没有"走哪一边"可判——只剩工具动作这一条路。

interface FakeStore {
  store: Store
  actions: Action[]
  verdicts: Array<{ id: string; status: string }>
  audits: unknown[]
  transitions: string[]
  /** 每次状态转移带上的补丁（result / error / finishedAt）。 */
  patches: Array<Record<string, unknown>>
  inbox: Array<{ title: string; type: string }>
  comments: unknown[]
}

function fakeStore(input: {
  tools?: Tool[]
  run?: Partial<Run> | null
  failListTools?: boolean
  existing?: Action | null
}): FakeStore {
  const actions: Action[] = []
  const verdicts: Array<{ id: string; status: string }> = []
  const audits: unknown[] = []
  const transitions: string[] = []
  const patches: Array<Record<string, unknown>> = []
  const inbox: Array<{ title: string; type: string }> = []
  const comments: unknown[] = []

  const store = {
    async getRun() {
      return input.run ?? null
    },
    async listTools() {
      if (input.failListTools === true) throw new Error('存储打不开')
      return input.tools ?? []
    },
    async findActionByIdempotencyKey() {
      return input.existing ?? null
    },
    async insertAction(action: Action) {
      actions.push(action)
    },
    async transitionAction(_id: string, expect: string, next: string, patch?: Record<string, unknown>) {
      transitions.push(`${expect}->${next}`)
      if (patch !== undefined) patches.push(patch)
      return true
    },
    async appendInboxItem(item: { title: string; type: string }) {
      inbox.push(item)
    },
    async insertComment(comment: unknown) {
      comments.push(comment)
    },
    async insertVerdict(verdict: { id: string; status: string }) {
      verdicts.push({ id: verdict.id, status: verdict.status })
    },
    async transitionVerdict(_id: string, expect: string, next: string) {
      verdicts.push({ id: 'transition', status: `${expect}->${next}` })
      return true
    },
    async appendAudit(record: unknown) {
      audits.push(record)
    },
  } as unknown as Store

  return { store, actions, verdicts, audits, transitions, patches, inbox, comments }
}

function toolRecord(): Tool {
  const manifest = {
    schema: 'agentdeck/tool@1',
    slug: 'example-note',
    name: '示例工具',
    version: '1.0.0',
    description: '',
    runtime: 'node' as const,
    entry: 'scripts/note.mjs',
    actions: [
      {
        name: 'append-note',
        summary: '追加一行',
        reversible: true,
        dryRun: 'supported' as const,
        timeoutMs: 10_000,
        params: {
          bound: { dir: { from: 'workdir' as const } },
          open: { text: { type: 'string' as const, max: 100, required: true } },
        },
      },
      {
        name: 'unsafe-clean',
        summary: '不支持 dry-run 的动作',
        reversible: false,
        dryRun: 'unsupported' as const,
        timeoutMs: 10_000,
        params: { bound: { dir: { from: 'workdir' as const } }, open: {} },
      },
    ],
  }

  return {
    id: 'tool-1' as ToolId,
    workspaceId: WORKSPACE,
    slug: 'example-note',
    name: '示例工具',
    description: '',
    version: '1.0.0',
    manifest,
    files: { 'scripts/note.mjs': '// noop\n' },
    docs: '',
    source: 'local',
    sourceRef: 'path:/tmp/example-note',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Tool
}

const run: Partial<Run> = {
  id: 'run-1' as Run['id'],
  workspaceId: WORKSPACE,
  subject: { type: 'issue', id: 'issue-1' },
  workDir: '/work/run-1',
}

describe('ActionRunner：工具动作交给脚本执行器（动作只有这一种，D41）', () => {
  test('★ 没注入执行器时第三方动作明确失败（不静默跳过）', async () => {
    const fake = fakeStore({ tools: [toolRecord()], run })
    const runner = new ActionRunner({ store: fake.store })

    const result = await runner.execute({
      ref: { type: 'example-note.append-note', params: { text: 'x' } } as never,
      workspaceId: WORKSPACE,
      verdictId: 'v1' as never,
      runId: 'run-1' as never,
    })

    assert.equal(result.action.status, 'failed')
    assert.match(result.action.error ?? '', /没有注入脚本执行器/)
    assert.equal(fake.inbox.length, 1, '失败必须进通知（FR-ACTION-08）')
  })

  test('★ 第三方动作：绑定值由平台注入，脚本拿到的是合并后的参数', async () => {
    const fake = fakeStore({ tools: [toolRecord()], run })
    const calls: ScriptExecutionRequest[] = []
    const runner = new ActionRunner({
      store: fake.store,
      executeToolScript: async (req) => {
        calls.push(req)
        return { ok: true, detail: '写好了', exitCode: 0, durationMs: 3 }
      },
    })

    const result = await runner.execute({
      ref: { type: 'example-note.append-note', params: { text: '一句话' } } as never,
      workspaceId: WORKSPACE,
      verdictId: 'v1' as never,
      runId: 'run-1' as never,
    })

    assert.equal(result.action.status, 'executed')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.params, { text: '一句话', dir: '/work/run-1' })
    assert.equal(calls[0]!.context.workdir, '/work/run-1')
    assert.equal(calls[0]!.context.runId, 'run-1')
    assert.equal(calls[0]!.action.type, 'example-note.append-note')
    assert.equal(calls[0]!.action.entry, 'scripts/note.mjs')
    assert.ok('scripts/note.mjs' in calls[0]!.files, '执行器要拿到这个包的文件集合')
    // 记录里存的是**最终参数**（含平台绑定的那份）
    assert.deepEqual(fake.actions[0]!.params, { text: '一句话', dir: '/work/run-1' })
    assert.deepEqual(fake.transitions, ['proposed->auto_approved', 'auto_approved->executing', 'executing->executed'])
  })

  test('★★ 整条链：判决 → 平台解析（tools）→ 注入绑定值 → 脚本被执行 → 动作记录', async () => {
    const tempRoot = await makeTempDir('chain')
    // ★ 工作目录必须**真的存在**：执行器在起进程之前会查一次，不存在就明确
    //   拒绝（而不是退到别的目录去跑，那会让脚本改到错的地方）。
    const workdir = await makeTempDir('chain-work')
    try {
      const fake = fakeStore({ tools: [toolRecord()], run: { ...run, workDir: workdir } })
      const spawn = fakeSpawn({ stdout: JSON.stringify({ ok: true, detail: '写好了' }) })
      const scriptExecutor = new ScriptExecutor({
        tempRoot,
        spawn: spawn.spawn,
        findExecutable: noLookup,
      })
      const actions = new ActionRunner({
        store: fake.store,
        executeToolScript: (req) => scriptExecutor.execute(req),
      })
      const coordinator = new ReviewCoordinator({ store: fake.store, actions })

      const verdict = {
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        confidence: 0.9,
        findings: [],
        // ★ 模型只给开放参数；`dir` 是绑定参数，它看不见也填不了
        action: { type: 'example-note.append-note', params: { text: '来自判决的一句话' } },
        escalateReason: null,
      }
      const output = `结论：\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(verdict)}\n${VERDICT_FENCE_END}\n`

      const handling = await coordinator.handle({
        run: {
          ...run,
          workDir: workdir,
          id: 'run-1',
          agentId: 'agent-1',
          subject: { type: 'issue', id: 'issue-1' },
        } as never,
        workspaceId: WORKSPACE,
        output,
        // 标准里写的白名单 + 同一份已安装工具清单
        allowedActions: ['example-note.append-note'],
        tools: [toolRecord()],
        invalidAttempts: 0,
        inputBlobRefs: [],
        skillRefs: [],
        modelId: 'fake-model',
        promptHash: null,
        argv: ['claude', '-p'],
        runtimeDescriptorKey: 'claude',
        cliVersion: '0.0.0-fake',
        usage: null,
      })

      // ① 判决被判成 act（而不是"未知动作类型"）
      assert.equal(handling.decision.kind, 'act')
      // ② 动作真的记下来了，且是**命名空间名**
      assert.equal(fake.actions.length, 1)
      assert.equal(fake.actions[0]!.type, 'example-note.append-note')
      assert.equal(fake.actions[0]!.status, 'proposed')
      // ③ 执行器拿到的参数 = open（模型给的）+ bound（平台按事实注入的）
      assert.equal(spawn.calls.length, 1)
      const sent = JSON.parse(spawn.stdin()) as Record<string, unknown>
      assert.deepEqual(sent['params'], { text: '来自判决的一句话', dir: workdir })
      assert.equal(sent['action'], 'example-note.append-note')
      // ④ 状态由平台写：执行中 → 已执行
      assert.deepEqual(fake.transitions, [
        'proposed->auto_approved',
        'auto_approved->executing',
        'executing->executed',
      ])
      // ⑤ 审计留痕
      assert.equal(fake.audits.length, 1)
      // ⑥ 动作记录里存的是**最终参数**（含平台绑的 dir）——审计要能回答
      //    "到底拿什么去执行的"
      assert.deepEqual(fake.actions[0]!.params, { text: '来自判决的一句话', dir: workdir })
    } finally {
      await cleanup(tempRoot)
      await cleanup(workdir)
    }
  })

  test('★ 未安装的第三方动作 ⇒ 抛"动作不合规"（走 invalid 路径，不静默忽略）', async () => {
    const fake = fakeStore({ tools: [], run })
    const runner = new ActionRunner({ store: fake.store })

    await assert.rejects(
      () =>
        runner.execute({
          ref: { type: 'ghost-pkg.do-thing', params: {} } as never,
          workspaceId: WORKSPACE,
          verdictId: 'v1' as never,
          runId: 'run-1' as never,
        }),
      /动作不合规：未知动作类型：ghost-pkg\.do-thing/,
    )
    assert.equal(fake.actions.length, 0, '不合规的判决不该留下动作记录')
  })

  test('读取已安装工具失败时，失败原因里说清是"读不到"', async () => {
    const fake = fakeStore({ failListTools: true, run })
    const runner = new ActionRunner({ store: fake.store })

    await assert.rejects(
      () =>
        runner.execute({
          ref: { type: 'example-note.append-note', params: { text: 'x' } } as never,
          workspaceId: WORKSPACE,
          verdictId: 'v1' as never,
          runId: 'run-1' as never,
        }),
      /读取已安装的工具包失败：存储打不开/,
    )
  })

  test('run 的 subject 不是 issue / 没有工作目录 ⇒ 绑定失败，动作不合规', async () => {
    const fake = fakeStore({
      tools: [toolRecord()],
      run: { ...run, subject: { type: 'report', id: 'r1' }, workDir: null },
    })
    const runner = new ActionRunner({ store: fake.store })

    await assert.rejects(
      () =>
        runner.execute({
          ref: { type: 'example-note.append-note', params: { text: 'x' } } as never,
          workspaceId: WORKSPACE,
          verdictId: 'v1' as never,
          runId: 'run-1' as never,
        }),
      /workdir/,
    )
  })

  test('★ 调试：不跑脚本，只记录动作与解析后的参数（2026-09 取代预演准入）', async () => {
    const fake = fakeStore({ tools: [toolRecord()], run })
    const calls: ScriptExecutionRequest[] = []
    const runner = new ActionRunner({
      store: fake.store,
      executeToolScript: async (req) => {
        calls.push(req)
        return { ok: true, detail: '不该被调用', exitCode: 0, durationMs: 1 }
      },
    })

    const result = await runner.execute({
      ref: { type: 'example-note.append-note', params: { text: 'x' } } as never,
      workspaceId: WORKSPACE,
      verdictId: 'v1' as never,
      runId: 'run-1' as never,
      debug: true,
    })

    // ★ 硬证据：脚本**一次都没被调用**——调试不是"演一遍"，是根本不跑。
    assert.equal(calls.length, 0, '调试模式下一次都不该起脚本')
    assert.equal(result.action.status, 'executed')
    // 协议里 `Action.dryRun` = "没真跑、只记录"：时间线靠它显示「调试 · 未执行」
    assert.equal(result.action.dryRun, true)
    assert.equal(result.action.params['text'], 'x', '解析后的参数原样记下')
    assert.equal(result.action.result?.['debug'], true)
    assert.match(String(result.action.result?.['detail']), /调试模式/)
  })

  // ⚠️ 这里原本有一条「★ 内置动作那条路没变：dry-run 仍然只记录"会做什么"」。
  //
  // 这条能力已经不在平台内（D41：动作全部来自工具包脚本，dry-run 也由脚本
  // 自己保证）：平台不再有"我知道这条动作打算做什么、所以我能替它记下
  // `wouldDo`"这条分支——那要求平台自己实现动作。现在 `dryRun: true` 只是
  // 原样透传给脚本，由脚本描述"我打算改什么"（上一条 `unsupported` 的用例
  // 与「dry-run：照样跑脚本」那组守的就是这个新形状）。

  // ⚠️ 这里原本有一条「★ 内置动作真的执行时仍走原来的 switch（评论真的写了）」。
  //
  // 主体就是**内置动作的副作用**（评论真的写进 store），所以整条删掉：这条能力
  // 已经不在平台内（D41：动作全部来自工具包脚本，而工具脚本没有平台 API——
  // 它改不了 store 里的评论）。六个 `case` 与它们的辅助函数随内置动作一起删了，
  // 见 `apps/daemon/src/actions.ts` 的文件头。

  test('★ 幂等优先于绑定：同一条判决重放时环境变了也照样 skipped', async () => {
    const existing = {
      id: 'a1',
      workspaceId: WORKSPACE,
      verdictId: 'v1',
      type: 'example-note.append-note',
      plane: 'local',
      params: {},
      status: 'executed',
      idempotencyKey: 'k',
      dryRun: false,
      result: null,
      error: null,
      rollbackRef: null,
      createdAt: 1,
      finishedAt: 2,
    } as unknown as Action

    // run 的 workdir 已经没了（重放时环境变了）：绑定算不出来，
    // 但那条动作**早就执行过**了，重放就该干净地落 skipped。
    const fake = fakeStore({
      tools: [toolRecord()],
      run: { ...run, workDir: null },
      existing,
    })
    const runner = new ActionRunner({ store: fake.store })

    const result = await runner.execute({
      ref: { type: 'example-note.append-note', params: { text: 'x' } } as never,
      workspaceId: WORKSPACE,
      verdictId: 'v1' as never,
      runId: 'run-1' as never,
    })

    assert.equal(result.skipped, true)
    assert.equal(result.action.status, 'skipped')
    assert.deepEqual(fake.transitions, ['proposed->skipped'])
  })

  test('幂等命中仍然记 skipped（键的语义未变）', async () => {
    // ★ 夹具换成**工具动作名**（D41：动作只可能是 `<包 slug>.<动作名>`）。
    //   原来拿内置的 `comment.create` 当夹具：它的**形状**仍然合法，但已经
    //   没有对应的工具包，所以校验那一步就会判「工具包 comment 还没有装到这个
    //   工作区」，根本走不到幂等判定——因此这里同时把 `toolRecord()` 装进 store。
    const existing = {
      id: 'a1',
      workspaceId: WORKSPACE,
      verdictId: 'v1',
      type: 'example-note.append-note',
      plane: 'local',
      params: {},
      status: 'executed',
      idempotencyKey: 'k',
      dryRun: false,
      result: null,
      error: null,
      rollbackRef: null,
      createdAt: 1,
      finishedAt: 2,
    } as unknown as Action

    const fake = fakeStore({ tools: [toolRecord()], existing, run })
    const runner = new ActionRunner({ store: fake.store })

    const result = await runner.execute({
      ref: { type: 'example-note.append-note', params: { text: '你好' } } as never,
      workspaceId: WORKSPACE,
      verdictId: 'v1' as never,
      runId: 'run-1' as never,
    })

    assert.equal(result.skipped, true)
    assert.equal(result.action.status, 'skipped')
    assert.deepEqual(fake.transitions, ['proposed->skipped'])
  })
})
