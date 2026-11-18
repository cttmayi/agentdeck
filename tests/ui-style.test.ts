import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * 仓库级的**界面风格**静态检查（分批第 301 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这几条检查是从一次"每个页面都长得不一样"的体检里长出来的（`docs/design/style-audit.md`）
 * ══════════════════════════════════════════════════════════════════
 *
 * 体检量到的现状：30 处裸字号（15 种取值）、23 处裸圆角（7 种）、
 * **组件自己把同一个按钮画了 7 遍**、20 个**根本不存在的 CSS 变量**
 * （其中 7 个没有 fallback ⇒ 那一条声明整条失效，谁也没发现）。
 *
 * 这些缺陷有一个共同点：**类型检查与单元测试都看不见**，而且每一个单独看都"只差一点"，
 * 只有把全站摆在一起看才发现"同一个次要按钮在 7 个组件里内距不同"。
 * 靠人逐页复查是留不住的（这次的数字就是攒出来的），所以变成机器检查。
 *
 * 规则本身写在 `docs/design/ui-style.md`；这里只钉住**最容易复发的那几条**：
 *
 *   1. 字号/圆角不许写裸值（例外白名单在下面，每条都写了为什么）
 *   2. 组件里不许**重画**全局控件的形状（`.btn` / `.badge` / `.field` 只在 `app.css` 里定形状；
 *      组件可以调它的位置——`align-self`/`margin` 这类——但不能改它的填充、描边、字号）
 *   3. 不许引用**不存在的** CSS 变量（那等于写了一条永远不生效的声明）
 *   4. `.small` 不许再用（298 批已改名 `.fs-xs`；留着别名就还是两套名字）
 */

const REPO_ROOT = join(import.meta.dirname, '..')
const APP_CSS = 'packages/ui/src/styles/app.css'

/** 扫描范围：两个前端 app 的组件 + 设计系统本身。`ref/` 是上游材料，不扫。 */
const STYLE_ROOTS = ['apps/web/src', 'apps/remote/web/src', 'packages/ui/src']

/** 全局控件族的"形状"属性：组件里改到这些就是重画了一个控件。 */
const SHAPE_PROPS =
  /(^|[\s;{])(padding|border|border-[a-z]+|background|background-color|color|border-radius|font-size|font-weight|height|min-height|box-shadow|filter)\s*:/i

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      out.push(...(await walk(rel)))
    } else if (/\.(svelte|css)$/.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

type Hit = { file: string; line: number; text: string }

/** 逐行找某条声明的写法（注释行不算——注释里写 `font-size: xx` 是在讲历史）。 */
function declarations(files: Map<string, string>, prop: string): Hit[] {
  const out: Hit[] = []
  const re = new RegExp(`(^|[\\s;{])${prop}\\s*:`, 'i')
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return
      if (re.test(line)) out.push({ file, line: i + 1, text: t })
    })
  }
  return out
}

/**
 * 明说的例外。**每条都必须写清为什么**——白名单只会变长，不写理由的白名单
 * 三个月后就没人敢删了，于是规则悄悄死了。
 */
const ALLOW = {
  /** ★ 305 批：使用者纠正了口径——"可以变像素，主要还是为了同一"。
      原来那 17 处 `em` 与 `.markdown` 的标题分级已全部换成 `--fs-*` 令牌，
      所以这里**不再放行 `em`**：新写 `em` 字号一律拦下（要相对父级就用令牌档位说话）。 */
  fontEm: /$^/,
  /** 令牌、`inherit`、百分比 */
  fontOk: /font-size:\s*(var\(--fs-|inherit|[\d.]+%)/,
  /** `50%` 是"圆"（头像/圆点/进度环），不是圆角档位 */
  radiusPillPercent: /border-radius:\s*50%/,
  /** 滚动条轨道的历史值 5px：改 4/6 都会动像素，确认过保持 */
  radiusLegacy5: /border-radius:\s*5px/,
  /** 多值简写/calc 里用令牌（`0 var(--radius) var(--radius) 0`） */
  radiusCalc: /border-radius:\s*calc\(/,
}

describe('界面风格护栏（规则见 docs/design/ui-style.md）', () => {
  test('字号不写裸值：只认 `var(--fs-*)`、`inherit`、`em`（例外）', async () => {
    const files = await load()
    const bad = declarations(files, 'font-size').filter(
      (h) => !ALLOW.fontOk.test(h.text) && !ALLOW.fontEm.test(h.text),
    )
    assert.deepEqual(
      bad.map(describeHit),
      [],
      '字号必须走 `--fs-*` 令牌（`em` 是明说的例外，见 ui-style.md §5）',
    )
  })

  test('圆角不写裸值：只认 `var(--radius*)`、`50%`（圆）、`calc`', async () => {
    const files = await load()
    const bad = declarations(files, 'border-radius').filter(
      (h) =>
        !h.text.includes('var(--radius') &&
        !ALLOW.radiusPillPercent.test(h.text) &&
        !ALLOW.radiusCalc.test(h.text) &&
        !(h.file === APP_CSS && ALLOW.radiusLegacy5.test(h.text)),
    )
    assert.deepEqual(
      bad.map(describeHit),
      [],
      '圆角必须走 `--radius*` 令牌（`50%` 与 app.css 那处 5px 是明说的例外）',
    )
  })

  test('组件里不许重画全局控件：`.btn` / `.badge` / `.field` 的形状只在 app.css', async () => {
    const files = await load()
    const bad: string[] = []
    for (const [file, text] of files) {
      if (file === APP_CSS || !file.endsWith('.svelte')) continue
      for (const rule of rulesOf(text)) {
        // 只盯"基础族本身"：`.btn` / `.badge` / `.field`，以及 `.btn--*` 变体。
        // 复合修饰（`.badge.mine`、`.field.field-lock`）是**加东西**，允许。
        const base = rule.selector.split(',').map((s) => s.trim())
        const hits = base.filter(
          (s) => /^\.(btn|badge|field)$/.test(s) || /^\.btn--[a-z-]+(:[a-z-]+)?$/.test(s),
        )
        if (hits.length === 0) continue
        const shape = rule.body.split('\n').filter((l) => SHAPE_PROPS.test(l) && !l.trim().startsWith('*'))
        if (shape.length > 0) {
          bad.push(`${file}:${rule.line}  ${rule.selector} → ${(shape[0] ?? '').trim()}`)
        }
      }
    }
    assert.deepEqual(
      bad,
      [],
      '这几族的形状只有 app.css 一份定义；组件里只能调位置（align-self/margin 之类），' +
        '要新外观就在 app.css 加变体（ui-style.md §0.2）',
    )
  })

  test('不许引用不存在的 CSS 变量（写了也等于没写）', async () => {
    const files = await load()
    const defined = new Set<string>()
    for (const text of files.values()) {
      for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
        const name = m[1]
        if (name !== undefined) defined.add(name)
      }
    }
    /**
     * 运行期由 inline style 注入的（不是令牌，是"这一处算出来的数"）：
     *   `--level`（麦克风电平）、`--artifact-w`（右栏宽度）、`--create-pad-x`（栅格留白）、
     *   `--list-w` / `--grip-w`（列表宽度拖动把手，2026-11，由 `apps/web/src/lib/list-grip.ts`
     *   运行时写进网格；`--grip-w` 的默认值在 fallback 里，声明留给把手自己）
     */
    const injected = new Set(['--level', '--artifact-w', '--create-pad-x', '--list-w', '--grip-w'])
    const bad: string[] = []
    for (const [file, text] of files) {
      text.split('\n').forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('*') || t.startsWith('/*')) return
        for (const m of line.matchAll(/var\((--[a-z0-9-]+)/gi)) {
          const name = m[1] ?? ''
          if (name === '' || defined.has(name) || injected.has(name)) continue
          bad.push(`${file}:${i + 1}  ${name}  | ${t}`)
        }
      })
    }
    assert.deepEqual(
      bad,
      [],
      '用了没定义的变量 ⇒ 那条声明整条失效（体检里抓到 20 个，7 个连 fallback 都没有）',
    )
  })

  test('★★ 行容器只有一处定义：用 ListRow 的页面 `<ul>` 必须带 `list-stack`，且不许自己再写一份 reset', async () => {
    /*
     * ★ 2026-11（D136）：这条判据是"编排列表整列右移 40px"那次的产物。
     *
     * 起因不是有人写错了值，而是**同一件事被写了两遍**：定时任务页把 `ul` 的 reset
     * 写进 `Schedules.svelte` 的 scoped `<style>`（修它自己"左边空出一大截"那次），
     * 而 Svelte 的 scoped 样式**不跨文件**——编排页用了同一个类名 `list-stack`，
     * 照样吃浏览器默认的 `padding-left: 40px`。
     *
     * 所以从结构上钉死：**行容器**（承载 `ListRow` 的那个 `<ul>`）的样式只能在
     * `app.css` 的 `.list-stack` 里，页面只能写 `class="list-stack …"`。
     * 这条能拦住"新列表页忘了重置 / 又抄一份"，而那正是探针量不到的：探针量的是
     * **这一次**的页面长什么样，抓不到"下一个页面会不会犯同一个错"。
     *
     * ⚠️ 只扫**用 ListRow 的文件**：`.mat-list` / `.var-list` / `.history-list` 那些是
     *    面板内的小列表，不是行容器（它们各自的形状是内容的一部分）。
     */
    const files = await load()
    const bad: string[] = []
    /** 注释行不算（注释里写 `<ul>` 是在讲历史，这个仓库到处都是）。 */
    const isComment = (t: string): boolean =>
      t.startsWith('*') || t.startsWith('/*') || t.startsWith('//') || t.startsWith('<!--')
    for (const [file, text] of files) {
      if (!file.endsWith('.svelte')) continue
      if (!text.includes('<ListRow')) continue
      for (const [i, line] of text.split('\n').entries()) {
        // ① 承载 ListRow 的 <ul> 必须带 list-stack
        if (/<ul\b/.test(line) && !isComment(line.trim())) {
          const cls = /class="([^"]*)"/.exec(line)
          const names = (cls?.[1] ?? '').split(/\s+/).filter(Boolean)
          if (!names.includes('list-stack')) {
            bad.push(`${file}:${i + 1}  ${line.trim()}  ⇒ 用 ListRow 的 <ul> 必须带 list-stack`)
          }
        }
      }
      // ② 同一个文件里不许再为列表容器声明 reset（选择器指 ul 或 *-list）
      for (const rule of rulesOf(text)) {
        if (rule.selector.startsWith('@')) continue
        const isListContainer =
          /(^|[\s,>])ul\b/.test(rule.selector) || /-list(?:\.|\s|,|$)/.test(rule.selector)
        if (!isListContainer) continue
        if (/(^|[\s;{])list-style\s*:/.test(rule.body)) {
          bad.push(
            `${file}:${rule.line}  ${rule.selector} ⇒ 列表容器的 reset 只在 app.css 的 .list-stack 里`,
          )
        }
      }
    }
    assert.deepEqual(bad, [], '行容器的重置只能有一处（app.css `.list-stack`）')
  })

  test('★★ 设计稿里嵌的 CSS 必须与真文件逐字相同（列表页范例 / 平台成员设计稿）', async () => {
    /*
     * ★ 2026-11（D145）：从「只盯列表页范例」扩到**所有带标记的设计稿**——新增的
     *   `platform-members-design.html` 同样逐字嵌了 `app.css`。新增一份时：在两段 CSS
     *   前后加 `==== BEGIN/END ==== ` 标记，并把它加进下面这个清单。
     *   同步命令：`node tools/ui-demo/sync-list-demo.mjs`。
     */
    for (const rel of [
      'docs/design/list-page-demo.html',
      'docs/design/platform-members-design.html',
    ]) {
    /*
     * ★ 2026-11（D136）：使用者要一份"以后照着抄"的 HTML 范例。范例若像设计稿那样
     * **手抄一份令牌**，它迟早与真文件漂开——使用者照着它抄反而抄进旧样式（这个仓库
     * 已经栽过"三页各写一份同样的六行 CSS"）。
     *
     * 所以范例里的第一段 `<style>` 是**从真文件逐字嵌入**的（`app.css` + `ListRow` /
     * `ListPane` 的 scoped 样式），这条判据盯着它：真文件改了而范例没重新生成 ⇒ 红。
     * 重新生成的办法写在范例文件头（把真文件内容贴进那两对 `==== BEGIN/END ====`
     * 之间即可；`BEGIN`/`END` 标记本身不许改）。
     */
      const demo = await readFile(join(REPO_ROOT, rel), 'utf8')
    const grab = (begin: string, end: string): string => {
      const i = demo.indexOf(begin)
      const j = demo.indexOf(end)
      assert.ok(i >= 0 && j > i, `范例里找不到标记：${begin}`)
      return demo.slice(i + begin.length, j)
    }
    const same = (a: string, b: string): boolean =>
      a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim()

    const appCss = await readFile(join(REPO_ROOT, APP_CSS), 'utf8')
    const demoApp = grab(
      '/* ==== BEGIN app.css（packages/ui/src/styles/app.css，逐字嵌入，别手改）==== */',
      '/* ==== END app.css ==== */',
    )
    assert.ok(
      same(appCss, demoApp),
      `${rel} 里的 app.css 与真文件不一致——跑 node tools/ui-demo/sync-list-demo.mjs`,
    )

    const scopedOf = async (rel: string): Promise<string> => {
      const text = await readFile(join(REPO_ROOT, rel), 'utf8')
      const m = /<style>\n([\s\S]*)\n<\/style>/.exec(text)
      assert.ok(m, `${rel} 里找不到 <style> 块`)
      return m[1]!
    }
    /*
     * 控件 scoped 样式那一段是**可选的**：只有"要长得跟产品一模一样"的页面才需要
     * （列表页范例嵌了；平台成员设计稿只有表格与面板，没嵌）。有标记就必须逐字一致。
     */
    const BEGIN_CMP =
      '/* ==== BEGIN 标准控件里的 scoped 样式（真实页面里免费拿到，这里只为了让 demo 长得一样）==== */'
    if (demo.includes(BEGIN_CMP)) {
      const demoScoped = grab(BEGIN_CMP, '/* ==== END 标准控件 scoped 样式 ==== */')
      for (const sv of [
        'apps/web/src/components/ListRow.svelte',
        'apps/web/src/components/ListPane.svelte',
      ]) {
        assert.ok(
          demoScoped.includes((await scopedOf(sv)).trim()),
          `${rel} 里缺了 ${sv} 的 scoped 样式（或与真文件不一致）——跑一次同步脚本`,
        )
      }
    }
    }
  })

  test('★★ 组头也只有一处定义：`.list-group-*` 的样式只能在 app.css 与 ListGroupHead 里', async () => {
    /*
     * ★ 2026-11（D137）：列表分组原来**两页各写一套**（任务页带边框卡片、智能体页淡字行），
     * 类名、结构、字号都不同。收编成标准控件之后，这条判据守住"别再散回去"：
     * 除了 `app.css`（定义）与 `ListGroupHead.svelte`（它自己的 scoped 收尾样式），
     * 任何页面/组件都不许再出现 `.list-group-*` 的选择器。
     */
    const files = await load()
    const allowed = new Set([
      APP_CSS,
      'apps/web/src/components/ListGroupHead.svelte',
    ])
    const bad: string[] = []
    for (const [file, text] of files) {
      if (allowed.has(file)) continue
      for (const rule of rulesOf(text)) {
        if (/\blist-group-[a-z-]+/.test(rule.selector)) {
          bad.push(`${file}:${rule.line}  ${rule.selector}`)
        }
      }
    }
    assert.deepEqual(bad, [], '组头的样式只许在 app.css 与 ListGroupHead.svelte 里')
  })

  test('`.small` 已改名 `.fs-xs`：不许再出现在 class 里', async () => {
    const files = await load()
    const bad: string[] = []
    for (const [file, text] of files) {
      if (!file.endsWith('.svelte')) continue
      text.split('\n').forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('*') || t.startsWith('/*')) return
        const m = /class="([^"]*)"/.exec(line)
        if (m && (m[1] ?? '').split(/\s+/).includes('small')) bad.push(`${file}:${i + 1}  ${t}`)
      })
    }
    assert.deepEqual(bad, [], '`.small` 在 298 批改名 `.fs-xs`；留别名就还是两套名字')
  })
})

/** 把一个样式块拆成 { selector, body, line }（够用的浅解析：`}` 收尾即可）。 */
function rulesOf(text: string): { selector: string; body: string; line: number }[] {
  const out: { selector: string; body: string; line: number }[] = []
  const lines = text.split('\n')
  let cur: { selector: string; body: string[]; line: number } | null = null
  lines.forEach((line, i) => {
    if (cur === null) {
      if (line.includes('{') && !line.trim().startsWith('*') && !line.trim().startsWith('@')) {
        const selector = line.slice(0, line.indexOf('{')).trim()
        if (selector !== '' && !/^\d/.test(selector) && !/^[\d.]+%/.test(selector)) {
          cur = { selector, body: [], line: i + 1 }
          const rest = line.slice(line.indexOf('{') + 1).trim()
          if (rest !== '' && rest !== '}') cur.body.push(rest)
          if (rest.endsWith('}')) {
            out.push({ selector, body: cur.body.join('\n'), line: cur.line })
            cur = null
          }
        }
      }
      return
    }
    if (line.includes('}')) {
      const head = line.slice(0, line.indexOf('}')).trim()
      if (head !== '') cur.body.push(head)
      const done = cur
      out.push({ selector: done.selector, body: done.body.join('\n'), line: done.line })
      cur = null
      return
    }
    cur.body.push(line)
  })
  return out
}

function describeHit(h: Hit): string {
  return `${relative(REPO_ROOT, join(REPO_ROOT, h.file))}:${h.line}  ${h.text}`
}

async function load(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const root of STYLE_ROOTS) {
    for (const rel of await walk(root)) files.set(rel, await readFile(join(REPO_ROOT, rel), 'utf8'))
  }
  return files
}
