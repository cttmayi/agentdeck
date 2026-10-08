import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { describe, test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ToolSourceError, expandHome, resolveLocalToolPath } from './tool-source.ts'
import { MAX_FILES } from '@agentdeck/skill-source'
import { makeTempDir } from './testing/tmp.ts'

/**
 * 工具包来源解析（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里守的是"标准格式真的能拦住不好的包"
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者要的是"工具目录最好有一个标准格式，用于判断是否适配本平台"。
 * 判据写在 `packages/protocol/src/tools.ts` 的 schema 里，而这个文件负责
 * 证明**每一条判据都真的会拒**——否则"标准格式"只是文档里的一句话。
 *
 * 错误还必须**说得具体**：写工具包的人看到的是那句消息，不是 issue 列表。
 * 所以几条 asserts 直接钉住"消息里提到了缺什么、去哪儿改"。
 */

const EXAMPLE = resolve('examples/tools/example-note')

/** 往一个临时目录里写一个包，返回目录路径。 */
async function writePackage(
  label: string,
  files: Record<string, string | Buffer>,
): Promise<string> {
  const dir = await makeTempDir(`tool-${label}`)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

const manifest = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'agentdeck/tool@1',
    slug: 'demo',
    name: '演示工具',
    runtime: 'node',
    entry: 'run.mjs',
    actions: [{ name: 'go', summary: '做事', reversible: true, dryRun: 'supported' }],
    ...patch,
  })

describe('D40：工具包来源解析', () => {
  test('★ 仓库里的示例包能装上（它就是给作者抄的那份）', async () => {
    const pkg = await resolveLocalToolPath(EXAMPLE)
    assert.equal(pkg.manifest.slug, 'example-note')
    assert.deepEqual(
      pkg.manifest.actions.map((a) => `${pkg.manifest.slug}.${a.name}`),
      ['example-note.append-note', 'example-note.clean-notes'],
    )
    // 入口脚本必须真的在包里（清单说了不算）
    assert.ok('scripts/note.mjs' in pkg.files)
    assert.ok('scripts/clean.mjs' in pkg.files)
    // 清单与 TOOL.md 不进 files——它们不是支持文件，各有各的字段
    assert.equal('tool.json' in pkg.files, false)
    assert.equal('TOOL.md' in pkg.files, false)
    assert.ok(pkg.docs.includes('# 示例工具'), 'TOOL.md 的正文要留下（界面要显示）')
    assert.equal(pkg.sourceRef, `path:${EXAMPLE}`)
  })

  test('★ 也能直接指向 tool.json（编辑器里复制出来的常是文件路径）', async () => {
    const pkg = await resolveLocalToolPath(join(EXAMPLE, 'tool.json'))
    assert.equal(pkg.manifest.slug, 'example-note')
  })

  test('★ 缺 tool.json ⇒ 说清"它不是工具包"并列出目录里有什么', async () => {
    const dir = await writePackage('no-manifest', { 'SKILL.md': '# 我是个技能' })
    const err = await resolveLocalToolPath(dir).then(
      () => null,
      (e: unknown) => e as ToolSourceError,
    )
    assert.ok(err)
    assert.equal(err.code, 'missing_tool_json')
    assert.match(err.message, /这里没有 tool\.json/)
    assert.match(String(err.detail), /SKILL\.md/, '要列出目录里到底有什么')
  })

  test('★ 大小写不对给一句人话（macOS 上碰巧能读，Linux 上不行）', async () => {
    const dir = await writePackage('case', { 'Tool.json': manifest(), 'run.mjs': 'x' })
    const err = await resolveLocalToolPath(dir).catch((e: ToolSourceError) => e)
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'missing_tool_json')
    assert.match(String(err.detail), /全小写/)
  })

  test('清单不是合法 JSON ⇒ bad_json（并说清 JSON 的规矩）', async () => {
    const dir = await writePackage('bad-json', {
      'tool.json': "{ schema: 'agentdeck/tool@1' }",
      'run.mjs': 'x',
    })
    const err = await resolveLocalToolPath(dir).catch((e: ToolSourceError) => e)
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'bad_json')
  })

  test('★ 判据不过 ⇒ manifest_invalid，且**逐条**列出哪里不合规', async () => {
    // 版本号不是 x.y.z + runtime 不在白名单 + 动作名不是 kebab-case（三处）
    //
    // ⚠️ D41：这里的第三项原来是 `slug: 'issue'`（"占用了内置动作的前缀"）。
    //    三个前缀保留（`RESERVED_TOOL_SLUGS = ['comment','issue','notify']`）
    //    随内置动作一起从 `packages/protocol/src/tools.ts` 删掉了，所以
    //    `issue` / `comment` / `notify` **不再是保留字**，`slug: 'issue'` 现在
    //    完全合法（见那边 slug 字段上的注释）。要保住"逐条列出"这条用例的主体，
    //    就得换一个**真的**不合规的字段——版本号必须是 `x.y.z`。
    const dir = await writePackage('invalid', {
      'tool.json': manifest({
        version: '1.0',
        runtime: 'bash -c',
        actions: [{ name: 'Go', summary: 'x', reversible: true, dryRun: 'supported' }],
      }),
      'run.mjs': 'x',
    })
    const err = await resolveLocalToolPath(dir).catch((e: ToolSourceError) => e)
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'manifest_invalid')
    assert.match(String(err.detail), /version/, '要点到具体字段')
    assert.match(String(err.detail), /runtime/)
    // 三处不合规就该报三处，不能只报第一条
    assert.ok(String(err.detail).split('\n').filter((l) => l.startsWith('·')).length >= 3)
  })

  test('★ 清单声明的入口不在包里 ⇒ missing_entry（且点名是哪个动作）', async () => {
    const dir = await writePackage('missing-entry', {
      'tool.json': manifest({
        actions: [
          { name: 'go', summary: 'x', reversible: true, dryRun: 'supported' },
          { name: 'other', summary: 'y', reversible: true, dryRun: 'supported', entry: 'missing.mjs' },
        ],
      }),
      'run.mjs': 'x',
    })
    const err = await resolveLocalToolPath(dir).catch((e: ToolSourceError) => e)
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'missing_entry')
    assert.match(err.message, /missing\.mjs/)
    assert.match(err.message, /other/, '要说清是哪个动作的入口缺了')
  })

  test('★ 二进制文件被明确记下"没装"，而不是静默装进来', async () => {
    const dir = await writePackage('binary', {
      'tool.json': manifest(),
      'run.mjs': 'console.log(1)',
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    })
    const pkg = await resolveLocalToolPath(dir)
    assert.equal('logo.png' in pkg.files, false)
    const ignored = pkg.ignored.find((i) => i.path === 'logo.png')
    assert.ok(ignored, '要如实记下来一件事：这个文件没装')
    assert.match(ignored.reason, /二进制/)
  })

  test('tool.json 自己是二进制 ⇒ 不能说"没有 tool.json"', async () => {
    const dir = await writePackage('binary-manifest', {
      'tool.json': Buffer.from([0x00, 0x01, 0x02, 0x03]),
      'run.mjs': 'x',
    })
    const err = await resolveLocalToolPath(dir).catch((e: ToolSourceError) => e)
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'binary_file', '它明明在，只是内容不对——说成"没有"会让人白查文件名')
  })

  test('★ slug 以清单为准：显式覆盖值不一致时直接拒（否则判决里该写哪个没有答案）', async () => {
    const err = await resolveLocalToolPath(EXAMPLE, { slug: 'other-name' }).catch(
      (e: ToolSourceError) => e,
    )
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'bad_input')
    assert.match(err.message, /不一致/)
  })

  test('相对路径 ⇒ bad_input（它取决于 daemon 从哪儿启动）', async () => {
    const err = await resolveLocalToolPath('examples/tools/example-note').catch(
      (e: ToolSourceError) => e,
    )
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'bad_input')
  })

  test('文件数量超上限 ⇒ too_many_files', async () => {
    // ⚠️ 随共享的 `MAX_FILES` 走（skill 与工具**共享规则常量**，见 tool-source.ts 头注释）：
    //    写死 70 会随着上限提高变成"没超限却期望报错"（2026-10 上限提到 512 就踩了）。
    const files: Record<string, string> = { 'tool.json': manifest(), 'run.mjs': 'x' }
    for (let i = 0; i < MAX_FILES; i += 1) files[`f${i}.txt`] = 'x'
    const dir = await writePackage('many', files)
    const err = await resolveLocalToolPath(dir).catch((e: ToolSourceError) => e)
    assert.ok(err instanceof ToolSourceError)
    assert.equal(err.code, 'too_many_files')
  })
})

describe('★ Windows：`~\` 也是家目录（2026-10 兼容性审计）', () => {
  test('expandHome 认 `~/` 也认 `~\`；不认别的', () => {
    const home = homedir()
    assert.equal(expandHome('~'), home)
    assert.ok(expandHome('~/tools').startsWith(home), '`~/tools` 要展开到家目录底下')
    assert.ok(expandHome('~\\tools').startsWith(home), '`~\\tools` 也要展开')
    // 中间的 `~` 不是家目录（`a/~/b` 是普通相对路径）
    assert.equal(expandHome('a/~/b'), 'a/~/b')
  })
})
