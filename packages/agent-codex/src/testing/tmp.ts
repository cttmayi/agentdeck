import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 适配器测试用的临时目录。
 *
 * 与 `apps/daemon/src/testing/tmp.ts`、`packages/store-file/src/testing/tmp.ts`、
 * `packages/agent-generic/src/testing/tmp.ts` 同一套约定：**放在工作区内的
 * `.cache/test-tmp`，不用系统 `/tmp`**。内容是同一份约定，改的时候要一起改。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

export async function makeTempDir(prefix = 'codex'): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
