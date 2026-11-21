import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AGENT_DIR_NAME_MAX, slugForAgentName, uniqueAgentDirName } from './agent-slug.ts'

/**
 * **智能体目录名 = 名字的 slug**（D231，方案 D）。
 *
 * 钉的是"能不能安全地当目录名"这一件事，逐条对应一种真会踩到的坏法：
 * 跨平台非法字符、大小写不敏感导致的互相覆盖、保留名建不出目录、超长。
 */

describe('slugForAgentName', () => {
  test('★ 中文原样保留（不拼音化：目录名要能跟界面上的名字对上）', () => {
    assert.equal(slugForAgentName('智能体生成者'), '智能体生成者')
    assert.equal(slugForAgentName('助手审核员'), '助手审核员')
  })

  test('★★ ASCII 一律转小写（APFS 大小写不敏感：Writer 与 writer 会是同一个目录）', () => {
    assert.equal(slugForAgentName('Writer'), 'writer')
    assert.equal(slugForAgentName('Writer'), slugForAgentName('writer'))
  })

  test('★ 非法字符与空白折成 `-`，连续 `-` 压掉、首尾去掉', () => {
    assert.equal(slugForAgentName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
    assert.equal(slugForAgentName('  写作 员  '), '写作-员')
    assert.equal(slugForAgentName('a---b'), 'a-b')
    assert.equal(slugForAgentName('  -x-  '), 'x')
  })

  test('★ 空名 / 只有非法字符 ⇒ 退回 `agent`（调用方再解决唯一性）', () => {
    assert.equal(slugForAgentName(''), 'agent')
    assert.equal(slugForAgentName('   '), 'agent')
    assert.equal(slugForAgentName('///'), 'agent')
  })

  test('★ 超长截断到上限（中文 3 字节/字，留足 255 字节的单段余量）', () => {
    const long = '很'.repeat(200)
    const slug = slugForAgentName(long)
    assert.equal(slug.length, AGENT_DIR_NAME_MAX)
  })

  test('★★ 保留名加前缀：点开头（本仓库把点开头当元文件跳过）与 Windows 设备名', () => {
    assert.ok(!slugForAgentName('.hidden').startsWith('.'))
    assert.equal(slugForAgentName('CON'), 'agent-con')
    assert.equal(slugForAgentName('nul'), 'agent-nul')
    assert.equal(slugForAgentName('COM1'), 'agent-com1')
    // 普通名字不受影响
    assert.equal(slugForAgentName('console'), 'console')
  })
})

describe('uniqueAgentDirName', () => {
  test('★ 没被占用就用基名；占用则依次加 -2 / -3', () => {
    assert.equal(uniqueAgentDirName('写作员', new Set()), '写作员')
    assert.equal(uniqueAgentDirName('写作员', new Set(['写作员'])), '写作员-2')
    assert.equal(uniqueAgentDirName('写作员', new Set(['写作员', '写作员-2'])), '写作员-3')
  })

  test('★★ 大小写不同也算占用（磁盘上是一个目录）', () => {
    assert.equal(uniqueAgentDirName('Writer', new Set(['writer'])), 'writer-2')
  })

  test('★ 两个不同的名字算出同一个 slug ⇒ 第二个加后缀（不合并、不猜）', () => {
    // `写作/员` 与 `写作-员` 都算成 `写作-员`（前者非法字符折成 `-`）
    assert.equal(slugForAgentName('写作/员'), slugForAgentName('写作-员'))
    const first = uniqueAgentDirName('写作/员', new Set())
    const second = uniqueAgentDirName('写作-员', new Set([first]))
    assert.equal(first, '写作-员')
    assert.equal(second, '写作-员-2')
  })
})
