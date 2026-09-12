import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnProcessTree } from './process-tree.ts'

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
