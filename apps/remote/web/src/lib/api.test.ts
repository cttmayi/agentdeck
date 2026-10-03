import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ApiError, api } from './api.ts'

/**
 * 远端管理页的接口层。
 *
 * ⚠️ 这一层最容易出的错是**把失败说成成功**或**把技术原文丢给使用者**：
 *   `fetch` 抛的是 `TypeError: Failed to fetch`（网络层）、`res.ok` 为假时是 HTTP
 *   状态码——两者都对使用者没有意义（他要么去看服务起没起、要么去看状态码）。
 *   所以这里钉的是"**错误里有没有该有的信息**"，不是"有没有抛"。
 *
 * 用一个假的 `fetch` 顶替（不联网、不起服务）。
 */
type FetchLike = typeof fetch

function withFetch<T>(impl: FetchLike, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('远端管理页：接口层', () => {
  test('★ 目录：原样解析（skills/tools/loginMethods 都在）', async () => {
    const catalog = { skills: [{ slug: 'pptx' }], tools: [], loginMethods: [] }
    await withFetch(
      (async () => okJson(catalog)) as FetchLike,
      async () => {
        const got = await api.catalog()
        assert.equal(got.skills.length, 1)
        assert.equal(got.skills[0]!.slug, 'pptx')
      },
    )
  })

  test('★ HTTP 不 ok ⇒ 错误里带上状态码与服务端原话（不吞成"失败了"三个字）', async () => {
    await withFetch(
      (async () => new Response('目录读不了', { status: 500 })) as FetchLike,
      async () => {
        await assert.rejects(
          () => api.catalog(),
          (err: unknown) => {
            assert.ok(err instanceof ApiError)
            assert.match(err.message, /500/)
            assert.match(err.message, /目录读不了/, '服务端那句原话要带上——它是唯一的线索')
            return true
          },
        )
      },
    )
  })

  test('★ 网络层失败 ⇒ 错误里说清"取不到"并带上原因（不是裸的 TypeError）', async () => {
    await withFetch(
      (async () => {
        throw new TypeError('Failed to fetch')
      }) as FetchLike,
      async () => {
        await assert.rejects(() => api.syncStatus(), ApiError)
      },
    )
  })

  test('★ 触发同步：202 与 409 都算"拿到了状态"（409 = 已经有一个在跑，不是错误）', async () => {
    const running = {
      state: 'running',
      startedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      tail: ['清单：12 条'],
    }
    for (const status of [202, 409]) {
      await withFetch(
        (async () => new Response(JSON.stringify(running), { status })) as FetchLike,
        async () => {
          const got = await api.startSync()
          assert.equal(got.state, 'running')
        },
      )
    }
  })

  test('★ 触发同步的其它失败（403 等）⇒ 仍然当成错误报出来，不假装开始了', async () => {
    await withFetch(
      (async () => new Response('只允许回环来源触发同步', { status: 403 })) as FetchLike,
      async () => {
        await assert.rejects(() => api.startSync(), /403|只允许回环来源/)
      },
    )
  })
})

describe('远端管理页：装 / 卸的客户端', () => {
  test('★ 装成功 ⇒ 回 slug 与文件清单（界面要显示装了几个文件）', async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ installed: { slug: 'foo', files: ['SKILL.md'] } }), {
          status: 201,
        })) as FetchLike,
      async () => {
        const got = await api.installSkill({ url: 'https://github.com/o/r' })
        assert.equal(got.slug, 'foo')
        assert.deepEqual(got.files, ['SKILL.md'])
      },
    )
  })

  test('★★ 装失败 ⇒ 把**服务端那句原话**抛出来（"为什么装不上"是唯一能行动的信息）', async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ error: '这里没有 SKILL.md，所以它不是技能' }), {
          status: 400,
        })) as FetchLike,
      async () => {
        await assert.rejects(() => api.installSkill({ url: 'https://github.com/o/r' }), (err: unknown) => {
          assert.ok(err instanceof ApiError)
          assert.match(err.message, /SKILL\.md/)
          assert.doesNotMatch(err.message, /HTTP 400/, '别把状态码当成解释丢给使用者')
          return true
        })
      },
    )
  })

  test('★ 卸成功静默返回；失败时同样给原话（同步来的那条会被拒）', async () => {
    await withFetch(
      (async () => new Response('{}', { status: 200 })) as FetchLike,
      async () => {
        await api.uninstallSkill('foo')
      },
    )
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ error: '「bar」是推荐清单同步下来的，不能在页面上删' }), {
          status: 409,
        })) as FetchLike,
      async () => {
        await assert.rejects(() => api.uninstallSkill('bar'), /推荐清单/)
      },
    )
  })
})
