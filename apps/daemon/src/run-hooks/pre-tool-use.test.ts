/**
 * 任务隔离 hook（2026-10）：`pre-tool-use.py` 的决策矩阵 + `inject.ts` 的注入/清理。
 *
 * ⚠️ 临时目录一律走 `makeTempDir`（`.cache/test-tmp`），**不用 `os.tmpdir()`**。
 * 测试里 spawn 的是**平台自己的** `pre-tool-use.py`（python3），不是真实 agent CLI
 * （NFR-T-01 禁的是会烧额度/改文件的真实 CLI，不适用于这里）。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeTempDir } from '../testing/tmp.ts'
import { injectRunHooks, removeRunHooks } from './inject.ts'

const hookScript = new URL('./pre-tool-use.py', import.meta.url).pathname

/** spawn python3 跑 hook 脚本：写 stdin、收 stdout。execFile 没有 input 选项。 */
function decide(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): Promise<{ decision: string; reason: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [hookScript])
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
    await removeRunHooks(root)
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
    await removeRunHooks(root)
  }
})

test('inject：写 .claude/settings.json + hook 脚本；remove：清干净', async () => {
  const root = await makeTempDir('run-hooks')
  try {
    await injectRunHooks(root)
    const settings = JSON.parse(
      await readFile(join(root, '.claude', 'settings.json'), 'utf8'),
    )
    const hook = settings.hooks.PreToolUse[0]
    assert.ok(hook.matcher.includes('Bash'))
    assert.ok(hook.matcher.includes('Read'))
    assert.equal(hook.hooks[0].type, 'command')
    assert.ok(hook.hooks[0].command.includes('pre-tool-use.py'))
    assert.ok(hook.hooks[0].timeout > 0)
    await stat(join(root, '.agentdeck', 'hooks', 'pre-tool-use.py'))
    // 清理：两个落点都消失
    await removeRunHooks(root)
    await assert.rejects(stat(join(root, '.agentdeck', 'hooks', 'pre-tool-use.py')))
    await assert.rejects(stat(join(root, '.claude', 'settings.json')))
  } finally {
    await removeRunHooks(root)
  }
})

test('inject 幂等：跑两次结果一致', async () => {
  const root = await makeTempDir('run-hooks')
  try {
    await injectRunHooks(root)
    const first = await readFile(join(root, '.claude', 'settings.json'), 'utf8')
    await injectRunHooks(root)
    const second = await readFile(join(root, '.claude', 'settings.json'), 'utf8')
    assert.equal(first, second)
  } finally {
    await removeRunHooks(root)
  }
})
