/**
 * 把 `docs/material/`（**唯一手写源**）同步成运行时副本 `apps/daemon/catalog/material/`。
 *
 * 为什么要这一步：资料要跟着 daemon 一起发布（`apps/daemon/catalog/` 是随包走的那一档，
 * 平台技能也在那儿），但**不许有两份手写的东西**——人读的和 agent 读的必须是同一份。
 * 所以：
 *
 *   手写：`docs/material/**`   （在 docs 里，`docs/README.md` 有链接，人能读）
 *   产物：`apps/daemon/catalog/material/**`（daemon 起生成类对话时原样复制进工作目录）
 *
 * `tests/material-sync.test.ts` 逐字节比对两边（不一样就红）。改了 docs 里任何一份，跑：
 *
 *     node tools/material/sync.mjs
 *
 * ⚠️ 与 `tools/ui-demo/sync-demo.mjs` 同一条规矩：产物目录里**不要手改**——下次同步会被覆盖。
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SOURCE = join(ROOT, 'docs', 'material')
const TARGET = join(ROOT, 'apps', 'daemon', 'catalog', 'material')

if (!existsSync(SOURCE)) {
  console.error(`找不到资料源：${SOURCE}`)
  process.exit(1)
}

/** 递归列出相对路径（只列文件），用于打印"同步了哪几份"。 */
function walk(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(full.slice(base.length + 1))
  }
  return out.sort()
}

// 整目录替换（内容全量一致；不做"合并"——旧文件必须消失，否则 agent 会读到过期资料）
rmSync(TARGET, { recursive: true, force: true })
cpSync(SOURCE, TARGET, { recursive: true })

const files = walk(TARGET)
console.log(`material 同步完成：${files.length} 个文件`)
for (const f of files) console.log(`  ${f}`)
