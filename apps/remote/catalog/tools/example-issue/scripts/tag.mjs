#!/usr/bin/env node
/**
 * example-issue 的动作：tag（给单据打标签）。
 *
 * 约定与 example-notify 相同（stdin 收 JSON、stdout 出 JSON、dryRun 只描述）。
 * 它**不真的改任何单据**：把收到的参数（开放 + 绑定）追加写成工作目录的
 * `issue-ops.log`，每行一个动作、带操作名，方便看"这次判决让脚本对哪个工作区、哪个
 * 单据、做什么"。
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
  label: params.label ?? null,
  addSummary: params['add-summary'] ?? null,
}
const row = {
  at: new Date().toISOString(),
  action: input.action,
  dryRun: input.dryRun === true,
  bound: { dir, workspaceId: params['workspace-id'] ?? null },
  open,
  types: Object.fromEntries(Object.entries(open).map(([k, v]) => [k, v === null ? 'null' : typeof v])),
}

const target = join(dir, 'issue-ops.log')
if (input.dryRun === true) {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      detail: `会往 ${target} 追加一条打标记录（dry-run，没有真的写）：${JSON.stringify(row)}`,
    }),
  )
} else {
  await appendFile(target, JSON.stringify(row) + '\n', 'utf8')
  process.stdout.write(
    JSON.stringify({
      ok: true,
      detail: `已往 ${target} 追加一条打标记录：label=${String(open.label)} addSummary=${String(open.addSummary)}`,
    }),
  )
}
