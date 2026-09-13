/**
 * 一个**够用就好**的 Markdown 渲染器。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么自己写，而不是引 marked / markdown-it
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个前端的运行时依赖是**零**（见 README 的技术栈一节）。而这里要渲染的
 * 是 agent 产出的一段 Markdown —— 为了它引一个解析器，等于为了一个视图把
 * "运行时零依赖"这条约束破掉。
 *
 * 而且引库也不自动等于安全：渲染出来的 HTML 要直接插进页面，任何"允许原始
 * HTML 透传"的实现都等于把 XSS 的门打开。自己写反而更清楚**哪些语法被支持**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全规则只有一条：**先转义，再拼我们自己的标签**
 * ══════════════════════════════════════════════════════════════════
 *
 * 顺序不能反：先拼标签再转义会把我们的标签也转义掉；先转义再拼则保证
 * **任何来自输入的 `<` 都已经是 `&lt;`**，后面我们插入的标签全是自己写死的字面量。
 *
 * 所以：
 *   - 原始 HTML **一律不认**（`<script>` 会原样显示成文字）；
 *   - 链接只允许 `http:` / `https:` / `mailto:`——`javascript:` 会被丢掉；
 *   - 图片的 src 走调用方给的 `resolveAsset`（把工作目录里的相对路径映射到
 *     我们能取的地址），不允许直接把任意 URL 塞进 `src`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 支持的语法（刻意很少，够渲染一份报告就行）
 * ══════════════════════════════════════════════════════════════════
 *
 *   标题 # ~ ####、粗体、斜体、行内代码、围栏代码块、无序/有序列表、
 *   引用、水平线、链接、图片、表格
 *
 * 不支持：嵌套列表的复杂缩进、HTML、脚注、定义列表。**不支持的东西会原样
 * 显示成文字**——那比"悄悄解析错"好。
 */

export interface MarkdownOptions {
  /**
   * 把图片/链接里的相对路径映射成可取的地址。
   *
   * 工作目录里的图片（agent 画出来的流程图之类）就靠它显示出来。返回 null
   * 表示这个地址不该被渲染成链接/图片（会退化成纯文本）。
   */
  resolveAsset?: (href: string) => string | null
}

/** HTML 转义。**所有**来自输入的文字都要过这一道。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 只允许这几种协议——`javascript:` 之类直接判不合法。 */
function safeHref(href: string): string | null {
  const trimmed = href.trim()
  if (trimmed === '') return null
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  // 相对路径交给调用方决定（工作目录里的文件）
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null // 其它协议：拒
  return trimmed
}

function renderInline(text: string, options: MarkdownOptions): string {
  // ══════════════════════════════════════════════════════════════════
  // 顺序很要紧：**先摘出结构，再转义剩下的文字，最后拼我们自己的标签**
  // ══════════════════════════════════════════════════════════════════
  //
  // 第一版是"先把整段转义，再在转义后的文本上拼标签"，于是每一处插回去的
  // 东西都被**二次转义**：
  //
  //   - 行内代码：`<img onerror=x>` 显示成 `&amp;lt;img onerror=x&amp;gt;`
  //   - 图片的 alt：引号变成 `&amp;quot;`
  //
  // 而且图片/链接的 `src`、`href` 也是从**已转义**的文本里取的——路径里带 `&`
  // 会被当成 `&amp;` 交给取文件的接口，于是取不到。这两个 bug 都是测试抓出来的。
  //
  // 现在：结构从**原始文本**里摘出来放进占位符，剩下的文字整体转义，
  // 最后把占位符换成按各自上下文转义好的 HTML。
  const slots: string[] = []
  const stash = (html: string): string => `\u0000S${slots.push(html) - 1}\u0000`

  let work = text

  // ① 行内代码：内容按"文本节点"转义
  work = work.replace(/`([^`]+)`/g, (_m, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  )

  // ② 图片：必须在链接之前（否则 `!` 会被留下）
  work = work.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const resolved = options.resolveAsset ? options.resolveAsset(src) : null
    // 取不到地址：原样显示成**文字**（看得出这里本来有张图、路径是什么），
    // 而不是让它被后面的链接正则吃成一个孤零零的 `!`
    if (resolved === null) return stash(escapeHtml(`![${alt}](${src})`))
    return stash(
      `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" loading="lazy">`,
    )
  })

  // ③ 链接
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const safe = safeHref(href)
    if (safe === null) return stash(escapeHtml(label)) // `javascript:` 之类：只留文字
    const resolved = /^[a-z][a-z0-9+.-]*:/i.test(safe)
      ? safe
      : options.resolveAsset
        ? options.resolveAsset(safe)
        : null
    if (resolved === null) return stash(escapeHtml(label))
    return stash(
      `<a href="${escapeHtml(resolved)}" target="_blank" rel="noreferrer noopener">` +
        `${escapeHtml(label)}</a>`,
    )
  })

  // ④ 剩下的**文字**整体转义（此刻文本里只剩普通字符与占位符）
  let out = escapeHtml(work)

  // ⑤ 强调。放在转义之后做：`*` `~` 不在转义集合里，而我们的标签是字面量
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')

  // ⑥ 放回占位符（里面的内容已经按各自上下文转义过了，**不要再转一次**）
  out = out.replace(/\u0000S(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '')

  return out
}

const FENCE = /^\s*```(\w*)\s*$/

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []

  let i = 0
  /** 列表是否开着——`ul`/`ol` 要配对，不能每行开一个 */
  let listOpen: 'ul' | 'ol' | null = null

  const closeList = (): void => {
    if (listOpen) {
      html.push(`</${listOpen}>`)
      listOpen = null
    }
  }
  const openList = (kind: 'ul' | 'ol'): void => {
    if (listOpen === kind) return
    closeList()
    html.push(`<${kind}>`)
    listOpen = kind
  }

  while (i < lines.length) {
    const line = lines[i]!

    // ── 围栏代码块 ──
    const fence = FENCE.exec(line)
    if (fence) {
      closeList()
      const lang = fence[1] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!)
        i += 1
      }
      i += 1 // 跳过收尾的 ```
      const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : ''
      html.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // ── 表格：表头 | 分隔行 | 数据行 ──
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      closeList()
      const cellsOf = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim())

      const head = cellsOf(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(cellsOf(lines[i]!))
        i += 1
      }
      html.push('<table><thead><tr>')
      for (const cell of head) html.push(`<th>${renderInline(cell, options)}</th>`)
      html.push('</tr></thead><tbody>')
      for (const row of rows) {
        html.push('<tr>')
        for (const cell of row) html.push(`<td>${renderInline(cell, options)}</td>`)
        html.push('</tr>')
      }
      html.push('</tbody></table>')
      continue
    }

    // ── 空行 ──
    if (line.trim() === '') {
      closeList()
      i += 1
      continue
    }

    // ── 水平线 ──
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      closeList()
      html.push('<hr>')
      i += 1
      continue
    }

    // ── 标题 ──
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1]!.length
      html.push(`<h${level}>${renderInline(heading[2]!, options)}</h${level}>`)
      i += 1
      continue
    }

    // ── 引用（连续行合成一个 blockquote）──
    if (/^\s*>\s?/.test(line)) {
      closeList()
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i += 1
      }
      html.push(`<blockquote>${renderInline(body.join(' '), options)}</blockquote>`)
      continue
    }

    // ── 列表 ──
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet) {
      openList('ul')
      html.push(`<li>${renderInline(bullet[1]!, options)}</li>`)
      i += 1
      continue
    }
    if (numbered) {
      openList('ol')
      html.push(`<li>${renderInline(numbered[1]!, options)}</li>`)
      i += 1
      continue
    }

    // ── 普通段落：把连续的非空行合成一段（Markdown 的软换行）──
    closeList()
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !FENCE.test(lines[i]!) &&
      !/^(#{1,4})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!)
    ) {
      para.push(lines[i]!)
      i += 1
    }
    // 两个以上空格结尾 = 硬换行
    const text = para
      .map((l) => (l.endsWith('  ') ? `${l.trimEnd()}<br>` : l))
      .join('\n')
    html.push(`<p>${renderInline(text, options)}</p>`)
  }

  closeList()
  return html.join('\n')
}
