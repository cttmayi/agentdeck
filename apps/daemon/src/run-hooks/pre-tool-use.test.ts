/**
 * 任务隔离 hook（2026-10 / 分批第 76 批）：`pre-tool-use.py` 的决策矩阵 + 它在**受管
 * 配置目录**里的落点与 `settings.json` 片段。
 *
 * 分批第 76 批把落点从"任务工作目录"改成"受管 `CLAUDE_CONFIG_DIR`"（使用者：
 * 「别在 workdir 里留平台的东西」）——所以"写进工作目录"那两条判据随之作废，
 * 换成"写进受管目录、且工作目录里什么都不留"。
 *
 * ⚠️ 临时目录一律走 `makeTempDir`（`.cache/test-tmp`），**不用 `os.tmpdir()`**。
 * 测试里 spawn 的是**平台自己的** `pre-tool-use.py`（python3），不是真实 agent CLI
 * （NFR-T-01 禁的是会烧额度/改文件的真实 CLI，不适用于这里）。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanup, makeTempDir } from '../testing/tmp.ts'
import { installManagedRunHook, MANAGED_HOOK_SCRIPT_REL } from './inject.ts'

/**
 * 跑 hook 脚本用的解释器。
 *
 * ★ 分批第 228 批（三平台兼容）：原来写死 `python3`。Windows 上**没有** `python3`
 *   （官方安装器给的是 `python.exe`）⇒ 这一整组判据在 Windows CI 上会红，而红的原因
 *   与"hook 的决策矩阵"无关。这里按"机器上实际有哪个"挑：`python3` → `python`。
 *   ⚠️ 两个都没有时**不静默跳过**：让用例失败并说清"要装 Python"——那是环境问题，
 *   不是这条判据作废了。
 */
function resolvePython(): string {
  const candidates = process.platform === 'win32' ? ['python3', 'python'] : ['python3', 'python']
  const pathValue = process.env['PATH'] ?? ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const name of candidates) {
    for (const dir of pathValue.split(delimiter)) {
      if (dir === '') continue
      for (const ext of exts) {
        const candidate = `${dir}${dir.endsWith('\\') || dir.endsWith('/') ? '' : '/'}${name}${ext}`
        try {
          accessSync(candidate, constants.F_OK)
          return candidate
        } catch {
          /* 继续找 */
        }
      }
    }
  }
  // 找不到就退回 `python3`：让 spawn 报 ENOENT，用例失败且原因清楚
  return 'python3'
}

const pythonPath = resolvePython()
const hookScript = new URL('./pre-tool-use.py', import.meta.url).pathname

/** 用平台上的 Python 跑 hook 脚本：写 stdin、收 stdout。execFile 没有 input 选项。 */
function decide(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): Promise<{ decision: string; reason: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [hookScript])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`hook 退出码 ${code}: ${stderr}`))
      try {
        const out = JSON.parse(stdout)
        resolve({
          decision: out.hookSpecificOutput.permissionDecision,
          reason: out.hookSpecificOutput.permissionDecisionReason ?? '',
        })
      } catch (err) {
        reject(new Error(`hook 输出不是 JSON: ${stdout} (${String(err)})`))
      }
    })
    child.stdin.write(JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }))
    child.stdin.end()
  })
}

test('hook 决策矩阵：结构化路径工具（Read/Edit/Write/Glob/Grep）', async () => {
  const root = await makeTempDir('run-hooks')
  try {
    // 工作目录内：放行
    for (const [tool, key] of [
      ['Read', 'file_path'],
      ['Edit', 'file_path'],
      ['Write', 'file_path'],
    ] as const) {
      const { decision } = await decide(tool, { [key]: join(root, 'doc', 'a.md') }, root)
      assert.equal(decision, 'allow', `${tool} 工作目录内应放行`)
    }
    // 相对路径：放行
    {
      const { decision } = await decide('Read', { file_path: 'doc/a.md' }, root)
      assert.equal(decision, 'allow')
    }
    // 工作目录外（绝对路径）：拒绝
    {
      const { decision, reason } = await decide('Read', { file_path: '/Users/other/x.md' }, root)
      assert.equal(decision, 'deny')
      assert.match(reason, /越界/)
    }
    // 越上父目录：拒绝
    {
      const { decision } = await decide('Read', { file_path: join(root, '..', 'x.md') }, root)
      assert.equal(decision, 'deny')
    }
    // Glob：模式越界拒绝、正常放行
    {
      assert.equal((await decide('Glob', { pattern: '../**/*.md' }, root)).decision, 'deny')
      assert.equal((await decide('Glob', { pattern: 'doc/**/*.md' }, root)).decision, 'allow')
    }
    // Grep：path 越界拒绝、缺省放行
    {
      assert.equal((await decide('Grep', { path: '/etc' }, root)).decision, 'deny')
      assert.equal((await decide('Grep', { path: '.' }, root)).decision, 'allow')
    }
  } finally {
    // 决策矩阵不涉及落点：临时目录由 cleanup 在外面删
  }
})

test('hook 决策矩阵：Bash 只拦明显越界', async () => {
  const root = await makeTempDir('run-hooks')
  try {
    const cases: Array<[string, string]> = [
      ['pwd', 'allow'],
      ['ls -la', 'allow'],
      ['find . -type f | head', 'allow'],
      ['curl -s https://example.com', 'allow'], // URL 不是绝对路径
      ['curl -o doc/out.html https://example.com', 'allow'], // 相对落点
      ['ls ..', 'deny'],
      ['cd .. && ls', 'deny'],
      ['cat ~/.claude/settings.json', 'deny'],
      ['ls /Users/ling/agentdeck-workspace/issue-other', 'deny'], // 工作目录外的绝对路径
      ['curl -o /tmp/x https://example.com', 'deny'], // 绝对落点在外部
    ]
    for (const [cmd, want] of cases) {
      const { decision } = await decide('Bash', { command: cmd }, root)
      assert.equal(decision, want, `Bash ${JSON.stringify(cmd)} 应 ${want}`)
    }
  } finally {
    // 决策矩阵不涉及落点：临时目录由 cleanup 在外面删
  }
})

test('★★★ 分批第 76 批：hook 写进**受管配置目录**，不再写工作目录', async () => {
  const configDir = await makeTempDir('run-hooks-managed')
  const workDir = await makeTempDir('run-hooks-workdir')
  try {
    const hook = await installManagedRunHook(configDir)

    // ① 脚本落在受管目录里，**不在**工作目录里
    const script = await readFile(join(configDir, MANAGED_HOOK_SCRIPT_REL), 'utf8')
    assert.match(script, /PreToolUse|permissionDecision/u, '写进去的确实是那个 hook 脚本')
    assert.equal(hook.scriptPath, join(configDir, MANAGED_HOOK_SCRIPT_REL))
    assert.deepEqual(
      await readdir(workDir).catch(() => [] as string[]),
      [],
      '★ 工作目录里**什么都不许留**（这正是这一批的目的）',
    )

    // ② settings 片段形状：matcher 覆盖那几类工具、命令指向受管脚本、有超时
    const entry = hook.hooks.PreToolUse[0]!
    for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) {
      assert.ok(entry.matcher.includes(tool), `matcher 要含 ${tool}`)
    }
    assert.equal(entry.hooks[0]!.type, 'command')
    assert.ok(entry.hooks[0]!.command.includes(MANAGED_HOOK_SCRIPT_REL), '命令指向受管目录里的脚本')
    assert.ok(entry.hooks[0]!.timeout > 0)
  } finally {
    await cleanup(configDir)
    await cleanup(workDir)
  }
})

test('★★ 幂等：跑两次结果一致（每轮都会重写，不能抖）', async () => {
  const configDir = await makeTempDir('run-hooks-idem')
  try {
    const first = await installManagedRunHook(configDir)
    const firstScript = await readFile(join(configDir, MANAGED_HOOK_SCRIPT_REL), 'utf8')
    const second = await installManagedRunHook(configDir)
    const secondScript = await readFile(join(configDir, MANAGED_HOOK_SCRIPT_REL), 'utf8')
    assert.equal(JSON.stringify(first.hooks), JSON.stringify(second.hooks))
    assert.equal(firstScript, secondScript)
  } finally {
    await cleanup(configDir)
  }
})
