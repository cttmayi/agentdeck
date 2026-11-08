import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 仓库级的**平台兼容**检查（2026-11，Windows infra_error 事故后固化）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组检查是"Windows 上沉淀总报 infra_error"那次事故的产物
 * ══════════════════════════════════════════════════════════════════
 *
 * 现场（提交 f79ee99）：codex 的 app-server 干完了活（skill/SKILL.md 都写好了），
 * `turn/completed` 先到，适配器随后 `terminate()` 收进程——macOS 上 SIGTERM 让
 * `exitCode=null`，Windows 上 `taskkill /T /F` 强杀却留下 `exitCode=1`，于是
 * 同一份成功产出在 Windows 上被误判成 infra_error。macOS 上跑测试**永远量不到**
 * Windows 的行为——真机差异只能靠"把契约钉死在代码形状上"来防：
 *
 *   ① 判级契约（纯函数回归用例，stream-parser.test.ts）：
 *      `classifyCodexFailure(exitCode:1 + completed + 有产出) → null`；
 *   ② 本文件的形状扫描：适配器里不许出现"terminate 之后捞退出码"的写法、
 *      不许出现平台判断、taskkill 只能从 process-tree.ts 一处发。
 *
 * 扫描代替不了测试，但它拦的是"**人又写回老形状**"——检查不会手滑。
 * 规则全文见 docs/design/platform-compat.md（改代码前过一遍）。
 */

const REPO_ROOT = join(import.meta.dirname, '..')

/** 适配器源码目录（平台无关是适配器的契约，见 platform-compat.md §3）。 */
const ADAPTER_DIRS = [
  join('packages', 'agent-codex', 'src'),
  join('packages', 'agent-claude', 'src'),
  join('packages', 'agent-generic', 'src'),
]

/** 允许出现平台分支的 agent-core 文件（分支收口点，见 platform-compat.md §2/§3）。 */
const PROCESS_TREE_FILE = join('packages', 'agent-core', 'src', 'process-tree.ts')

/** 递归收集目录下的 .ts 文件（不含测试）。 */
async function collectTsFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(join(REPO_ROOT, dir), { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) await collectTsFiles(rel, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(rel)
  }
  return out
}

describe('★ 平台兼容：适配器不许写平台分支（Windows ≠ macOS 咬过一次，见 platform-compat.md）', () => {
  test('★★ 适配器里不许出现 "terminate 之后捞退出码" 的反模式（.exited.catch(）', async () => {
    /*
     * 事故形状（f79ee99 修复前的 codex-backend）：
     *
     *     await handle!.terminate()
     *     const exit = await handle!.exited.catch(...)   ← 读到的正是我们 taskkill 留下的 exitCode=1
     *
     * 适配器自己 terminate 之后读退出码，读到的值取决于"怎么杀"（信号 vs taskkill），
     * 与 CLI 的成败无关。这个形状再出现就再犯一次事故——直接拦。
     */
    const offenders: string[] = []
    for (const dir of ADAPTER_DIRS) {
      for (const file of await collectTsFiles(dir)) {
        const source = await readFile(join(REPO_ROOT, file), 'utf8')
        for (const [index, line] of source.split('\n').entries()) {
          if (/\.exited\.catch\(/.test(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`)
          }
        }
      }
    }
    assert.deepEqual(offenders, [], '适配器里不许在 terminate 之后读进程退出码（见 platform-compat.md §1）')
  })

  test('★★ 适配器里不许读平台（process.platform / isWindows）', async () => {
    /*
     * 平台知识收口在 agent-core（spawn-target / probe / process-tree / executable-check）。
     * 适配器读平台 = 平台差异散进每个 runtime，macOS 上测不出来的分支会悄悄进 Windows。
     * 真的需要在适配器里分支时，先按 platform-compat.md「怎么新增一个平台分支」挪位置。
     */
    const offenders: string[] = []
    for (const dir of ADAPTER_DIRS) {
      for (const file of await collectTsFiles(dir)) {
        const source = await readFile(join(REPO_ROOT, file), 'utf8')
        for (const [index, line] of source.split('\n').entries()) {
          if (/\bprocess\.platform\b|\bisWindows\b/.test(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`)
          }
        }
      }
    }
    assert.deepEqual(offenders, [], '适配器不许读平台（见 platform-compat.md §3）')
  })

  test('★ taskkill 只能从 process-tree.ts 一处发（收进程只有一处）', async () => {
    /*
     * terminate 的平台分支（Unix 信号 / Windows taskkill）必须收口在 process-tree.ts：
     * 每个适配器都自己杀进程，早晚有人把"退出码判级"的错误假设复制过去。
     */
    const offenders: string[] = []
    for (const dir of ADAPTER_DIRS) {
      for (const file of await collectTsFiles(dir)) {
        const source = await readFile(join(REPO_ROOT, file), 'utf8')
        for (const [index, line] of source.split('\n').entries()) {
          if (/spawn\(\s*['"]taskkill/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    // 允许的那一处必须还在（process-tree.ts 的 Windows 分支没被删掉）
    const treeSource = await readFile(join(REPO_ROOT, PROCESS_TREE_FILE), 'utf8')
    assert.ok(/spawn\(\s*['"]taskkill/.test(treeSource), 'process-tree.ts 的 taskkill 分支不许消失')
    assert.deepEqual(offenders, [], '适配器不许自己 spawn taskkill（见 platform-compat.md §2）')
  })
})
