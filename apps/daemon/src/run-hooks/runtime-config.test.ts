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
 *   ② 唯一的差异是受管目录**按不按工作目录分**——它在策略表里，而不是两段 if；
 *   ③ 按策略派生出来的行为（删目录、清旧目录）也自动跟着走（claude 无操作、codex 真删）。
 */
describe('★ 分批第 64 批：两个 runtime 一条逻辑', () => {
  test('★★★ 受管目录的差异在 **profile 子类**里，不在两段实现里', () => {
    const claudeProfile = profileFor('claude')
    const codexProfile = profileFor('codex')
    assert.ok(claudeProfile !== null && codexProfile !== null)
    const claudePlan = claudeProfile.isolation({ rootDir: '/root', sourcePath: '', hostSkillRoots: [] })
    const codexPlan = codexProfile.isolation({ rootDir: '/root', sourcePath: '', hostSkillRoots: [] })
    assert.equal(claudePlan.perWorkDir, false, 'claude：全局一份（resume 要稳定的会话状态）')
    assert.equal(codexPlan.perWorkDir, true, 'codex：按工作目录分（trust 段每轮不同）')
    assert.equal(claudePlan.scanHostSkills, false, 'claude 实测不读 ~/.agents/skills')
    assert.equal(codexPlan.scanHostSkills, true, 'codex 会扫，要逐条禁用')
    for (const key of ['claude', 'codex'] as const) {
      assert.ok((profileFor(key)?.why.length ?? 0) > 10, `${key} 的 profile 必须写清"为什么"`)
    }
    assert.equal(managedHomeFor('claude', '/root', '/ws/a'), '/root', 'claude 不按工作目录分')
    assert.equal(managedHomeFor('codex', '/root', '/ws/a'), codexHomeFor('/root', '/ws/a'))
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
    assert.equal(claude.home, join(dataDir, 'claude-config'), 'claude 的受管目录就是根')
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

    // claude：策略是"全局一份" ⇒ 删实体不该去动它
    assert.equal(
      await forgetRuntimeConfigHome('claude', join(dataDir, 'claude-config'), work),
      false,
      'claude 的受管目录是全局的，删某个任务不该动它',
    )
    // codex：真删
    assert.equal(await forgetRuntimeConfigHome('codex', codexRoot, work), true)
    assert.equal(await exists(sync.home), false)
    // 清理旧目录同理（claude 无操作）
    assert.deepEqual(await pruneRuntimeConfigHomes('claude', join(dataDir, 'claude-config'), '/x'), [])
    await cleanup(dataDir)
  })
})
