/**
 * codex 个人配置隔离（2026-10，D78 的 codex 版）：`syncCodexConfigDir` 的行为。
 *
 * 重点断言的是「copy 进受管目录的文件长什么样」：auth.json 与 config.toml
 * 整份 copy、文件 600（里面都有真实 key，只给属主读）、幂等覆盖（改 key
 * 即时生效）、以及源文件缺失时**返回 ok:false 带原因**而不是抛异常
 * （调用方据此记 note——不悄悄"以为隔离了"）。
 *
 * ⚠️ 临时目录一律走 `makeTempDir`（`.cache/test-tmp`）。这里不 spawn 任何
 * CLI（NFR-T-01：测试里绝不调用真实 agent CLI）。
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cleanup, makeTempDir } from '../testing/tmp.ts'
import {
  findSkillFiles,
  syncCodexConfigDir,
  withBundledSkillsDisabled,
  withHostSkillsDisabled,
  withTrustedProject,
} from './codex-config.ts'

test('syncCodexConfigDir：把源 ~/.codex 的 auth.json 与 config.toml copy 进受管目录', async () => {
  const root = await makeTempDir('ccd-codex')
  try {
    const source = join(root, 'codex-home')
    const configDir = join(root, 'codex-config')
    // 模拟 ~/.codex：auth.json（认证）与 config.toml（端点和 key 混在一起）
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-456' }), 'utf8')
    await writeFile(
      join(source, 'config.toml'),
      'model = "codex"\n[model_providers.local]\nbase_url = "http://127.0.0.1:8080"\napi_key = "sk-xxxx"\n',
      'utf8',
    )

    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.ok, true, '正常同步应成功')
    assert.deepEqual(result.copied, ['auth.json', 'config.toml'])

    const auth = JSON.parse(await readFile(join(configDir, 'auth.json'), 'utf8')) as { OPENAI_API_KEY: string }
    assert.equal(auth.OPENAI_API_KEY, 'sk-test-456')
    const toml = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:8080"/, 'config.toml 整份 copy（端点不能丢）')

    // ★ 两个文件都有真实 key：只给属主读
    for (const name of ['auth.json', 'config.toml']) {
      const mode = (await stat(join(configDir, name))).mode & 0o777
      assert.equal(mode, 0o600, `${name} 应为 600（有 key）`)
    }
  } finally {
    await cleanup(root)
  }
})

test('syncCodexConfigDir：幂等覆盖——改源 key 后重新同步即时生效', async () => {
  const root = await makeTempDir('ccd-codex-idem')
  try {
    const source = join(root, 'codex-home')
    const configDir = join(root, 'codex-config')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-old' }), 'utf8')
    await writeFile(join(source, 'config.toml'), 'model = "codex"\n', 'utf8')

    await syncCodexConfigDir(configDir, source)
    // 使用者换了 key（幂等语义：每次 run 现读现 copy，不用重启 daemon）
    await writeFile(join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-new' }), 'utf8')
    const result = await syncCodexConfigDir(configDir, source)

    assert.equal(result.ok, true)
    const auth = JSON.parse(await readFile(join(configDir, 'auth.json'), 'utf8')) as { OPENAI_API_KEY: string }
    assert.equal(auth.OPENAI_API_KEY, 'sk-new', '重新同步应覆盖旧值')
  } finally {
    await cleanup(root)
  }
})

test('syncCodexConfigDir：源缺文件 → ok:false 带原因，不抛异常', async () => {
  const root = await makeTempDir('ccd-codex-missing')
  try {
    const source = join(root, 'codex-home')
    const configDir = join(root, 'codex-config')
    // 只有 auth.json，没有 config.toml——codex 在受管目录下起不到"和平时
    // 一样"的状态（端点定义丢了），必须明说没隔离，不能悄悄跑偏
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), '{}', 'utf8')

    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /config\.toml/, '原因要指明缺哪个文件')
    assert.deepEqual(result.copied, ['auth.json'])
  } finally {
    await cleanup(root)
  }
})

test('syncCodexConfigDir：源目录不存在 → ok:false 带原因', async () => {
  const root = await makeTempDir('ccd-codex-nosrc')
  try {
    const source = join(root, 'no-such-codex-home')
    const configDir = join(root, 'codex-config')
    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.ok, false)
    assert.ok(result.reason, '要有原因')
  } finally {
    await cleanup(root)
  }
})

/**
 * ★ 分批第 55 批：让工作目录里的 `.codex/config.toml` 真的被读。
 *
 * 真机上量到（不是推断）：项目未 trusted 时 codex 只吐一句
 * `Project-local config, hooks, and exec policies are disabled … but skills still load`，
 * 项目级配置文件当场被忽略；在受管 `CODEX_HOME/config.toml` 里补上
 * `[projects."<workDir>"] trust_level = "trusted"` 之后，同一份文件立刻被读
 * （实测：往里塞一个不存在的键，trusted 前一声不响，trusted 后 codex 报
 * `project (…/.codex/config.toml): xxx is ignored`）。
 */
describe('★ 分批第 55 批：项目级配置的门（trusted）', () => {
  test('★★★ withTrustedProject：补一段、幂等、按 TOML 规则转义路径', () => {
    const text = 'model = "gpt-5"\n'
    const one = withTrustedProject(text, '/Users/ling/agentdeck-workspace/issue-1')
    assert.equal(one.added, true)
    assert.match(one.text, /\[projects\."\/Users\/ling\/agentdeck-workspace\/issue-1"\]\ntrust_level = "trusted"\n/u)
    assert.ok(one.text.startsWith('model = "gpt-5"'), '原有内容一个字都不许动')

    // 幂等：再来一次不追加（TOML 重复定义同一个表是错误，追加两次 codex 直接起不来）
    const twice = withTrustedProject(one.text, '/Users/ling/agentdeck-workspace/issue-1')
    assert.equal(twice.added, false)
    assert.equal(twice.text, one.text)

    // Windows 路径：反斜杠必须转义，否则 config.toml 解析失败（而报错只说"配置坏了"）。
    // ⚠️ 这里用字符串拼而不是正则：正则里"匹配两个反斜杠"要写四个，读起来全是噪声，
    //    而这条判据的意图是"TOML 里应该写成两个反斜杠"——写清楚比压缩表达式重要。
    const winDir = 'C:\\Users\\ling\\agentdeck-workspace\\issue-2'
    const winEscaped = winDir.replace(/\\/g, '\\\\')
    const win = withTrustedProject('', winDir)
    assert.ok(
      win.text.includes(`[projects."${winEscaped}"]`),
      `Windows 路径要按 TOML 转义，实际：${win.text}`,
    )
  })

  test('★★★ 同步时给 trustProjectDir ⇒ 受管 config.toml 里真的多了那一段', async () => {
    const dataDir = await makeTempDir('codex-trust-sync')
    const source = join(dataDir, 'user-codex')
    const configDir = join(dataDir, 'managed')
    const workDir = join(dataDir, 'issue-trust-me')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), '{"OPENAI_API_KEY":"sk-fake"}\n', 'utf8')
    await writeFile(join(source, 'config.toml'), 'model = "gpt-5"\n', 'utf8')
    // 项目级 config（这次要它生效的那一份）
    await mkdir(join(workDir, '.codex'), { recursive: true })
    await writeFile(join(workDir, '.codex', 'config.toml'), 'project_setting = 1\n', 'utf8')

    const result = await syncCodexConfigDir(configDir, source, workDir)
    assert.equal(result.ok, true, result.reason ?? '')
    assert.equal(result.trustedProject, workDir, 'note 要知道信任了哪个目录')
    assert.ok(
      typeof result.trustedProjectConfigHash === 'string' &&
        result.trustedProjectConfigHash.length === 12,
      '项目级 config 的指纹要记下来（audit 用，内容不进日志）',
    )
    const written = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.match(written, /trust_level = "trusted"/u)
    assert.ok(written.includes(workDir), '受管 config.toml 里要指向这次的工作目录')
    assert.ok(written.startsWith('model = "gpt-5"'), '使用者那份配置要在（复制语义不变）')

    // 再来一轮同一个目录 ⇒ 不许出现第二段（否则 codex 起不来）
    const again = await syncCodexConfigDir(configDir, source, workDir)
    assert.equal(again.ok, true)
    const serialized = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.equal(
      serialized.split(`[projects."${workDir}"]`).length - 1,
      1,
      '同一个项目的 trust 段只能有一段',
    )
  })

  test('★★ 不给 trustProjectDir ⇒ 不写 trust 段（但 system skills 照关——那是与项目无关的一条）', async () => {
    const dataDir = await makeTempDir('codex-trust-none')
    const source = join(dataDir, 'user-codex')
    const configDir = join(dataDir, 'managed')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), '{}\n', 'utf8')
    await writeFile(join(source, 'config.toml'), 'model = "gpt-5"\n', 'utf8')
    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.trustedProject, null, '不传就不该信任任何项目')
    const written = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.ok(!written.includes('[projects."'), '不传 trustProjectDir 就不许出现信任段')
    // ★ 分批第 56 批：`[skills.bundled]` 与项目无关，属于"每次 run 都要关"的那一条
    assert.match(written, /\[skills\.bundled\]\nenabled = false/u)
  })
})

/**
 * ★ 分批第 56 批：关掉 codex **自带**的 system skills。
 *
 * 实测依据（本机 0.157.1，`codex debug prompt-input`）：干净 CODEX_HOME 下有三个技能根 ——
 * 工作目录的 `.codex/skills`（我们注入的）、`$HOME/.agents/skills`（跨 agent 全局目录）、
 * `CODEX_HOME/skills/.system`（codex 自带 6 个）。使用者看到"9 个"就是后两个相加。
 *
 * 关掉自带那 6 个的键（上游 PR #13792 的落地名）实测有效：
 *
 *     [skills.bundled]
 *     enabled = false
 *
 * 留下 `~/.agents/skills` 是因为**没有任何配置键能关它**（上游 issue #46414 / #24237 / #56659
 * 都还开着），只能靠改 HOME ——那会连带丢 `~/.ssh` 与 `~/.config`，不在这一步做。
 */
describe('★ 分批第 56 批：关掉 codex 自带的 system skills', () => {
  test('★★★ withBundledSkillsDisabled：追加一段、幂等、不覆盖使用者自己那段', () => {
    const one = withBundledSkillsDisabled('model = "gpt-5"\n')
    assert.equal(one.added, true)
    assert.ok(one.text.endsWith('[skills.bundled]\nenabled = false\n'), one.text)
    assert.ok(one.text.startsWith('model = "gpt-5"'), '使用者那份配置一个字不动')

    const twice = withBundledSkillsDisabled(one.text)
    assert.equal(twice.added, false)
    assert.equal(twice.alreadyConfigured, true, '再来一次要认出已经配过了')

    // 使用者自己写过这一段 ⇒ **不改**（TOML 重复定义同一个表会让 codex 起不来）
    const theirs = '[skills.bundled]\nenabled = true\n'
    const kept = withBundledSkillsDisabled(theirs)
    assert.equal(kept.added, false)
    assert.equal(kept.text, theirs, '使用者的配置不许被平台改写')
  })

  test('★★★ 同步之后受管 config.toml 里真有这一段，且我们注入的技能不受影响', async () => {
    const dataDir = await makeTempDir('codex-bundled')
    const source = join(dataDir, 'user-codex')
    const configDir = join(dataDir, 'managed')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), '{}\n', 'utf8')
    await writeFile(join(source, 'config.toml'), 'model = "gpt-5"\n', 'utf8')

    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(result.bundledSkills, 'disabled')
    const written = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.match(written, /\[skills\.bundled\]\nenabled = false/u)
  })

  test('★★ 使用者自己配了 [skills.bundled] ⇒ 如实回报"没被我们改写"（日志要说出来）', async () => {
    const dataDir = await makeTempDir('codex-bundled-theirs')
    const source = join(dataDir, 'user-codex')
    const configDir = join(dataDir, 'managed')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), '{}\n', 'utf8')
    await writeFile(join(source, 'config.toml'), '[skills.bundled]\nenabled = true\n', 'utf8')

    const result = await syncCodexConfigDir(configDir, source)
    assert.equal(
      result.bundledSkills,
      'already-configured',
      '这时平台没关掉那一组，"已关闭"的话会说谎 ⇒ 交给调用方如实说',
    )
    const written = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.equal(written, '[skills.bundled]\nenabled = true\n')
  })
})

/**
 * ★ 分批第 57 批：宿主级技能（`$HOME/.agents/skills`）逐条禁用。
 *
 * 机制是使用者实测出来的：他在 `~/temp` 里用 codex 的 `/skills` 关掉了 find-skills，
 * 结果写在 `~/.codex/config.toml`：
 *
 *     [[skills.config]]
 *     path = "/Users/ling/.agents/skills/find-skills/SKILL.md"
 *     enabled = false
 *
 * 我复核过（`codex debug prompt-input`）：单文件禁用 ⇒ 该 skill 从模型清单消失；
 * **目录当 path 无效** ⇒ 必须逐条列 SKILL.md；对 codex 自带的 `.system` 同样有效。
 */
describe('★ 分批第 57/58 批：宿主级技能禁用（skills.config）', () => {
  test('★★★ withHostSkillsDisabled：**优先按 name**、读不到 name 才按 path、幂等、不覆盖使用者开关', () => {
    const one = withHostSkillsDisabled('model = "gpt-5"\n', [
      { name: 'find-skills', path: '/h/.agents/skills/find-skills/SKILL.md' },
      { name: 'manim', path: '/h/.agents/skills/manim/SKILL.md' },
      // 读不到 frontmatter name 的（退回按绝对路径）
      { name: null, path: '/h/.agents/skills/无名/SKILL.md' },
    ])
    assert.deepEqual(one.disabled, ['find-skills', 'manim', '/h/.agents/skills/无名/SKILL.md'])
    // 分批第 58 批实测：按 name 关是有效的，而且比 path 省（嵌套副本一条就够）
    assert.match(one.text, /\[\[skills\.config\]\]\nname = "find-skills"\nenabled = false/u)
    assert.match(
      one.text,
      /\[\[skills\.config\]\]\npath = "\/h\/\.agents\/skills\/无名\/SKILL\.md"\nenabled = false/u,
      '没有 name 的技能退回按路径关',
    )
    assert.ok(one.text.startsWith('model = "gpt-5"'), '使用者那份配置一个字都不动')

    const twice = withHostSkillsDisabled(one.text, [
      { name: 'find-skills', path: '/h/.agents/skills/find-skills/SKILL.md' },
    ])
    assert.equal(twice.disabled.length, 0)
    assert.deepEqual(twice.alreadyListed, ['find-skills'])
    assert.equal(twice.text, one.text, '重复追加会让 config.toml 里出现两条一样的表')

    // 使用者自己关过（或在 /skills 里点过）⇒ 我们不碰他的取值（他可能故意开回来）
    const theirs = '[[skills.config]]\nname = "find-skills"\nenabled = true\n'
    const kept = withHostSkillsDisabled(theirs, [
      { name: 'find-skills', path: '/h/.agents/skills/find-skills/SKILL.md' },
    ])
    assert.deepEqual(kept.disabled, [])
    assert.deepEqual(kept.alreadyListed, ['find-skills'])
    assert.equal(kept.text, theirs)
  })

  test('★★ findSkillFiles：递归找 SKILL.md（codex 也认嵌套那份），找不到就是空数组', async () => {
    const dir = await makeTempDir('host-skills')
    const root = join(dir, 'agents-skills')
    await mkdir(join(root, 'alpha'), { recursive: true })
    await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n\n# a\n', 'utf8')
    // 嵌套那份（真机上的 fireworks-tech-graph 就是这样，codex 把两份都列出来了）
    await mkdir(join(root, 'beta', 'skills', 'beta'), { recursive: true })
    await writeFile(
      join(root, 'beta', 'skills', 'beta', 'SKILL.md'),
      '---\nname: beta\n---\n\n# b\n',
      'utf8',
    )
    await writeFile(join(root, 'beta', 'README.md'), 'no\n', 'utf8')

    const found = await findSkillFiles([root])
    assert.equal(found.length, 2, `实际：${found.map((s) => s.path).join('、')}`)
    assert.ok(found.every((s) => s.path.endsWith('SKILL.md')))
    assert.deepEqual(
      found.map((s) => s.name),
      ['alpha', 'beta'],
      '★ 要读出 frontmatter 里的 name（按 name 关比 path 省）',
    )

    const none = await findSkillFiles([join(dir, '不存在的目录')])
    assert.deepEqual(none, [], '目录不存在是正常情况（没装这类技能），不该抛')
  })

  test('★★★ 同步时给了宿主级技能 ⇒ 受管 config.toml 里逐条写上了 enabled=false', async () => {
    const dataDir = await makeTempDir('host-skills-sync')
    const source = join(dataDir, 'user-codex')
    const configDir = join(dataDir, 'managed')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'auth.json'), '{}\n', 'utf8')
    await writeFile(join(source, 'config.toml'), 'model = "gpt-5"\n', 'utf8')

    const result = await syncCodexConfigDir(configDir, source, undefined, [
      { name: 'find-skills', path: '/h/.agents/skills/find-skills/SKILL.md' },
    ])
    assert.deepEqual(result.hostSkillsDisabled, ['find-skills'])
    const written = await readFile(join(configDir, 'config.toml'), 'utf8')
    assert.match(written, /name = "find-skills"\nenabled = false/u)
    // 与"关掉自带 system skills"那一条并存
    assert.match(written, /\[skills\.bundled\]\nenabled = false/u)
  })
})
