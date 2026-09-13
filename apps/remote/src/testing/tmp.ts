import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 测试用的临时目录——**落在仓库内的 .cache 下**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不用 os.tmpdir()
 * ══════════════════════════════════════════════════════════════════
 *
 * 两个理由，第二个是硬的：
 *
 *   1. 沙箱/受限环境对工作区之外的写入有限制，系统临时目录可能写不进去，
 *      于是测试在别人机器上莫名其妙地红；
 *   2. 系统临时目录里放的是**使用者机器上别的东西**。测试如果养成"对
 *      tmpdir() 做递归删除"的习惯，一次手滑的后果不是"测试失败"，而是
 *      "删掉了使用者临时目录里的内容"。仓库里已经发生过一次这种事
 *      （见 tests/test-safety.test.ts），那条检查就是它的产物。
 *
 * 与 apps/daemon/src/testing/tmp.ts 是同一份实现。两个 app 各留一份是刻意的：
 * remote 不依赖 domain，为一个测试辅助去加一条包依赖并不划算。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

export async function makeTempDir(prefix = 'remote'): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
