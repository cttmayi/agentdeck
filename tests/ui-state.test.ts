import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 三种状态（空 / 加载 / 错误）的**形状与位置**只有一处定义（D178）。
 *
 * 为什么用源码判而不是只用探针：这三种状态有两类是**瞬时**的（加载态一闪就没了）、
 * 一类是**要制造故障**才出现的（错误态）。探针跑一趟抓不到它们（能抓到的只有空态），
 * 而"顺手写个内联 `height:4rem`""把读失败渲染成一行灰字"这类退化恰恰是最常发生的。
 * 所以这里直接读源码：**规则的形状看得见、也拦得住**；探针只补"它到底长在哪儿"。
 *
 * 规则（写在 `docs/design/ui-style.md` §2.8）：
 *   · 骨架只有两档形状，类名给：`.skeleton`（单行）/ `.skeleton.skeleton--block`（一块）；
 *     **不许**再写内联 `height` / `width` / `margin`。
 *   · 空态两类语境，类名给：`.empty`（整块为空）/ `.empty.empty--flush`（内容里一小格为空）；
 *     **不许**用内联 style 掰全局样式。
 *   · 读失败（"这块数据没拿到"）必须渲染成**正文里的 `.notice bad`**——不是一行灰字、
 *     也不是只弹一个 toast（toast 只承载"一次操作的结果"）。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'apps/web/src')

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files(full, out)
    else if (entry.name.endsWith('.svelte')) out.push(full)
  }
  return out
}

const sources = files(SRC).map((full) => ({
  rel: full.slice(ROOT.length + 1),
  text: readFileSync(full, 'utf8'),
}))

/** 一行里出现某个 class 的属性片段（`class="…"` / `class={…}` 都算） */
function classAttrLines(text: string, cls: string): Array<{ line: number; body: string }> {
  const hits: Array<{ line: number; body: string }> = []
  text.split('\n').forEach((body, i) => {
    const re = new RegExp(`class=(?:"|\\{')[^"']*\\b${cls}\\b`)
    if (re.test(body)) hits.push({ line: i + 1, body })
  })
  return hits
}

test('★ 骨架只有两档形状，且**不许**再写内联尺寸（`.skeleton` / `.skeleton--block`）', () => {
  const offenders: string[] = []
  for (const { rel, text } of sources) {
    for (const { line, body } of classAttrLines(text, 'skeleton')) {
      // 只认类名里的 skeleton（`skeleton.listBox` 那类探针键不在这里，它们是 .ts/.mjs）
      if (!/class="[^"]*\bskeleton\b/.test(body)) continue
      if (/style=/.test(body)) {
        offenders.push(`${rel}:${line} 用内联 style 写骨架尺寸：${body.trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))

  // 两档之外没有第三档：`skeleton--` 只有 block 一个值
  const modifiers = new Set<string>()
  for (const { text } of sources) {
    for (const m of text.matchAll(/skeleton--([a-z-]+)/g)) modifiers.add(m[1] ?? '')
  }
  assert.deepEqual([...modifiers], ['block'], `骨架只许两档（单行 + --block），多出了：${[...modifiers].join('、')}`)
})

test('★ 空态两档语境由类名给，**不许**用内联 style 掰（`.empty` / `.empty--flush`）', () => {
  const offenders: string[] = []
  const modifiers = new Set<string>()
  for (const { rel, text } of sources) {
    for (const { line, body } of classAttrLines(text, 'empty')) {
      if (/style=/.test(body)) offenders.push(`${rel}:${line} 用内联 style 掰空态：${body.trim()}`)
      for (const m of body.matchAll(/empty--([a-z-]+)/g)) modifiers.add(m[1] ?? '')
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
  assert.deepEqual(
    [...modifiers],
    ['flush'],
    `空态只许两档语境（整块 + --flush），多出了：${[...modifiers].join('、')}`,
  )
  // `.empty-value`（字段值为空的占位）是另一件事，不能和 `.empty` 混着用
  const mixed: string[] = []
  for (const { rel, text } of sources) {
    for (const { line, body } of classAttrLines(text, 'empty-value')) {
      if (/\bempty\b(?!-)/.test(body.replace('empty-value', ''))) mixed.push(`${rel}:${line}`)
    }
  }
  assert.deepEqual(mixed, [], `同一个 class 里既有 .empty 又有 .empty-value：${mixed.join('、')}`)
})

test('★★ 读失败一律渲染成正文里的 `.notice`（不是灰字、也不是只弹 toast）', () => {
  /**
   * 判据的形状：每个 `$loadError[...]` 出现处，**附近**（这一行与往后 3 行）必须能看见
   * `class="notice …"` —— 两种合法写法都覆盖：
   *   · 守卫 + 下一行渲染：`{#if $loadError['x']}` → `<div class="notice bad">…</div>`；
   *   · 交给共享外壳渲染：`loadError={$loadError['x'] ?? null}`（`ListPane` 自己渲染 notice）。
   * 判"往哪儿渲染"而不是"这一行长什么样"：后者会把守卫行也当成违规（这是本判据第一版
   * 犯的错——它把 7 处正常的守卫/传参全报成了红的）。
   */
  const offenders: string[] = []
  for (const { rel, text } of sources) {
    const lines = text.split('\n')
    lines.forEach((body, i) => {
      if (!/\$loadError\[/.test(body)) return
      const window = lines.slice(i, i + 4).join('\n')
      if (/class="notice/.test(window)) return
      // 交给共享外壳（`loadError={…}`）也算"有地方渲染"：外壳里有判据盯着它渲染成 notice
      if (/loadError=\{/.test(body)) return
      offenders.push(`${rel}:${i + 1} 读失败附近没有 .notice：${body.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))

  // 共享外壳那两条渲染点必须真的是 notice（传参合法性的依据）
  for (const rel of ['apps/web/src/components/ListPane.svelte']) {
    const source = sources.find((s) => s.rel === rel)
    assert.ok(source, `${rel} 不存在`)
    assert.match(
      source.text,
      /class="notice bad">\{loadError\}/,
      `${rel} 里 \`{loadError}\` 必须渲染成 \`.notice bad\``,
    )
  }
})

test('★★ 「这块数据没拿到」不许只弹 toast：toast 只承载一次操作的结果', () => {
  // 机械能判的只有"toast 的文案键明显是加载语义"这一类（`loadFailed` / `loadError` / `fetchFailed`）。
  // 更细的语义判断（"这次操作为什么失败"属于哪一种）写在 ui-style.md §2.8，判不了就不假装判得了。
  const offenders: string[] = []
  for (const { rel, text } of sources) {
    for (const m of text.matchAll(/(?:showToast|toast\.set)\(([^\n]*)\)/g)) {
      const arg = m[1] ?? ''
      // ⚠️ 必须带词边界：`chat.uploadFailed`（上传是一个**动作**，toast 正确）里的
      //    "uploadFailed" 含有子串 "loadFailed"，不带边界会把它误判成读失败。
      if (/(?:^|\b)(loadFailed|loadError|fetchFailed)\b/.test(arg)) {
        const line = text.slice(0, m.index).split('\n').length
        offenders.push(`${rel}:${line} 把"读失败"交给 toast：${arg.trim().slice(0, 80)}`)
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})
