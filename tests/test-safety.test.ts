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

/**
 * ★ 分批第 43 批：`windowsVerbatimArguments` 不许再漏（真 Windows 上起不来的那一格）。
 *
 * 背景是使用者真机报的："`.cmd`/`.bat` 启动失败……在 process-tree 中，调用
 * `cmd /d /s /c` 时，需要设置 `VerbatimArguments: true`，避免转义"。
 * 当时的写法是**每个 spawn 路自己拼一份选项**（`process-tree` 一份、
 * `script-executor` 一份），两份都漏了这个旗标——纯函数测试全绿，Windows 上全挂。
 *
 * 修法不是"各补一行"，而是让"决定起什么"与"怎么起"之间只有一条通道
 * （`spawnPlanFor`）。这条检查守的就是那个通道：
 *
 *   凡是生产代码里调 `resolveSpawnTarget(` 的文件，也必须用 `spawnPlanFor(`。
 *
 * 为什么用"文件级"而不是"行级"：行级要写解析器，而这里真正想禁止的是
 * "新增了一条起进程的路、但忘了那一个旗标"。文件级就够——新增一条路必然要在
 * 同一个文件里解析 target，于是它也必然会被要求带上 plan。
 */
describe('★ Windows 起进程：verbatim 旗标只有一个出口（spawnPlanFor）', () => {
  async function collectProdFiles(dir: string, out: string[] = []): Promise<string[]> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'ref') continue
      if (entry.name === 'dist' || entry.name === 'web') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await collectProdFiles(full, out)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
    }
    return out
  }

  test('★ 用了 resolveSpawnTarget 的生产文件，必须同时用 spawnPlanFor', async () => {
    const files = [
      ...(await collectProdFiles(join(REPO_ROOT, 'apps'))),
      ...(await collectProdFiles(join(REPO_ROOT, 'packages'))),
    ]
    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (!source.includes('resolveSpawnTarget(')) continue
      // 定义它的那个文件自己不算（它同时导出两个函数）
      if (file.endsWith(join('agent-core', 'spawn-target.ts'))) continue
      if (!source.includes('spawnPlanFor(')) offenders.push(relative(REPO_ROOT, file))
    }
    assert.deepEqual(
      offenders,
      [],
      `这些文件解析了 spawn target 却没走 spawnPlanFor（= windowsVerbatimArguments 会漏，` +
        `真 Windows 上 .cmd/.bat 起不来）：${offenders.join('、')}`,
    )
  })
})
