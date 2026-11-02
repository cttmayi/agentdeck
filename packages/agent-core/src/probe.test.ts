import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { detectVersion, windowsCandidateExtensions } from './probe.ts'
import { executableWrapper } from './spawn-target.ts'

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

/**
 * 造一个"能报版本"的假 CLI。
 *
 * ★ 分批第 228 批（三平台兼容）：**用 `executableWrapper` 造两份形状**，夹具脚本写成
 *   **Node**（`.mjs`）而不是 `#!/bin/sh`。
 *
 * 原因是这条夹具在 Windows 上根本起不来：`spawn('fake-version')` 拿到一个
 * `#!/bin/sh` 文件 ⇒ 没有 sh、也没有 `.cmd` 垫片 ⇒ ENOENT/EINVAL，于是
 * "版本探测"的三条判据在 Windows CI 上会红，而红的原因与它们要测的东西无关。
 * `executableWrapper` 正是为这件事存在的（Unix 给 `#!/bin/sh` 包装、Windows 给
 * npm 垫片形状），所以夹具只写**行为**（Node 脚本），两种形状由它产出。
 */
async function makeFake(dirName: string, body: string): Promise<string> {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  const dir = await mkdtemp(join(TEST_TMP_ROOT, dirName))
  const script = join(dir, 'fake-version.mjs')
  await writeFile(script, body, 'utf8')
  const wrapper = executableWrapper({
    name: 'fake-version',
    nodePath: process.execPath,
    scriptPath: script,
  })
  const path = join(dir, wrapper.name)
  await writeFile(path, wrapper.content, 'utf8')
  if (wrapper.needsChmod) await chmod(path, 0o755)
  return path
}

describe('detectVersion（版本探测，FR-CLI-07 的输入）', () => {
  test('★ stderr 先打警告、stdout 报版本 → 取 stdout 的版本', async () => {
    const path = await makeFake(
      'stderr-warn-',
      `console.error('WARNING: proceeding anyway')\nconsole.log('codex-cli 0.144.0-alpha.4')\n`,
    )
    try {
      assert.equal(await detectVersion(path), '0.144.0-alpha.4')
    } finally {
      await rm(dirnameOf(path), { recursive: true, force: true })
    }
  })

  test('★ stdout 空、版本只在 stderr → 退回 stderr', async () => {
    const path = await makeFake(
      'stdout-empty-',
      `console.log('')\nconsole.error('v1.2.3')\n`,
    )
    try {
      assert.equal(await detectVersion(path), '1.2.3')
    } finally {
      await rm(dirnameOf(path), { recursive: true, force: true })
    }
  })

  test('★ 单行版本（claude 那种）→ 正常取到', async () => {
    const path = await makeFake('plain-version-', `console.log('2.1.143')\n`)
    try {
      assert.equal(await detectVersion(path), '2.1.143')
    } finally {
      await rm(dirnameOf(path), { recursive: true, force: true })
    }
  })
})

/** ⚠️ 用 `node:path` 的 `dirname`（分批第 228 批）：手写 `lastIndexOf('/')` 在 Windows 上切不开反斜杠。 */
function dirnameOf(path: string): string {
  return dirname(path)
}

describe('★ Windows 的候选扩展名（2026-10 兼容性审计的 A2）', () => {
  // 旧版这里写死了 `.exe/.cmd/.bat/.ps1/''`：`.ps1` 是 PowerShell 脚本，
  // **Node 起不了它**（要 `powershell -File`）⇒ 探测"成功"、真跑必炸。
  // 现在以机器的 PATHEXT 为准，并按"Node 起得起来"过滤。

  test('★ 真实机器上的 PATHEXT ⇒ 滤掉 Node 起不了的那几个', () => {
    // 这是 Windows 默认值（一字不差）
    const ext = windowsCandidateExtensions('.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC')
    assert.deepEqual(ext, ['.com', '.exe', '.bat', '.cmd', ''])
    for (const bad of ['.ps1', '.vbs', '.js', '.wsf', '.msc']) {
      assert.ok(!ext.includes(bad), `${bad} 不该在候选里（Node 起不了它）`)
    }
  })

  test('PATHEXT 缺了/被改窄 ⇒ 三种可 spawn 的还是要补上', () => {
    assert.deepEqual(windowsCandidateExtensions(undefined), ['.exe', '.com', '.cmd', '.bat', ''])
    assert.deepEqual(windowsCandidateExtensions('.EXE'), ['.exe', '.com', '.cmd', '.bat', ''])
  })

  test('末尾的空串在（"命令自带扩展名"那种情形就靠它）', () => {
    assert.equal(windowsCandidateExtensions('.EXE;.CMD').at(-1), '')
  })
})
