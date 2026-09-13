import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * 仓库级的**测试安全**检查。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组检查是一次真实事故的产物
 * ══════════════════════════════════════════════════════════════════
 *
 * 写"从 GitHub 安装 skill"的测试时，某条用例的 `finally` 里被写成了：
 *
 *     await cleanup(await import('node:os').then((os) => os.tmpdir()))
 *
 * 而 `cleanup()` 是 `rm(dir, { recursive: true, force: true })`——
 * 也就是说，跑一次测试就会去**递归删掉操作系统的临时目录**。
 *
 * 它确实执行了，也确实抛错了（那条用例因此报了一个看起来毫不相干的失败），
 * 而磁盘上绝大多数内容侥幸还在。侥幸不是设计：同样一行代码换个平台、
 * 换个权限状态，结果可能就是把使用者的临时目录清空。
 *
 * 所以这里把它变成一条**机器检查**：任何递归删除都不许以
 * `tmpdir()` / `homedir()` / 根目录为目标。人写测试时会手滑，检查不会。
 *
 * 顺带钉住另一条同源的纪律：测试的临时目录必须建在仓库内
 * （`.cache/test-tmp`，见 apps/daemon/src/testing/tmp.ts），不能散到系统临时目录里——
 * 否则沙箱环境写不了、清理也容易漏。
 */

const REPO_ROOT = join(import.meta.dirname, '..')

/**
 * 递归删除的入口。
 *
 * ⚠️ **必须包含仓库自己的 `cleanup()`**（apps/daemon/src/testing/tmp.ts）。
 *    第一版只列了 `rm/rmSync/rimraf/rmdir`，于是它漏掉了那次真实的事故写法
 *    `cleanup(tmpdir())`——因为那行里根本没出现 `rm` 这个词。守卫抓不到真实
 *    事故，就是装饰品。所以这里同时列"底层函数名"与"本仓库的包装函数名"。
 */
const DESTRUCTIVE =
  /\b(rm|rmSync|rimraf|rmdir|rmdirSync|cleanup|removeDir|remove|deleteDir|rmrf|forceRemove)\s*\(/g

/** 危险目标：操作系统临时目录、家目录、根目录。 */
const DANGEROUS_TARGETS = [
  { pattern: /tmpdir\s*\(\s*\)/, why: '操作系统的临时目录' },
  { pattern: /homedir\s*\(\s*\)/, why: '家目录' },
  { pattern: /['"`]\/['"`]/, why: '文件系统根目录' },
]

async function collectTestFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'ref') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectTestFiles(full, out)
    else if (entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('★ 测试安全：不许递归删除危险目录', () => {
  test('★ 没有哪条测试对 tmpdir()/homedir()/根目录做递归删除', async () => {
    const files = await collectTestFiles(REPO_ROOT)
    assert.ok(files.length > 20, `应当扫到不少测试文件，实际 ${files.length}`)

    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const lines = source.split('\n')

      for (const [index, line] of lines.entries()) {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
        DESTRUCTIVE.lastIndex = 0
        if (!DESTRUCTIVE.test(line)) continue

        // 往后看几行：参数常常写在下一行（`cleanup(\n  target\n)`）
        const window = lines.slice(index, index + 4).join('\n')
        for (const target of DANGEROUS_TARGETS) {
          if (target.pattern.test(window)) {
            offenders.push(
              `${relative(REPO_ROOT, file)}:${index + 1} 对${target.why}做递归删除 → ${line.trim()}`,
            )
          }
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `★ 递归删除危险目录是**不可逆**的，一旦手滑就会毁掉使用者机器上的东西：\n${offenders.join('\n')}`,
    )
  })

  test('★ 测试文件里根本不该出现 tmpdir()', async () => {
    // 比"别拿它去删"更强的一条：**根本别用**。测试的临时目录一律建在仓库内的
    // `.cache/test-tmp`（见 testing/tmp.ts）。用系统临时目录有两个问题：
    // 一是沙箱环境下写不进去，二是它离"被误删"只有一步之遥。
    const files = await collectTestFiles(REPO_ROOT)
    const offenders: string[] = []
    for (const file of files) {
      // 守卫自己当然要提到 tmpdir()——那是它在检查的东西
      if (file.endsWith('test-safety.test.ts')) continue
      const source = await readFile(file, 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
        if (/tmpdir\s*\(\s*\)/.test(line)) {
          offenders.push(`${relative(REPO_ROOT, file)}:${index + 1} → ${line.trim()}`)
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `★ 测试不要用 os.tmpdir()，请用 testing/tmp.ts 的 makeTempDir()：\n${offenders.join('\n')}`,
    )
  })

  test('★ 测试的临时目录建在仓库内（沙箱里也写得进去）', async () => {
    const tmpHelper = join(REPO_ROOT, 'apps/daemon/src/testing/tmp.ts')
    const source = await readFile(tmpHelper, 'utf8')
    assert.match(
      source,
      /\.cache/,
      '临时目录必须落在仓库内的 .cache 下——写到系统临时目录在沙箱环境下会直接失败',
    )
    assert.equal(
      /tmpdir\s*\(\s*\)/.test(source),
      false,
      '★ 别用 os.tmpdir()：既可能写不了，也容易在清理时误伤',
    )
  })
})
