import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ToolManifest,
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type ActionRef,
  type Tool,
} from '@alpha-helper/protocol'
import { decideReview, isStructuralInvalid } from '../review/pipeline.ts'
import {
  bindParams,
  isToolActionDefinition,
  mergeActionParams,
  resolveActionDefinition,
  resolveAllowedActionsWithTools,
  resolveToolActionDefinition,
  toolActionDefinitions,
  toolActionHints,
  validateActionRefWith,
  validateFixedParams,
  validateOpenParams,
  type ActionFacts,
  type ToolActionDefinition,
} from './tool-actions.ts'
// ⚠️ `ActionValidation` 现在从 `./definition.ts` 导出：D41 把内置动作连同
//    `actions/registry.ts` 一起删了，那个模块里只剩"动作定义的形状"与
//    `validateActionAllowed`（见 `definition.ts` 顶部的说明）。
import { type ActionValidation } from './definition.ts'

/**
 * 工具动作的解析 / 校验（D40）。
 *
 * 这里守的是**安全判断**——"这个动作存不存在""模型给的参数能不能过"
 * "绑定值有没有缺失"。所以每条判据都有一个"必须被拒"的用例：
 * 一个只测"好输入能过"的测试，对着一个永远返回 ok 的实现同样会绿。
 */

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

const WORKSPACE = 'ws-1' as Tool['workspaceId']

function makeTool(
  input: {
    slug?: string
    name?: string
    runtime?: string
    entry?: string
    version?: string | null
    actions?: unknown[]
    files?: Record<string, string>
    source?: 'local' | 'remote'
  } = {},
): Tool {
  const slug = input.slug ?? 'example-note'
  const manifest = ToolManifest.parse({
    schema: 'alpha-helper/tool@1',
    slug,
    name: input.name ?? '示例工具',
    version: input.version === undefined ? '1.0.0' : input.version,
    description: '测试用的包',
    runtime: input.runtime ?? 'node',
    entry: input.entry ?? 'scripts/note.mjs',
    actions: input.actions ?? [
      {
        name: 'append-note',
        summary: '追加一行',
        reversible: true,
        dryRun: 'supported',
        timeoutMs: 10_000,
        params: {
          bound: { dir: { from: 'workdir' } },
          open: { text: { type: 'string', max: 20 } },
        },
      },
    ],
  })

  return {
    id: `tool-${slug}` as Tool['id'],
    workspaceId: WORKSPACE,
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    manifest,
    files: input.files ?? { 'scripts/note.mjs': '// noop\n' },
    docs: '',
    source: input.source ?? 'local',
    sourceRef: input.source === 'remote' ? 'remote:catalog@1.0.0' : 'path:/tmp/example-note',
    createdAt: 1,
    updatedAt: 1,
  }
}

/** 「一个装了包的策略 → 一个动作定义」的常用路径。 */
function define(tools: readonly Tool[], type = 'example-note.append-note'): ToolActionDefinition {
  const definition = resolveToolActionDefinition(type, tools)
  assert.ok(definition, `应当解析到 ${type}`)
  return definition
}

const facts: ActionFacts = {
  issueId: 'issue-7',
  runId: 'run-9',
  workspaceId: String(WORKSPACE),
  workdir: '/work/run-9',
}

// ─────────────────────────────────────────────────────────────
// toolActionDefinitions
// ─────────────────────────────────────────────────────────────

describe('toolActionDefinitions：一个包摊成一组动作（D40）', () => {
  test('动作名是 <slug>.<name>，且带上"谁提供的"', () => {
    const tool = makeTool({
      actions: [
        {
          name: 'append-note',
          summary: '追加一行',
          reversible: true,
          dryRun: 'supported',
          timeoutMs: 10_000,
          params: { bound: { dir: { from: 'workdir' } }, open: {} },
        },
        {
          name: 'clean-notes',
          summary: '删掉记录',
          entry: 'scripts/clean.mjs',
          reversible: false,
          dryRun: 'supported',
          timeoutMs: 10_000,
          params: { bound: {}, open: {} },
        },
      ],
    })

    const definitions = toolActionDefinitions([tool])
    assert.deepEqual(Object.keys(definitions).sort(), [
      'example-note.append-note',
      'example-note.clean-notes',
    ])

    const append = definitions['example-note.append-note']!
    assert.equal(append.type, 'example-note.append-note')
    assert.equal(append.plane, 'local')
    assert.equal(append.executorKey, 'script:example-note')
    assert.equal(append.runtime, 'node')
    assert.equal(append.entry, 'scripts/note.mjs')
    assert.equal(append.timeoutMs, 10_000)
    assert.equal(append.reversible, true)
    assert.equal(append.dryRun, 'supported')
    assert.deepEqual(append.provider, {
      slug: 'example-note',
      toolId: 'tool-example-note',
      name: '示例工具',
      version: '1.0.0',
      source: 'local',
      sourceRef: 'path:/tmp/example-note',
    })

    // 每个动作可以有自己的入口（`clean.mjs`），没写的才落到包级 entry
    assert.equal(definitions['example-note.clean-notes']!.entry, 'scripts/clean.mjs')
    assert.equal(definitions['example-note.clean-notes']!.reversible, false)
  })

  test('没写 timeoutMs 时用清单默认值 60s（协议里的默认不能在这里丢掉）', () => {
    const tool = makeTool({
      actions: [
        {
          name: 'append-note',
          summary: 'x',
          reversible: true,
          dryRun: 'supported',
          params: { bound: {}, open: {} },
        },
      ],
    })
    assert.equal(toolActionDefinitions([tool])['example-note.append-note']!.timeoutMs, 60_000)
  })

  test('describe 是一行能贴在通知里的摘要', () => {
    const definition = define([makeTool()])
    const text = definition.describe({ dir: '/work/x', text: '一句话' })
    assert.match(text, /示例工具/)
    assert.match(text, /example-note\.append-note/)
    assert.match(text, /追加一行/)
    assert.match(text, /dir=\/work\/x/)
  })

  test('同一个 slug 装了两份时先装的赢（不合并、不静默覆盖）', () => {
    const first = makeTool({ name: '先装的' })
    const second = makeTool({ name: '后装的' })
    const definitions = toolActionDefinitions([first, second])
    assert.equal(definitions['example-note.append-note']!.provider.name, '先装的')
  })

  test('没装任何工具 ⇒ 空表', () => {
    assert.deepEqual(toolActionDefinitions([]), {})
  })
})

// ─────────────────────────────────────────────────────────────
// resolveActionDefinition：只认已安装的工具包，找不到就是 null
// ─────────────────────────────────────────────────────────────

describe('resolveActionDefinition：只认已安装的工具包 / 未装即 null', () => {
  test('★ `comment` 不再是保留字：装了那个包就解析到它，解析到的是**装的那个包**', () => {
    // ⚠️ 这条用例原来叫"内置动作不受已安装工具影响"：`comment.create` 当年是
    //    **内置**的裸名，装了同名包也不会被顶掉，所以它还顺手断言了
    //    `isToolActionDefinition(definition) === false`（"内置定义没有 provider"）。
    //
    //    D41 之后**没有内置动作**了，那个断言守的能力已经不在平台里：现在每一份
    //    定义都由工具包摊出来、**都带 provider**。而 `comment` / `issue` / `notify`
    //    也不再是保留字（`RESERVED_TOOL_SLUGS` 随内置动作一起删了）——它们只是
    //    普通包名，"谁装的、装的是什么"就是唯一答案。
    const commentPkg = makeTool({
      slug: 'comment',
      name: '评论工具',
      actions: [
        {
          name: 'create',
          summary: '写一条评论',
          reversible: true,
          dryRun: 'supported',
          params: { bound: {}, open: { body: { type: 'string', max: 200 } } },
        },
      ],
    })
    const definition = resolveActionDefinition('comment.create', [commentPkg])
    assert.ok(definition)
    assert.equal(definition.type, 'comment.create')
    assert.equal(definition.provider.slug, 'comment', '定义来自**装的那个包**，不是内置定义')
  })

  test('第三方动作：装了这个包就能解析到', () => {
    const definition = resolveActionDefinition('example-note.append-note', [makeTool()])
    assert.ok(definition)
    assert.equal(isToolActionDefinition(definition), true)
  })

  test('★ 包没装 ⇒ null（调用方按"未知动作类型"处理）', () => {
    assert.equal(resolveActionDefinition('other-note.append-note', [makeTool()]), null)
  })

  test('★ 包装了但没有声明这个动作 ⇒ null', () => {
    assert.equal(resolveActionDefinition('example-note.delete-everything', [makeTool()]), null)
  })

  test('形状不对的名字不解析（D41 之后不存在"裸名"这一说了）', () => {
    // `deploy.production` 的形状是**合法**的（它就是 `<包 slug>.<动作名>`），
    // 只是这个工作区没装 `deploy` 包；`Example.Append` 连形状都不合法。
    // 两者都不是可用动作。原来这条还兼着"内置裸名不在这里解析"的意思——
    // 裸名已经不是一个概念了（每个动作名都必须带包 slug）。
    assert.equal(resolveActionDefinition('deploy.production', [makeTool()]), null)
    assert.equal(resolveActionDefinition('Example.Append', [makeTool()]), null)
  })
})

// ─────────────────────────────────────────────────────────────
// bindParams
// ─────────────────────────────────────────────────────────────

describe('bindParams：按事实算绑定值，缺什么就说清缺什么', () => {
  const allSources = (): ToolActionDefinition =>
    define([
      makeTool({
        actions: [
          {
            name: 'append-note',
            summary: 'x',
            reversible: true,
            dryRun: 'supported',
            params: {
              bound: {
                issue: { from: 'subject.issueId' },
                run: { from: 'subject.runId' },
                ws: { from: 'workspace.id' },
                dir: { from: 'workdir' },
                confirm: { from: 'literal', value: 'yes' },
              },
              open: {},
            },
          },
        ],
      }),
    ])

  test('五种来源都按事实取值，literal 取清单里的值', () => {
    const result = bindParams(allSources(), facts)
    assert.ok(result.ok)
    assert.deepEqual(result.params, {
      issue: 'issue-7',
      run: 'run-9',
      ws: String(WORKSPACE),
      dir: '/work/run-9',
      confirm: 'yes',
    })
  })

  test('★ subject 不是 issue ⇒ 说清是"subject 不是 issue"，且**不塞空串**', () => {
    const result = bindParams(allSources(), { ...facts, issueId: null })
    assert.equal(result.ok, false)
    assert.ok(!result.ok)
    assert.equal(result.issues.length, 1)
    assert.match(result.issues[0]!, /subject\.issueId/)
    assert.match(result.issues[0]!, /subject 不是 issue/)
    assert.doesNotMatch(result.issues[0]!, /：\s*$/)
  })

  test('★ 没有工作目录 ⇒ 明确失败（而不是把 dir 绑成空串）', () => {
    const result = bindParams(allSources(), { ...facts, workdir: null })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /workdir/)
    assert.match(result.issues[0]!, /工作目录/)
  })

  test('★ 没有关联 run ⇒ 明确失败', () => {
    const result = bindParams(allSources(), { ...facts, runId: null })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /subject\.runId/)
  })

  test('不需要绑定参数的动作用任何事实都能算出来', () => {
    const definition = define([
      makeTool({
        actions: [
          {
            name: 'append-note',
            summary: 'x',
            reversible: true,
            dryRun: 'supported',
            params: { bound: {}, open: { text: { type: 'string', max: 5 } } },
          },
        ],
      }),
    ])
    const result = bindParams(definition, { ...facts, workdir: null, runId: null, issueId: null })
    assert.ok(result.ok)
    assert.deepEqual(result.params, {})
  })
})

// ─────────────────────────────────────────────────────────────
// validateOpenParams
// ─────────────────────────────────────────────────────────────

describe('validateOpenParams：模型给的参数逐项严格校验', () => {
  const definition = define([
    makeTool({
      actions: [
        {
          name: 'append-note',
          summary: 'x',
          reversible: true,
          dryRun: 'supported',
          params: {
            bound: { dir: { from: 'workdir' } },
            open: {
              text: { type: 'string', max: 5 },
              mode: { type: 'enum', values: ['fast', 'safe'] },
              count: { type: 'integer', min: 1, max: 10 },
              flag: { type: 'boolean' },
              note: { type: 'string', max: 10, required: false },
            },
          },
        },
      ],
    }),
  ])

  test('全部合规 ⇒ ok', () => {
    const result = validateOpenParams(definition, {
      text: '你好',
      mode: 'fast',
      count: 3,
      flag: true,
    })
    assert.deepEqual(result, { ok: true })
  })

  test('★ 未知键一律拒（**绑定参数名也算未知键**——这是"模型改不了绑定值"的那道门）', () => {
    const result = validateOpenParams(definition, { text: 'x', mode: 'fast', count: 1, flag: true, dir: '/etc' })
    assert.ok(!result.ok)
    assert.match(result.issues.join('\n'), /动作参数 dir/)
    assert.match(result.issues.join('\n'), /没有这个参数/)
  })

  test('★ required 缺失 ⇒ 拒', () => {
    const result = validateOpenParams(definition, { mode: 'fast', count: 1, flag: true })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /动作参数 text/)
    assert.match(result.issues[0]!, /必填/)
  })

  test('★ 字符串超 max ⇒ 拒，且说清上限与实际长度', () => {
    const result = validateOpenParams(definition, { text: '123456', mode: 'fast', count: 1, flag: true })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /最多 5 个字符，实际 6 个/)
  })

  test('★ 枚举不在 values 里 ⇒ 拒，并列出允许的取值', () => {
    const result = validateOpenParams(definition, { text: 'x', mode: 'slow', count: 1, flag: true })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /允许：fast、safe/)
  })

  test('★ 整数越界 / 不是整数 ⇒ 拒', () => {
    const over = validateOpenParams(definition, { text: 'x', mode: 'fast', count: 99, flag: true })
    assert.ok(!over.ok)
    assert.match(over.issues[0]!, /超出允许范围 1\.\.10，实际 99/)

    const float = validateOpenParams(definition, { text: 'x', mode: 'fast', count: 1.5, flag: true })
    assert.ok(!float.ok)
    assert.match(float.issues[0]!, /必须是整数/)
  })

  test('类型不对（字符串 / 布尔 / 数组）⇒ 拒', () => {
    const bad = validateOpenParams(definition, { text: 7, mode: 'fast', count: 1, flag: 'yes' })
    assert.ok(!bad.ok)
    const all = bad.issues.join('\n')
    assert.match(all, /动作参数 text：必须是字符串/)
    assert.match(all, /动作参数 flag：必须是 true 或 false/)
  })

  test('required: false 的参数不给也过；给了就照样校验', () => {
    assert.deepEqual(
      validateOpenParams(definition, { text: 'x', mode: 'fast', count: 1, flag: true, note: undefined }),
      { ok: true },
    )
    const tooLong = validateOpenParams(definition, {
      text: 'x',
      mode: 'fast',
      count: 1,
      flag: true,
      note: 'x'.repeat(11),
    })
    assert.ok(!tooLong.ok)
    assert.match(tooLong.issues[0]!, /动作参数 note/)
  })

  test('null 与"没给"同义：必填参数给 null 报"必填"，不报类型错', () => {
    const result = validateOpenParams(definition, { text: null, mode: 'fast', count: 1, flag: true })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /必填/)
  })

  test('★ 错误文案带 `动作参数 ` 前缀 —— pipeline 靠它把"模型手误"判成可重试', () => {
    const result = validateOpenParams(definition, {})
    assert.ok(!result.ok)
    for (const issue of result.issues) assert.match(issue, /^动作参数 /)
  })

  test('没有开放参数的动作：给任何参数都拒', () => {
    const strict = define([makeTool()])
    const result = validateOpenParams(strict, { text: 'x', extra: 1 })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /可用的开放参数：text/)
  })

  test('★ D43：已固定的参数名被模型写进来 ⇒ 拒，并说"已固定、不需要也不许写"（结构性 invalid）', () => {
    const strict = define([makeTool()])
    const result = validateOpenParams(strict, { text: '模型想写' }, { text: '平台注入' })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /已由使用者在界面上固定为/)
    assert.match(result.issues[0]!, /不需要、也不许写/)
  })

  test('★ D43：模型没写固定参数 ⇒ 不受影响（只有"写了"才越界）', () => {
    const strict = define([makeTool()])
    assert.deepEqual(validateOpenParams(strict, {}, { text: '平台注入' }), { ok: true })
  })
})

// ─────────────────────────────────────────────────────────────
// mergeActionParams
// ─────────────────────────────────────────────────────────────

describe('mergeActionParams：bound 一定在，且盖不过去的只有它自己', () => {
  test('合并出最终参数：open 的照传，bound 的必定注入', () => {
    const definition = define([makeTool()])
    const merged = mergeActionParams(definition, facts, { text: '一句话' })
    assert.ok(merged.ok)
    assert.deepEqual(merged.params, { text: '一句话', dir: '/work/run-9' })
  })

  test('★ 模型想覆盖绑定值 ⇒ 在 open 校验那一步就被拒（不是"被覆盖掉"）', () => {
    const definition = define([makeTool()])
    const merged = mergeActionParams(definition, facts, { text: 'x', dir: '/etc/passwd' })
    assert.ok(!merged.ok)
    assert.match(merged.issues.join('\n'), /动作参数 dir/)
  })

  test('open 有问题时先报 open 的问题（不先报"工作目录没分配"）', () => {
    const definition = define([makeTool()])
    const merged = mergeActionParams(definition, { ...facts, workdir: null }, { text: 'x'.repeat(50) })
    assert.ok(!merged.ok)
    assert.match(merged.issues[0]!, /动作参数 text/)
  })

  test('绑定值缺失时明确失败', () => {
    const definition = define([makeTool()])
    const merged = mergeActionParams(definition, { ...facts, workdir: null }, { text: 'x' })
    assert.ok(!merged.ok)
    assert.match(merged.issues[0]!, /workdir/)
  })

  test('★ D43：固定参数与绑定值一样**必定注入**（模型给不了、平台钉的必在）', () => {
    const definition = define([makeTool()])
    const merged = mergeActionParams(definition, facts, {}, { text: '平台注入' })
    assert.ok(merged.ok)
    assert.deepEqual(merged.params, { text: '平台注入', dir: '/work/run-9' })
  })

  test('★ D43：模型写固定参数名 ⇒ 在 open 校验那一步就被拒（不是"被覆盖掉"）', () => {
    const definition = define([makeTool()])
    const merged = mergeActionParams(definition, facts, { text: '模型越界' }, { text: '平台注入' })
    assert.ok(!merged.ok)
    assert.match(merged.issues.join('\n'), /已由使用者在界面上固定为/)
  })
})

// ─────────────────────────────────────────────────────────────
// validateActionRefWith
// ─────────────────────────────────────────────────────────────

describe('validateActionRefWith：先判类型，再判参数，最后连绑定值一起判', () => {
  const tools = [makeTool()]
  const ref = (type: string, params: Record<string, unknown>): ActionRef =>
    ({ type, params }) as unknown as ActionRef

  // ⚠️ 这里原来有一条「★ 内置动作走既有实现，结果逐字相同」：它把
  //    `validateActionRefWith(ref, { tools })` 的结果与内置那版
  //    `validateActionRef(ref)` 逐字对比，钉住"内置动作的参数校验与 D40 之前
  //    一字不差"。D41 把内置动作连同 `validateActionRef`/注册表一起删了，
  //    所以那条用例守的能力（"内置动作的参数校验没被改动"）已经不存在，
  //    删掉而不是改写成别的断言——现在**每一份**动作定义都来自工具包，
  //    参数校验只有 `validateOpenParams` / `mergeActionParams` 这一条路，
  //    它们的用例就在下面几节。

  test('第三方动作 + 合规的开放参数 + 完整事实 ⇒ ok', () => {
    assert.deepEqual(
      validateActionRefWith(ref('example-note.append-note', { text: '一句话' }), { tools, facts }),
      { ok: true },
    )
  })

  test('★ 包没装 ⇒ 一条带 `未知动作类型` 的错（结构性 invalid，不让模型重试）', () => {
    const result = validateActionRefWith(ref('other-note.append-note', { text: 'x' }), { tools, facts })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /^未知动作类型：other-note\.append-note/)
    assert.match(result.issues[0]!, /没有装/)
  })

  test('包装了但没这个动作 ⇒ 说清是"包里没有这个动作"', () => {
    const result = validateActionRefWith(ref('example-note.nope', {}), { tools, facts })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /没有声明这个动作/)
  })

  test('形状不对（大写 / 缺动作名）⇒ 也报未知动作类型', () => {
    for (const type of ['Example-Note.Append', 'example-note.', 'nope']) {
      const result = validateActionRefWith(ref(type, {}), { tools, facts })
      assert.ok(!result.ok, `${type} 应当被拒`)
      assert.match(result.issues[0]!, /未知动作类型/)
    }
  })

  test('★ 开放参数不合法 ⇒ 拒（走的是模型可重试的那条路）', () => {
    const result = validateActionRefWith(ref('example-note.append-note', { text: 'x'.repeat(21) }), {
      tools,
      facts,
    })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /^动作参数 text/)
  })

  test('★ 注入绑定值后再校验：事实缺失（没有工作目录）⇒ 拒', () => {
    const result = validateActionRefWith(ref('example-note.append-note', { text: 'x' }), {
      tools,
      facts: { ...facts, workdir: null },
    })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /workdir/)
  })

  test('不传事实时只校开放参数（并说明这是个部分校验）', () => {
    assert.deepEqual(
      validateActionRefWith(ref('example-note.append-note', { text: 'x' }), { tools }),
      { ok: true },
    )
  })

  test('★ D43：模型把固定参数当 open 填 ⇒ 校验阶段就被拒（"已固定，不要写"）', () => {
    const result = validateActionRefWith(
      ref('example-note.append-note', { text: 'x' }),
      { tools, facts, fixed: { text: '平台注入' } },
    )
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /已由使用者在界面上固定为/)
  })

  test('★ D43：固定参数覆盖了必填项 ⇒ 模型不给它**不算**"必填缺失"（平台注入）', () => {
    // `text` 是 required；被固定后模型正确地不写它，校验必须放行。
    assert.deepEqual(
      validateActionRefWith(
        ref('example-note.append-note', {}),
        { tools, facts, fixed: { text: '平台注入' } },
      ),
      { ok: true },
    )
  })

  test('★ D43：固定参数不覆盖的必填项照旧查（固定"一部分"≠ 放开其余）', () => {
    const result = validateActionRefWith(
      ref('example-note.append-note', {}),
      { tools, facts, fixed: {} },
    )
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /必填，但模型没有给这个参数/)
  })
})

// ─────────────────────────────────────────────────────────────
// 失败分类：动作"不可用"必须不可重试；参数手误才可重试
// ─────────────────────────────────────────────────────────────

describe('★ 三处失败各走哪条 invalid 路（重试有没有意义）', () => {
  const tools = [makeTool()]
  const ref = (type: string, params: Record<string, unknown> = {}): ActionRef =>
    ({ type, params }) as unknown as ActionRef

  /** 判决链把它挂到 `action` 路径上（与 `decideReview` 的写法一致）。 */
  const asIssues = (result: ActionValidation): Array<{ path: string[]; message: string }> =>
    result.ok ? [] : result.issues.map((message: string) => ({ path: ['action'], message }))

  test('包没装 / 包里没声明这个动作 / 形状不对 ⇒ **结构性**（重试只会把同一个名字再写一遍）', () => {
    for (const type of ['other-note.append-note', 'example-note.nope', 'Example-Note.Append']) {
      const issues = asIssues(validateActionRefWith(ref(type), { tools, facts }))
      assert.equal(issues.length, 1, `${type} 应当被拒`)
      assert.equal(
        isStructuralInvalid(issues),
        true,
        `${type} 必须判成结构性（不可重试）：${issues[0]!.message}`,
      )
    }
  })

  test('开放参数写错 ⇒ **不是**结构性（模型下次完全可能写对，要给重试机会）', () => {
    const issues = asIssues(validateActionRefWith(ref('example-note.append-note'), { tools, facts }))
    assert.ok(issues.length > 0)
    assert.equal(
      isStructuralInvalid(issues),
      false,
      `参数问题必须可重试，否则一次手误连重试机会都没有：${issues.map((i) => i.message).join('；')}`,
    )
  })

  test('这条分类是**靠文案前缀**成立的 —— 所以动作类的错不能借用 `动作参数 ` 前缀', () => {
    // 这就是那个坑：`isStructuralInvalid` 先看 `动作参数 ` 前缀（判可重试），
    // 再按路径 `action` 兜底。动作类型类的错一旦带上参数前缀，就会从
    // "结构性 invalid" 悄悄退化成"重试三次还是同一个名字"。
    for (const type of ['other-note.append-note', 'example-note.nope', 'Example-Note.Append']) {
      const issues = asIssues(validateActionRefWith(ref(type), { tools, facts }))
      assert.doesNotMatch(issues[0]!.message, /^动作参数/)
    }
  })

  test('★ D43：模型写**固定参数** ⇒ 结构性（不可重试）：不是手误，是越过了使用者钉下的边界', () => {
    const issues = asIssues(
      validateActionRefWith(ref('example-note.append-note', { text: 'x' }), {
        tools,
        facts,
        fixed: { text: '平台注入' },
      }),
    )
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.message, /^固定参数 text：/, '★ 必须用 `固定参数 ` 前缀，而不是 `动作参数 `')
    assert.doesNotMatch(issues[0]!.message, /^动作参数/)
    assert.equal(
      isStructuralInvalid(issues),
      true,
      `★ 固定参数被模型写了，重试只会再写一遍 ⇒ 必须结构性：${issues[0]!.message}`,
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 契约里的第三方动作说明
// ─────────────────────────────────────────────────────────────

describe('toolActionHints：写进判决契约的那几行（D40）', () => {
  test('白名单里的已安装动作 ⇒ 一行说明（名字 + 摘要 + 模型该填的参数）', () => {
    const hints = toolActionHints(['example-note.append-note'], [makeTool()])
    assert.equal(hints.length, 1)
    assert.equal(hints[0]!.type, 'example-note.append-note')
    assert.match(hints[0]!.summary, /追加一行/)
    assert.deepEqual(hints[0]!.openParams, ['text'])
  })

  test('★ 绑定参数**绝不出现**在契约里（写进去只会诱导模型去填，然后被拒）', () => {
    const hints = toolActionHints(['example-note.append-note'], [makeTool()])
    assert.equal(hints[0]!.openParams.includes('dir'), false, 'bound 参数不能出现在契约里')
  })

  test('★ 只有"白名单 ∩ 已安装"才会出现：没装 / 包里没这个动作名 / 形状不对都不列', () => {
    const tools = [makeTool()]
    assert.deepEqual(toolActionHints(['ghost-pkg.do-thing'], tools), [])
    assert.deepEqual(toolActionHints(['example-note.nope'], tools), [])
    // ⚠️ D41：`comment.create` 原来是**内置动作**（"白名单里的内置动作不列进
    //    第三方那一节"）。现在没有内置动作了，它只是一个**形状合法、但对应
    //    的包没装**的动作名——行为一样（找不到定义就跳过），理由换了。
    assert.deepEqual(toolActionHints(['comment.create'], tools), [])
    assert.deepEqual(toolActionHints(['comment.create', 'Example-Note.Append'], tools), [])
  })

  test('没装任何工具 ⇒ 契约里没有第三方动作那一节', () => {
    assert.deepEqual(toolActionHints(['example-note.append-note'], []), [])
  })

  test('多个已安装包的动作按白名单顺序排（契约稳定，便于人核对）', () => {
    const other = makeTool({
      slug: 'lint-note',
      name: '另一个包',
      actions: [
        {
          name: 'check',
          summary: '检查一遍',
          reversible: true,
          dryRun: 'supported',
          params: { bound: {}, open: { path: { type: 'string', max: 10 } } },
        },
      ],
    })
    const hints = toolActionHints(
      ['example-note.append-note', 'lint-note.check'],
      [makeTool(), other],
    )
    assert.deepEqual(
      hints.map((h) => h.type),
      ['example-note.append-note', 'lint-note.check'],
    )
    assert.deepEqual(hints[1]!.openParams, ['path'])
  })

  test('★ D43：固定参数从 openParams 里**减去**、单独列成 fixedParams（模型不用填、写了会被拒）', () => {
    const hints = toolActionHints(
      ['example-note.append-note'],
      [makeTool()],
      { 'example-note.append-note': { text: '已钉的值' } },
    )
    assert.equal(hints.length, 1)
    assert.deepEqual(hints[0]!.openParams, [], '固定参数不能再让模型填')
    assert.deepEqual(hints[0]!.fixedParams, [{ name: 'text', value: '已钉的值' }])
  })

  test('★ D43：没固定的动作照旧全量列 open 参数（fixedByType 只影响列出来的那份）', () => {
    const hints = toolActionHints(['example-note.append-note'], [makeTool()], {})
    assert.deepEqual(hints[0]!.openParams, ['text'])
    assert.equal(hints[0]!.fixedParams, undefined)
  })

  test('★ D43：只固定了一部分参数 ⇒ 剩下那些照旧列给模型', () => {
    const tool = makeTool({
      actions: [
        {
          name: 'append-note',
          summary: '追加一行',
          reversible: true,
          dryRun: 'supported',
          params: {
            bound: { dir: { from: 'workdir' } },
            open: {
              text: { type: 'string', max: 20 },
              level: { type: 'enum', values: ['info', 'warn'] },
            },
          },
        },
      ],
    })
    const hints = toolActionHints(
      ['example-note.append-note'],
      [tool],
      { 'example-note.append-note': { level: 'warn' } },
    )
    assert.deepEqual(hints[0]!.openParams, ['text'], '没固定的参数照旧列出来')
    assert.deepEqual(hints[0]!.fixedParams, [{ name: 'level', value: 'warn' }])
  })
})

// ─────────────────────────────────────────────────────────────
// validateFixedParams（D43）：保存 agent / 提交 run 时的写入口守卫
// ─────────────────────────────────────────────────────────────

describe('validateFixedParams：对"使用者在界面上设的固定参数"的守卫（D43）', () => {
  const definition = define([makeTool()])

  test('全是 open 参数且值合规 ⇒ ok', () => {
    assert.deepEqual(validateFixedParams(definition, { text: '一句话' }), { ok: true })
  })

  test('★ 绑定参数名 ⇒ 拒（固定参数只能钉 open；bound 是平台按事实注入的）', () => {
    const result = validateFixedParams(definition, { dir: '/tmp/x' })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /动作参数 dir/)
    assert.match(result.issues[0]!, /不归使用者钉/)
  })

  test('★ 值不合规（超上限 / 不是枚举值）⇒ 拒——与模型填**同一套**取值判据', () => {
    const result = validateFixedParams(definition, { text: 'x'.repeat(21) })
    assert.ok(!result.ok)
    assert.match(result.issues[0]!, /动作参数 text/)
  })

  test('★ 空值（null / undefined）⇒ 拒，并说"删掉这一项"而不是"补一个"', () => {
    for (const value of [null, undefined]) {
      const result = validateFixedParams(definition, { text: value })
      assert.ok(!result.ok)
      assert.match(result.issues[0]!, /固定参数不能是空值/)
    }
  })

  test('★ 不检查 required 缺失：固定"一部分"是合法选择，剩下的留给模型填', () => {
    assert.deepEqual(validateFixedParams(definition, {}), { ok: true })
  })

  test('★ 模型写固定参数的那道闸在这里**不**适用（这是写入口，不是判决校验）', () => {
    // 一个值既是 open、又合规，在写入口就该被收下——判决侧才会判"模型不许写"。
    assert.deepEqual(validateFixedParams(definition, { text: '合规的值' }), { ok: true })
  })
})

// ─────────────────────────────────────────────────────────────
// 与判决链的接法（decideReview 拿到工具清单之后）
// ─────────────────────────────────────────────────────────────

describe('★ 判决链接上工具清单之后：装了的能走、没装的走结构性 invalid', () => {
  const tools = [makeTool()]
  const fence = (obj: unknown): string =>
    `说明\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(obj)}\n${VERDICT_FENCE_END}\n结束`

  const verdictWith = (type: string, params: Record<string, unknown>): Record<string, unknown> => ({
    schemaVersion: 1,
    conclusion: 'pass',
    reasonCode: 'meets_criteria',
    confidence: 0.9,
    findings: [],
    action: { type, params },
    escalateReason: null,
  })

  test('已安装的第三方动作 ⇒ act（判定会真的去执行它）', () => {
    const decision = decideReview({
      output: fence(verdictWith('example-note.append-note', { text: '一句话' })),
      allowedActions: ['example-note.append-note'],
      tools,
      invalidAttempts: 0,
    })
    assert.equal(decision.kind, 'act')
  })

  test('★ 包没装 ⇒ invalid（结构性，不是 retry）', () => {
    const decision = decideReview({
      output: fence(verdictWith('ghost-pkg.do-thing', {})),
      // 白名单里写了也没用：类型**现在不存在**
      allowedActions: ['ghost-pkg.do-thing'],
      tools,
      invalidAttempts: 0,
    })
    assert.equal(decision.kind, 'invalid')
    if (decision.kind !== 'invalid') return
    assert.equal(isStructuralInvalid(decision.issues), true)
    assert.match(decision.issues.map((i) => i.message).join('；'), /未知动作类型/)
  })

  test('★ 包装了但没声明这个动作 ⇒ invalid（同样不可重试）', () => {
    const decision = decideReview({
      output: fence(verdictWith('example-note.nope', {})),
      allowedActions: ['example-note.nope'],
      tools,
      invalidAttempts: 0,
    })
    assert.equal(decision.kind, 'invalid')
  })

  test('★ 包装了但**没写进行动权限** ⇒ invalid，且报错指出去哪儿勾上', () => {
    // ⚠️ 这条断言守两件事：① 装了包不等于授权（白名单是权威，见上面那条用例）；
    //    ② 错误信息**指向审核者的「行动权限」**——使用者唯一能看到的就是这句话，
    //    指错地方（比如还写着"skill"）会让他去 Skills 页翻半天。
    const decision = decideReview({
      output: fence(verdictWith('example-note.append-note', { text: 'x' })),
      allowedActions: [],
      tools,
      invalidAttempts: 0,
    })
    assert.equal(decision.kind, 'invalid')
    if (decision.kind !== 'invalid') return
    const text = decision.issues.map((i) => i.message).join('；')
    assert.match(text, /行动权限/)
    assert.doesNotMatch(text, /skill/, '授权早就不在 skill 上了，报错别再提它')
  })

  test('★ 不传工具清单 ⇒ 带动作的判决一律不可用（不再有"只认内置"那条退路）', () => {
    // D41：`decideReview` 只走 `validateActionRefWith(ref, { tools: input.tools ?? [] })`，
    // 而它离了工具清单**什么都解析不出来**。所以"没给 tools"不再意味着"退回内置动作"
    // （内置动作已经不存在），而是"这个动作名查无实据" ⇒ 结构性 invalid。
    const decision = decideReview({
      output: fence(verdictWith('example-note.append-note', { text: 'x' })),
      allowedActions: ['example-note.append-note'],
      invalidAttempts: 0,
    })
    assert.equal(decision.kind, 'invalid')
    if (decision.kind !== 'invalid') return
    assert.match(decision.issues.map((i) => i.message).join('；'), /未知动作类型/)
  })
})

// ─────────────────────────────────────────────────────────────
// resolveAllowedActionsWithTools
// ─────────────────────────────────────────────────────────────

describe('resolveAllowedActionsWithTools：白名单要看得见已安装的工具', () => {
  test('★ 标准里声明的名字一个都没有对应已安装包 ⇒ 全进 unavailable（D41 的刻意结果）', () => {
    // ⚠️ 这条原来是「标准里声明的内置动作原样保留」：`allowed` 深等于那两个
    //    **内置裸名**、`unavailable` 为空。D41 把内置动作整个删掉之后那一支
    //    不存在了，所以断言按新现实翻过来，而且这个结果是**刻意的**：
    //
    //      · `comment.create` 形状合法（看着就像 `<包 slug>.<动作名>`），但这个
    //        工作区**没有装** `comment` 这个包；
    //      · `issue.add_label` 连形状都不合法（下划线不在允许字符里）。
    //
    //    两者都不是可用动作 ⇒ 都进 `unavailable`。"白名单里写了、包没装"必须
    //    是**不可用**，判决真引用它就走 invalid —— 绝不静默当成"允许"。
    const resolved = resolveAllowedActionsWithTools(['comment.create', 'issue.add_label'], [])
    assert.deepEqual(resolved.allowed, [])
    assert.deepEqual(
      resolved.unavailable.map((u) => u.type),
      ['comment.create', 'issue.add_label'],
    )
    assert.match(resolved.unavailable[0]!.reason, /没有装/, '形状合法但包没装')
    assert.match(resolved.unavailable[1]!.reason, /形状/, '连形状都不对')
  })

  test('★ 标准里写了未安装的动作 ⇒ 进 unavailable（判决引用它就走 invalid）', () => {
    const resolved = resolveAllowedActionsWithTools(
      ['example-note.append-note', 'other-note.append-note'],
      [makeTool()],
    )
    // ⚠️ 只放**声明过的**那一项：装了包不会顺带把它的动作塞进来（未声明即拒绝）。
    //    D41：白名单第一项从内置的 `comment.create` 换成工具动作名——内置动作
    //    已经不存在，白名单里能写的只有 `<包 slug>.<动作名>`。
    assert.deepEqual(resolved.allowed, ['example-note.append-note'])
    assert.equal(resolved.unavailable.length, 1)
    assert.equal(resolved.unavailable[0]!.type, 'other-note.append-note')
    assert.match(resolved.unavailable[0]!.reason, /没有装/)
  })

  test('包装了、但标准写的动作名不在包里 ⇒ 也进 unavailable', () => {
    const resolved = resolveAllowedActionsWithTools(['example-note.nope'], [makeTool()])
    // 白名单里写了一个包里没有的动作名 ⇒ 它就是不可用；包里**真实的**那个动作
    // 也不会因此被顺带放行（两个方向都不许"自动补"）
    assert.deepEqual(resolved.allowed, [])
    assert.match(resolved.unavailable[0]!.reason, /没有声明动作/)
  })

  test('形状不对的名字不会被当成"允许"', () => {
    // `deploy.production` 本身是**合法**形状（它只是没装）；这里要的是
    // 形状就不对的名字：大写、空段、结尾的点。
    for (const type of ['Deploy.production', 'deploy..production', 'deploy.']) {
      const resolved = resolveAllowedActionsWithTools([type], [])
      assert.deepEqual(resolved.allowed, [], `${type} 不该被允许`)
      assert.match(resolved.unavailable[0]!.reason, /形状/)
    }
  })

  test('★ 装了包**不等于**授权：没写进白名单的工具动作一律不准（未声明即拒绝）', () => {
    // ⚠️ 这条断言原来是反过来的（"装了 = 授权这一组"）。那个口径在 D40 收口
    //    之后是错的：`Agent.allowedActions` 是**权威白名单**，而"自动放行"会让
    //    它名存实亡——使用者取消了某个动作，判决却仍然能触发它，症状是
    //    "界面上的勾选不起作用"。这里钉住新口径。
    const resolved = resolveAllowedActionsWithTools([], [makeTool()])
    assert.deepEqual(resolved.allowed, [])
    assert.deepEqual(resolved.unavailable, [], '不是"不可用"，是**没被授权**——两者的话术不同')
  })

  test('不重复：标准里写了、包里也有同一个动作时只出现一次', () => {
    // ⚠️ D41：这条原来在声明的动作名旁边还放了一个**内置**动作（`comment.create`），
    //    当作"已安装的工具动作"之外的另一种来源。内置动作删掉之后白名单里只可能
    //    写工具动作，所以夹具换成一个**声明了两个动作**的包：只有被声明的那一个
    //    进 `allowed`、且只出现一次；包里另一个动作不会被顺带放行（"装了就授权
    //    整组"那段 D40 就删了，见 `resolveAllowedActionsWithTools` 结尾）。
    const pack = makeTool({
      actions: [
        {
          name: 'append-note',
          summary: '追加一行',
          reversible: true,
          dryRun: 'supported',
          params: { bound: {}, open: {} },
        },
        {
          name: 'clean-notes',
          summary: '删掉记录',
          reversible: false,
          dryRun: 'supported',
          params: { bound: {}, open: {} },
        },
      ],
    })
    const resolved = resolveAllowedActionsWithTools(['example-note.append-note'], [pack])
    assert.deepEqual(resolved.allowed, ['example-note.append-note'])
    assert.deepEqual(
      resolved.unavailable,
      [],
      '包里那个没被声明的动作不是"不可用"，是**没被授权**——两者的话术不同',
    )
  })
})
