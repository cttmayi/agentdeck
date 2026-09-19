#!/usr/bin/env node
/**
 * example-notify 的入口。
 *
 * 脚本与平台之间的约定只有三条（与 hello-tool / example-note 完全一样，因为
 * **格式是一回事**——远端装进来的包与本地目录装进来的包没有任何区别）：
 *
 *   1. stdin 收一份 JSON：`{ action, params, dryRun, context }`；
 *   2. stdout 出一份 JSON：`{ ok, detail }`；退出码非 0 也算失败；
 *   3. `dryRun: true` 时只描述、不许改。
 *
 * 它**不真的发通知**：把收到的**完整参数**（开放参数 + 平台按事实注入的绑定参数）
 * 追加写到工作目录的 `notify.log`。打开那个文件，就能看到"这一次判决到底把哪些
 * 参数传到了脚本"——这正是拿这个范例测试参数管道的用意。
 *
 * ★ 记录里把每个开放参数的**类型**也写出来：测试参数时"类型对不对"和"值对不对"
 *    同样重要——模型把 `retries` 填成字符串、或把 `channel` 填成枚举外的值，
 *    写出来一眼就能看见。
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')

const params = input.params ?? {}
const dir = params.dir
if (typeof dir !== 'string' || dir === '') {
  process.stdout.write(JSON.stringify({ ok: false, detail: '没有拿到工作目录（绑定参数 dir 缺失）' }))
  process.exit(0)
}

const open = {
  channel: params.channel ?? null,
  title: params.title ?? null,
  content: params.content ?? null,
  urgent: params.urgent ?? null,
  retries: params.retries ?? null,
}
const row = {
  at: new Date().toISOString(),
  action: input.action,
  dryRun: input.dryRun === true,
  bound: { dir, runId: params['run-id'] ?? null },
  open,
  // 类型逐项写出来：`urgent` 应当是 boolean、`retries` 应当是 number。
  types: Object.fromEntries(Object.entries(open).map(([k, v]) => [k, v === null ? 'null' : typeof v])),
}

const target = join(dir, 'notify.log')
if (input.dryRun === true) {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      detail: `会往 ${target} 追加一条通知记录（dry-run，没有真的写）：${JSON.stringify(row)}`,
    }),
  )
} else {
  await appendFile(target, JSON.stringify(row) + '\n', 'utf8')
  process.stdout.write(
    JSON.stringify({
      ok: true,
      detail: `已往 ${target} 追加一条通知记录：channel=${String(open.channel)} urgent=${String(open.urgent)}`,
    }),
  )
}
