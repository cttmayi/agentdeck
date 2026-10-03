import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { renderText, webText, type TextParams, type WebTextId } from '@agentdeck/i18n'
import { catalogEntryState, compareVersions, type CatalogEntryState } from './skill-catalog.ts'

/**
 * 远端目录条目 vs 本地已装 skill 的**状态判定**。
 *
 * 这是纯逻辑，所以能把每种组合都摆出来。它的价值在于：这四种状态的差别
 * 是使用者**唯一**能看到的信号，搞错其中任何一个的后果都不是"界面难看"，
 * 而是"他做了错误的决定"——比如把降级看成更新，或者看到"已安装"就
 * 不再去装一份其实内容不同的东西。
 *
 * ⚠️ D39 起这一层产出的是**文案键 + 插值**（`labelId` / `hintId`）。下面要断言的
 *    仍然是"这句话该怎么说"，所以按 `renderText(..., 'zh')` 渲染出中文后再断言：
 *    迁移前那两句原文（`已安装`、"本地 1.0.0 比目录里的 1.0.0 **更新**"…）一个字
 *    都不能少，否则就是迁移过程中把话改没了。
 */
const zh = (id: WebTextId, params?: TextParams): string =>
  renderText(webText, id, 'zh', params)

/** 渲染按钮上的字（消费方在界面里的做法也是这个：`$t(state.labelId, state.labelParams)`）。 */
const labelOf = (s: CatalogEntryState): string => zh(s.labelId, s.labelParams)

/** 渲染那句说明。 */
const hintOf = (s: CatalogEntryState): string => zh(s.hintId, s.hintParams)

describe('compareVersions', () => {
  test('常见形式能比大小', () => {
    assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
    assert.equal(compareVersions('1.2.0', '1.10.0'), -1, '按数字比，不是按字符串比')
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
    assert.equal(compareVersions('1.0', '1.0.0'), 0, '缺一段按 0 算')
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, '前缀 v 不影响')
  })

  test('★ 两个字符串一样 ⇒ 0，哪怕它不是 x.y.z 的形式', () => {
    // 相等是我们判得了的。不判这一条，下面那条"认不出来 ⇒ null"会让
    // catalogEntryState 把两个**完全相同**的版本号说成「更新」。
    assert.equal(compareVersions('beta', 'beta'), 0)
    assert.equal(compareVersions('2024-05', '2024-05'), 0)
    assert.equal(compareVersions(' 1.0.0 ', '1.0.0'), 0, '两边的空白不算差异')
  })

  test('★ 认不出来就返回 null，而不是猜一个', () => {
    // 目录里的版本是发布者自己写的字符串，不保证是 semver。
    // 猜一个大小会直接变成界面上一句错的"这是更新"。
    for (const v of ['2024-05', 'beta', '1.0.0-rc1', '', 'a.b.c']) {
      assert.equal(compareVersions(v, '1.0.0'), null, v)
    }
  })
})

describe('catalogEntryState', () => {
  const entry = { slug: 'general-review', version: '1.0.0' }

  test('本地没有 ⇒ 安装（不带 overwrite）', () => {
    const s = catalogEntryState(undefined, entry)
    assert.equal(s.action, 'install')
    assert.equal(s.disabled, false)
    assert.equal(s.needsOverwrite, false, '★ 新装绝不能带 overwrite —— 那是"我在覆盖"的确认')
  })

  test('★ 版本一致 ⇒ 已安装，按钮禁用（这就是"版本一致提示已安装"）', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '1.0.0' }, entry)
    assert.equal(s.action, 'installed')
    // 断言的是**渲染出来的那句话**，不是键名：键可以改，话不能变。
    assert.equal(s.labelId, 'install.actionInstalled')
    assert.equal(labelOf(s), '已安装')
    assert.equal(s.disabled, true)
    assert.equal(s.needsOverwrite, false)
    assert.match(hintOf(s), /1\.0\.0/)
  })

  test('★ 目录里是新版本 ⇒ 更新（并显示版本变化）', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '1.0.0' }, {
      slug: 'general-review',
      version: '1.1.0',
    })
    assert.equal(s.action, 'update')
    assert.equal(labelOf(s), '更新到 1.1.0')
    assert.match(labelOf(s), /1\.1\.0/)
    assert.equal(s.disabled, false)
    assert.equal(s.needsOverwrite, true, '更新要覆盖本地那份，所以必须显式确认')
    assert.equal(hintOf(s), '本地 1.0.0 → 目录 1.1.0。')
    assert.match(hintOf(s), /1\.0\.0 → 目录 1\.1\.0/)
  })

  test('★ 本地更新 ⇒ 说清是"往回退"，不许叫更新', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '2.0.0' }, entry)
    assert.equal(s.action, 'downgrade')
    assert.equal(labelOf(s), '退回 1.0.0')
    assert.match(labelOf(s), /退回/)
    assert.match(hintOf(s), /更新/)
    assert.match(hintOf(s), /往回退/)
    assert.equal(s.needsOverwrite, true)
  })

  test('★ 本地有版本但认不出来 ⇒ 当作可更新，但把两个版本号都摆出来', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '2024-05' }, entry)
    assert.equal(s.action, 'update')
    // 认不出新旧时按钮上只写「更新」——**不带版本号**，因为"更新到 1.0.0"
    // 会让这句变成一句我们其实判断不出来的话。
    assert.equal(labelOf(s), '更新')
    assert.match(hintOf(s), /2024-05/)
    assert.match(hintOf(s), /1\.0\.0/)
    assert.match(hintOf(s), /无法判断新旧/, '不能假装知道谁新谁旧')
  })

  test('★ 目录这条**没有版本号**（取不到上游提交）⇒ 两种情形都不许瞎比大小', () => {
    // 2026-10 起推荐清单的版本取自"上游那个目录最近一次提交"，取不到时是 null。
    // null 的含义是**我们不知道**——不是"没有版本"，也不是"版本为空"。
    const noVer = { slug: 'pptx', version: null }

    // ① 本地没有 ⇒ 装，但不能说"目录里有 pptx vxxx"（那会渲染成一个空位）
    const fresh = catalogEntryState(undefined, noVer)
    assert.equal(fresh.action, 'install')
    assert.equal(labelOf(fresh), '安装')
    assert.doesNotMatch(hintOf(fresh), /\s\s/)
    assert.match(hintOf(fresh), /取不到上游提交/)

    // ② 本地有版本 ⇒ **不能**说"已安装"（不知道是不是同一份内容），要么替换要么更新
    const local = { slug: 'pptx', version: 'abc1234' }
    const s = catalogEntryState(local, noVer)
    assert.equal(s.action, 'replace')
    assert.equal(s.needsOverwrite, true)
    assert.equal(s.disabled, false)
    assert.match(hintOf(s), /无法判断是不是同一份内容/)
  })

  test('★ 本地有同名但**没有版本** ⇒ 不能冒充"已安装"，是替换', () => {
    // 从路径/GitHub 装进来的、或者本机自建的，都没有版本。
    // 我们不知道手上这份是不是同一份内容，所以不能替它背书。
    for (const local of [
      { slug: 'general-review' },
      { slug: 'general-review', version: null },
      { slug: 'general-review', source: 'local' },
    ]) {
      const s = catalogEntryState(local, entry)
      assert.equal(s.action, 'replace', JSON.stringify(local))
      assert.equal(labelOf(s), '替换本地同名')
      assert.equal(s.disabled, false)
      assert.equal(s.needsOverwrite, true)
      assert.match(hintOf(s), /没有版本信息/)
    }
  })

  test('本地没有：说清"目录里有这一条、本地还没有"，并带上 slug 与版本', () => {
    const s = catalogEntryState(undefined, entry)
    assert.equal(labelOf(s), '安装')
    assert.equal(hintOf(s), '目录里有 general-review 1.0.0，本地还没有。')
  })

  /**
   * ⚠️ 这条原来断言的是 `…1.0.0 **更新**。…`——那两个星号是 markdown 的粗体记号，
   *    而这句话是**当纯文本渲染**的，所以在界面上它就是两个星号（2026-09 全库
   *    清掉了这类残留）。断言的意图没变：这句中文是默认语言，也是别处（探针、
   *    文档）引用的依据，所以逐字钉住——只是钉的那一份现在不再带记号。
   */
  test('★ 中文那句"往回退"逐字保留（词表里的 zh 是默认语言，也是探针断言的依据）', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '2.0.0' }, entry)
    assert.equal(
      hintOf(s),
      '本地 2.0.0 比目录里的 1.0.0 更新。点下去是往回退，不是更新——确认这是你要的。',
    )
  })

  test('slug 不同不会互相影响（同名才比较）', () => {
    // 调用方负责按 slug 找 local；这里确认"本地没有这个 slug"就是安装
    const s = catalogEntryState({ slug: 'something-else', version: '9.9.9' }, entry)
    assert.equal(s.action, 'install')
  })
})
