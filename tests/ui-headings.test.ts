import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 标题层级与卡片外壳只有一处定义（D179）。
 *
 * 规则写在 `docs/design/ui-style.md` §2.9：
 *   页名 `h1.page-name`(15px) → 这一块的名字 `h2`(17px) → 分段 `h3`(17px)
 *   → 段内小节 `h4`(13px/dim)；标签档（`label` / `.cell-label` / 看板列头）**不是标题**。
 *   卡片 = `.card-grid`（网格）+ `.main-panel`（外壳），关于页与设置页同一套。
 *
 * 为什么要这组判据（三个都是量出来的现状，不是假想）：
 *   · `h2` 曾经是 22px，于是 `.detail-head` / `.pane-head` / `.main-panel-head` /
 *     `.mem-preview-head` **四处各写一遍**"把 h2 压回 17px"——同一个值写四遍，
 *     就等于没有层级定义，谁再写第五遍也没人会问为什么；
 *   · "段内小节"有过四种写法（`<h4>` / `<span class="cell-label">` /
 *     `<div class="proc-head">` / `<h3 class="artifact-sub">`），字号都 13px，
 *     字色与权重各不相同，其中 `.artifact-sub` 标签说"分段"、样式说"小节"；
 *   · 卡片壳两套（`.ab-card` 私有、`.main-panel` 全局），网格两份逐字相同。
 *
 * 每一条都能在源码里数清楚；观感那部分（字号到底多大）由探针在真 Chrome 里量
 * （`tools/layout-probe` 的 `headings.*`），两边各管一半。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'apps/web/src')
const UI_CSS = join(ROOT, 'packages/ui/src/styles/app.css')

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) svelteFiles(full, out)
    else if (entry.name.endsWith('.svelte')) out.push(full)
  }
  return out
}

const sources = svelteFiles(SRC).map((full) => ({
  rel: full.slice(ROOT.length + 1),
  text: readFileSync(full, 'utf8'),
}))

/** 取出文件里 `<style>` 块的内容（只看样式，不看模板/脚本里的字符串；注释也剥掉） */
function styleBlocks(text: string): string {
  return text
    .split('<style>')
    .slice(1)
    .map((part) => (part.split('</style>')[0] ?? '').replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n')
}

/** 样式块里命中某个选择器前缀的规则体（到第一个 `}` 为止，够用来判字号） */
function ruleBodies(style: string, selectorPattern: RegExp): string[] {
  const bodies: string[] = []
  const re = new RegExp(`${selectorPattern.source}\\s*\\{`, 'g')
  for (const m of style.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length
    const end = style.indexOf('}', start)
    if (end > start) bodies.push(style.slice(start, end))
  }
  return bodies
}

test('★ 页名唯一：`<h1>` 只许出现在顶栏（一页一个）', () => {
  const offenders = sources.filter((s) => /<h1\b/.test(s.text)).map((s) => s.rel)
  assert.deepEqual(offenders, ['apps/web/src/components/Topbar.svelte'])
  const topbar = sources.find((s) => s.rel.endsWith('Topbar.svelte'))
  assert.ok(topbar)
  assert.match(topbar.text, /<h1 class="page-name">/, '顶栏的页名必须带 `.page-name`')
})

test('★★ 字号只在 app.css 一处定义：组件里不许给 h2/h3/h4 写 `font-size`', () => {
  /**
   * 白名单只有一处：**浮层工具条的标题**（`PromptEditor` 的 `.pe-head h3`）。
   * 浮层不属于页面层级（它盖在页面上、14px 是"模态头"那一档），且那里还兼着省略号，
   * 所以它自带字号是合理的——但必须写在这份白名单里，不能悄悄变成第二套层级。
   */
  const ALLOW = new Set(['apps/web/src/components/PromptEditor.svelte'])
  const offenders: string[] = []
  for (const { rel, text } of sources) {
    if (ALLOW.has(rel)) continue
    const style = styleBlocks(text)
    for (const body of ruleBodies(style, /(?:\s|^|>)[^,{}]*\bh[234]\b/)) {
      if (/font-size/.test(body)) offenders.push(`${rel} → ${body.trim().replace(/\s+/g, ' ')}`)
    }
  }
  assert.deepEqual(offenders, [], `标题字号不许在组件里覆盖（见 ui-style.md §2.9）：\n${offenders.join('\n')}`)

  // app.css 里那把梯子必须还是四个值（改这个层级得同一批改文档与探针）
  const css = readFileSync(UI_CSS, 'utf8')
  const ladder = ['h1', 'h2', 'h3', 'h4'].map((tag) => {
    const m = css.match(new RegExp(`(?:^|\\n)${tag} \\{ font-size: var\\(--fs-(\\w+)\\)`))
    return m ? m[1] : null
  })
  assert.deepEqual(
    ladder.slice(1),
    ['lg', 'lg', 'sm'],
    `四级梯子被改了（现在：${ladder.join(' / ')}）——改层级必须同一批改 ui-style.md §2.9 与探针 headings.*`,
  )
})

test('★★ 段内小节只有一种写法：`h4`（不许再用伪小节的四种方言）', () => {
  // 两个曾用"假小节"的地方，现在标签必须就是 h4
  const mustBeH4: Array<[string, string]> = [
    ['apps/web/src/components/CrystallizeView.svelte', 'proc-head'],
    ['apps/web/src/components/CrystallizeArtifactPane.svelte', 'artifact-sub'],
  ]
  /** 剥掉注释：讲历史时注释里会提到旧写法（`<h3 class="artifact-sub">`），那不是违规 */
  const stripComments = (text: string) =>
    text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  for (const [rel, cls] of mustBeH4) {
    const source = sources.find((s) => s.rel === rel)
    assert.ok(source, `${rel} 不存在`)
    const code = stripComments(source.text)
    assert.match(
      code,
      new RegExp(`<h4[^>]*class="${cls}"`),
      `${rel} 的 \`${cls}\` 必须是 \`<h4>\`（段内小节那一档）`,
    )
    assert.doesNotMatch(
      code,
      new RegExp(`<h[123]\\b[^>]*class="${cls}"`),
      `${rel} 的 \`${cls}\` 不许再用 h1/h2/h3 标签`,
    )
  }

  // 标签档（不是标题）不许打成标题标签：看板列头曾经是 `<h4>` 却按 12px 大写标签写样式
  const offenders: string[] = []
  for (const { rel, text } of sources) {
    for (const m of text.matchAll(/<h[1-4]\b[^>]*class="([^"]*)"/g)) {
      const cls = m[1] ?? ''
      if (/label|col-|hint/i.test(cls)) offenders.push(`${rel} → <h*> class="${cls}"`)
    }
  }
  assert.deepEqual(offenders, [], `标签档（label / 列头）不许用标题标签：\n${offenders.join('\n')}`)
})

test('★★ 卡片只有一套壳：`.card-grid` 网格 + `.main-panel` 卡片（关于页与设置页同一套）', () => {
  const offenders: string[] = []
  for (const { rel, text } of sources) {
    for (const m of text.matchAll(/class="([^"]*)"/g)) {
      const cls = m[1] ?? ''
      // 页面私有的卡片壳与网格：这两个名字本身就是"第二套"
      if (/(^|\s)(ab-card|set-card|ab-grid|set-grid)($|\s)/.test(cls)) {
        offenders.push(`${rel} → class="${cls}"`)
      }
    }
  }
  assert.deepEqual(offenders, [], `卡片壳只许全局这一套（ui-style.md §2.9）：\n${offenders.join('\n')}`)

  // 卡片网格只有一份定义（在 app.css）；两份逐字相同的旧网格（`.ab-grid` / `.set-grid`）不许回来
  // ⚠️ 只管**卡片**网格：`.cell` / `.field-row` / 记录那种两列排布是别的结构，不在这条里
  //   （第一版写成"凡 `repeat(2, minmax(0,1fr))` 都违规"，把四个页面的单元格网格全报红了）。
  const css = readFileSync(UI_CSS, 'utf8')
  assert.equal((css.match(/\.card-grid \{/g) ?? []).length, 1, '`.card-grid` 在 app.css 里必须只有一处定义')
  assert.deepEqual(offenders, [], offenders.join('\n'))

  // 用到卡片的两页必须真的用全局壳（数量按现状钉住，多一张少一张都要有人看）
  // ⚠️ 用**完整路径**找：`endsWith('Settings.svelte')` 会先撞上 `ChatSettings.svelte` /
  //   `CrystallizeSettings.svelte` / `WorkspaceSettings.svelte`（第一版就撞了，报"找不到 .card-grid"）
  const about = sources.find((s) => s.rel === 'apps/web/src/views/About.svelte')
  const settings = sources.find((s) => s.rel === 'apps/web/src/views/Settings.svelte')
  assert.ok(about && settings)
  assert.equal((about.text.match(/<section class="main-panel"/g) ?? []).length, 6, '关于页六张卡')
  assert.match(about.text, /<div class="card-grid">/)
  assert.match(settings.text, /<div class="card-grid">/)
})

test('★★ 填充档不许当边框线：`--surface-2` 只用来填背景（胶囊描边是唯一例外）', () => {
  /**
   * D167 定过：线用 `--line`、填充用 `--surface-2`（对比 1.16 的"线"在深色底上根本看不见）。
   * D174 修掉设置页 `.set-card` 那一处，但关于页还有三处同样的写法（D179 一并修）。
   * 唯一保留：`.stage-chips button` 的胶囊描边——胶囊本来就用最浅一档描边，且它紧贴同色底。
   */
  const offenders: string[] = []
  const files = [
    ...sources.map((s) => ({ rel: s.rel, text: s.text })),
    { rel: 'packages/ui/src/styles/app.css', text: readFileSync(UI_CSS, 'utf8') },
  ]
  for (const { rel, text } of files) {
    const body = rel.endsWith('.css') ? text : styleBlocks(text)
    body.split('\n').forEach((line, i) => {
      if (!/border[^:]*:\s*[\d.]+px\s+(solid|dashed)\s+var\(--surface-2\)/.test(line)) return
      // 允许胶囊描边那一处（app.css 里 `.stage-chips button` 的规则体）
      const near = body.slice(Math.max(0, body.indexOf(line) - 400), body.indexOf(line) + line.length)
      if (/\.stage-chips button \{/.test(near)) return
      offenders.push(`${rel}:${i + 1} ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `边框线要用 \`--line\`（填充档看不出来）：\n${offenders.join('\n')}`)
})
