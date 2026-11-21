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

  /**
   * ★★ D180：**按钮的重量词必须带 `btn--` 前缀**（`ghost` / `primary` / `secondary` /
   * `danger` / `link` / `quiet` / `mini` / `icon` / `tight` / `sm`）。
   *
   * 为什么值得一条判据：D298 把按钮族改名成 `.btn--*` 时**漏了
   * `packages/ui/src/components` 那一层**（那一批 167 个按钮全在 `apps/web`）。
   * 于是 `Modal` 的「关闭」写着 `class="ghost"`、`ConfirmDialog` 的「取消/确认」写着
   * `secondary` / `danger` —— **这些裸名字没有一条全局规则**，而裸 `button` 的 base 是
   * `background: var(--accent-dim)`：实测「关闭」渲染成 `rgb(47, 111, 208)` + 白字。
   *
   * 这类缺陷的特点：**不报错、不警告、类型检查也看不见**，只是安静地变成另一个按钮。
   * 使用者原话："可以看到'关闭'等的蓝色按钮……不太好看"——所以它必须只能靠判据拦。
   *
   * 同时反向判一次：**用到的 `btn--*` 变体必须在 `app.css` 里有定义**
   * （否则就是"写了个名字、没人给它画样子"）。
   */
  test('★★ 按钮的重量词必须带 `btn--` 前缀，且用到的变体必须在 app.css 里有定义', async () => {
    const files = await load()
    const WEIGHTS = ['ghost', 'primary', 'secondary', 'danger', 'link', 'quiet', 'mini', 'icon', 'tight', 'sm']
    const bare: string[] = []
    const used = new Set<string>()
    for (const [file, text] of files) {
      if (!file.endsWith('.svelte')) continue
      // 讲历史时注释里会原样引用旧写法（`class="ghost"`），先剥注释再判
      const code = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      code.split('\n').forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return
        // 模板字面量的属性（`class={`btn btn--${kind ?? 'secondary'}`}`）解析不了 ——
        // 里面那些字符串是**取值**而不是类名，跳过（第一版把 `?? 'secondary'` 报成了裸名字）
        if (/class=\{\`/.test(line)) return
        // 静态写法：`class="a b c"`；动态写法：`class={cond ? 'a b' : 'c'}` —— 两种都要看
        for (const m of line.matchAll(/class=(?:"[^"]*"|\{[^}]*\})/g)) {
          const raw = m[0]
          const sources = raw.startsWith('class="') ? [raw.slice(7, -1)] : [...raw.matchAll(/'[^']*'/g)].map((x) => x[0].slice(1, -1))
          for (const source of sources) {
            for (const token of source.split(/\s+/)) {
              if (token === '') continue
              const hit = WEIGHTS.find((w) => token === w)
              if (hit !== undefined) bare.push(`${file}:${i + 1}  ${t}`)
              else if (/^btn--[a-z]+$/i.test(token)) used.add(token)
            }
          }
        }
      })
    }
    assert.deepEqual(
      bare,
      [],
      '按钮的重量词必须写成 `btn btn--<重量>`（裸名字没有全局规则，裸 button 会变成蓝底主按钮）：\n' +
        bare.join('\n'),
    )

    const css = files.get(APP_CSS) ?? ''
    const missing = [...used].filter((v) => !new RegExp(`\\.${v}\\b`).test(css))
    assert.deepEqual(missing, [], `这些按钮变体在 app.css 里没有定义（写了名字但没人画样子）：${missing.join('、')}`)
  })

  /**
   * ★★★ D201：**圆角令牌"名字里的序"必须等于"数值的序"**，且组件里不许写裸 px 圆角。
   *
   * 查下来的一处真错：6px 那个叫 `--radius-xs`、4px 那个叫 `--radius-sm`——**名字是反的**
   *   （`xs` 比 `sm` 还大）。这种错不会让界面坏掉，但它让"挑哪个令牌"变成猜：
   *   下一个人在 4 与 6 之间选时，看名字只会选错。改的只是名字（`--radius-xs` → `--radius-md`），
   *   像素一个没动 ⇒ 视觉零变化；这条判据钉住以后不许再反。
   */
  test('★★★ 圆角令牌的名字顺序 = 数值顺序（none < sm < md < 默认 < lg < pill）', async () => {
    const files = await load()
    const css = files.get('packages/ui/src/styles/app.css') ?? ''
    // `--radius-none` 的值是 `0`（不带单位），其余是 `Npx` ⇒ 两种都收
    const read = (name: string): number => {
      const m = css.match(new RegExp(`${name}:\\s*(\\d+)(?:px)?;`))
      assert.ok(m, `app.css 里没有 ${name}`)
      return Number(m[1])
    }
    const ladder: Array<[string, number]> = [
      ['--radius-none', read('--radius-none')],
      ['--radius-sm', read('--radius-sm')],
      ['--radius-md', read('--radius-md')],
      ['--radius', read('--radius')],
      ['--radius-lg', read('--radius-lg')],
      ['--radius-pill', read('--radius-pill')],
    ]
    const names = ladder.map(([n]) => n)
    const values = ladder.map(([, v]) => v)
    assert.deepEqual(
      values,
      [...values].sort((a, b) => a - b),
      `圆角令牌的数值必须按名字顺序递增：${names.map((n, i) => `${n}=${String(values[i])}`).join(' < ')}`,
    )
    assert.equal(new Set(values).size, values.length, '圆角令牌不许有两个同值（那就是一个令牌两种叫法）')

    // 组件里不许写裸 px 圆角（允许：50%（圆）、var(--radius*)、calc(...)、以及"某几个角用令牌"的分角写法）
    const bare: string[] = []
    for (const [rel, text] of files) {
      if (!rel.endsWith('.svelte')) continue
      const at = text.indexOf('<style')
      if (at < 0) continue
      const style = text.slice(at).replace(/\/\*[^]*?\*\//g, '')
      for (const m of style.matchAll(/border-radius:\s*([^;]+);/g)) {
        const v = (m[1] ?? '').trim()
        if (/var\(--radius|50%|calc\(/.test(v)) continue
        bare.push(`${rel} → border-radius: ${v}`)
      }
    }
    assert.deepEqual(
      bare,
      [],
      '圆角走令牌（--radius-sm / --radius-md / --radius / --radius-lg / --radius-pill），不写裸值：\n' +
        bare.join('\n'),
    )
  })

  /**
   * ★★★ D193：**标题层级只有一套定义（在 app.css）**，页面不许给 `h1`–`h4` 写字号 / 字重 / 字色。
   *
   * 量到的现状（六页逐页量 computed style）：标题族**只有一处**在改动——
   *   `PromptEditor.svelte` 的 `.pe-head h3 { font-size: var(--fs-base); font-weight: 600 }`，
   *   把 `<h3>` 画成 14/600（而全局 h3 是 17/600）⇒ 那个"标题"其实落在**标签档**
   *   （13 那一档）与正文档（14）之间，两档都不是。
   * 这条判据钉住"层级不被页面重定义"，例外写进 `HEADING_OVERRIDES` 并写明理由。
   */
  test('★★★ 标题层级只有一处定义：页面不许给 h1–h4 写字号 / 字重 / 字色', async () => {
    const files = await load()
    const css = files.get('packages/ui/src/styles/app.css') ?? ''
    // 全局必须有这一档阶梯（少一行就说明有人把层级写丢了）
    for (const need of ['h1, h2, h3, h4', 'font-size: var(--fs-lg)', 'font-size: var(--fs-sm)']) {
      assert.ok(css.includes(need), `app.css 的标题族少了一行：${need}`)
    }
    /**
     * 登记过的例外：文件 → 选择器片段（+ 一句"为什么它不是标题层级的事"）。
     *
     * ★ D194：原来是空的以前有一条——`PromptEditor` 的 `.pe-head h3`（把 `<h3>` 画成
     *   14/600）。D194 把那个 `<h3>` 换成了非标题元素 `<span class="pe-head-name">`，
     *   声明一字不改（14/600 + margin 0 + 补上原来继承来的 `line-height`），**视觉一致**，
     *   于是"标题当标签用"这件事从根上没了，表也就空了。
     */
    const HEADING_OVERRIDES: Array<[string, string, string]> = []
    const offenders: string[] = []
    for (const [rel, text] of files) {
      if (!rel.endsWith('.svelte')) continue
      const at = text.indexOf('<style')
      if (at < 0) continue
      const style = text.slice(at).replace(/\/\*[^]*?\*\//g, '')
      for (const m of style.matchAll(/([^{}]*\bh[1-4]\b[^{}]*)\{([^{}]*)\}/g)) {
        const sel = String(m[1] ?? '')
          .split(/\s+/)
          .filter((x) => x !== '')
          .join(' ')
        const body = m[2] ?? ''
        if (!/font-size|font-weight|\bcolor:/.test(body)) continue
        const reg = HEADING_OVERRIDES.find(([f, sel2]) => f === rel && sel.includes(sel2))
        if (reg) continue
        offenders.push(`${rel} → ${sel} { ${body.trim().slice(0, 60)} }`)
      }
    }
    assert.deepEqual(offenders, [], `标题的字号/字重/字色在 app.css 里定一次就够；页面要改请先在 HEADING_OVERRIDES 登记理由：\n${offenders.join('\n')}`)
  })

  /**
   * ★★★ D192：**断点只有四级**，而且写法只有一种（range 语法）。
   *
   * 量到的现状：`app.css` 里有四档断点（74 / 72 / 60 / 48rem），但
   *   ① **60rem 那一档被拆成两块**（一块管"两列塌一列"、一块管内距与顶栏动作），
   *      中间隔着别的东西 ⇒ "60rem 到底改了什么"要翻两遍文件；
   *   ② 边界靠**凑数**：`min-width: 74rem` 的补集被写成 `max-width: 73.99rem`
   *      （两个页面各一处，注释还专门说明"必须对齐"）——一对边界需要 0.01 的差值
   *      才不重叠，这是 `max-width` 含边界造成的，不是任何人的疏忽；
   *   ③ 页面里还藏着一档 `110rem` / `64rem`，是**看板列数**的步进（6→3→2 列），
   *      跟"页面怎么排版"不是一回事，但它长得跟断点一模一样，没人登记就分不开。
   *
   * 现在：`app.css` 只许四档，一律 range 语法（`width >= 74rem` / `width < 72rem` /
   *   `width < 60rem` / `width < 48rem`），每档**只有一块**；页面里额外允许看板那一族
   *   （`110rem` / `64rem`，登记在 `BOARD_STEPS` 里并写明理由）。
   */
  test('★★★ 断点只有四级（range 语法、每档一块），看板列数步进单独登记', async () => {
    const files = await load()
    const css = files.get('packages/ui/src/styles/app.css') ?? ''
    const noComments = (t: string): string => t.replace(/\/\*[^]*?\*\//g, '')
    const queries = (t: string): string[] => [...noComments(t).matchAll(/@media\s*([^{]*?)\s*\{/g)].map((m) => (m[1] ?? '').trim())
    /** 四级断点：**每档一块**（同一档出现两次就说明又被拆开了） */
    const TIERS = [
      '(width >= 74rem)',
      '(width < 74rem)',
      '(width < 72rem)',
      '(width < 60rem)',
      '(width < 48rem)',
    ]
    // app.css 自己只许**四块**（其中 `< 74rem` 是"宽档的另一半"，归页面用，见下）
    const APP_TIERS = ['(width >= 74rem)', '(width < 72rem)', '(width < 60rem)', '(width < 48rem)']
    const appQ = queries(css)
    assert.deepEqual([...appQ].sort(), [...APP_TIERS].sort(), `app.css 的断点必须正好是这四块（每档一块，range 语法）：\n实际 ${appQ.join(' / ')}`)
    /** 不许再用 `max-width` / `min-width` 写屏幕宽度（那是"含边界"的写法，逼人凑 73.99） */
    const badSyntax: string[] = []
    for (const [rel, text] of files) {
      if (!rel.endsWith('.css') && !rel.endsWith('.svelte')) continue
      for (const q of queries(text.slice(text.indexOf('<style') >= 0 && rel.endsWith('.svelte') ? text.indexOf('<style') : 0))) {
        if (/max-width|min-width/.test(q)) badSyntax.push(`${rel} → @media ${q}`)
      }
    }
    assert.deepEqual(badSyntax, [], `屏幕宽度的断点请用 range 语法（\`width >= 74rem\` / \`width < 72rem\`）：\n${badSyntax.join('\n')}`)
    /** 页面里额外允许的、登记过的断点（每一项都要写清"为什么它不属四级"） */
    // ★ D192：原来这里登记着 Tasks 的 （看板列数步进）——
    //   实测发现那一族规则**从来没生效过**（被  的 auto-fit 压住），整族删了。
    //   所以这张表现在是空的：页面里除了四级断点，一个额外断点都不该有。
    const BOARD_STEPS: Record<string, string> = {}
    // 页面里的断点值：四级里的可以直接用；其余必须在 BOARD_STEPS 里登记
    const stray: string[] = []
    for (const [rel, text] of files) {
      if (!rel.endsWith('.svelte')) continue
      const at = text.indexOf('<style')
      if (at < 0) continue
      for (const q of queries(text.slice(at))) {
        if (TIERS.some((t2) => q === t2)) continue
        const reg = BOARD_STEPS[rel]
        if (reg && new RegExp(reg).test(q)) continue
        stray.push(`${rel} → @media ${q}`)
      }
    }
    assert.deepEqual(stray, [], `这些断点没有登记（四级是 74 / 72 / 60 / 48rem；其它必须进 BOARD_STEPS 并写明理由）：\n${stray.join('\n')}`)
  })

  /**
   * ★★★ D190：**"要截断的长文字"只有一个写法——全局 `.ellipsis`**。
   *
   * 来时：那条"让省略号真的生效"的四行（`max-width:100%` + `overflow:hidden` +
   * `text-overflow:ellipsis` + `white-space:nowrap`）在页面 `<style>` 里被**逐字抄了
   * 35 次**，其中 6 份连 `display:block` 与 `font-weight:600` 都一样。抄到第 35 份时
   * 已经没人知道哪一行是必须的（chat 那条的注释写着"`max-width:100%`，省略号才有盒子
   * 可裁"——那句话对**每一个**块级标题都成立，所以它不该只写在 chat 里）。
   *
   * 判据分两档：
   *   ① **不许再写** `max-width: 100%` + 那三条的组合（必须用 `.ellipsis`）；
   *   ② 只剩三条（不带 `max-width`）的旧写法**只许少不许增**（棘轮：现在是 27 处）。
   *      它们大多是 flex 子项自己的 `flex` / `min-width` 配套，收进 `.ellipsis` 要一条条
   *      改 markup。**D191 把剩下的 25 处全收了**（棘轮从 27 降到 0）——所以这条现在
   *      是"一处都不许"，不是"别再多"。
   */
  test('★★★ 截断的长文字只有一个写法（全局 `.ellipsis`），旧写法只许少不许增', async () => {
    const files = await load()
    const css = files.get('packages/ui/src/styles/app.css') ?? ''
    assert.equal((css.match(/\.ellipsis \{/g) ?? []).length, 1, '`.ellipsis` 在 app.css 里必须是唯一一处定义')
    for (const need of ['text-overflow: ellipsis', 'white-space: nowrap', 'overflow: hidden', 'max-width: 100%', 'min-width: 0']) {
      assert.ok(css.includes(need), "`.ellipsis` 少了一行：" + need)
    }
    const RATCHET = 0
    const offenders: string[] = []
    let trioOnly = 0
    for (const [rel, text] of files) {
      if (!rel.endsWith('.svelte')) continue
      const style = text.slice(text.indexOf('<style'))
      const noComments = style.replace(/\/\*[^]*?\*\//g, '')
      for (const m of noComments.matchAll(/\{([^{}]*text-overflow:\s*ellipsis[^{}]*)\}/g)) {
        const body = m[1] ?? ''
        if (body.includes('max-width: 100%')) offenders.push(`${rel} → ${body.trim().slice(0, 90)}`)
        else if (['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap'].every((x) => body.includes(x))) trioOnly++
      }
    }
    assert.deepEqual(offenders, [], `这套截断写法请改用全局 \`.ellipsis\`（markup 里加 class）：\n${offenders.join('\n')}`)
    assert.equal(
      trioOnly,
      0,
      `还有 ${trioOnly} 处在页面 \`<style>\` 里各写一遍截断三条（三条加不加 \`max-width:100%\` 都算）：` +
        '一律改成全局 \`.ellipsis\`（markup 里加 class，页面样式只留自己的 display/flex/字号）',
    )
  })

  /**
   * ★★ D190：**声明的令牌必须有人用**（不留死接口）。
   *
   * 这条是量出来的：`--fs-2xl`（28px）在 `:root` 里 declare 了，**产品代码里一处都没有**
   * ——`--fs-xl` 还有两处（`h1.page-name` 与 markdown 的 h1），再往上一档就是死的。
   * 死令牌比裸值更坏：它看起来像"有这一档可以选"，于是下一个人照着它写，界面里就多出
   * 一个只有它自己在用的字号。
   */
  test('★★ 令牌不许空手摆在那里：每个 `:root` 令牌至少有一处使用', async () => {
    const files = await load()
    const css = files.get('packages/ui/src/styles/app.css') ?? ''
    const roots = [...css.matchAll(/:root[^{]*\{([^}]*)\}/g)].map((m) => m[1] ?? '')
    const declared = new Set<string>()
    for (const b of roots) for (const m of b.matchAll(/--([\w-]+)\s*:/g)) declared.add(m[1] as string)
    const used = new Set<string>()
    for (const [, text] of files) for (const m of text.matchAll(/var\(--([\w-]+)/g)) used.add(m[1] as string)
    const dead = [...declared].filter((n) => !used.has(n)).sort()
    assert.deepEqual(dead, [], `这些令牌声明了却没人用（删掉令牌，或在需要它的地方用它）：\n${dead.map((n) => '--' + n).join('\n')}`)
  })

  /**
   * ★★★ D188：**排版总表的数字必须与 `app.css` 的令牌一致**。
   *
   * 由来：`ui-style.md` 的令牌表里那行「控件高 `--ctl-h` 1.9rem · `--ctl-h-sm` 1.5rem」
   * 在 D181/D182 之后**已经不存在了**——界面早就是 30px，文档还写着 1.9rem 与一个
   * 被撤销的档。文档漂移比代码 bug 更阴：没人报错，下一个照着文档写的人就写错。
   *
   * 这条判据把「文档里的数」与「令牌的真值」机器比对：从 `:root` 里解析令牌、
   * 展开 `var()`、算 `calc()` 里的 `+`、把 rem 折成 px（1rem = 16px），再和
   * §0.1 总表那一列比。`--rail-h` 是 `calc(var(--ctl-h) + 4px)` ⇒ 应该算出 34。
   */
  test('★★★ 排版总表（ui-style §0.1）里的数字必须等于 app.css 的令牌真值', async () => {
    const files3 = await load()
    const css = files3.get(APP_CSS) ?? ''
    // ⚠️ 令牌**不止在第一个 `:root` 里**（`--list-row-min-h` 就在列表那一段的第二个
    //    `:root` 块里）。所以整份文件扫一遍，同名以第一次出现为准。
    const raw = new Map<string, string>()
    for (const m of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
      if (!raw.has(m[1] as string)) raw.set(m[1] as string, (m[2] as string).trim())
    }
    /** 把令牌展开成 px 列表（1rem = 16px；只支持这一个加法，够用且不引第三方） */
    const toPx = (value: string): number[] | null => {
      let v = value
      for (let i = 0; i < 8 && v.includes('var('); i++) {
        v = v.replace(/var\(--([\w-]+)\)/g, (_a, name: string) => raw.get(name) ?? '?')
      }
      if (v.includes('?')) return null
      const calc = /calc\((.+)\)/.exec(v)?.[1]
      const nums = (str: string): number[] => {
        const out: number[] = []
        for (const tok of str.split(/\s+/).filter((t) => t !== '' && t !== '+')) {
          const m = /^([0-9.]+)(rem|px)?$/.exec(tok)
          if (!m) return []
          out.push(Math.round(Number(m[1]) * (m[2] === 'rem' ? 16 : 1)))
        }
        return out
      }
      if (calc !== undefined) {
        const sum = nums(calc)
        const a = sum[0]
        const b = sum[1]
        return a !== undefined && b !== undefined ? [Math.round(a + b)] : null
      }
      const list = nums(v)
      return list.length > 0 ? list : null
    }
    // ⚠️ 文档不在 `load()` 扫的那批文件里（它只扫界面源码）⇒ 直接用 readFile 读
    const doc = await readFile(join(REPO_ROOT, 'docs/design/ui-style.md'), 'utf8')
    const section = doc.slice(doc.indexOf('## 0.1 排版七条'), doc.indexOf('两条**不是数字**的规则'))
    const rows = [...section.matchAll(/\| ([^|]+) \| `--([\w-]+)` \| ([^|]+) \|/g)]
    assert.ok(rows.length >= 12, `§0.1 总表应当有至少 12 行带令牌的行（现在 ${rows.length} 行）`)
    const bad: string[] = []
    for (const row of rows) {
      const [, theme, name, shown] = row
      const truth = toPx(raw.get(name as string) ?? '')
      const claimed = (shown as string)
        .trim()
        .split(/[·/]/)
        .map((t) => t.trim())
        .filter((t) => /^[0-9]+$/.test(t))
        .map(Number)
      if (!truth) {
        bad.push(`--${String(name)} 在 app.css 里解析不出来（令牌删了？）`)
        continue
      }
      // 令牌只有一个数时（`--pad-cell: 12px` = 四边都 12），文档写"12/12"也算对：
      // 比的是**去重后的数值集合**，不是写法。
      const uniq = (xs: number[]): number[] => Array.from(new Set(xs))
      if (uniq(truth).join('/') !== uniq(claimed).join('/')) {
        bad.push(`「${String(theme).trim()}」\`--${String(name)}\`：文档写 ${claimed.join('/')}px，令牌真值 ${truth.join('/')}px`)
      }
      const source = files3.get(APP_CSS) ?? ''
      if (!source.includes(`--${String(name)}:`)) bad.push(`\`--${String(name)}\` 在 app.css 的 :root 里不存在`)
    }
    assert.deepEqual(bad, [], `文档与令牌漂了（改令牌时把 §0.1 那张表一起改）：\n${bad.join('\n')}`)
  })

  /**
   * ★★ D181：**动作按钮必须归进按钮族**（`class="btn btn--<重量>"`）。
   *
   * 由来：使用者说"按钮的类型差别大，一般按钮和顶栏的按钮差异太大"。查下来一半是
   * 悬空类名（D180），**另一半是根本没进族的裸 `<button>`**：新建任务表单的
   * 「保存并运行」、设置页的「登录」、平台设定的「保存」、技能的「安装」、
   * 任务页的「接着干」/「恢复」、聊天的「保存」、智能体详情的「设为默认/复制/取消」
   * ——它们没有类名，吃的是裸 `button` 的 base：**实心 accent + 38px 高**，
   * 于是"主按钮"在全站有两种尺寸；而且任何一颗不带 `btn--primary` 的裸按钮
   * 看起来都像主按钮（界面上一屏出现好几个"主要的事"）。
   *
   * 例外只有一类：**结构性控件**（`.fold-head` / `.nav-item` / `.row` / `.tab` /
   * 轨道里的互斥切换 …）。它们自带类名，形状由 app.css 里那条 `X button` 的
   * 元素选择器定，**不能拿按钮族的高度**（列表行、折叠头、开关都不是"按钮"）。
   * 白名单就是下面这一串，加新的先问自己："它是一句要做一件事的话吗？"是 ⇒ 按钮族。
   */
  test('★★ 动作按钮必须归进按钮族：裸 `<button>` 只许出现在结构性控件里', async () => {
    const STRUCTURAL = [
      // 折叠 / 导航 / 行 / 标签这一族（形状由 `.X button` 的元素选择器定）
      'fold-head', 'expand-toggle', 'nav-item', 'row', 'dir', 'column-label',
      'list-group-head', 'list-row-main', 'list-row-action', 'card', 'card-head',
      'tab', 'run-tab', 'theme-picker', 'view-switch', 'stage-chips', 'source-toggle',
      // 各自的专用控件
      'intake-choice', 'skill-choice', 'artifact-tab', 'draft-turn-toggle', 'file-row',
      'history-row', 'mem-pin', 'pane-resizer', 'pe-close', 'pe-var-chip', 'pill',
      'quick-weekdays', 'weekday-btn', 'prefix-x', 'prompt-expand', 'switch',
      'terms-label', 'wd-dir', 'wd-file', 'wf-tpl', 'cat-toggle',
      'pane-tabs', 'fv-toggle', 'page-menu',
    ]
    /**
     * 一条 class 属性可能长这样（Svelte 里很常见）：
     *   class="pill {form.freq === f.key ? 'active' : ''}"
     * 先把它里面的 `{…}` 表达式抹掉，剩下的才是"写死的类名"。
     */
    const tokensOf = (tag: string): { tokens: string[]; dynamic: boolean } => {
      const literal = /class="([^"]*)"/.exec(tag)?.[1]
      const isDynamic = /class=(\{|`)/.test(tag)
      if (literal === undefined && !isDynamic) return { tokens: [], dynamic: false }
      const stripped = (literal ?? '').replace(/\{[^}]*\}/g, ' ')
      const tokens = stripped.split(/\s+/).filter((t) => t !== '')
      if (isDynamic) {
        const inner = /class=\{([^}]*)\}/.exec(tag)?.[1] ?? ''
        for (const q of inner.matchAll(/'([^']*)'|`([^`]*)`/g)) {
          const v = q[1] ?? q[2] ?? ''
          for (const t of v.split(/\s+/)) if (t !== '' && !t.includes('$')) tokens.push(t)
        }
      }
      return { tokens, dynamic: isDynamic }
    }
    const bad: string[] = []
    const files2 = await load()
    for (const [file, text] of files2) {
      if (!file.endsWith('.svelte')) continue
      // 注释与 `<script>` 里也有 `<button>` 字样（讲历史的注释里就引过），先剥掉
      const code = text
        .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/<script[\s\S]*?<\/script>/g, (m) => m.replace(/[^\n]/g, ' '))
      for (const m of code.matchAll(/<button([\s\S]{0,400}?)>/g)) {
        const tag = m[1] ?? ''
        const line = code.slice(0, m.index).split('\n').length
        const { tokens } = tokensOf(tag)
        // ① 归了按钮族（`btn` 或任一 `btn--*`）⇒ 过
        //    模板字面量（`` class={`btn btn--${kind ?? 'secondary'}`} ``）里的 `btn`
        //    不是独立 token，得单独看一眼——Topbar 那排动作就是这么写的。
        const templateBtn = /class=(?:\{|`)[^>]*?[\s"'`]btn(--|\s|`|$)/.test(tag)
        if (templateBtn || tokens.some((t) => t === 'btn' || t.startsWith('btn--'))) continue
        // ② 全是结构性类名 ⇒ 过（形状由 app.css 的元素选择器定）
        if (tokens.some((t) => STRUCTURAL.includes(t))) continue
        /**
         * ③ 一个类名都没写（只有 `class:active` 这种指令）：它必须落在结构性容器里。
         *    做法是往前找最近一个"带 class 的开标签"——粗略，但它只用来挡住"裸按钮"，
         *    挡住之后剩下的每一个都在这五族里（`.theme-picker` / `.source-toggle` /
         *    `.stage-chips` / `.view-switch` / 文件页签）。
         */
        const before = code.slice(0, m.index)
        const lastClass = [...before.matchAll(/class="([^"]*)"/g)].pop()?.[1] ?? ''
        if (STRUCTURAL.some((t) => lastClass.split(/\s+/).includes(t))) continue
        bad.push(
          `${file}:${line}  ${tokens.length > 0 ? `没进按钮族（类名 ${tokens.join(' ')}）` : '裸按钮（一个类名都没有）'}` +
            `  <button ${tag.trim().slice(0, 80)}>`,
        )
      }
    }
    assert.deepEqual(
      bad,
      [],
      '动作按钮要写成 `class="btn btn--<重量>"`（裸 button 会渲染成"实心 accent + 38px"，' +
        '主按钮于是有两种尺寸、而且一屏会出现好几个"主操作"长相）：\n' + bad.join('\n'),
    )
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
