#!/usr/bin/env node
/**
 * 远端管理页的**界面探针**（`pnpm run probe:remote`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它为什么存在（2026-10，D53 / D55）
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon 界面有一条约 470 项常驻探针（`tools/layout-probe/`），而**远端管理页一开始
 * 一项都没有**。2026-10 做界面审查时靠临时量测页量出 7 处问题，其中两处**肉眼看不出来**：
 *
 *   · 同步按钮被同一行的长说明挤成两行 ⇒ 实测 54.4px（该是 35px 那一档）；
 *   · `.table-wrap` 是 `overflow: hidden` ⇒ 窗口一窄，表格右边的列**被裁掉且无法到达**
 *     （daemon 自己那张表在 860px 下裁掉 316px）。
 *
 * 临时脚本用完就删了 ⇒ 下次改界面又只能靠眼睛。这个目录把那套办法**固化**下来：
 * 起一个**一次性远端服务**（数据目录是夹具、同步工具是假脚本、**绝不联网**），
 * 把 `probe.html` 塞进 `apps/remote/web/dist/`（同源，才能量 iframe 里的东西），
 * 用无头 Chrome 跑一遍，读回 JSON，逐条断言。
 *
 * 与 daemon 那条探针同一套分工：**probe.html 只量事实，判据全在本文件**。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const WEB_DIST = path.join(ROOT, 'apps', 'remote', 'web', 'dist')
const SCRATCH = path.join(ROOT, '.cache', 'remote-ui-probe')
const PROBE_NAME = '_remote-ui-probe.html'
const TIMEOUT_MS = Number(process.env['PROBE_TIMEOUT_MS'] ?? 120_000)
const ALLOW_STALE = process.argv.includes('--allow-stale')

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const log = (s = '') => console.log(s)

function fail(code, ...lines) {
  log()
  for (const l of lines) log(red('✗ ') + l)
  process.exit(code)
}

// ── 构建产物必须先于它检查（与 daemon 探针同一条规矩）──
function staleBy() {
  const entry = path.join(WEB_DIST, 'index.html')
  if (!fs.existsSync(entry)) return 'missing'
  const entryMs = fs.statSync(entry).mtimeMs
  let newest = 0
  let newestFile = ''
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(ts|svelte|css)$/.test(e.name)) {
        const ms = fs.statSync(full).mtimeMs
        if (ms > newest) { newest = ms; newestFile = path.relative(ROOT, full) }
      }
    }
  }
  walk(path.join(ROOT, 'apps', 'remote', 'web', 'src'))
  walk(path.join(ROOT, 'packages', 'ui', 'src'))
  walk(path.join(ROOT, 'packages', 'i18n', 'src'))
  return newest > entryMs ? newestFile : null
}

const stale = staleBy()
if (stale === 'missing') {
  fail(2, 'apps/remote/web/dist 里没有 index.html。先跑 `pnpm run build:remote-web`（或 build:web）。')
}
if (stale && !ALLOW_STALE) {
  fail(2, `dist 比源码旧（更新的文件：${stale}）——现在量到的会是旧界面。`, '先跑 `pnpm run build:remote-web`；确实要用旧构建就加 --allow-stale。')
}

function findChrome() {
  if (process.env['CHROME']) {
    return fs.existsSync(process.env['CHROME']) ? process.env['CHROME'] : null
  }
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p)) ?? null
}
const chrome = findChrome()
if (!chrome) {
  fail(2, '找不到 Chrome / Chromium。这条检查需要一个真浏览器（它量的就是浏览器算出来的布局）。', '装了别的浏览器可以用 CHROME=/path/to/chrome pnpm run probe:remote 指定。')
}

// ── 夹具：两个技能（一个带"被清单排除"的记录）、一个手动装的、一份清单配置 ──
fs.rmSync(SCRATCH, { recursive: true, force: true })
const dataDir = path.join(SCRATCH, 'data')
const profile = path.join(SCRATCH, 'chrome-profile')
for (const d of [dataDir, profile]) fs.mkdirSync(d, { recursive: true })

const syncedDir = path.join(dataDir, 'catalog-skills')
const localDir = path.join(dataDir, 'catalog-skills-local')
const writeSkill = (root, slug, body, extra = {}) => {
  fs.mkdirSync(path.join(root, slug), { recursive: true })
  fs.writeFileSync(path.join(root, slug, 'SKILL.md'), body)
  for (const [rel, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, slug, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, slug, rel), text)
  }
}
const indexItem = (slug, over = {}) => ({
  url: `https://github.com/o/r/tree/main/skills/${slug}`,
  slug,
  name: `夹具技能 ${slug}`,
  category: 'other',
  origin: 'community',
  summary: '探针夹具。',
  fills: null,
  needs: '还得配个 key',
  sourceRef: `github:o/r@main:skills/${slug}`,
  version: 'abc1234',
  fetchedAt: '2026-10-05T00:00:00.000Z',
  files: ['SKILL.md'],
  excluded: [],
  ...over,
})

writeSkill(syncedDir, 'probe-synced', '# 同步来的技能\n\n正文正文。')
writeSkill(syncedDir, 'probe-partial', '# 被排除过一部分的技能\n\n正文。')
fs.writeFileSync(
  path.join(syncedDir, '.sync.json'),
  JSON.stringify({
    schema: 'agentdeck/recommended-skills-sync@1',
    syncedAt: '2026-10-05T00:00:00.000Z',
    items: [
      indexItem('probe-synced'),
      indexItem('probe-partial', { excluded: ['docs/', 'assets/big.png'] }),
    ],
  }, null, 2),
)
writeSkill(localDir, 'probe-local', '# 手动装的技能\n\n正文。', { 'extra.md': '支持文件' })
fs.writeFileSync(
  path.join(localDir, '.sync.json'),
  JSON.stringify({
    schema: 'agentdeck/recommended-skills-sync@1',
    syncedAt: '2026-10-05T00:00:00.000Z',
    items: [indexItem('probe-local', { manual: true, version: null })],
  }, null, 2),
)
// 清单配置（D54：工具转存后才存在；这里直接铺一份，好让页面上那行有真实数据可显示）
fs.writeFileSync(
  path.join(dataDir, 'recommended-skills.json'),
  JSON.stringify({
    schema: 'agentdeck/recommended-skills@1',
    verifiedAt: '2026-10-05',
    items: [
      { url: 'https://github.com/o/r/tree/main/skills/probe-synced', name: '夹具技能 probe-synced', category: 'other', summary: 's' },
      { url: 'https://github.com/o/r/tree/main/skills/probe-partial', name: '夹具技能 probe-partial', category: 'other', summary: 's' },
    ],
  }, null, 2),
)
// 假同步工具：**绝不联网**（探针只验界面，不抓东西）
const fakeTool = path.join(SCRATCH, 'fake-sync-tool.mjs')
fs.writeFileSync(fakeTool, "console.log('假同步工具：只打印，不抓取')\n")

fs.copyFileSync(path.join(HERE, 'probe.html'), path.join(WEB_DIST, PROBE_NAME))

async function freePort() {
  const net = await import('node:net')
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const port = await freePort()
const base = `http://127.0.0.1:${port}`
log(dim(`一次性远端服务：${base}（数据在 .cache/remote-ui-probe/，不碰 ~/.agentdeck）`))

const service = spawn(
  process.execPath,
  [
    path.join(ROOT, 'apps', 'remote', 'src', 'cli.ts'),
    '--port', String(port),
    '--data-dir', dataDir,
    '--sync-tool', fakeTool,
  ],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
)
let serviceLog = ''
service.stdout.on('data', (b) => (serviceLog += b))
service.stderr.on('data', (b) => (serviceLog += b))

const killService = () => { try { service.kill('SIGKILL') } catch { /* 已经退出 */ } }
process.on('exit', killService)

// 等它真的在听
let up = false
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  try {
    const res = await fetch(`${base}/api/health`)
    if (res.ok) { up = true; break }
  } catch { /* 还没起来 */ }
}
if (!up) {
  killService()
  fail(2, '一次性远端服务没起来：', serviceLog.split('\n').slice(-6).join('\n'))
}

const outFile = path.join(SCRATCH, 'dom.txt')
const errFile = path.join(SCRATCH, 'chrome.err')
const outFd = fs.openSync(outFile, 'w')
const errFd = fs.openSync(errFile, 'w')
const chromeChild = spawn(chrome, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--window-size=1400,1200',
  `--user-data-dir=${profile}`,
  '--virtual-time-budget=30000',
  '--dump-dom',
  `${base}/${PROBE_NAME}`,
], { stdio: ['ignore', outFd, errFd] })

// Chrome 打完 DOM 不会退出 ⇒ 轮询输出文件
let facts = null
const deadline = Date.now() + TIMEOUT_MS
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 300))
  const dom = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)
  if (!m) continue
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  if (raw.trim() === 'running') continue
  try { facts = JSON.parse(raw); break } catch { /* 还在写 */ }
}
try { chromeChild.kill('SIGKILL') } catch { /* ignore */ }
try { fs.rmSync(path.join(WEB_DIST, PROBE_NAME), { force: true }) } catch { /* ignore */ }

if (!facts) {
  killService()
  const err = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : ''
  fail(2, '探针页面没产出结果（超时）。', err.split('\n').slice(-8).join('\n'))
}

// ── 判据（只在这里；probe.html 只量）──
const box = (b) => b ?? { x: 0, y: 0, w: 0, h: 0 }
const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail })

check('页面挂起来了（#app 有内容）', facts.appFilled)
check('★ 页面有自己的 h1，且页名与侧栏选中项同一句话', facts.h1Count === 1 && facts.pageName === facts.navActive && !!facts.navActive, `h1=${facts.h1Count} 页名=${facts.pageName} 侧栏=${facts.navActive}`)
check(
  '★ 顶栏控件紧凑、宽度按内容（不是"没被样式表管到"的表单控件）',
  facts.topbarSelectBoxes.length > 0 && facts.topbarSelectBoxes.every((b) => b.h <= 36 && b.w < 200),
  JSON.stringify(facts.topbarSelectBoxes),
)
check('顶栏不横向溢出', facts.topbarOverflow === 0, `溢出 ${facts.topbarOverflow}px`)
check(
  '★★ 表格溢出时**可滚动**（`overflow-x` 不是 hidden——hidden 会把列裁掉且拿不回来）',
  facts.tableWrapOverflowCss !== 'hidden',
  `overflow-x=${facts.tableWrapOverflowCss}`,
)
check('表格存在、表头 6 列（技能/来源/版本/文件/抓取于/操作；D69.6 加了来源列）', facts.tableExists && facts.tableHeaders.length === 6, facts.tableHeaders.join(' | '))
check('表格行数 = 夹具的 3 条（2 条同步来的 + 1 条本地装的）', facts.tableRows === 3, `${facts.tableRows} 行`)
check(
  '★★ 同步按钮**不被挤成两行**（高度与主区按钮同一档，≤40px）',
  box(facts.syncButtonBox).h > 0 && box(facts.syncButtonBox).h <= 40,
  `同步按钮 ${box(facts.syncButtonBox).h}px / 行内按钮 ${box(facts.mainRowButtonBox).h}px`,
)
check('同步按钮有标签、旁边有状态文字', !!facts.syncButtonLabel && !!facts.syncStatusText, `${facts.syncButtonLabel} / ${facts.syncStatusText}`)
check(
  '★ 清单那一行是**真实数据**（条数 + 核对于 + 文件名），不是键名也不是硬编码路径',
  typeof facts.manifestLine === 'string' &&
    facts.manifestLine.includes('2 条') &&
    facts.manifestLine.includes('2026-10-05') &&
    facts.manifestLine.includes('recommended-skills.json'),
  facts.manifestLine ?? '(没有这一行)',
)
check('★★ 行内按钮是「查看」/「卸载」（不是重复表头那句话）', facts.firstRowButtonLabels.includes('查看'), facts.firstRowButtonLabels.join(' + '))
check(
  '★★ slug 与来源徽标同一行（徽标在来源列、不许独占一行把整行撑高）',
  facts.slugBox && facts.badgeBox && Math.abs(facts.slugBox.y - facts.badgeBox.y) <= 8,
  `slug y=${box(facts.slugBox).y} badge y=${box(facts.badgeBox).y}`,
)
check(
  '★ 来源徽标两种都出现（推荐清单 / 本地添加）',
  facts.badgeTexts.includes('推荐清单') && facts.badgeTexts.includes('本地添加'),
  facts.badgeTexts.join(' | '),
)
check('★ 「内容不完整」在页面上有提示（被清单排除过的那条）', facts.incompleteNotes.length >= 1, facts.incompleteNotes.join(' | '))
check('★ ★ 来源标识单行省略生效（`.source-ref` 样式是 app.css 共用的；remote 原来没有这条样式、会折行）', facts.sourceRefNowrap === 'nowrap', `white-space=${facts.sourceRefNowrap ?? '(没有 source-ref)'}`)
check('★ ★ 来源串（`github:…`）在「来源」列而不是技能列（使用者报过的位置问题）', facts.sourceColumnPlacement === true, `sourceColumnPlacement=${facts.sourceColumnPlacement}`)
check('★ ★ 版本统一 v 前缀 + 无版本号（与 daemon 同一档）', Array.isArray(facts.versionCellTexts) && facts.versionCellTexts.includes('vabc1234') && facts.versionCellTexts.some((t) => t.includes('无版本号')), facts.versionCellTexts.join(' | '))
check('★ ★ 文件列与 daemon 同一档（`SKILL.md` + 支持文件数；没有"个文件"式显示）', Array.isArray(facts.filesCellTexts) && facts.filesCellTexts.some((t) => t === 'SKILL.md') && !facts.filesCellTexts.some((t) => t.includes('个文件')), facts.filesCellTexts.join(' | '))
check('★ 同步来的那条不给卸载（按钮置灰 + title 说清该怎么做）', facts.disabledRowButtons.some((b) => b.label === '卸载' && b.title.length > 0), JSON.stringify(facts.disabledRowButtons))
check('安装表单在（可折叠 + 链接输入框）', facts.installFormPresent && facts.installUrlPresent && !!facts.installFormSummary, facts.installFormSummary ?? '')
check('★ 页面里没有未翻译的键名（`remote.xxx`）', (facts.untranslatedKeys ?? []).length === 0, (facts.untranslatedKeys ?? []).join(', '))
check('★ 点「查看」开出抽屉，里面有 SKILL.md 正文', facts.drawerOpened && facts.drawerHeadHasH2 && facts.drawerContentLength > 5, `正文 ${facts.drawerContentLength} 字`)
check('★★ 首行有 ▸ chevron、点它也能开抽屉（remote 之前没有 ▸，D69.8 补上）', facts.expandTogglePresent === true && facts.expandToggleOpensDrawer === true, `present=${facts.expandTogglePresent} opens=${facts.expandToggleOpensDrawer}`)
check('★ 抽屉里显示「需要配置」（装了才发现要配 key 是最糟的一种失败）', facts.drawerShowsNeeds === true, `drawerShowsNeeds=${facts.drawerShowsNeeds}`)
check('★ Esc 关得掉抽屉', facts.drawerClosedByEsc)
check('★★ 点「卸载」弹的是**自己画的**确认框（`.modal`），不是 window.confirm', facts.confirmModalOpened && /确定从远端目录里卸掉/.test(facts.confirmModalText ?? ''), (facts.confirmModalText ?? '').slice(0, 40))
check('★ 取消确认框 ⇒ 关掉，且那一行**还在**（确认框不是装饰）', facts.confirmModalClosed && facts.rowCountAfterCancel === 3, `行数 ${facts.rowCountAfterCancel}`)

killService()

// ── 报告 ──
log()
let failed = 0
for (const c of checks) {
  if (c.ok) log(`${green('✓')} ${c.name} ${dim(c.detail)}`)
  else { failed += 1; log(`${red('✗')} ${red(c.name)} ${dim(c.detail)}`) }
}
const reportPath = path.join(SCRATCH, 'report.json')
fs.writeFileSync(reportPath, JSON.stringify({ facts, checks }, null, 2))
log()
if (failed > 0) {
  log(red(`✗ ${failed} 项没过（共 ${checks.length} 项）`))
  log(dim(`量到的事实与报告：${path.relative(ROOT, reportPath)}`))
  process.exit(1)
}
log(green(`全部通过：${checks.length} 项`))
log(dim(`量到的事实与报告：${path.relative(ROOT, reportPath)}`))
