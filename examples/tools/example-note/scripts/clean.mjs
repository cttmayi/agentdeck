#!/usr/bin/env node
/**
 * 第二个入口：只负责删 NOTES.md。
 *
 * 单独一个文件是为了演示"每个动作可以有自己的 entry"——也为了演示
 * `reversible: false` 的动作长什么样（删掉的东西回不来，界面上要显式标注）。
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
const dir = input.params?.dir
if (typeof dir !== 'string' || dir === '') {
  process.stdout.write(JSON.stringify({ ok: false, detail: '没有拿到工作目录（bound 参数 dir 缺失）' }))
} else {
  const target = join(dir, 'NOTES.md')
  if (input.dryRun === true) {
    process.stdout.write(JSON.stringify({ ok: true, detail: `会删掉 ${target}（dry-run，没有真的删）` }))
  } else {
    await rm(target, { force: true })
    process.stdout.write(JSON.stringify({ ok: true, detail: `已删掉 ${target}` }))
  }
}
