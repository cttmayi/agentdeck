import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **「编排写法」资料与引擎一致**（2026-11，D255）。
 *
 * 起因：D143 把 API 细节写成一份独有技能，并用一条测试钉住"技能正文里每段 ```js 都能被
 * `validateWorkflowCode` 编译通过"——**写进规范里的例子跑不起来**是最坏的一种失真
 * （模型会照着抄）。D255 把这套内容搬成了**资料包**
 * （`docs/material/orchestration/`），所以那条判据要跟着搬家，不能丢：
 *
 *   ① `examples/*.js` 每一份都能编译（只构造不调用）；
 *   ② `api.md` 里每个 ```js 代码块都能编译；
 *   ③ 六个原语的名字在 `api.md` 里一个不少；
 *   ④ 几条"照猜一定写错"的语义真的写在里面（`parallel` 返回数组、把关者要会判、
 *      `reuseOutput`、执行失败抛错、没有 `inline`）。
 *
 * 用哪套校验：与 daemon 采纳时同一条（`checkCandidateCode` 的语法那一关），
 * 名字一栏用示例里自己出现的名字——示例是"示范写法"，引用的名字本来就是占位。
 */

const MATERIAL_ROOT = fileURLToPath(new URL('../../../docs/material/orchestration/', import.meta.url))

async function examples(): Promise<Array<{ name: string; code: string }>> {
  const dir = join(MATERIAL_ROOT, 'examples')
  const names = (await readdir(dir)).filter((n) => n.endsWith('.js')).sort()
  return Promise.all(
    names.map(async (name) => ({ name, code: await readFile(join(dir, name), 'utf8') })),
  )
}

async function apiMd(): Promise<string> {
  return await readFile(join(MATERIAL_ROOT, 'api.md'), 'utf8')
}

/** 从一段代码里抠出 `agent('名字')` 的名字（当"本编排有哪些人"喂给校验）。 */
function namesIn(code: string): Set<string> {
  const out = new Set<string>()
  for (const m of code.matchAll(/agent\(\s*(['"])([^'"]*)\1/g)) out.add(m[2] ?? '')
  return out
}

/** 编译一段代码（只构造不调用）——与引擎/采纳同一个构造路径。 */
function compileError(code: string): string | null {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => unknown
    // eslint-disable-next-line no-new -- 只构造不调用
    return_void(new AsyncFunction('agent', 'gate', 'flow', 'parallel', 'loop', 'route', code))
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 让 lint/TS 知道"构造出来但没用"是刻意的。 */
function return_void(_v: unknown): void {}

describe('编排写法资料（docs/material/orchestration）与引擎一致', () => {
  test('★★ examples/*.js 每一份都能编译，且引用的名字都在自己的 agents 里（示例自洽）', async () => {
    const files = await examples()
    assert.ok(files.length >= 4, `examples 至少 4 份，现在 ${files.length}`)
    for (const f of files) {
      const err = compileError(f.code)
      assert.equal(err, null, `examples/${f.name} 编不过：${err}`)
      // 示例里的人名都是占位，但必须**能在自己的示例里自洽**（有 agent 引用就写清是谁）
      for (const name of namesIn(f.code)) assert.ok(name !== '', `examples/${f.name} 里有空名字`)
    }
  })

  test('★★ api.md 里每个 js 代码块都能编译', async () => {
    const md = await apiMd()
    const blocks = [...md.matchAll(/```(?:js|javascript)\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')
    assert.ok(blocks.length >= 3, `api.md 里应当有至少 3 段可抄的代码，现在 ${blocks.length}`)
    for (const [i, code] of blocks.entries()) {
      const err = compileError(code)
      assert.equal(err, null, `api.md 第 ${i + 1} 段代码编不过：${err}`)
    }
  })

  test('★ 六个原语一个不少，且几条"照猜一定写错"的语义写在里面', async () => {
    const md = await apiMd()
    for (const p of ['agent', 'gate', 'flow', 'parallel', 'loop', 'route']) {
      assert.ok(md.includes(p), `api.md 里缺原语 ${p}`)
    }
    // 这几条是 D143 那条判据原本要守的东西，搬家时一条都不许丢
    assert.ok(/返回.*数组|数组/.test(md), '要写明 parallel 返回的是数组')
    assert.ok(md.includes('判定函数'), '要写明把关者必须能判（判定函数 / gate）')
    assert.ok(md.includes('reuseOutput'), '要写明人把关用 reuseOutput')
    assert.ok(md.includes('抛错'), '要写明执行失败会抛错（不是 done + 错误文本）')
    assert.ok(md.includes('inline'), '要点名"没有 inline 这个原语"')
    // 版本文件也要在（daemon 落盘时写进索引、入库时写进 apiVersion）
    const version = JSON.parse(
      await readFile(join(MATERIAL_ROOT, 'api-version.json'), 'utf8'),
    ) as { version?: unknown }
    assert.equal(typeof version.version, 'string')
  })
})
