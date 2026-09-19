#!/usr/bin/env node
/**
 * 远端示例工具的入口。
 *
 * 脚本与平台之间的约定只有三条（与 `examples/tools/example-note` 完全一样，
 * 因为**格式是一回事**——远端装进来的包与本地目录装进来的包没有任何区别）：
 *
 *   1. stdin 收一份 JSON：`{ action, params, dryRun, context }`；
 *   2. stdout 出一份 JSON：`{ ok, detail }`；退出码非 0 也算失败；
 *   3. `dryRun: true` 时只描述、不许改。
 *
 * `dir` 是**绑定参数**（平台按事实填：被审那次执行的工作目录），
 * `message` 是**开放参数**（模型填，清单里限了长度）。
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')

const dir = input.params?.dir
if (typeof dir !== 'string' || dir === '') {
  process.stdout.write(JSON.stringify({ ok: false, detail: '没有拿到工作目录（bound 参数 dir 缺失）' }))
  process.exit(0)
}

const message = typeof input.params?.message === 'string' ? input.params.message.trim() : ''
if (message === '') {
  process.stdout.write(JSON.stringify({ ok: false, detail: 'message 是空的，没什么可写' }))
  process.exit(0)
}

const target = join(dir, 'HELLO.md')
if (input.dryRun === true) {
  process.stdout.write(
    JSON.stringify({ ok: true, detail: `会往 ${target} 追加一行问候（dry-run，没有真的写）` }),
  )
} else {
  await appendFile(target, `你好：${message}\n`, 'utf8')
  process.stdout.write(JSON.stringify({ ok: true, detail: `已往 ${target} 追加一行问候` }))
}
