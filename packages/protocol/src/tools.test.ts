import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  TOOL_MANIFEST_SCHEMA,
  ToolManifest,
  toolActionType,
  toolSlugOfAction,
} from './tools.ts'
import { ActionRefType } from './tools.ts'

/**
 * 工具包格式（D40）。
 *
 * 这份 schema 就是"是不是适配本平台的工具"的判据，所以测试也按判据组织：
 * 每一条**拒绝**都要有对应的用例，否则"格式"只是文档里的一句话。
 */

const base = {
  schema: TOOL_MANIFEST_SCHEMA,
  slug: 'close-issue',
  name: '关闭 issue',
  runtime: 'node',
  entry: 'close.mjs',
  actions: [
    {
      name: 'close',
      summary: '关闭这条 issue 并留一句说明',
      reversible: false,
      dryRun: 'supported',
      params: {
        bound: { id: { from: 'subject.issueId' } },
        open: { note: { type: 'string', max: 4_000 } },
      },
    },
  ],
}

const parse = (patch: Record<string, unknown>) => ToolManifest.safeParse({ ...base, ...patch })

describe('D40：工具包清单', () => {
  test('★ 最小的一份合法清单通过，并补出默认值', () => {
    const r = ToolManifest.safeParse(base)
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues))
    if (!r.success) return
    assert.equal(r.data.version, null)
    assert.equal(r.data.description, '')
    assert.equal(r.data.actions[0]?.timeoutMs, 60_000)
    assert.equal(r.data.actions[0]?.params.open['note']?.required, true)
  })

  test('★ 判据一：schema 版本不认识 ⇒ 拒绝（不做"尽力而为"）', () => {
    const r = parse({ schema: 'agentdeck/tool@2' })
    assert.equal(r.success, false)
  })

  test('★ 判据二：slug 必须 kebab-case（不再保留任何前缀）', () => {
    assert.equal(parse({ slug: 'Close_Issue' }).success, false)
    assert.equal(parse({ slug: '-leading' }).success, false)
    // ⚠️ 这条断言在 D41 反转过来：内置动作删掉之后，`comment` 这类名字**不再
    //    与任何东西撞车**（每个动作名都带包 slug），所以它是合法的包名——
    //    原来那张保留前缀表只会挡住一个正当的名字。
    for (const slug of ['comment', 'issue', 'notify']) {
      assert.equal(parse({ slug }).success, true, `${slug} 现在应当是合法的包名`)
    }
  })

  test('★ 判据三：runtime 必须在白名单里（不给"自己填个命令"的自由）', () => {
    assert.equal(parse({ runtime: 'node' }).success, true)
    assert.equal(parse({ runtime: 'shell' }).success, true)
    assert.equal(parse({ runtime: 'python3' }).success, true)
    assert.equal(parse({ runtime: 'bash -c' }).success, false)
    assert.equal(parse({ runtime: '/usr/bin/node' }).success, false)
  })

  test('★ 判据四：动作名 kebab-case、组内唯一、至少要有一个', () => {
    assert.equal(parse({ actions: [] }).success, false)
    assert.equal(
      parse({
        actions: [
          { name: 'Close', summary: 'x', reversible: true, dryRun: 'supported' },
        ],
      }).success,
      false,
    )
    const dup = parse({
      actions: [
        { name: 'close', summary: 'a', reversible: true, dryRun: 'supported' },
        { name: 'close', summary: 'b', reversible: true, dryRun: 'supported' },
      ],
    })
    assert.equal(dup.success, false)
  })

  test('★ 入口路径不许跑出包外（远端目录给的包是外部输入）', () => {
    assert.equal(parse({ entry: '../../etc/passwd' }).success, false)
    assert.equal(parse({ entry: '/usr/bin/node' }).success, false)
  })

  test('★ 开放参数每一项都必须有界：string 不给无界形态', () => {
    const ok = parse({
      actions: [
        {
          name: 'close',
          summary: 'x',
          reversible: true,
          dryRun: 'supported',
          params: { open: { note: { type: 'string', max: 100 } } },
        },
      ],
    })
    assert.equal(ok.success, true)

    const tooLong = parse({
      actions: [
        {
          name: 'close',
          summary: 'x',
          reversible: true,
          dryRun: 'supported',
          params: { open: { note: { type: 'string', max: 100_000 } } },
        },
      ],
    })
    assert.equal(tooLong.success, false, '上限本身也要有上限，否则等于没界')
  })

  test('★ 同一个参数不许既是 bound 又是 open（否则"模型填不了"被悄悄绕过）', () => {
    const r = parse({
      actions: [
        {
          name: 'close',
          summary: 'x',
          reversible: true,
          dryRun: 'supported',
          params: {
            bound: { id: { from: 'subject.issueId' } },
            open: { id: { type: 'string', max: 10 } },
          },
        },
      ],
    })
    assert.equal(r.success, false)
  })

  test('bound 的来源与取值必须自洽', () => {
    const noValue = parse({
      actions: [
        {
          name: 'close',
          summary: 'x',
          reversible: true,
          dryRun: 'supported',
          params: { bound: { id: { from: 'literal' } } },
        },
      ],
    })
    assert.equal(noValue.success, false, 'literal 必须给 value')

    const strayValue = parse({
      actions: [
        {
          name: 'close',
          summary: 'x',
          reversible: true,
          dryRun: 'supported',
          params: { bound: { id: { from: 'subject.issueId', value: 'x' } } },
        },
      ],
    })
    assert.equal(strayValue.success, false, '非 literal 不许给 value（那会与事实打架）')
  })

  test('未知字段一律拒绝（strict）', () => {
    assert.equal(parse({ extra: 1 }).success, false)
    assert.equal(
      parse({
        actions: [
          { name: 'close', summary: 'x', reversible: true, dryRun: 'supported', shell: 'rm -rf /' },
        ],
      }).success,
      false,
    )
  })
})

describe('D40：动作名的命名空间', () => {
  test('第三方动作名是 <组 slug>.<动作名>', () => {
    assert.equal(toolActionType({ slug: 'close-issue' }, 'close'), 'close-issue.close')
    assert.equal(toolSlugOfAction('close-issue.close'), 'close-issue')
    // ⚠️ D41 之后没有"内置裸名"这个概念：`issue.update_status` 里的下划线
    //    让它**形状不合法**（动作名的两段都是 kebab-case），所以取不到 slug。
    assert.equal(toolSlugOfAction('issue.update_status'), null)
  })

  test('★ 判决里的动作名只接受 `<包 slug>.<动作名>`（D41 起没有内置裸名）', () => {
    for (const t of ['comment.create', 'close-issue.close', 'notify.emit']) {
      assert.equal(ActionRefType.safeParse(t).success, true, t)
    }
    // 形状不合规的一律拒：空段、大写、下划线、**只有一段**（内置裸名已经不存在）
    for (const t of [
      'close-issue.',
      '.close',
      'Close-issue.close',
      'close_issue.close',
      'nope',
      'issue.update_status',
    ]) {
      assert.equal(ActionRefType.safeParse(t).success, false, t)
    }
  })

  test('★ 动作名只有一种形状（D41：没有内置裸名了）', () => {
    // 原来这里断言 `isNamespacedAction('comment.create') === false`（把它当内置名）。
    // 内置动作删掉之后那个函数也不存在了：`comment.create` 现在就是一个**普通的
    // 工具动作名**——前提是它来自一个叫 `comment` 的包。
    assert.equal(toolSlugOfAction('comment.create'), 'comment')
    assert.equal(toolSlugOfAction('notify.emit'), 'notify')
    assert.equal(toolSlugOfAction('nope'), null, '没有包 slug 的名字不是动作名')
  })
})
