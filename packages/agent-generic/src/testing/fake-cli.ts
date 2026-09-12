/**
 * 假 CLI —— 测试用的假可执行文件（NFR-T-01）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能拿真 CLI 测
 * ══════════════════════════════════════════════════════════════════
 *
 * 跑真 CLI 会**消耗使用者的真实额度**，而且它会真的改文件——测试跑一遍
 * 可能在仓库里留下改动。所以适配器测试里的"CLI"永远是本文件这种假货：
 * 一个 Node 进程，按脚本往 stdout 吐 NDJSON，退出码由剧本决定。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是 .mjs + 一层 sh 包装
 * ══════════════════════════════════════════════════════════════════
 *
 * `spawnProcessTree` 直接 exec 可执行文件，**不经过 shell**。而可执行位是
 * 文件系统属性，写进仓库的 `.mjs` 未必带 +x（Windows 上更没有）。于是：
 *
 *   sh 包装（带 shebang，测试里 chmod 0o755）→ exec node → 本脚本
 *
 * 包装脚本把 `$@`（也就是 argv.ts 拼出来的真实参数）原样转发给本脚本，
 * 所以**被测的 argv 仍然是真实 argv**，没有被测试替身改写。
 *
 * ══════════════════════════════════════════════════════════════════
 * 剧本用环境变量选，不用命令行参数
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为命令行参数正是被测对象之一——用参数选剧本，就分不清"参数没传到"
 * 和"剧本选错了"。环境变量与 argv 是两条路，互不干扰。
 *
 * 另外 `FAKE_ARGV_ECHO_FILE` 会把真实收到的 argv 落盘：后端测试因此可以
 * 直接断言**进程实际收到的参数**，而不是断言我们对 buildArgv 的理解。
 * 这两件事差别很大——中间少了一层拼接就看不出来了。
 */

import { writeFileSync } from 'node:fs'

const SCENARIO = process.env['FAKE_SCENARIO'] ?? 'ok'
const argv = process.argv.slice(2)

// 版本探测（`probe()` 会调 detectVersion）必须**早返回**：否则剧本的输出会
// 和版本号混在一起，`detectVersion` 取第一行就会拿到剧本的第一条事件。
if (argv.includes('--version')) {
  process.stdout.write('agent-cli 0.0.0-fake\n')
  process.exit(0)
}

// ── 把真实 argv 落盘（若要求） ────────────────────────────────
const echoFile = process.env['FAKE_ARGV_ECHO_FILE']
if (echoFile) writeFileSync(echoFile, JSON.stringify(argv), 'utf8')

// ── 参数合法性检查（只在要求时做，避免干扰别的剧本） ──────────
if (process.env['FAKE_ASSERT_MANAGED'] === '1') {
  const problems: string[] = []
  if (argv.includes('--prompt')) problems.push('--prompt 不该出现（禁改参数）')
  if (argv.includes('--output')) problems.push('--output 不该出现（禁改参数）')
  if (argv.includes('--non-interactive')) problems.push('--non-interactive 不该出现')
  if (problems.length > 0) {
    process.stdout.write(`${JSON.stringify({ type: 'text', text: `ARGV 违规: ${problems.join('; ')}` })}\n`)
    process.exit(7)
  }
}

// ── prompt 的读取方式由投递模式决定 ───────────────────────────
const usesStdin = process.env['FAKE_PROMPT_STDIN'] === '1'
let prompt = ''

if (usesStdin) {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  prompt = Buffer.concat(chunks).toString('utf8')
} else {
  // argv 模式：prompt 是最后一个参数（后端把它追加在末尾）
  prompt = argv.at(-1) ?? ''
}

const emit = (event: unknown): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

const text = (t: string): void => emit({ type: 'text', text: t })

// 把 prompt 里最后一行回显出来——测试据此确认 prompt 真的送到了进程里
const promptTail = prompt.trim().split('\n').at(-1) ?? ''

switch (SCENARIO) {
  case 'ok': {
    emit({ type: 'session', session_id: 'fake-sess-1' })
    text(`收到 ${prompt.length} 字节`)
    emit({ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } })
    emit({ type: 'tool_result', name: 'read_file', output: '文件内容' })
    emit({ type: 'thinking', text: '该收尾了' })
    emit({
      type: 'usage',
      input_tokens: 120,
      output_tokens: 30,
      cost_usd: 0.00042,
    })
    emit({
      type: 'result',
      status: 'success',
      result: `完成：${promptTail}`,
      session_id: 'fake-sess-1',
    })
    break
  }

  case 'error-status': {
    text('我先试试')
    emit({ type: 'result', status: 'error', result: '额度用尽了', session_id: 'fake-sess-2' })
    process.exitCode = 1
    break
  }

  case 'garbled': {
    text('前面还是好好的')
    process.stdout.write('这一行不是 JSON，是 CLI 打到 stdout 的诊断信息\n')
    emit({ type: 'tool_use', name: 'read_file' })
    process.stdout.write('{ 这不是合法的 JSON\n')
    // ★ 刻意不给终止事件：格式变了，但进程干净退出
    break
  }

  case 'partial': {
    emit({ type: 'session', session_id: 'fake-sess-3' })
    text('我开始了')
    // 中途被 kill：没有终止事件，也没有退出码（signal 终止）
    process.kill(process.pid, 'SIGKILL')
    break
  }

  case 'plain-text': {
    // stdout 上全是自由文本——完全没有 NDJSON。这是"最像 agent 什么都没说"的形态
    process.stdout.write('I could not find the file you mentioned.\n')
    process.stdout.write('Please check the path and try again.\n')
    break
  }

  case 'usage-only': {
    emit({ type: 'usage', input_tokens: 10, output_tokens: 2 })
    // 有事件、有遥测，但**没有终止事件**，也没有不可解析行 → 仍然必须失败
    break
  }

  case 'garbage': {
    process.stdout.write('这不是 NDJSON\n')
    process.exitCode = 3
    break
  }

  case 'resume-rejected': {
    // 真实 CLI 拒绝恢复时通常把原因写到 stderr，然后以错误终止。
    // 这个剧本用来验证「rejectDetectable=true 时探测真的能命中」这条路径。
    process.stderr.write('Error: unknown session id fake-not-exist\n')
    emit({ type: 'result', status: 'error', result: '无法恢复会话' })
    process.exitCode = 1
    break
  }

  case 'stderr-crash': {
    process.stderr.write("Error: Cannot find module 'agent-cli/lib/main.js'\n")
    process.exitCode = 1
    break
  }

  case 'long-tool-output': {
    emit({ type: 'tool_result', name: 'read_file', output: 'x'.repeat(9000) })
    emit({ type: 'result', status: 'success', result: 'ok' })
    break
  }

  case 'no-result': {
    text('我说了话，但没有终止事件，也没有任何不可解析行')
    break
  }

  default:
    process.stderr.write(`未知剧本：${SCENARIO}\n`)
    process.exitCode = 64
}

// 把 stdin 读到的内容也留个证据（stdin 模式下测试用它确认帧格式）
const stdinEcho = process.env['FAKE_PROMPT_ECHO_FILE']
if (stdinEcho && usesStdin) writeFileSync(stdinEcho, prompt, 'utf8')
