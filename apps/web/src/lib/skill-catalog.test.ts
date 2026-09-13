import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { catalogEntryState, compareVersions } from './skill-catalog.ts'

/**
 * 远端目录条目 vs 本地已装 skill 的**状态判定**。
 *
 * 这是纯逻辑，所以能把每种组合都摆出来。它的价值在于：这四种状态的差别
 * 是使用者**唯一**能看到的信号，搞错其中任何一个的后果都不是"界面难看"，
 * 而是"他做了错误的决定"——比如把降级看成更新，或者看到"已安装"就
 * 不再去装一份其实内容不同的东西。
 */

describe('compareVersions', () => {
  test('常见形式能比大小', () => {
    assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
    assert.equal(compareVersions('1.2.0', '1.10.0'), -1, '按数字比，不是按字符串比')
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
    assert.equal(compareVersions('1.0', '1.0.0'), 0, '缺一段按 0 算')
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, '前缀 v 不影响')
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
    assert.equal(s.label, '已安装')
    assert.equal(s.disabled, true)
    assert.equal(s.needsOverwrite, false)
    assert.match(s.hint, /1\.0\.0/)
  })

  test('★ 目录里是新版本 ⇒ 更新（并显示版本变化）', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '1.0.0' }, {
      slug: 'general-review',
      version: '1.1.0',
    })
    assert.equal(s.action, 'update')
    assert.match(s.label, /1\.1\.0/)
    assert.equal(s.disabled, false)
    assert.equal(s.needsOverwrite, true, '更新要覆盖本地那份，所以必须显式确认')
    assert.match(s.hint, /1\.0\.0 → 目录 1\.1\.0/)
  })

  test('★ 本地更新 ⇒ 说清是"往回退"，不许叫更新', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '2.0.0' }, entry)
    assert.equal(s.action, 'downgrade')
    assert.match(s.label, /退回/)
    assert.match(s.hint, /更新/)
    assert.match(s.hint, /往回退/)
    assert.equal(s.needsOverwrite, true)
  })

  test('★ 本地有版本但认不出来 ⇒ 当作可更新，但把两个版本号都摆出来', () => {
    const s = catalogEntryState({ slug: 'general-review', version: '2024-05' }, entry)
    assert.equal(s.action, 'update')
    assert.match(s.hint, /2024-05/)
    assert.match(s.hint, /1\.0\.0/)
    assert.match(s.hint, /无法判断新旧/, '不能假装知道谁新谁旧')
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
      assert.equal(s.disabled, false)
      assert.equal(s.needsOverwrite, true)
      assert.match(s.hint, /没有版本信息/)
    }
  })

  test('slug 不同不会互相影响（同名才比较）', () => {
    // 调用方负责按 slug 找 local；这里确认"本地没有这个 slug"就是安装
    const s = catalogEntryState({ slug: 'something-else', version: '9.9.9' }, entry)
    assert.equal(s.action, 'install')
  })
})
