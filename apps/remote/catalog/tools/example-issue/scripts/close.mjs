#!/usr/bin/env node
/**
 * example-issue 的动作：close（模拟关闭单据）。
 *
 * 与 tag 共用一个输出文件（`issue-ops.log`），但**参数形状只有一项**（reason）——
 * 同一个包里两个动作、两套参数，演示"动作自己的清单决定它要哪些参数"。
 * `reversible: false` 演示"这个动作不可回滚"：平台对它可以执行、但不承诺能撤销。
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
  reason: params.reason ?? null,
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
      detail: `会往 ${target} 追加一条关闭记录（dry-run，没有真的写）：${JSON.stringify(row)}`,
    }),
  )
} else {
  await appendFile(target, JSON.stringify(row) + '\n', 'utf8')
  process.stdout.write(
    JSON.stringify({
      ok: true,
      detail: `已往 ${target} 追加一条关闭记录：reason=${String(open.reason)}`,
    }),
  )
}
