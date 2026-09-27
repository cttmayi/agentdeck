import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectVersion } from './probe.ts'

/**
 * `detectVersion` 的回归测试。
 *
 * 加它的直接原因是一个真实缺陷：codex 的 `--version` 会先在 stderr 打一行
 * WARNING（"could not create PATH aliases"），旧实现把 stdout/stderr 混进
 * 同一个串、取"第一行"，于是版本探测拿到的是那行警告——`--verify-runtime
 * codex` 把"探测版本"报成了 WARNING 文本。版本号必须以 **stdout** 为准，
 * stdout 为空才退回 stderr。
 *
 * 临时目录沿用工作区内 `.cache/test-tmp` 的约定（不用系统 `/tmp`）。
 */
const TEST_TMP_ROOT = join(process.cwd(), '.cache', 'test-tmp')

async function makeFake(dirName: string, script: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  const dir = await mkdtemp(join(TEST_TMP_ROOT, dirName))
  const path = join(dir, 'fake-version')
  await writeFile(path, `#!/bin/sh\n${script}`, 'utf8')
  await chmod(path, 0o755)
  return path
}

describe('detectVersion（版本探测，FR-CLI-07 的输入）', () => {
  test('★ stderr 先打警告、stdout 报版本 → 取 stdout 的版本', async () => {
    const path = await makeFake('stderr-warn-', `echo 'WARNING: proceeding anyway' >&2\necho 'codex-cli 0.144.0-alpha.4'`)
    try {
      assert.equal(await detectVersion(path), '0.144.0-alpha.4')
    } finally {
      await rm(dirnameOf(path), { recursive: true, force: true })
    }
  })

  test('★ stdout 空、版本只在 stderr → 退回 stderr', async () => {
    const path = await makeFake('stdout-empty-', `echo ''\necho 'v1.2.3' >&2`)
    try {
      assert.equal(await detectVersion(path), '1.2.3')
    } finally {
      await rm(dirnameOf(path), { recursive: true, force: true })
    }
  })

  test('★ 单行版本（claude 那种）→ 正常取到', async () => {
    const path = await makeFake('plain-version-', `echo '2.1.143'`)
    try {
      assert.equal(await detectVersion(path), '2.1.143')
    } finally {
      await rm(dirnameOf(path), { recursive: true, force: true })
    }
  })
})

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}
