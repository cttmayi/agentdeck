import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cacheHeadersFor } from './index.ts'

/**
 * 静态资源的缓存策略。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组测试挡的是一次真实的误判
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者报"聊天页不工作、任务页正常"。查下来 daemon 是好的、当前这份前端也是
 * 好的——他看的是一个**早就开着、没有刷新**的标签页。而这里原本**一个缓存头都
 * 不发**：浏览器对那份外壳既不知道能不能复用，也没有依据去问"变了没有"。
 *
 * 所以判据按"文件名有没有内容哈希"分，两档各自钉住——尤其是**别把 `index.html`
 * 也设成 immutable**：那样重建之后浏览器一直用旧外壳，而旧外壳指向的旧包已经被
 * 每次构建清掉了。
 */
describe('静态资源的缓存头', () => {
  test('★ 带内容哈希的产物可以长期缓存（重建之后不必让使用者清缓存）', () => {
    assert.match(cacheHeadersFor('/assets/index-abc123.js').cacheControl, /immutable/)
    assert.match(cacheHeadersFor('/assets/index-abc123.css').cacheControl, /max-age=\d{6,}/)
  })

  test('★★ 外壳（index.html）必须每次核对——它指向哪个包决定了界面是哪一版', () => {
    assert.equal(cacheHeadersFor('/index.html').cacheControl, 'no-cache')
    assert.equal(cacheHeadersFor('/').cacheControl, 'no-cache')
    assert.doesNotMatch(
      cacheHeadersFor('/index.html').cacheControl,
      /immutable/,
      'index.html 设成 immutable ⇒ 重建之后浏览器一直用旧外壳，而旧包已经被清掉了',
    )
  })

  test('其它静态文件（favicon 之类）同样每次核对', () => {
    assert.equal(cacheHeadersFor('/favicon.ico').cacheControl, 'no-cache')
    assert.equal(cacheHeadersFor('/logo.svg').cacheControl, 'no-cache')
  })
})
