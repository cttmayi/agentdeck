import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { toolUpdateState, type CatalogToolLike } from './tool-update.ts'

const REMOTE = { slug: 'hello-tool', version: '1.0.0', source: 'remote' }

const catalog = (...tools: CatalogToolLike[]): CatalogToolLike[] => tools

describe('toolUpdateState：什么时候给「更新」按钮', () => {
  it('★ 远端更新 ⇒ 给按钮，而且按钮上写着要更新到哪一版', () => {
    const s = toolUpdateState(REMOTE, catalog({ slug: 'hello-tool', version: '1.0.1' }))
    assert.ok(s)
    assert.equal(s.action, 'update')
    assert.equal(s.labelId, 'install.actionUpdateTo')
    assert.deepEqual(s.labelParams, { version: '1.0.1' })
    // 点下去会**覆盖本地那个包**，所以必须带 overwrite
    assert.equal(s.needsOverwrite, true)
  })

  it('按数字比版本，不是按字符串比（1.10.0 比 1.9.9 新）', () => {
    const s = toolUpdateState(
      { slug: 't', version: '1.9.9', source: 'remote' },
      catalog({ slug: 't', version: '1.10.0' }),
    )
    assert.ok(s)
    assert.deepEqual(s.labelParams, { version: '1.10.0' })
  })

  it('版本一样 ⇒ 不给按钮（没有可更新的东西）', () => {
    assert.equal(
      toolUpdateState(REMOTE, catalog({ slug: 'hello-tool', version: '1.0.0' })),
      null,
    )
  })

  it('★ 远端更旧 ⇒ 不给按钮：那是**往回退**，不该混在「更新」里', () => {
    assert.equal(
      toolUpdateState(REMOTE, catalog({ slug: 'hello-tool', version: '0.9.0' })),
      null,
    )
  })

  it('★ 不是从远端目录装的 ⇒ 不给按钮（同名不等于同一个东西的两版）', () => {
    // 从路径装的包，目录里恰好有个同名条目：点「更新」就是把手上这份悄悄换掉
    assert.equal(
      toolUpdateState(
        { slug: 'hello-tool', version: '1.0.0', source: 'local' },
        catalog({ slug: 'hello-tool', version: '9.9.9' }),
      ),
      null,
    )
  })

  it('目录里没有这个 slug ⇒ 不给按钮', () => {
    assert.equal(toolUpdateState(REMOTE, catalog({ slug: 'other-tool', version: '9.9.9' })), null)
    assert.equal(toolUpdateState(REMOTE, catalog()), null)
  })

  it('目录里那一条没有版本号 ⇒ 不给按钮（没有可比的东西，猜一个就是编）', () => {
    assert.equal(
      toolUpdateState(REMOTE, catalog({ slug: 'hello-tool', version: null })),
      null,
    )
  })

  it('★ 本地没有版本号（装的时候清单就没写）⇒ 不给按钮', () => {
    assert.equal(
      toolUpdateState(
        { slug: 'hello-tool', version: null, source: 'remote' },
        catalog({ slug: 'hello-tool', version: '2.0.0' }),
      ),
      null,
    )
  })

  it('★ 版本号认不出来但两边不一样 ⇒ 给按钮，但按钮上不写版本号（写"更新"）', () => {
    const s = toolUpdateState(
      { slug: 't', version: '2024-05', source: 'remote' },
      catalog({ slug: 't', version: '2024-06' }),
    )
    assert.ok(s)
    assert.equal(s.action, 'update')
    // 「更新」而不是「更新到 2024-06」：我们并不知道它是不是更新
    assert.equal(s.labelId, 'install.actionUpdate')
    // 说明里把两个版本号都给出来，让使用者自己判断
    assert.equal(s.hintId, 'install.updateUnknownHint')
  })

  it('版本号认不出来、而且两边一样 ⇒ 不给按钮', () => {
    assert.equal(
      toolUpdateState(
        { slug: 't', version: 'beta', source: 'remote' },
        catalog({ slug: 't', version: 'beta' }),
      ),
      null,
    )
  })

  it('v 前缀不影响比较（v1.2.3 = 1.2.3）', () => {
    assert.equal(
      toolUpdateState(
        { slug: 't', version: 'v1.2.3', source: 'remote' },
        catalog({ slug: 't', version: '1.2.3' }),
      ),
      null,
    )
  })

  it('缺一段按 0 算（1.0 = 1.0.0）', () => {
    assert.equal(
      toolUpdateState(
        { slug: 't', version: '1.0', source: 'remote' },
        catalog({ slug: 't', version: '1.0.0' }),
      ),
      null,
    )
  })

  it('★ 只认自己那一条：目录里别人更新的版本不会让它给按钮', () => {
    const s = toolUpdateState(
      REMOTE,
      catalog(
        { slug: 'other-tool', version: '99.0.0' },
        { slug: 'hello-tool', version: '1.0.0' },
      ),
    )
    assert.equal(s, null)
  })
})
