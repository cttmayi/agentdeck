import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  ClaudeProfile,
  CodexProfile,
  GenericProfile,
  knownProfileKeys,
  profileFor,
  RuntimeProfile,
} from './runtime-profile.ts'

/**
 * ★ 分批第 67 批：平台侧的差异收进 `RuntimeProfile` 子类（不在 executor 里写 `if key ===`）。
 *
 * 使用者：「尽量还是用公共类，通过继承来实现它们之间的差异」。
 *
 * 这一组钉的是：**差异是子类声明出来的**，而不是散在调用点上的名字判断。
 */
describe('★ 分批第 67 批：RuntimeProfile（平台侧差异的唯一定义处）', () => {
  test('★★★ 三个 runtime 各是一个子类，默认值 = "最少副作用"', () => {
    assert.ok(profileFor('claude') instanceof ClaudeProfile)
    assert.ok(profileFor('codex') instanceof CodexProfile)
    assert.ok(profileFor('generic') instanceof GenericProfile)
    assert.ok(profileFor('claude') instanceof RuntimeProfile, '都是同一个基类的子类')
    assert.equal(profileFor('不存在的 runtime'), null, '未知 runtime ⇒ null（调用方什么都不做）')
    assert.deepEqual(knownProfileKeys().sort(), ['claude', 'codex', 'generic'])
  })

  test('★★★ 差异全在 plan 里：claude 全局一份不扫宿主级、codex 按工作目录分且要扫', () => {
    const deps = { rootDir: '/root', sourcePath: '/src', hostSkillRoots: ['/host'] }
    const claude = profileFor('claude')!.isolation(deps)
    const codex = profileFor('codex')!.isolation(deps)
    assert.deepEqual(claude, {
      rootDir: '/root',
      sourcePath: '/src',
      perWorkDir: false,
      scanHostSkills: false,
    })
    assert.deepEqual(codex, {
      rootDir: '/root',
      sourcePath: '/src',
      perWorkDir: true,
      scanHostSkills: true,
    })
    // generic 显式"不做隔离"（以前是 executor 里没写它 ⇒ 隐式的"漏了"）
    assert.equal(profileFor('generic')!.isolation(deps).rootDir, null)
  })

  test('★★ 任务隔离 hook 只有 claude 有（注入与摘除读同一个判据）', () => {
    assert.equal(profileFor('claude')!.injectsRunHooks(), true)
    assert.equal(profileFor('codex')!.injectsRunHooks(), false)
    assert.equal(profileFor('generic')!.injectsRunHooks(), false)
    // 基类默认 false：新 runtime 不会因为漏写而"多做一件没人预期的事"
    class NewRuntime extends RuntimeProfile {
      readonly why = '新 runtime 的占位'
    }
    assert.equal(new NewRuntime().injectsRunHooks(), false)
    assert.equal(new NewRuntime().isolation({ rootDir: '/x', sourcePath: '', hostSkillRoots: [] }).rootDir, null)
  })

  test('★ 每一条差异都必须能说出理由（why 不能空）', () => {
    for (const key of knownProfileKeys()) {
      const why = profileFor(key)!.why
      assert.ok(why.trim().length > 10, `${key} 的 profile 必须写清"为什么是这个形态"：${why}`)
    }
  })
})

/**
 * ★ 分批第 68 批：适配器侧按**交互方式**分族、公共部分在根上。
 *
 * 这一类判据不在运行时（它是继承结构），所以在源码层面钉住层次，别让"两族又各自长一份"。
 */
describe('★ 分批第 68 批：适配器的类层次（按交互方式分族）', () => {
  test('★★★ 两个族都继承同一个根类；两族各自只有一个类', async () => {
    const { readFile } = await import('node:fs/promises')
    const root = new URL('../../../../packages/agent-core/src/', import.meta.url)
    const baseSrc = await readFile(new URL('backend-base.ts', root), 'utf8')
    const serviceSrc = await readFile(new URL('service-backend.ts', root), 'utf8')

    assert.match(baseSrc, /export abstract class AgentBackendBase/, '根类在')
    assert.match(
      baseSrc,
      /export abstract class LineStreamBackendBase<P extends LineStreamParserLike>\s*\n\s*extends AgentBackendBase/,
      '✦ cli 族必须继承根类（否则 probe/解析可执行文件又各写一份）',
    )
    assert.match(
      serviceSrc,
      /export abstract class ServiceBackendBase extends AgentBackendBase/,
      '✦ service 族必须继承根类',
    )
    // 两族都不许再各自实现 resolveExecutable / probe（那是根类的事）
    for (const [name, src] of [
      ['backend-base.ts 的 cli 族', baseSrc.slice(baseSrc.indexOf('class LineStreamBackendBase'))],
      ['service-backend.ts', serviceSrc],
    ] as const) {
      assert.ok(
        !/protected async resolveExecutable\(/.test(src),
        `${name} 不该再自己实现 resolveExecutable（第 68 批把它收进根类了）`,
      )
      assert.ok(!/^\s*async probe\(\)/m.test(src), `${name} 不该再自己实现 probe()`)
    }
  })
})
