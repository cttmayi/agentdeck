/**
 * 编排代码的高亮（极简、零依赖）——纯函数，可单测。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么自己写，而不是引一个编辑器库
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的要求是"编排代码的显示要像专业编辑器那样有高亮"。但本项目的硬约束是
 * **离线可用、没有 CDN 依赖**（页面跑在 127.0.0.1 上），而 CodeMirror / Monaco
 * 都是几百 KB 起、还要维护主题与中文输入法的细节。
 *
 * 编排代码只有几十行，语法也是我们自己定的（六个原语 + 普通 JS）。所以这里做一个
 * **行内高亮 + textarea 叠层**（`CodeEditor.svelte`）：
 *   · 底下一层 `<pre>` 画带颜色/加粗的 token；
 *   · 上面一层透明文字、可见光标的 `<textarea>` 负责真正的输入；
 *   · 两层用**同一套字体度量与 `white-space: pre`**，所以字符位置逐字对齐。
 *
 * ⚠️ 顺序是硬规则（与 `markdown.ts` 同一条纪律）：**先转义、再包标签**。
 *    反过来（先包标签再整段转义）会把我们自己生成的 `<span>` 也转义掉；
 *    而"不转义直接拼"会让代码里的 `<` 变成标签——那是 XSS 入口，与 Markdown 渲染器
 *    踩过的坑一模一样。
 *
 * ⚠️ 高亮**只是显示**：输出永远是从原文里切出来的片段，一个字都不许增删——
 *    否则"看到的就是我写的那段"这件事就不成立了（与文件查看器的"原文逐字"同一条）。
 */

/** 编排里会用到的 JS 关键字（够用就好，不追求完整）。 */
const KEYWORDS = new Set([
  'await',
  'const',
  'let',
  'var',
  'return',
  'if',
  'else',
  'for',
  'while',
  'of',
  'in',
  'function',
  'new',
  'typeof',
  'try',
  'catch',
  'finally',
  'throw',
  'async',
  'true',
  'false',
  'null',
  'undefined',
])

/** 直接认作"函数名"的那几个原语（高亮成强调色，读代码时一眼看到流程骨架）。 */
const PRIMITIVES = new Set(['agent', 'gate', 'flow', 'parallel', 'loop', 'route'])

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const span = (cls: string, text: string): string =>
  `<span class="tok-${cls}">${escapeHtml(text)}</span>`

/**
 * 把一段 JS 变成带 `<span class="tok-*">` 的 HTML（**已经转义过**）。
 *
 * 认这几类：行注释 / 块注释 / 字符串（含模板串）/ 数字 / 关键字 / 原语名 / 标点。
 * 认不出来的按普通文本输出——**宁可少上色，也不要把字符吞掉或挪位**。
 */
export function highlightJs(code: string): string {
  const out: string[] = []
  let i = 0
  const push = (text: string) => {
    if (text !== '') out.push(escapeHtml(text))
  }
  while (i < code.length) {
    const ch = code[i]!
    const next = code[i + 1]

    // 行注释：// 到行尾
    if (ch === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      const stop = end < 0 ? code.length : end
      out.push(span('comment', code.slice(i, stop)))
      i = stop
      continue
    }
    // 块注释：/* … */（没闭合就一直画到末尾——宁可整段灰掉，也不要循环出去）
    if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end < 0 ? code.length : end + 2
      out.push(span('comment', code.slice(i, stop)))
      i = stop
      continue
    }
    // 字符串：'…' / "…" / `…`（支持反斜杠转义；没闭合就到行尾，避免吞掉整个文件）
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < code.length) {
        const c = code[j]!
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === ch) {
          j += 1
          break
        }
        if (c === '\n' && ch !== '`') break // 单/双引号不跨行
        j += 1
      }
      out.push(span('string', code.slice(i, Math.min(j, code.length))))
      i = Math.min(j, code.length)
      continue
    }
    // 数字
    if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(code[i - 1] ?? '')) {
      let j = i + 1
      while (j < code.length && /[0-9._]/.test(code[j]!)) j += 1
      out.push(span('number', code.slice(i, j)))
      i = j
      continue
    }
    // 标识符：关键字 / 原语 / 其它
    if (/[A-Za-z_$\u4e00-\u9fff]/.test(ch)) {
      let j = i + 1
      while (j < code.length && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(code[j]!)) j += 1
      const word = code.slice(i, j)
      if (PRIMITIVES.has(word)) out.push(span('primitive', word))
      else if (KEYWORDS.has(word)) out.push(span('keyword', word))
      else push(word)
      i = j
      continue
    }
    push(ch)
    i += 1
  }
  return out.join('')
}
