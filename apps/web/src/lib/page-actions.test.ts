import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { get } from 'svelte/store'

/**
 * 「这一页的动作」登记表（`page-actions.ts`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这几条值得单独测
 * ══════════════════════════════════════════════════════════════════
 *
 * 这套机制只有一处在**动**：顶栏里紧跟页名的那排按钮。它写坏的样子都不报错，只是
 * "某个按钮不见了 / 多出来一个"，而且**要切着页才看得出来**——手工很难复现：
 *
 * - 按视图存取写错 ⇒ 换页顶栏**空着**（或显示上一页的按钮），取决于销毁与挂载
 *   的顺序。Svelte 换个版本就可能换顺序，所以这里把两种顺序**都测一遍**。
 * - 覆盖写成合并 ⇒ 切一次语言多一排按钮。
 *
 * 逻辑与 DOM 无关，所以在 Node 里直接测（和 `sync.test.ts` 同一个路子）。
 */

const mod = await import('./page-actions.ts')

const action = (id: string, label = id) => ({ id, label, onActivate: () => {} })

beforeEach(() => {
  mod.resetPageActions()
})

describe('★ 页面动作登记：读的一侧只认当前视图', () => {
  test('登记之后，当前视图读得到，且顺序与交上来的一致', () => {
    mod.setPageActions('tasks', [action('list', '列表'), action('board', '看板'), action('refresh', '刷新')])
    const got = mod.actionsFor(get(mod.pageActions), 'tasks')
    assert.deepEqual(
      got.map((a) => a.label),
      ['列表', '看板', '刷新'],
      '顺序就是按钮顺序——它由视图决定，不该被这里打乱',
    )
  })

  test('★ 别的视图登记的内容一个字都不显示（切页不残留的**根**）', () => {
    mod.setPageActions('agents', [action('new', '新建')])
    assert.deepEqual(mod.actionsFor(get(mod.pageActions), 'tasks'), [], '当前是任务页，就不该看到智能体页的按钮')
    assert.equal(mod.actionsFor(get(mod.pageActions), 'agents').length, 1, '它自己的那一页仍然读得到')
  })

  test('没人登记时是空数组，不是 null（顶栏可以直接 each）', () => {
    assert.deepEqual(mod.actionsFor(get(mod.pageActions), 'chat'), [])
    assert.equal(get(mod.pageActions), null)
  })
})

describe('★ 换页：两种销毁/挂载顺序都不能出错', () => {
  test('顺序 A：先卸载旧页（清空），再登记新页', () => {
    mod.setPageActions('tasks', [action('refresh')])
    mod.clearPageActions('tasks')
    mod.setPageActions('tools', [action('install', '安装工具')])
    assert.deepEqual(mod.actionsFor(get(mod.pageActions), 'tools').map((a) => a.id), ['install'])
  })

  test('★★ 顺序 B：新页**先**登记，旧页才卸载——旧页的清理不许把新页清掉', () => {
    mod.setPageActions('tasks', [action('refresh')])
    // 新页挂载（登记）……
    mod.setPageActions('tools', [action('install', '安装工具')])
    // ……旧页这一刻才卸载
    mod.clearPageActions('tasks')
    assert.deepEqual(
      mod.actionsFor(get(mod.pageActions), 'tools').map((a) => a.id),
      ['install'],
      '旧页的清理只该清自己那一份，否则顶栏会在切页后空着',
    )
  })

  test('清理**当前**那一页会真的清掉（卸载之后不留残影）', () => {
    mod.setPageActions('tools', [action('install')])
    mod.clearPageActions('tools')
    assert.deepEqual(mod.actionsFor(get(mod.pageActions), 'tools'), [])
  })
})

describe('★ 同一视图重复登记 = 替换', () => {
  test('切换语言重新登记一次，按钮不会变成两排', () => {
    mod.setPageActions('skills', [action('refresh', '刷新'), action('install', '安装 skill')])
    // 语言变了，视图的 `$:` 重新登记一遍（标签换成英文）
    mod.setPageActions('skills', [action('refresh', 'Refresh'), action('install', 'Install skill')])
    const got = mod.actionsFor(get(mod.pageActions), 'skills')
    assert.equal(got.length, 2, '整体覆盖，不是追加')
    assert.deepEqual(got.map((a) => a.label), ['Refresh', 'Install skill'])
  })

  test('动作可以随状态增减（聊天起草时不再给「新对话」）', () => {
    mod.setPageActions('chat', [action('new', '新对话')])
    mod.setPageActions('chat', [])
    assert.deepEqual(mod.actionsFor(get(mod.pageActions), 'chat'), [])
  })
})
