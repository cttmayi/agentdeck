import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { CREATE_HASH, VIEWS, hashFor, parseHash } from './route.ts'

/**
 * 路由：地址 ↔ (视图, 建模式, 沉淀页选中)。
 *
 * ⚠️ 这一组测试存在的理由很具体：这几条分支**错了不会报错**——它只是把人送到
 *    另一个页面上。D58 之前没有任何测试碰过这段判据（`view.ts` 里有 `window`，
 *    `node --test` import 不了），所以"未知地址回落哪儿"这种改动只能靠探针隔着
 *    浏览器看，而探针自己也会写错地址（见 D58 那条记录里的 8 条红）。
 */
describe('parseHash', () => {
  it('★ `#/tasks/new` 是建任务那一栏的正规地址', () => {
    assert.deepEqual(parseHash('#/tasks/new'), { view: 'tasks', creating: true, crystallize: null })
  })

  it('★★ `#/new` 是老地址，仍然直达同一个状态（书签不作废）', () => {
    // D58 之前「新建任务」是一整页、侧栏一项，`#/new` 被写进了文档与探针。
    // 改地址时把它丢掉的表现是"那条链接落到列表上"，而没有人会收到任何提示。
    assert.deepEqual(parseHash('#/new'), { view: 'tasks', creating: true, crystallize: null })
  })

  it('★ 两个地址指向**同一个**状态（不是两个视图）', () => {
    assert.deepEqual(parseHash('#/new'), parseHash('#/tasks/new'))
  })

  it('`#/tasks` 只是任务页，不带建模式（否则"看"和"建"永远说不清）', () => {
    assert.deepEqual(parseHash('#/tasks'), { view: 'tasks', creating: false, crystallize: null })
  })

  it('★ 沉淀页：`#/crystallize/<runId>` 落在沉淀视图、带 runId（三轮的正规地址）', () => {
    assert.deepEqual(parseHash('#/crystallize/01M57WHC'), {
      view: 'crystallize',
      creating: false,
      crystallize: { runId: '01M57WHC' },
    })
  })

  it('★★ 旧子路由（`#/chat/crystallize/<runId>`）解析成沉淀视图同一状态（syncRoute 会重定向地址）', () => {
    assert.deepEqual(parseHash('#/chat/crystallize/01M57WHC'), {
      view: 'crystallize',
      creating: false,
      crystallize: { runId: '01M57WHC' },
    })
    assert.deepEqual(parseHash('#/tasks/crystallize/01M57WHC'), {
      view: 'crystallize',
      creating: false,
      crystallize: { runId: '01M57WHC' },
    })
  })

  it('★ `#/crystallize` 只是沉淀页列表，没选中任何一条', () => {
    assert.deepEqual(parseHash('#/crystallize'), {
      view: 'crystallize',
      creating: false,
      crystallize: null,
    })
  })

  it('★★ 未知地址回落「任务」（D58 改的方向：合并之后任务才是主场）', () => {
    for (const bogus of ['', '#', '#/', '#/nope', '#/newtask', '#/tasks/board']) {
      assert.deepEqual(parseHash(bogus), { view: 'tasks', creating: false, crystallize: null }, bogus)
    }
  })

  it('每个视图都认得出自己', () => {
    for (const v of VIEWS) assert.equal(parseHash(`#/${v}`).view, v)
  })

  it('`new` 不在 VIEWS 里（否则"页面有几个"会有两个答案）', () => {
    assert.ok(!(VIEWS as readonly string[]).includes('new'))
  })
})

describe('hashFor', () => {
  it('★ 与 parseHash 是一对：逐项来回都还原得回来', () => {
    for (const v of VIEWS) {
      const round = parseHash(hashFor(v))
      assert.deepEqual(round, { view: v, creating: false, crystallize: null }, v)
    }
    assert.deepEqual(parseHash(hashFor('tasks', { creating: true })), {
      view: 'tasks',
      creating: true,
      crystallize: null,
    })
  })

  it('★ 沉淀页选中地址与 parseHash 是一对（刷新还在、能分享链接的那一页）', () => {
    const round = parseHash(hashFor('crystallize', { crystallize: { runId: '01M57WHC' } }))
    assert.deepEqual(round, {
      view: 'crystallize',
      creating: false,
      crystallize: { runId: '01M57WHC' },
    })
  })

  it('建模式只吐正规那个地址（老地址只进不出）', () => {
    assert.equal(hashFor('tasks', { creating: true }), CREATE_HASH)
  })

  it('★ `creating` 只对「任务」成立（别的视图没有这个状态）', () => {
    assert.equal(hashFor('agents', { creating: true }), '#/agents')
  })

  it('★ `crystallize` 只对沉淀视图成立（别的视图没有这个状态）', () => {
    assert.equal(hashFor('agents', { crystallize: { runId: 'X' } }), '#/agents')
    assert.equal(hashFor('chat', { crystallize: { runId: 'X' } }), '#/chat')
    assert.equal(hashFor('tasks', { crystallize: { runId: 'X' } }), '#/tasks')
    assert.equal(hashFor('skills', { crystallize: { runId: 'X' } }), '#/skills')
  })
})
