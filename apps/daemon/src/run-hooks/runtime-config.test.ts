import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cleanup, makeTempDir } from '../testing/tmp.ts'
import { codexHomeFor } from './codex-config.ts'
import { forgetRuntimeConfigHome, managedHomeFor, pruneRuntimeConfigHomes, syncRuntimeConfig } from './runtime-config.ts'
import { profileFor } from './runtime-profile.ts'

/**
 * ★ 分批第 64 批：claude 与 codex 的配置隔离走**同一条**逻辑。
 *
 * 使用者：「我还是建议同一逻辑，代码尽量复用」。
 *
 * 这一组钉的是「复用」到底成不成立：
 *   ① 两个 runtime 都从**同一个函数**进来，各自产出「日志说明 + 要注入的 env」；
 *   ② 差异（扫不扫宿主级技能、关不关自带 skills）在 **profile 子类**里，不是两段 if；
 *   ③ 按策略派生出来的行为（删目录、清旧目录）也自动跟着走。
 *
 * ★ 分批第 77 批：**claude 也按工作目录分了**（原来全局一份）。所以这里不再有
 *   "claude 不按工作目录分"那种断言——两个 runtime 的**目录粒度**现在一致，
 *   剩下的差异只有"扫不扫宿主级技能"与"关不关自带 skills"。
 */
describe('★ 分批第 64 批：两个 runtime 一条逻辑', () => {
  test('★★★ 受管目录的差异在 **profile 子类**里，不在两段实现里', () => {
    const claudeProfile = profileFor('claude')
    const codexProfile = profileFor('codex')
    assert.ok(claudeProfile !== null && codexProfile !== null)
    const claudePlan = claudeProfile.isolation({ rootDir: '/root', sourcePath: '', hostSkillRoots: [] })
    const codexPlan = codexProfile.isolation({ rootDir: '/root', sourcePath: '', hostSkillRoots: [] })
    // ★ 分批第 77 批：两个 runtime 都按工作目录分。claude 的理由是"技能与 hook 都住这份
    //   home 里，而技能集按 agent 变"；会话按 cwd 索引，所以 resume 不受影响（实测过）。
    assert.equal(claudePlan.perWorkDir, true, 'claude：按工作目录分（分批第 77 批）')
    assert.equal(codexPlan.perWorkDir, true, 'codex：按工作目录分（trust 段每轮不同）')
    assert.equal(claudePlan.scanHostSkills, false, 'claude 实测不读 ~/.agents/skills')
    assert.equal(codexPlan.scanHostSkills, true, 'codex 会扫，要逐条禁用')
    for (const key of ['claude', 'codex'] as const) {
      assert.ok((profileFor(key)?.why.length ?? 0) > 10, `${key} 的 profile 必须写清"为什么"`)
    }
    assert.equal(managedHomeFor('claude', '/root', '/ws/a'), codexHomeFor('/root', '/ws/a'))
    assert.equal(managedHomeFor('codex', '/root', '/ws/a'), codexHomeFor('/root', '/ws/a'))
    for (const key of ['claude', 'codex'] as const) {
      assert.notEqual(
        managedHomeFor(key, '/root', '/ws/a'),
        managedHomeFor(key, '/root', '/ws/b'),
        `${key} 两个工作目录必须分开（否则并行 run 互相覆盖技能/会话）`,
      )
    }
    assert.notEqual(
      managedHomeFor('codex', '/root', '/ws/a'),
      managedHomeFor('codex', '/root', '/ws/b'),
      'codex 两个工作目录必须分开（否则并行 run 互相覆盖）',
    )
  })

  test('★★★ 同一个函数产出两个 runtime 的「notes + env」', async () => {
    const dataDir = await makeTempDir('rc-sync')
    const work = join(dataDir, 'ws')
    await mkdir(work, { recursive: true })
    const claudeSource = join(dataDir, 'claude-settings.json')
    await writeFile(claudeSource, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-fake' } }), 'utf8')
    const codexSource = join(dataDir, 'codex-src')
    await mkdir(codexSource, { recursive: true })
    await writeFile(join(codexSource, 'auth.json'), '{}\n', 'utf8')
    await writeFile(join(codexSource, 'config.toml'), 'model = "gpt-5"\n', 'utf8')

    const claude = await syncRuntimeConfig({
      runtimeKey: 'claude',
      rootDir: join(dataDir, 'claude-config'),
      workDir: work,
      sourcePath: claudeSource,
    })
    assert.equal(claude.ok, true, claude.reason ?? '')
    assert.equal(
      claude.home,
      codexHomeFor(join(dataDir, 'claude-config'), work),
      'claude 的受管目录按工作目录分（分批第 77 批）',
    )
    assert.equal(claude.env['CLAUDE_CONFIG_DIR'], claude.home)
    assert.equal(claude.env['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'], '1')
    assert.ok(claude.notes.some((n) => n.includes('claude 个人配置隔离：已启用')))
    assert.ok(claude.notes.some((n) => n.includes('plugin-authoring@builtin=false')))

    const codex = await syncRuntimeConfig({
      runtimeKey: 'codex',
      rootDir: join(dataDir, 'codex-config'),
      workDir: work,
      sourcePath: codexSource,
      hostSkills: [{ name: 'x', path: '/h/.agents/skills/x/SKILL.md' }],
    })
    assert.equal(codex.ok, true, codex.reason ?? '')
    assert.equal(codex.home, codexHomeFor(join(dataDir, 'codex-config'), work))
    assert.equal(codex.env['CODEX_HOME'], codex.home)
    assert.ok(codex.notes.some((n) => n.includes('codex 个人配置隔离：已启用')))
    assert.ok(codex.notes.some((n) => n.includes('宿主级技能：已逐条禁用 1 个')))
  })

  test('★★★ 删除/清理也按策略走：codex 真删、claude 无操作', async () => {
    const dataDir = await makeTempDir('rc-forget')
    const work = join(dataDir, 'ws')
    await mkdir(work, { recursive: true })
    const codexRoot = join(dataDir, 'codex-config')
    const codexSource = join(dataDir, 'codex-src')
    await mkdir(codexSource, { recursive: true })
    await writeFile(join(codexSource, 'auth.json'), '{}\n', 'utf8')
    await writeFile(join(codexSource, 'config.toml'), 'model = "x"\n', 'utf8')
    const sync = await syncRuntimeConfig({
      runtimeKey: 'codex',
      rootDir: codexRoot,
      workDir: work,
      sourcePath: codexSource,
    })
    assert.equal(sync.ok, true, sync.reason ?? '')
    const exists = async (p: string): Promise<boolean> =>
      readFile(join(p, 'config.toml'), 'utf8').then(
        () => true,
        () => false,
      )
    assert.equal(await exists(sync.home), true, '前提：同步之后那份目录存在')

    // claude：分批第 77 批起也按工作目录分 ⇒ **删实体同样要清**（那份 home 里
    // 有 settings.json 的 ANTHROPIC_* 副本）。先同步一份出来，再删。
    const claudeSource = join(dataDir, 'claude-settings.json')
    await writeFile(claudeSource, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-fake' } }), 'utf8')
    const claudeSync = await syncRuntimeConfig({
      runtimeKey: 'claude',
      rootDir: join(dataDir, 'claude-config'),
      workDir: work,
      sourcePath: claudeSource,
    })
    assert.equal(claudeSync.ok, true, claudeSync.reason ?? '')
    assert.equal(
      await readFile(join(claudeSync.home, 'settings.json'), 'utf8').then(
        () => true,
        () => false,
      ),
      true,
      '前提：那份 claude home 里有 settings.json',
    )
    assert.equal(
      await forgetRuntimeConfigHome('claude', join(dataDir, 'claude-config'), work),
      true,
      '★ claude 的 home 里也有凭据副本 ⇒ 删实体必须清掉它',
    )
    // codex：真删
    assert.equal(await forgetRuntimeConfigHome('codex', codexRoot, work), true)
    assert.equal(await exists(sync.home), false)
    // 清理旧目录同理：两个 runtime 都按 workdir 剪枝（claude 现在也有"每目录一份"）
    assert.deepEqual(
      await pruneRuntimeConfigHomes('claude', join(dataDir, 'claude-config'), claudeSync.home),
      [],
      '只有一份时不该删任何东西',
    )
    await cleanup(dataDir)
  })
})
