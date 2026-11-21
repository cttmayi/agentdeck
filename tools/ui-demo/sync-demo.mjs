/**
 * 把 `docs/design/` 里那些**逐字嵌入**了 `app.css` 的设计页重新同步成真文件的样子。
 *
 * ⚠️ 2026-11（D211）：文件名从 `sync-list-demo.mjs` 改成 `sync-demo.mjs`——它同步的
 *   从来不止"列表页"那一份（还有 `platform-members-design.html`）。
 *
 * 为什么要这个脚本：那份 HTML 范例的第一段 `<style>` 是 `app.css`（含两个标准控件的
 * scoped 样式）的**逐字副本**——这样范例里的颜色/字号/行高就是产品里的样子，而不是
 * "照着调得像"。但它会过期：`app.css` 一改，范例就该跟着变。
 *
 * `tests/ui-style.test.ts` 有一条判据专门盯着"两段是不是逐字相同"（不一样就红）。
 * 红了就跑这一条：
 *
 *     node tools/ui-demo/sync-demo.mjs
 *
 * 然后刷新浏览器里的范例页。标记（`==== BEGIN/END ==== `）本身不许改——判据靠它们定位。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
/**
 * 带标记的设计页（每份都在自己的 `<style>` 里嵌了 app.css）。
 * ⚠️ 新增一份就先在两段 CSS 前后加 `==== BEGIN/END ==== ` 标记，再来这里加一行。
 */
const DEMOS = [
  join(ROOT, 'docs/design/ui-demo.html'),
  join(ROOT, 'docs/design/platform-members-design.html'),
  join(ROOT, 'docs/design/workflow-agents-design.html'),
]
const APP_CSS = join(ROOT, 'packages/ui/src/styles/app.css')
const COMPONENTS = [
  join(ROOT, 'apps/web/src/components/ListRow.svelte'),
  join(ROOT, 'apps/web/src/components/ListPane.svelte'),
]

const BEGIN_APP = '/* ==== BEGIN app.css（packages/ui/src/styles/app.css，逐字嵌入，别手改）==== */'
const END_APP = '/* ==== END app.css ==== */'
const BEGIN_CMP = '/* ==== BEGIN 标准控件里的 scoped 样式（真实页面里免费拿到，这里只为了让 demo 长得一样）==== */'
const END_CMP = '/* ==== END 标准控件 scoped 样式 ==== */'

/** 抠出 .svelte 的 `<style>` 内容（原样）。 */
function scopedStyle(path) {
  const text = readFileSync(path, 'utf8')
  const m = /<style>\n([\s\S]*)\n<\/style>/.exec(text)
  if (!m) throw new Error(`${path} 里找不到 <style> 块`)
  return m[1]
}

/** 把 `begin…end` 之间的内容换成 `body`（标记本身留着）。 */
function replaceRegion(text, begin, end, body) {
  const i = text.indexOf(begin)
  const j = text.indexOf(end)
  if (i < 0 || j < i) throw new Error(`范例里找不到标记：${begin}`)
  return text.slice(0, i + begin.length) + '\n' + body + '\n      ' + text.slice(j)
}

const appCss = readFileSync(APP_CSS, 'utf8')
const componentCss = COMPONENTS.map(scopedStyle).join('\n\n')

for (const demo of DEMOS) {
  const before = readFileSync(demo, 'utf8')
  let html = before
  const hasApp = html.includes(BEGIN_APP)
  if (hasApp) html = replaceRegion(html, BEGIN_APP, END_APP, appCss)
  const hasCmp = html.includes(BEGIN_CMP)
  if (hasCmp) html = replaceRegion(html, BEGIN_CMP, END_CMP, componentCss)
  writeFileSync(demo, html, 'utf8')
  console.log(
    `${demo.replace(ROOT + '/', '')}：` +
      (hasApp ? `app.css ${appCss.length} 字` : '（无 app.css 标记，跳过）') +
      (hasCmp ? ` + 控件 scoped ${componentCss.length} 字` : '') +
      `（${before.length} → ${html.length} 字）`,
  )
}
