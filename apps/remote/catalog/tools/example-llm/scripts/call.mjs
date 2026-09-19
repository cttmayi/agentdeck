#!/usr/bin/env node
/**
 * example-llm 的入口（约定与 example-notify 相同：stdin 收 JSON、stdout 出 JSON、
 * dryRun 只描述）。
 *
 * 它**不真的调模型**：把收到的**完整调用参数**（模型枚举、prompt、数值边界、布尔）
 * 追加写成工作目录的 `llm-calls.jsonl`（一行一次调用）。打开那个文件，就能看到
 * "这次判决让脚本用哪个模型、多大温度、多少 token"——数值参数是不是真的以
 * **number** 到了脚本（而不是字符串"0.7"），也写在类型里。
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
  model: params.model ?? null,
  prompt: params.prompt ?? null,
  temperature: params.temperature ?? null,
  maxTokens: params['max-tokens'] ?? null,
  stream: params.stream ?? null,
}
const row = {
  at: new Date().toISOString(),
  action: input.action,
  dryRun: input.dryRun === true,
  bound: { dir, runId: params['run-id'] ?? null },
  open,
  types: Object.fromEntries(Object.entries(open).map(([k, v]) => [k, v === null ? 'null' : typeof v])),
}

const target = join(dir, 'llm-calls.jsonl')
if (input.dryRun === true) {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      detail: `会往 ${target} 追加一条调用记录（dry-run，没有真的写）：${JSON.stringify(row)}`,
    }),
  )
} else {
  await appendFile(target, JSON.stringify(row) + '\n', 'utf8')
  process.stdout.write(
    JSON.stringify({
      ok: true,
      detail: `已往 ${target} 追加一条调用记录：model=${String(open.model)} temperature=${String(open.temperature)}`,
    }),
  )
}
