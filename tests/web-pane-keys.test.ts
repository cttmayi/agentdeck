import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 「哪些地方能拖宽」只有一处定义，这条判据盯着它（D176）。
 *
 * 背景：拖宽的存档名在三个地方出现——视图模板的 `data-list-key`（真正决定
 * `--list-w` 存哪个键）、`lib/pane-resize.ts` 的 `LIST_PANES`（设置页「布局」
 * 拿它列"全部可拖的位置"）、以及存档键本身。前两者**必须一一对应**：
 * 少一条 ⇒ 设置页列不出来、拖坏了没处恢复；多一条 ⇒ 设置页列了一个拖不动的行
 * （"界面在、代码路径不在"，本仓库最常见的缺陷）。
 *
 * 所以这里直接**读源码**比对两边，而不是靠人记得一起改。视图增删一个可拖列表时
 * 若忘了另一头，这条会红并指名哪一边多了/少了。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VIEWS_DIR = join(ROOT, 'apps/web/src/views')
const PANE_SRC = readFileSync(join(ROOT, 'apps/web/src/lib/pane-resize.ts'), 'utf8')

/** 视图模板里所有 `data-list-key="…"`（可拖列表栏的声明） */
function viewListKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of readdirSync(VIEWS_DIR)) {
    if (!file.endsWith('.svelte')) continue
    const text = readFileSync(join(VIEWS_DIR, file), 'utf8')
    for (const m of text.matchAll(/data-list-key="([^"]+)"/g)) {
      if (m[1] !== undefined) keys.add(m[1])
    }
  }
  return keys
}

/** `LIST_PANES` 里声明的存档名（`list.<key>` 取 `<key>`） */
function declaredListKeys(): Set<string> {
  const block = /export const LIST_PANES = \[([\s\S]*?)\] as const/.exec(PANE_SRC)
  assert.ok(block, 'lib/pane-resize.ts 里找不到 LIST_PANES——设置页「布局」靠它列位置')
  const body = block[1] ?? ''
  const names = new Set<string>()
  for (const m of body.matchAll(/name: 'list\.([^']+)'/g)) {
    if (m[1] !== undefined) names.add(m[1])
  }
  return names
}

test('★ 「哪些视图的列表能拖」只有一处定义：模板里的 data-list-key 与 LIST_PANES 一一对应', () => {
  const inViews = viewListKeys()
  const declared = declaredListKeys()
  const missing = [...inViews].filter((k) => !declared.has(k)).sort()
  const extra = [...declared].filter((k) => !inViews.has(k)).sort()
  assert.deepEqual(
    missing,
    [],
    `视图模板里有 data-list-key 但 LIST_PANES 没列（设置页「布局」会漏掉这一行）：${missing.join('、')}`,
  )
  assert.deepEqual(
    extra,
    [],
    `LIST_PANES 列了但没有任何视图声明（设置页会出现一个拖不动的行）：${extra.join('、')}`,
  )
  // 六条是当前的事实；数量变了也要在上面两条之外显式改这里，免得"少了一半还绿"
  assert.equal(declared.size, 6, '可拖列表的数量变了：确认是真的加了/删了一个列表，再改这个数')
})

test('★ 存档键只有一个前缀：`agentdeck.pane.<name>`（老键只在迁移代码里出现一次）', () => {
  // 除了 pane-resize.ts 自己，别处不许再拼存档前缀 / 直接读写老键——
  // 拼第二遍就是第二处定义"键长什么样"，两边一漂就"存进去的读不出来"。
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(svelte|ts)$/.test(entry.name)) continue
      const rel = full.slice(ROOT.length + 1)
      if (rel === 'apps/web/src/lib/pane-resize.ts') continue
      const text = readFileSync(full, 'utf8')
      for (const needle of ["agentdeck.pane.", "agentdeck.listW.", "agentdeck.crystallize.artifactW"]) {
        if (text.includes(needle)) offenders.push(`${rel} 里直接用了 ${needle}`)
      }
    }
  }
  walk(join(ROOT, 'apps/web/src'))
  assert.deepEqual(offenders, [], offenders.join('\n'))
})
