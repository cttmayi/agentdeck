import assert from 'node:assert/strict'
import { test } from 'node:test'
import { saveGroup } from './stores.ts'

/**
 * 保存**已有的组**时，PATCH 的 body 里不许带 `id`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要专门钉这一条（真实缺陷，2026-10 由布局探针量出来）
 * ══════════════════════════════════════════════════════════════════
 *
 * `saveGroup()` 原来是 `JSON.stringify(input)`——**整份对象连 `id` 一起发**，
 * 而 daemon 对 body 里的未知字段是严格拒收的（"不认识的字段：id。可改的有：
 * name, members, allowedActions, …"）。表现：
 *
 *   · **新建**组走 POST，一直是好的（`id` 那时本来就没有）；
 *   · **编辑**任意一个已有的组、点保存 ⇒ 必然 400 ⇒ 改什么都存不进去。
 *     而界面上看起来只是"点了保存没反应"（红字在页面底部，列表那一行没变），
 *     于是这个不对称能一直躲着——直到探针去量"点「移除」→ 保存 ⇒ **接口上**那条
 *     权限真的没了"，发现接口上那条一直在。
 *
 * ⚠️ 只量"接口有没有变"是**分不清**三种失败的：① 界面根本没发（按钮点错了）
 *    ② 发了但被服务端拒 ③ 发了、也收了，但发出去的那一份还是老值。最后是靠把
 *    `window.fetch` 包一层、看真的发出去的那一份才定位到（探针里也留着这个抓手：
 *    facts 的 `groups.saveRequests` / `groups.saveErrorNotice`）。
 *
 * 这里守着的是**线格式**那一半：id 只出现在路径里，不进 body。
 */

/** 一次请求的记录（只留断言要看的那三样）。 */
type Call = { path: string; method: string; body: string }

/** 打一次桩：把 fetch 换掉，收下每次调用的 path/method/body。 */
async function withFetchStub<T>(
  run: (calls: Call[]) => Promise<T>,
  respond: (call: Call) => unknown,
): Promise<T> {
  const calls: Call[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      path: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    }
    calls.push(call)
    return new Response(JSON.stringify(respond(call)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = realFetch
  }
}

test('改已有的组：PATCH 的 body 里**没有** id（它在路径里；带上去会被 daemon 拒）', async () => {
  const created = { id: 'g1', name: '探针用的编队' }
  await withFetchStub(
    async (calls) => {
      await saveGroup({
        id: 'g1',
        name: '探针用的编队',
        members: ['exec', 'rev'],
        allowedActions: [],
        actionParams: {},
        debugActions: [],
        maxReworks: null,
        enabled: true,
      })
      const patch = calls.find((c) => c.method === 'PATCH')
      assert.ok(patch, '没有发出 PATCH（改已有组的写入口不见了？）')
      assert.equal(patch.path, '/api/agent-groups/g1', 'id 应该只出现在路径里')
      const body = JSON.parse(patch.body) as Record<string, unknown>
      assert.equal('id' in body, false, `PATCH 的 body 里不该有 id：${patch.body}`)
      // 只钉"没有 id"是不够的：把 id 删掉的同时把别的字段也弄丢，是另一种坏法。
      assert.equal(body['name'], '探针用的编队')
      assert.deepEqual(body['members'], ['exec', 'rev'])
      assert.deepEqual(body['allowedActions'], [])
      assert.equal(body['maxReworks'], null)
      assert.equal(body['enabled'], true)
    },
    (call) =>
      call.method === 'GET' ? { groups: [], members: [] } : { group: created },
  )
})

test('新建组：走 POST 到集合路径（这条一直是好的，一起钉住，免得修上面那条时把它弄坏）', async () => {
  await withFetchStub(
    async (calls) => {
      await saveGroup({
        name: '新建的编队',
        members: ['exec', 'rev'],
        allowedActions: [],
        actionParams: {},
        debugActions: [],
        maxReworks: 0,
        enabled: true,
      })
      const post = calls.find((c) => c.method === 'POST')
      assert.ok(post, '没有发出 POST')
      assert.equal(post.path, '/api/agent-groups')
      const body = JSON.parse(post.body) as Record<string, unknown>
      assert.equal('id' in body, false)
      assert.equal(body['name'], '新建的编队')
    },
    (call) => (call.method === 'GET' ? { groups: [], members: [] } : { group: { id: 'g2' } }),
  )
})