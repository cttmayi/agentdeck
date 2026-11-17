import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { highlightJs } from './code-highlight.ts'

/**
 * 编排代码高亮（`code-highlight.ts`）。
 *
 * 钉三件事：
 *   ① **顺序**：先转义再包标签——代码里的 `<` 不许变成真的标签（XSS）；
 *   ② **逐字**：把标签剥掉之后必须与原文**完全相同**（高亮只加颜色，不动字符）；
 *   ③ 该上色的上色：注释 / 字符串 / 数字 / 关键字 / 六个原语。
 */

/** 剥掉我们自己加的 `<span class="tok-…">` 与转义，还原成原文。 */
function plain(html: string): string {
  return html
    .replace(/<span class="tok-[a-z]+">/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

describe('编排代码高亮', () => {
  const CODE = [
    '// 周报：先取数再成稿',
    "const 取数 = agent('数据员')",
    'const 报告 = await flow([取数], "写一份 {{task}}")',
    'if (报告.message.length > 0) {',
    '  await gate(`这版可以发了吗`)',
    '}',
  ].join('\n')

  test('★★ 剥掉标签之后与原文逐字相同（高亮只上色，不动一个字）', () => {
    assert.equal(plain(highlightJs(CODE)), CODE)
  })

  test('★★ 代码里的 HTML 被转义：不许变成真标签（XSS 入口）', () => {
    const html = highlightJs("const x = '<script>alert(1)</script>'")
    assert.ok(!html.includes('<script>'), '尖括号必须被转义')
    assert.match(html, /&lt;script&gt;/)
    // 剥标签后原文还在
    assert.ok(plain(html).includes("'<script>alert(1)</script>'"))
  })

  test('★ 该上色的上色了：注释 / 字符串 / 数字 / 关键字 / 原语', () => {
    const html = highlightJs(CODE)
    assert.match(html, /tok-comment">\/\/ 周报/, '行注释')
    assert.match(html, /tok-string">'数据员'</, '单引号字符串')
    assert.match(html, /tok-string">"写一份 \{\{task\}\}"/, '双引号字符串（占位符原样）')
    assert.match(html, /tok-string">`这版可以发了吗`</, '模板串')
    assert.match(html, /tok-keyword">const</, '关键字')
    assert.match(html, /tok-keyword">await</, '关键字 await')
    assert.match(html, /tok-primitive">agent</, '原语 agent')
    assert.match(html, /tok-primitive">gate</, '原语 gate')
    assert.match(html, /tok-number">0</, '数字')
  })

  test('没闭合的字符串 / 注释不许把整段吞掉（宁可整段灰掉，也不要循环或丢字）', () => {
    assert.equal(plain(highlightJs("const a = 'abc")), "const a = 'abc")
    assert.equal(plain(highlightJs('/* 没闭合')), '/* 没闭合')
    assert.equal(plain(highlightJs('')), '')
  })
})
