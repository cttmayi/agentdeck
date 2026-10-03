import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 工作区内的临时目录——沙箱环境对工作区外写入有限制。
 *
 * ⚠️ 每个包各有一份（`agent-core` / `agent-codex` / `store-file` / `store-sqlite` …
 *    都这样）：它是**测试脚手架**，跨包共享要额外立一个包并把它拖进每个包的
 *    依赖里，而这点重复不值得那个代价。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

export async function makeTempDir(prefix = 'skill-source'): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
