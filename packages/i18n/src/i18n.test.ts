import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { LOCALES, LOCALE_LABEL, isLocale } from './locale.ts'
import { placeholdersOf, renderText, type TextCatalog } from './text.ts'
import { remoteText, type RemoteTextId } from './remote/index.ts'
import { webText, type WebTextId } from './web/index.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * 词表自身的守卫（D39）
 * ══════════════════════════════════════════════════════════════════
 *
 * 翻译最容易出的两类错都是**静默**的：漏了英文（英文界面里冒出一句中文）、
 * 占位符不一致（界面上留下一串 `{name}` 字面量）。它们不会报错，只会难看。
 * 所以这两条在这里机械地钉住——加词条的那一刻就会红。
 *
 * ══════════════════════════════════════════════════════════════════
 * 类型层的钉子：`WebTextId` 必须是**字面量联合**
 * ══════════════════════════════════════════════════════════════════
 *
 * `webText` 现在由 `Object.assign({}, ...webTextParts)` 合并而来（让那张清单
 * 成为唯一来源）。这个写法**能**保住字面量键联合，但它不是显而易见的——
 * 一旦 `WebTextId` 退化成 `string`，`$t('agents.typo')` 就不再是编译错误，
 * 而**运行时不会报任何东西**：界面上安静地显示成键名。所以这里反向断言一次：
 * 如果 `WebTextId` 变成 `string`，下面那行 `true` 赋给 `never` 会立刻编译报错。
 */
type AssertLiteralKeys = string extends WebTextId ? never : true

/** 同一条件对**远端管理页**的词表再钉一次（`remoteText` 也可能退化成 string）。 */
type AssertRemoteLiteralKeys = string extends RemoteTextId ? never : true

/**
 * 有词表的**两个前端**。
 *
 * 2026-10 加了第二个前端（远端的技能/工具管理页，跑在 4518 上），它有自己的
 * 命名空间 `remote/`。下面所有守卫**对两者一视同仁**（循环跑两遍），而不是给
 * 新前端再抄一套检查——那种抄法迟早只改一边。
 */
const NAMESPACES = [
  { label: 'daemon 界面', dir: './web/', text: webText as TextCatalog, minTables: 10 },
  { label: '远端管理页', dir: './remote/', text: remoteText as TextCatalog, minTables: 4 },
] as const

/**
 * 把 `web/` 下的每张词表**扫出来**（文件名 → 它导出的那张表）。
 *
 * 为什么动态扫而不是在测试里抄一份清单：清单一旦有两份，"新加一张词表"就会
 * 变成两处要改的地方，而**只改一处不会报错**——这正是 D39 迁移里踩过两次的坑。
 * 每个词表文件按约定只导出一张表（`xxxText`），所以"这个模块里那个对象导出"
 * 就是它。
 */
async function loadCatalogs(
  dirName = './web/',
): Promise<Array<{ file: string; catalog: TextCatalog }>> {
  const dir = new URL(dirName, import.meta.url)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .sort()
  const out: Array<{ file: string; catalog: TextCatalog }> = []
  for (const file of files) {
    const mod = (await import(new URL(`${dirName}${file}`, import.meta.url).href)) as Record<
      string,
      unknown
    >
    const catalogs = Object.entries(mod).filter(
      ([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v),
    )
    assert.equal(catalogs.length, 1, `${file} 应当只导出一张词表，实际有 ${catalogs.length} 个对象导出`)
    out.push({ file, catalog: catalogs[0]![1] as TextCatalog })
  }
  return out
}

describe('D39：界面词表', () => {
  test('★ 词条键仍然是字面量联合（拼错键名必须是编译错误）', () => {
    const pinned: AssertLiteralKeys = true
    const pinnedRemote: AssertRemoteLiteralKeys = true
    assert.equal(pinned && pinnedRemote, true)
  })

  for (const ns of NAMESPACES) {
    test(`★ 每条词条 zh / en 都有，且都非空（${ns.label}）`, () => {
      for (const [id, entry] of Object.entries(ns.text)) {
        for (const locale of LOCALES) {
          const value = entry[locale]
          assert.equal(typeof value, 'string', `${id} 缺 ${locale}`)
          assert.ok(value.trim() !== '', `${id} 的 ${locale} 是空的`)
        }
      }
    })

    test(`★ 同一条词条两边占位符一致（${ns.label}）`, () => {
      for (const [id, entry] of Object.entries(ns.text)) {
        assert.deepEqual(
          placeholdersOf(entry.en),
          placeholdersOf(entry.zh),
          `${id} 的占位符两边不一致`,
        )
      }
    })
  }

  for (const ns of NAMESPACES) {
    test(`键名沿用「区域.用途」的形状，且英文侧不残留中文（${ns.label}）`, () => {
      for (const [id, entry] of Object.entries(ns.text)) {
      // 形状：`区域.用途`，允许更深一层（术语表用 `term.<族>.<值>`，
      // 值里带下划线与点——它们直接来自协议枚举，改一个字母就找不到那条词条）
      // ⚠️ 允许 `-`：`term.evidence.in-range-unverified` 里的值直接来自
      //    协议枚举（RuntimeEvidence），把它改写成驼峰会与代码里那份对不上
        assert.match(id, /^[a-z]+\.[a-zA-Z0-9_.-]+$/, `${id} 的键名形状不对`)
        assert.doesNotMatch(entry.en, /[\u4e00-\u9fa5]/, `${id} 的英文里还有中文`)
      }
    })
  }

  for (const ns of NAMESPACES) {
    test(`★ 合并各表时没有重名的键（${ns.label}）`, async () => {
    // 对象展开的语义是"后者赢"：两张表都定义 `agents.new` 时，先来的那条**静默消失**，
    // 症状只是"某个地方显示成键名"——很难联想到是重名。
    //
    // ⚠️ 各张表**自己从 `web/` 目录里扫出来**（见下面 `loadCatalogs()`），
    //    这里不抄一份文件清单。两份清单的后果很具体：加了表却只改一处时，
    //    要么"检查红着而界面已经坏"，要么"界面坏着而检查绿着"——D39 迁移里
    //    真实踩过两次（两个 agent 各一次）。
      const catalogs = await loadCatalogs(ns.dir)
      const sum = catalogs.reduce((n, c) => n + Object.keys(c.catalog).length, 0)
      assert.equal(
        Object.keys(ns.text).length,
        sum,
        `合并后少了 ${sum - Object.keys(ns.text).length} 条——两张表里有同名的键`,
      )
    })
  }

  for (const ns of NAMESPACES) {
    test(`★ 每个词表文件都被接进来了（${ns.label}）`, async () => {
    // 这条守的是"文件存在但没合并"：新增 `web/xxx.ts` 却忘了写进 `index.ts` 的
    // 展开清单时，合并结果里根本没有它的词条、重名检查也不会红——症状是界面上
    // 某个区域整片显示成键名（`tools.title`），而人只会怀疑"是不是渲染错了"。
    //
    // 做法是**逐文件动态 import，逐条比对**（而不是数个数）：既能抓住"整张表没
    // 接进来"，也能抓住"接了但值不一样"（复制粘贴改了一半的那种）。
      const catalogs = await loadCatalogs(ns.dir)
      assert.ok(
        catalogs.length >= ns.minTables,
        `${ns.dir} 下只找到 ${catalogs.length} 张词表，扫目录的逻辑可能坏了`,
      )
      for (const { file, catalog } of catalogs) {
        const ids = Object.keys(catalog)
        assert.ok(ids.length > 0, `${file} 里一张词表都没有（空表也要么填满、要么别建）`)
        for (const id of ids) {
          const merged = (ns.text as Record<string, { zh: string; en: string } | undefined>)[id]
          assert.ok(
            merged !== undefined,
            `${file} 里的 ${id} 没有出现在合并结果里——把它 import 进 index.ts 并展开`,
          )
          assert.deepEqual(merged, catalog[id], `${file} 的 ${id} 与合并结果里的值不一致`)
        }
      }
    })
  }

  for (const ns of NAMESPACES) {
    test(`★ 词条里不许出现 markdown 记号（\`**\` 与反引号）（${ns.label}）`, () => {
    // 2026-09 全库清扫：18 处词条里带着 `**`，而它们**都是当纯文本渲染**的
    // （`$t(...)` 的返回值直接进文本节点，中间没有 markdown 渲染器），所以使用者
    // 看到的是"会**覆盖**已有那个的内容"——记号跟着一起显示出来了。
    //
    // 这类残留的可怕之处在于**两边都不报错**：中文界面看起来只是"多了两个星号"，
    // 而写词条的人以为自己标了粗体。所以在这里机械地钉死：想强调就用词。
    // 英文侧同样不许——那串星号在英文界面上一样难看。
      // ★ 两种记号一起拦（2026-10）：界面上是**纯文本**渲染，`**加粗**` 与 `` `代码` ``
      //   都会原样显示给使用者。原来只拦了 `**`；加反引号是因为我自己新写的词条里
      //   带了它（`reportingEnabled: false`），而当时的守卫看不见——**守卫漏掉的那类
      //   错误，写的人就一定会犯**。
      for (const [id, entry] of Object.entries(ns.text)) {
        for (const locale of LOCALES) {
          assert.doesNotMatch(entry[locale], /\*\*/, `${id} 的 ${locale} 里带着 markdown 强调号`)
          assert.doesNotMatch(entry[locale], /`/, `${id} 的 ${locale} 里带着反引号（会原样显示）`)
        }
      }
    })
  }

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
