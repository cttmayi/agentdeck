import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 适配器测试用的临时目录。
 *
 * 和 `apps/daemon/src/testing/tmp.ts`、`packages/store-file/src/testing/tmp.ts`
 * 同一套约定：**放在工作区内的 `.cache/test-tmp`，不用系统 `/tmp`**。
 *
 * 少一个包各自抄一份是值得的——`packages/*` 之间不能互相依赖
 * （agent-generic 依赖 agent-core 是单向的，反过来拉 daemon 的测试工具
 * 会把应用层拖进包里）。三份内容是同一份约定，改的时候要一起改。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

export async function makeTempDir(prefix = 'generic'): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return mkdtemp(join(TEST_TMP_ROOT, `${prefix}-`))
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
