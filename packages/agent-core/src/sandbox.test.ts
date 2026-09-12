import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  SandboxUnavailableError,
  planSandbox,
  probeSandbox,
} from './sandbox.ts'

/**
 * 可选沙箱。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一组测试里最重要的是"**不可用时会怎样**"
 * ══════════════════════════════════════════════════════════════════
 *
 * 沙箱包装本身长什么样并不难，难的是它**拿不到**的时候怎么处置。
 * 如果那时候选择"那就直接跑吧"，使用者就会在**以为自己被保护着**的
 * 情况下裸奔——这种失败比"功能没做"严重得多，因为它把安全感本身
 * 变成了假的。
 *
 * 所以最关键的三条测试是：不可用时必须抛、探测结果要说清原因、
 * 以及 `none` 模式下审计里也要留痕（"当时没被沙箱"是个必须可查的事实）。
 *
 * 所有探测都注入 `hasTool`，不依赖跑测试的机器上装了什么。
 */

const never = async (): Promise<boolean> => false
const always = async (): Promise<boolean> => true

describe('沙箱探测', () => {
  test('none 模式永远可用，且不需要任何工具', async () => {
    const probe = await probeSandbox('none', { platform: 'darwin', hasTool: never })
    assert.equal(probe.available, true)
    assert.equal(probe.tool, null)
  })

  test('macOS 上找 sandbox-exec', async () => {
    const probe = await probeSandbox('workdir-write', { platform: 'darwin', hasTool: always })
    assert.equal(probe.available, true)
    assert.equal(probe.tool, 'sandbox-exec')
  })

  test('Linux 上找 bwrap，缺失时给出**可执行的**安装提示', async () => {
    const missing = await probeSandbox('workdir-write', { platform: 'linux', hasTool: never })
    assert.equal(missing.available, false)
    assert.match(missing.reason ?? '', /bubblewrap|bwrap/)
    assert.match(missing.reason ?? '', /apt install|dnf install/, '要有能照着敲的命令')

    const present = await probeSandbox('workdir-write', { platform: 'linux', hasTool: always })
    assert.equal(present.tool, 'bwrap')
  })

  test('★ 未实现的平台如实说"没有"，而不是假装支持', async () => {
    const probe = await probeSandbox('workdir-write', { platform: 'win32', hasTool: always })
    assert.equal(probe.available, false)
    assert.match(probe.reason ?? '', /win32/)
    assert.match(probe.reason ?? '', /容器|VM/)
  })
})

describe('★ 沙箱不可用时绝不静默降级', () => {
  test('★ 开了沙箱但工具不存在 ⇒ 抛异常，而不是返回一条无包装的命令行', async () => {
    await assert.rejects(
      () =>
        planSandbox({
          mode: 'workdir-write',
          command: 'claude',
          args: ['-p', '干活'],
          workDir: '/work',
          platform: 'linux',
          hasTool: never,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxUnavailableError)
        // 错误信息必须同时说清三件事：为什么、不会降级、怎么办
        assert.match(err.message, /不可用/)
        assert.match(err.message, /不会静默降级/)
        assert.match(err.message, /bubblewrap|bwrap/)
        return true
      },
    )
  })

  test('★ 明确关掉沙箱时，如实标注"当时没有沙箱保护"', async () => {
    const plan = await planSandbox({
      mode: 'none',
      command: 'claude',
      args: ['-p', '干活'],
      workDir: '/work',
    })
    assert.equal(plan.command, 'claude', '不该被包装')
    assert.deepEqual(plan.args, ['-p', '干活'])
    // 审计里必须留痕：将来回看一条 run 时，"当时有没有沙箱"是个要紧的事实
    assert.match(plan.appliedDescription, /未启用沙箱/)
    assert.match(plan.appliedDescription, /完整权限/)
  })
})

describe('沙箱包装的形状', () => {
  test('macOS：只放行工作目录的写，读不受限', async () => {
    const plan = await planSandbox({
      mode: 'workdir-write',
      command: 'claude',
      args: ['-p', '干活'],
      workDir: '/work/abc',
      platform: 'darwin',
      hasTool: always,
    })
    assert.equal(plan.command, 'sandbox-exec')
    const profile = plan.args[1] ?? ''
    assert.match(profile, /\(deny file-write\*\)/, '必须先关掉写')
    assert.match(profile, /subpath "\/work\/abc"/, '再显式放行工作目录')
    // 读不能锁：agent 要读 CLI 自己的安装位置、node_modules、语言工具链，锁了基本跑不起来
    assert.ok(!/deny file-read/.test(profile), '读不该被限制')
    // 原始命令与参数必须原样跟在后面
    assert.deepEqual(plan.args.slice(2), ['claude', '-p', '干活'])
  })

  test('Linux：根只读、工作目录可写、父进程死则跟着死', async () => {
    const plan = await planSandbox({
      mode: 'workdir-write',
      command: 'claude',
      args: ['-p', '干活'],
      workDir: '/work/abc',
      platform: 'linux',
      hasTool: always,
    })
    assert.equal(plan.command, 'bwrap')
    const s = plan.args.join(' ')
    assert.match(s, /--ro-bind \/ \//, '根文件系统只读')
    assert.match(s, /--bind \/work\/abc \/work\/abc/, '工作目录单独 bind 成可写')
    assert.match(s, /--die-with-parent/, '不留孤儿进程')
    assert.match(s, /claude -p 干活$/, '原命令在最后')
  })

  test('额外的可写目录会被一起放行（工具链要写临时目录）', async () => {
    const plan = await planSandbox({
      mode: 'workdir-write',
      command: 'claude',
      args: [],
      workDir: '/work',
      extraWritableDirs: ['/tmp/build-cache'],
      platform: 'linux',
      hasTool: always,
    })
    assert.match(plan.args.join(' '), /--bind \/tmp\/build-cache \/tmp\/build-cache/)
  })

  test('★ 审计描述里必须带上"这不是安全边界"，而不只是说用了什么工具', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const plan = await planSandbox({
        mode: 'workdir-write',
        command: 'claude',
        args: [],
        workDir: '/work',
        platform,
        hasTool: always,
      })
      assert.match(
        plan.appliedDescription,
        /不是安全边界/,
        `${platform}：审计里必须如实披露这一点（NG7）`,
      )
      assert.match(plan.appliedDescription, /误操作/)
    }
  })
})
