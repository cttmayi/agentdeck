import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { startDaemon } from './server.ts'
import { SKILL_LIST_SCHEMA } from './skill-list.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * `GET /api/skills/install-list`（本地安装清单接口）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条接口**不联网**
 * ══════════════════════════════════════════════════════════════════
 *
 * 它只读本地那份 JSON、算 slug（见 `skill-list.ts`），不抓 GitHub——真正的下载
 * 发生在使用者点「安装」之后。所以这里的 daemon 用 stub backend、`port: 0`，
 * 不跑真 CLI、不碰网络。
 *
 * 覆盖三件事：**缺省清单能返回**、**`--skills-catalog` 覆盖生效**、**清单坏掉
 * 明确报错（不是给一张空表）**。
 */

async function withDaemon<T>(
  fn: (url: string) => Promise<T>,
  opts: { skillListPath?: string } = {},
): Promise<T> {
  const dir = await makeTempDir('install-list-api')
  const d = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    workRoot: join(dir, 'work'),
    ...(opts.skillListPath ? { skillListPath: opts.skillListPath } : {}),
    backend: {
      key: 'claude',
      protocol: 'stream-json',
      rejectDetectable: true,
      async probe() {
        return { available: false, command: 'claude', cliVersion: null }
      },
      async execute() {
        throw new Error('这个测试不该执行任何 run')
      },
    } as never,
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn(d.url)
  } finally {
    await d.close()
    await cleanup(dir)
  }
}

interface Entry {
  slug: string
  name: string
  source: { kind: 'url' | 'path'; value: string }
}

async function getList(url: string): Promise<{ status: number; entries: Entry[]; skipped: unknown[] }> {
  const res = await fetch(`${url}/api/skills/install-list`)
  const body = (await res.json()) as { entries?: Entry[]; skipped?: unknown[] }
  return { status: res.status, entries: body.entries ?? [], skipped: body.skipped ?? [] }
}

describe('★ 本地安装清单接口', () => {
  test('缺省：返回仓库自带那份清单的条目', async () => {
    await withDaemon(async (url) => {
      const { status, entries } = await getList(url)
      assert.equal(status, 200)
      assert.ok(entries.length > 0, '自带清单不该是空的')
      for (const e of entries) {
        assert.ok(e.slug, '每条都要有 daemon 算出来的 slug')
        assert.ok(['url', 'path'].includes(e.source.kind))
        assert.ok(e.source.value, '每条都要有一个来源值')
      }
    })
  })

  test('★ `--skills-catalog` 覆盖生效：返回的是指定的那份', async () => {
    const dir = await makeTempDir('install-list-override')
    try {
      const manifest = join(dir, 'custom.json')
      await writeFile(
        manifest,
        JSON.stringify({
          schema: SKILL_LIST_SCHEMA,
          items: [{ name: '自定', url: 'https://github.com/acme/custom-skill' }],
        }),
        'utf8',
      )
      await withDaemon(
        async (url) => {
          const { entries } = await getList(url)
          assert.deepEqual(entries.map((e) => e.slug), ['custom-skill'])
        },
        { skillListPath: manifest },
      )
    } finally {
      await cleanup(dir)
    }
  })

  test('★ 清单本身坏掉 ⇒ 明确报错（500），而不是回一张空表', async () => {
    const dir = await makeTempDir('install-list-broken')
    try {
      const manifest = join(dir, 'broken.json')
      await writeFile(manifest, '{ 这不是 json', 'utf8')
      await withDaemon(
        async (url) => {
          const res = await fetch(`${url}/api/skills/install-list`)
          assert.equal(res.status, 500, '"清单读不了"不该被显示成"清单是空的"')
        },
        { skillListPath: manifest },
      )
    } finally {
      await cleanup(dir)
    }
  })
})
