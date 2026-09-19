#!/usr/bin/env node
/**
 * 示例工具的入口脚本。
 *
 * ══════════════════════════════════════════════════════════════════
 * 脚本与平台之间的约定（就这三条）
 * ══════════════════════════════════════════════════════════════════
 *
 *   1. **stdin 收一份 JSON**：`{ action, params, dryRun, context }`。
 *      `params` 里已经有平台绑定的值（`bound`）与模型给的值（`open`）——
 *      脚本**不需要**（也拿不到）区分它们，边界是平台的事；
 *   2. **stdout 出一份 JSON**：`{ ok: true, detail: "一句话" }` 或
 *      `{ ok: false, detail: "为什么没做成" }`。**退出码**非 0 也算失败
 *      （脚本崩了、或者你没写 stdout），两种情况平台都会记成 `failed`
 *      并通知——静默失败是不允许的；
 *   3. `dryRun: true` 时**只许描述、不许改**。输出里说清"我打算改什么"。
 *      做不到就老实写 `"dryRun": "unsupported"`，平台不会让它自动执行。
 *
 * ⚠️ 脚本拿到 `params` 就照着用；它**不该**去猜"哪个值是模型给的"——
 *    绑定值的存在意义正是让模型碰不到它。
 */
import { appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const read = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const main = async () => {
  const input = await read()
  const params = input.params ?? {}
  const dir = params.dir
  if (typeof dir !== 'string' || dir === '') {
    return { ok: false, detail: '没有拿到工作目录（bound 参数 dir 缺失）' }
  }

  if (input.action === 'example-note.append-note') {
    const text = typeof params.text === 'string' ? params.text : ''
    if (text.trim() === '') return { ok: false, detail: 'text 是空的，没什么可写' }
    const target = join(dir, 'NOTES.md')
    if (input.dryRun === true) return { ok: true, detail: `会往 ${target} 追加一行（dry-run，没有真的写）` }
    await appendFile(target, `- ${text}\n`, 'utf8')
    return { ok: true, detail: `已往 ${target} 追加一行` }
  }

  if (input.action === 'example-note.clean-notes') {
    const target = join(dir, 'NOTES.md')
    if (input.dryRun === true) return { ok: true, detail: `会删掉 ${target}（dry-run，没有真的删）` }
    await rm(target, { force: true })
    return { ok: true, detail: `已删掉 ${target}` }
  }

  return { ok: false, detail: `这个脚本不认识动作 ${String(input.action)}` }
}

const result = await main()
process.stdout.write(JSON.stringify(result))
