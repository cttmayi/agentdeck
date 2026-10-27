#!/usr/bin/env node
/**
 * `POST /api/task` 的示例客户端（只用 node 内置的 fetch，零依赖）。
 *
 * 为什么给一个脚本而不是只给 curl：真用起来会撞上三件 curl 一行写不清的事——
 *   ① `wait` 到期返回 202 之后还得自己轮询收口；
 *   ② 退出码要能表达三种不同的结果（跑成了 / 跑失败了 / 请求没跑起来）；
 *   ③ prompt 里带引号、换行、中文时，命令行拼 JSON 很容易拼坏。
 *
 * 用法：
 *   node task.mjs --prompt "写一个文件 hello.txt，内容是 hi，然后回复 DONE"
 *   node task.mjs --prompt "..." --workdir /Users/me/repo --wait 60
 *   node task.mjs --prompt "..." --group 01M...        # 按智能体组走（会审）
 *   node task.mjs --prompt "..." --out result.md       # 只把最终那段话写进文件
 *   node task.mjs --prompt "..." --key my-key-1        # 幂等键：重跑不会二次执行
 *   node task.mjs --prompt "..." --daemon http://127.0.0.1:4517
 *
 * 退出码（与 CLI 同一套语义）：
 *   0 = 跑完了（status=completed）
 *   1 = 跑失败（status=failed/cancelled，或超时仍未终态）
 *   2 = 用法错误（参数不对）
 *   3 = 请求本身失败（连不上 / 非 2xx / 字段被拒等）
 */

const USAGE = `用法：node task.mjs --prompt "要它做的事" [选项]

  --prompt <文本>     必填
  --workdir <绝对路径> 不给就由 daemon 自动分配一间
  --agent <id>        用哪个执行者（缺省 = 工作区默认执行者）
  --group <id>        用哪个智能体组（给了就等于选了这个组：会执行+审核+按组动作权限）
  --max-turns <n>     给 CLI 的回合上限
  --wait <秒>         这次最多等多久（0 = 立刻返回 runId 自己轮询；默认 30）
  --timeout <秒>      202 之后继续轮询多久（默认 900）
  --key <串>          幂等键：同一个键第二次来不会重跑
  --daemon <url>      默认 http://127.0.0.1:4517（也可用环境变量 AGENTDECK_URL）
  --out <文件>        把最终那段话写进这个文件（不然打到 stdout 末尾）
  --json              只打印原始返回体（机器可读）
  -h, --help          这一屏
`

function parseArgs(argv) {
  const out = { wait: 30, timeout: 900, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) {
        console.error(`参数 ${key} 少了一个值`)
        process.exit(2)
      }
      i += 1
      return v
    }
    switch (key) {
      case '--prompt': out.prompt = next(); break
      case '--workdir': out.workDir = next(); break
      case '--agent': out.agent = next(); break
      case '--group': out.group = next(); break
      case '--max-turns': out.maxTurns = Number(next()); break
      case '--wait': out.wait = Number(next()); break
      case '--timeout': out.timeout = Number(next()); break
      case '--key': out.key = next(); break
      case '--daemon': out.daemon = next(); break
      case '--out': out.out = next(); break
      case '--json': out.json = true; break
      case '-h': case '--help': console.log(USAGE); process.exit(0); break
      default:
        console.error(`不认识的参数：${key}\n\n${USAGE}`)
        process.exit(2)
    }
  }
  if (typeof out.prompt !== 'string' || out.prompt.trim() === '') {
    console.error(`--prompt 必填\n\n${USAGE}`)
    process.exit(2)
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
const daemon = (opts.daemon ?? process.env.AGENTDECK_URL ?? 'http://127.0.0.1:4517').replace(/\/+$/, '')

/** 请求体**只放这六个键**：多一个 daemon 都会 400（那是刻意的白名单）。 */
const body = {
  prompt: opts.prompt,
  ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
  ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
  ...(opts.group !== undefined ? { groupId: opts.group } : {}),
  ...(Number.isFinite(opts.maxTurns) ? { maxTurns: opts.maxTurns } : {}),
  wait: opts.wait,
}
const headers = { 'content-type': 'application/json' }
if (opts.key !== undefined) headers['idempotency-key'] = opts.key

function fail(status, text) {
  console.error(`请求失败（HTTP ${status}）：`)
  try {
    const parsed = JSON.parse(text)
    console.error(`  code : ${parsed.code ?? '(没有)'}`)
    console.error(`  说明 : ${parsed.error ?? text}`)
    if (parsed.fields) console.error(`  不被接受的字段 : ${parsed.fields.join('、')}`)
  } catch {
    console.error(`  ${text.slice(0, 800)}`)
  }
  process.exit(3)
}

let res
try {
  res = await fetch(`${daemon}/api/task`, { method: 'POST', headers, body: JSON.stringify(body) })
} catch (err) {
  console.error(`连不上 daemon：${daemon}`)
  console.error(`  ${err instanceof Error ? err.message : String(err)}`)
  console.error('  daemon 起了吗？`pnpm run daemon`（默认 http://127.0.0.1:4517）')
  process.exit(3)
}
const firstText = await res.text()
if (res.status !== 200 && res.status !== 202) fail(res.status, firstText)

let payload = JSON.parse(firstText)

// 202 = 到了 wait 还没跑完（或者你 wait=0）。**继续用 GET 收口**，不必重新提交。
if (res.status === 202) {
  const runId = payload.runId
  console.log(`已受理，还在跑：runId=${runId}（wait 到期了，继续轮询 ${opts.timeout}s 上限）`)
  const deadline = Date.now() + opts.timeout * 1000
  let delay = 500
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 5000) // 退避：别把 daemon 打满
    const polled = await fetch(`${daemon}/api/task/${runId}`)
    const text = await polled.text()
    if (polled.status !== 200 && polled.status !== 202) fail(polled.status, text)
    payload = JSON.parse(text)
    if (polled.status === 200) break
    process.stdout.write('.')
  }
  process.stdout.write('\n')
}

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log('─'.repeat(60))
  console.log(`runId    : ${payload.runId}`)
  console.log(`状态      : ${payload.status}${payload.deduplicated ? '（这是重放：同一个幂等键，没有再跑一次）' : ''}`)
  console.log(`归属任务  : ${payload.issueId}（界面「任务」页里标题以 [API] 开头的那条）`)
  console.log(`工作目录  : ${payload.workDir}`)
  if (payload.usage) {
    const usd = (payload.usage.costUsdMicros ?? 0) / 1_000_000
    console.log(`用量      : in ${payload.usage.inputTokens} / out ${payload.usage.outputTokens} / ≈ $${usd.toFixed(4)}（${payload.usage.costSource}）`)
  }
  if (payload.review) {
    console.log(`审核      : ${payload.review.conclusion}（${payload.review.reasonCode}）`)
  } else {
    console.log('审核      : 没有（没传 --group 就不审，这是刻意的）')
  }
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    console.log(`产物      : ${payload.files.map((f) => `${f.relPath}(${f.bytes}B)`).join('、')}`)
  }
  if (payload.failureReason) console.log(`失败原因  : ${payload.failureReason}`)
  console.log('─'.repeat(60))
  console.log(payload.output ?? '(没有文字产出)')
  if (opts.out !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(opts.out, payload.output ?? '', 'utf8')
    console.log(`\n（已写入 ${opts.out}）`)
  }
}

process.exit(payload.status === 'completed' ? 0 : 1)
