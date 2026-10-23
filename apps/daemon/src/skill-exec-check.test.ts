/**
 * 可执行性定检（分批第 20 批）。
 *
 * 为什么这一份测试值得写细：定检的**价值全在"不许含糊"**上——它一旦把"没查"混进"通过"，
 * 或者把"事实"写成"结论"，审核者拿到的就不再是事实，而是另一份需要判断的东西（那还不如不做）。
 * 所以这里逐条钉住四种状态各自的语义。
 *
 * ⚠️ 两条走过的弯路（都写进断言里，防止有人"顺手简化"回去）：
 *   ① 第一版用 `python3 -m py_compile` 做语法检查 ⇒ 它往**被检目录**里写了
 *      `scripts/__pycache__/`——检查动作改了现场（使用者的草稿目录里就躺着这么一个，
 *      是审核者自己跑出来的）。现在用 `ast.parse`，第一个测试就钉住"检完目录里没多出东西"。
 *   ② 第一版把"解析器不存在"并进 `ok` ⇒ 在没有 python3 的机器上，"脚本语法没问题"是假的。
 *      现在必须 `skipped`，且 Markdown 里要写「**没查**」。
 *
 * ⚠️ 用真 python3 / node / bash（它们是**解析器**，NFR-T-01 禁的是真 agent CLI）。
 *    临时目录在仓库内 `.cache/test-tmp`（`makeTempDir`）。
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  execCheckHasFailure,
  renderExecCheckMarkdown,
  runSkillExecCheck,
  summarizeExecCheck,
} from './skill-exec-check.ts'
import type { ExecCheckItem, ExecCheckReport } from './skill-exec-check.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

let root: string

before(async () => {
  root = await makeTempDir('skill-exec-check')
})

after(async () => {
  await cleanup(root)
})

/** 造一个草稿目录（每次一个独立子目录，测试之间不互相污染）。 */
async function makeSkill(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, name, 'skill')
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true })
    await writeFile(join(dir, rel), body, 'utf8')
  }
  await mkdir(dir, { recursive: true })
  return dir
}

const GOOD_SKILL = [
  '---',
  'name: trace-topic-to-primary-source',
  'description: 当只给了一个可能歧义的名字时用——先解析到唯一标识符再交付。',
  '---',
  '',
  '## When to Use',
  '',
  '只给了一个名字、需要先消歧时。',
  '',
  '## Procedure',
  '',
  '1. 取元信息（`<NAME>` 换成人名）：',
  '',
  '```bash',
  'curl "https://example.org/?q=<NAME>"',
  '```',
  '',
].join('\n')

function find(report: ExecCheckReport, kind: ExecCheckItem['kind']): ExecCheckItem[] {
  return report.items.filter((i) => i.kind === kind)
}

/**
 * 取第一条并**在此断言它存在**。
 *
 * 为什么不在断言里写 `items[0]!.x`：`noUncheckedIndexedAccess` 下那样每处都要感叹号，
 * 而"这一项没出现"恰恰是要报出来的失败（`!` 会把它变成 TypeError，看起来像测试脚本坏了）。
 */
function first(items: ExecCheckItem[], what: string): ExecCheckItem {
  const it = items[0]
  assert.ok(it !== undefined, `定检里没有这一项：${what}`)
  return it
}

describe('骨架', () => {
  test('齐全 ⇒ 六项里 frontmatter/两节都通过', async () => {
    const dir = await makeSkill('skeleton-ok', { 'SKILL.md': GOOD_SKILL })
    const report = await runSkillExecCheck(dir)
    const skeleton = find(report, 'skeleton')
    assert.equal(skeleton.filter((i) => i.status === 'fail').length, 0)
    assert.ok(skeleton.some((i) => i.detail.includes('kebab-case')))
  })

  test('缺 `## Procedure` ⇒ 明确报缺哪一节（不是一句"结构不对"）', async () => {
    const dir = await makeSkill('skeleton-missing', {
      'SKILL.md': GOOD_SKILL.replace('## Procedure', '## Steps'),
    })
    const report = await runSkillExecCheck(dir)
    const bad = find(report, 'skeleton').filter((i) => i.status === 'fail')
    assert.equal(bad.length, 1)
    assert.match(first(bad, '骨架失败项').detail, /缺 ## Procedure/)
  })

  test('name 不是 kebab-case ⇒ 报出实际值（人要能直接改）', async () => {
    const dir = await makeSkill('skeleton-name', {
      'SKILL.md': GOOD_SKILL.replace('name: trace-topic-to-primary-source', 'name: Trace_Topic'),
    })
    const report = await runSkillExecCheck(dir)
    assert.ok(find(report, 'skeleton').some((i) => i.detail.includes('不是 kebab-case：Trace_Topic')))
  })

  test('没有 SKILL.md ⇒ 报读不到，且**不抛**（定检挂了不该让起审核失败）', async () => {
    const dir = await makeSkill('skeleton-none', { 'references/a.md': 'x' })
    const report = await runSkillExecCheck(dir)
    assert.ok(find(report, 'skeleton').some((i) => i.status === 'fail' && i.detail.includes('读不到')))
  })
})

describe('脚本语法（只解析，不执行）', () => {
  test('语法正确的 python/js/bash ⇒ 三项都通过', async () => {
    const dir = await makeSkill('scripts-ok', {
      'SKILL.md': GOOD_SKILL,
      'scripts/a.py': 'import sys\nprint(sys.argv)\n',
      'scripts/b.js': 'import fs from "node:fs"\nexport const x = fs\n',
      'scripts/c.sh': '#!/usr/bin/env bash\necho hi\n',
    })
    const report = await runSkillExecCheck(dir)
    const ok = find(report, 'script_syntax').filter((i) => i.status === 'ok')
    assert.equal(ok.length, 3)
    assert.ok(ok.every((i) => i.detail.includes('只解析')))
  })

  test('python 语法错 ⇒ 报不通过，并带上真正的原因（不是整段 traceback）', async () => {
    const dir = await makeSkill('scripts-bad-py', {
      'SKILL.md': GOOD_SKILL,
      'scripts/bad.py': 'def f(:\n',
    })
    const report = await runSkillExecCheck(dir)
    const bad = find(report, 'script_syntax').filter((i) => i.status === 'fail')
    assert.equal(bad.length, 1)
    const item = first(bad, '脚本语法失败项')
    assert.match(item.detail, /SyntaxError/)
    assert.ok(item.detail.length < 300, '理由要压成一句，不要把 traceback 整段塞进判决')
  })

  test('bash 语法错 ⇒ 报不通过', async () => {
    const dir = await makeSkill('scripts-bad-sh', {
      'SKILL.md': GOOD_SKILL,
      'scripts/bad.sh': 'if [ 1 = 1 ]; then\n',
    })
    const report = await runSkillExecCheck(dir)
    assert.ok(find(report, 'script_syntax').some((i) => i.status === 'fail'))
  })

  test('检完**目录里没多出东西**（曾经用 py_compile，往被检目录写了 __pycache__）', async () => {
    const dir = await makeSkill('scripts-clean', {
      'SKILL.md': GOOD_SKILL,
      'scripts/a.py': 'print(1)\n',
    })
    const before = (await readdir(dir, { recursive: true })).map(String).sort()
    await runSkillExecCheck(dir)
    const after = (await readdir(dir, { recursive: true })).map(String).sort()
    assert.deepEqual(after, before, '定检不许改动被检目录')
  })

  test('解析器不存在 ⇒ **没查**，不许算通过（第一版并进 ok 过）', async () => {
    const dir = await makeSkill('scripts-no-tool', {
      'SKILL.md': GOOD_SKILL,
      'scripts/a.py': 'print(1)\n',
    })
    const report = await runSkillExecCheck(dir, {
      // 模拟"这台机器没有 python3"：起不来 ⇒ code=null
      run: async () => ({ code: null, out: 'spawn python3 ENOENT' }),
    })
    const item = first(find(report, 'script_syntax'), '脚本语法项')
    assert.equal(item.status, 'skipped')
    assert.match(item.detail, /没有结论/)
    const md = renderExecCheckMarkdown(report)
    assert.match(md, /没查/)
    assert.match(md, /不要把"没查"当成"通过"/)
  })

  test('没有 scripts/ ⇒ 说清"没有脚本可查"，而不是静默无此项', async () => {
    const dir = await makeSkill('scripts-none', { 'SKILL.md': GOOD_SKILL })
    const report = await runSkillExecCheck(dir)
    assert.ok(find(report, 'script_syntax').some((i) => i.target === '（没有脚本）'))
  })

  test('不认识的后缀 ⇒ 列出来（`事实`），不假装查过', async () => {
    const dir = await makeSkill('scripts-other', {
      'SKILL.md': GOOD_SKILL,
      'scripts/run.rb': 'puts 1\n',
    })
    const report = await runSkillExecCheck(dir)
    assert.ok(find(report, 'script_syntax').some((i) => i.status === 'note' && i.target.includes('run.rb')))
  })
})

describe('引用的支持文件 / 占位符 / 吞错写法', () => {
  test('引用了不存在的 scripts/x.py ⇒ 报不通过（执行者照做会读不到）', async () => {
    const dir = await makeSkill('ref-missing', {
      'SKILL.md': `${GOOD_SKILL}\n支持文件见 \`scripts/extract-html.py\`。\n`,
      'references/extraction.md': '见 `scripts/extract-html.py` 与 `templates/notes.md`。\n',
    })
    const report = await runSkillExecCheck(dir)
    const bad = find(report, 'referenced_file').filter((i) => i.status === 'fail')
    assert.deepEqual(bad.map((i) => i.target).sort(), ['scripts/extract-html.py', 'templates/notes.md'])
  })

  test('引用的文件都在 ⇒ 一条通过（不要每个引用报一条，判决会淹掉）', async () => {
    const dir = await makeSkill('ref-ok', {
      'SKILL.md': `${GOOD_SKILL}\n见 \`scripts/a.sh\`。\n`,
      'scripts/a.sh': 'echo hi\n',
    })
    const report = await runSkillExecCheck(dir)
    const refs = find(report, 'referenced_file')
    assert.equal(refs.length, 1)
    assert.equal(first(refs, '引用项').status, 'ok')
  })

  test('只在代码块里出现的占位符 ⇒ 报`事实`且措辞留有余地（机械检查不该假装比它知道的多）', async () => {
    const dir = await makeSkill('placeholder', {
      'SKILL.md': [
        '---',
        'name: x',
        'description: y',
        '---',
        '',
        '## When to Use',
        'a',
        '',
        '## Procedure',
        '',
        '1. `<NAME>` 换成人名（这一句就是"解释过"的证据）：',
        '',
        '```bash',
        'curl "https://example.org/?q=<NAME>&page=<PAGE_NO>"',
        '```',
        '',
      ].join('\n'),
    })
    const report = await runSkillExecCheck(dir)
    const item = first(find(report, 'placeholder'), '占位符项')
    assert.equal(item.status, 'note')
    assert.match(item.detail, /可能没解释/)
    assert.match(item.detail, /<PAGE_NO>/)
    assert.ok(!item.detail.includes('<NAME>'), '<NAME> 在正文里解释过，不该列进来')
  })

  test('吞掉错误的写法 ⇒ 只列事实，**不判不合格**（合法的 2>/dev/null 到处都是）', async () => {
    const dir = await makeSkill('swallow', {
      'SKILL.md': `${GOOD_SKILL}\n\`\`\`bash\nrm -f /tmp/x || true\nfoo 2>/dev/null\n\`\`\`\n`,
    })
    const report = await runSkillExecCheck(dir)
    const item = first(find(report, 'error_swallowing'), '吞错写法项')
    assert.equal(item.status, 'note')
    assert.match(item.detail, /\|\| true/)
    assert.match(item.detail, /2>\/dev\/null/)
    assert.ok(!execCheckHasFailure(report) || find(report, 'error_swallowing').every((i) => i.status === 'note'))
  })
})

describe('报告本身', () => {
  test('摘要与"有没有硬故障"两个出口对得上（日志与流程各用各的）', async () => {
    const bad = await runSkillExecCheck(
      await makeSkill('sum-bad', { 'SKILL.md': GOOD_SKILL, 'scripts/bad.py': 'def f(:\n' }),
    )
    assert.ok(execCheckHasFailure(bad))
    assert.match(summarizeExecCheck(bad), /不通过 1/)
    const good = await runSkillExecCheck(await makeSkill('sum-ok', { 'SKILL.md': GOOD_SKILL }))
    assert.equal(execCheckHasFailure(good), false)
  })

  test('Markdown 里带出被检目录与时间（判决要能指回现场）', async () => {
    const dir = await makeSkill('md', { 'SKILL.md': GOOD_SKILL })
    const report = await runSkillExecCheck(dir)
    const md = renderExecCheckMarkdown(report)
    assert.match(md, /平台定检/)
    assert.match(md, /被检目录 `skill\/`/)
  })
})