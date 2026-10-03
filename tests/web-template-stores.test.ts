import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * 仓库级检查：Svelte 模板里**不许裸用 store**（漏了 `$`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这是一次真实投诉的产物（2026-10）
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者报："安装 skill，提示『远端不可用』，我明确已经启动 remote 了"。
 *
 * 根因不在远端，在技能页模板里的一行：
 *
 *     {#if remoteError}     ← 裸的 store **对象**，恒为真
 *       …远端不可用：{$remoteError}   ← 值是空串，所以冒号后面空着
 *
 * 于是那条"远端不可用"**无条件**显示，而且冒号后面什么都没有（因为压根没有错误）；
 * 同一处 `{:else if !remoteError && isLoggedIn()}` 又让"目录里没有条目"的空态
 * **永远走不到**（`!对象` 恒为假），中间那个"未登录"分支也成了死代码。
 * 也就是说：一个漏写的 `$` 同时废掉了三个状态里的两个，而**界面上看不出来**
 * （svelte-check 不会报——语法完全合法）。
 *
 * 所以这条判据交给机器：人漏 `$` 时手不会抖，检查会。
 *
 * 为什么不用现成工具：`svelte-check` 只看类型，裸 store 对象在模板里有合法类型
 * （`Writable` 是个对象，`{#if}` 收 any）。这条规则属于"语义约定"，只能自己扫。
 */

const REPO_ROOT = join(import.meta.dirname, '..')
const WEB_SRC = join(REPO_ROOT, 'apps', 'web', 'src')

async function collect(dir: string, suffix: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collect(full, suffix, out)
    else if (entry.name.endsWith(suffix)) out.push(full)
  }
  return out
}

/**
 * 找出这个前端里**所有**是 store 的名字。
 *
 * ⚠️ 动态收集（而不是手写一张名单）：手写的名单会在下一次有人加 store 时悄悄过时，
 *    而"过时的检查"看起来和"通过的检查"一模一样。
 */
async function collectStoreNames(): Promise<Set<string>> {
  const names = new Set<string>()
  for (const file of await collect(WEB_SRC, '.ts')) {
    const source = await readFile(file, 'utf8')
    for (const m of source.matchAll(/export const (\w+)\s*=\s*(?:writable|derived|readable)/g)) {
      names.add(m[1]!)
    }
  }
  return names
}

/**
 * 文件里声明过的**局部**名字。
 *
 * 没有这一步就会有误报：组件里叫 `loading`、`view` 这种常见名字的局部变量
 * （`FileViewer.svelte` 的 `loading`、`WorkDirTree.svelte` 的 `loading`）会被
 * 当成 store。**误报的检查会被下一个人关掉**，所以宁可多写这几行。
 */
function localNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const m of source.matchAll(/(?:^|\s)(?:export\s+)?(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]!)
  }
  for (const m of source.matchAll(/(?:export\s+)?(?:let|const|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.split(':').pop()!.split('=')[0]!.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const m of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    names.add(m[1]!)
    for (const part of m[2]!.split(',')) {
      const name = part.split(':')[0]!.split('=')[0]!.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const m of source.matchAll(/\$:\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]!)
  return names
}

/** 判断/循环标签里的表达式（`{#if}` / `{:else if}` / `{#each}` / `{#await}` / `{#key}`）。 */
const TAG = /\{#(?:if|each|await|key)\b([^}]*)\}|\{:else if\b([^}]*)\}/g

describe('★ 前端模板：store 必须订阅（`$store`），不许裸用', () => {
  test('★ 判断/循环里裸用 store ⇒ 红（裸对象恒为真，会废掉整条状态链）', async () => {
    const stores = await collectStoreNames()
    assert.ok(stores.size >= 10, `应当扫到不少 store，实际 ${stores.size}`)

    const offenders: string[] = []
    for (const file of await collect(WEB_SRC, '.svelte')) {
      const source = await readFile(file, 'utf8')
      // 注释里提到 store 名字是**允许**的（本仓库的注释大量引用标识符），先去掉
      const stripped = source.replace(/<!--[\s\S]*?-->/g, (m) => '\n'.repeat(m.split('\n').length - 1))
      const locals = localNames(stripped)
      for (const [index, line] of stripped.split('\n').entries()) {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
        TAG.lastIndex = 0
        for (const m of line.matchAll(TAG)) {
          const expr = m[1] ?? m[2] ?? ''
          // 字符串字面量里的名字不算（`actionsMode === 'tools-unknown'` 曾因此误报）
          const code = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ')
          for (const store of stores) {
            if (locals.has(store)) continue
            // 前面是 `$`（订阅）、`.`（属性名）或标识符字符 ⇒ 不是裸用
            if (new RegExp(`(?<![\\w$.])${store}\\b`).test(code)) {
              offenders.push(
                `${relative(REPO_ROOT, file)}:${index + 1} 裸用 store \`${store}\`：${line.trim()}`,
              )
            }
          }
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      '★ 裸用 store（漏 `$`）= 一个恒为真的对象，会把整条状态链废掉，而界面看不出来' +
        `（svelte-check 不会报）：\n${offenders.join('\n')}`,
    )
  })
})
