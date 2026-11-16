import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnProcessTree } from './process-tree.ts'
import type { SpawnTarget } from './spawn-target.ts'

/**
 * 进程句柄的**信号面**测试。
 *
 * 加它的直接原因是一个真实缺陷：`exited` 把 `spawn` 的两种失败
 * （同步抛出、异步 `'error'` 事件）都压成了 `{ code: null }`，
 * 于是 ENOENT / EACCES 的原因彻底丢失，上层只能报一句"没拿到输出"。
 * 适配器因此把"CLI 装坏了"报成"输出格式变了"——**错误文本指向了错的地方**。
 *
 * 所以 `process` 这个字段被暴露出来，本测试守的就是它真的能挂监听器、
 * 真的能拿到错误。不验证的话，这个扩展位会安静地失效，
 * 而失效的表现又回到"错误文本指向错地方"。
 *
 * 临时目录沿用工作区内 `.cache/test-tmp` 的约定（不用系统 `/tmp`：
 * 受限沙箱里系统 tmp 可能不可写，那会让测试莫名失败）。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

async function makeTempDir(): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, 'process-tree-'))
}

describe('进程句柄的诊断面（NFR-P-05 的补充，不是替代）', () => {
  test('★ 起不来的进程会把原因交给调用方，而不是只给一个 code:null', async () => {
    const dir = await makeTempDir()
    try {
      const handle = spawnProcessTree({
        command: join(dir, 'not-a-real-program'),
        args: [],
        cwd: dir,
        env: process.env,
      })

      const [err] = (await once(handle.process, 'error')) as [NodeJS.ErrnoException]
      assert.equal(err.code, 'ENOENT')
      const exit = await handle.exited
      assert.equal(exit.code, null, '失败被压成 null 退出码——所以错误事件是唯一的线索')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('pid 在进程起来后可见（活性判定与诊断都用它）', async () => {
    const dir = await makeTempDir()
    try {
      const handle = spawnProcessTree({
        command: process.execPath,
        args: ['-e', 'setTimeout(()=>{}, 50)'],
        cwd: dir,
        env: process.env,
      })
      assert.equal(typeof handle.pid, 'number')
      await handle.terminate(500)
      await handle.exited
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})


/**
 * ★ 分批第 43 批：`.cmd` / `.bat` 在真 Windows 上起不来 —— 缺的是 `windowsVerbatimArguments`。
 *
 * 使用者原话：「我在 windows 查到了问题，问题是 .cmd/.bat 启动失败的问题，包括
 * spawn-target 中文件路径需要加引号，另外在 process-tree 中，调用 cmd /d /s /c 时，
 * 需要设置 VerbatimArguments:true，避免转义」。
 *
 * 为什么这条判据必须写在这里（而不是只测 `spawn-target` 那个纯函数）：
 * `spawn-target` 只决定"拼什么"，**把选项交给 `spawn` 的是 `process-tree`**。
 * 漏在后者的话，纯函数全绿、Windows 上照样起不来——这一批之前正是这个状态。
 *
 * ⚠️ 本机是 macOS，真跑 `cmd.exe` 不可能；这里用 `resolveTarget` 注入把
 *    `via: 'cmd'` 那一档"造出来"，再用假的 `spawn` 量它**到底收到了什么选项**。
 */
class FakeChild extends EventEmitter {
  readonly stdout = null
  readonly stderr = null
  readonly stdin = null
  readonly pid = undefined
}

describe('★ 分批第 43 批：via=cmd 时 spawn 必须收到 windowsVerbatimArguments', () => {
  const cmdTarget: SpawnTarget = {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\npm\\codex.cmd" app-server --stdio'],
    via: 'cmd',
    verbatimArguments: true,
  }

  test('★★★ via: cmd ⇒ spawn 收到 windowsVerbatimArguments: true（这就是真机量出来的那条）', () => {
    const seen: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = []
    const handle = spawnProcessTree({
      command: 'codex',
      args: ['app-server', '--stdio'],
      cwd: process.cwd(),
      env: process.env,
      resolveTarget: () => cmdTarget,
      spawnImpl: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
        seen.push({ command, args, options })
        return new FakeChild() as never
      }) as never,
    })
    void handle

    assert.equal(seen.length, 1, '假 spawn 必须被调用一次')
    assert.equal(seen[0]?.command, cmdTarget.command)
    assert.deepEqual(seen[0]?.args, cmdTarget.args)
    assert.equal(
      seen[0]?.options['windowsVerbatimArguments'],
      true,
      '★★ 少了这个旗标，Node 会把我们拼好的那条命令行再转义一遍 ⇒ 真 Windows 上起不来',
    )
  })

  test('★★ via: direct / shim ⇒ **不能**开 verbatim（含空格的路径要靠 Node 加引号）', () => {
    const seen: Array<Record<string, unknown>> = []
    spawnProcessTree({
      command: '/usr/local/bin/claude',
      args: ['--version'],
      cwd: process.cwd(),
      env: process.env,
      resolveTarget: () => ({
        command: '/usr/local/bin/claude',
        args: ['--version'],
        via: 'direct',
        verbatimArguments: false,
      }),
      spawnImpl: ((_command: string, _args: readonly string[], options: Record<string, unknown>) => {
        seen.push(options)
        return new FakeChild() as never
      }) as never,
    })
    assert.equal(
      seen[0]?.['windowsVerbatimArguments'],
      false,
      '★ 如果对所有情况都开 verbatim，`C:\\Program Files\\nodejs\\node.exe` 这种路径会被拆成两个参数',
    )
  })
})

/**
 * ★★ 2026-11 真机 P0（D120）：**切行只认 `\n`，U+2028/U+2029 是普通字符**。
 *
 * 现场：9 条 run 全死在 `thread/resume（id=2）超时（60000ms）`，run 日志里 119 条
 * 「JSON-RPC 帧不可解析」。根因是这里原来用 `readline.createInterface`——Node 的
 * readline 把 ECMAScript 的 LineTerminator（含 U+2028 / U+2029）也当行结束，
 * 于是一帧 1.6MB 的 NDJSON 被切成 119 段（实测切点全落在 `\xe2\x80\xa8` 上）。
 *
 * 判据：**一行 JSON 里带 U+2028/U+2029，出来必须还是一行、还能 parse**。
 * 不测的话，这处会"看起来在逐行读"，而 agent 读进来的 PDF/网页文本一旦带这类字符
 * （很常见），协议层就整帧崩掉——而且崩的姿势是"超时"，看不出跟切行有关。
 */
describe('★★ D120：U+2028/U+2029 不许被当成换行（真机 9 条 run 死在这里）', () => {
  test('★★ 一行 JSON 内含 U+2028/U+2029 ⇒ 仍是**一行**且能 JSON.parse', async () => {
    const dir = await makeTempDir()
    try {
      // 与真机同形：码点直接进 JSON 字符串（真 codex 就是这么发的，不做转义）
      const frame = JSON.stringify({ id: 2, result: { text: 'A practical \u2028guide to \u2029building agents' } })
      const lines: string[] = []
      const handle = spawnProcessTree({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.FRAME + "\\n")'],
        cwd: dir,
        env: { ...process.env, FRAME: frame },
        onStdoutLine: (line) => lines.push(line),
      })
      await handle.exited
      assert.equal(lines.length, 1, '两个 Unicode 行分隔符不许各成一行')
      assert.deepEqual(JSON.parse(lines[0]!), JSON.parse(frame), '整帧原样到达')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('★ CRLF 仍然是一行（Windows 上 CLI 一直是 CRLF）', async () => {
    const dir = await makeTempDir()
    try {
      const lines: string[] = []
      const handle = spawnProcessTree({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("甲\\r\\n乙\\r\\n")'],
        cwd: dir,
        env: process.env,
        onStdoutLine: (line) => lines.push(line),
      })
      await handle.exited
      assert.deepEqual(lines, ['甲', '乙'], 'CRLF 的行尾 \\r 要剥掉，否则 JSON.parse 会多一个字符')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('★ 收尾没有换行的最后一行也要交出去（否则日志尾行静默消失）', async () => {
    const dir = await makeTempDir()
    try {
      const lines: string[] = []
      const handle = spawnProcessTree({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("完整一行\\n没有换行的尾巴")'],
        cwd: dir,
        env: process.env,
        onStdoutLine: (line) => lines.push(line),
      })
      await handle.exited
      assert.deepEqual(lines, ['完整一行', '没有换行的尾巴'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('★ 多字节字符卡在块边界也不会被劈开（按字符串收，不按 Buffer 拼）', async () => {
    const dir = await makeTempDir()
    try {
      const lines: string[] = []
      // 每 3 字节写一次：汉字/U+2028（都是 3 字节 UTF-8）必然跨块
      const script = 'const s = "汉字\\u2028分隔\\u2029再来\\n"; for (let i = 0; i < s.length; i++) process.stdout.write(s[i]);'
      const handle = spawnProcessTree({
        command: process.execPath,
        args: ['-e', script],
        cwd: dir,
        env: process.env,
        onStdoutLine: (line) => lines.push(line),
      })
      await handle.exited
      assert.equal(lines.length, 1)
      assert.equal(lines[0], '汉字\u2028分隔\u2029再来')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
