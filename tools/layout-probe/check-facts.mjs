#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 * check-facts.mjs —— 拿 `dump.html` 里探针**当下发布**的事实比对 `CHECKS`
 * ══════════════════════════════════════════════════════════════════════
 *
 * 为什么需要它（2026-10，重对齐那几段过期断言时补的）：
 *
 * `run.mjs` 只在探针写出 `done: true` 时才读事实、才逐条判。而探针的
 * `--virtual-time-budget` 是**硬的**：每一条超时的 `until()` 吃掉 15s **虚拟**时间，
 * 所以只要有几段过期断言在超时，预算就会在跑到一半时用光——那一刻 `#out` 里还是
 * `pending`，`run.mjs` 于是只报一句「探针没在超时前给出结果」，**一条真因都看不到**。
 *
 * 探针现在每到一段开头就 `publish(false)` 把手上量到的事实写进 DOM，所以 dump 里
 * 其实**有**几百条已经量到的事实。这个脚本把它们读出来、按 `run.mjs` 的期望逐条判，
 * 分成三类：
 *
 *   · **绿**：量到了、判过了，通过；
 *   · **红**：量到了、判不过——**这才是真问题**（选择器过期、或者实现真的变了）；
 *   · **没量到**：探针还没跑到那一段（`null` / `undefined` / key 不在）。
 *
 * 用法（探针那次跑不完也没关系）：
 *
 * ```bash
 * PROBE_TIMEOUT_MS=420000 pnpm run probe:layout || true
 * node tools/layout-probe/check-facts.mjs
 * ```
 *
 * ⚠️ 它**不是** `pnpm run probe:layout` 的替代：它读的是"探针跑到哪算哪"的现场，
 *    所以"没量到"那一类里可能混着真问题。完整的验收仍然是探针自己跑完、`done: true`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DUMP = path.join(ROOT, '.cache/layout-probe/dump.html')
const RUN = path.join(HERE, 'run.mjs')

const dim = (s) => `\u001b[2m${s}\u001b[0m`
const red = (s) => `\u001b[31m${s}\u001b[0m`
const yellow = (s) => `\u001b[33m${s}\u001b[0m`
const green = (s) => `\u001b[32m${s}\u001b[0m`

if (!fs.existsSync(DUMP)) {
  console.error(red(`✗ 没有 dump：${path.relative(ROOT, DUMP)}（先跑一次 pnpm run probe:layout）`))
  process.exit(1)
}

// ── 把 `CHECKS` 这一段数组原样取出来求值 ──
//
// ⚠️ 不用 `import('../run.mjs')`：那个文件一被 import 就把 daemon、夹具、Chrome
//    全跑一遍。这里只要那个数组字面量，所以按行切出来，配上它用到的那几个纯函数
//    与常量（`near` / `sameSet` / `CHAIN_ACTION`）。`run.mjs` 改了这几样的话，
//    下面的 `eval` 会直接抛错——这是**要的**：宁可这个工具报"配不上"，也不要
//    它悄悄用一份过期的期望值给出结论。
const runLines = fs.readFileSync(RUN, 'utf8').split('\n')
const start = runLines.findIndex((l) => l.startsWith('const CHECKS = ['))
if (start < 0) {
  console.error(red('✗ run.mjs 里找不到 `const CHECKS = [`'))
  process.exit(1)
}
let end = -1
for (let i = start + 1; i < runLines.length; i++) {
  if (runLines[i] === ']') {
    end = i
    break
  }
}
if (end < 0) {
  console.error(red('✗ run.mjs 里找不到 CHECKS 数组的结尾'))
  process.exit(1)
}

/** 常量从 `run.mjs` 里原样抄（改了就跟着改，不在这里另立一份）。 */
const constOf = (name) => {
  const m = new RegExp(`^const ${name} = (.*)$`, 'm').exec(runLines.join('\n'))
  if (!m) throw new Error(`run.mjs 里找不到常量 ${name}`)
  return m[1].replace(/\/\/.*$/, '').trim()
}

const preamble = `
const near = (a, e, tol = 2) => typeof a === 'number' && Math.abs(a - e) <= tol
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.includes(x))
const CHAIN_ACTION = ${constOf('CHAIN_ACTION')}
`
const CHECKS = eval(`${preamble}\n${runLines.slice(start, end + 1).join('\n')}\n;CHECKS`)

// ── 读 dump 里的 `#out` ──
const html = fs.readFileSync(DUMP, 'utf8')
const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(html)
if (!m) {
  console.error(red('✗ dump 里没有 #out（Chrome 还没把 DOM 打出来？）'))
  process.exit(1)
}
const text = m[1]
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .trim()
if (text === 'pending') {
  console.error(
    yellow('⚠ dump 里 #out 还是 "pending"——探针连第一次发布都没走到（脚本没解析？页面没加载？）'),
  )
  process.exit(1)
}
const data = JSON.parse(text)
const { facts, errors, done } = data

console.log(
  dim(
    `探针报告：done=${done} · 事实 ${Object.keys(facts).length} 条 · errors ${errors.length} 条` +
      (done ? '' : '（★ 没跑完：下面的"没量到"里可能混着真问题）'),
  ),
)
if (errors.length) {
  console.log(yellow('--- errors（探针自己报的，多是"拿不到元素"）：'))
  for (const e of errors.slice(0, 12)) console.log('  ·', String(e).split('\n')[0].slice(0, 150))
  if (errors.length > 12) console.log(dim(`  …还有 ${errors.length - 12} 条`))
}

let pass = 0
let fail = 0
let missing = 0
const failures = []
const missingViews = new Map()
for (const c of CHECKS) {
  const known = Object.hasOwn(facts, c.key)
  const v = facts[c.key]
  if (!known || v === null || v === undefined) {
    missing++
    missingViews.set(c.view, (missingViews.get(c.view) ?? 0) + 1)
    continue
  }
  let ok
  try {
    ok = c.ok(v, facts)
  } catch {
    ok = false
  }
  if (ok) pass++
  else {
    fail++
    failures.push(
      `${c.view} | ${c.key} | ${String(c.label).slice(0, 64)} | 实测 ${JSON.stringify(v).slice(0, 70)}`,
    )
  }
}

console.log(
  `\nCHECKS ${CHECKS.length} 条：${green(`绿 ${pass}`)} · ${red(`红 ${fail}`)} · ${dim(`没量到 ${missing}`)}`,
)
if (failures.length) {
  console.log(red('\n--- 已量到但判不过的（这些是真问题）：'))
  for (const f of failures) console.log('  ✗', f)
}
if (missingViews.size) {
  console.log(dim('\n--- 没量到的按段落分布（探针大概停在这些段落之前或之中）：'))
  for (const [view, n] of [...missingViews.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(dim(`  ${view}：${n} 条`))
  }
}
process.exit(fail > 0 ? 1 : 0)