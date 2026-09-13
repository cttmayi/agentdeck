#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 * 界面布局检查：跑得起来、量得出来、不对就红
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用法：
 *
 *   pnpm run build:web          # 先构建（探针量的是 apps/web/dist 里的真产物）
 *   pnpm run probe:layout       # 量一遍并断言
 *   pnpm run probe:layout -- --keep   # 结束后留下 daemon，方便自己用浏览器看
 *
 * 它做四件事：
 *
 *   1. 起一个**一次性 daemon**（数据与工作目录都在 .cache/layout-probe/ 下，
 *      绝不碰 ~/.alpha-helper，也不写任何仓库外的地方）。首启会播种一对
 *      agent 与一个审核模板，所以断言有确定的数据可依；
 *   2. 把 `probe.html` 拷进 `apps/web/dist/`（daemon 只从那里提供静态文件），
 *      跑完删掉——它是构建产物目录，不该长期留着探针；
 *   3. 用 headless Chrome 打开它，等它把量到的事实写成 JSON；
 *   4. 拿这份事实去对 `CHECKS` 里的期望值，全过退出 0，有一条不过退出 1。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么它不是 `pnpm run check` 的一部分
 * ══════════════════════════════════════════════════════════════════════
 *
 * 它需要**真的 Chrome** 和**一个真的 daemon**。把它塞进 `check` 就等于让
 * 整个测试套件依赖"这台机器上装了浏览器"——那是 NFR-T-01 那条线（测试不许
 * 依赖真实环境）反过来走。所以它是一条单独的命令：改布局时跑，日常不跑。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三个坑（都是踩过的）
 * ══════════════════════════════════════════════════════════════════════
 *
 *   - headless Chrome 打完 `--dump-dom` **不会退出**（这个环境里必现）。
 *     所以它是"后台跑 → 轮询输出文件 → 再杀"，而不是"等它结束再看输出"；
 *   - 杀进程只按**这次专用的 user-data-dir** 匹配。早先用
 *     `pkill -f "Google Chrome"` 把使用者本人的浏览器一起杀了，是个事故；
 *   - `vite build` 会清空 `dist/`，所以探针页每次都要重新拷进去。同时也
 *     意味着"dist 比源码旧"是常态——那种情况下量到的是旧界面，必须拦住。
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist')
const SCRATCH = path.join(ROOT, '.cache', 'layout-probe')
const PROBE_NAME = 'layout-probe.html'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const KEEP = flag('keep')
const ALLOW_STALE = flag('allow-stale')
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 120_000)

const log = (s = '') => process.stdout.write(s + '\n')
const paint = (code, s) => `\u001b[${code}m${s}\u001b[0m`
const green = (s) => paint('32', s)
const red = (s) => paint('31', s)
const yellow = (s) => paint('33', s)
const dim = (s) => paint('2', s)

// ══════════════════════════════════════════════════════════════════════
// 期望值：量到的"事实"对不对
// ══════════════════════════════════════════════════════════════════════
//
// 一条一行、一句话说清"这条在防什么"。改布局时先看这里——它同时是
// 这份布局的规格说明。数值用容差比：`rem` 按 16px 算，但不同环境可能差
// 一两像素，卡死在 416 会因为无关的事变红。

const near = (actual, expected, tol = 2) =>
  typeof actual === 'number' && Math.abs(actual - expected) <= tol

const CHECKS = [
  // ── 智能体：主从布局 ──
  { view: '智能体', key: 'agents.gotData', label: 'agent 数据到得了界面（列表不是空的）', ok: (v) => v === true },
  { view: '智能体', key: 'agents.cardCount', label: '渲染出 agent 卡片', ok: (v) => v >= 1, show: (v) => `${v} 张` },
  {
    view: '智能体',
    key: 'agents.everyCardWellFormed',
    label: '每张卡片都有名字、角色徽章、两行说明',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.executorShowsReviewer',
    label: '执行者卡片上"由谁审它"解析出了名字（不是"已不存在"）',
    ok: (v) => typeof v === 'string' && v.length > 0 && !v.includes('已不存在'),
  },
  { view: '智能体', key: 'agents.initialClass', label: '未选中时布局不带 with-detail', ok: (v) => !String(v).includes('with-detail') },
  { view: '智能体', key: 'agents.initialListDisplay', label: '未选中时左栏可见', ok: (v) => v === 'flex' },
  { view: '智能体', key: 'agents.initialDetailDisplay', label: '未选中时右栏可见（显示占位）', ok: (v) => v === 'flex' },
  {
    view: '智能体',
    key: 'agents.mainOverflowY',
    label: '`:has(> .split-layout)` 生效：主区不整体滚动（hidden）',
    ok: (v) => v === 'hidden',
  },
  { view: '智能体', key: 'agents.mainPaddingTop', label: '主区 padding 归零，留白交给两栏', ok: (v) => v === '0px' },
  { view: '智能体', key: 'agents.layoutHeightDelta', label: '布局高度 = 主区高度（两栏各自内部滚动）', ok: (v) => near(v, 0, 1) },
  { view: '智能体', key: 'agents.afterClickClass', label: '点一条 agent 后带上 with-detail', ok: (v) => String(v).includes('with-detail') },
  {
    view: '智能体',
    key: 'agents.tracks',
    label: '两栏：清单 26rem(416px) + 详情占剩余',
    ok: (v) => Array.isArray(v) && v.length === 2 && near(parseFloat(v[0]), 416) && parseFloat(v[1]) > parseFloat(v[0]),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  { view: '智能体', key: 'agents.activeCardClass', label: '选中的卡片有 active 态', ok: (v) => String(v).includes('active') },
  { view: '智能体', key: 'agents.detailRendered', label: '右栏真的渲染出了 agent 详情', ok: (v) => v === true },
  { view: '智能体', key: 'agents.wideBackDisplay', label: '宽屏不显示返回按钮（列表就在左边）', ok: (v) => v === 'none' },
  { view: '智能体', key: 'agents.wideListDisplay', label: '宽屏左栏可见', ok: (v) => v === 'flex' },
  { view: '智能体', key: 'agents.narrowListDisplay', label: '窄屏 + 选中详情时列表隐藏', ok: (v) => v === 'none' },
  { view: '智能体', key: 'agents.narrowDetailDisplay', label: '窄屏 + 选中详情时详情可见', ok: (v) => v === 'flex' },
  { view: '智能体', key: 'agents.narrowBackDisplay', label: '窄屏出现返回按钮', ok: (v) => v !== 'none' && v !== 'MISSING' },
  { view: '智能体', key: 'agents.afterBackClass', label: '点返回后 with-detail 撤掉', ok: (v) => !String(v).includes('with-detail') },
  { view: '智能体', key: 'agents.afterBackListDisplay', label: '返回后左栏回来', ok: (v) => v === 'flex' },
  { view: '智能体', key: 'agents.afterBackDetailDisplay', label: '窄屏下返回后详情栏消失', ok: (v) => v === 'none' },
  {
    view: '智能体',
    key: 'agents.editButtonFound',
    label: '详情里有「编辑」（下面那条要在编辑态里量）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.runtimeOptions',
    label: 'runtime 选择器的选项与身份接口一致（加/删一个 runtime 时写死的界面会在这里暴露）',
    ok: (v, facts) =>
      Array.isArray(v) &&
      v.length > 0 &&
      JSON.stringify(v) === JSON.stringify(facts['agents.identityRuntimeKeys']),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '智能体',
    key: 'agents.provisionalWarningInEdit',
    label: '★ 编辑态里选到**未验证**的 runtime 会给提示（以前编辑态没有任何提示）',
    ok: (v) => typeof v === 'string' && v.length > 10,
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 22)}…"`),
  },
  {
    view: '智能体',
    key: 'agents.runtimeCardCount',
    label: 'Runtime 概览渲染成卡片',
    ok: (v) => v >= 1,
    show: (v) => `${v} 张`,
  },
  {
    view: '智能体',
    key: 'agents.runtimeCardsWellFormed',
    label: '每张 runtime 卡都有多行字段（版本/证据/判定没丢）',
    ok: (v) => v === true,
  },

  // ── 任务清单：同一套主从 + 去重字样 ──
  { view: '任务清单', key: 'tasks.gotRows', label: '夹具任务渲染成了表格行（否则下面那条会空过）', ok: (v) => v === true },
  {
    view: '任务清单',
    key: 'tasks.firstRowStageCell',
    label: '从没跑过的那行：标签「执行中」+ 额外信息「还没开始执行」',
    ok: (v) => /^执行中\s+还没开始执行/.test(String(v)),
  },
  {
    view: '任务清单',
    key: 'tasks.heightSpread',
    label: '★ 行高与标题长度**无关**：长标题与短标题的行一样高（差 ≤ 2px）',
    ok: (v) => typeof v === 'number' && v <= 2,
    show: (v) => `差 ${v}px`,
  },
  {
    view: '任务清单',
    key: 'tasks.maxRowHeight',
    label: '行高还有个上限（两条都是矮的，也别是"两个都很高"）',
    ok: (v) => typeof v === 'number' && v <= 120,
    show: (v) => `${v}px`,
  },
  {
    view: '任务清单',
    key: 'tasks.titleClipped',
    label: '长标题确实被截断了（否则"行高无关"是空过的）',
    ok: (v) => v === true,
  },
  {
    view: '任务清单',
    key: 'tasks.detailTitleAfterClick',
    label: '点一行会打开它的详情，且标题是**完整**的（列表里那份是截断的）',
    ok: (v, facts) =>
      typeof v === 'string' && v.length > 0 && v === facts['tasks.clickedRowTitle'],
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 18)}…"`),
  },
  {
    view: '任务清单',
    key: 'tasks.detailHasTimestamp',
    label: '列表只留了日期，完整时间戳（含时分）在详情里还看得见',
    ok: (v) => v === true,
  },
  {
    view: '任务清单',
    key: 'tasks.titleWidth',
    label: '标题独占一行：宽度接近整个列表栏（≥ 240px）',
    ok: (v) => typeof v === 'number' && v >= 240,
    show: (v) => `${v}px`,
  },
  { view: '任务清单', key: 'tasks.layoutPresent', label: '任务页也是主从（左右两栏都在）', ok: (v) => v === true },
  {
    view: '任务清单',
    key: 'tasks.mainOverflowY',
    label: '任务页 `:has()` 同样生效',
    ok: (v) => v === 'hidden',
  },
  {
    view: '任务清单',
    key: 'tasks.duplicateStageTextCount',
    label: '渲染结果里「等待审核」出现 0 次（使用者点名要去掉的重复字样）',
    ok: (v) => v === 0,
    show: (v) => `${v} 次`,
  },

  // ── Skills：安装面板在抽屉里 ──
  { view: 'Skills', key: 'skills.title', label: 'Skills 页渲染', ok: (v) => v === 'Skills' },
  { view: 'Skills', key: 'skills.oldInlinePanel', label: '正文里不再有旧的内嵌安装面板', ok: (v) => v === false },
  { view: 'Skills', key: 'skills.tableRows', label: 'skill 列表有内容', ok: (v) => v >= 1, show: (v) => `${v} 行` },
  { view: 'Skills', key: 'skills.openButtonFound', label: '找得到「安装 skill」按钮', ok: (v) => v === true },
  {
    view: 'Skills',
    key: 'skills.drawerClass',
    label: '打开的是抽屉且用了宽版',
    ok: (v) => String(v).includes('drawer') && String(v).includes('wide'),
  },
  {
    view: 'Skills',
    key: 'skills.drawerWidth',
    label: '抽屉宽 46rem(736px)',
    ok: (v) => near(v, 736, 4),
    show: (v) => `${v}px`,
  },
  { view: 'Skills', key: 'skills.backdropPresent', label: '有背景遮罩（点它可关）', ok: (v) => v === true },
  { view: 'Skills', key: 'skills.footButtonText', label: '底部常驻的是主操作「检查并安装」', ok: (v) => v === '检查并安装' },
  { view: 'Skills', key: 'skills.footBottomDelta', label: '主操作贴住视口底部', ok: (v) => near(v, 0, 1), show: (v) => `差 ${v}px` },
  { view: 'Skills', key: 'skills.tabCount', label: '两个来源页签都在', ok: (v) => v === 2, show: (v) => `${v} 个` },
  { view: 'Skills', key: 'skills.duplicateCloseInTabs', label: '页签条里没有与抽屉头重复的「关闭」', ok: (v) => v === false },
  {
    view: 'Skills',
    key: 'skills.rowsBehindDrawer',
    label: '抽屉没把后面的 skill 列表吞掉（装完就能看见它）',
    ok: (v) => v >= 1,
    show: (v) => `${v} 行`,
  },
  { view: 'Skills', key: 'skills.drawerGoneAfterEsc', label: 'Esc 能关掉抽屉', ok: (v) => v === true },

  // ── 新建任务 ──
  { view: '新建任务', key: 'new.hasContent', label: '新建任务页渲染出来了（没白屏）', ok: (v) => v === true },
]

// ══════════════════════════════════════════════════════════════════════
// 环境准备
// ══════════════════════════════════════════════════════════════════════

function findChrome() {
  // CHROME 指了就必须真的存在：直接把它交给 spawn 会得到一个
  // ENOENT 的调用栈，而"路径写错了"和"这个浏览器跑不起来"看起来一样
  if (process.env.CHROME) {
    return fs.existsSync(process.env.CHROME) ? process.env.CHROME : null
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

function fail(code, ...lines) {
  log()
  for (const l of lines) log(red('✗ ') + l)
  process.exit(code)
}

/** dist 比源码旧 ⇒ 量到的是旧界面。这比"没有 dist"更危险，因为它看起来能跑。 */
function staleBy() {
  const entry = path.join(WEB_DIST, 'index.html')
  if (!fs.existsSync(entry)) return 'missing'
  const entryMs = fs.statSync(entry).mtimeMs
  let newest = 0
  let newestFile = ''
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const ms = fs.statSync(p).mtimeMs
        if (ms > newest) {
          newest = ms
          newestFile = path.relative(ROOT, p)
        }
      }
    }
  }
  walk(path.join(ROOT, 'apps', 'web', 'src'))
  if (newest > entryMs) return newestFile
  return null
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

async function waitFor(url, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 只按这次专用的 profile 目录匹配——绝不宽匹配（那会杀掉使用者自己的浏览器）。 */
function killChrome(profile, child) {
  try {
    child.kill('SIGKILL')
  } catch {}
  try {
    execFileSync('pkill', ['-f', profile], { stdio: 'ignore' })
  } catch {}
}

function parseFacts(html) {
  const m = html.match(/<pre id="out">([\s\S]*?)<\/pre>/)
  if (!m) return null
  const body = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

// ══════════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════════

const chrome = findChrome()
if (!chrome) {
  fail(
    2,
    '找不到 Chrome / Chromium。这个检查需要一个真浏览器（它量的就是浏览器算出来的布局）。',
    '装了别的浏览器可以用 CHROME=/path/to/chrome pnpm run probe:layout 指定。',
  )
}

const stale = staleBy()
if (stale === 'missing') {
  fail(2, 'apps/web/dist 里没有 index.html。先跑 `pnpm run build:web`。')
}
if (stale && !ALLOW_STALE) {
  fail(
    2,
    `dist 比源码旧（更新的文件：${stale}）——现在量到的会是旧界面。`,
    '先跑 `pnpm run build:web`；确实要用旧构建就加 --allow-stale。',
  )
}

fs.rmSync(SCRATCH, { recursive: true, force: true })
const dataDir = path.join(SCRATCH, 'data')
const workRoot = path.join(SCRATCH, 'work')
const profile = path.join(SCRATCH, 'chrome-profile')
for (const d of [dataDir, workRoot, profile]) fs.mkdirSync(d, { recursive: true })

const probeSrc = path.join(HERE, 'probe.html')
const probeDst = path.join(WEB_DIST, PROBE_NAME)
fs.copyFileSync(probeSrc, probeDst)

const port = await freePort()
const base = `http://127.0.0.1:${port}`
log(dim(`一次性 daemon：${base}（数据在 .cache/layout-probe/，不碰 ~/.alpha-helper）`))

const daemon = spawn(
  process.execPath,
  [
    path.join(ROOT, 'apps', 'daemon', 'src', 'cli.ts'),
    '--port',
    String(port),
    '--no-open',
    '--data-dir',
    dataDir,
    '--work-root',
    workRoot,
  ],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
)
let daemonLog = ''
daemon.stdout.on('data', (b) => (daemonLog += b))
daemon.stderr.on('data', (b) => (daemonLog += b))

let chromeChild = null
let exitCode = 1
const dumpPath = path.join(SCRATCH, 'dump.html')

/**
 * daemon 没起来。
 *
 * ★ 这里**不能**直接 `process.exit(2)`：那会跳过 `finally`，于是拷进
 *   `apps/web/dist/` 的探针页就留在那儿了（构建产物目录里多出一个不该有的
 *   文件）。所以走异常路径，让 `finally` 收尾。
 */
class DaemonDown extends Error {}

try {
  if (!(await waitFor(base, 20_000))) {
    log(red('✗ 一次性 daemon 没起来。它的输出：'))
    for (const l of daemonLog.split('\n').slice(-12)) log('  ' + l)
    throw new DaemonDown()
  }

  // ══════════════════════════════════════════════════════════════════
  // 造**一条任务**——但绝不造 run
  // ══════════════════════════════════════════════════════════════════
  //
  // ★ 这条是必需的，不是装饰：任务清单的"重复字样"检查最初是**空过**的
  //   ——没有任务时表格一行都不渲染，于是把「等待审核」这句话塞回模板
  //   也照样全绿（变异测试抓到的：变异 3 退出码 0）。表格里必须有行，
  //   那条检查才真的在检查。
  //
  // ★ 只 POST /api/issues，**不建 run**：建 run 就会去调真的 CLI
  //   （NFR-T-01 的底线）。这条路由只 `insertIssue`，不派发执行——所以
  //   它是安全的，而"不派 assignee"是第二道保险。
  // ★ 标题**故意很长**：任务清单是表格，标题是使用者输入的任意文本。
  //   这条夹具用来量"一行能被拉多高"——原先没有上限，一个长标题就能把
  //   整行撑成好几行，列表的节奏全乱。
  const seedTitle =
    '探针用的任务（别动它）：这个标题故意写得非常长，长到足以在列表里换行很多次，' +
    '因为使用者的标题可以是任意长度的一段话，而列表的行高不该由它决定。'
  //
  // ★ 造**两条**：一条长标题、一条短标题。行高"与标题长度无关"这条性质，
  //   只能靠两者对比来断言——写一个魔法阈值（"不超过 64px"）既容易被无关的
  //   间距调整弄红，又挡不住"两个都是 100px"这种真问题。
  try {
    for (const title of [seedTitle, '短标题']) {
      const res = await fetch(`${base}/api/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, description: '由 tools/layout-probe 造的夹具。' }),
      })
      if (!res.ok) log(yellow(`⚠ 造夹具任务失败（HTTP ${res.status}）——任务页那几条检查会空过`))
    }
  } catch (err) {
    log(yellow(`⚠ 造夹具任务时出错：${err}`))
  }

  const outFd = fs.openSync(dumpPath, 'w')
  const errFd = fs.openSync(path.join(SCRATCH, 'chrome.err'), 'w')
  // `--virtual-time-budget` 决定了 dump 的时机：给它足够长，让探针把四步都跑完
  chromeChild = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1400,1200',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=30000',
      '--dump-dom',
      `${base}/${PROBE_NAME}`,
    ],
    { stdio: ['ignore', outFd, errFd] },
  )

  // Chrome 打完 DOM **不会退出**，所以轮询输出文件而不是等它结束
  let parsed = null
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (fs.existsSync(dumpPath)) {
      const p = parseFacts(fs.readFileSync(dumpPath, 'utf8'))
      if (p && p.done === true) {
        parsed = p
        break
      }
    }
    await sleep(400)
  }

  if (!parsed) {
    log(red('✗ 探针没在超时前给出结果（dump 里没有 done:true）'))
    log(dim(`  原始 dump：${path.relative(ROOT, dumpPath)}`))
    log(dim(`  这份构建的 index.html 引用的脚本：`))
    const html = fs.existsSync(dumpPath) ? fs.readFileSync(dumpPath, 'utf8') : ''
    log(dim('  ' + (html.match(/src="\.\/assets\/[^"]+"/)?.[0] ?? '（没抓到）')))
    exitCode = 1
  } else {
    const { facts, errors } = parsed
    const failures = []

    for (const e of errors ?? []) failures.push({ view: '探针', label: e, got: null })

    for (const c of CHECKS) {
      const v = facts[c.key]
      if (v === undefined) {
        failures.push({ view: c.view, label: `${c.label} —— 没量到这个值（选择器可能改了）`, got: null })
        continue
      }
      if (!c.ok(v, facts))
        failures.push({ view: c.view, label: c.label, got: c.show ? c.show(v) : JSON.stringify(v) })
    }

    let lastView = ''
    for (const c of CHECKS) {
      const v = facts[c.key]
      const bad = failures.some((f) => f.label.startsWith(c.label))
      if (c.view !== lastView) {
        log()
        log(c.view)
        lastView = c.view
      }
      const shown = v === undefined ? dim('—') : dim(c.show ? c.show(v) : JSON.stringify(v))
      log(`  ${bad ? red('✗') : green('✓')} ${c.label} ${shown}`)
    }

    log()
    if (failures.length === 0) {
      log(green(`全部通过：${CHECKS.length} 项`))
      exitCode = 0
    } else {
      log(red(`${failures.length} 项没通过（共 ${CHECKS.length} 项）：`))
      for (const f of failures) log(`  ${red('✗')} [${f.view}] ${f.label}${f.got === null ? '' : `　实测 ${f.got}`}`)
      exitCode = 1
    }

    fs.writeFileSync(
      path.join(SCRATCH, 'report.json'),
      JSON.stringify({ at: new Date().toISOString(), facts, errors, failures }, null, 2),
    )
    log()
    log(dim(`量到的事实与报告：${path.relative(ROOT, path.join(SCRATCH, 'report.json'))}`))
  }
} catch (err) {
  if (!(err instanceof DaemonDown)) throw err
  exitCode = 2
} finally {
  if (chromeChild) killChrome(profile, chromeChild)
  if (KEEP) {
    log()
    log(yellow(`--keep：daemon 还开着（PID ${daemon.pid}）→ ${base}/#/agents`))
    log(yellow(`  自己拿浏览器看，用完：kill ${daemon.pid}`))
    daemon.unref()
  } else {
    daemon.kill('SIGTERM')
    await sleep(600)
    try {
      daemon.kill('SIGKILL')
    } catch {}
  }
  // dist 是构建产物，探针页不该留在那儿（下次 build 也会清掉，但别指望它）
  fs.rmSync(probeDst, { force: true })
}

process.exit(exitCode)
