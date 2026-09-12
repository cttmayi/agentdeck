import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** 工作区内的临时目录——沙箱环境对工作区外写入有限制。 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

export async function makeTempDir(prefix = 'daemon'): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
