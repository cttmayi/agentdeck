import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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

/**
 * ══════════════════════════════════════════════════════════════════
 * 词条的**死活**：每个词条都要有使用者（分批第 11 批）
 * ══════════════════════════════════════════════════════════════════
 *
 * 为什么要有这一条：本仓库最常见的缺陷是"字段/接口/界面都在，就是没有代码路径让它发生"。
 * 词表是它最 slippery 的一种——删了界面上一句话，词条留在词典里，**没有任何东西会红**：
 * 类型还在、zh/en 还齐、占位符还对。下一个读代码的人看到 `crystallize.auditRefresh`
 * 会以为"有个刷新按钮"，而那个按钮早就没了。
 *
 * ⚠️ 判据必须**两条**（第一版只有第 ① 条，量出 184 个"死词条"，其中约 120 个是假的）：
 *   ① 源码里出现这个名字（字面量用法）；
 *   ② 或者它落在**动态拼出来的命名空间**里——界面上有
 *      `` $t(`term.conclusion.${v.conclusion}`) `` 这种写法（状态 / 枚举值直接拼），
 *      这类词条**没有字面量**，是"扫不到"而不是"没人用"。把两者混为一谈，
 *      结果是删掉一批正在界面上的词条（那比留着死词条严重得多）。
 *   另一处假阳性来自**只扫了一个前端**：远端管理页的界面源码在 `apps/remote/web/src/`
 *   （不在 `apps/remote/src/`），只扫后者会把整个 `remote.*` 判死。
 */

/** 扫出来的源码全文 + 由它推出的动态命名空间前缀。 */
interface DeadKeyScan {
  dead: string[]
  dynamicPrefixes: string[]
}

/**
 * 纯函数：给定"全部词条键"与"全部源码全文"，返回**没有任何使用者**的那些。
 *
 * 抽成纯函数是为了能用夹具单独量它准不准（见下一条用例）——
 * 一个判据如果在真仓库上跑绿，可能只是因为它什么都没扫到。
 */
export function findDeadKeys(input: {
  keys: readonly string[]
  sources: readonly string[]
  /**
   * 允许"暂时没有使用者"的键（**每一条都要写清为什么**）。
   *
   * 现在为空。留着这个口子是因为将来可能出现"界面还没接、但词条先定稿"的正当情况；
   * 一旦有人往这里加东西，他必须写下理由，而理由会出现在 review 里。
   */
  allowed?: readonly string[]
}): DeadKeyScan {
  const body = input.sources.join('\n')
  // `` `ns.prefix.${x}` ``：动态拼接的命名空间（只取"名字里带点的前缀"）
  const dynamicPrefixes = [
    ...new Set([...body.matchAll(/`([A-Za-z0-9_.]+\.)\$\{/g)].map((m) => m[1] as string)),
  ]
  const allowed = new Set(input.allowed ?? [])
  const dead = input.keys.filter(
    (k) =>
      !allowed.has(k) &&
      !body.includes(k) &&
      !dynamicPrefixes.some((prefix) => k.startsWith(prefix)),
  )
  return { dead, dynamicPrefixes }
}

/** 扫仓库源码（**不含**词典自身、测试、构建产物）。 */
function collectSources(): { files: string[]; texts: string[] } {
  const ROOTS = ['apps', 'packages', 'tools']
  const EXTS = ['.ts', '.svelte', '.mjs', '.js']
  const root = process.cwd()
  const files: string[] = []
  const texts: string[] = []
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) {
        // 构建产物与依赖目录里的副本会把**每一个**词条都扫成"有人用"⇒ 判据失效
        if (['node_modules', 'dist', '.cache', '.git', 'build'].includes(e.name)) continue
        walk(full)
        continue
      }
      if (!EXTS.some((x) => e.name.endsWith(x))) continue
      if (e.name.includes('.test.')) continue
      // 词典自身（含本文件所在的包）不算使用者：它的 zh/en 正文里当然有这个名字
      if (full.startsWith(`${root}/packages/i18n/`)) continue
      files.push(full.slice(root.length + 1))
      texts.push(readFileSync(full, 'utf8'))
    }
  }
  for (const r of ROOTS) walk(`${root}/${r}`)
  return { files, texts }
}

/**
 * ★ 分批第 54 批：**同一个东西只许有一个词**。
 *
 * 使用者按「沉淀审核 / 审核沉淀 / skill 审核」三个名字看同一件事，会以为它们是
 * 三样不同的东西（与上一批「指令 / 身份」同一类毛病）。这一组把它钉死：
 *
 *   · 角色徽标（界面）= 「沉淀审核」
 *   · 设置里那个开关          = 「沉淀审核」
 *   · 服务端拒绝文案          = 「沉淀审核」  ← 它在 `apps/daemon/src/server.ts`，
 *     不是词条，所以只能读源码比对；两处一旦漂开，使用者看到的解释和界面就对不上。
 *
 * ⚠️ 只钉**角色叫法**，不钉 agent 的名字：内置那条 agent 的名字是「Skill 审核者（内置）」，
 *    那是**它是谁**（和「起草者（内置）」一对），与"这个角色叫什么"是两件事。
 */
describe('术语一致：同一个角色只许有一个叫法（分批第 54 批）', () => {
  const ROLE_WORD = '沉淀审核'

  test('★★ 角色徽标与设置里的开关用同一个词', () => {
    assert.equal(
      webText['agents.roleSkillReviewer'].zh,
      ROLE_WORD,
      '角色徽标要与设置开关同词（推荐「沉淀审核」）',
    )
    assert.equal(webText['settings.reviewerScriptRun'].zh, ROLE_WORD, '设置开关也要是这个词')
  })

  test('★★★ 服务端拒绝文案里的角色叫法必须与界面一致（两处漂开就说不到一起）', () => {
    // ⚠️ 路径要从**仓库根**算：`import.meta.url` 在 `packages/i18n/src/` 下，
    //    第一版写成 `../../apps/...` 指到了 `packages/apps/...`（ENOENT，红了才发现）。
    const source = readFileSync(new URL('../../../apps/daemon/src/server.ts', import.meta.url), 'utf8')
    assert.ok(
      source.includes(`if (role === 'skill-reviewer') return '「${ROLE_WORD}」'`),
      `server.ts 的 roleRejectionLabel 必须用「${ROLE_WORD}」，与界面同一个词`,
    )
    // 判据只针对**代码里真的返回的那一句**：注释里记"原来是 skill 审核"是历史，留着有用
    assert.ok(
      !source.includes("return '「skill 审核」'"),
      '旧的「skill 审核」不许再作为拒绝文案返回（同一个角色三个词就是这么来的）',
    )
  })

  test('★★ 旧词「审核沉淀」在生产代码里不许再出现（文档里的历史记录除外）', () => {
    const old = '审核沉淀'
    const offenders: string[] = []
    const walk = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'web') continue
        const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
        if (entry.isDirectory()) {
          if (entry.name === 'web') continue
          walk(child)
          continue
        }
        if (!/\.[cm]?tsx?$|\.svelte$/.test(entry.name)) continue
        const text = readFileSync(child, 'utf8')
        if (text.includes(old)) offenders.push(child.pathname)
      }
    }
    // 仓库根的 `apps/` 与 `packages/`（i18n 自己在 packages/i18n/src 下，往上三层）
    walk(new URL('../../../apps/', import.meta.url))
    walk(new URL('../', import.meta.url))
    assert.deepEqual(
      offenders.filter((f) => !f.endsWith('i18n.test.ts')),
      [],
      `这些文件里还有旧词「${old}」：${offenders.join('、')}`,
    )
  })
})

describe('词条死活：每个词条都要有使用者（分批第 11 批）', () => {
  test('★ 判据本身准不准：夹具里"用到的 / 动态拼的 / 真没用的"三种', () => {
    const { dead, dynamicPrefixes } = findDeadKeys({
      keys: ['a.used', 'a.alsoUsed', 'b.byStatus.queued', 'b.byStatus.running', 'c.dead'],
      sources: ["$t('a.used')", '$t(`b.byStatus.${status}` as WebTextId)', "// a.alsoUsed 只在注释里出现也算" ],
    })
    assert.deepEqual(dead, ['c.dead'], '只有 c.dead 该被判死')
    assert.deepEqual(dynamicPrefixes, ['b.byStatus.'], '动态命名空间要被认出来（它没有字面量）')
    // ⚠️ 这条是"判据会不会全判死"的自检：一个都没用过的源码 ⇒ 全死
    const all = findDeadKeys({ keys: ['a.used', 'c.dead'], sources: ['const x = 1'] })
    assert.deepEqual(all.dead, ['a.used', 'c.dead'], '扫不到就是全死（这才是"没扫到"的样子）')
    // 白名单要生效（否则那个口子是个摆设）
    const allowed = findDeadKeys({ keys: ['c.dead'], sources: [], allowed: ['c.dead'] })
    assert.deepEqual(allowed.dead, [])
  })

  test('★ 仓库里没有死词条（每个键都能找到使用者，含动态拼接的命名空间）', async () => {
    const sources = collectSources()
    assert.ok(sources.files.length > 100, `源码文件扫得太少（${sources.files.length} 个）⇒ 扫描逻辑坏了`)
    assert.equal(
      sources.files.filter((f) => f.includes('/dist/')).length,
      0,
      '构建产物必须排除（它含全部词条 ⇒ 判据会变成永远绿）',
    )

    const keys: string[] = []
    for (const ns of NAMESPACES) {
      const catalog = await loadCatalogs(ns.dir)
      for (const { catalog: table } of catalog) keys.push(...Object.keys(table))
    }
    assert.ok(keys.length > 1000, `词条只扫到 ${keys.length} 个 ⇒ 词表没读全`)

    const { dead, dynamicPrefixes } = findDeadKeys({ keys, sources: sources.texts })
    assert.ok(
      dynamicPrefixes.length >= 5,
      `动态命名空间只认出 ${dynamicPrefixes.length} 个 ⇒ 动态那一半判据失效了（会误报一片）`,
    )
    assert.deepEqual(
      dead,
      [],
      '这些词条没有任何代码引用它们——要么把界面接上、要么删掉：\n' + dead.join('\n'),
    )
  })
})
