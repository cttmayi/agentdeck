import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 测试用临时数据目录。
 *
 * 刻意放在**工作区内**而不是系统 tmp：沙箱环境对工作区外写入有限制，
 * 用系统 tmp 会让测试在受限环境下莫名失败。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

export async function makeTempDir(prefix = 'sqlite'): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
