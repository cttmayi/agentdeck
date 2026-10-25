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
