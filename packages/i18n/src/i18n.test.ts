import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LOCALES, LOCALE_LABEL, isLocale } from './locale.ts'
import { placeholdersOf, renderText } from './text.ts'
import { webText } from './web/index.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * 词表自身的守卫（D39）
 * ══════════════════════════════════════════════════════════════════
 *
 * 翻译最容易出的两类错都是**静默**的：漏了英文（英文界面里冒出一句中文）、
 * 占位符不一致（界面上留下一串 `{name}` 字面量）。它们不会报错，只会难看。
 * 所以这两条在这里机械地钉住——加词条的那一刻就会红。
 */
describe('D39：界面词表', () => {
  test('★ 每条词条 zh / en 都有，且都非空', () => {
    for (const [id, entry] of Object.entries(webText)) {
      for (const locale of LOCALES) {
        const value = entry[locale]
        assert.equal(typeof value, 'string', `${id} 缺 ${locale}`)
        assert.ok(value.trim() !== '', `${id} 的 ${locale} 是空的`)
      }
    }
  })

  test('★ 同一条词条两边占位符一致（否则界面上会剩下 `{name}` 字面量）', () => {
    for (const [id, entry] of Object.entries(webText)) {
      assert.deepEqual(
        placeholdersOf(entry.en),
        placeholdersOf(entry.zh),
        `${id} 的占位符两边不一致`,
      )
    }
  })

  test('键名沿用「区域.用途」的形状，且英文侧不残留中文', () => {
    for (const [id, entry] of Object.entries(webText)) {
      assert.match(id, /^[a-z]+\.[a-zA-Z0-9]+$/, `${id} 的键名形状不对`)
      assert.doesNotMatch(entry.en, /[\u4e00-\u9fa5]/, `${id} 的英文里还有中文`)
    }
  })

  test('渲染：插值、缺键、缺语言三种情形的行为都是确定的', () => {
    const catalog = {
      'x.greet': { zh: '你好 {name}', en: 'Hello {name}' },
      'x.partial': { zh: '只有中文', en: '' },
    }
    assert.equal(renderText(catalog, 'x.greet', 'en', { name: 'Ada' }), 'Hello Ada')
    assert.equal(renderText(catalog, 'x.greet', 'zh', { name: 'Ada' }), '你好 Ada')
    // 缺键 ⇒ 返回**键名**（看得见、好排查），而不是抛异常让整页白屏
    assert.equal(renderText(catalog, 'x.nope', 'en'), 'x.nope')
    // 英文空 ⇒ 退回默认语言，而不是显示空字符串
    assert.equal(renderText(catalog, 'x.partial', 'en'), '只有中文')
    // 参数没给 ⇒ 原样留下占位符（不编一个值）
    assert.equal(renderText(catalog, 'x.greet', 'en'), 'Hello {name}')
  })

  test('语言名用各自的语言写（切换器里必须两种语言的人都找得到）', () => {
    assert.equal(LOCALE_LABEL.zh, '中文')
    assert.equal(LOCALE_LABEL.en, 'English')
    assert.equal(isLocale('en'), true)
    assert.equal(isLocale('fr'), false)
    assert.equal(isLocale(null), false)
  })
})
