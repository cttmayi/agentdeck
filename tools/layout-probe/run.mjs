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

/**
 * 两份"契约值名单"是不是**同一份**（集合比较，与顺序无关）。
 *
 * ★ 顺序无关不是讲究：勾选的那一份、工具清单列出来的那一份、审核者当初存进去的
 *   那一份，三者的顺序都可能不同（探针上报时已经排过序，这里再比一次是防"哪天
 *   上报忘了排"）。写成 `JSON.stringify(a) === JSON.stringify(b)` 会把"顺序不同"
 *   读成"内容不同"，而界面上两者一模一样。
 */
const sameSet = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((x) => b.includes(x))

// ══════════════════════════════════════════════════════════════════════
// 「新建任务」三步链的夹具（名字与动作在此定义：造夹具与 CHECKS 共用一份）
// ══════════════════════════════════════════════════════════════════════
//
// ★ 三个名字**必须**与既有夹具不同，而且不能互相是子串：探针里大量按
//   "行的文字里含这个名字"找 agent（`row.textContent.includes(name)`），
//   名字撞上或互为子串就会点到别人那一行上，而症状是"读到的值莫名其妙"。
//
// ⚠️ 这两个审核者**刻意都不叫「探针用的执行者」/「探针用的老形态审核者」**：
//    前者是"工具挂给了谁"与"换默认"那两段的夹具，后者是 D38 迁移那一段的
//    夹具（它必须在跑到那一段时还是"只挂 skill、没有内联标准"的老形态）。
//
// ⚠️ 三个新 agent 都**不抢"默认"那个位置**：默认由播种的那个执行者当着，
//    `defaultAgent.*` 那一组（徽章只有一个、预选的是设过的那个）靠的就是它。
const CHAIN_EXECUTOR = '探针用的三步链执行者'
const CHAIN_REVIEWER = '探针用的三步链审核者'
const CHAIN_EMPTY_REVIEWER = '探针用的空权限审核者'
/** 那个审核者的动作权限：**已装**工具包里的一个动作（契约值 `<slug>.<动作名>`）。 */
const CHAIN_ACTION = 'probe-tool.clean-notes'

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
  {
    view: '任务清单',
    key: 'tasks.boardButtonFound',
    label: '看板/列表可以切换（下面两条要在看板里量）',
    ok: (v) => v === true,
  },
  {
    view: '任务清单',
    key: 'tasks.boardColumnCount',
    label: '★ 看板是**五档**状态（执行中 / 待审查 / 行动中 / 等待人处理 / 已完成审查）',
    ok: (v) => v === 5,
    show: (v) => `${v} 列`,
  },
  {
    view: '任务清单',
    key: 'tasks.boardHasActingColumn',
    label: '★ 「行动中」有自己的一列（判决要求做的动作还没做完时不再显示成"已审查"）',
    ok: (v) => v === true,
  },
  {
    view: '任务清单',
    key: 'tasks.boardColumns',
    label: '★ 「待人工」排在「已审查」之前——从左往右越来越接近结束',
    ok: (v) =>
      Array.isArray(v) &&
      v.some((t) => t.includes('等待人处理')) &&
      v.findIndex((t) => t.includes('等待人处理')) <
        v.findIndex((t) => t.includes('已完成审查')),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
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
    key: 'skills.uninstallButtonFound',
    label: '★ 每行有「卸载」（D38 补齐：原来"装了要删只有改库"）',
    ok: (v) => v === true,
  },
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

  // ── 侧边栏第五项 + 工具页（D40）──
  //
  // ★ **"侧边栏恰好四项"这条从 D40 起改成五项**：使用者点名要「工具」作为
  //   第五项（排在 Skills 之后），所以这里量的是**恰好 5 项**且最后一项是
  //   「工具」。原来那一版只有"四项够用"的说法（写在 `Sidebar.svelte` 的注释与
  //   README 里），探针里并没有直接的计数断言——所以这一条是**新加的**，
  //   它同时守住两处联动：`view.ts` 的 `VIEWS` 与 `Sidebar.svelte` 的 `ITEMS`，
  //   少动一处不会报错，只表现为"视图打不开 / 侧边栏点不到它"。
  {
    view: '工具（D40）',
    key: 'shell.navItemCount',
    label: '★ 侧边栏是五项（D40 起「工具」是第 5 项）',
    ok: (v) => v === 5,
    show: (v) => `${v} 项`,
  },
  {
    view: '工具（D40）',
    key: 'shell.navLastItem',
    label: '★ 最后一项就是「工具」（排在 Skills 之后）',
    ok: (v) => v === '工具',
  },
  {
    view: '工具（D40）',
    key: 'shell.navItems',
    label:
      '★★ 侧边栏**整串顺序**就是这五项（顺序错、中间少/换一项、多出第 6 项都会红——只数个数＋看末项会漏掉中间那几种）',
    ok: (v) =>
      JSON.stringify(v) ===
      JSON.stringify(['新建任务', '任务清单', '智能体', 'Skills', '工具']),
    show: (v) => (Array.isArray(v) ? v.join(' → ') : String(v)),
  },
  { view: '工具（D40）', key: 'tools.title', label: '工具页渲染出来了', ok: (v) => v === '工具' },
  {
    view: '工具（D40）',
    key: 'tools.fixtureFound',
    label: '★ 列表里有夹具工具（否则下面几条会空过）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.fixtureActionCell',
    label: '★ 那一行的**动作数**是 2（一个组里有几个动作）',
    ok: (v) => typeof v === 'string' && v.includes('2'),
  },
  {
    view: '工具（D40）',
    key: 'tools.fixtureMountedBy',
    label: '★ 那一行说得出它挂给了哪个 agent（挂载关系是卸载能否成功的前提）',
    ok: (v) => typeof v === 'string' && v.includes('探针用的执行者'),
  },
  {
    view: '工具（D40）',
    key: 'tools.actionTypes',
    label: '★ 点开一行看得到组内动作，且动作名是契约值 `<slug>.<动作名>`',
    ok: (v) =>
      Array.isArray(v) &&
      v.length === 2 &&
      v.includes('probe-tool.append-note') &&
      v.includes('probe-tool.clean-notes'),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '工具（D40）',
    key: 'tools.irreversibleFlag',
    label: '★ `reversible: false` 的动作显式标了「不可回滚」',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.noDryRunFlag',
    label: '★ `dryRun: unsupported` 的动作显式标了「不支持预演，不能自动执行」',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.boundGroupNote',
    label: '★ 绑定参数单独成组，并写明"模型看不到也填不了"',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.openGroupNote',
    label: '模型可填的参数单独成组（显示类型与上限）',
    ok: (v) => v === true,
  },
  { view: '工具（D40）', key: 'tools.installButtonFound', label: '标题栏有「安装工具」', ok: (v) => v === true },
  {
    view: '工具（D40）',
    key: 'tools.drawerAtRight',
    label: '★ 安装抽屉开在**右侧**（贴住视口右边缘）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.drawerWidth',
    label: '抽屉是宽版 46rem(736px)（那张表有六列）',
    ok: (v) => near(v, 736, 4),
    show: (v) => `${v}px`,
  },
  { view: '工具（D40）', key: 'tools.drawerBackdrop', label: '有背景遮罩（点它可关）', ok: (v) => v === true },
  {
    view: '工具（D40）',
    key: 'tools.installFailureShown',
    label: '★ 装坏包时显示失败块（不是只给一句"安装失败"）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.installFailureDetailLines',
    label: '★ 后端给的 detail 本身**是多行**的（`missing_entry` 那条是两行）',
    ok: (v) => typeof v === 'number' && v >= 2,
    show: (v) => `${v} 行`,
  },
  {
    view: '工具（D40）',
    key: 'tools.installFailureDetailKeepsLines',
    label: '★ 那个多行 detail 是按多行**显示**的（`pre-wrap`，不是被折成一坨）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.installFailureHint',
    label: '★ 失败时还给了"那我该怎么做"（按错误码）',
    ok: (v) => typeof v === 'string' && v.length > 10,
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 26)}…"`),
  },
  {
    view: '工具（D40）',
    key: 'tools.installSuccess',
    label: '★ 从抽屉里真的装得进一个包（输入框 → 检查并安装）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.installSuccessListsWhat',
    label: '★ 装完说清了**装进来什么**（动作与文件都列出来）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.rowsAfterUiInstall',
    label: '★ 装完列表**立刻**多了一条（不是刷新才看见）',
    ok: (v) => typeof v === 'number' && v >= 2,
    show: (v) => `${v} 行`,
  },
  { view: '工具（D40）', key: 'tools.drawerGoneAfterEsc', label: 'Esc 能关掉安装抽屉', ok: (v) => v === true },
  {
    view: '工具（D40）',
    key: 'tools.detailSectionForExecutor',
    label: '★ 执行者的详情里有「干活时能用的工具包」那一段，并列出挂着的组',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.detailMountHintWording',
    label: '★ 执行者工具段的挂载说明说清"挂载 = 送进它的工作目录"（D42：两个行为面分开，不再说"把整组动作交给它"）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.detailPickerHasFixture',
    label: '编辑态里能勾到已安装的组（挂载单位是组）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.mountSaveTookEffect',
    label: '★ 摘挂保存之后详情**真的刷新**（摘掉之后那一段就不再显示它）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.mountRestoreTookEffect',
    label: '★ 再挂回去同样生效（来回走的都是接口，不是本地勾选的样子）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.reviewerHasNoToolsSection',
    label: '★ 审核者的详情里**没有**工具那一段（只判断不动手，不给必然失败的开关）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'standard.formToolActions',
    label: '★ 「行动权限」里能勾到**已装工具的动作**（值是 `<slug>.<动作名>`）',
    ok: (v) => Array.isArray(v) && v.includes('probe-tool.append-note'),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '工具（D40）',
    key: 'standard.formToolSummaryShown',
    label: '★ 工具动作旁边带着它的 `summary`（不然勾选变成对着一串机器名猜）',
    ok: (v) => typeof v === 'string' && v.length > 4,
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 24)}…"`),
  },

  // ── 新建表单 / 设置：右侧抽屉（D32）──
  //
  // 这两个面板在左栏里待过两版都不行：一版按 max-width 画成 736px 横着盖住
  // 右栏（栏头 167px → 1070px、清单被顶出视口），一版不溢出但只有 358px 宽、
  // 模版编辑器没法用。现在两个都是**右侧抽屉**。
  //
  // 这一组量的是**容纳关系**（在不在该在的地方、够不够宽、有没有溢出）——
  // 上一版正是"量外观的检查全绿，而布局已经垮了"。
  { view: '新建表单 / 设置', key: 'template.openButtonFound', label: '智能体页有「新建」入口', ok: (v) => v === true },
  { view: '新建表单 / 设置', key: 'template.openButtonLabel', label: '按钮文案就是「新建」', ok: (v) => v === '新建' },
  { view: '新建表单 / 设置', key: 'template.settingsButtonFound', label: '★「设置」就在「新建」旁边', ok: (v) => v === true },
  { view: '新建表单 / 设置', key: 'template.settingsButtonLabel', label: '按钮文案就是「设置」（不是"第一句话设置"）', ok: (v) => v === '设置' },
  {
    view: '新建表单 / 设置',
    key: 'template.oldSettingsLabelGone',
    label: '界面上不再有「第一句话设置」这个更长的名字',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.settingsButtonIsSecondary',
    label: '设置入口是次要按钮（主操作仍然是「新建」）',
    ok: (v) => v === true,
  },
  { view: '新建表单 / 设置', key: 'template.formOpened', label: '点「新建」后出现抽屉', ok: (v) => v === true },
  { view: '新建表单 / 设置', key: 'template.formDrawerTitle', label: '抽屉标题是「新建智能体」', ok: (v) => v === '新建智能体' },
  { view: '新建表单 / 设置', key: 'template.formHasBackdrop', label: '有背景遮罩（点它可关）', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'template.formAtRight',
    label: '★ 抽屉贴在**右边**（使用者要求：放在最右边打开）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formWidthPx',
    label: '抽屉宽度（不再是左栏那个 416px 的宽度）',
    ok: (v) => typeof v === 'number' && v > 600,
    show: (v) => `${v}px`,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formInsidePane',
    label: '★ 抽屉不在主从两栏里（在栏里就会被挤窄或被撑爆）',
    ok: (v) => v === false,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formInsideHead',
    label: '★ 抽屉更不在栏头里（曾经它在，于是整垮了主从布局）',
    ok: (v) => v === false,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.headGrowthPx',
    label: '★ 打开抽屉后栏头高度不变',
    ok: (v) => v === 0,
    show: (v) => `涨了 ${v}px`,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formOverflowX',
    label: '抽屉内部没有横向溢出',
    ok: (v) => v === 0,
    show: (v) => `${v}px`,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formHasNoTemplateField',
    label: '★ 新建表单里**没有**模版那一栏（它是通用配置，不是每个 agent 一份）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.footVisible',
    label: '主操作常驻在视口内（表单长也不用先滚到底）',
    ok: (v) => v === true,
  },
  { view: '新建表单 / 设置', key: 'template.footPrimaryLabel', label: '底部主操作是「创建」', ok: (v) => v === '创建' },
  {
    view: '新建表单 / 设置',
    key: 'template.formGoneAfterEsc',
    label: '★ Esc 能关掉抽屉（Esc 在抽屉组件里统一处理）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.listBackAfterEsc',
    label: '关掉之后 agent 清单还在（抽屉没把列表吃掉）',
    ok: (v) => v === true,
  },

  // ── 设置抽屉 ──
  { view: '新建表单 / 设置', key: 'settings.panelOpened', label: '点「设置」后出现抽屉', ok: (v) => v === true },
  { view: '新建表单 / 设置', key: 'settings.drawerTitle', label: '★ 抽屉标题就是「设置」（不是"第一句话设置"）', ok: (v) => v === '设置' },
  { view: '新建表单 / 设置', key: 'settings.hasBackdrop', label: '设置有遮罩', ok: (v) => v === true },
  { view: '新建表单 / 设置', key: 'settings.isWide', label: '设置用的是宽抽屉（46rem）', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.panelWidthPx',
    label: '设置抽屉宽度（模版这种长文本要够宽）',
    ok: (v) => typeof v === 'number' && v > 600,
    show: (v) => `${v}px`,
  },
  { view: '新建表单 / 设置', key: 'settings.panelAtRight', label: '★ 设置抽屉也在右边', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.panelInsidePane',
    label: '★ 设置抽屉不在主从两栏里',
    ok: (v) => v === false,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.headGrowthPx',
    label: '★ 打开设置抽屉后栏头高度不变',
    ok: (v) => v === 0,
    show: (v) => `涨了 ${v}px`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.panelOverflowX',
    label: '设置抽屉内部没有横向溢出',
    ok: (v) => v === 0,
    show: (v) => `${v}px`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.sectionCount',
    label: '★ 它是"装设置的容器"：正文是分段（`.drawer-section`）的，以后好往里加',
    ok: (v) => typeof v === 'number' && v >= 1,
    show: (v) => `${v} 段`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.sectionTitles',
    label: '现在这一段叫「第一句话模版」',
    ok: (v) => Array.isArray(v) && v.includes('第一句话模版'),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.footSaveLabel',
    label: '底部是一个共用的「保存」（将来的设置也走它）',
    ok: (v) => v === '保存',
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.tabLabels',
    label: '★ 段里两个页签：执行 / 审核',
    ok: (v) => Array.isArray(v) && v.length === 2 && v[0] === '执行' && v[1] === '审核',
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  { view: '新建表单 / 设置', key: 'settings.activeTab', label: '默认停在「执行」', ok: (v) => v === '执行' },
  { view: '新建表单 / 设置', key: 'settings.tplFieldPresent', label: '有模版输入框', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.tplFieldWidthPx',
    label: '★ 模版输入框比左栏宽得多（这正是要抽屉的原因）',
    ok: (v) => typeof v === 'number' && v > 550,
    show: (v) => `${v}px`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.tplFieldHeightEmptyPx',
    label: '★ 空的模版也有一个像样的高度下限（别只给 8 行）',
    ok: (v) => typeof v === 'number' && v >= 300,
    show: (v) => `${v}px`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.tplFieldHeightExecPx',
    label: '执行那份填进去之后也不低于下限',
    ok: (v) => typeof v === 'number' && v >= 300,
    show: (v, facts) => `${v}px（${facts['settings.execFilledLines']} 行）`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.reviewFilledLines',
    label: '审核那份填进去的是那几十行默认模版（否则下面那条高度断言会空过）',
    ok: (v) => typeof v === 'number' && v >= 20,
    show: (v) => `${v} 行`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.tplFieldHeightReviewPx',
    label: '★ 输入框跟着内容长高（使用者点名"填写框太小，不利用看内容"）',
    ok: (v, facts) =>
      typeof v === 'number' &&
      v > 500 &&
      v > (facts['settings.tplFieldHeightEmptyPx'] ?? 0),
    show: (v, facts) => `${v}px（空框 ${facts['settings.tplFieldHeightEmptyPx']}px）`,
  },
  { view: '新建表单 / 设置', key: 'settings.badgeBefore', label: '没设过时状态是「平台默认」', ok: (v) => v === '平台默认' },
  { view: '新建表单 / 设置', key: 'settings.fillButtonFound', label: '有「填入默认模版」', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.filledHasPrompt',
    label: '填入默认模版后框里真的有变量 {{prompt}}',
    ok: (v) => v === true,
  },
  { view: '新建表单 / 设置', key: 'settings.filledBadge', label: '填完之后状态变「自定义」', ok: (v) => v === '自定义' },
  {
    view: '新建表单 / 设置',
    key: 'settings.reviewBadgeWhileExecuteCustom',
    label: '★ 切到「审核」页签时它是**独立的**一份（执行改了不动审核）',
    ok: (v) => v === '平台默认',
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.reviewFilledHasMaterial',
    label: '审核那份填入默认后带 {{material}}（两份各有各的必需变量）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.varRowCount',
    label: '变量清单真的列出了变量（不是空表）',
    ok: (v) => typeof v === 'number' && v >= 5,
    show: (v) => `${v} 行`,
  },
  { view: '新建表单 / 设置', key: 'settings.varHasPrompt', label: '变量清单里有 {{prompt}}', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.varListHasNoRoleVar',
    label: '★ 变量清单里没有 {{role}}（D33：它自带标题、与 {{instructions}} 重名同事，已取消）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.varHasInstructions',
    label: '变量清单里有 {{instructions}}（内容那个）',
    ok: (v) => v === true,
  },
  { view: '新建表单 / 设置', key: 'settings.varMarksRequired', label: '必需的变量上标了「必需」', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.previewHasHeader',
    label: '★ 审核那份的预览里是「# 审核任务」（说明预览走的是真渲染器）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.previewHasSampleMaterial',
    label: '预览用的是示例材料（明说了不是你的真实数据）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.previewHasNoRawVar',
    label: '预览里没有没展开的变量',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.previewOverflowX',
    label: '预览块内部没有横向溢出',
    ok: (v) => v === 0,
    show: (v) => `${v}px`,
  },
  { view: '新建表单 / 设置', key: 'settings.saveButtonFound', label: '有「保存」', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.panelClosedAfterSave',
    label: '保存之后抽屉关掉（不用再点一次取消）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.savedExecute',
    label: '★ 保存真的落库了（直接问接口：执行那份非空）',
    ok: (v) => v === true,
  },
  { view: '新建表单 / 设置', key: 'settings.savedReview', label: '★ 审核那份也落库了', ok: (v) => v === true },
  {
    view: '新建表单 / 设置',
    key: 'settings.reopenedBadge',
    label: '★ 重开设置时看到的就是刚存下的那份（显示与生效是同一份）',
    ok: (v) => v === '自定义',
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.goneAfterEsc',
    label: 'Esc 能关掉设置抽屉',
    ok: (v) => v === true,
  },

  // ── 审核标准（D37）──
  //
  // 标准从 skill 里搬到审核者身上之后，界面上必须有地方看见它、写它——
  // 否则"标准在哪"这件事又变成要读代码才知道。
  {
    view: '审核标准',
    key: 'standard.detailHasName',
    label: '★ 审核者详情里看得到标准的名字',
    ok: (v) => typeof v === 'string' && v.length > 0,
  },
  {
    view: '审核标准',
    key: 'standard.detailShowsBody',
    label: '★ 标准正文就在详情里（不用去 Skills 页对着 slug 猜）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.detailHasActionsSection',
    label: '★ 审核者详情里有**独立**的「行动权限」那一段（D40 收口：不再长在审核标准里）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.detailActionsSectionTitle',
    label: '★ 那一段的标题就是「行动权限…」（靠它认出容器，后面几条都在容器里量）',
    ok: (v) => typeof v === 'string' && v.startsWith('行动权限'),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '审核标准',
    key: 'standard.executorHasNoActionsSection',
    label: '★ 执行者的详情里**没有**「行动权限」段（它的能力是工具，不给必然失败的勾选）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.detailActionChips',
    label: '★ 它判完能触发哪些动作在**「行动权限」那一段里**看得见（"允许触发的动作"那一行）',
    ok: (v) => Array.isArray(v),
    show: (v) => (Array.isArray(v) ? v.join(' | ') || '(空)' : String(v)),
  },
  {
    view: '审核标准',
    key: 'standard.detailActionSource',
    label:
      '★ 界面上那一行显示的**逐字等于**接口回给它的 `allowedActions`（契约值原样显示，不翻译也不改写）',
    // ⚠️ D41 换掉了原来的判据（"chips 里有 `comment.create`"）：内置动作整组
    //    被移除之后，那个名字量的是旧现实，而它的红绿取决于夹具里存着什么。
    //    现在量的是**两份事实的关系**：页面上那些 chip 的集合 = 库里那份白名单。
    //    这仍然是一条硬判据（少一个、多一个、被翻译过都会红），而且不依赖
    //    "我期待某一个具体的动作名"。
    ok: (v, facts) => {
      const src = facts['standard.detailActionSource']
      const chips = facts['standard.detailActionChips']
      if (!Array.isArray(src) || !Array.isArray(chips)) return false
      return JSON.stringify([...chips].sort()) === JSON.stringify([...src].sort())
    },
    show: (v, facts) =>
      `${JSON.stringify(v)} vs 接口 ${JSON.stringify(facts['standard.detailActionSource'])}`,
  },
  {
    view: '审核标准',
    key: 'standard.detailActionsOutOfStandard',
    label: '★ 那份动作清单**不再**出现在「审核标准」那一行里（同一件事只有一个出处）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.actionsHintAbsentWhenSet',
    label: '★ 它自己已经有动作权限时，**不**说"动作来自那些 skill"（那句话会变假）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.emptyWarning',
    label: '有标准的审核者不该显示"审不了任何东西"那条警告',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formHasEditorForExecutor',
    label: '新建表单：执行角色下**不**出现标准栏',
    ok: (v) => v === false,
  },
  {
    view: '审核标准',
    key: 'standard.formActionsAbsentForExecutor',
    label: '★ 执行角色下**连行动权限那一栏都没有**（更不会预勾；它的能力是工具）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formHasEditorForReviewer',
    label: '★ 切到审核角色 ⇒ 出现审核标准编辑栏',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formActionsBlockLabel',
    label: '★ 动作勾选长在**「行动权限」那一栏的容器里**（不是靠数字巧合）',
    ok: (v) => typeof v === 'string' && v.startsWith('行动权限'),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '审核标准',
    key: 'standard.formNoBuiltinGroup',
    label: '★ D41：那一栏里**没有**内置动作那一组（它的容器 `.action-picker` 一处都不该有）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formActionOptions',
    label:
      '★ 那一栏里的勾选项**全部**是已装工具包的动作（`<slug>.<动作名>`，slug 取自接口回的已装列表）',
    // ⚠️ 这条才是"动作只能来自工具包"在界面上的落点：只量"没有内置动作那一组"
    //    的话，把那一组换个类名重新长出来照样绿。
    ok: (v, facts) => {
      const slugs = facts['standard.installedSlugs']
      if (!Array.isArray(v) || v.length === 0 || !Array.isArray(slugs)) return false
      return v.every(
        (x) => typeof x === 'string' && slugs.some((s) => x.startsWith(`${s}.`)),
      )
    },
    show: (v, facts) =>
      `${Array.isArray(v) ? v.join(' | ') : String(v)}（已装 slug：${JSON.stringify(facts['standard.installedSlugs'])}）`,
  },
  {
    view: '审核标准',
    key: 'standard.formDefaultAction',
    label: '★ 一个都不**预勾**（内置动作没得勾了，工具动作由使用者自己决定）',
    ok: (v) => v === '',
  },
  {
    view: '审核标准',
    key: 'standard.formToolTickBoxFound',
    label: '★ 那一栏里勾得到夹具工具的动作（否则下面那条退化成空过）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formTickSurvivesTyping',
    label: '★ 写下标准正文之后勾着的那一个**还在**（标准与权限是两份草稿，互不覆盖）',
    ok: (v) => v === 'probe-tool.append-note',
  },
  {
    view: '审核标准',
    key: 'standard.formStandardEditorIsNameAndBody',
    label: '★ 标准编辑器容器里是**名字 + 正文**（与动作块拆成两处）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formStandardEditorHasNoActions',
    label: '★ 标准编辑器容器里**没有**动作勾选了（它已经搬到「行动权限」段）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formStandardReachesParent',
    label: '★ 标准栏与父组件是**通的**：写下正文后状态徽章从「没有标准」变「已写」',
    ok: (v) => v === '已写',
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '审核标准',
    key: 'standard.actionEditSaved',
    label:
      '★ 在详情里勾一个**工具动作**（`probe-tool.append-note`）、保存之后真的多出那一条（写入口走通了）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.actionSummaryAfterSave',
    label: '★ 只读态那一条 chip 旁边带着它的 `summary`（契约值 + 清单里那句话）',
    ok: (v) => v === '把一句话追加到工作目录的 NOTES.md',
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '审核标准',
    key: 'standard.actionSavedOnServer',
    label: '★ 而且**接口上**也真的变了（不是只把界面画对了）',
    ok: (v) => v === true,
    show: (v, facts) => `${v}（接口回：${JSON.stringify(facts['standard.serverAllowedActions'])}）`,
  },
  {
    view: '审核标准',
    key: 'standard.formMentionsNoSkillNeeded',
    label: '界面说清了"判断依据是标准，不是 skill"',
    ok: (v) => v === true,
  },

  // ── 迁移：把挂载的 skill 转成内联标准（D38）──
  //
  // 使用者的真实处境：他删不掉 general-review，因为审核者还挂着它、而且标准正来自它。
  // 这一步就是那个出口，所以必须端到端量（按钮 → 标准出现、挂载清空）。
  {
    view: '迁移（D38）',
    key: 'migrate.legacyFixtureFound',
    label: '★ 夹具里有一个"只挂 skill、没有内联标准"的审核者（否则下面会空过）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.buttonFound',
    label: '★ 老形态审核者的详情页有「把挂载的 skill 转成内联标准」',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.detailSwitched',
    label: '★ 右栏真的换成了那个老形态审核者（否则下面读到的是上一个 agent）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyHintBefore',
    label: '点之前那一段显示的是"沿用挂载的 skill"',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyHintGone',
    label: '点之后那句提示消失（不再是老形态了）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.adopted',
    label: '★ 点完之后标准真的固化到它身上了',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyAgentFound',
    label: '夹具 agent 的 id 拿到了（下面那条要按 id 问接口）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.mountCleared',
    label: '★ 挂载同时被摘掉（于是那条 skill 才卸得掉）——**按接口上的 skillIds 判**，不扫页面文字',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyActionsHintShown',
    label: '★ 老数据（动作写在**挂载的 skill** 里）时「行动权限」段说清了出处：一个都没勾也能触发',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyBothHintsTogether',
    label:
      '★★ 老形态下**两条提示在同一屏上一起看得见**（"标准沿用挂载的 skill" + "动作也来自这些 skill"——"都还是老形态"只有合起来才说得清）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyActionsNoFalseClaim',
    label: '★ 同一段里**没有**同时说"只报告、不动作"（列表空是因为白名单住在 skill 里）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyActionsHintGone',
    label: '★ 固化（挂载被摘掉）之后那句提示跟着消失（再说就是假话）',
    ok: (v) => v === true,
  },

  // ── 默认智能体（D36）──
  //
  // 端到端那一组：点按钮 → 徽章**移到**刚点的那张卡上（且仍然只有一个）→
  // 新建任务页预选它。布局那几条是第二轮反馈加的：开关必须在卡片**里面**、
  // 整行不许溢出（第一版溢出 54px，栏里多出一条横向滚动条）。
  {
    view: '默认智能体',
    key: 'defaultAgent.executorCount',
    label: '★ 至少有两个执行者，才测得了"换默认"',
    ok: (v) => typeof v === 'number' && v >= 2,
    show: (v) => `${v} 个`,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.badgeCount',
    label: '★ 界面上「默认」徽章**有且只有一个**（必须有一个默认）',
    ok: (v) => v === 1,
    show: (v) => `${v} 个`,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.noCancelButton',
    label: '★ 没有「取消默认」这种说法（要换就设成另一个）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.setButtonCount',
    label: '★ 其余每个执行者卡片上都有「设为默认」',
    ok: (v) => typeof v === 'number' && v >= 1,
    show: (v) => `${v} 个`,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.noButtonOnReviewer',
    label: '审核者的卡片上没有这个开关（任务不会交给它）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.rowFitsPane',
    label: '★ 带开关那一行不超出左栏（第一版溢出 54px）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.switchInsideRow',
    label: '★ 开关在卡片的边框**里面**（不是挂在边框外）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.rowOverflowX',
    label: '卡片内部没有横向溢出',
    ok: (v) => v === 0,
    show: (v) => `${v}px`,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.paneBodyOverflowX',
    label: '★ 左栏正文没有横向溢出（第一版这里是 54px）',
    ok: (v) => v === 0,
    show: (v) => `${v}px`,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.setButtonFound',
    label: '找得到一个「设为默认」按钮',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.badgeMovesToTarget',
    label: '★★ 点完之后「默认」徽章**移到刚点的那张卡**上（原来那个自动让位）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.badgeStillExactlyOne',
    label: '设完之后徽章仍然只有一个（单选，不是两个都亮）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.noCancelAfterSet',
    label: '设完之后界面上依然没有「取消默认」',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.targetHasNoToggle',
    label: '已经是默认的那个不再显示开关（徽章已经说明了）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.optionMarked',
    label: '新建任务页的选择器里，那一项标着「（默认）」',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.selectListsOnlyExecutors',
    label: '★ 选择器里**只有执行者**（原来默认选中的甚至是个审核员）',
    ok: (v) => v === true,
  },
  {
    view: '默认智能体',
    key: 'defaultAgent.preselected',
    label: '★★ 新建任务页**预选**的就是设过的那个 agent',
    ok: (v, facts) =>
      typeof v === 'string' && v.length > 0 && v === facts['defaultAgent.targetName'],
  },

  // ── 语言切换（D39）──
  //
  // 这一段跑在**最后**（前面全是中文断言），并且在末尾切回中文。
  {
    view: '语言切换',
    key: 'lang.switchPresent',
    label: '★ 顶栏有语言切换器',
    ok: (v) => v === true,
  },
  {
    view: '语言切换',
    key: 'lang.defaultIsZh',
    label: '默认是中文（既有数据/文档/断言的语言）',
    ok: (v) => v === 'zh',
  },
  { view: '语言切换', key: 'lang.navBefore', label: '切换前导航是中文', ok: (v) => v === '新建任务' },
  {
    view: '语言切换',
    key: 'lang.switchedToEn',
    label: '★ 切到 English 之后界面真的变英文（响应式没断）',
    ok: (v) => v === true,
  },
  { view: '语言切换', key: 'lang.navAfter', label: '导航变成 New task', ok: (v) => v === 'New task' },
  {
    view: '语言切换',
    key: 'lang.settingsLabel',
    label: '顶栏那个按钮也变成 Settings',
    ok: (v) => v === 'Settings',
  },
  {
    view: '语言切换',
    key: 'lang.contractValuesUntranslated',
    label:
      '★ 契约值（`probe-tool.append-note` 这类机器值）**不翻译**（探针刚走真实写入口把它勾上去）',
    ok: (v) => v === true,
  },
  {
    view: '语言切换',
    key: 'lang.stageShort',
    label: '★ 阶段短标签也翻（推导层给的是文案键，不是中文句子）',
    ok: (v) => v === 'Running',
  },
  {
    view: '语言切换',
    key: 'lang.stageNote',
    label: '★ 行内提示也翻（`noteId` 这条路是通的）',
    ok: (v) => v === 'Not started yet',
  },
  {
    view: '语言切换',
    key: 'lang.boardColumnsInEn',
    label: '★ 看板五个列头都翻（`titleId`），一个中文字都不剩',
    ok: (v) =>
      Array.isArray(v) &&
      v.length === 5 &&
      v.join('|') === 'Executing|Executed · awaiting review|Acting|Needs a human|Reviewed',
  },
  {
    view: '语言切换',
    key: 'lang.boardHintsInEn',
    label: '★ 列说明也翻（`hintId`）',
    ok: (v) =>
      Array.isArray(v) && v.length === 5 && v.every((s) => s.length > 0 && !/[\u4e00-\u9fff]/.test(s)),
  },
  {
    view: '语言切换',
    key: 'lang.backToListInEn',
    label: '探针把视图模式还原成列表（模式存在 localStorage 里，会带到下一轮）',
    ok: (v) => v === true,
  },
  {
    view: '语言切换',
    key: 'lang.savedOnServer',
    label: '★ 选择写回了服务端（界面与 prompt 的语言指令一致）',
    ok: (v) => v === 'zh',
  },

  // ── 一个工具包都没装：那一栏的空态（D41）──
  //
  // ★ 这一组**自己把现场造成"一个都没装"**（探针走真接口摘挂 + 卸载，再点「工具」
  //   页那个刷新）：夹具里装着 `probe-tool`，"没有工具包"这个状态本来不存在。
  //   所以它排在最后（卸载之后前面那些检查就量不到了），而且每一步都如实上报
  //   ——这一组绿的意思是"空态真的被看到过"，不是"这一段没跑到"。
  {
    view: '行动权限空态（D41）',
    key: 'noTools.slugsBefore',
    label: '★ 卸载之前确实装着工具（否则下面的空态是碰巧看到的）',
    ok: (v) => Array.isArray(v) && v.length > 0,
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.refusals',
    label: '★ 摘挂与卸载都没被拒（被拒的话下面的空态根本没造出来）',
    ok: (v) => v === 0,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.refreshButtonFound',
    label: '「工具」页有那个刷新按钮（探针靠它让界面的 `$tools` 真的空掉）',
    ok: (v) => v === true,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.viewEmptyState',
    label: '工具页自己显示的是空态（列表确实空了）',
    ok: (v) => v === true,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.detailSwitched',
    label: '★ 右栏真的换成了那个"没有工具包可授权"的审核者（否则下面读到的是上一个）',
    ok: (v) => v === true,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.readOnlyHasEmptyState',
    label:
      '★ 只读态的「行动权限」那一行说的是"还没有装工具包 ⇒ 没有任何动作可授权"（不是一片空白）',
    ok: (v) => v === true,
    show: (v, facts) => `${v}　实测：「${String(facts['noTools.readOnlyText'] ?? '')}」`,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.readOnlyHasChip',
    label: '★ 只读态那一行里**没有**动作 chip（空就是空，不编一条出来）',
    ok: (v) => v === false,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.readOnlyGoButton',
    label: '★ 只读态那个空态**指向「工具」页**（一个可点的去处，不是一句干话）',
    ok: (v) => typeof v === 'string' && v.includes('工具'),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.formHasEmptyState',
    label: '★ 编辑态那一栏说的是同一句话（两个地方一个口径）',
    ok: (v) => v === true,
    show: (v, facts) => `${v}　实测：「${String(facts['noTools.formText'] ?? '')}」`,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.formHasToolsHeading',
    label: '★ 那一栏里**没有空的分组标题**（"已装工具的动作"下面什么都没有是最坏的一种画法）',
    ok: (v) => v === false,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.formHasGroupBox',
    label: '★ 也没有空的分组容器（按包分组的那一块整块不出现）',
    ok: (v) => v === false,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.formPickerShown',
    label: '★ 编辑态那一栏是「左选右配」的 ActionPicker，根容器在（空态画在组件内部）',
    ok: (v) => v === true,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.formHasAnyCheckbox',
    label: '★ 一个复选框都没有（没有可勾的东西就别画勾选框）',
    ok: (v) => v === false,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.formGoButton',
    label: '★ 编辑态的空态也指向「工具」页（按钮文案里写着"工具"）',
    ok: (v) => typeof v === 'string' && v.includes('工具'),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '行动权限空态（D41）',
    key: 'noTools.linkNavigatesToTools',
    label: '★ 而且那个去处**真的通**：点一下落到「工具」页（不是画了一个按钮）',
    ok: (v) => v === true,
  },

  // ── 配过、但没有出处的动作（D41 收尾 / D42）──
  //
  // ★ 现场是**真造出来的**（两个阶段，都是真接口）：
  //   · 阶段 A：先给审核员配上 `probe-tool-ui.ping`（那个包装着，写入口收），
  //     再把 `probe-tool-ui` 卸载 ⇒ 那条权限变成"配过、但没有出处"，然后
  //     **勾一个仍然可用的动作再保存** ⇒ 那份 patch 里带着它 ⇒ **400**。
  //     这就是使用者报的那条路径："打开行动权限 → 改点别的 → 保存 → 400"。
  //   · 阶段 B/C：把那几个包全卸载 ⇒ 只读态那一行 + 编辑态那一栏的表现。
  //   ⚠️ 真实老库（`reviewStandard.allowedActions` 里躺着 `comment.create` 这类
  //      旧的内置动作名）在探针里**造不出来**：写入口按设计拒绝裸名、并刻意忽略
  //      那个老字段。所以这里覆盖的是同一段界面 + 同一条接口路径的等价状态；
  //      旧名字本身由 `apps/web/src/lib/agent-actions.test.ts` 钉住。
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleGrantOk',
    label: '★ 夹具：先把 `probe-tool-ui.ping` 配到审核员身上（那个包装着，写入口收）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleUninstallOk',
    label: '★ 夹具：再把那个包卸载（这条权限立刻变成"配过、但没有出处"）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleListedInEdit',
    label: '★ 编辑态里那条**看得见**（勾选框里没有它——但绝不能让它凭空消失）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleLiveBoxFound',
    label: '★ 夹具：还有一个**可用**的动作可以勾（保存时那一份 patch 才带得上它）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleServerRefuses',
    label: '★ 带着那条没有出处的名字保存 ⇒ **服务端真的拒了**（400，不是界面自己编的）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleErrorVerbatim',
    label: '★★ 那句拒绝的话**原样显示在页面上**（与接口回的那句逐字相同：不吞掉、也不自己概括）',
    ok: (v) => v === true,
    show: (v, facts) =>
      `${v}　实测显示：「${String(facts['noTools.staleErrorShown'] ?? '')}」`,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleStillEditing',
    label: '★ 被拒之后界面**还停在编辑态**（没有假装保存成功）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleKeptAfterRefusal',
    label: '★★ 那条名字**还在草稿里**（被拒之后不许静默剔除——"使用者没同意就改了权限"）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleDropButton',
    label: '★ 并且给了可操作的下一步：「移除」入口就在它那一行',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.staleFixedOnServer',
    label: '★★ 点「移除」→ 再保存 ⇒ 这一次真的存进去了（接口上那条没了；不是死胡同）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadHolderFound',
    label: '★ 夹具里有一个"配过、但包已卸载"的 agent（否则下面几条会空过）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadDetailSwitched',
    label: '★ 右栏真的换成了它（否则下面读到的是上一个 agent）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadChipKept',
    label: '★ 只读态里那条权限**照原样留着**（不静默过滤掉——"配过"这件事不能抹）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadChipMarked',
    label: '★ 旁边明说它**当前不可用**（不能与一条真的能触发的动作长得一模一样）',
    ok: (v) => v === '当前不可用',
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadHintShown',
    label: '★ 那一段下面说清了为什么（找不到出处 + 下一步）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadHintBothCauses',
    label:
      '★ 解释里**两个成因都说了**：平台的内置动作已整组移除（旧名字）/ 提供它的包被卸载（能装回来）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadHintNextStepReadOnly',
    label: '★ 只读态给的下一步是**那一段里真的有的**（"点「编辑」…移除"）——不是编辑态那句',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadHintNextStepInEdit',
    label: '★ 编辑态给的下一步是那一栏里真的有的（「移除」按钮 + 去「工具」页装包）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadListedInEdit',
    label: '★ 编辑态把它**列出来**了（勾选框里没有它，不列就是"看不见"）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadRemoveButton',
    label: '★ 并且给了「移除」入口（否则一保存就被服务端拒，而错误点名的那条在界面上不存在）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadPartialStillRefused',
    label:
      '★ 只去掉一条就保存 ⇒ **仍然被拒**（服务端的规则是"名单里只要还有一条没出处的就不收"）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadAllRemoved',
    label: '★ 逐条点「移除」之后，那一栏里一条契约值都不剩了（草稿真的清了）',
    ok: (v) => v === true,
  },
  {
    view: '配过但不可用（D41）',
    key: 'noTools.deadDroppedOnServer',
    label: '★★ 点「移除」→ 保存之后，**接口上**那条权限真的没了（不是个死胡同）',
    ok: (v) => v === true,
  },

  // ── 新建任务的三步链（① 执行 → ② 审核 → ③ 行动）──
  //
  // ★ 这一页刚从一个"执行者下拉"变成**三步链**，而三步里有两处错法的后果
  //   都不是排版：
  //     · ② 的默认值错了 ⇒ 使用者没点过任何东西，却改变了"这条产出会不会被审"；
  //     · 提交时那个 key 的三态错了 ⇒ "跟随"被写成 `null`（这次真的不审了），
  //       而界面上看起来一切照旧。
  //   所以下面这组里最重要的两条是 `newtask.followRunMode` 与
  //   `newtask.noneRunMode`：它们读的是**接口上那条 run**，不是页面上的字。
  //
  // ⚠️ 夹具（两个审核者 + 一个执行者）由 `run.mjs` 在**装完夹具工具包之后**造，
  //    三个 id 与那个动作名经 URL 传给探针页：`POST /api/agents` 在保存时会校验
  //    `allowedActions` 里的动作来自**已安装**的工具包，装之前建必然 400。
  {
    view: '新建任务的三步链',
    key: 'newtask.fixtureExecutorId',
    label: '★ 夹具：三个 agent 的 id 与那个动作名都从 URL 到位了（否则下面一整组都会空过）',
    ok: (v, facts) =>
      typeof v === 'string' &&
      v.length > 0 &&
      typeof facts['newtask.fixtureReviewerId'] === 'string' &&
      facts['newtask.fixtureReviewerId'].length > 0 &&
      typeof facts['newtask.fixtureEmptyReviewerId'] === 'string' &&
      facts['newtask.fixtureEmptyReviewerId'].length > 0 &&
      facts['newtask.fixtureAction'] === CHAIN_ACTION,
    show: (v, facts) =>
      `执行者 ${String(v).slice(-6)} / 审核者 ${String(facts['newtask.fixtureReviewerId']).slice(-6)} / 空权限 ${String(facts['newtask.fixtureEmptyReviewerId']).slice(-6)} / 动作 ${String(facts['newtask.fixtureAction'])}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.stepTitles',
    label: '★ 三步的标题都在，而且顺序就是 ① 执行 → ② 审核 → ③ 行动（少一步 = 有一件事没问）',
    ok: (v) => JSON.stringify(v) === JSON.stringify(['① 执行', '② 审核', '③ 行动']),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.pageReady',
    label: '★ 夹具执行者真的选上了（②③ 是 `{#if chosen}` 里的：这一步不成立，下面量到的就是两段空气）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.executorSelectApplied',
    label: '① 选中的确实是夹具那个执行者（不是列表里的第一个）',
    ok: (v, facts) => v === facts['newtask.fixtureExecutorId'],
    show: (v) => `${String(v).slice(-6)}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.reviewerOptionValues',
    label:
      '★ ② 的三档都在：跟随 / 每个审核者 / 不自动审核（这一次）——后两档都要使用者显式点',
    ok: (v, facts) =>
      Array.isArray(v) &&
      v.includes('follow') &&
      v.includes('none') &&
      v.includes(`pick:${facts['newtask.fixtureReviewerId']}`),
    show: (v) => (Array.isArray(v) ? `${v.length} 项：${v.join(' | ')}` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.reviewerDefaultPick',
    label: '★★ ② **默认是「跟随」**（默认不替使用者做决定：选择"不审"必须是他点出来的）',
    ok: (v) => v === 'follow',
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followOptionText',
    label: '★ 「跟随」那一项带上了**执行者的名字**（否则"跟随谁"要靠猜）',
    ok: (v) => typeof v === 'string' && v.includes(`跟随「${CHAIN_EXECUTOR}」的设置`),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followOptionText',
    label:
      '★★ 并且带上了它**实际会跟到的那个审核者**（D28 的长期安排在提交前就看得见）',
    ok: (v) => typeof v === 'string' && v.includes(CHAIN_REVIEWER),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionsSectionFound',
    label: '★ ③ 那一段真的画出来了（否则"里面没有控件"是一条空过的断言）',
    ok: (v) => v === true,
  },
  // ── ★ 改写之一：`newtask.actionChips`（③ 只读 ⇒ 契约值画在 `.chip` 里）──
  //
  // 为什么原来那条不再成立：③ 从**只读**改成了**可勾**（智能体页「行动权限」那个
  // 形状）。可勾那一档的契约值画在**勾选框旁边**（`label.action-option > code`），
  // 不再有 `.chip` 可选那一档的判据必须整个换口径：从"有一段只读文字里出现了
  // 契约值"变成"**框里那个动作**就是它、而且框旁边逐字写着它的 `summary`"。
  // ⚠️ 它**不是被放松**：原来只要求"字符串在页面上出现过"，现在要求"框的
  //    `value` / 旁边的 `code` / 旁边的 `summary` 三样都对上接口里那一份"。
  {
    view: '新建任务的三步链',
    key: 'newtask.fixtureReviewerActions',
    label:
      '★ 夹具：那个审核者**当前生效的动作**从接口读到了（它是"默认该勾着谁"的基准；读不到的话下面几条会空过）',
    ok: (v) => sameSet(v, [CHAIN_ACTION]),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.fixtureSourcesRead',
    label:
      '★ 工具清单与 agent 名单都从接口读到了（"框该有几个"与"默认该勾什么"都拿它当基准）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.installedActionTotal',
    label: '★ 已装工具包一共声明了几个动作（> 0，否则"框的条数"那条会空过）',
    ok: (v) => typeof v === 'number' && v > 0,
    show: (v, facts) => `${v} 个：${(facts['newtask.installedActions'] ?? []).join(' | ')}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.fixtureActionSummary',
    label: '★ 夹具那个动作在工具清单里的 `summary` 读到了（下面"逐字相同"那条的基准）',
    ok: (v) => typeof v === 'string' && v.length > 0,
    show: (v) => (v === null ? 'null' : `"${String(v)}"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionBoxValues',
    label:
      '★★★ ③ 可勾那一档的勾选框 = **已装工具包声明的全部动作**（含那个审核者当前没有的那些）——只画它已有的那几条就只能减不能加，而"这一次允许一个它长期没有的动作"正是这份覆盖的意义',
    ok: (v, facts) => sameSet(v, facts['newtask.installedActions']),
    show: (v, facts) =>
      `${Array.isArray(v) ? v.join(' | ') : String(v)}　（接口里已装工具的 ${facts['newtask.installedActionTotal']} 个 / 那个审核者当前 ${(facts['newtask.fixtureReviewerActions'] ?? []).length} 个）`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionCheckedCount',
    label:
      '★★★ ③ 上**勾着的**数量 = 那个审核者当前生效的动作数（夹具里 1 条：`probe-tool.clean-notes`）——这是新的默认口径：勾选框不是"随便画几个"，它预勾的就是 ② 那个人现在真能触发的那些',
    ok: (v, facts) =>
      typeof v === 'number' &&
      v > 0 &&
      v === (facts['newtask.fixtureReviewerActions'] ?? []).length,
    show: (v, facts) =>
      `${v} 个勾着 / 那个审核者有 ${(facts['newtask.fixtureReviewerActions'] ?? []).length} 个　勾着的：${(facts['newtask.actionCheckedValues'] ?? []).join(' | ')}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionCheckedValues',
    label:
      '★★★ 而且勾着的**就是那个审核者当前生效的那几条**（集合相等）——差一条就意味着"默认状态"已经偷偷成了一次覆盖',
    ok: (v, facts) => sameSet(v, facts['newtask.fixtureReviewerActions']),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionBoxCount',
    label:
      '★★ 框的条数与"已装工具的动作总数"一致（不是"那个审核者的条数"——两者在夹具里是 3 vs 1）；写成只画审核者那几条的实现会红',
    ok: (v, facts) =>
      facts['newtask.installedActionTotal'] > 0 && v === facts['newtask.installedActionTotal'],
    show: (v, facts) => `${v} 个框 / 已装工具共 ${facts['newtask.installedActionTotal']} 个动作`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionFixtureBox',
    label:
      '★★★ 那个动作的勾选框里**契约值原样显示**（不翻译、不概括），旁边是工具清单里的 `summary`（**逐字相同**），而且它默认就是勾着的',
    ok: (v, facts) =>
      !!v &&
      v.code === CHAIN_ACTION &&
      typeof facts['newtask.fixtureActionSummary'] === 'string' &&
      v.summary === facts['newtask.fixtureActionSummary'] &&
      v.checked === true,
    show: (v, facts) =>
      v
        ? `code=${JSON.stringify(v.code)} / checked=${v.checked} / summary=${JSON.stringify(v.summary)}（接口里是 ${JSON.stringify(facts['newtask.fixtureActionSummary'])}）`
        : '找不到那个动作的勾选框',
  },

  // ── ★ 新不变量：那句「只对这一次任务生效」**只在改过之后**出现 ──
  //
  // 默认状态（一下都没碰过）出现它 = 对使用者说"你改了它的长期权限"——假话；
  // 动一下（取消一个勾）不出现它 = 他这一次的收紧会被当成长期安排。
  {
    view: '新建任务的三步链',
    key: 'newtask.untickDispatched',
    label: '★ 探针真的把那个勾**取消**了（否则下面两条量的是"没动过"的现场）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionsOnceOnlyWhenDefault',
    label:
      '★★★ 默认（一下都没碰过）**没有**那句「只对这一次任务生效」——它在默认态出现就是一句假话（长期那一份还好好的，这一页只是准备了一次覆盖）',
    ok: (v) => v === false,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionsOnceOnlyAfterUntick',
    label:
      '★★★ 取消一个勾之后**必须**出现那句（少了它，这一次的收紧会被当成"改了那个审核者的长期行动权限"，下一条任务又变回老样子）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedCheckedValues',
    label: '★ 取消之后**一个勾都没有**了（下面那句"一个都不勾"必须对应这个状态）',
    ok: (v) => Array.isArray(v) && v.length === 0,
    show: (v) => (Array.isArray(v) ? `${v.length} 个` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionsClearedHint',
    label:
      '★ 一个都不勾时说的是**"这一次一个动作都不勾"**（"它本来就没有"是另一件事，两句不能合成一句：后者会让使用者以为平台没听懂他刚才的操作）',
    ok: (v) =>
      typeof v === 'string' &&
      v.includes('这一次一个动作都不勾') &&
      v.includes('不会触发任何操作'),
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 56)}…"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.retickSettled',
    label: '★ 探针把那个勾**又勾回来**了（等这一次重渲染落地；下面那条量的是落地之后的样子）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionsOnceOnlyAfterRetick',
    label:
      '★★★ 勾回来之后那句必须**消失**（勾选结果又与审核者那份一致了 = 没改）：判据是"改没改"（集合相等），不是"碰没碰过"——写成"碰过就一直显示"的实现会把"其实没改"报成改了，于是**多带一份覆盖**出去',
    ok: (v) => v === false,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramEditorForFixture',
    label:
      '★★★ 固定参数编辑器（D44）长在「左选右配」的**右栏**：默认选中夹具动作（`probe-tool.clean-notes`）、编辑器在、绑定参数区写着"平台注入"',
    ok: (v) =>
      v !== null &&
      v.selected === CHAIN_ACTION &&
      v.hasEditor === true &&
      v.hasBoundNote === true,
    show: (v) => (v === null ? 'null' : JSON.stringify(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramEditorDefault',
    label:
      '★★★ 编辑器默认值 = 审核者**长期那份**（夹具里钉的 `text=长期钉的`）——不是空白："跟随"被画成"这次没设"就会诱导人把长期配置冻成一次覆盖',
    ok: (v) => v === '长期钉的',
    show: (v) => (v === null ? 'null' : JSON.stringify(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramFixedPairSwitch',
    label:
      '★★★ 字符串参数有**显式**的「不固定（模型填）/ 固定」开关（D43 界面反馈）：不能只靠输入框 placeholder 暗示——否则使用者看到的就只有"不固定（模型填）"，看不出哪里能设固定值；审核者已固定时开关停在「固定」',
    ok: (v) =>
      v !== null &&
      v.options.includes('不固定（模型填）') &&
      v.options.includes('固定') &&
      v.mode === 'fixed',
    show: (v) => (v === null ? 'null' : JSON.stringify(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramFixedInputAlwaysVisible',
    label:
      '★★★ 输入框**常驻**（D43 界面反馈第二轮）：开关切到「不固定」时输入框仍然在（空）——"直接写值 = 固定"是主路径，不能先选「固定」才冒出输入框，否则使用者会问"平台会传入什么"；且这次切换真的改了参数（"固定参数改了"出现，不是只动了开关）',
    ok: (v) =>
      v !== null && v.mode === 'open' && v.inputVisible === true && v.inputValue === '' && v.dirty === true,
    show: (v) => (v === null ? 'null' : JSON.stringify(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramFixedPendingHint',
    label:
      '★★★ 选了「固定」但没填值 ⇒ 明确提示"还没填值"（不许静默当没设——使用者会以为钉上了，其实什么都没存）',
    ok: (v) => v !== null && v.hintShown === true,
    show: (v) => (v === null ? 'null' : JSON.stringify(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramFixedPendingGone',
    label:
      '★★★ 填上值 ⇒ 提示消失、开关停在「固定」、输入框里就是那个值——"平台会传入什么" = 你填的这个，没有第二份值',
    ok: (v) =>
      v !== null && v.pendingGone === true && v.mode === 'fixed' && v.inputValue === '临时钉一下',
    show: (v) => (v === null ? 'null' : JSON.stringify(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramDirtyShown',
    label:
      '★★★ 改过一个固定参数 ⇒ "固定参数改了"那句出现（与白名单"只对这一次任务生效"同一条口径：改的只是这一次，审核者的长期配置没动）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.paramDirtyGone',
    label:
      '★★★ 改回来 ⇒ 那句消失（"其实没改"不许带一次覆盖出去：那会把长期配置冻成一次性决定）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.agentDetailFixedChip',
    label:
      '★★★ 智能体详情**只读**那一档：契约值 chip 旁边带「已固定: text=长期钉的」（固定值在界面上看得见，别让使用者忘了自己钉过什么）',
    ok: (v) =>
      v !== null &&
      typeof v.chip === 'string' &&
      v.chip.includes('已固定') &&
      v.chip.includes('text=长期钉的'),
    show: (v) => (v === null ? 'null' : JSON.stringify(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.actionsMentionsReviewer',
    label:
      '★ ③ 说得出**默认勾的那一份来自谁**（它是那个审核者的能力）',
    ok: (v) => typeof v === 'string' && v.includes(CHAIN_REVIEWER),
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 46)}…"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.onceOnlyAfterPick',
    label:
      '★ 在 ② 上**指名换一个人**之后出现"只对这一次生效"那句（范围：这一次 ≠ 长期安排）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.emptyPermsActionsText',
    label:
      '★★ 有审核者、但它一个动作都没配 ⇒ ③ 必须说清后果（**它的判决只会给出结论，不会触发任何操作**）',
    ok: (v) =>
      typeof v === 'string' &&
      v.includes('现在没有一个能用的动作') &&
      v.includes('判决') &&
      v.includes('不会触发任何操作'),
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 50)}…"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.emptyPermsChips',
    label:
      '★ 那一档**不画 chip**（③ 可勾时契约值画在勾选框旁边，chip 是"旧 daemon 兑现不了覆盖"那一档的形状）——这一条现在只说明"形状没串档"，真正的判据是下面那两条：**框在、全空**',
    ok: (v) => Array.isArray(v) && v.length === 0,
    show: (v) => (Array.isArray(v) ? `${v.length} 个` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.emptyPermsBoxValues',
    label:
      '★★★ 有审核者、但它**一个动作都没有** ⇒ 勾选框**照画**，条数仍是已装工具的动作总数——这一档要的是"全空但可勾"（一个框都不画的实现等于说"这一栏没救了"，而它其实能加）',
    ok: (v, facts) =>
      facts['newtask.installedActionTotal'] > 0 &&
      sameSet(v, facts['newtask.installedActions']),
    show: (v, facts) =>
      `${Array.isArray(v) ? v.length : String(v)} 个框 / 已装工具共 ${facts['newtask.installedActionTotal']} 个动作`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.emptyPermsCheckedValues',
    label:
      '★★★ 而且**一个都没勾**（那个审核者当前生效的动作就是空的：默认勾选是把它的现状**照实**画出来，不是替它预勾一条）',
    ok: (v) => Array.isArray(v) && v.length === 0,
    show: (v) => (Array.isArray(v) ? `${v.length} 个：${v.join(' | ')}` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.noneApplied',
    label: '② 切到「不自动审核（这一次）」这一步本身成功了（下面几条的前提）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.onceOnlyAfterNone',
    label: '★ 这一档同样带着"只对这一次生效"那句（它也是"这一次"的决定，不是长期安排）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.noneActionsText',
    label:
      '★★ 选了"不自动审核"之后 ③ 改说**没有审核者**这件事：这次既不会有判决，也不会有任何动作',
    ok: (v) =>
      typeof v === 'string' &&
      v.includes('这次没有审核者') &&
      v.includes('既不会有判决') &&
      v.includes('也不会有任何动作'),
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 50)}…"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.noneActionsText',
    label:
      '★★ 而且**没有**照抄另一档那句"判决只会给出结论，不会触发任何操作"——这一档连判决都不会有，说它就是假话',
    ok: (v) => typeof v === 'string' && !v.includes('不会触发任何操作'),
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 50)}…"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.noneActionsControlCount',
    label:
      '★ "不审"这一档的 ③ 里**一个旋钮都没有**（没有审核者就没有动作可谈——它不是"这一页只读"，而是"这一档根本没有可勾的东西"）',
    ok: (v, facts) => facts['newtask.actionsSectionFound'] === true && v === 0,
    show: (v) => `${v} 个控件`,
  },

  // ── ★ 档三：工具清单没到 ⇒ **一个勾选框都不画** ──
  //
  // 现场是"让 `/api/tools` 真的失败"再造出来的（`$tools` 那一刻还留着上一次取到的
  // 清单 ⇒ 与"一个包都没装"长得一样，而这一栏必须说"说不准"）。
  {
    view: '新建任务的三步链',
    key: 'newtask.toolsUnknownPatched',
    label: '★ 现场真的被造成了那个样子：`/api/tools` 在这一次刷新里失败（patch 装上了）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.toolsUnknownViewError',
    label:
      '★★ 失败走的是**界面自己那条路**（「工具」页显示的就是 store 里记下的那条错误，逐字带探针编的那句话）——不是探针替它改状态',
    ok: (v) => typeof v === 'string' && v.includes('/api/tools 取失败'),
    show: (v) => (v === null ? 'null' : `"${String(v)}"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.toolsUnknownBoxesBefore',
    label:
      '★★ 前提：这一次失败**之前**界面手里是有清单的（框有若干个）——否则下面量到的是"真的一个包都没装"，那是另一档',
    ok: (v) => typeof v === 'number' && v > 0,
    show: (v) => `${v} 个框`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.toolsUnknownBoxValues',
    label:
      '★★★ 清单没到 ⇒ ③ 里**一个勾选框都不画**（不知道有哪些动作时，画出来的框就是在替使用者猜）',
    ok: (v) => Array.isArray(v) && v.length === 0,
    show: (v) => (Array.isArray(v) ? `${v.length} 个：${v.join(' | ')}` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.toolsUnknownText',
    label:
      '★★★ 而且说的是"**工具清单还没到**"，**不是**"现在没有一个能用的动作"——后者是关于**他自己的权限**的一句假话（那一刻清单只是没取到，不是空的），而这正是最初把这一档加进来的原因',
    ok: (v) =>
      typeof v === 'string' &&
      v.includes('工具清单还没到') &&
      !v.includes('现在没有一个能用的动作'),
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 52)}…"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.toolsUnknownChips',
    label: '★ 这一档也**不画 chip**（chip 属于"退回只读"那一档，不是"不知道"这一档）',
    ok: (v) => Array.isArray(v) && v.length === 0,
    show: (v) => (Array.isArray(v) ? `${v.length} 个` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.toolsUnknownRestored',
    label:
      '★ 收尾：还原之后 ③ 的框又回来了（否则后面那三条端到端量的是"清单还没到"的残局）',
    ok: (v) => v === true,
  },

  // ── ★ 档四：这个 daemon **兑现不了这一栏的覆盖** ⇒ 退回只读（画 chip）──
  //
  // 现场是把 `/api/identity` 的 `capabilities` 里 `task-action-whitelist` **只去掉
  // 这一个**（`reviewer-override` 留着）：这正是"只重建了一半"的中间态，也是
  // 那两个标志**必须分开**的理由。
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonPatched',
    label: '★ 现场真的被造成了那个样子：身份那一份被打成了"没有 `task-action-whitelist`"（patch 装上了）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonCapsAfterPatch',
    label:
      '★★ 而且 patch 之后那份身份**确实少了这一个标志、其它照旧**（`reviewer-override` 还在）——否则下面量到的不是"旧 daemon"那一档',
    ok: (v) =>
      Array.isArray(v) &&
      !v.includes('task-action-whitelist') &&
      v.includes('reviewer-override'),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonBoxValues',
    label:
      '★★★ 兑现不了这一栏的覆盖 ⇒ ③ **退回只读**：一个勾选框都不画（画了就是在撒谎：那份覆盖发过去会被对面静默忽略，而两边都不报错）',
    ok: (v) => Array.isArray(v) && v.length === 0,
    show: (v) => (Array.isArray(v) ? `${v.length} 个：${v.join(' | ')}` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonControlCount',
    label:
      '★★★ 并且那一段里**一个旋钮都没有**（input / select / textarea / button === 0）——"只读"这条老口径在**这一档**仍然成立，所以它留在这里量',
    ok: (v) => v === 0,
    show: (v) => `${v} 个控件`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonChips',
    label:
      '★★★ 退回只读之后契约值**原样出现**（`<包 slug>.<动作名>`，不翻译、不概括）——原来那条 `actionChips` 的判据搬到了这一档（chip 才是这一档的形状）',
    ok: (v) => Array.isArray(v) && v.includes(CHAIN_ACTION),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonChipSummary',
    label:
      '★★ 契约值旁边是工具清单里那句 `summary`，而且**逐字相同**（原来那条只要求"长度大于 4"，现在拿接口里那一份比）',
    ok: (v, facts) =>
      typeof v === 'string' &&
      typeof facts['newtask.fixtureActionSummary'] === 'string' &&
      v === facts['newtask.fixtureActionSummary'],
    show: (v, facts) =>
      v === null ? 'null' : `"${String(v)}"（接口里是 "${String(facts['newtask.fixtureActionSummary'])}"）`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonText',
    label:
      '★★ 并且说清了**这一次改不了 + 补救动作是重启 daemon**（与 ② 那条同一个口径；不说的话使用者只会以为界面坏了）',
    ok: (v) =>
      typeof v === 'string' && v.includes('这一栏这一次改不了') && v.includes('重启 daemon'),
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 52)}…"`),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonReviewerOptions',
    label:
      '★★★ 而 ② 那一栏**没有跟着只读**（跟随 / 换人 / 不审三档都在）——两个能力标志是**两份契约**：合成一个的话，这个中间态下 ② 会跟着退化，而"这一次换个人审"本来是兑现得了的',
    ok: (v, facts) =>
      Array.isArray(v) &&
      v.includes('follow') &&
      v.includes('none') &&
      v.includes(`pick:${facts['newtask.fixtureReviewerId']}`),
    show: (v) => (Array.isArray(v) ? `${v.length} 项` : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.oldDaemonRestored',
    label: '★ 收尾：身份还原之后 ③ 的勾选框又回来了（否则后面那三条端到端量的是"退回只读"的残局）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followSubmitReachedTasks',
    label:
      '★ 提交①（跟随）之后**界面自己走完了**（两次 POST 都 await 过才切视图）——否则接口那两条读到的是别的 run',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followSubmitPick',
    label:
      '★ 提交①之前 ② 上**真的停在「跟随」**（这一条只观察、不设置：它若不是，下面那条量到的就是别的状态）',
    ok: (v) => v === 'follow',
    show: (v) => `② = ${JSON.stringify(v)}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followRunAgentId',
    label: '★ 那条新 run 真的挂在夹具执行者上（不然下面那条量的可能是别人的 run）',
    ok: (v, facts) => v !== null && v === facts['newtask.fixtureExecutorId'],
    show: (v) => String(v).slice(-6),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followRunMode',
    label:
      '★★★ 端到端：② 停在「跟随」时提交 ⇒ 接口上 `reviewer.mode === "follow"`（**不是** `none`：跟随绝不能写成 `null`）',
    ok: (v) => v === 'follow',
    show: (v) => `reviewer.mode = ${JSON.stringify(v)}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.noneSubmitReachedTasks',
    label: '★ 提交②（不自动审核）后界面同样走完了',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.noneRunAgentId',
    label: '★ 那一条新 run 也挂在夹具执行者上',
    ok: (v, facts) => v !== null && v === facts['newtask.fixtureExecutorId'],
    show: (v) => String(v).slice(-6),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.noneRunMode',
    label:
      '★★★ 端到端：在 ② 上选「不自动审核（这一次）」再点「创建并派发」⇒ 接口上 `reviewer.mode === "none"`（界面上选的与发出去的请求体是同一件事）',
    ok: (v) => v === 'none',
    show: (v) => `reviewer.mode = ${JSON.stringify(v)}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.fetchRestored',
    label:
      '★ 上面那两处 patch（失败的工具清单 / 少了标志的身份）**都还原了** —— 三条端到端量的必须是恢复正常之后的现场，不能踩在残局上',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followSubmitChecked',
    label:
      '★ E1 的前提：提交之前 ③ 上确实**一下都没碰过**（勾着的仍是那个审核者当前那份）——它若不是，下面那条量到的就是别的状态',
    ok: (v, facts) => sameSet(v, facts['newtask.fixtureReviewerActions']),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followRunRecordRead',
    label:
      '★ E1 的前提：那条新 run 的**落库原文**真的读回来了（`GET /api/runs/<id>`；读不到时下面那条会是 null 而红，不会静默通过）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.followRunHasAllowedActionsKey',
    label:
      '★★★ E1 端到端：**没碰 ③ 就提交** ⇒ 那条 run 的落库原文里**根本没有 `allowedActions` 这个 key**（= 跟随那个审核者的长期「行动权限」）。写成 `...(x ?? [])` 那种"总是带"的实现会给出 `[]` ⇒ 红：使用者什么都没做，却把这个审核者的权限**冻死在这一条任务上**（以后在智能体页给它加动作，从这一页建的任务仍然按老那份跑）',
    ok: (v) => v === false,
    show: (v, facts) =>
      `键在吗：${JSON.stringify(v)}　值：${JSON.stringify(facts['newtask.followRunAllowedActions'])}（null = 没有那个键或者值是 null，看左边那一位）`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedSubmitUntick',
    label: '★ E2 的前提：探针真的把 ③ 上那个勾**取消**了',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedSubmitChecked',
    label:
      '★ E2 的前提：提交之前 ③ 上**一个勾都没有**（这个状态就是发出去那个 `[]` 的含义，只观察、不设置）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedSubmitReachedTasks',
    label: '★ 提交（一个动作都不勾）之后界面同样走完了（两次 POST 都 await 过才切视图）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedRunAgentId',
    label: '★ 那一条新 run 也挂在夹具执行者上（不然下面那条量的可能是别人的 run）',
    ok: (v, facts) => v !== null && v === facts['newtask.fixtureExecutorId'],
    show: (v) => String(v).slice(-6),
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedRunRecordRead',
    label: '★ E2 的前提：那一条新 run 的落库原文读回来了',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedRunHasAllowedActionsKey',
    label:
      '★★★ E2 端到端：**一个都不勾**再提交 ⇒ 那个 key **在**（在才是对的：这一次是一条决定，不是"没配"）',
    ok: (v) => v === true,
    show: (v) => `键在吗：${JSON.stringify(v)}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.clearedRunAllowedActions',
    label:
      '★★★ E2 端到端：而且它是**空数组 `[]`**（键在、值空）= "这一次一个动作都不许触发"。它与 E1 一起钉死"**省略 ≠ 空数组**"：靠"数组是空的就省掉"来偷懒的实现会让使用者的收紧**静默失效**，而那条任务看起来一切正常结束',
    ok: (v, facts) =>
      facts['newtask.clearedRunHasAllowedActionsKey'] === true &&
      Array.isArray(v) &&
      v.length === 0,
    show: (v) => JSON.stringify(v),
  },

  // ── D45：返工次数（界面 ↔ 请求体 ↔ 落库）──
  {
    view: '新建任务的三步链',
    key: 'newtask.reworkDefault',
    label:
      '★ D45：进页面时「审核不通过时返工」默认是 **0**（不返工）——返工要花钱，不能替使用者决定多跑几轮',
    ok: (v) => v === '0',
    show: (v) => `默认 ${JSON.stringify(v)}`,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.setRework',
    label: '★ D45 的前提：探针真的把那个下拉拧到了 2（拧不动的话下面量到的就是默认值）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.reworkRunRecordRead',
    label: '★ D45 的前提：那条新 run 的落库原文读回来了（读不到时下面那条会是 null 而红，不静默通过）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务的三步链',
    key: 'newtask.reworkRunMaxReworks',
    label:
      '★★★ D45 端到端：界面上拧到 **2** 再提交 ⇒ 落库原文里 `maxReworks === 2`（界面上选的与落库的是同一件事；断在这里的表现是"配了返工却一次都不返"，而界面上看不出任何异常）',
    ok: (v) => v === 2,
    show: (v) => `maxReworks = ${JSON.stringify(v)}`,
  },

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

  // ★ 造一条 **skill** 当夹具（D38 之后首启不再播种 skill，技能库是空的）：
  //   探针的 Skills 那一段要量列表、抽屉与卸载按钮，没有内容就只能量到空态。
  try {
    const res = await fetch(`${base}/api/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skills: [{ slug: 'probe-skill', name: '探针技能', body: '# 探针\n\n夹具。', source: 'local' }],
      }),
    })
    if (!res.ok) log(yellow(`⚠ 造夹具 skill 失败（HTTP ${res.status}）——Skills 那几条会量到空态`))
  } catch (err) {
    log(yellow(`⚠ 造夹具 skill 时出错：${err}`))
  }

  // ★ 再造一个**老形态的审核者**（D38 的迁移夹具）：只挂 skill、没有内联标准。
  //   探针要走一遍"把挂载的 skill 转成内联标准 → 那条 skill 才卸得掉"。
  try {
    const skills = (await (await fetch(`${base}/api/skills`)).json()).skills
    const probeSkill = skills.find((s) => s.slug === 'probe-skill')
    if (!probeSkill) {
      log(yellow('⚠ 找不到夹具 skill——迁移那几条会空过'))
    } else {
      const res = await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '探针用的老形态审核者',
          role: 'reviewer',
          skillIds: [probeSkill.id],
        }),
      })
      if (!res.ok) log(yellow(`⚠ 造老形态审核者失败（HTTP ${res.status}）`))
    }
  } catch (err) {
    log(yellow(`⚠ 造老形态审核者时出错：${err}`))
  }

  // ★ 再造**一个执行者**（不造 run）：探针要测"换默认智能体"，而首启播种的
  //   执行者**已经是默认**——只有一个执行者时，卡片上根本没有「设为默认」可点，
  //   那一组检查会全部空过。
  //
  //   ⚠️ 这件事必须在这里做（Node 侧、真实时间），不能在探针里做：探针跑在
  //   `--virtual-time-budget` 下，`setTimeout` 是**虚拟**的，而网络请求是真的——
  //   在探针里"创建 → 等界面刷新"会**看早**（实测：API 已经返回 3 个 agent，
  //   界面那一轮轮询已经跑完了上百次而没等到重新渲染）。
  try {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '探针用的执行者', role: 'executor' }),
    })
    if (!res.ok) log(yellow(`⚠ 造夹具 agent 失败（HTTP ${res.status}）——换默认那几条会空过`))
  } catch (err) {
    log(yellow(`⚠ 造夹具 agent 时出错：${err}`))
  }

  // ══════════════════════════════════════════════════════════════════
  // 造**工具包夹具**（D40）：三个目录，加一次真的安装
  // ══════════════════════════════════════════════════════════════════
  //
  // 三份夹具各管一件事，缺一条就会有一段检查**空过**：
  //
  //   ① `probe-tool`：装得上、**两个动作**，其中 `clean-notes` 是
  //      `reversible: false` + `dryRun: 'unsupported'`——"不可回滚 / 不支持预演"
  //      那两条标注只有动作本身带着这两个值时才量得到；
  //   ② `probe-tool-ui`：给**抽屉里那次真实安装**用（换个 slug，否则同名会被
  //      自己的 ① 挡住，量到的是"同名冲突"而不是"装上了"）；
  //   ③ `probe-broken`：清单合法但**入口脚本不在包里** ⇒ 服务端回
  //      `missing_entry` 且 `detail` 是**多行**的（`describeDir` 一行 +
  //      一句解释）。"失败时 error 与多行 detail 一起显示"只有这种夹具量得到。
  //
  // ⚠️ 目录写在 `.cache/layout-probe/` 里（SCRATCH），仓库外一个字节都不写。
  // ⚠️ 路径要**传给探针页**（`?badToolPath=` / `?uiToolPath=`）：抽屉里那次
  //    安装是探针"真的往输入框里打字"驱动的，而它不可能自己编出这个路径。
  const fixtureToolsDir = path.join(SCRATCH, 'fixture-tools')
  const toolFixtureDir = path.join(fixtureToolsDir, 'probe-tool')
  const uiToolFixtureDir = path.join(fixtureToolsDir, 'probe-tool-ui')
  const brokenToolFixtureDir = path.join(fixtureToolsDir, 'probe-broken')

  const writeTool = (dir, manifest, files) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify(manifest, null, 2))
    for (const [rel, text] of Object.entries(files)) {
      const full = path.join(dir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, text)
    }
  }

  try {
    writeTool(
      toolFixtureDir,
      {
        schema: 'alpha-helper/tool@1',
        slug: 'probe-tool',
        name: '探针工具（夹具）',
        version: '1.0.0',
        description: '探针夹具：两个动作，其中一个不可回滚且不支持预演。',
        runtime: 'node',
        entry: 'scripts/note.mjs',
        actions: [
          {
            name: 'append-note',
            summary: '把一句话追加到工作目录的 NOTES.md',
            reversible: true,
            dryRun: 'supported',
            timeoutMs: 10000,
            params: {
              // 绑定参数：模型看不到也填不了（界面上要标出来）
              bound: { dir: { from: 'workdir' } },
              // 开放参数：有界，界面显示类型与上限
              open: { text: { type: 'string', max: 500 } },
            },
          },
          {
            name: 'clean-notes',
            // ★ 这一条是"不可回滚 + 不支持预演"两条标注的唯一来源
            summary: '把 NOTES.md 删掉（演示 reversible=false 的动作）',
            entry: 'scripts/clean.mjs',
            reversible: false,
            dryRun: 'unsupported',
            params: {
              bound: { confirm: { from: 'literal', value: 'yes' } },
              // ★ D43：给这条动作一个 **open** 参数——固定参数编辑器只对"勾上的
              //   动作 + 有 open 参数"出现，夹具审核者钉的正是这一个（见下）。
              open: { text: { type: 'string', max: 500 } },
            },
          },
        ],
      },
      {
        'TOOL.md': '# 探针工具\n\n夹具包，由 tools/layout-probe 造。\n',
        'scripts/note.mjs': "console.log('probe note')\n",
        'scripts/clean.mjs': "console.log('probe clean')\n",
      },
    )

    writeTool(
      uiToolFixtureDir,
      {
        schema: 'alpha-helper/tool@1',
        slug: 'probe-tool-ui',
        name: '探针工具（从抽屉里装的）',
        version: '0.1.0',
        runtime: 'node',
        entry: 'scripts/run.mjs',
        actions: [
          {
            name: 'ping',
            summary: '打印一行（夹具）',
            reversible: true,
            dryRun: 'supported',
          },
        ],
      },
      { 'scripts/run.mjs': "console.log('probe ui tool')\n" },
    )

    writeTool(
      brokenToolFixtureDir,
      {
        schema: 'alpha-helper/tool@1',
        slug: 'probe-broken',
        name: '探针坏包（清单合法、入口不在）',
        runtime: 'node',
        // 声明的入口**不在**包里 ⇒ missing_entry，detail 两行
        entry: 'scripts/missing.mjs',
        actions: [
          { name: 'do-nothing', summary: '什么也不做（夹具）', reversible: true, dryRun: 'supported' },
        ],
      },
      // 故意只有 tool.json：`files` 为空，于是"入口文件不在包里"这条一定会触发
      {},
    )
  } catch (err) {
    log(yellow(`⚠ 写工具包夹具时出错：${err}`))
  }

  try {
    const res = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'path', path: toolFixtureDir }),
    })
    if (!res.ok) {
      log(yellow(`⚠ 装夹具工具失败（HTTP ${res.status}）——工具那几条会量到空态`))
    } else {
      const { tool } = await res.json()
      // ★ 把它挂到**夹具执行者**身上：Tools 那两处要量的正是"挂给了谁"与
      //   "智能体详情里挂载了什么"。没人挂的工具只能量到"未挂给任何智能体"，
      //   而"挂了一个"是另一条显示分支——两条都得有夹具才量得全。
      //
      //   挂在夹具执行者（而不是播种的那个）上：探针要在 agents 页按名字找到
      //   这一行，名字是确定的，不依赖列表顺序。
      const agents = (await (await fetch(`${base}/api/agents`)).json()).agents ?? []
      const fixtureExec = agents.find((a) => a.name === '探针用的执行者')
      if (!fixtureExec) {
        log(yellow('⚠ 找不到夹具执行者——"挂给了谁"那几条会量到空态'))
      } else {
        const put = await fetch(`${base}/api/agents/${encodeURIComponent(fixtureExec.id)}/tools`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ toolIds: [tool.id] }),
        })
        if (!put.ok) log(yellow(`⚠ 把夹具工具挂到执行者上失败（HTTP ${put.status}）`))
      }
    }
  } catch (err) {
    log(yellow(`⚠ 装夹具工具时出错：${err}`))
  }

  // ══════════════════════════════════════════════════════════════════
  // 造**新建任务三步链**的夹具：两个审核者 + 一个执行者
  // ══════════════════════════════════════════════════════════════════
  //
  //   · `CHAIN_REVIEWER`：**带标准**（D37：没有标准的审核者拿不到审核任务）
  //     + 一个**已装**工具包里的动作（`probe-tool.clean-notes`）。③ 要量的
  //     正是"那个审核者当前允许的动作"；
  //   · `CHAIN_EMPTY_REVIEWER`：带标准、**一个动作都没有**。③ 的空态有两档
  //     （"没有审核者" / "有审核者但没动作"），后者只有这么一个 agent 才量得到，
  //     而它说的那句后果（"判决只会给出结论，不会触发任何操作"）是另一档没有的；
  //   · `CHAIN_EXECUTOR`：`reviewerAgentId` 指向第一个审核者 —— 于是 ② 的
  //     "跟随"那一项**真的跟得到一个人**（"跟随但没配"是另一档）。
  //
  // ⚠️ **顺序**：必须在上面那次 `POST /api/tools` **之后**。
  //    `POST /api/agents` 保存时会拿 `allowedActions` 对着**已安装的工具包**校验
  //    （`parseAgentAllowedActions`），装之前建必然 400（"动作来自还没安装的工具包"）。
  //
  // ⚠️ **`runtimeKey: 'generic'`**：端到端那两条要真的点一次「创建并派发」，
  //    于是 daemon 会去 spawn 那个 runtime 的命令。`claude` 在这台机器上是装了
  //    （会真的拉起一个模型去干活），而 `generic` 的命令是 `agent-cli`——它不
  //    存在，run 会**立刻**以 ENOENT 失败。这里要的只是"那条 run 被创建出来、
  //    带上了哪一态的 reviewer"，执行本身跑不跑得起来与这条断言无关，
  //    所以刻意选那个跑不起来的 runtime：探针不该替使用者去调真的 CLI。
  //
  // ⚠️ 三个都**不抢"默认"**（默认是播种的那个执行者）：`defaultAgent.*` 那一组
  //    量的是徽章只有一个、预选的是设过的那个。
  const chainFixture = { executorId: '', reviewerId: '', emptyReviewerId: '' }
  try {
    const createAgent = async (body) => {
      const res = await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const detail = await res
          .json()
          .then((p) => p.error ?? '')
          .catch(() => '')
        log(
          yellow(
            `⚠ 造三步链夹具 agent 失败（${body.name}，HTTP ${res.status}${detail ? `：${detail}` : ''}）`,
          ),
        )
        return null
      }
      return await res.json()
    }

    const reviewer = await createAgent({
      name: CHAIN_REVIEWER,
      role: 'reviewer',
      reviewStandard: {
        name: '三步链夹具标准',
        body: '# 三步链夹具标准\n\n只看结论有没有依据。',
      },
      allowedActions: [CHAIN_ACTION],
      // ★ D43：这个审核者长期钉了一份固定参数——新建任务 ③ 的编辑器默认值
      //   就是它，改过才算"这一次的覆盖"。
      actionParams: { [CHAIN_ACTION]: { text: '长期钉的' } },
    })
    const emptyReviewer = await createAgent({
      name: CHAIN_EMPTY_REVIEWER,
      role: 'reviewer',
      reviewStandard: {
        name: '空权限夹具标准',
        body: '# 空权限夹具标准\n\n只看产出在不在。',
      },
    })
    // 执行者最后建：它要指向上面那个审核者（`validateRoleAndReviewer` 会查存在性）
    const executor = await createAgent({
      name: CHAIN_EXECUTOR,
      role: 'executor',
      runtimeKey: 'generic',
      ...(reviewer ? { reviewerAgentId: reviewer.id } : {}),
    })

    if (reviewer && emptyReviewer && executor) {
      chainFixture.executorId = String(executor.id)
      chainFixture.reviewerId = String(reviewer.id)
      chainFixture.emptyReviewerId = String(emptyReviewer.id)
    } else {
      log(yellow('⚠ 三步链夹具没造全——新建任务那一组会量到空值'))
    }
  } catch (err) {
    log(yellow(`⚠ 造三步链夹具时出错：${err}`))
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
      // `--virtual-time-budget` 决定了 dump 的时机：给它足够长，让探针把四步都跑完。
      // ⚠️ 它量的是**虚拟时间**（`setTimeout` 是虚拟的，网络请求是真的），所以
      //    每加一段"等界面真的变了"的检查都会吃掉它。30s 那档在"配过但不可用"
      //    那一组加进来之后**不够了**（实测 dump 出来时探针还在跑，`done` 没写），
      //    于是放宽到 60s——真正兜住"跑不完"的是下面 `TIMEOUT_MS` 那个 deadline
      //    （默认 120s 真实时间），所以这里放宽只是让**跑得完的**探针跑完。
      // ⚠️ 60s 那档在「新建任务的三步链」那一组（两次真实提交 + 等界面走完 +
      //    从接口读回那条 run）加进来之后也紧了：那一组里有好几处 `until()`，
      //    而**超时的** `until()` 一次就吃掉 15s 虚拟时间。放宽到 120s。
      //    放宽本身没有代价：探针一跑完页面就空闲，剩下的虚拟预算会**瞬间**
      //    用光（虚拟时间在任务队列空的时候是直接跳过去的），dump 不会变慢。
      '--virtual-time-budget=120000',
      '--dump-dom',
      // ★ 把夹具路径交给探针页：抽屉里那次安装是"真的往输入框里打字"驱动的，
      //   而探针不可能自己编出 `.cache/layout-probe/…` 这个绝对路径。
      // ★ 三步链那三个 id 与动作名同样从 URL 传（与工具路径一个理由：夹具在
      //   Node 侧造，探针**不许**靠"列表里的第一个"这种脆假设去找它们）。
      `${base}/${PROBE_NAME}?badToolPath=${encodeURIComponent(brokenToolFixtureDir)}&uiToolPath=${encodeURIComponent(uiToolFixtureDir)}` +
        `&chainExecutor=${encodeURIComponent(chainFixture.executorId)}` +
        `&chainReviewer=${encodeURIComponent(chainFixture.reviewerId)}` +
        `&chainEmptyReviewer=${encodeURIComponent(chainFixture.emptyReviewerId)}` +
        `&chainAction=${encodeURIComponent(CHAIN_ACTION)}`,
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
        failures.push({ view: c.view, label: c.label, got: c.show ? c.show(v, facts) : JSON.stringify(v) })
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
      // ⚠️ `show` 与 `ok` 一样收得到 `facts`：写"实测 736px / 栏宽 416px"这种
      //    对照说明时要用另一个事实。只给值的话就得把两个数拼进同一个 key。
      const shown =
        v === undefined ? dim('—') : dim(c.show ? c.show(v, facts) : JSON.stringify(v))
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
