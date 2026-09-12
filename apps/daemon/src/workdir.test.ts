import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWorkDir, resolveWorkDir, sanitizeIdPart } from './workdir.ts'

/**
 * 工作目录的解析（D27）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条规则改的是**默认行为**
 * ══════════════════════════════════════════════════════════════════
 *
 * D20 原来是"工作目录由使用者指定"，于是**每建一个任务都要先想一个目录**。
 * 现在改成每个任务自动获得一个独立目录——使用者不必操心，想接自己的仓库
 * 时仍然可以显式指定。
 *
 * 这组测试要钉住的核心是：**优先级顺序**，以及**缺省真的会分配一个独立目录**
 * （而不是退化成一个共享目录或空值）。
 */

const SUBJECT = { type: 'issue' as const, id: '01M2ABC' }

describe('★ 目录解析的优先级', () => {
  test('★ 都不给时自动分配，且按**任务**分目录', () => {
    const r = resolveWorkDir({
      workRoot: '/work',
      subject: SUBJECT,
      fallbackId: '01M2RUN',
    })
    assert.equal(r.origin, 'auto')
    assert.equal(r.path, '/work/issue-01M2ABC', '按 subject 分，不是按 runId')
    assert.match(r.explanation, /每个任务一个独立目录/)
  })

  test('★ 同一任务的不同 run 得到**同一个**目录（重试才看得见上次的文件）', () => {
    const a = resolveWorkDir({ workRoot: '/work', subject: SUBJECT, fallbackId: 'run-1' })
    const b = resolveWorkDir({ workRoot: '/work', subject: SUBJECT, fallbackId: 'run-2' })
    assert.equal(
      a.path,
      b.path,
      '★ 按 run 分的话，一次重试就是一间全新的空房间——而"重试"的语义恰恰是"接着做"',
    )
  })

  test('不同任务得到不同目录', () => {
    const a = resolveWorkDir({ workRoot: '/work', subject: { type: 'issue', id: 'A' }, fallbackId: 'x' })
    const b = resolveWorkDir({ workRoot: '/work', subject: { type: 'issue', id: 'B' }, fallbackId: 'y' })
    assert.notEqual(a.path, b.path)
  })

  test('显式指定的目录优先级最高', () => {
    const r = resolveWorkDir({
      requested: '/my/repo',
      agentDefault: '/agent/dir',
      workRoot: '/work',
      subject: SUBJECT,
      fallbackId: 'x',
    })
    assert.equal(r.path, '/my/repo')
    assert.equal(r.origin, 'requested')
  })

  test('★ agent 配置的默认目录仍然有效 —— 那是**显式选择**，不是兜底', () => {
    const r = resolveWorkDir({
      agentDefault: '/agent/dir',
      workRoot: '/work',
      subject: SUBJECT,
      fallbackId: 'x',
    })
    assert.equal(r.path, '/agent/dir')
    assert.equal(r.origin, 'agent-default')
  })

  test('空白字符串不算"指定过"（表单里清空一项不该变成一个叫 "  " 的目录）', () => {
    const r = resolveWorkDir({
      requested: '   ',
      agentDefault: '',
      workRoot: '/work',
      subject: SUBJECT,
      fallbackId: 'x',
    })
    assert.equal(r.origin, 'auto')
  })

  test('subject 缺失时用 fallbackId，不炸', () => {
    const r = resolveWorkDir({
      workRoot: '/work',
      subject: undefined as never,
      fallbackId: '01M2RUN',
    })
    assert.equal(r.path, '/work/run-01M2RUN')
  })

  test('三类 subject 有各自前缀（ls 时一眼看出是哪类对象）', () => {
    assert.equal(
      resolveWorkDir({ workRoot: '/w', subject: { type: 'report', id: 'R' }, fallbackId: 'x' }).path,
      '/w/report-R',
    )
    assert.equal(
      resolveWorkDir({ workRoot: '/w', subject: { type: 'run', id: 'N' }, fallbackId: 'x' }).path,
      '/w/run-N',
    )
  })
})

describe('★ id 会拼进文件系统，所以必须防御', () => {
  test('★ 路径穿越字符被替换掉', () => {
    // 正常数据下 id 都是 ULID，这条永远不会触发。它的存在是因为
    // **这条路径会拼进文件系统**：只要有一天某个 id 来自别处
    //（导入的历史数据、第三方写入的引用），一个没被过滤的 ../ 就会让
    // 工作目录跑到别的地方去。
    const r = resolveWorkDir({
      workRoot: '/work',
      subject: { type: 'issue', id: '../../etc' },
      fallbackId: 'x',
    })
    // 断言**性质**而不是下划线的个数——数个数是脆的，而且没意义：
    // 真正要保证的是"它老老实实待在 workRoot 底下"。
    assert.ok(!r.path.includes('..'), `解析结果里不能有 ..：${r.path}`)
    assert.ok(r.path.startsWith('/work/'), `必须待在 workRoot 底下：${r.path}`)
    assert.equal(r.path.split('/').length, 3, '不能多出层级')
    assert.ok(r.path.endsWith('etc'), '可读的部分保留下来')
  })

  test('★ 全是非法字符时不能返回空串', () => {
    // 空串会让 `join(root, '')` 变成根本身——于是所有这类任务
    // **共用同一个目录**，而且是根目录
    assert.equal(sanitizeIdPart('../..'), 'unknown')
    assert.equal(sanitizeIdPart('...'), 'unknown')
    assert.equal(sanitizeIdPart(''), 'unknown')
  })

  test('斜杠被替换（否则会多出一层目录）', () => {
    assert.equal(sanitizeIdPart('a/b'), 'a_b')
  })

  test('正常 ULID 原样保留', () => {
    assert.equal(sanitizeIdPart('01M2ABCXYZ'), '01M2ABCXYZ')
  })

  test('超长 id 被截断（文件名长度有上限）', () => {
    assert.equal(sanitizeIdPart('a'.repeat(500)).length, 128)
  })
})

describe('ensureWorkDir', () => {
  test('目录不存在时创建（含中间层）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alpha-workdir-'))
    try {
      const target = join(dir, 'a', 'b', 'c')
      await ensureWorkDir(target)
      assert.equal((await stat(target)).isDirectory(), true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('目录已存在时不报错（重试会走到这里）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alpha-workdir2-'))
    try {
      await ensureWorkDir(dir)
      await ensureWorkDir(dir)
      assert.equal((await stat(dir)).isDirectory(), true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
