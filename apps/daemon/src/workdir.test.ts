import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  defaultWorkRoot,
  ensureWorkDir,
  fallbackWorkRoot,
  migrateLegacyWorkRoot,
  resolveWorkDir,
  sanitizeIdPart,
} from './workdir.ts'

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
  // ★ 临时目录一律用 makeTempDir（仓库内的 .cache/test-tmp），**不用 os.tmpdir()**：
  //   系统临时目录在沙箱环境下可能写不进去，而且它离"被误删"只差一步。
  //   这条纪律由 tests/test-safety.test.ts 机器检查。
  test('目录不存在时创建（含中间层）', async () => {
    const dir = await makeTempDir('ensure-workdir')
    try {
      const target = join(dir, 'a', 'b', 'c')
      await ensureWorkDir(target)
      assert.equal((await stat(target)).isDirectory(), true)
    } finally {
      await cleanup(dir)
    }
  })

  test('目录已存在时不报错（重试会走到这里）', async () => {
    const dir = await makeTempDir('ensure-workdir-twice')
    try {
      await ensureWorkDir(dir)
      await ensureWorkDir(dir)
      assert.equal((await stat(dir)).isDirectory(), true)
    } finally {
      await cleanup(dir)
    }
  })
})

describe('★ 工作目录根：可见的那一个，和自洽的兜底', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条规则被改过两次，两次都是"位置不对"
   * ══════════════════════════════════════════════════════════════════
   *
   * 第一版：数据目录的同级（`<dataDir>/../work`）。只在数据目录恰好叫 `data`
   * 时看起来对——`--data-dir /tmp/x` 会让产出落到 `/tmp/work`。
   *
   * 第二版：数据目录之内（`<dataDir>/work`）。跑偏修好了，但默认下变成
   * `~/.alpha-helper/data/work/`——**藏在点开头的目录里，还埋在 data 下面两层**。
   *
   * 现在：**家目录下一个可见的 `alpha-helper-workspace/`**。
   *
   * 为什么"可见"是硬要求：工作目录装的是 agent 真正的产出，使用者要用
   * Finder 打开、要在终端里 `cd` 进去。产出放在找不到的地方等于没有产出。
   */
  test('★ 默认在家目录下，而且**不是隐藏目录**', () => {
    const root = defaultWorkRoot()
    assert.equal(dirname(root), homedir(), `★ 应当在家的正下方：${root}`)
    assert.equal(basename(root), 'alpha-helper-workspace')
    assert.equal(
      basename(root).startsWith('.'),
      false,
      '★ 不能是点开头的隐藏目录——Finder 默认不显示，使用者就找不到产出了',
    )
    assert.equal(root.includes('//'), false, `不该有双斜杠：${root}`)
    assert.match(root, /alpha-helper/, '使用者要能一眼认出这是本应用的地方')
  })

  test('★ 默认根只由函数自己决定，不吃任何参数', () => {
    // 这条是**签名层面**的约束：`defaultWorkRoot()` 不收 `dataDir`。
    // 只要它还接受 dataDir，就一定会有人再次把它推导成 `<dataDir>/…`——
    // 而那正是前两版各自跑偏的根源。这里断言调用两次结果一致，
    // 把"它是个常量"这件事钉住。
    assert.equal(defaultWorkRoot(), defaultWorkRoot())
    assert.equal(
      defaultWorkRoot().startsWith(homedir()),
      true,
      '不能变成相对路径（相对路径会跟着 cwd 漂）',
    )
  })

  test('★ 兜底根必须待在数据目录之内 —— 否则测试会写进使用者的家目录', () => {
    // 核心的兜底（`startDaemon` 没收到 workRoot 时用的那个）绝不能碰家目录。
    // 测试用的是 `.cache/test-tmp/` 里的一次性数据目录；只要兜底在 dataDir
    // 之内，**任何一处忘了传 workRoot 的测试**都不可能污染真实环境。
    //
    // 这是个结构性的保证，不是靠"记得传"。故意拿几个非常规 dataDir 试。
    for (const dataDir of ['/tmp/x', '/home/u/.alpha-helper/data', '.cache/dev/daemon-data']) {
      const root = fallbackWorkRoot(dataDir)
      assert.ok(
        root.startsWith(`${dataDir}/`),
        `★ 兜底根必须在数据目录之内：${dataDir} ⇒ ${root}`,
      )
    }
  })

  test('dataDir 以斜杠结尾时不会拼出双斜杠', () => {
    const root = fallbackWorkRoot('/home/u/.alpha-helper/data/')
    assert.ok(!root.includes('//'), root)
  })
})

describe('★ 旧工作目录的一次性迁移', () => {
  /**
   * 为什么必须迁移：自动目录的路径是**算出来**的，不是记下来的。
   *
   * `<workRoot>/<subjectType>-<subjectId>`——同一任务的两次 run 因此落在同一个
   * 目录里，重试能接着做（D27 的本意）。代价是**根一改，旧任务的目录就换了地方**：
   * 重试会得到一个空目录，看起来像上次的产出丢了。
   *
   * 所以改根这件事必须连带把旧目录搬过去，否则就是一次静默的数据丢失。
   */
  test('★ 旧目录搬到新根：内容真的过去了，旧目录不再存在', async () => {
    const dataDir = await makeTempDir('migrate-legacy')
    const homeDir = await makeTempDir('migrate-new')
    const legacyRoot = fallbackWorkRoot(dataDir)
    const workRoot = join(homeDir, 'alpha-helper-workspace')

    try {
      await mkdir(join(legacyRoot, 'issue-01M2ABC'), { recursive: true })
      await writeFile(join(legacyRoot, 'issue-01M2ABC', 'note.txt'), '上次做到这里', 'utf8')

      const result = await migrateLegacyWorkRoot({ legacyRoot, workRoot })

      assert.equal(result, 'moved')
      assert.equal(
        await readFile(join(workRoot, 'issue-01M2ABC', 'note.txt'), 'utf8'),
        '上次做到这里',
        '★ 内容必须在——迁移的全部意义就是让重试还能看到上次的文件',
      )
      await assert.rejects(stat(legacyRoot), '旧目录搬完就不该还在了')
    } finally {
      await cleanup(dataDir)
      await cleanup(homeDir)
    }
  })

  test('★ 新根非空 ⇒ 什么都不碰，并且要警告（那是使用者的地盘）', async () => {
    const dataDir = await makeTempDir('migrate-legacy')
    const homeDir = await makeTempDir('migrate-new')
    const legacyRoot = fallbackWorkRoot(dataDir)
    const workRoot = join(homeDir, 'alpha-helper-workspace')

    const warnings: string[] = []
    try {
      await mkdir(join(legacyRoot, 'issue-old'), { recursive: true })
      await mkdir(join(workRoot, 'issue-new'), { recursive: true })
      await writeFile(join(workRoot, 'issue-new', 'mine.txt'), '我自己放的', 'utf8')

      const result = await migrateLegacyWorkRoot({
        legacyRoot,
        workRoot,
        onWarn: (m) => warnings.push(m),
      })

      assert.equal(result, 'skipped')
      assert.equal(
        await readFile(join(workRoot, 'issue-new', 'mine.txt'), 'utf8'),
        '我自己放的',
        '★ 绝不能覆盖使用者已经放进新目录的东西',
      )
      assert.equal((await stat(join(legacyRoot, 'issue-old'))).isDirectory(), true, '旧内容也不能丢')
      assert.equal(warnings.length, 1, '★ 静默跳过会让人以为已经迁完了，必须说一声')
      assert.match(warnings[0]!, /没有丢/)
    } finally {
      await cleanup(dataDir)
      await cleanup(homeDir)
    }
  })

  test('全新安装（旧根不存在）⇒ 跳过，而且**不白建一个新目录**', async () => {
    const dataDir = await makeTempDir('migrate-legacy')
    const homeDir = await makeTempDir('migrate-new')
    const workRoot = join(homeDir, 'alpha-helper-workspace')

    try {
      assert.equal(await migrateLegacyWorkRoot({ legacyRoot: fallbackWorkRoot(dataDir), workRoot }), 'skipped')
      await assert.rejects(stat(workRoot), '没东西可搬时不该建目录')
    } finally {
      await cleanup(dataDir)
      await cleanup(homeDir)
    }
  })

  test('旧根是空目录 ⇒ 跳过', async () => {
    const dataDir = await makeTempDir('migrate-legacy')
    const homeDir = await makeTempDir('migrate-new')
    const legacyRoot = fallbackWorkRoot(dataDir)
    const workRoot = join(homeDir, 'alpha-helper-workspace')

    try {
      await mkdir(legacyRoot, { recursive: true })
      assert.equal(await migrateLegacyWorkRoot({ legacyRoot, workRoot }), 'skipped')
      await assert.rejects(stat(workRoot))
    } finally {
      await cleanup(dataDir)
      await cleanup(homeDir)
    }
  })

  test('★ 旧根与新根是同一个 ⇒ 跳过，而且**不该给警告**', async () => {
    const dataDir = await makeTempDir('migrate-legacy')
    const root = fallbackWorkRoot(dataDir)
    const warnings: string[] = []
    try {
      await mkdir(join(root, 'issue-x'), { recursive: true })
      // 测试里 workRoot 就是 fallbackWorkRoot(dataDir)，两者相同——这是**正常**
      // 情况，不是需要提醒使用者的事。所以这里断言"没有警告"：
      // 一旦这条守卫被去掉，代码会走到"新根非空"那条分支上去，并且发出
      // 一条"旧目录还没搬"的警告——那会让人以为有东西落下了。
      assert.equal(
        await migrateLegacyWorkRoot({ legacyRoot: root, workRoot: root, onWarn: (m) => warnings.push(m) }),
        'skipped',
      )
      assert.equal(warnings.length, 0, '★ 同一个目录不是"需要提醒"的情况')
      assert.equal((await stat(join(root, 'issue-x'))).isDirectory(), true)
    } finally {
      await cleanup(dataDir)
    }
  })

  test('★ 新根在旧根里面 ⇒ 跳过（否则就是把目录搬进它自己）', async () => {
    const dataDir = await makeTempDir('migrate-legacy')
    const root = fallbackWorkRoot(dataDir)
    const warnings: string[] = []
    try {
      await mkdir(join(root, 'issue-x'), { recursive: true })
      const nested = join(root, 'nested')
      assert.equal(
        await migrateLegacyWorkRoot({ legacyRoot: root, workRoot: nested, onWarn: (m) => warnings.push(m) }),
        'skipped',
      )
      assert.equal(warnings.length, 0)
      await assert.rejects(stat(nested), '不能凭空建出那个嵌套目录')
    } finally {
      await cleanup(dataDir)
    }
  })

  test('★ 搬不动时只警告，**不删源**（旧内容必须原样留着）', async () => {
    const dataDir = await makeTempDir('migrate-legacy')
    const homeDir = await makeTempDir('migrate-new')
    const legacyRoot = fallbackWorkRoot(dataDir)
    // 让新根的父亲是个**文件**：mkdir/rename 必然失败，
    // 但又不至于碰到真实文件系统上别的东西。
    const blocker = join(homeDir, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    const workRoot = join(blocker, 'alpha-helper-workspace')

    const warnings: string[] = []
    try {
      await mkdir(join(legacyRoot, 'issue-old'), { recursive: true })
      await writeFile(join(legacyRoot, 'issue-old', 'keep.txt'), '别删我', 'utf8')

      const result = await migrateLegacyWorkRoot({
        legacyRoot,
        workRoot,
        onWarn: (m) => warnings.push(m),
      })

      assert.equal(result, 'failed')
      assert.equal(warnings.length, 1)
      assert.equal(
        await readFile(join(legacyRoot, 'issue-old', 'keep.txt'), 'utf8'),
        '别删我',
        '★ 迁移失败绝不能连带删掉旧内容——那才是真正的数据丢失',
      )
    } finally {
      await cleanup(dataDir)
      await cleanup(homeDir)
    }
  })
})
