import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CSV_MAX_COLS,
  CSV_MAX_ROWS,
  HEX_PEEK_BYTES,
  HIGHLIGHT_MAX_BYTES,
  defaultFace,
  extOf,
  fileKindOf,
  fileUrl,
  hasFace,
  hexDump,
  languageOf,
  looksBinaryText,
  parseCsv,
  rawFaceIsHex,
  refineKind,
  shouldHighlight,
  splitPath,
} from './file-view.ts'

/**
 * 查看器的判据。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组测试要挡住的是"看起来正常"的错
 * ══════════════════════════════════════════════════════════════════
 *
 * 把 Markdown 当纯文本显示、把一个二进制当文本显示、给一个认不出来的后缀配一套
 * 像模像样的语法配色——这三件事**都不报错**，界面上也"有东西"，只是它讲的不是
 * 事实。而这一栏存在的全部意义就是让使用者相信"我看到的就是磁盘上那个文件"。
 */
describe('文件查看器：按什么看', () => {
  test('服务端给的类型优先：图片 / PDF / HTML 直接就是它们自己', () => {
    assert.equal(fileKindOf('image/png', 'a.png'), 'image')
    assert.equal(fileKindOf('image/svg+xml', 'a.svg'), 'image')
    assert.equal(fileKindOf('application/pdf', 'a.pdf'), 'pdf')
    assert.equal(fileKindOf('text/html; charset=utf-8', 'a.html'), 'html')
  })

  test('★ octet-stream 是服务端的明确表态（"这不是我认识的文本"）⇒ 二进制', () => {
    // 扩展名会说谎：一个叫 .py 的二进制文件，按二进制处理才对
    assert.equal(fileKindOf('application/octet-stream', 'a.py'), 'binary')
    assert.equal(fileKindOf('application/octet-stream', 'a.bin'), 'binary')
  })

  test('★ 文本要再按扩展名细分——服务端把 .md / .json / .py 都发成 text/plain', () => {
    const t = 'text/plain; charset=utf-8'
    assert.equal(fileKindOf(t, 'README.md'), 'markdown')
    assert.equal(fileKindOf(t, 'notes.markdown'), 'markdown')
    assert.equal(fileKindOf(t, 'data.json'), 'json')
    assert.equal(fileKindOf(t, 'table.csv'), 'csv')
    assert.equal(fileKindOf(t, 'sort.py'), 'code')
    assert.equal(fileKindOf(t, 'x.ts'), 'code')
    assert.equal(fileKindOf(t, 'run.sh'), 'code')
    assert.equal(fileKindOf(t, 'a.yml'), 'code')
    assert.equal(fileKindOf(t, 'notes.txt'), 'text')
    // 没有扩展名的纯文本
    assert.equal(fileKindOf(t, 'LICENSE'), 'text')
  })

  test('application/json 也归 JSON（服务端对 .json 两条路都可能走）', () => {
    assert.equal(fileKindOf('application/json; charset=utf-8', 'a.json'), 'json')
  })

  test('★ 扩展名解析：点开头的隐藏文件不算扩展名', () => {
    assert.equal(extOf('a/b/c.py'), '.py')
    assert.equal(extOf('.gitignore'), '', '点开头是隐藏文件名，不是扩展名')
    assert.equal(extOf('noext'), '')
    assert.equal(extOf('UPPER.MD'), '.md', '大小写不影响判定')
  })

  test('★ 内容的判据：解出来带 NUL ⇒ 它其实是二进制（扩展名骗不了人）', () => {
    assert.equal(looksBinaryText('普通的文本\n第二行'), false)
    assert.equal(looksBinaryText('PK\u0003\u0004\u0000\u0000'), true)
  })

  test('★ refineKind：NUL 降级只对文本类生效，image/pdf 是服务端的明确表态', () => {
    // 回归：PNG 按 UTF-8 解出来必然带 NUL，绝不能把 image 降级成 binary——
    //   那正是"PNG 显示成原文、不能看图"这个 bug 的来源。
    assert.equal(refineKind('image', 'PNG\u0000\u0000\u0000IHDR'), 'image')
    assert.equal(refineKind('image', ''), 'image')
    assert.equal(refineKind('pdf', '%PDF\u0000\u0000'), 'pdf')
    // 文本类照旧：叫 .txt 实为 zip 的，还是会被识破
    assert.equal(refineKind('text', 'PK\u0003\u0004\u0000\u0000'), 'binary')
    assert.equal(refineKind('code', 'PK\u0003\u0004\u0000\u0000'), 'binary')
    assert.equal(refineKind('markdown', '干净的文本\n第二行'), 'markdown')
    // 已经是 binary 的不动
    assert.equal(refineKind('binary', '任何内容'), 'binary')
  })
})

describe('文件查看器：两面', () => {
  test('二进制只有「原文」；PDF 只有「渲染」；图片两面都有', () => {
    assert.equal(hasFace('binary', 'rendered'), false)
    assert.equal(hasFace('binary', 'raw'), true)
    // 图片两面都有：位图的原文是 hex，SVG 的原文是源码
    assert.equal(hasFace('image', 'rendered'), true)
    assert.equal(hasFace('image', 'raw'), true)
    assert.equal(hasFace('pdf', 'rendered'), true)
    assert.equal(hasFace('pdf', 'raw'), false)
    // 文本两侧都有
    for (const k of ['markdown', 'html', 'json', 'csv', 'code', 'text'] as const) {
      assert.equal(hasFace(k, 'rendered'), true, `${k} 应该有渲染面`)
      assert.equal(hasFace(k, 'raw'), true, `${k} 应该有原文面`)
    }
  })

  test('默认看哪一面：能渲染的给渲染，二进制给原文', () => {
    assert.equal(defaultFace('markdown'), 'rendered')
    assert.equal(defaultFace('html'), 'rendered')
    assert.equal(defaultFace('json'), 'rendered')
    assert.equal(defaultFace('csv'), 'rendered')
    assert.equal(defaultFace('image'), 'rendered')
    assert.equal(defaultFace('binary'), 'raw')
  })

  test('原文面是 hex 还是文本：二进制与位图是 hex，SVG 是文本', () => {
    // 二进制：hex（老语义）
    assert.equal(rawFaceIsHex('binary'), true)
    // 位图：按字节看就是十六进制，与二进制共用 hex 显示
    assert.equal(rawFaceIsHex('image', 'a.png'), true)
    assert.equal(rawFaceIsHex('image', 'drawing/photo.jpg'), true)
    // SVG 是文本（XML）：原文给源码，不是 hex
    assert.equal(rawFaceIsHex('image', 'a.svg'), false)
    assert.equal(rawFaceIsHex('image', 'dir/a.svg'), false)
    // 不带路径时按位图处理（默认面不受影响）
    assert.equal(rawFaceIsHex('image'), true)
    // 文本类都不是 hex
    assert.equal(rawFaceIsHex('text'), false)
    assert.equal(rawFaceIsHex('code'), false)
    assert.equal(rawFaceIsHex('markdown', 'a.md'), false)
  })
})

describe('文件查看器：着色', () => {
  test('只有认得出的代码才着色', () => {
    assert.equal(shouldHighlight('code', 1000), true)
    assert.equal(shouldHighlight('text', 1000), false, '纯文本没有语法可着')
    assert.equal(shouldHighlight('json', 1000), false, 'JSON 走折叠树那一面')
    assert.equal(shouldHighlight('markdown', 1000), false, 'Markdown 走渲染那一面')
  })

  test('★ 超过阈值就不着色（照样给原文，并说明原因）', () => {
    assert.equal(shouldHighlight('code', HIGHLIGHT_MAX_BYTES), true, '正好等于阈值 ⇒ 还着')
    assert.equal(shouldHighlight('code', HIGHLIGHT_MAX_BYTES + 1), false)
    assert.equal(shouldHighlight('code', 8 * 1024 * 1024), false)
    assert.equal(shouldHighlight('code', 0), false, '空文件没什么可着')
  })

  test('★ 语言映射：认不出来给 null（绝不 highlightAuto 猜一套错的配色）', () => {
    assert.equal(languageOf('a/b/sort.py'), 'python')
    assert.equal(languageOf('x.tsx'), 'typescript')
    assert.equal(languageOf('Dockerfile'), null)
    assert.equal(languageOf('weird.xyz'), null)
    assert.equal(languageOf('noext'), null)
  })
})

describe('文件查看器：原文的呈现', () => {
  test('十六进制：每行 16 字节，右边配可打印字符（不可打印打点）', () => {
    const dump = hexDump(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x41, 0x00]))
    assert.match(dump, /^00000000 {2}50 4b 03 04 41 00/)
    assert.match(dump, /PK\.\.A\.$/, '可打印的原样，不可打印的是点')
  })

  test('★ 十六进制只取前一段（大文件不把整屏撑爆）', () => {
    const big = new Uint8Array(HEX_PEEK_BYTES * 4).fill(0x41)
    const lines = hexDump(big).split('\n')
    assert.equal(lines.length, HEX_PEEK_BYTES / 16, `只该有 ${HEX_PEEK_BYTES / 16} 行`)
  })

  test('路径拆成目录与文件名（标题栏里目录要弱化）', () => {
    assert.deepEqual(splitPath('a/b/c.md'), { dir: 'a/b/', name: 'c.md' })
    assert.deepEqual(splitPath('c.md'), { dir: '', name: 'c.md' })
  })

  test('「新标签页打开」的地址与那一栏用的是同一套', () => {
    assert.equal(
      fileUrl('/api/conversations/c1', { path: 'out/我的 文件.md' }),
      '/api/conversations/c1/file?path=out%2F%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6.md',
    )
  })
})

/**
 * CSV 的「渲染」面。
 *
 * ⚠️ 这一面**不解释数据**：不做类型推断、不把空串显示成 `null`。它只做一件事——
 *    把"用逗号分隔、引号里可以有逗号"这件事拆对。
 */
describe('文件查看器：CSV 那一面', () => {
  test('基本拆分，末尾空行不算一行', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n').rows, [
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('★ 引号里的逗号不算分隔符，两个引号是一个引号', () => {
    assert.deepEqual(parseCsv('name,note\n"张,三","他说""好"""\n').rows, [
      ['name', 'note'],
      ['张,三', '他说"好"'],
    ])
  })

  test('★ 引号里的换行不算换行', () => {
    assert.deepEqual(parseCsv('a\n"第一行\n第二行"\n').rows, [['a'], ['第一行\n第二行']])
  })

  test('★ 行/列超上限要明说截断了（不假装全在）', () => {
    const many = Array.from({ length: CSV_MAX_ROWS + 5 }, (_, i) => `r${i}`).join('\n')
    const out = parseCsv(many)
    assert.equal(out.rows.length, CSV_MAX_ROWS)
    assert.equal(out.truncated, true)

    const wide = [Array.from({ length: CSV_MAX_COLS + 3 }, () => 'x').join(',')].join('\n')
    assert.equal(parseCsv(wide).truncated, true)
    assert.equal(parseCsv(wide).rows[0]!.length, CSV_MAX_COLS)
  })

  test('★ 不做类型推断：原文怎么写就怎么显示', () => {
    assert.deepEqual(parseCsv('1.0,,yes\n').rows, [['1.0', '', 'yes']])
  })
})
