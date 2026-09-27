import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { escapeHtml, renderMarkdown } from './markdown.ts'

/**
 * Markdown 渲染。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组测试里最要紧的是**不产生可执行的 HTML**
 * ══════════════════════════════════════════════════════════════════
 *
 * 渲染出来的东西会被直接插进页面（`{@html …}`），而输入是 **agent 产出的
 * 一段文本** —— 也就是说，一个被诱导的 agent（或者它读到的某个文件里的内容）
 * 可以决定这段文本是什么。
 *
 * 而页面与 daemon **同源**：一段能执行的脚本就能直接调 `/api/*`（跑任务、
 * 读日志、装 skill）。所以"渲染 Markdown"在这里是一件安全相关的事，不是排版。
 */

describe('★ 不产生可执行的 HTML', () => {
  test('★ 原始 HTML 一律被转义，不当标签', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    assert.equal(html.includes('<script>'), false, '★ 绝不能出现真的 script 标签')
    assert.match(html, /&lt;script&gt;/, '应当原样显示成文字')
  })

  test('★ 单个标签、自闭合标签、事件属性也一样', () => {
    for (const evil of [
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<a href="javascript:alert(1)">x</a>',
    ]) {
      const html = renderMarkdown(evil)
      assert.equal(/<(script|img|svg|iframe|a)\b/i.test(html), false, `不该产生标签：${evil}`)
      // ⚠️ 这条断言第一版写成了"输出里含 onerror=" —— 而这几个输入里只有第一个
      //    有 onerror（第二个是 onload），于是用例在为错误的理由失败。
      //    要紧的是"整段被当成文字"：转义后的原文应当原样出现在输出里。
      assert.ok(
        html.includes(escapeHtml(evil)),
        `应当原样显示成文字：${evil} → ${html}`,
      )
    }
  })

  test('★ `javascript:` 链接被丢掉，只留文字', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    assert.equal(html.includes('javascript:'), false)
    assert.match(html, /点我/)
  })

  test('★ 即使 resolveAsset 什么都不检查，`javascript:` 也不能进 href', () => {
    // ⚠️ 上一条用例其实钉不住"协议检查"那道关：没有 resolveAsset 时，
    //    另一个分支（"取不到地址就只留文字"）恰好也把它挡住了。
    //    变异验证发现了这一点 —— 把协议检查删掉，那条用例照样通过。
    //
    //    所以这里给一个**最坏的** resolveAsset：原样返回。此时唯一能挡住
    //    `javascript:` 的就只剩协议检查本身。
    const echo = (s: string): string => s
    for (const evil of ['javascript:alert(1)', 'JavaScript:alert(1)', ' data:text/html,<x>']) {
      const html = renderMarkdown(`[点我](${evil.trim()})`, { resolveAsset: echo })
      assert.equal(
        /href="\s*(javascript|data):/i.test(html),
        false,
        `★ 协议检查必须兜住：${evil} → ${html}`,
      )
    }
  })

  test('`data:` 链接同样被拒（可以承载脚本）', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)')
    assert.equal(html.includes('data:text/html'), false)
  })

  test('正常的 http(s) 与 mailto 链接保留', () => {
    assert.match(renderMarkdown('[a](https://example.com/x)'), /href="https:\/\/example.com\/x"/)
    assert.match(renderMarkdown('[a](mailto:x@example.com)'), /href="mailto:x@example\.com"/)
  })

  test('★ 代码块里的内容也被转义', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    assert.equal(html.includes('<script>'), false)
    assert.match(html, /&lt;script&gt;/)
  })

  test('★ 行内代码里的内容也被转义', () => {
    const html = renderMarkdown('试试 `<img onerror=x>`')
    assert.equal(html.includes('<img'), false)
    assert.match(html, /&lt;img onerror=x&gt;/)
  })

  test('★ 输出里带 `</p>` 之类闭合标签也不能提前闭合我们的容器', () => {
    // 输入里的 `</p>` 会先被转义，所以不可能真的闭合
    const html = renderMarkdown('</p><script>x</script>')
    assert.equal(html.includes('</p><script>'), false)
  })
})

describe('图片：工作目录里的相对路径要能显示出来', () => {
  test('相对路径交给 resolveAsset 映射', () => {
    const html = renderMarkdown('![流程图](bubble_sort_flowchart.png)', {
      resolveAsset: (src) => `/api/runs/R1/file?path=${encodeURIComponent(src)}`,
    })
    assert.match(html, /<img src="\/api\/runs\/R1\/file\?path=bubble_sort_flowchart\.png"/)
    assert.match(html, /alt="流程图"/)
  })

  test('★ resolveAsset 返回 null 时不渲染成图片（避免给一个取不到的地址）', () => {
    const html = renderMarkdown('![x](secret.png)', { resolveAsset: () => null })
    assert.equal(html.includes('<img'), false)
    assert.match(html, /secret\.png/, '原样显示，让人知道这里本来有张图')
  })

  test('没有 resolveAsset 时不把任意地址塞进 src', () => {
    const html = renderMarkdown('![x](https://evil.example.com/a.png)')
    assert.equal(html.includes('<img'), false)
  })

  test('★ alt 文本里的引号会被转义（不能逃出属性）', () => {
    const html = renderMarkdown('![a" onerror="alert(1)](x.png)', {
      resolveAsset: () => '/x.png',
    })
    // ⚠️ 断言"输出里不含 onerror=" 是错的：它以**文字**形式出现在 alt 的值里，
    //    无害。要紧的是那个引号被转义了，所以 `" onerror="` 这种
    //    "闭合属性再开一个"的形态不可能出现。
    assert.equal(html.includes('" onerror="'), false, '★ 引号必须被转义，逃不出属性')
    assert.match(html, /&quot; onerror=&quot;/)
  })
})

describe('渲染常见语法', () => {
  const opts = { resolveAsset: (s: string) => `/f/${s}` }

  test('标题', () => {
    assert.match(renderMarkdown('## 报告', opts), /<h2>报告<\/h2>/)
    assert.match(renderMarkdown('#### 深层', opts), /<h4>深层<\/h4>/)
  })

  test('粗体 / 斜体 / 删除线', () => {
    assert.match(renderMarkdown('**粗**', opts), /<strong>粗<\/strong>/)
    assert.match(renderMarkdown('*斜*', opts), /<em>斜<\/em>/)
    assert.match(renderMarkdown('~~删~~', opts), /<del>删<\/del>/)
  })

  test('列表（有序 / 无序各配一对标签）', () => {
    const ul = renderMarkdown('- a\n- b', opts)
    assert.match(ul, /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/)
    const ol = renderMarkdown('1. a\n2. b', opts)
    assert.match(ol, /<ol>\n<li>a<\/li>\n<li>b<\/li>\n<\/ol>/)
  })

  test('★ 连续两段之间列表标签要闭合（不能漏 </ul>）', () => {
    const html = renderMarkdown('- a\n\n普通段落', opts)
    assert.equal((html.match(/<ul>/g) ?? []).length, 1)
    assert.equal((html.match(/<\/ul>/g) ?? []).length, 1)
  })

  test('围栏代码块带语言标记', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```', opts)
    assert.match(html, /<pre><code class="lang-js">const a = 1<\/code><\/pre>/)
  })

  test('引用与水平线', () => {
    assert.match(renderMarkdown('> 引用内容', opts), /<blockquote>引用内容<\/blockquote>/)
    assert.match(renderMarkdown('---', opts), /<hr>/)
  })

  test('表格', () => {
    const html = renderMarkdown('| 文件 | 用途 |\n|---|---|\n| a.mmd | 源文件 |', opts)
    assert.match(html, /<th>文件<\/th>/)
    assert.match(html, /<td>a\.mmd<\/td>/)
  })

  test('★ 表格不会被当成普通段落（分隔行识别）', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', opts)
    assert.equal(html.includes('<table>'), true)
    assert.equal(html.includes('<p>'), false)
  })

  test('普通段落合成一段（软换行）', () => {
    assert.match(renderMarkdown('第一行\n第二行', opts), /<p>第一行\n第二行<\/p>/)
  })

  test('空输入返回空串，不抛', () => {
    assert.equal(renderMarkdown(''), '')
  })

  test('★ 真实产物：冒泡排序那份报告能渲染出表格与图片', () => {
    // 用使用者那次真实产出的一段（原样）
    const source = [
      '已完成。冒泡排序算法的流程图如下（已渲染并人工核对）：',
      '',
      '![冒泡排序算法流程图](bubble_sort_flowchart.png)',
      '',
      '## 报告',
      '',
      '| 文件 | 用途 |',
      '|---|---|',
      '| `bubble_sort_flowchart.mmd` | Mermaid 源文件 |',
      '| `bubble_sort_flowchart.svg` | 矢量图 |',
    ].join('\n')
    const html = renderMarkdown(source, opts)
    assert.match(html, /<img src="\/f\/bubble_sort_flowchart\.png"/)
    assert.match(html, /<h2>报告<\/h2>/)
    assert.match(html, /<code>bubble_sort_flowchart\.mmd<\/code>/)
  })
})

describe('escapeHtml', () => {
  test('五个字符都转', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
  })
})

/**
 * ★ 代码块里的换行必须**原样留在输出里**。
 *
 * 起因是一次真实的误判：使用者报「聊天里那段代码的换行没有了」，看上去像模型
 * 没写换行。实测下来渲染器是对的（文字里 10 个换行都在），问题是 CSS 给行内
 * 代码写的 `white-space: nowrap` 被继承进了 `pre>code`，把十行压成一行。
 *
 * 所以这一条钉住"渲染器这一侧的产出"：只要它把换行丢掉，任何样式都救不回来。
 */
describe('★ 代码块：换行', () => {
  test('围栏代码块里的换行原样保留（不是合成一段）', () => {
    const out = renderMarkdown('```python\ndef f(a):\n    return a\n```\n')
    const body = /<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/.exec(out)?.[1] ?? ''
    assert.equal(body, 'def f(a):\n    return a', `代码块里的换行被动了：${JSON.stringify(body)}`)
  })

  test('缩进也是内容的一部分（不能被折叠）', () => {
    const out = renderMarkdown('```\n    indented\n\tTAB\n```\n')
    const body = /<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/.exec(out)?.[1] ?? ''
    assert.equal(body, '    indented\n\tTAB')
  })
})
