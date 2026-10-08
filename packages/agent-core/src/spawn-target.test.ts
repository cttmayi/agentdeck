import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UnspawnableCommandError,
  WINDOWS_SPAWNABLE_EXT,
  buildCmdLine,
  describeSpawnError,
  executableWrapper,
  npmShimText,
  parseNpmShim,
  quoteForCmd,
  resolveSpawnTarget,
} from './spawn-target.ts'

/**
 * Windows 上"到底该 exec 什么"的判据（2026-10 兼容性审计的 A1/A2）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这些判据为什么能在 macOS 上跑
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为平台是**注入**的（`platform: 'win32'`），垫片文本也是**注入**的
 * （`readText`）。没被钉住的只剩最后一层"真 Windows 上 exec 得起来吗"——
 * 那一层写进了 `docs/reference/windows-compat.md` 的"没量到的"。
 *
 * ⚠️ 夹具里那段垫片是**真的 npm 垫片**（`cmd-shim` 生成的那个形状，逐字抄的），
 *    不是我们自己编的形状。拿自己编的形状测自己的解析器，等于什么都没测。
 */

/** npm（cmd-shim）生成的垫片，逐字抄的：`%~dp0` + `IF EXIST node.exe` + `%*`。 */
function npmShimLegacy(dir: string, target: string, withLocalNode: boolean): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    withLocalNode
      ? `IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)`
      : `IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)`,
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${dir}\\${target}" %*`,
    '',
  ].join('\r\n')
}

const SHIM_DIR = 'C:\\Users\\ling\\AppData\\Roaming\\npm'
const SHIM_PATH = `${SHIM_DIR}\\claude.cmd`
const CLI_JS = `${SHIM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`

describe('★ 解开 npm 垫片（Windows 上 spawn .cmd 的唯一正路）', () => {
  test('真的 npm 垫片 ⇒ 抠出它要跑的 .js', () => {
    const shim = parseNpmShim(npmShimLegacy(SHIM_DIR, 'node_modules\\@anthropic-ai\\claude-code\\cli.js', false), SHIM_PATH)
    assert.notEqual(shim, null)
    assert.equal(shim!.script, CLI_JS)
  })

  test('多分支垫片（IF EXIST 两套写法）⇒ 认最后一个带 %* 的分支', () => {
    const text = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\agent-cli\\cli.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\node_modules\\agent-cli\\cli.js" %*
)`
    const shim = parseNpmShim(text, SHIM_PATH)
    assert.notEqual(shim, null)
    assert.equal(shim!.script, `${SHIM_DIR}\\\\node_modules\\agent-cli\\cli.js`)
  })

  test('`%dp0`（老版本漏一个百分号）也认', () => {
    const shim = parseNpmShim('"%dp0\\node.exe" "%dp0\\cli.js" %*', SHIM_PATH)
    assert.notEqual(shim, null)
    // ⚠️ 期望值是**双**反斜杠：npm 的 `dp0` 自带结尾分隔符，垫片又写了 `\cli.js`
    //    ——真实文本就是 `…\npm\\cli.js`，Windows 容忍重复分隔符（见 substituteDp0 的注释）
    assert.equal(shim!.script, `${SHIM_DIR}\\\\cli.js`)
  })

  test('★ 不是垫片形状 ⇒ null（**绝不猜**，交给 cmd.exe 兜底）', () => {
    assert.equal(parseNpmShim('@ECHO off\r\necho hello\r\n', SHIM_PATH), null)
    // 有 %* 但没有脚本可抠（比如它转手去调另一个 .exe）
    assert.equal(parseNpmShim('@ECHO off\r\n"%~dp0\\other.exe" %*\r\n', SHIM_PATH), null)
  })

  test('空文件 ⇒ null（不会拿空串去拼出一条命令）', () => {
    assert.equal(parseNpmShim('', SHIM_PATH), null)
  })
})

describe('★ resolveSpawnTarget：平台差异只有这一处', () => {
  const readText = (text: string | null) => () => text

  test('Unix 上一律原样返回，**连读都不读**那个文件', () => {
    let read = 0
    const out = resolveSpawnTarget({
      command: '/usr/local/bin/claude',
      args: ['--version'],
      platform: 'darwin',
      readText: () => {
        read += 1
        return null
      },
    })
    assert.deepEqual(out, { command: '/usr/local/bin/claude', args: ['--version'], via: 'direct' })
    assert.equal(read, 0, 'Unix 上不该去读什么垫片')
  })

  test('Windows + `.exe` ⇒ 原样（原生安装器那种装法不受影响）', () => {
    const out = resolveSpawnTarget({
      command: 'C:\\Users\\ling\\.local\\bin\\claude.exe',
      args: ['--version'],
      platform: 'win32',
    })
    assert.deepEqual(out, {
      command: 'C:\\Users\\ling\\.local\\bin\\claude.exe',
      args: ['--version'],
      via: 'direct',
    })
  })

  test('★ Windows + `.cmd` ⇒ 解开垫片，用**调用方给的 node**跑那个 .js', () => {
    const out = resolveSpawnTarget({
      command: SHIM_PATH,
      args: ['--resume', 'abc'],
      platform: 'win32',
      readText: readText(npmShimLegacy(SHIM_DIR, 'node_modules\\@anthropic-ai\\claude-code\\cli.js', false)),
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    })
    assert.equal(out.via, 'shim')
    assert.equal(out.command, 'C:\\Program Files\\nodejs\\node.exe')
    // ⚠️ 顺序也要对：脚本在前、真实参数原样在后（垫片的 `%*` 就是这个位置）
    assert.deepEqual(out.args, [CLI_JS, '--resume', 'abc'])
  })

  test('★ 垫片自带的 node.exe **故意不用**——一律用调用方给的 node', () => {
    // 理由（也写进了模块头）：垫片里那个 node.exe 要么不存在（现代 npm 写的是
    // `SET "_prog=node"`，意思是"从 PATH 找"），要么是来路不明的副本；而
    // "正在跑 daemon 的这个 node"一定存在、版本一定够。猜错解释器的表现是
    // "CLI 起来了但报语法错"——比失败难查。
    const text = '"%~dp0\\node.exe" "%~dp0\\cli.js" %*'
    const out = resolveSpawnTarget({
      command: SHIM_PATH,
      args: [],
      platform: 'win32',
      readText: readText(text),
      nodePath: 'C:\\other\\node.exe',
    })
    assert.equal(out.command, 'C:\\other\\node.exe')
    assert.deepEqual(out.args, [`${SHIM_DIR}\\\\cli.js`])
  })

  test('★ 认不出的 .cmd ⇒ 走 cmd.exe（`/d /s /c` + 整条包一层引号）', () => {
    const out = resolveSpawnTarget({
      command: SHIM_PATH,
      args: ['--flag', 'C:\\a b\\x.txt'],
      platform: 'win32',
      readText: readText('@ECHO off\r\necho nothing to parse here\r\n'),
      env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    })
    assert.equal(out.via, 'cmd')
    assert.equal(out.command, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(out.args.slice(0, 3), ['/d', '/s', '/c'])
    assert.equal(out.args[3], `"${SHIM_PATH} --flag "C:\\a b\\x.txt""`)
  })

  test('读不到垫片（文件没了）⇒ 也走 cmd.exe，而不是抛', () => {
    const out = resolveSpawnTarget({
      command: SHIM_PATH,
      args: [],
      platform: 'win32',
      readText: readText(null),
    })
    assert.equal(out.via, 'cmd')
  })

  test('★ `.ps1` ⇒ 明确拒绝（Node 起不了它，cmd /c 也不成立）', () => {
    assert.throws(
      () =>
        resolveSpawnTarget({
          command: 'C:\\Users\\ling\\AppData\\Roaming\\npm\\claude.ps1',
          args: [],
          platform: 'win32',
        }),
      (err: unknown) => {
        assert.ok(err instanceof UnspawnableCommandError)
        assert.match(err.message, /PowerShell/)
        assert.match(err.message, /\.cmd/, '要说清"npm 同时给了 .cmd，用那个"')
        return true
      },
    )
  })

  test('可 spawn 的扩展名表里**没有** `.ps1`（探测那张表要和它一致）', () => {
    assert.deepEqual([...WINDOWS_SPAWNABLE_EXT], ['.exe', '.com', '.cmd', '.bat'])
  })
})

describe('★ cmd 的引号规则：表达不了就拒绝，不静默改写', () => {
  test('普通参数不加引号，带空格的加', () => {
    assert.equal(quoteForCmd('--flag'), '--flag')
    assert.equal(quoteForCmd('a b'), '"a b"')
    assert.equal(quoteForCmd(''), '""')
  })

  test('★ 含 `"` 或 `%` 或换行的参数 ⇒ 拒绝（不是转义、不是丢掉）', () => {
    // ⚠️ 这条是**故意的**：`"` 在 cmd 与目标程序的 CRT 里有两套转义规则，
    //    "转义一次两边都对"的写法不存在；`%` 在 `cmd /c` 的命令行上会被展开
    //    （`%%` 只对批处理有效）。静默改写的结果是"prompt 少了半句"——
    //    那比明确失败难查得多。
    assert.equal(quoteForCmd('say "hi"'), null)
    assert.equal(quoteForCmd('100%'), null)
    assert.equal(quoteForCmd('two\nlines'), null)
  })

  test('★ 拒绝时把"哪个参数、为什么、怎么办"说清', () => {
    assert.throws(
      () => buildCmdLine('C:\\npm\\x.cmd', ['--prompt', 'say "hi"']),
      (err: unknown) => {
        assert.ok(err instanceof UnspawnableCommandError)
        assert.match(err.message, /无法如实传递/)
        assert.match(err.message, /\.exe/, '要给出可照做的替代方案')
        return true
      },
    )
  })

  test('路径里有 `%` 也拒绝（那种路径确实存在，但过 cmd 一定会被改写）', () => {
    assert.throws(() => buildCmdLine('C:\\100%\\x.cmd', []), UnspawnableCommandError)
  })
})

describe('★ executableWrapper：假 CLI 的包装（A3，两种平台两种形状）', () => {
  test('Unix ⇒ `#!/bin/sh` + exec，并且要 +x 位（形状与改动前逐字一致）', () => {
    const w = executableWrapper({
      platform: 'darwin',
      name: 'agent-cli',
      nodePath: '/usr/local/bin/node',
      scriptPath: '/tmp/fake-cli.ts',
    })
    assert.equal(w.name, 'agent-cli')
    assert.equal(w.needsChmod, true)
    assert.ok(w.content.startsWith('#!/bin/sh\n'))
    assert.match(w.content, /exec "\/usr\/local\/bin\/node" "\/tmp\/fake-cli\.ts" "\$@"/)
  })

  test('Windows ⇒ `.cmd`，且**能被真解析器解开**成 `<node> <script>`', () => {
    const w = executableWrapper({
      platform: 'win32',
      name: 'agent-cli',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\tmp\\fake-cli.ts',
    })
    assert.equal(w.name, 'agent-cli.cmd')
    assert.equal(w.needsChmod, false, 'Windows 上 chmod 是空操作，别假装它有意义')
    // ★ 这条是**往返**：真解析器读得懂我们造的包装 ⇒ Windows 上假 CLI 起得来，
    //   而"被测的 argv 仍是真实 argv"这条性质照样成立。
    const target = resolveSpawnTarget({
      command: `C:\\tmp\\${w.name}`,
      args: ['--resume', 'abc'],
      platform: 'win32',
      readText: () => w.content,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    })
    assert.equal(target.via, 'shim')
    assert.deepEqual(target.args, ['C:\\tmp\\fake-cli.ts', '--resume', 'abc'])
  })

  test('Windows 上包装的路径带空格（`C:\\Program Files\\…`）也照样解开', () => {
    const w = executableWrapper({
      platform: 'win32',
      name: 'codex-app-server-fake',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\Users\\a b\\fake-app-server.ts',
    })
    const shim = parseNpmShim(w.content, 'C:\\Users\\a b\\codex-app-server-fake.cmd')
    assert.notEqual(shim, null)
    assert.equal(shim!.script, 'C:\\Users\\a b\\fake-app-server.ts')
  })
})

describe('★ npmShimText：造一个"我们的解析器认得、形状与 npm 一致"的垫片', () => {
  test('生成 ⇒ 解析 的往返（测试脚手架就是用它的）', () => {
    const text = npmShimText({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\tmp\\fake-cli.ts',
    })
    const shim = parseNpmShim(text, 'C:\\tmp\\agent-cli.cmd')
    assert.notEqual(shim, null)
    assert.equal(shim!.script, 'C:\\tmp\\fake-cli.ts')
  })
})

describe('★ describeSpawnError：把所有 spawn 失败都翻成人话', () => {
  // ⚠️ 这份翻译原先在 agent-generic 与 agent-codex 里**各有一份**，注释写着
  //    "改的时候要一起改"——那正是最会漂的安排。现在只有一份，判据也只有一处。
  test('★ EINVAL ⇒ 说清"这个文件不能直接执行"并给出可照做的替代（`.cmd` 是主因）', () => {
    const text = describeSpawnError({ code: 'EINVAL' }, 'claude', 'C:\\npm\\claude.cmd')
    assert.match(text, /不能被直接执行/)
    assert.match(text, /\.cmd/)
    assert.match(text, /原生安装器|\.exe/, '要给出一条能照做的路')
    assert.ok(!text.includes('**'), '这段话会进界面与日志，别留 markdown 记号')
  })

  test('ENOENT / EACCES 的老话不变（有人在界面上认得出它们）', () => {
    assert.match(describeSpawnError({ code: 'ENOENT' }, 'claude', '/x/claude'), /找不到 claude 可执行文件/)
    assert.match(describeSpawnError({ code: 'EACCES' }, 'claude', '/x/claude'), /不可执行/)
  })

  test('没见过的错误 ⇒ 原样带上，不吞细节', () => {
    assert.match(describeSpawnError(new Error('莫名其妙'), 'claude', '/x/claude'), /莫名其妙/)
    assert.match(describeSpawnError(null, 'claude', '/x/claude'), /启动 claude 失败/)
  })
})
