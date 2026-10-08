import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkEnvironment, isWritableDir } from './environment.ts'

/**
 * 运行环境预检的判据（2026-10 Windows 兼容性审计的 B3）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这条判据重要
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个预检存在的理由是把"CLI 状态目录写不进去"从**一句指向错方向的 EPERM**
 * （看起来像"工作目录没建成功"）提前成启动时的一句人话。所以它**漏报**的代价很大：
 * 使用者照样会在运行中撞上那句 EPERM，照样往错的方向排查。
 *
 * Windows 上 `access(W_OK)` 不反映 ACL ⇒ 旧实现正好会在最需要它的那台机器上漏报。
 * 现在那边改成"真写一次"，而"真写"这条用**注入的 writeProbe** 就能在 macOS 上钉住。
 *
 * 临时目录沿用工作区内 `.cache/test-tmp` 的约定（不用系统 `/tmp`）。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

async function makeTempDir(prefix: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, prefix))
}

describe('★ isWritableDir：Windows 上真写一次，别信 access', () => {
  test('★ Windows：writeProbe 失败 ⇒ 报不可写，并把真实 errno 带出来', async () => {
    const dir = await makeTempDir('writable-win-')
    try {
      const err = Object.assign(new Error('EPERM: operation not permitted, open …'), {
        code: 'EPERM',
      })
      const out = await isWritableDir(dir, {
        platform: 'win32',
        writeProbe: async () => {
          throw err
        },
      })
      assert.equal(out.ok, false)
      assert.match(out.reason ?? '', /EPERM/, '要让使用者拿到能去搜的错误码')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('★ Windows：真写的探针会落到那个目录里，且**写完就删**（不留垃圾）', async () => {
    const dir = await makeTempDir('writable-probe-')
    try {
      const seen: string[][] = []
      const out = await isWritableDir(dir, {
        platform: 'win32',
        // 用"真写"那条默认实现：写进去、列一次目录、再删
        writeProbe: async (path) => {
          await writeFile(join(path, '.agentdeck-write-probe-test'), '', 'utf8')
          seen.push(await readdir(path))
          await rm(join(path, '.agentdeck-write-probe-test'), { force: true })
        },
      })
      assert.equal(out.ok, true)
      assert.deepEqual(seen[0], ['.agentdeck-write-probe-test'])
      assert.deepEqual(await readdir(dir), [], '探针文件必须被删掉')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('★ 非 Windows：**不**去写使用者的家目录（走 access 那条快路）', async () => {
    const dir = await makeTempDir('writable-posix-')
    try {
      let probed = 0
      const out = await isWritableDir(dir, {
        platform: 'linux',
        writeProbe: async () => {
          probed += 1
        },
      })
      assert.equal(out.ok, true)
      assert.equal(probed, 0, 'POSIX 上不该往那个目录里写探针文件')
      assert.deepEqual(await readdir(dir), [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('目录不存在 ⇒ 试着建（CLI 首次运行时就是这样）', async () => {
    const root = await makeTempDir('writable-missing-')
    try {
      const target = join(root, 'not-there-yet')
      assert.deepEqual(await isWritableDir(target), { ok: true })
      assert.deepEqual(await readdir(target), [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('建不出来 ⇒ 把 errno 的话带回来（不是一句"不可写"）', async () => {
    const root = await makeTempDir('writable-fail-')
    try {
      // 拿一个"父路径是文件"的位置，mkdir 一定失败
      const blocker = join(root, 'a-file')
      await writeFile(blocker, 'x', 'utf8')
      const out = await isWritableDir(join(blocker, 'under'))
      assert.equal(out.ok, false)
      assert.ok((out.reason ?? '').length > 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('★ checkEnvironment：只查可用的 runtime', () => {
  const descriptor = {
    key: 'claude',
    command: 'claude',
    stateDir: '.claude',
  } as unknown as Parameters<typeof checkEnvironment>[0][number]['descriptor']

  test('没装的 runtime 不谈"它的家目录写不进去"', async () => {
    const home = await makeTempDir('env-home-')
    try {
      const report = await checkEnvironment([{ descriptor, available: false }], { homeDir: home })
      assert.equal(report.ok, true)
      assert.deepEqual(report.checkedPaths, [])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('★ 状态目录的位置被一个同名文件占着 ⇒ 一条 error（不然是运行中的 ENOTDIR）', async () => {
    const home = await makeTempDir('env-home2-')
    try {
      const blocker = join(home, '.claude')
      await writeFile(blocker, 'not a dir', 'utf8')
      const report = await checkEnvironment([{ descriptor, available: true }], { homeDir: home })
      assert.equal(report.ok, false)
      assert.equal(report.issues[0]?.subject, 'claude')
      assert.match(report.issues[0]?.summary ?? '', /状态目录/)
      assert.match(report.issues[0]?.action ?? '', /状态目录/, '怎么办那一段也要点回状态目录')
      assert.match(report.issues[0]?.summary ?? '', /同名的文件/, '要说清是"被文件占了"而不是"没权限"')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('★ Windows 上预检会调用"真写"（那条判据在真机上就是它）', async () => {
    const home = await makeTempDir('env-home3-')
    try {
      // 目录先存在——不然走的是"刚 mkdir 出来"那条（那次成功本身就已经证明能写了）
      await mkdir(join(home, '.claude'), { recursive: true })
      let probed = 0
      const report = await checkEnvironment([{ descriptor, available: true }], {
        homeDir: home,
        deps: {
          platform: 'win32',
          writeProbe: async () => {
            probed += 1
          },
        },
      })
      assert.equal(report.ok, true)
      assert.equal(probed, 1, 'Windows 上必须真写一次（access(W_OK) 在那里不查 ACL）')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})