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
 *      绝不碰 ~/.agentdeck，也不写任何仓库外的地方）。首启会播种一对
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

import { execFileSync, spawn, spawnSync } from 'node:child_process'
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
/**
 * Chrome 的 `--virtual-time-budget`（毫秒，**虚拟**时间）。
 *
 * ★ 2026-10 起可调：它与 `TIMEOUT_MS`（真实时间）是两把不同的闸，而"探针没在超时前
 *   给出结果"这句话可能是**任意一把**先到：
 *   · `TIMEOUT_MS` 到了 ⇒ 我们主动杀掉 Chrome，dump 被截断（甚至 0 字节）；
 *   · 虚拟预算到了 ⇒ 探针还在跑，dump 里 `done` 不是 true（但 `#out` 里有**跑到
 *     哪一段**的全部事实，见 `check-facts.mjs`）。
 *   虚拟时间在任务队列空的时候是**直接跳过去**的，所以调大它的代价通常很小；而当
 *   有过期断言在超时（每条 `until()` 吃 15s 虚拟时间）时，调大是唯一能看到更多段落的
 *   办法。两者一起给：`PROBE_VIRTUAL_MS=900000 PROBE_TIMEOUT_MS=900000 pnpm run probe:layout`。
 */
const VIRTUAL_MS = Number(process.env.PROBE_VIRTUAL_MS ?? 300_000)

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
/**
 * 三步链夹具那个**组**的名字（2026-10 起长期行动权限的唯一权威是组）。
 */
const CHAIN_GROUP = '探针用的三步链编队'

const CHECKS = [
  // ── 智能体：主从布局 ──
  { view: '智能体', key: 'agents.gotData', label: 'agent 数据到得了界面（列表不是空的）', ok: (v) => v === true },
  { view: '智能体', key: 'agents.cardCount', label: '渲染出 agent 卡片', ok: (v) => v >= 1, show: (v) => `${v} 张` },
  {
    view: '智能体',
    key: 'agents.everyCardWellFormed',
    label: '每张卡片都有名字、角色徽章、一行说明（摘要 + 元信息，2026-10 由两行合并）',
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
  { view: '智能体', key: 'agents.wideListDisplay', label: '宽屏左栏可见', ok: (v) => v === 'flex' },
  { view: '智能体', key: 'agents.narrowListDisplay', label: '窄屏 + 选中详情时列表隐藏', ok: (v) => v === 'none' },
  { view: '智能体', key: 'agents.narrowDetailDisplay', label: '窄屏 + 选中详情时详情可见', ok: (v) => v === 'flex' },
  // ⚠️ 2026-10：原来这里有四条针对**窄屏返回按钮**的断言（宽屏不出现 / 窄屏出现 /
  //    点它回到列表 / 点它之后右栏消失）。那个按钮已经不存在了——AgentDetail 改成
  //    "选中即编辑"（没有查看态）、栏头交给 `MainArea` 渲染，而智能体页没给它
  //    `backLabel`。窄屏的出口与任务页同一个：**侧边栏那一项**（全屏常驻、最容易
  //    点到）。判据因此换成"真的出得去"，而不是"某个按钮在不在"。
  { view: '智能体', key: 'agents.narrowExitFound', label: '★ 窄屏的出口在（底部「取消」：放弃草稿 + 退出这一栏）', ok: (v) => v === true },
  { view: '智能体', key: 'agents.afterExitClass', label: '★★ 点出口之后 with-detail 撤掉（真的回到列表，不是"按钮在但走不掉"）', ok: (v) => !String(v).includes('with-detail') },
  { view: '智能体', key: 'agents.afterExitListDisplay', label: '★ 出口之后左栏回来', ok: (v) => v === 'flex' },
  { view: '智能体', key: 'agents.afterExitDetailDisplay', label: '★★ 窄屏下出口之后详情栏消失（否则使用者卡在一张表单里）', ok: (v) => v === 'none' },
  {
    view: '智能体',
    key: 'agents.detailNoHero',
    label: '★ 选中即编辑：右栏**没有 hero 头**（2026-10 使用者拍板去掉预览页，与智能体组页同款）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.detailNoEditButton',
    label: '★★ 也没有「编辑」按钮——**没有查看/编辑两态**（两个态是"改了没保存"最容易被误会的地方）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.detailEditableInPlace',
    label: '★ 而卡片里就是能改的控件（角色卡 + 指令框）——"选中即编辑"要真的落成能改，不是换了个空壳',
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
    key: 'agents.noProvisionalRuntime',
    label: '★ 未接真实 CLI 的 runtime（evidence 非 verified）不进身份接口的 runtimes 数组（UI 全从它来，2026-10 起不显示未验证 runtime）',
    ok: (v) => v === true,
    show: (v) => (v === null ? 'null' : String(v)),
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
    label: '每张 runtime 卡都至少有一行（名字+版本还在）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.noPageIntro',
    label: '★ 智能体页**没有**页头导语（D63 按要求去掉："这里配置每个智能体…"——那句在复述卡片已经在说的话）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'common.disabledButtonsExplained',
    label: '★ 置灰的按钮都写了「为什么不能点」（项目纪律）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'common.drawerHeadsStandard',
    label: '★ 抽屉头部只有一种写法（`.drawer-head`；技能页目录抽屉原来是裸 `<header>`，样式全丢）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'common.noHintStacking',
    label: '提示文字不叠加两档字号（`hint faint small` 那种写法已清掉）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.runtimeCardMinimal',
    label: 'CLI 卡极简：只剩「claude + 版本」，核对/会话/版本支持那些行全没了',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.settingsDraftDiscarded',
    label:
      '★★★ 「设置」里改过内容、**没保存就关掉**，重开时必须回到**打开时那一份**（已保存的值，空也算一份）——这条来自使用者的原话："我修改了内容，没有保存直接点关闭或者取消后，重新打开，内容没有恢复保存前的内容"',
    ok: (v) => v === true,
  },

  // ── 任务：同一套主从 + 去重字样 ──
  { view: '任务', key: 'tasks.gotRows', label: '夹具任务渲染成了表格行（否则下面那条会空过）', ok: (v) => v === true },
  {
    view: '任务',
    key: 'tasks.firstRowStageCell',
    label: '从没跑过的那行：标签「执行中」+ 额外信息「还没开始执行」',
    ok: (v) => /^执行中\s+还没开始执行/.test(String(v)),
  },
  {
    view: '任务',
    key: 'tasks.heightSpread',
    label: '★ 行高与标题长度**无关**：长标题与短标题的行一样高（差 ≤ 2px）',
    ok: (v) => typeof v === 'number' && v <= 2,
    show: (v) => `差 ${v}px`,
  },
  {
    view: '任务',
    key: 'tasks.maxRowHeight',
    label: '行高还有个上限（两条都是矮的，也别是"两个都很高"）',
    ok: (v) => typeof v === 'number' && v <= 120,
    show: (v) => `${v}px`,
  },
  {
    view: '任务',
    key: 'tasks.titleClipped',
    label: '长标题确实被截断了（否则"行高无关"是空过的）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.detailTitleAfterClick',
    label: '点一行会打开它的详情，且标题是**完整**的（列表里那份是截断的）',
    ok: (v, facts) =>
      typeof v === 'string' && v.length > 0 && v === facts['tasks.clickedRowTitle'],
    show: (v) => (v === null ? 'null' : `"${String(v).slice(0, 18)}…"`),
  },
  {
    view: '任务',
    key: 'tasks.detailHasTimestamp',
    label: '列表只留了日期，完整时间戳（含时分）在详情里还看得见',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.foldHeadsAreButtons',
    label: '★ 折叠区块头部是真按钮 + aria-expanded（D69.9 详情重排）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.neverRunDescOpen',
    label: '★ 从没跑过的任务：描述默认展开（D69.9 状态驱动：未跑时描述是唯一正文）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.foldToggles',
    label: '★ 点折叠头真的能收起 / 再展开（D69.9 折叠不是摆设）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.decideBarSticky',
    label: '★ 裁决条 sticky 钉在详情栏底部（D69.10：超一屏也永远够得着通过/反馈/放弃；D69.14 起标题「这条任务怎么办」已删）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.noDecideHeading',
    label: '★ 词条：裁决区不再有「这条任务怎么办」标题（D69.14 使用者要求去掉字样）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'heads.tasksEmptyNoHead',
    label: '★ 任务空态没有栏头（D69.15.2：空态=纯提示，不再挂返回按钮/空标题/边框线）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'heads.chatTitleRowTop',
    label: '★ 聊天标题顶在栏头行首（D69.15.2：改名按钮不再把标题顶低 7px）',
    ok: (v) => v === true,
  },
  // ⚠️ 智能体页 2026-10 起**没有 hero**（选中即编辑，没有预览页头）。D69.15 的
  //    "栏头标题/副题统一"由任务与聊天那两条继续钉着；这两条在智能体页只能认
  //    `NO-HERO` / `NO-HINT`——留着它们是为了**继续钉住"这一页不该长出 hero"**
  //    （真想加回预览页时，这两条会红，提醒同步那条决定）。
  {
    view: '智能体',
    key: 'heads.agentsHeroFullBleed',
    label: '智能体页**没有**栏头 hero（`NO-HERO` 才是对的：选中即编辑；D69.15.2 的通栏由任务/聊天钉着）',
    ok: (v) => v === true || v === 'NO-HERO',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '智能体',
    key: 'heads.agentsRoleHintFs',
    label: '智能体页**没有** hero ⇒ 也没有角色的 hero 副题（`NO-HINT` 才是对的）',
    ok: (v) => v === true || v === 'NO-HINT',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '任务',
    key: 'heads.tasksHeadMetrics',
    label: '★ 任务详情栏头标题统一指标（D69.15：字号 fs-lg 17px、留白 16/12、下边框 1px——使用者抓的 Title 高度不一致）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'heads.agentsHeadTitleFs',
    label: '智能体栏头标题字号 fs-lg 17px——这一页已经没有栏头了，所以也只认 `NO-HERO`',
    ok: (v) => v === true || v === 'NO-HERO',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '聊天',
    key: 'heads.chatHeadTitleFs',
    label: '★ 聊天栏头标题字号 fs-lg 17px（D69.15 标题统一）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.deleteButtonPerRow',
    label: '每项右侧有独立的删除按钮（主按钮之外、不是按钮套按钮）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.runStatusLocalized',
    label: '★ 执行记录的状态是中文（不再把协议英文值 completed/running/… 摊在徽标上）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.rowsNotIndented',
    label: '★ 任务行没有 `<ul>` 默认的左缩进（行与标题都从左边起，不是"内容靠右"）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.noListMarker',
    label: '行首没有列表圆点（`list-style: none`）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.titleWidth',
    label: '标题独占一行：宽度接近整个列表栏（≥ 240px）',
    ok: (v) => typeof v === 'number' && v >= 240,
    show: (v) => `${v}px`,
  },
  {
    view: '任务',
    key: 'tasks.boardButtonFound',
    label: '看板/列表可以切换（下面两条要在看板里量）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.boardColumnCount',
    label:
      '★ 看板是**六档**状态（执行中 / 待审查 / 行动中 / 等待人处理 / 已完成审查 / 已放弃，D47）',
    ok: (v) => v === 6,
    show: (v) => `${v} 列`,
  },
  {
    view: '任务',
    key: 'tasks.boardHasActingColumn',
    label: '★ 「行动中」有自己的一列（判决要求做的动作还没做完时不再显示成"已审查"）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.boardColumns',
    label: '★ 「待人工」排在「已审查」之前——从左往右越来越接近结束',
    ok: (v) =>
      Array.isArray(v) &&
      v.some((t) => t.includes('等待人处理')) &&
      v.findIndex((t) => t.includes('等待人处理')) <
        v.findIndex((t) => t.includes('已完成审查')),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  { view: '任务', key: 'tasks.layoutPresent', label: '任务页也是主从（左右两栏都在）', ok: (v) => v === true },
  {
    view: '任务',
    key: 'tasks.mainOverflowY',
    label: '任务页 `:has()` 同样生效',
    ok: (v) => v === 'hidden',
  },
  {
    view: '任务',
    key: 'tasks.duplicateStageTextCount',
    label: '渲染结果里「等待审核」出现 0 次（使用者点名要去掉的重复字样）',
    ok: (v) => v === 0,
    show: (v) => `${v} 次`,
  },

  // ── Skills：安装面板在抽屉里 ──
  { view: '技能', key: 'skills.title', label: '技能页渲染（中文页名）', ok: (v) => v === '技能' },
  { view: '技能', key: 'skills.oldInlinePanel', label: '正文里不再有旧的内嵌安装面板（`.install-panel`）', ok: (v) => v === false },
  {
    view: '技能',
    key: 'skills.noLegacyDrawerBeforeOpen',
    label: '★ 没打开安装面板时，页面上**没有** `.drawer`（它是主区面板，不是弹框）',
    ok: (v) => v === true,
  },
  { view: '技能', key: 'skills.tableRows', label: 'skill 列表有内容', ok: (v) => v >= 1, show: (v) => `${v} 行` },
  {
    view: '技能',
    key: 'skills.descriptionShown',
    label: '★ 名称列把 SKILL.md frontmatter 里的说明显示出来了（不是永远空的一格）',
    ok: (v) => v === true,
  },
  { view: '技能', key: 'skills.openButtonFound', label: '找得到「安装技能」按钮', ok: (v) => v === true },
  {
    view: '技能',
    key: 'skills.uninstallButtonFound',
    label: '★ 每行有「卸载」（D38 补齐：原来"装了要删只有改库"）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.filesCellFormat',
    label: '★ 文件列是 `SKILL.md`（夹具没带支持文件；不许显示成"0 个文件"，D69.5）',
    ok: (v) => v === 'SKILL.md',
  },
  {
    view: '技能',
    key: 'skills.slugHeader',
    label: '★ 首列叫「技能」（不是「标识」，D69.7）',
    ok: (v) => v === '技能',
  },
  {
    view: '技能',
    key: 'skills.sourceBeforeVersion',
    label: '★ 「来源」列在「版本」之前（D69.7 统一列序）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.slugCellFlexWrap',
    label: '★ 首格 `▸ slug` 是 flex 且不折行（D69.8：列一窄就换行的问题的根治）',
    ok: (v) => v === 'nowrap',
  },
  {
    view: '技能',
    key: 'skills.panelClass',
    label: '打开的是主区就地面板（`.main-panel`，不是 `.drawer`）',
    ok: (v) => String(v).includes('main-panel') && !String(v).includes('drawer'),
  },
  {
    view: '技能',
    key: 'skills.panelInMain',
    // ★ 2026-10（使用者：「安装都是右侧弹框，需要改成类似新建智能体那样，在主区
    //   显示」）：面板必须是 `.main` 内容盒里的一块，且**不是**浮层。这一条同时
    //   钉住"左右边缘对齐主区"——量的是真盒子，不是某个 class 在不在。
    label: '★ 安装面板在主区内容盒里、且不是浮层（position 不是 fixed/absolute）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.panelNoBackdrop',
    label: '★ 没有背景遮罩（它不是对话框——后面的列表是被换掉的，不是被挡住的）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.panelReplacesList',
    label: '★ 面板**取代**列表（开着时表格不在 DOM 里，而不是被推到视口外）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.panelBackVisible',
    label: '★ 头部有**一直可见**的返回入口（列表被换掉了，它是唯一的路）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.panelBackLabel',
    label: '返回入口说的是「← 返回技能列表」',
    ok: (v) => v === '← 返回技能列表',
  },
  {
    view: '技能',
    key: 'skills.backReturnsToList',
    label: '★ 点返回就回到列表（表格回来、面板没了）',
    ok: (v) => v === true,
  },
  { view: '技能', key: 'skills.footButtonText', label: '面板底部是主操作「检查并安装」', ok: (v) => v === '检查并安装' },
  { view: '技能', key: 'skills.tabCount', label: '三个来源页签都在（路径/GitHub · 远端目录 · 本地清单）', ok: (v) => v === 3, show: (v) => `${v} 个` },
  { view: '技能', key: 'skills.duplicateCloseInTabs', label: '页签条里没有与抽屉头重复的「关闭」', ok: (v) => v === false },
  {
    view: '技能',
    key: 'skills.remoteUnavailableLabel',
    // ★ 2026-10 使用者报过："安装 skill 提示远端不可用，我明确已经启动 remote 了"。
    //   根因是模板里裸用 store（`{#if remoteError}`，对象恒为真）⇒ 这条提示**无条件**
    //   显示、冒号后面空着。判据刻意**与环境无关**：没出现也算通过（远端在跑、
    //   目录拉到了就该没有它），出现了就必须带上真实错误文字。
    label: '★「远端不可用」出现时必须带真实错误（冒号不许空着——2026-10 那个 bug）',
    ok: (v) =>
      typeof v === 'string' && (v === '(没有出现，正常)' || /：\s*\S/.test(v)),
  },
  {
    view: '技能',
    key: 'skills.remoteStates',
    // ⚠️ 那条 bug 同时把"未登录"与"目录为空"两个状态压成了死代码，而界面上
    //   看不出少了东西（"整页只有一句提示"也像正常）。所以这里钉"四种里至少有一种"。
    label: '★ 远端目录页签的状态至少渲染出一种（不可用 / 未登录 / 空 / 表）',
    ok: (v) => typeof v === 'string' && v !== '' && v !== '(空)',
  },
  {
    view: '技能',
    key: 'skills.escClosesPanel',
    label: 'Esc 能关掉安装面板（与同一页的设置抽屉同一手感）',
    ok: (v) => v === true,
  },

  // ── 本地技能目录（勾一个别的 AI 工具的目录 ⇒ 看见 ⇒ 能挂）──
  { view: '技能', key: 'skills.settingsButtonFound', label: '★ 页头有「设置」入口', ok: (v) => v === true },
  {
    view: '技能',
    key: 'skills.dirsCandidateCount',
    label: '内置候选目录都列出来了（claude / codex / cursor / agents）',
    ok: (v) => v === 4,
    show: (v) => `${v} 个`,
  },
  {
    view: '技能',
    key: 'skills.dirsCandidateLabels',
    label: '候选用的是工具名（不是路径或 id）',
    ok: (v) => Array.isArray(v) && v.includes('Claude Code') && v.includes('Codex'),
    show: (v) => (Array.isArray(v) ? v.join('/') : String(v)),
  },
  { view: '技能', key: 'skills.dirsAllHavePath', label: '每个候选都显示了完整路径（要能核对自己勾的是哪个）', ok: (v) => v === true },
  { view: '技能', key: 'skills.dirsAllHaveCheckbox', label: '每个候选都有勾选框', ok: (v) => v === true },
  {
    view: '技能',
    key: 'skills.dirsCheckboxWidth',
    label: '★★ 勾选框是勾选框的大小（全局 `input { width: 100% }` 会把它撑成整行，实测 480px ⇒ 路径被挤成 0 宽）',
    ok: (v) => typeof v === 'number' && v > 8 && v <= 24,
    show: (v) => `${v}px`,
  },
  {
    view: '技能',
    key: 'skills.dirsPathWidth',
    label: '★ 路径占住了整行剩下的宽度（没被挤成 0）',
    ok: (v, all) => typeof v === 'number' && typeof all['skills.dirsRowWidth'] === 'number' && v > all['skills.dirsRowWidth'] * 0.6,
    show: (v) => `${v}px`,
  },
  {
    view: '技能',
    key: 'skills.dirsBodyOverflowX',
    label: '★ 抽屉内容不横向溢出',
    ok: (v) => v === 0,
    show: (v) => `溢出 ${v}px`,
  },
  {
    view: '技能',
    key: 'skills.dirsRowHeights',
    label: '★ 候选行没有被撑高（每行一两个文本行的高度）',
    ok: (v) => Array.isArray(v) && v.every((h) => h > 0 && h < 110),
    show: (v) => (Array.isArray(v) ? v.join('/') : String(v)),
  },
  {
    view: '技能',
    key: 'skills.dirsUncheckNote',
    label: '★ 写清了"取消勾选不会删掉什么、正在用的不会抽走"',
    ok: (v) => typeof v === 'string' && v.includes('不会删掉') && v.includes('摘'),
  },
  { view: '技能', key: 'skills.dirsAddInputFound', label: '能自己填一个路径（内置表之外也要能勾）', ok: (v) => v === true },
  {
    view: '技能',
    key: 'skills.localSkillCount',
    label: '★★ 勾上夹具目录之后，那两个 skill 真的出现在列表里',
    ok: (v) => v === 2,
    show: (v) => `${v}/2 个`,
  },
  {
    view: '技能',
    key: 'skills.localBadgeHasPath',
    label: '★ 来源徽标写的是那个目录（不是笼统的「本机自建」）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.localUninstallDisabled',
    label: '★ 来自本地目录的那条不给卸载（删了也会被下次扫描带回来）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.dirsSkipNote',
    label: '★ 空目录被如实报出来（"勾了却少一个"要能追到原因）',
    ok: (v) => typeof v === 'string' && v.includes('probe-empty-dir') && v.includes('SKILL.md'),
  },
  {
    view: '技能',
    key: 'skills.dirsCustomRow',
    label: '自己填的路径单独列出来（要能看见、能取消）',
    ok: (v) => typeof v === 'string' && v.includes('fixture-local-skills'),
  },
  {
    view: '智能体',
    key: 'skills.pickerHasLocalSkill',
    label: '★★ 读进来的 skill 能挂给智能体（选择器里有它）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'skills.pickerCheckboxTook',
    label: '★ 真的能勾上（不是只有一行字）',
    ok: (v) => v === true,
  },

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
    // ★ 2026-10（D70）：侧边栏第五项变第六项——「智能体组」加在「智能体」后面
    //   （先有"人"，才有"队"）。这一条与下面就差一个数，两条一起才守得住"中间
    //   少一项 / 多一项"。
    label: '★ 侧边栏是六项（聊天最轻、排第一；D58 把「新建任务」并进「任务」、D70 加了「智能体组」）',
    ok: (v) => v === 6,
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
      '★★ 侧边栏**整串顺序**就是这六项（顺序错、中间少/换一项、多出第 7 项都会红——只数个数＋看末项会漏掉中间那几种）',
    ok: (v) =>
      JSON.stringify(v) ===
      // ★ 聊天排在最前：它是最轻的入口（先聊清楚），而且它要管多个对话，
      //   本身就是一个完整页面。
      // ★ 2026-10（D58）：「新建任务」不再是侧栏一项——它并进了「任务」，
      //   建任务变成那一页右上角的主操作（下面那条 `tasks.createAction*` 钉它）。
      // ★ 2026-10（D70）：「智能体组」插在「智能体」后面——组是"队"，
      //   紧跟在"人"后面读起来才顺（`Sidebar.svelte` 的 `ITEMS` 是唯一出处）。
      JSON.stringify(['聊天', '任务', '智能体', '智能体组', '技能', '工具']),
    show: (v) => (Array.isArray(v) ? v.join(' → ') : String(v)),
  },
  { view: '工具（D40）', key: 'tools.title', label: '工具页渲染出来了', ok: (v) => v === '工具' },
  {
    view: '任务',
    // ★ 2026-10（D58）：合并之后**建任务的入口在这一页**。这一条钉的正是"合并"
    //   这件事本身：少一个入口（侧栏）就必须多一个（这一页），否则功能是**没了**
    //   而不是"搬家"——而那种缺失在界面上看不出来（只是"没地方建"）。
    key: 'tasks.createActionLabel',
    label: '★ 任务页顶栏有「新建任务」主操作（D58 把建并入这一页）',
    ok: (v) => v === '新建任务',
  },
  {
    view: '任务',
    key: 'tasks.createActionKind',
    label: '★ 它是 primary（这一页的主操作，不是与模式开关并列的第三个开关）',
    ok: (v) => v === 'primary',
  },
  {
    view: '任务',
    key: 'tasks.createActionReachesForm',
    label: '★★ 点它**真的到得了那个表单**（不是画了一个按钮）',
    ok: (v) => v === true,
  },

  // ══════════════ 聊天（闭环的旁路）══════════════
  {
    view: '聊天',
    key: 'chat.hasListPane',
    label: '左栏（对话列表）在',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.hasDetailPane',
    label: '右栏（消息流）在',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.twoColumnsSideBySide',
    label: '★ 两栏真的**并排**（左栏整个在右栏左边，两栏各自有宽度）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.listNarrowerThanDetail',
    label: '左栏比右栏窄（对话列表是索引，消息流是正文）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.detailWorkDirReadOnly',
    label: '详情页的工作目录只读（没有改名/保存/改回平台分配的控件）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.draftWorkDirInput',
    label: '「新对话」界面在 Agent 选择器下面有工作目录输入（可留空=自动分配）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.deleteButtonPerItem',
    label: '每项右侧有独立的删除按钮（主按钮之外、不是按钮套按钮）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.deleteConfirmUsesModal',
    label: '★ 点删除弹的是**平台自己的居中对话框**（不是 window.confirm），且「取消」不删',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.activeItemBorder',
    label: '★ 对话列表的选中框与任务列表**完全一致**（同一个描边色——原来这里是灰的、任务那边是强调色）',
    ok: (v, facts) =>
      typeof v === 'string' &&
      v !== '' &&
      v !== 'rgba(0, 0, 0, 0)' &&
      v === facts['tasks.activeItemBorder'],
    show: (v, facts) => `${v}（任务：${facts['tasks.activeItemBorder']}）`,
  },
  {
    view: '聊天',
    key: 'chat.activeItemBackground',
    label: '选中项的背景色两处也一致',
    ok: (v, facts) =>
      typeof v === 'string' && v !== '' && v === facts['tasks.activeItemBackground'],
    show: (v, facts) => `${v}（任务：${facts['tasks.activeItemBackground']}）`,
  },
  {
    view: '聊天',
    key: 'chat.emptyStateShown',
    label: '没有对话时列表里是空态（不是一片空白）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.composerInsideDetail',
    label: '★★ 输入框在**右栏里**（上一回的表单就是这样画进左栏、横盖右栏的）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.composerNotInList',
    label: '★ 输入框**不在**左栏里',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.agentPickerOrHint',
    label: '新对话要有执行者选择器，没有执行者时要给提示（不能让人白打一段字）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.enterHint',
    label: '★ 页面上写明 Enter 发送 / Shift+Enter 换行（与「要做什么」**正好相反**）',
    ok: (v) => v === true,
  },
  // ⚠️ 这里原有 `chat.boundaryHint`（"页面上写明这里不动手"）：2026-09 那句话
  //    按要求从页面上拿掉了，断言一起删——留一条量不存在的东西的断言，比没有更坏。
  {
    view: '聊天',
    key: 'chat.bubbleRadiusRule',
    label:
      '★ 气泡圆角不是胶囊：要么是圆角令牌，要么是个小像素值（100px 那种在多行文本上会变成两条夸张的弧线）',
    ok: (v) => {
      if (typeof v !== 'string') return false
      const t = v.trim()
      // 令牌就是对的：`--radius` / `--radius-sm` 都是 8px 级别的
      if (/^var\(--radius(-sm)?\)$/.test(t)) return true
      const px = /^(\d+(?:\.\d+)?)px$/.exec(t)
      return px !== null && Number(px[1]) <= 12
    },
    show: (v) => String(v),
  },
  {
    view: '任务',
    key: 'tasks.filesColumnStillRenders',
    label:
      '★★ 任务详情结果区**右侧栏**照旧能列（D69.9.1 文件回右侧栏、不折叠——使用者：高频项；共用组件那条路径没坏：base 传错会表现成"取不到"或一直骨架屏，两者肉眼都不明显）——要求真的拿到东西，且**不许**出现"取不到"那一块',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.logModeNoOuterScroll',
    label: '★★ 点「完整日志」后详情栏**不再有外置滚动条**（D69.12：双滚动条——内置+外置，外置不该有；详情栏 flex + overflow hidden，滚动全在日志自己的盒子里）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.logToggleLabel',
    label: '★ 词条：「完整日志」按钮文字精确匹配（D69.13；substring 挡不住被改回「看完整日志」）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.showFinalResultLabel',
    label: '★ 词条：切过去后同一按钮显示「最后结果」（D69.13）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.logFillsPane',
    label: '★ 日志是详情栏主体（高度占比过半 = flex 吃满剩余空间，不再 26rem 固定高低）',
    ok: (v) => typeof v === 'number' && v > 0.45,
    show: (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : String(v)),
  },
  {
    view: '聊天',
    key: 'chat.filesPanelPresent',
    label:
      '★★ 对话打开着的时候，右栏底部有「工作目录的文件」那一栏（任务详情那一栏与它是同一个组件，只是"问谁"不同）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.filesListsFixtureAndManagedLast',
    label:
      '★★★ 展开之后真的列得出目录里的东西，而且**平台注入物排在产出后面**——顺序由界面侧的 sortWorkDirEntries 保证（服务端返回的是目录自己的顺序），所以只能在这一层量',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.filesOneLevelThenExpand',
    label:
      '★★ 一次只列一层：没点开 notes/ 之前看不到里面的 deep.txt，点开之后才出现（递归列整棵树会把真正的产出淹掉）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.codeBlockKeepsNewlines',
    label:
      '★★★ 代码块里的换行**真的显示出来**（`white-space` 不是 nowrap/normal，且六行的高度与行数相称）——这条来自一次真实误判：行内代码那条 `nowrap` 被继承进 `pre > code`，十行代码折成一行、`<pre>` 只有 47px，而**看起来像模型没写换行**',
    ok: (v) => v === true,
  },
  {
    view: '外壳',
    key: 'web.shellNotCachedBlindly',
    label:
      '★★★ 外壳（index.html）**每次都核对**（`no-cache` + ETag）——这条来自一次真实误判："聊天页不工作、任务页正常"，实际是那个标签页跑着旧前端：而这边原本一个缓存头都不发，浏览器拿那份外壳没有任何办法',
    ok: (v) => v === true,
  },
  {
    view: '外壳',
    key: 'web.hashedAssetImmutable',
    label:
      '★★ 带内容哈希的产物是 `immutable` 长缓存，而带 `If-None-Match` 回来问时回 **304**（核对要便宜，否则每次刷新都重下 HTML）',
    ok: (v) => v === true,
  },
  {
    view: '外壳',
    key: 'web.identityReportsBuild',
    label:
      '★★ 身份接口报出**这一版界面叫什么**（`webBuild`）：`capabilities` 回答"daemon 是哪一版"，它回答"界面是哪一版"——两者不一致时两边都不报错，只能靠一句可查的话',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerRawIsVerbatim',
    label:
      '★★★ 文件查看器的「原文」**逐字等于接口发回来的字节**（探针自己再 fetch 一次比对）——格式化、重排、去掉空行都会让它红：这一栏存在的意义就是"我看到的就是磁盘上那个文件"',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerMarkdownFaces',
    label:
      '★★ Markdown 两面都对：渲染面里是标题（`h1`），原文面里是字面量 `# 结论`——把 Markdown 当纯文本显示**不报错**，只是少了渲染，所以必须两面都量',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerFrameNotSameOrigin',
    label:
      '★★★ HTML 的渲染面是 iframe，**允许脚本但没有 allow-same-origin**（直接读属性），而且父页面**读不到**它的 document——脚本能跑是为了让 p5 画布那类产出真的画出来，不透明源是为了让 agent 写的页面调不到这个 daemon 的接口',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerBinaryIsHex',
    label:
      '★★ 二进制不当文本渲染：只有说明 + 前若干字节的十六进制（当文本渲染得到的是一屏替换字符，看起来像文件坏了）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerTooBigNoHighlight',
    label:
      '★★ 超过阈值的源码**不着色**，但原文照旧完整，并说明原因（给 8MB 文本套高亮会把页面卡死，而使用者只会以为这一栏很慢）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerVideoPlays',
    label:
      '★★★ 视频渲染成 `<video controls>`，**没有**十六进制/原文那一面，而且 `readyState >= 1`——播放器真的拿到了元数据（一口空黑框挡不住"视频显示不了"这个 bug）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerVideoRange206',
    label:
      '★★★ 带 `Range` 的请求回 **206** + 正确的 `content-range` + 只有那 100 字节（探针自己再整份取一次逐字节比对），且响应有 `accept-ranges: bytes`——这是"能不能拖进度"的判据',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerMediaNoSandboxCsp',
    label:
      '★★★ 媒体响应**不带**那条 sandbox 的 CSP（带了它，浏览器在新标签页里为媒体合成的那张文档自己会被 `default-src none` 管住、视频放不出来），但 `nosniff` 还在；而文本/HTML 那一档的 CSP **一个字没松**',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerAudioPlays',
    label: '★ 音频同理：渲染成 `<audio>`、拿到元数据、不当二进制',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.fileViewerUnplayableSaysWhy',
    label:
      '★★ 放不出来的容器（用冒充 `.mkv` 的垃圾字节造，确定性）**退化成"浏览器放不了"这句人话**，而不是一口黑框、也不是十六进制——不说清是谁的事，使用者会去查一个不存在的 bug',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.filesHiddenInDraft',
    label: '★ 草稿态**不画**那一栏（还没有对话，也就还没有目录）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.filesUnsupportedOnOldDaemon',
    label:
      '★★★ 旧 daemon（没有 `conversation-files`）⇒ 那一栏**说明原因**、不许真去列——任务页那边撞过一次：404 的失败被画成骨架屏，"取不到"与"还在加载"长得一模一样',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.hasContent',
    label: '聊天页渲染出来了',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.ownedSkillOption',
    label:
      '★★ 「新对话」的执行者下拉里，除了执行者还有"按 skill 选"这一组——选项文字要说清是哪条 skill、等于跟谁说话',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.allSkillsOffered',
    label:
      '★★★ **所有已安装的 skill** 都在那个下拉里，一条不少——包括没人挂的那条（"有它的执行者"不存在时，这条 skill 由对话自己带着走）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.skillBindsOwner',
    label:
      '★★★ 选了有主的 skill 之后，界面上写出"将使用谁"，而那个名字必须就是**接口上真挂着这条 skill 的执行者**（等于"和有这个 skill 的 agent 对话"这句话本身）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.unownedHiddenOnOldDaemon',
    label:
      '★★★ 旧 daemon（`capabilities` 里没有 `conversation-skills`）：没人挂的 skill **不许出现在下拉里**，并说出原因——旧 daemon 会静默忽略 `skillIds`，界面却会写着"将使用它 + 这条 skill"，两边都不报错（有主的 skill 不受影响）',
    ok: (v) => v === true,
  },
  {
    view: '聊天',
    key: 'chat.orphanSkillSentAsSkillIds',
    label:
      '★★★ 选了没人挂的 skill 之后，**发出去的请求体里真的带上了 skillIds**（界面画对而忘了带，这一轮就是白选——页面上还看不出异常）',
    ok: (v) => v === true,
  },
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
    key: 'tools.descClampApplied',
    label: '★ 说明列的两行截断真的生效（`.desc-clamp` 是 app.css 共用样式）',
    ok: (v) => v === '2',
  },
  {
    view: '工具（D40）',
    key: 'tools.rowActionsFlex',
    label: '★ 操作列是 flex 容器（`.row-actions` 是 app.css 共用样式）',
    ok: (v) => v === 'flex',
  },
  {
    view: '工具（D40）',
    key: 'tools.updatedAtColumn',
    label: '★ 工具表也有「更新于」列（与技能页同一套格式）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.sourceBeforeVersion',
    label: '★ 「来源」列在「版本」之前（与技能页同一列序，D69.7）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.slugCellFlexWrap',
    label: '★ 首格 `▸ slug` 是 flex 且不折行（D69.8）',
    ok: (v) => v === 'nowrap',
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
    key: 'tools.boundGroupNote',
    label: '★ 绑定参数单独成组，并写明"模型看不到也填不了"（说明整块面板只说一次）',
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
    key: 'tools.panelInMain',
    label: '★ 安装面板在主区内容盒里、且不是浮层（与技能页同一套判据）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.panelNoBackdrop',
    label: '★ 没有背景遮罩（它不是对话框）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.panelReplacesList',
    label: '★ 面板**取代**工具列表（开着时表格不在 DOM 里）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.panelBackVisible',
    label: '★ 头部有**一直可见**的返回入口',
    ok: (v) => v === true,
  },
  { view: '工具（D40）', key: 'tools.panelBackLabel', label: '返回入口说的是「← 返回工具列表」', ok: (v) => v === '← 返回工具列表' },
  { view: '工具（D40）', key: 'tools.backReturnsToList', label: '★ 点返回就回到列表', ok: (v) => v === true },
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
  { view: '工具（D40）', key: 'tools.escClosesPanel', label: 'Esc 能关掉安装面板', ok: (v) => v === true },
  {
    // ★ 这一段撤了两次，所以这三条查的是**最终态**（使用者的要求：
    //   「执行智能体不支持"行动"，去掉」，然后「"干活时能用的工具包"…是否也应该去掉」）：
    //   执行者详情里那一段**整段不在**，且「可挂载的工具组」这句不再出现。
    //   原来那五条（detailSectionForExecutor / detailPickerHasFixture /
    //   detailMountHintWording / mountSaveTookEffect / mountRestoreTookEffect）
    //   随那一段一起删了——界面既然不再提供挂载，就没有"从界面上挂一次、看它真的
    //   写进去了"这回事可查。挂载接口本身仍由 `tools-api.test.ts` 覆盖。
    view: '工具（D40）',
    key: 'tools.executorHasNoToolsSection',
    label: '★ 执行者的详情里**没有**「干活时能用的工具包」那一段了',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.executorNoPickLabel',
    label: '★ 「可挂载的工具组」这句在执行者详情里不再出现（使用者看到的就是这一句）',
    ok: (v) => v === true,
  },
  {
    view: '工具（D40）',
    key: 'tools.reviewerHasNoToolsSection',
    label: '★ 审核者的详情里**也没有**工具那一段（只判断不动手；现在两边都没有了）',
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
  { view: '新建表单 / 设置', key: 'template.openButtonLabel', label: '按钮文案就是「新建智能体」', ok: (v) => v === '新建智能体' },
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
    key: 'template.drawerLeavesLayoutAlone',
    label:
      '★★ 打开抽屉前后，主区里**每一块的位置与尺寸都没动**（它曾经被渲染进栏头，把栏头从 167px 撑到 1070px、整垮主从布局）',
    ok: (v) => v === true,
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
    key: 'settings.drawerLeavesLayoutAlone',
    label: '★★ 打开设置抽屉前后，主区里每一块的位置与尺寸都没动',
    ok: (v) => v === true,
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
    label:
      '★ 段里三个**链路**页签：执行 / 审核 / **聊天**（2026-09 加的第三份——聊天不套任务模版，它有自己的 ① 框架）',
    ok: (v) =>
      Array.isArray(v) && v.length === 3 && v[0] === '执行' && v[1] === '审核' && v[2] === '聊天',
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.blockTabLabels',
    label:
      '★★ 每条链路下面有**块**页签：① 框架 / ② 身份 / ③ 任务（2026-10 三框改造——不是合并成一篇）',
    ok: (v) =>
      Array.isArray(v) && v.length === 3 && v[0] === '① 框架' && v[1] === '② 身份' && v[2] === '③ 任务',
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  { view: '新建表单 / 设置', key: 'settings.activeTab', label: '默认停在「执行」', ok: (v) => v === '执行' },
  {
    view: '新建表单 / 设置',
    key: 'settings.activeBlock',
    label: '★ 默认停在「① 框架」那一块',
    ok: (v) => v === '① 框架',
  },
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
    key: 'settings.filledHasFrameVars',
    label:
      '填入默认模版后框里是**真正的框架**（有 `{{runId}}` 这类在用变量，且没有已退役的 `{{prompt}}`）',
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
    key: 'settings.reviewFilledHasVerdict',
    label:
      '审核那份填入默认后带判决契约（`{{verdict}}` 是现在**唯一**的必需变量——材料与标记由平台放，不在模版里了）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.reviewFilledHasNoMaterial',
    label:
      '★ 审核那份的默认模版里**没有** `{{material}}`（材料与标记由平台放——模版里写它会被保存时拒掉）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.varRowCount',
    label: '变量清单真的列出了变量（不是空表）',
    ok: (v) => typeof v === 'number' && v >= 5,
    show: (v) => `${v} 行`,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.varListHasLive',
    label: '变量清单里列着**还在用**的那些（{{runId}} / {{skills}}）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.varListHasNoRetired',
    label:
      '★★ 变量清单里**没有**六个退役变量与 `{{role}}`——列了就等于教人写它（写了会被保存时专门拒掉并说清去处）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.varRowCountIsNine',
    label: '变量表正好九条（退役六个之后）——条数变了就说明表与文档/代码又分叉了',
    ok: (v) => v === true,
  },
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
    key: 'settings.chatTabFound',
    label: '★ 有第三个页签「聊天」（聊天有自己的 ①：它不是任务的又一次投递）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.chatPreviewRenders',
    label: '★★ 在聊天那一档点「预览」真的渲染出来了（接口原来只收 execute / review ⇒ 这个按钮直接报错）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.chatPreviewNoRawVar',
    label: '★ 聊天的预览里也没有没展开的变量',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.savedChat',
    label:
      '★★ 聊天那份**真的落库**了（直接问接口）——写入口只认两个 key 时，快捷键提示照样说"已保存"，而库里一个字都没写',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.reopenedChat',
    label: '★ 重开设置、切到聊天页签，框里是刚存进去的那份（走了一圈库回来）',
    ok: (v) => v === true,
  },
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

  // ── 判断依据（D37 → 2026-09 收口到「指令」）──
  //
  // ★ 这一段量的是**一次删除**：使用者说「移除审核智能体的『审核标准』」，而那件事
  //   能做的前提是判断依据已经并进 ② 身份（= 「指令」）。所以判据有两半：
  //   ① 那个字段名与那一段**一个字都不剩**；
  //   ② 老数据那份正文与"并进来"的入口**都在「指令」那一栏里**（否则就是
  //      "删干净了，顺手把依据也删没了"）。
  //   ⚠️ 只量一半都会假绿：只量①，正文没了也绿；只量②，段还在也绿。
  {
    view: '审核标准',
    key: 'standard.detailHasNoNameBadge',
    label: '★ 审核者详情里**没有**"标准的名字"徽标了（那个字段已删：平台侧没人读它、'
      + '一个审核者只有一份标准所以区分不了什么、默认值又是常量）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.detailShowsBody',
    label: '★ 老数据那份判断依据正文现在显示在「指令」那一栏里（不用去 Skills 页对着 slug 猜）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.noStandardRowLabel',
    label: '★★ 详情里**没有任何一行**叫「审核标准」了（使用者的要求：「移除审核智能体的『审核标准』」）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.noStandardSectionTitle',
    label: '★★ 也没有「用什么标准」那一段的标题（删的是整段，不是把标签换个说法）',
    ok: (v) => v === true,
    show: (v, facts) => `${v}　实测各段标题：${JSON.stringify(facts['standard.detailSectionTitles'] ?? null)}`,
  },
  {
    view: '审核标准',
    key: 'standard.foldInButtonInInstructionsRow',
    label: '★★ 而"把这份判断依据并进「指令」"的入口在「指令」那一栏里（内联老标准原本只能手抄，现在也给了入口）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.skillsSectionStillThere',
    label: '★ 「技能」那一段还在（删的是"标准"，不是"挂载"——skill 的勾选/展示一条都没少）',
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
    key: 'standard.executorEditHasNoActionsSection',
    label: '★ 执行者**点「编辑」之后**也没有「行动权限」段（编辑态走 draft.role，是另一条判据）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.executorEditSectionHeadings',
    label: '编辑态实际渲染出来的段落标题（它必须先有内容，上面那条才作数）',
    ok: (v) => Array.isArray(v) && v.length > 0,
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '审核标准',
    key: 'standard.switchWhileEditingName',
    label:
      '★ 编辑到一半换 agent ⇒ **退出编辑态**（输入框里不会再留着上一个人的草稿；留在编辑态会让人以为还在改 A）',
    ok: (v) => v === '(不在编辑态)',
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '审核标准',
    key: 'standard.switchWhileEditingTitle',
    label: '★ 换过去之后右栏标题是**新的那个人**（不是上一个人的名字）',
    ok: (v) => v === '探针用的执行者',
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '审核标准',
    key: 'standard.switchWhileEditingNoActions',
    label: '★ 编辑到一半换成执行者 ⇒ 不再显示「行动权限」（草稿的 role 是上一个人的时候会露出来）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.switchWhileEditingHeadings',
    label: '换 agent 之后实际渲染出来的段落标题',
    ok: (v) => Array.isArray(v) && v.length > 0,
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
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
    label: '★ 那份动作清单**不在**承载判断依据的那一栏（现在是「指令」）里——同一件事只有一个出处',
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
    label: '有判断依据的审核者不该显示"审不了任何东西"那条警告',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.emptyReviewerFixtureFound',
    label: '★ 夹具里有一个"什么都没写"的审核者（否则下面那条正向断言空过）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.emptyReviewerSwitched',
    label: '★ 右栏真的换成了那个夹具（否则量到的是上一个审核者的头部）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.headlineWhenNoIdentity',
    label:
      '★★ 真的没有依据时那条警告**要出现**（"它审不了任何东西…"）——没有这一半，上面那条负向断言靠"警告永远不显示"也能绿',
    ok: (v) => typeof v === 'string' && v.includes('审不了任何东西'),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '审核标准',
    key: 'standard.headlineWordingUpdated',
    label:
      '★★ 而且那句话说的是**「没有写「指令」」**，不再说「没有审核标准」——那个字段界面上已经没有了（使用者报的就是这句）',
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
    key: 'standard.formStandardEditorRemoved',
    label:
      '★★ 切到审核角色 ⇒ **不再有标准编辑框**（2026-09：标准并进「指令」，不再单独设置）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formHasMergedHint',
    label:
      '★★ 那一栏**说明还在**：「身份与判断依据写在「指令」里，标准不再单独设置」——只说"框没了"会让使用者以为标准凭空消失',
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
    key: 'standard.formStandardEditorGone',
    label:
      '★★ 那个编辑容器（`.standard`）**整个不在了**（它连同"正文"一起并进了「指令」）',
    ok: (v) => v === true,
  },
  // ⚠️ 原来这里有一条"标准编辑器容器里没有动作勾选"。2026-09 标准并进「指令」之后
  //    **那个容器整个不存在了** ⇒ 这条失去主语，删掉而不是留一个永远量不到的键。
  //    "动作勾选只在「行动权限」段"这件事仍由下面 `standard.formActionsBlockLabel`
  //    与 `standard.formNoBuiltinGroup` 两条钉着。
  // ⚠️ 原来这里有一条"标准栏与父组件是通的（写下正文后徽章变「已写」）"。
  //    2026-09 标准并进「指令」之后，**那个徽章与那个框都不存在了** ⇒ 这条删掉，
  //    而不是留着量一个 null（探针里"空过"等于永远绿）。同一件事现在由
  //    「指令那一栏与父组件是通的」承担（见下面那组 instructions 的检查）。

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

  // ── 迁移：把挂载的 skill 里的判断依据并进「指令」（D38）──
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
    label: '★ 老形态审核者的详情页有「把这份判断依据并进「指令」」',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.noInstructionsBefore',
    label: '★ 搬移**之前**那一栏说"没有写「指令」 ⇒ 拿不到审核任务"（就是这句在搬完之后不许再说）',
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
    label: '★ 点完之后标准真的固化到它身上了（详情里出现了那份正文）',
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
  {
    view: '迁移（D38）',
    key: 'migrate.instructionsRowNoFalseClaim',
    label:
      '★★ 搬完之后「指令」那一栏**不再**是"没有写「指令」"那个空态——正文刚刚并进来，那句话此刻是假的（与上面 `noInstructionsBefore` 成对：搬之前真、搬之后假）',
    ok: (v) => v === true,
    show: (v, facts) => `${v}　实测：「${String(facts['migrate.instructionsRowAfterText'] ?? '')}」`,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyNoticeGone',
    label:
      '★★ 老形态的提示与那颗「并进」按钮也跟着消失（留着的话，界面会在搬完之后继续暗示"你还有一份老标准没处理"）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.noFalseHeadlineAfterAdopt',
    label:
      '★★★ 搬完之后（依据在「指令」里、老字段清空、没有挂载）顶上那条"审不了任何东西"的红警告**不许出现**——这就是使用者报的那条假警报',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.noStandardRowAfter',
    label: '★ 搬完之后整个详情里仍然没有「审核标准」那一行（那一段是被删掉的，不是被藏起来的）',
    ok: (v) => v === true,
  },

  // ── 保存一次就把"老的信息"清掉（2026-09）──
  //
  // 使用者说「还留着老的信息…建议我重新编辑保存后 就应该去掉这些旧资讯」。
  // 这一组的判据是**两半**：提示消失（老字段清掉）＋ **身份那段文字一字未变**。
  // 只量前一半，把老字段直接删掉也能绿，而那是丢了一段判断依据。
  {
    view: '老信息清理（保存时）',
    key: 'fold.fixtureFound',
    label: '★ 夹具里有一个带内联老标准的审核者（否则下面整组空过）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.detailSwitched',
    label: '★ 右栏真的换成了这个夹具（否则下面量到的是上一个 agent）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.noticeBefore',
    label: '★ 前提：保存**之前**那条"还带着老的字段"的提示确实在（不然"它消失了"没法量）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.editHintWarns',
    label: '★ 编辑态**提前说清**保存会发生什么（"我的指令怎么多了一段"不该是没预告的改动）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.leftEditing',
    label: '★ 保存之后真的退出了编辑（等的是"输入框消失"，不是固定 sleep）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.reviewStandardAfter',
    label:
      '★★ 老字段真的清掉了（问接口：`reviewStandard` 是 null；界面「no-agent」= 接口根本没读到，那也不算通过）',
    ok: (v) => v === null,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.instructionsGotBody',
    label: '★ 老标准的正文并进了「指令」（不是被删掉）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.identityUnchanged',
    label:
      '★★★ 而**投递出去的那段文字逐字节相同**（前后各自按 `[指令, 老标准]` 拼一遍比）——"顺手清理"不许变成"顺手丢一段判断依据"',
    ok: (v) => v === true,
    show: (v, facts) =>
      `${v}　前：${JSON.stringify(facts['fold.identityBefore'])}　后：${JSON.stringify(facts['fold.identityAfter'])}`,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.noticeAfter',
    label: '★★ 保存之后那条老提示**消失了**（使用者要的正是这一条：重新编辑保存后旧资讯就该没了）',
    ok: (v) => v === false,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.readOnlyShowsMerged',
    label: '★ 而且只读态「指令」那一栏里现在就是那段合并后的文字（界面上看得见"依据还在"）',
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
    label: '建任务那一栏的选择器里，那一项标着「（默认）」',
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
    label: '★★ 建任务那一栏**预选**的就是设过的那个 agent',
    ok: (v, facts) =>
      typeof v === 'string' && v.length > 0 && v === facts['defaultAgent.targetName'],
  },

  // ── 顶栏：页名 + 这一页的动作（2026-09 改版）──
  //
  // ⚠️ 这一段与语言那一段**顺序不能颠倒**：它断言的是中文界面（页名「任务」
  //    这类字面）。语言那一段跑在最后，测完切回中文。
  //
  // 判据的方向是"**跟着页换**"：三个页面各一条，期望值是逐页写死的。只量
  // "按钮数量 > 0"的话，五个页面全显示同一排按钮也能过——而那正是这次改版要防的。
  {
    view: '顶栏',
    key: 'topbar.pageName',
    label: '★ 顶栏左边写着**当前这一页**的名字（任务 / 智能体 / 工具 三轮都对）',
    ok: (v) => v && v['#/tasks'] === '任务' && v['#/agents'] === '智能体' && v['#/tools'] === '工具',
  },
  {
    view: '顶栏',
    key: 'topbar.actions',
    label:
      '★★ 顶栏里紧跟着页名的那排动作**只属于当前这一页**（换页就整排换掉，上一页的按钮一个都不留）',
    ok: (v) =>
      v &&
      // ★ 2026-10（D58）：任务页多了一个主操作（建任务被并进这一页）——
      //   这里同时钉住它排在**最前**（主操作该在模式开关前面）。
      JSON.stringify(v['#/tasks']) === JSON.stringify(['新建任务', '列表', '看板', '刷新']) &&
      JSON.stringify(v['#/agents']) === JSON.stringify(['新建智能体', '设置', '刷新']) &&
      JSON.stringify(v['#/tools']) === JSON.stringify(['安装工具', '刷新']),
  },
  {
    view: '顶栏',
    key: 'topbar.sameAsSidebar#/tasks',
    label: '★ 页名与侧栏那一项**是同一句话**（两处各写一份迟早会不一样）',
    ok: (v) => v === '任务',
  },
  {
    view: '顶栏',
    key: 'topbar.sameAsSidebar#/agents',
    label: '页名与侧栏那一项一致（智能体）',
    ok: (v) => v === '智能体',
  },
  {
    view: '顶栏',
    key: 'topbar.sameAsSidebar#/tools',
    label: '页名与侧栏那一项一致（工具）',
    ok: (v) => v === '工具',
  },
  {
    view: '顶栏',
    key: 'topbar.oneLine',
    label: '★ 顶栏恒为**一行**（三个页面都量）：高度被 `.shell` 的 calc 用着，换行会把整页挤歪',
    ok: (v) => v && v['#/tasks'] === true && v['#/agents'] === true && v['#/tools'] === true,
  },
  {
    view: '顶栏',
    key: 'topbar.overflowPx',
    label: '★ 顶栏**不横向溢出**（三个页面都量）：窄窗口下动作收进 `⋯`，不靠换行解决',
    ok: (v) => v && v['#/tasks'] === 0 && v['#/agents'] === 0 && v['#/tools'] === 0,
  },
  {
    view: '顶栏',
    key: 'topbar.actionsAtSidebarEdge',
    label:
      '★★ 这一页的动作，**左缘与侧栏右缘对齐**（= 与主区内容共一条竖线）——页名长短不影响它，顶栏与 .shell 共用同一个 grid，结构上就对齐',
    ok: (v) => v && v['#/tasks'] === true && v['#/agents'] === true && v['#/tools'] === true,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '顶栏',
    key: 'topbar.actionsLeftOfTitleRight',
    label:
      '★★ 这一页的动作在最左边那一组里，而在最右边的是与页面无关的那几个（推到最右时两者隔着一千多像素，看起来是两件不相干的事）',
    ok: (v) => v && v['#/tasks'] === true && v['#/agents'] === true && v['#/tools'] === true,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '顶栏',
    key: 'topbar.buttonHeights',
    label:
      '★★ 两档高度**各自齐**：工具条里的格子 24px、工具条外的常驻控件 30px（2026-10 改版之后这是嵌套关系，不是"不齐"——但**组内**不齐仍然是"加一个按钮就把这排弄歪"）',
    ok: (v) =>
      !!v &&
      ['#/tasks', '#/agents', '#/tools'].every(
        (k) =>
          v[k] &&
          JSON.stringify(v[k].cells) === JSON.stringify([24]) &&
          JSON.stringify(v[k].others) === JSON.stringify([30]),
      ),
    show: (v) =>
      Object.entries(v ?? {})
        .map(([k, hs]) =>
          hs && hs.cells ? `${k}: 格子 ${hs.cells.join('/')}px · 常驻 ${hs.others.join('/')}px` : `${k}: ${hs}`,
        )
        .join('　'),
  },
  {
    view: '顶栏',
    key: 'topbar.trackHeight',
    label:
      '★ 工具条**轨道**与常驻控件同高（30px）——这一条钉的是"一条带子上的节奏"，也正是上面那个 bug 该被抓住的地方（格子被拉到 30 时轨道看不出问题，而工具条会变成一条没有呼吸的实心带）',
    ok: (v) => v && v['#/tasks'] === 30 && v['#/agents'] === 30 && v['#/tools'] === 30,
    show: (v) => Object.entries(v ?? {}).map(([k, h]) => `${k}: ${h}px`).join('　'),
  },
  {
    view: '顶栏',
    key: 'topbar.activeModeVisible',
    label:
      '★★ 当前那个模式按钮**看得出来**（`.active` 曾经是死类名：「列表 / 看板」长得一模一样。'
      + '⚠️ 比对的基准必须是**同一种 kind 的旁边那一格**——拿主操作当基准的话，'
      + '把 `.active` 的样式整条删掉它照样绿，实测踩过）',
    // 「不适用」= 这一页没有模式切换（只有任务页有），那是正常的
    ok: (v) =>
      !!v &&
      ['#/tasks', '#/agents', '#/tools'].every(
        (k) => v[k] === true || v[k] === '不适用（这一页没有"当前模式"）',
      ),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '顶栏',
    key: 'topbar.moreHiddenWide',
    label: '★ 宽屏下 `⋯` **不出现**（三个页面都量）：收起来只是窄屏的事',
    ok: (v) => v && v['#/tasks'] === true && v['#/agents'] === true && v['#/tools'] === true,
  },

  // ── 语言切换（D39）──
  //
  // 这一段跑在**最后**（前面全是中文断言），并且在末尾切回中文。
  {
    view: '语言切换',
    key: 'lang.switchPresent',
    label: '★ 设置抽屉里有语言切换器（2026-09 从顶栏撤进设置抽屉；探针原来量顶栏 select，早已不存在）',
    ok: (v) => v === true,
  },
  {
    view: '语言切换',
    key: 'lang.defaultIsZh',
    label: '默认是中文（既有数据/文档/断言的语言）',
    ok: (v) => v === 'zh',
  },
  // ⚠️ 取样那一项是「任务」（合并之后导航里没有「新建任务」了——见 D58）。
  //    这里问的是"界面语言真的切了吗"，与取样哪一项无关，跟着改就行。
  { view: '语言切换', key: 'lang.navBefore', label: '切换前导航是中文', ok: (v) => v === '任务' },
  {
    view: '语言切换',
    key: 'lang.switchedToEn',
    label: '★ 切到 English 之后界面真的变英文（响应式没断）',
    ok: (v) => v === true,
  },
  { view: '语言切换', key: 'lang.navAfter', label: '导航变成 Tasks', ok: (v) => v === 'Tasks' },
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
    view: '列表栏骨架（D61）',
    key: 'skeleton.headH',
    label:
      '★★ 三条栏头带同高 51px、完全同款（D64 后聊天也没标题了——只有计数+搜索，与任务/智能体一模一样）',
    ok: (v) => !!v && v.chat === 51 && v.tasks === 51 && v.agents === 51,
    show: (v) => ['chat', 'tasks', 'agents'].map((k) => `${k}: ${v?.[k]}px`).join('　'),
  },
  {
    view: '列表栏骨架（D61）',
    key: 'skeleton.searchInHead',
    label:
      '★ 搜索框**在栏头里**、不独行：三页 inHead=true / inBody=false（聊天 D63 也补了计数+搜索）',
    ok: (v) => {
      const t = v?.tasks
      const c = v?.chat
      const a = v?.agents
      return (
        !!t && t.inHead === true && t.inBody === false &&
        !!c && c.inHead === true && c.inBody === false &&
        !!a && a.inHead === true && a.inBody === false
      )
    },
    show: (v) =>
      ['chat', 'tasks', 'agents'].map((k) => `${k}: 栏头内 ${v?.[k]?.inHead} / 列表内 ${v?.[k]?.inBody}`).join('　'),
  },
  {
    view: '列表栏骨架（D61）',
    key: 'skeleton.rowH',
    label:
      '★★ 三页列表行高同一档（`--list-row-min-h` 64px，内容更高的跟随内容）且每页内部恒定——三页两两相差 ≤1px',
    ok: (v) => {
      const hs = ['chat', 'tasks', 'agents'].map((k) => v?.[k])
      return hs.every((h) => typeof h === 'number' && h >= 63) && Math.max(...hs) - Math.min(...hs) <= 1
    },
    show: (v) => ['chat', 'tasks', 'agents'].map((k) => `${k}: ${v?.[k]}px`).join('　'),
  },
  {
    view: '列表栏骨架（D61）',
    key: 'skeleton.headsTitleless',
    label:
      '★ 三页栏头带里**都没有标题**（D64：聊天「对话」二字按要求去掉——三页同款才像一个整体）',
    ok: (v) => !!v && v.chat === true && v.tasks === true && v.agents === true,
    show: (v) => ['chat', 'tasks', 'agents'].map((k) => `${k}: 有标题=${v?.[k]}`).join('　'),
  },
  {
    view: '列表栏骨架（D61）',
    key: 'skeleton.separatorHeights',
    label:
      '★ 任务列表的分组标题回到**内容高度**（D61 全局 `.list-head` 曾把两行都固定成 51px，D64 修掉）：单行那条 <51px（min 抓"固定带"这个漏的特征），双行那条 ≤64px',
    ok: (v) => !!v && v.min < 51 && v.max <= 64,
    show: (v) => (v ? `min ${v.min}px / max ${v.max}px` : `${v}`),
  },
  {
    view: '列表栏骨架（D61）',
    key: 'skeleton.separatorNoHint',
    label: '★「需要注意」分组**不带解释**（D67："执行失败/被取消…"那句按要求删了，加回来就红）',
    ok: (v) => v === true,
  },
  {
    view: '行内细节（D65）',
    key: 'rowdetail.title',
    label:
      '★ 三页行内标题同一档：字号 14（--fs-base）、字重 600（原来实测 13/400、14/600、14/700）',
    ok: (v) =>
      ['chat', 'tasks', 'agents'].every(
        (k) => !!v?.[k] && Math.abs(v[k].fs - 14) < 0.1 && v[k].w === 600,
      ),
    show: (v) => ['chat', 'tasks', 'agents'].map((k) => `${k}: ${v?.[k]?.fs}/${v?.[k]?.w}`).join('　'),
  },
  {
    view: '行内细节（D65）',
    key: 'rowdetail.chip',
    label:
      '★ 徽标同一形状：任务阶段标签与智能体角色徽标都是胶囊（radius=100px；原来任务描边方角 r4px）',
    ok: (v) => !!v && v.tasks === '100px' && v.agents === '100px' && v.tasks === v.agents,
    show: (v) => ['tasks', 'agents'].map((k) => `${k}: ${v?.[k]}`).join('　'),
  },
  {
    view: '行内细节（D65）',
    key: 'rowdetail.rowBox',
    label:
      '★ 行容器同款：三页都是 align-items center、gap 2px（智能体原来 flex-start / 4px）',
    ok: (v) =>
      ['chat', 'tasks', 'agents'].every(
        (k) => !!v?.[k] && v[k].align === 'center' && v[k].gap === '2px',
      ),
    show: (v) => ['chat', 'tasks', 'agents'].map((k) => `${k}: ${v?.[k]?.align}/${v?.[k]?.gap}`).join('　'),
  },
  {
    view: '行内细节（D65）',
    key: 'rowdetail.hover',
    label:
      '★ 三页行 hover 底色统一 `--surface-hover`（任务/智能体原来误用 `--surface-2`——那是选中态底色）',
    ok: (v) =>
      ['chat', 'tasks', 'agents'].every((k) => v?.[k] === 'var(--surface-hover)'),
    show: (v) => ['chat', 'tasks', 'agents'].map((k) => `${k}: ${v?.[k] ?? '?'}`).join('　'),
  },
  {
    view: '列表栏骨架（D61）',
    key: 'skeleton.delInset',
    label:
      '★ 删除按钮同一位置（右缘内缩 `--sp-1`、垂直居中）——聊天与任务两栏一致（原来 -1 贴边 vs -5）',
    ok: (v) => {
      const a = v?.chat
      const b = v?.tasks
      return !!a && !!b && a.inset === b.inset && a.centerDelta <= 2 && b.centerDelta <= 2
    },
    show: (v) =>
      ['chat', 'tasks']
        .map((k) => {
          const x = v?.[k]
          return x ? `${k}: 内缩${x.inset}px 居中差${x.centerDelta}px` : `${k}: ${x}`
        })
        .join('　'),
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
    label: '★ 看板六个列头都翻（`titleId`），一个中文字都不剩',
    ok: (v) =>
      Array.isArray(v) &&
      v.length === 6 &&
      v.join('|') === 'Executing|Executed · awaiting review|Acting|Needs a human|Reviewed|Dropped',
  },
  {
    view: '语言切换',
    key: 'lang.boardHintsInEn',
    label: '★ 列说明也翻（`hintId`）',
    ok: (v) =>
      Array.isArray(v) && v.length === 6 && v.every((s) => s.length > 0 && !/[\u4e00-\u9fff]/.test(s)),
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
  // ══════════════════════════════════════════════════════════════════
  // ★ 版面：三步排成一行 + 首屏看得见三个问题
  // ══════════════════════════════════════════════════════════════════
  {
    view: '新建任务',
    key: 'newtask.layoutLead',
    label: '★★★「要做什么」在**三步上面**（它在 DOM 里一直是最前面一个，却被网格挪走过：'
      + '`.step-exec` 写了显式 `grid-row: 1 / span 2`，它只定了列、行交给自动排布，'
      + '而 CSS Grid 先放"行列都确定"的——于是输入框掉到三步下面。看代码看不出来）',
    ok: (v) =>
      !!v?.lead &&
      !!v?.firstStep &&
      v.lead.top < v.firstStep.top &&
      // 输入框整条都在三步上面（不是"标签在上面、框在下面"）
      (v.textarea ? v.textarea.top + v.textarea.h <= v.firstStep.top + 1 : false),
    show: (v) =>
      v?.lead
        ? `「要做什么」top=${v.lead.top} 高=${v.lead.h}　输入框 top=${v.textarea?.top} 高=${v.textarea?.h}　三步第一块 top=${v.firstStep.top}`
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.layoutFlushAfterConfig',
    label: '★★ ① **被要求拉满**（`align-self: stretch`）且两列齐平——`layoutSteps` 那条'
      + '在进页面时量，夹具里两列恰好一样高，**怎么都是齐的**，测不出拉伸有没有生效，'
      + '所以这里另量一次并直接断言那条 CSS 属性。'
      + '⚠️ 夹具的右列（128+16+231）与 ① 的自然高度一样，这一条仍偏弱；'
      + '真正拉开差距的是真实数据（③ 有两枚胶囊时 ① 483px vs 自然 375px）',
    ok: (v) =>
      !!v &&
      v.alignSelf === 'stretch' &&
      v.actionsH > 0 &&
      Math.abs(v.execBottom - v.actionsBottom) <= 2,
    show: (v) =>
      v
        ? `① 高=${v.execH} 底=${v.execBottom}　③ 高=${v.actionsH} 底=${v.actionsBottom}　align-self=${v.alignSelf}`
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.chipRadius',
    label: '★ 胶囊的圆角是**普通圆角**（8px），不是"胶囊"造型的 100px——一枚里有 3~4 行字时，'
      + '100px 在那么高的框上会变成两段夸张的弧，左右两条直边几乎没了',
    ok: (v) => !!v && Number.parseFloat(v.radius) <= 12,
    show: (v) => (v ? `圆角 ${v.radius}（框高 ${v.height}px）` : String(v)),
  },
  {
    view: '新建任务',
    key: 'newtask.layoutSteps',
    label: '★★ 两列：**左列 ① 执行，右列 ② 审核在上、③ 行动在下**（③ 与 ② 同列同一条线：'
      + '先判、再动），且 ① **拉到与右列齐平**（不拉平的话左列第二格会空出一个洞）',
    ok: (v) => {
      const a = v?.exec
      const b = v?.review
      const c = v?.actions
      if (!a || !b || !c) return false
      const ntSameRow = a.top === b.top
      const ntOtherCol = a.left !== b.left
      const ntStacked = b.left === c.left && c.top > b.top
      const ntFlush = Math.abs(a.top + a.h - (c.top + c.h)) <= 2
      return ntSameRow && ntOtherCol && ntStacked && ntFlush
    },
    show: (v) =>
      v?.exec
        ? `① top=${v.exec.top} left=${v.exec.left} 高=${v.exec.h}　② top=${v.review?.top} left=${v.review?.left}　③ top=${v.actions?.top} left=${v.actions?.left} 高=${v.actions?.h}`
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.titleAutoGrow',
    label: '★★「要做什么」**默认 3 行、随输入长高、15 行封顶**（判据是量出来的高度，'
      + '不是"它有个 rows 属性"——写死的 rows 与"真的会跟着长"在属性上看不出区别）',
    ok: (v) =>
      // 1 行与 3 行一样高 ⇒ 起步就是 3 行
      v?.h1 === v?.h3 &&
      // 超过 3 行开始长
      v?.h6 > v?.h3 &&
      // 一直长到 15 行
      v?.h15 > v?.h6 &&
      // 15 行之后封顶（30 行不再变高；留 4px 余量——`scrollHeight` 是整数、
      // 行高是小数，卡死在"完全相等"上会因为一两像素的取整假红），并且改成自己滚
      v?.h30 <= v?.h15 + 4 &&
      v?.overflowAt30 === 'auto' &&
      // 清空之后回到起步高度（程序化改值也要重新量）
      v?.hAfterClear === v?.h3,
    show: (v) =>
      v
        ? `rows=${v.rows}　1行=${v.h1} 3行=${v.h3} 6行=${v.h6} 15行=${v.h15} 30行=${v.h30}（${v.overflowAt30}）清空后=${v.hAfterClear}`
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.titleFullWidth',
    label: '★ 那个框**占满整行宽度**（这一页唯一要写的东西就是它，原来只用了 544px / 1096px，'
      + '右边一半是空的）',
    ok: (v) => !!v && v.width > v.formWidth * 0.9,
    show: (v) => (v ? `${v.width}px / 整行 ${v.formWidth}px` : String(v)),
  },
  {
    view: '新建任务',
    key: 'newtask.actionsConfigParamLines',
    label: '★★ 每个动作的**钉死的固定值 `name=value` 与契约值同一行**（同一句"模拟关闭单据"，'
      + '钉了 `reason=巡检` 与没钉是两回事），且胶囊上**没有**多余的参数行',
    ok: (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((c) => typeof c?.type === 'string') &&
      // 夹具那个动作钉了 `text=长期钉的` ⇒ 它的固定值必须在**第一行**（head）里
      v.some((c) => (c.head ?? '').includes('已固定')) &&
      // ⚠️ 而且**不许**多出别的参数行：曾经多过"由模型填 / 平台注入"两行机器名，
      //    使用者没法据它们做任何决定（开放参数本来就会由模型填、平台注入的值
      //    他也改不了）。一枚胶囊最多两行字：契约值+固定值、说明。
      v.every((c) => (c.subCount ?? 0) <= 2),
    show: (v) =>
      Array.isArray(v)
        ? v.map((c) => `${c.type} → [${c.subs.join(' | ')}]`).join('　')
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.layoutFirstScreen',
    label: '★★ 首屏（不滚动）里三个问题的**标题与主控件**都在——这一页要回答的就是这三个问题，'
      + '看不到就等于要滚下去猜',
    ok: (v) =>
      Array.isArray(v) &&
      v.length === 3 &&
      v.every((x) => x.titleVisible === true && x.controlVisible === true),
    show: (v) =>
      Array.isArray(v)
        ? v.map((x) => `${x.title}:标题${x.titleVisible ? '✓' : '✗'}控件${x.controlVisible ? '✓' : '✗'}`).join('　')
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.actionsConfigInCard',
    label: '★★ 允许的动作那几枚胶囊**在 ③ 那张卡片里面**（不是页面上另一处的一条）——'
      + '挪出去之后那一块读起来是"另一件事"：使用者问"这些是什么"时，答案在 ③ 里，不在外面',
    ok: (v) => v?.detailInsideCard === true && v?.chipsInCard > 0 && v?.chipsOutside === 0,
    show: (v) =>
      v
        ? `在卡片里=${v.detailInsideCard}　卡片内 ${v.chipsInCard} 枚 / 卡片外 ${v.chipsOutside} 枚`
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.actionsConfigOnePerLine',
    label: '★ 那几枚胶囊**一枚一行**（③ 只有一列宽，横排会折成"契约值半行、说明挤到下一行、'
      + '下一枚又从半路接上"的乱条）',
    ok: (v) =>
      Array.isArray(v?.tops) && v.tops.length > 0 && new Set(v.tops).size === v.tops.length,
    show: (v) =>
      Array.isArray(v?.tops)
        ? `${v.count} 枚，${new Set(v.tops).size} 个不同顶边　高 ${v.heights?.join('/')}px`
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.footSummaryText',
    label: '★★ 提交栏那一行说清"我即将提交的是什么"（交给谁 · 谁审 · 允许几个动作）——'
      + '滚下去看高级选项时，它是唯一还在的上下文',
    ok: (v) =>
      typeof v === 'string' &&
      v.includes(CHAIN_EXECUTOR) &&
      v.includes(CHAIN_REVIEWER) &&
      /\d/.test(v),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '新建任务',
    key: 'newtask.footStickyAtBottom',
    label: '★★ 滚到页面最底下时提交栏**还在视口里**（判据是"滚了之后还在"，不是"它有个 sticky 声明"）',
    ok: (v) => v?.visible === true,
    show: (v) => (v ? `可见=${v.visible}　横贯=${v.spansPane}（${v.footW}px vs 可滚区 ${v.paneW}px）` : String(v)),
  },
  {
    view: '新建任务',
    key: 'newtask.footSpansPane',
    label: '★ 提交栏**横贯整块可滚区**（`.main` 自己有左右留白，不留负边距它会缩在那圈留白里，'
      + '滚过去的内容从两侧露出来）',
    ok: (v) => v?.spansPane === true,
    show: (v) => (v ? `${v.footW}px vs 可滚区 ${v.paneW}px` : String(v)),
  },
  // ══════════════════════════════════════════════════════════════════
  // ★「要做什么」：两个字段合并成一个多行框
  // ══════════════════════════════════════════════════════════════════
  {
    view: '新建任务',
    key: 'newtask.titleField',
    label: '★「要做什么」是**一个多行框**（单行 `input` 装不下真正要说的东西：一按回车就提交、'
      + '写得长只能横着滚）',
    ok: (v) => v?.count === 1 && v?.multiline === true && v?.required === true,
    show: (v) => (v ? `${v.tag} · 多行=${v.multiline} · 必填=${v.required} · 这一栏共 ${v.count} 个控件` : String(v)),
  },
  {
    view: '新建任务',
    key: 'newtask.hasDescriptionField',
    label: '★「补充说明」那一栏**没有了**（"标题 + 补充说明"是记录格式的分法，不是使用者的；'
      + '切分交给 `lib/request-text.ts`，他不必先做一次分类）',
    ok: (v) => v === false,
  },
  // ══════════════════════════════════════════════════════════════════
  // ★ ③ 行动：从"铺一整段选择器"改成"一个按钮 + 居中对话框"
  // ══════════════════════════════════════════════════════════════════
  {
    view: '新建任务',
    key: 'newtask.actionsSectionHeight',
    label: '★ ③ 行动那一段**收起来了**（原来选择器直接铺在里面，实测 537px、在 700px 高的视口里'
      + '从 y=670 开始——等于下半屏全是这一栏，提交按钮被推到两屏之外）',
    // ⚠️ 判据改过：③ 现在**理应**装下"配置细节"（胶囊 + 出处句），比原来高是对的
    //    ——拿一个像素上限守它，只会逼着人把配置挪到别处去（那正是被否掉的那一版）。
    //    这里守的是**那一整块选择器没有铺回来**：铺回来时这一段会是 700px 以上，
    //    而 `actionsPickerNotInline` 只管 `.action-perms` 在不在、管不到"是不是又
    //    变成一整屏"。两条一起才封得住。
    ok: (v) => typeof v === 'number' && v > 0 && v < 640,
    show: (v, facts) => {
      const ntParts = facts['newtask.actionsSectionParts']
      const ntBreak = Array.isArray(ntParts)
        ? '　[' + ntParts.map((x) => `${String(x.cls).split(' ')[0]} ${x.h}px`).join(' + ') + ']'
        : ''
      return `${v}px（改之前 537px）${ntBreak}`
    },
  },
  {
    view: '新建任务',
    key: 'newtask.actionsPickerNotInline',
    label: '★ 选择器**不在页面上**了（它住进对话框；留在页面里就会把这一栏重新撑回几百像素）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务',
    key: 'newtask.actionsConfigChips',
    label: '★★ ③ 上画的是**当前的配置细节**（每个允许的动作一枚胶囊：契约值 + 它的 `summary`），'
      + '不是一个计数——选择器进对话框之后，这一行是**不点开就唯一能看见配置的地方**',
    ok: (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((c) => typeof c?.type === 'string' && c.type.includes('.') && !!c?.summary),
    show: (v) => (Array.isArray(v) ? v.map((c) => c.type).join(' | ') : String(v)),
  },
  {
    view: '新建任务',
    key: 'newtask.actionsConfigFixedText',
    label: '★★ 钉死的固定值在页面上**看得见**（`已固定: text=长期钉的`）——不写出来的话，'
      + '使用者以为这次会带着他上次钉的值去执行，而实际发出去的是另一个值',
    ok: (v) => typeof v === 'string' && v.includes('已固定') && v.includes('text='),
    show: (v) => `"${String(v)}"`,
  },
  {
    view: '新建任务',
    key: 'newtask.actionsConfigMatchesPicks',
    label: '★★ 页面上的胶囊 == 对话框里勾着的框（同一个事实的两种画法）——两处各算一遍就会分叉，'
      + '而分叉的表现是"页面上写着允许 A、点开对话框里勾的是 B"，且没有任何报错',
    ok: (v) =>
      Array.isArray(v?.chips) && Array.isArray(v?.picks) && v.chips.join() === v.picks.join(),
    show: (v) =>
      Array.isArray(v?.chips)
        ? `胶囊 ${v.chips.join(' | ') || '（空）'}　勾着 ${v.picks.join(' | ') || '（空）'}`
        : String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.actionsDialogClosedInitially',
    label: '一进页面 ③ 的对话框是**关着**的（默认状态不该有浮层盖着表单）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务',
    key: 'newtask.actionsChooseButtonText',
    label: '★ 那颗按钮的字回答"点开能干什么"（`选择动作…`），不是"这里是什么"'
      + '（后者与上面那行标签重复，同一件事两个出处）',
    ok: (v) => typeof v === 'string' && v.includes('选择动作'),
    show: (v) => String(v),
  },
  {
    view: '新建任务',
    key: 'newtask.actionsDialogOpens',
    label: '★★ 点那颗按钮**真的打开**了浮层（按钮在、点了不开是这次改动最容易出的错，'
      + '而它的症状是后面所有勾选框断言一起红）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务',
    key: 'newtask.actionsDialogHasPicker',
    label: '★ 对话框里就是那个**左选右配**的选择器（搬进去的是同一个组件，不是另画一个）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务',
    key: 'newtask.actionsDialogBox',
    label: '★ 对话框**一屏放得下**（装不下就会出现"浮层自己套一层滚动条"，'
      + '而两栏挑选器在里面滚最难受：左栏滚走了、右栏还在）',
    ok: (v) => v?.fits === true,
    show: (v) => (v ? `高 ${v.h}px · 顶边 ${v.top}px · 视口内=${v.fits}` : String(v)),
  },
  {
    view: '新建任务',
    key: 'newtask.actionsCountMatchesPicker',
    label: '★★ 按钮旁的计数与选择器状态条**同一个分母**（两处各算一遍就会在"装了什么包"变化时'
      + '分叉，症状是同一屏上两个不同的总数——实测踩过"已允许 2 / 1 个动作"）',
    ok: (v) => v !== null && v.button[0] === v.picker[0] && v.button[1] === v.picker[1],
    show: (v) => (v ? `按钮 ${v.button.join('/')} · 状态条 ${v.picker.join('/')}` : String(v)),
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
      // ★ 还要求"读完之后真的回到了新建任务页"（`landed`）：这一条原来只认 chip，
      //   而 chip 是在**智能体页**读的 ⇒ 回程那一步即使失败也照样绿（D58 之前它
      //   写着一个不存在的地址 `#/newtask`，靠"未知 hash 回落"才碰巧有效）。
      v.landed === true &&
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
    view: '新建任务',
    key: 'newtask.deliveryModeRecorded',
    label:
      '★★ 投递档**落在 run 上**：探针的 run 走 generic（没有系统提示通道）⇒ 该是 **B**（三块合成一段）。这条钉住 A 档的另一侧——换个 runtime 投递形状真的变了，而且**说得出来**',
    ok: (v) => v === 'B',
    show: (v) => String(v),
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
  { view: '新建任务', key: 'new.hasContent', label: '建任务那一栏渲染出来了（表单在右栏里 + 左边清单还在）', ok: (v) => v === true },
  {
    view: '任务',
    key: 'tasks.createKeepsListBeside',
    label:
      '★★ 「新建任务」进的是**右栏里的表单**，而左边那份清单还在（这是合并的意义：清单当参照、表单写在右边）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.createPaneFormPresent',
    label: '★ 表单真的在右栏里（`.detail-pane .create-body` 里面）——不是又画了一个整页',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.createBodyIsScroller',
    label: '★ 那一栏自己滚（`overflow-y: auto`）——不滚的话提交栏吸底吸的是整个窗口，滚起来会飘走',
    ok: (v) => v === 'auto',
  },
  {
    view: '任务',
    key: 'tasks.createNarrowListHidden',
    label:
      '★★ 窄屏（800px）进建任务：清单**让位**（`display:none`）——不让位的话两栏各半，表单挤得没法用',
    ok: (v) => v === 'none',
  },
  {
    view: '任务',
    key: 'tasks.createNarrowPaneShown',
    label:
      '★★★ 而右栏**必须还在**（这一条是那个坑本身：右栏的显隐由 `.with-detail` 管，`$creating` 少算进去就是"点新建任务什么都不出现"）',
    ok: (v) => v === 'flex',
  },
  {
    view: '任务',
    key: 'tasks.createNarrowExitViaSidebar',
    label:
      '★★★ 窄屏下**真的出得去**：点侧栏「任务」⇒ 回到列表（那一栏上面原来有个「返回任务清单」，按要求去掉了 ⇒ 出口落到侧栏这一项上，而它一定在；"出不去"在窄屏上的样子是卡在一张表单里、连清单都看不见）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.createListButtonLeaves',
    label:
      '★★ 宽屏下点顶栏的「列表」也出得去——它本来就已经是选中态，而在建任务时它必须表示"离开表单、回列表"（从前那种写法直接 return，点了毫无反应）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.createNarrowColumns',
    label:
      '★★ 800px 窗口 ⇒ 右栏内容宽约 496px（< 36rem）⇒ 表单退成**单列**（两列硬撑会溢出）',
    ok: (v) => v === 1,
  },
  {
    view: '任务',
    key: 'tasks.createNarrowNoOverflowX',
    label:
      '★ 单列之后这一栏**不横向溢出**（可滚区与包着表单那一层都算，`scrollWidth ≤ clientWidth`）——容器查询那一档的意义就在这儿',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.createWideColumns',
    label:
      '★★★ 1280 的窗口下右栏只有 624px ⇒ 表单**仍然是单列**——这一条钉的是"按容器判、不按窗口判"（`@media` 会看见 1280 而排成两列，每列 265px）',
    ok: (v) => v === 1,
  },
  {
    view: '任务',
    key: 'tasks.createWidePaneInner',
    label: '★ 顺带如实记下右栏的实际内容宽（两列那条阈值 36rem 就是照它定的）',
    ok: (v) => typeof v === 'number' && v > 0,
    show: (v) => `${v}px`,
  },
  {
    view: '任务',
    key: 'tasks.createWiderColumns',
    label:
      '★★★ 窗口画宽到 1600 ⇒ 右栏约 860px ⇒ 表单**回到两列**——与上面那条配对：同一份 CSS，窗口不同、右栏宽度不同 ⇒ 列数不同（这才是"按容器判"）',
    ok: (v) => v === 2,
  },
  {
    view: '任务',
    key: 'tasks.createWiderPaneInner',
    label: '★ 宽窗口下右栏的实际内容宽',
    ok: (v) => typeof v === 'number' && v > 0,
    show: (v) => `${v}px`,
  },
  {
    view: '任务',
    key: 'tasks.leaveCreateAsks',
    label:
      '★★ 表单里写了内容、又点了左边另一条任务 ⇒ **先问一句**（不问就是静默丢掉写了一半的东西，而界面上不留任何痕迹）',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.sidebarLeaveAsks',
    label:
      '★★★ 写着草稿时点**侧边栏的「任务」**也要先问一句——去掉那个返回按钮之后，这一项是全屏常驻、最容易点到的那条出口，而它走通用导航、压根不知道"建任务"这件事',
    ok: (v) => v === true,
  },
  {
    view: '任务',
    key: 'tasks.discardConfirmLeaves',
    label: '★★★ 而点「放弃」之后**真的回到列表**（上面那条只证明它会问；"问了但走不掉"同样是个坏掉的出口）',
    ok: (v) => v === true,
  },
  // ══════════════════════════════════════════════════════════════════
  // 沉淀审阅页排版（D80 四轮重排，设计 §6.1 的三条规矩）
  // ══════════════════════════════════════════════════════════════════
  {
    view: '沉淀',
    key: 'crystal.attached',
    label: '夹具：那条已完成草稿真的挂上了（「继续」之后进到审阅态）——不成立的话下面一整组都空过',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.barText',
    label: '★ 结论条一行说完"能不能入库 / 改了几个文件 / 目标是谁"（这里是新建目标）',
    ok: (v) => typeof v === 'string' && /3 个文件/.test(v) && /新建 skill/.test(v),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.barAboveFold',
    label: '★★ 结论条**在首屏**（改前结论在 y=932，900 高的窗口首屏根本看不到审阅）',
    ok: (v) => v === true,
    show: (v, f) => `结论 y=${f['crystal.barY']} / 视口 ${f['crystal.viewportH']}`,
  },
  {
    view: '沉淀',
    key: 'crystal.pageFitsViewport',
    label: '★★ 页面**不整页滚**（改前内容 ~2030px：素材与日志把整页撑长，主区反而被挤出首屏）',
    ok: (v) => v === true,
    show: (v, f) => `文档 ${f['crystal.scrollH']}px / 视口 ${f['crystal.viewportH']}px`,
  },
  {
    view: '沉淀',
    key: 'crystal.paneTreeBodySideBySide',
    label: '★ 主区是**真的并排**两列（树固定窄栏 + 窗格），不是上下叠着（布局类缺陷只有量得出来）',
    ok: (v) => v === true,
    show: (v, f) => `树 ${f['crystal.treeW']}px　窗格高 ${f['crystal.paneH']}px`,
  },
  {
    view: '沉淀',
    key: 'crystal.paneH',
    label: '★★ 窗格高度落在 `clamp(22rem, 58vh, 40rem)` 那一档里（352–640px；写死小高会让编辑器只有几行）',
    ok: (v) => typeof v === 'number' && v >= 350 && v <= 641,
    show: (v) => `${v}px`,
  },
  {
    view: '沉淀',
    key: 'crystal.treeHasSkillMd',
    label: '树的每一行是「徽标 + 文件名（+ 行数）」——SKILL.md 在',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.treeTagTexts',
    label: '★★ 树行的徽标与 `+n −m` **同源**（都来自那一版对比）：改版草稿里没动的 `references/notes.md` 不许标成"新增"',
    ok: (v) => Array.isArray(v) && v.length >= 2,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.reviewInputCount',
    label: '★★ 审阅区**只有一个输入框**（slug）——四轮第 ④ 点：SKILL.md 里已经有 name/description，不该再让人填空',
    ok: (v) => v === 1,
    show: (v, f) => `${v} 个（slug ${f['crystal.slugInputCount']}）`,
  },
  {
    view: '沉淀',
    key: 'crystal.frontmatterLine',
    label: 'name / description 以**只读摘要**呈现（从 SKILL.md frontmatter 解析出来的那一行）',
    ok: (v) => typeof v === 'string' && v.includes('probe-crystal'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.editorInContentTab',
    label: '默认标签是「内容」：编辑器在（审阅的第一件事是看字）',
    ok: (v) => v === true,
    show: (v, f) => `标签 ${JSON.stringify(f['crystal.tabTexts'])}`,
  },
  {
    view: '沉淀',
    key: 'crystal.diffTabSwapsEditor',
    label: '★★★ 点「差异」⇒ 编辑区**让位**、diff 出现（同一个窗格换内容，不是并排挤成两半）',
    ok: (v) => v === true,
    show: (v, f) => `diff 行 ${f['crystal.diffLineCount']}`,
  },
  {
    view: '沉淀',
    key: 'crystal.diffSamePlaceAsEditor',
    label: '★★★ diff 出现在**编辑器原来那块窗格里**（改前 diff 在编辑器下方 519px 处，改一行要上下滚）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.nonRevisedHasNoBaselineSwitch',
    label: '★ 基线切换按钮只在**差异**标签下、且只在**改版草稿**上出现——这一条量的是"新建目标的草稿不给一个永远空的切换"',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.materialFoldClosed',
    label: '★★ 素材默认**折叠**（改前常驻 345px 压在审阅之上；摘要里给文件数）',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify(f['crystal.materialFoldSummary']),
  },
  {
    view: '沉淀',
    key: 'crystal.materialBelowPane',
    label: '★★ 素材与起草日志在主区**下方**（参考信息不抢"唯一要动手的地方"的位置）',
    ok: (v) => v === true,
    show: (v, f) =>
      (f['crystal.foldHeads'] ?? []).map((h) => `${h.label}:${h.y}`).join('　'),
  },
  {
    view: '沉淀',
    key: 'crystal.materialFoldOpens',
    label: '★ 展开素材能列出文件与预览（`material/` 里那份索引够 agent 自己读）',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify(f['crystal.materialRows']),
  },
  {
    view: '沉淀',
    key: 'crystal.materialPaneCols',
    label: '★ 素材清单复用**同一套**观感（也是"窄栏 + 正文"两列，不是另画一套单列列表）',
    ok: (v) => typeof v === 'string' && v.split(' ').filter(Boolean).length === 2,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.reviseRowHiddenInitially',
    label: '★★「按意见改一版」的输入框**默认不占高度**（点开才出现——它是"有时要用"的动作，不是常驻表单）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.reviseRowAppearsOnDemand',
    label: '★ 点它之后输入框真的出现（按钮在、点了不开是这类改动最容易出的错）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedAttached',
    label: '夹具：改版草稿（`revisedFrom`）也挂得上（下面两条量的是它的对比基线）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedApiRevisedFrom',
    label: '夹具：改版草稿的 `revisedFrom` 从**接口**读得到（页面与接口分开量：读不到就得先查接口，别先怀疑界面）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedEditorHasMarker',
    label: '★ 换到改版草稿之后编辑器里是**这一版**的字（防止量到上一条草稿的现场——探针在这里踩过一次）',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify(f['crystal.revisedEditorHead']),
  },
  {
    view: '沉淀',
    key: 'crystal.revisedDefaultBaselineActive',
    label: '★★★ 改版草稿默认停在**「对比上一版草稿」**——"按意见改一版"出来的那一版，使用者此刻问的就是"比上一版改了哪"',
    ok: (v) => v === '对比上一版草稿',
    show: (v, f) => `停在 ${JSON.stringify(v)}　按钮 ${JSON.stringify(f['crystal.revisedSwitchButtons'])}`,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedHasBaselineSwitch',
    label: '★ 改版草稿能切到"对比当前版本"（已经入库的那份才是"当前版本"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedDiffLineCount',
    label: '★★ 默认那一份对比量到的是**与上一版草稿的差**（真差：两版只差一行 ⇒ 行数是个位数，而不是"整份都算新增"）',
    ok: (v) => typeof v === 'number' && v > 0 && v < 10,
    show: (v, f) => `diff 行 ${v}　结论条 ${JSON.stringify(f['crystal.revisedBarText'])}`,
  },
  {
    view: '任务',
    key: 'tasks.leaveCreateCancelKeepsDraft',
    label: '★★★ 点「取消」之后**字还在、框关掉了**——确认框要真的能拦住这一次切换（否则它只是个装饰）',
    ok: (v) => v === true,
  },
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
  // ── Windows（2026-10 兼容性审计的 D 级）──────────────────────────────
  // Windows 上 Chrome 装在每台机器都可能不一样的地方，而**还有 Edge**：
  // 它是 Chromium 内核，CDP 那套用法一模一样。有的机器上（Server、新装的
  // Windows）Edge 是唯一存在的浏览器——那正好是"探针能不能跑"的分界。
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] ?? ''
    candidates.push(
      `${pf}\\Google Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google Chrome\\Application\\chrome.exe`,
      ...(local === '' ? [] : [`${local}\\Google Chrome\\Application\\chrome.exe`]),
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    )
  }
  return candidates.find((p) => p !== '' && fs.existsSync(p)) ?? null
}

/**
 * 造音视频夹具（2026-10）：一段真能解码的小视频 + 一个手写的 WAV。
 *
 * ⚠️ **WAV 是手写的**（44 字节头 + PCM），不依赖 ffmpeg：音频那条判据因此
 *    在任何机器上都量得到。视频只能靠 ffmpeg，没有它就把这一条如实报成红。
 */
function makeMediaFixtures(dir) {
  const made = []
  try {
    // ① 真视频：160x120、1 秒、纯色 + 一个方块（编解码器认的是容器与码流，不是画面）
    const clip = path.join(dir, 'clip.webm')
    const r = spawnSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
        '-c:v', 'libvpx', '-b:v', '100k', '-an',
        clip,
      ],
      { stdio: 'ignore' },
    )
    if (r.status !== 0) return { ok: false, why: 'ffmpeg 生成 webm 失败（没装 ffmpeg？）', made }
    made.push('clip.webm')

    // ② mp4：只用来量"类型认得出来 + Range 对"（不要求解码，Chromium 没有 H.264）
    const mp4 = path.join(dir, 'clip.mp4')
    const r2 = spawnSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
        mp4,
      ],
      { stdio: 'ignore' },
    )
    if (r2.status === 0) made.push('clip.mp4')

    // ③ WAV：手写——44 字节 RIFF 头 + 0.2 秒 8kHz 单声道正弦
    const rate = 8000
    const samples = Math.round(rate * 0.2)
    const pcm = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i += 1) {
      pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2)
    }
    const head = Buffer.alloc(44)
    head.write('RIFF', 0)
    head.writeUInt32LE(36 + pcm.length, 4)
    head.write('WAVE', 8)
    head.write('fmt ', 12)
    head.writeUInt32LE(16, 16) // fmt 块大小
    head.writeUInt16LE(1, 20) // PCM
    head.writeUInt16LE(1, 22) // 单声道
    head.writeUInt32LE(rate, 24)
    head.writeUInt32LE(rate * 2, 28) // 字节率
    head.writeUInt16LE(2, 32) // 块对齐
    head.writeUInt16LE(16, 34) // 位深
    head.write('data', 36)
    head.writeUInt32LE(pcm.length, 40)
    fs.writeFileSync(path.join(dir, 'tone.wav'), Buffer.concat([head, pcm]))
    made.push('tone.wav')

    // ④ 一段**放不出来**的东西（冒充 .mkv）：用来量"放不出来时界面有没有说一句人话"
    fs.writeFileSync(path.join(dir, 'broken.mkv'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))
    made.push('broken.mkv')
    return { ok: true, why: '', made }
  } catch (err) {
    return { ok: false, why: String(err), made }
  }
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

/**
 * 只按这次专用的 profile 目录匹配——绝不宽匹配（那会杀掉使用者自己的浏览器）。
 *
 * ⚠️ Windows 上 `pkill` 不存在，而且**光杀父进程不够**：Chrome 会 fork 出一堆
 *    渲染/GPU 子进程，杀掉父进程后它们还活着、还占着那个 profile 目录
 *    （于是下一次运行会看到"profile 已被占用"）。那边要用 `taskkill /T`——
 *    和 `process-tree.ts` 在 Windows 上收子进程树是同一个理由、同一把工具。
 */
function killChrome(profile, child) {
  try {
    child.kill('SIGKILL')
  } catch {}
  try {
    if (process.platform === 'win32') {
      if (typeof child.pid === 'number') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      execFileSync('pkill', ['-f', profile], { stdio: 'ignore' })
    }
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
log(dim(`一次性 daemon：${base}（数据在 .cache/layout-probe/，不碰 ~/.agentdeck）`))

// ⚠️ `--skills-root` / `--skills-mine-root` **必须显式传**，否则它们回落到
//    `~/.agentdeck/skills`（`defaultSkillsRoot()`）——而这一行的头注释写着
//    "数据与工作目录都在 .cache/layout-probe/ 下，绝不碰 ~/.agentdeck"。
//    实测撞到过：造夹具 skill 时 daemon 去 unlink
//    `~/.agentdeck/skills/probe-skill/SKILL.md`（在受限沙箱里是 EPERM ⇒
//    夹具 skill HTTP 500 ⇒ Skills 那几条静默变成"量到空态"）。在不受限的
//    机器上后果更糟：探针会**真的往使用者的技能根里装东西**。
const skillsRoot = path.join(SCRATCH, 'skills')
const skillsMineRoot = path.join(SCRATCH, 'skills-mine')
for (const d of [skillsRoot, skillsMineRoot]) fs.mkdirSync(d, { recursive: true })

/** 起 daemon（同一个数据目录、同一个端口，可能起两次——见下面"为什么起两次"）。 */
let daemon = null
let daemonLog = ''
function startDaemon() {
  const child = spawn(
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
      '--skills-root',
      skillsRoot,
      '--skills-mine-root',
      skillsMineRoot,
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.on('data', (b) => (daemonLog += b))
  child.stderr.on('data', (b) => (daemonLog += b))
  return child
}

daemon = startDaemon()

/**
 * 停掉 daemon 并**等它真的把 store 的锁放开**。
 *
 * ⚠️ 不能只 `kill()` 就接着开 FileStore：store 是**带锁的单写者**（`LockHeldError`），
 *    进程还没退干净时开它会直接抛。所以这里轮询"真的能打开"为止，
 *    而且把每次失败都咽掉（那正是"还没退干净"的正常表现）。
 */
async function stopDaemon() {
  if (!daemon) return
  daemon.kill('SIGTERM')
  const deadline = Date.now() + 10_000
  const { FileStore } = await import(path.join(ROOT, 'packages', 'store-file', 'src', 'index.ts'))
  while (Date.now() < deadline) {
    try {
      const probe = await FileStore.open({ dataDir, fsync: false })
      await probe.close?.()
      daemon = null
      return
    } catch {
      await sleep(200)
    }
  }
  throw new Error('daemon 没能在 10s 内停干净（store 锁一直占着）')
}

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
  // ★ 这条是必需的，不是装饰：任务页的"重复字样"检查最初是**空过**的
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
  // 记下第一条的 id：沉淀夹具那条源 run 要挂在它上面（`subject: {type:'issue'}`）。
  let issueFixtureId = ''
  try {
    for (const title of [seedTitle, '短标题']) {
      const res = await fetch(`${base}/api/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, description: '由 tools/layout-probe 造的夹具。' }),
      })
      if (!res.ok) {
        log(yellow(`⚠ 造夹具任务失败（HTTP ${res.status}）——任务页那几条检查会空过`))
        continue
      }
      const created = await res.json().catch(() => null)
      if (issueFixtureId === '' && created?.issue?.id) issueFixtureId = String(created.issue.id)
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
        skills: [
          {
            slug: 'probe-skill',
            name: '探针技能',
            // ★ 带 frontmatter 的 description：探针据此量"名称列有没有把作者
            //   写的说明显示出来"（正文仍是 `# 探针\n\n夹具。`——上面那条迁移
            //   断言认的是正文里那句）。
            body: '---\nname: probe-skill\ndescription: 探针夹具的说明\n---\n\n# 探针\n\n夹具。',
            source: 'local',
          },
        ],
      }),
    })
    if (!res.ok) log(yellow(`⚠ 造夹具 skill 失败（HTTP ${res.status}）——Skills 那几条会量到空态`))
  } catch (err) {
    log(yellow(`⚠ 造夹具 skill 时出错：${err}`))
  }

  // ★ 再造一个**老形态的审核者**（D38 的迁移夹具）：只挂 skill、没有内联标准。
  //   探针要走一遍"把判断依据并进「指令」→ 那条 skill 才卸得掉"。
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

  /**
   * ★★ 再造一个**什么都没有的审核者**（2026-09）：验证详情页顶上那条红警告
   * 「它审不了任何东西：没有写「指令」…」在**真的没有依据**时才出现。
   *
   * ⚠️ 它的孪生情形更重要：**只写了「指令」的审核者不该看到这条警告**——那条
   *    判据原来只看老字段（`reviewStandard` / `skillIds`），于是正常的审核者被
   *    误报（使用者的原话：「这个提示有问题」）。那个"不该出现"的方向用 D38 的
   *    夹具量（它搬完之后正是"只有指令"的形态），这里造的这一个量"该出现"。
   */
  try {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '探针用的没写指令的审核者', role: 'reviewer' }),
    })
    if (!res.ok) log(yellow(`⚠ 造没写指令的审核者失败（HTTP ${res.status}）`))
  } catch (err) {
    log(yellow(`⚠ 造没写指令的审核者时出错：${err}`))
  }

  /**
   * ★★ 再造一个**带内联老标准**的审核者（2026-09）：探针要走一遍
   * 「重新编辑保存一次 ⇒ 那条"还带着一份老的标准"的提示就该消失」。
   *
   * ⚠️ 为什么要**单独造一个**、而不是拿首启那个审核员来试：首启那个审核员
   *    被前面一组检查读着（老正文显示、并进来的按钮），把它改掉会让那一组
   *    量到"改完之后"的样子——一条断言读到的是别的现场，是这一整个探针里
   *    反复踩过的那类坑。
   */
  try {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '探针用的内联老标准审核者',
        role: 'reviewer',
        instructions: '你是严格的审核者。',
        // ⚠️ 正文要**长于 20 个字符**：`standard.detailShowsBody` 那条检查量的是
        //   "老正文真的显示出来了"（`pre` 里非空的一段），阈值 >20 是当初内置
        //   标准那段的长度——夹具正文太短会量不到"显示"这件事。
        reviewStandard: {
          body: '## 判定\n\n只看证据。\n\n1. 结论要有依据，证据要能指回原文。\n2. 不要引入标准之外的要求。',
        },
      }),
    })
    if (!res.ok) log(yellow(`⚠ 造内联老标准审核者失败（HTTP ${res.status}）`))
  } catch (err) {
    log(yellow(`⚠ 造内联老标准审核者时出错：${err}`))
  }

  /**
   * ★★ 再造一个**详情用的老标准审核者**（2026-09 三次改）：[审核标准] 那一段
   *   原来拿首启的审核员量"老正文显示 + 并进来的入口"，而首启的判据已并进
   *   「指令」（`reviewStandard` 是 null）——老正文那两条现在由**这一个**夹具
   *   来量。
   *
   * ⚠️ 为什么**不能**复用 `探针用的内联老标准审核者`：那一个是 fold-on-save 段
   *    的夹具（要留着完整的 `reviewStandard`），而 [审核标准] 段会在它身上走
   *    **真实保存**（勾 append-note 保存 ⇒ 内联老标准被服务端并进「指令」并清掉）。
   *    两条共用的话，fold-on-save 段量到的就是"改完之后"的样子——探针里反复
   *    踩过的那类坑（一条断言读到的是别的现场）。
   */
  try {
    const res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '探针用的老标准详情审核者',
        role: 'reviewer',
        instructions: '你是严格的审核者。',
        // ⚠️ 正文要**长于 20 个字符**：`standard.detailShowsBody` 那条检查量的是
        //   "老正文真的显示出来了"（`pre` 里非空的一段），阈值 >20 是当初内置
        //   标准那段的长度——夹具正文太短会量不到"显示"这件事。
        reviewStandard: {
          body: '## 判定\n\n只看证据。\n\n1. 结论要有依据，证据要能指回原文。\n2. 不要引入标准之外的要求。',
        },
      }),
    })
    if (!res.ok) log(yellow(`⚠ 造老标准详情审核者失败（HTTP ${res.status}）`))
  } catch (err) {
    log(yellow(`⚠ 造老标准详情审核者时出错：${err}`))
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
  // 造**聊天页的夹具**：一个挂着 skill 的执行者 + 一个谁都没挂的 skill
  // ══════════════════════════════════════════════════════════════════
  //
  // 「新对话」那个下拉里有一组选项是"按 skill 找的那个人"（选了它 = 和有这个
  // skill 的执行者对话）。没有夹具的话那几条检查会**空过**——空过等于永远绿，
  // 等于没量。
  //
  // ⚠️ 特意新造 skill、而不是复用上面的 `probe-skill`：那一条挂在**老形态审核者**
  //    身上，D38 的迁移那一段会动它的挂载。夹具之间不能互相踩。
  try {
    const res = await fetch(`${base}/api/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skills: [
          { slug: 'chat-probe-skill', name: '聊天夹具技能', body: '# 聊天夹具\n', source: 'local' },
          { slug: 'chat-orphan-skill', name: '没人挂的聊天夹具', body: '# 没人挂\n', source: 'local' },
        ],
      }),
    })
    if (!res.ok) log(yellow(`⚠ 造聊天夹具 skill 失败（HTTP ${res.status}）——聊天那几条会空过`))
    const all = (await (await fetch(`${base}/api/skills`)).json()).skills ?? []
    const owned = all.find((s) => s.slug === 'chat-probe-skill')
    if (!owned) {
      log(yellow('⚠ 找不到聊天夹具 skill——聊天那几条会空过'))
    } else {
      const r2 = await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '探针用的技能执行者',
          role: 'executor',
          skillIds: [owned.id],
        }),
      })
      if (!r2.ok) log(yellow(`⚠ 造技能执行者失败（HTTP ${r2.status}）`))
    }
  } catch (err) {
    log(yellow(`⚠ 造聊天夹具时出错：${err}`))
  }

  // ══════════════════════════════════════════════════════════════════
  // 造**对话目录夹具**：聊天右栏底部那一栏「工作目录的文件」
  // ══════════════════════════════════════════════════════════════════
  //
  // 那几条检查要一个**真的有东西的目录**，而且要三种东西都在：
  //
  //   · 产出（`结论.md`）与一个**还没展开**的子目录（`notes/`）——"一次只列一层"
  //     只有目录里真有一层可展开时才量得到；
  //   · 平台注入物（`.claude/skills/…` 与 `.agentdeck/context/…`）——"注入物
  //     排在产出后面"与"弱化显示"两条只有它们在的时候才有判据。
  //
  // ⚠️ **执行者用 `runtimeKey: 'generic'`**：建对话要带上第一句话，而那会立刻
  //    起一条 run。`generic` 的命令是 `agent-cli`（不存在），run 立刻以 ENOENT
  //    失败——这一条检查要的是"对话存在、目录是它报出来的那个"，与那一轮跑不跑
  //    得起来无关。探针不该替使用者去调真的 CLI（与三步链那三个夹具同一个理由）。
  //
  // ⚠️ 目录的路径**从 URL 交给探针页**：探针不该靠"列表里的第一条对话"这种脆
  //    假设去找它（`chatFilesWorkDir`）。
  //
  // ⚠️⚠️ **播种阶段刻意不建那条对话**：聊天那一段（执行者下拉、skill 那几条）
  //    是在"左栏一个对话都没有"的前提下量的——上一版在这里顺手建了对话，
  //    结果那一段全部变红（草稿态起不来、空态检查也失效）。所以对话由探针在
  //    **要量那一栏的那一刻**自己建（见 probe.html 里 `chatEnsureFixtureConversation`）。
  const chatFilesDir = path.join(SCRATCH, 'chat-files-wd')
  let chatFilesWorkDir = ''
  try {
    // 用 `fs.*Sync`（与上面工具夹具同一套）：这一段在起 daemon 之前跑，同步更直白
    const put = (rel, text) => {
      const full = path.join(chatFilesDir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, text)
    }
    put('结论.md', '# 结论\n\n夹具目录里的产出。\n')
    put('notes/deep.txt', 'deep\n')
    put('.claude/skills/probe-fixture/SKILL.md', '# 注入物\n')
    put('.agentdeck/context/probe.md', '上下文\n')
    // 查看器那几条要的东西：
    //   · 一个**真的会跑脚本**的 html（用来验 iframe 的 sandbox：脚本要能跑，
    //     而父页面**读不到**它的 document——那正是不透明源的意思）；
    //   · 一个带 NUL 的二进制（扩展名认不出 ⇒ 服务端回 octet-stream）；
    //   · 一个超过高亮阈值的源码文件（256KB 以上 ⇒ 不着色，但原文照旧完整）。
    put(
      'page.html',
      '<!doctype html><meta charset="utf-8"><title>probe</title>' +
        '<body><h1 id="t">还没跑</h1>' +
        '<script>document.getElementById("t").textContent="跑过了"</script>',
    )
    put('blob.bin', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41, 0x42, 0x00, 0xff]))
    put('big.py', Array.from({ length: 40000 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n')

    // ── 音视频（2026-10）──
    //
    // 需要**真能解码**的文件：视频那一条判据是"播放器拿到了元数据"（`readyState`），
    // 光有 `<video>` 元素不算数（一口空黑框正是这一条要挡的东西）。
    //
    // ⚠️ 用 **WebM/VP8**：Chrome 与 Chromium 都解码得了（H.264 只有 Google Chrome
    //    的官方包带），所以这条判据不取决于探针用的是哪个二进制。
    // ⚠️ `ffmpeg` 是**可选**依赖：没有就退化成"夹具没造出来"，那几条检查会因为
    //    找不到文件而红——而不是**静默变绿**（这是这个探针一贯的取舍）。
    const media = makeMediaFixtures(chatFilesDir)
    if (!media.ok) log(yellow(`⚠ 造音视频夹具失败：${media.why}——那几条检查会红`))
    else log(dim(`  音视频夹具：${media.made.join('、')}`))

    const madeAgent = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '探针用的目录执行者',
        role: 'executor',
        runtimeKey: 'generic',
      }),
    })
    if (!madeAgent.ok) throw new Error(`造目录执行者失败（HTTP ${madeAgent.status}）`)
    chatFilesWorkDir = chatFilesDir
  } catch (err) {
    log(yellow(`⚠ 造对话目录夹具时出错：${err}——那几条检查会空过`))
  }

  // ══════════════════════════════════════════════════════════════════
  // 造**工具包夹具**（D40）：三个目录，加一次真的安装
  // ══════════════════════════════════════════════════════════════════
  //
  // 三份夹具各管一件事，缺一条就会有一段检查**空过**：
  //
  //   ① `probe-tool`：装得上、**两个动作**，其中 `clean-notes` 是
  //      `reversible: false`——"不可回滚"那条标注只有动作本身带着这个值时才量得到
  //      （2026-09：`dryRun` 声明保留在夹具里，但它不再参与任何判断、也没有标注）；
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
        schema: 'agentdeck/tool@1',
        slug: 'probe-tool',
        name: '探针工具（夹具）',
        version: '1.0.0',
        description: '探针夹具：两个动作，其中一个不可回滚。',
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
            // ★ 这一条是"不可回滚"那条标注的唯一来源
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
        schema: 'agentdeck/tool@1',
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
        schema: 'agentdeck/tool@1',
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
    // ⚠️ 这里原来还会把夹具工具 `PUT` 到夹具执行者身上（`/api/agents/:id/tools`），
    //    好让「被哪些执行者挂载」那一列有内容可量。那一列与那条挂载能力一起撤掉了
    //    （使用者的决定），所以这次 PUT 没有消费者了，一并删掉——留着就是一条
    //    只为不存在的界面服务的夹具。接口本身仍由 `tools-api.test.ts` 覆盖。
    if (!res.ok) {
      log(yellow(`⚠ 装夹具工具失败（HTTP ${res.status}）——工具那几条会量到空态`))
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
  //   · `CHAIN_EXECUTOR`：执行者（2026-10 起不再有"长期由谁审"这个字段，
  //     配对改由**组**给出——见下面 `CHAIN_GROUP`）；
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
  const chainFixture = { executorId: '', reviewerId: '', emptyReviewerId: '', groupId: '' }
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
      // ⚠️ 2026-10 起 **agent 上不再有 `allowedActions` / `actionParams`**：
      //    "判完允许动什么"的唯一权威是**智能体组**（组页 ③ 行动）。这两个键
      //    现在会被 POST /api/agents 当"不认识的字段"400 拒掉——夹具因此
      //    静默没造出来，三步链那一组全量到空值（这一条是实测撞到的漂移）。
      //    长期权限改用下面那个**组**来给（见 `CHAIN_GROUP`）。
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
      // ⚠️ 这里原来传 `reviewerAgentId`（"这个执行者长期由谁审"）——2026-10 起
      //    这个概念**整个移除**（协议里字段都删了），"谁审"的唯一出处是
      //    **智能体组**。所以那一段不再设：② 的「跟随」在 agent 档下跟不到人，
      //    长期权限那一族判据改由上面那个组承担（`chainGroup`）。
      //    ⚠️ 传了就 400（"不认识的字段"）⇒ 整个链夹具造不出来 ⇒ 那一组全空过。
    })

    // ★ 长期行动权限现在挂在**组**上：新建任务页选「智能体组」时，① ② ③ 的
    //   默认值由这个组展开（`groupChainDefaults`）——③ 里那两个"跟随之"的
    //   判据（胶囊逐字等于接口回给它的值、固定参数的默认值）量的就是它。
    let chainGroup = null
    if (reviewer && executor) {
      const res = await fetch(`${base}/api/agent-groups`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: CHAIN_GROUP,
          members: [String(executor.id), String(reviewer.id)],
          allowedActions: [CHAIN_ACTION],
          actionParams: { [CHAIN_ACTION]: { text: '长期钉的' } },
        }),
      })
      if (!res.ok) {
        const detail = await res
          .json()
          .then((p) => p.error ?? '')
          .catch(() => '')
        log(yellow(`⚠ 造三步链夹具组失败（HTTP ${res.status}${detail ? `：${detail}` : ''}）`))
      } else {
        chainGroup = await res.json()
      }
    }

    if (reviewer && emptyReviewer && executor) {
      chainFixture.executorId = String(executor.id)
      chainFixture.reviewerId = String(reviewer.id)
      chainFixture.emptyReviewerId = String(emptyReviewer.id)
      if (chainGroup) chainFixture.groupId = String(chainGroup.group.id)
    } else {
      log(yellow('⚠ 三步链夹具没造全——新建任务那一组会量到空值'))
    }
  } catch (err) {
    log(yellow(`⚠ 造三步链夹具时出错：${err}`))
  }

  // ══════════════════════════════════════════════════════════════════
  // 造**本地技能目录夹具**（Skills 页 →「设置」）
  // ══════════════════════════════════════════════════════════════════
  //
  // 这一组量的是"勾一个别的 AI 工具的目录 ⇒ skill 出现在这一页 ⇒ 能挂给智能体"
  // 这条链**真的通**。三份夹具各管一件事：
  //
  //   ① `probe-local-a` / ② `probe-local-b`：两个真技能（要量"读进来了几个"，
  //      一个的话"只读进来一个"和"只认得一个"分不清）；
  //   ③ `probe-empty-dir/`：**没有 SKILL.md 的空目录**——实测
  //      `~/.claude/skills` 里就有一个这样的，而"勾了却少一个"是使用者最可能
  //      撞上的困惑，界面上必须有一句话解释它。
  //
  // ⚠️ 目录写在 SCRATCH 里（`.cache/layout-probe/`），仓库外一个字节都不写。
  // ⚠️ 路径要传给探针页：抽屉里那次勾选是"真的往输入框里打字"驱动的。
  const fixtureLocalSkillsRoot = path.join(SCRATCH, 'fixture-local-skills')
  try {
    for (const [slug, summary] of [
      ['probe-local-a', '探针夹具：本地目录里的第一个技能。'],
      ['probe-local-b', '探针夹具：本地目录里的第二个技能。'],
    ]) {
      const dir = path.join(fixtureLocalSkillsRoot, slug)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${slug}\ndescription: ${summary}\n---\n\n# ${slug}\n\n${summary}\n`,
      )
    }
    // 没有 SKILL.md 的目录：要出现在"跳过"那句话说的地方
    fs.mkdirSync(path.join(fixtureLocalSkillsRoot, 'probe-empty-dir'), { recursive: true })
  } catch (err) {
    log(yellow(`⚠ 造本地技能目录夹具时出错：${err}`))
  }

  // ══════════════════════════════════════════════════════════════════
  // 造**沉淀草稿**夹具（D80 审阅页的排版）
  // ══════════════════════════════════════════════════════════════════
  //
  // ★ 为什么这一组夹具要**停一次 daemon 再起**：
  //
  //   审阅页要量的东西（结论条、树、编辑/差异切换、素材折叠）全都长在一条
  //   **已完成的起草 run** 上，而这条 run 只能直接写进 store：
  //     · 走 `POST /api/crystallize/draft` 会去 spawn 真 CLI（NFR-T-01 禁止）；
  //     · 而 store 是**带锁的单写者**，daemon 开着的时候打不开（`LockHeldError`）。
  //   所以顺序是：起一次（把工作区与播种的 agent 建出来、把 HTTP 夹具都造好）
  //   → 停 → 直接写这条草稿 run 与它的 `skill/`、`material/` → 再起 → 量。
  //
  //   ⚠️ 播种（工作区 + 那对 agent）**只在首启**发生（`bootstrap` 见到已有工作区
  //      就直接返回），所以数据目录不能自己造——必须让 daemon 先建一遍。
  const crystalFixture = { draftRunId: '', revisedRunId: '', sourceRunId: '' }
  try {
    await stopDaemon()
    const { FileStore } = await import(path.join(ROOT, 'packages', 'store-file', 'src', 'index.ts'))
    const { ulid } = await import(path.join(ROOT, 'packages', 'protocol', 'src', 'ids.ts'))
    const store = await FileStore.open({ dataDir, fsync: false })
    try {
      const workspaceId = (await store.listWorkspaceIds())[0]
      const agents = await store.listAgents(workspaceId)
      const executor = agents.find((a) => a.role === 'executor') ?? agents[0]
      if (!workspaceId || !executor) {
        log(yellow('⚠ 找不到播种的 workspace / 执行者——沉淀那几条会空过'))
      } else {
        const now = Date.now()
        /**
         * 造一条**源 run**（起草页拿它算素材与目标）。
         *
         * ⚠️ 不派发、不 spawn——只是 store 里的一条记录。
         */
        const makeSource = async () => {
          const id = ulid()
          await store.insertRun({
            id,
            workspaceId,
            kind: 'execute',
            status: 'completed',
            agentId: executor.id,
            agentName: executor.name,
            subject: { type: 'issue', id: issueFixtureId },
            prompt: '探针夹具：沉淀的来源任务',
            queuedAt: now - 60_000,
            startedAt: now - 59_000,
            finishedAt: now - 58_000,
          })
          return id
        }
        /**
         * ★★ 两条草稿**各挂一个源 run**（不是共用一个）。
         *
         * 为什么：`找进行中的起草`（`findActiveDraft`）按源 run 找**最新那条**未入库
         * 草稿——两条草稿共用一个源时，**旧的那条永远挂不上**（界面上「继续」一定
         * 恢复新的那条，这是对的行为）。于是"量第一版草稿"的那一段实际量到的是
         * 第二版的现场（实测：`revisedFrom` 有值 ⇒ 基线切换按钮在、树行标着"修改"、
         * 全量都算"新增"的判据全红）。两条各一个源，两条才都挂得上。
         */
        const sourceRunId = await makeSource()
        const revisedSourceRunId = await makeSource()

        /**
         * 造一条**已完成的起草 run** + 它的产出目录。
         *
         * `files` 会真的写到 `<workRoot>/skill-draft-<id>/skill/` 下——审阅页读的是
         * 磁盘（`readDraftSkillDir`），不是 run 记录。
         */
        // ⚠️ `queuedAt` **必须两条不同**：`findActiveDraft`（daemon 侧"恢复进行中的
        //    起草"）按 `queuedAt` 降序取最新那条，而**相等时排序退化成插入序** ⇒
        //    界面上的「继续」会挂到**旧的那条**，后面所有"改版草稿"的判据都量到上
        //    一版的数字（实测踩过：结论条显示"+24 −0 · 对比当前版本"，而那一版根本
        //    没有 `revisedFrom`）。真机上两条草稿之间隔着一次 LLM 起草，不可能同毫秒；
        //    夹具里用一个共享的 `now` 就极易撞上，所以这里按序号递增。
        let draftSeq = 0
        const makeDraft = async (id, files, extra = {}) => {
          const { sourceRunId: draftSourceId = sourceRunId, ...rest } = extra
          const dir = path.join(workRoot, `skill-draft-${id}`)
          for (const [rel, text] of Object.entries(files)) {
            const full = path.join(dir, 'skill', rel)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            fs.writeFileSync(full, text)
          }
          // 素材也要有几份：素材折叠行的摘要量与预览量都指着它
          for (const [rel, text] of [
            ['00-README.md', '# 素材索引（探针夹具）\n\n先读这份，再按需读下面几份。\n'],
            ['meta.json', '{ "turns": 1, "toolCalls": 3 }\n'],
            ['turns/001.md', '# 第一轮\n\n探针夹具的一轮。\n'],
          ]) {
            const full = path.join(dir, 'material', rel)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            fs.writeFileSync(full, text)
          }
          draftSeq += 1
          await store.insertRun({
            id,
            workspaceId,
            kind: 'execute',
            status: 'completed',
            agentId: executor.id,
            agentName: executor.name,
            subject: { type: 'skill-draft', id, sourceRunId: draftSourceId },
            prompt: '探针夹具：起草',
            queuedAt: now - 30_000 + draftSeq * 1_000,
            startedAt: now - 29_000,
            finishedAt: now - 28_000,
            crystallizeTarget: { kind: 'new' },
            ...rest,
          })
          return id
        }

        const skillMd = (step2) =>
          '---\n' +
          'name: probe-crystal\n' +
          'description: 探针夹具：给沉淀审阅页量排版用。\n' +
          '---\n\n' +
          '# 探针提炼流程\n\n' +
          '## When to Use\n\n- 探针量排版时\n\n' +
          '## Procedure\n\n' +
          `1. 第一步\n2. ${step2}\n\n` +
          '## Verification\n\n- 探针全绿\n'

        // 第一版：三个文件（多文件产出）
        crystalFixture.sourceRunId = sourceRunId
        crystalFixture.draftRunId = await makeDraft(ulid(), {
          'SKILL.md': skillMd('第二步'),
          'references/notes.md': '# 说明\n\n第一版。\n',
          'scripts/check.sh': '#!/bin/sh\necho probe\n',
        })
        // 第二版：`revisedFrom` 指着第一版（界面据此给「对比上一版」）
        crystalFixture.revisedRunId = await makeDraft(
          ulid(),
          {
            'SKILL.md': skillMd('第二步（已按意见改）'),
            'references/notes.md': '# 说明\n\n第一版。\n',
            'scripts/check.sh': '#!/bin/sh\necho probe\n',
          },
          { revisedFrom: crystalFixture.draftRunId, sourceRunId: revisedSourceRunId },
        )
      }
    } finally {
      await store.close()
    }
  } catch (err) {
    log(yellow(`⚠ 造沉淀草稿夹具时出错：${err}`))
  }
  daemon = startDaemon()
  if (!(await waitFor(base, 20_000))) {
    log(red('✗ 第二次 daemon 没起来。它的输出：'))
    for (const l of daemonLog.split('\n').slice(-12)) log('  ' + l)
    throw new DaemonDown()
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
      // ⚠️ 120s 那档在「列表栏骨架（D61）」那一组（末尾多量三页、每页两三次
      //    等待）之后又紧了：实测 dump 出来时 `done` 还没写。放宽到 180s。
      `--virtual-time-budget=${VIRTUAL_MS}`,
      '--dump-dom',
      // ★ 把夹具路径交给探针页：抽屉里那次安装是"真的往输入框里打字"驱动的，
      //   而探针不可能自己编出 `.cache/layout-probe/…` 这个绝对路径。
      // ★ 三步链那三个 id 与动作名同样从 URL 传（与工具路径一个理由：夹具在
      //   Node 侧造，探针**不许**靠"列表里的第一个"这种脆假设去找它们）。
      `${base}/${PROBE_NAME}?badToolPath=${encodeURIComponent(brokenToolFixtureDir)}&uiToolPath=${encodeURIComponent(uiToolFixtureDir)}` +
        `&chainExecutor=${encodeURIComponent(chainFixture.executorId)}` +
        `&chainReviewer=${encodeURIComponent(chainFixture.reviewerId)}` +
        `&chainEmptyReviewer=${encodeURIComponent(chainFixture.emptyReviewerId)}` +
        `&chainAction=${encodeURIComponent(CHAIN_ACTION)}` +
        `&chainGroup=${encodeURIComponent(chainFixture.groupId ?? '')}` +
        `&crystalDraft=${encodeURIComponent(crystalFixture.draftRunId)}` +
        `&crystalRevised=${encodeURIComponent(crystalFixture.revisedRunId)}` +
        `&localSkillsDir=${encodeURIComponent(fixtureLocalSkillsRoot)}` +
        (chatFilesWorkDir ? `&chatFilesWorkDir=${encodeURIComponent(chatFilesWorkDir)}` : ''),
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
    log(yellow(`--keep：daemon 还开着（PID ${daemon?.pid}）→ ${base}/#/agents`))
    log(yellow(`  自己拿浏览器看，用完：kill ${daemon.pid}`))
    daemon?.unref()
  } else {
    daemon?.kill('SIGTERM')
    await sleep(600)
    try {
      daemon?.kill('SIGKILL')
    } catch {}
  }
  // dist 是构建产物，探针页不该留在那儿（下次 build 也会清掉，但别指望它）
  fs.rmSync(probeDst, { force: true })
}

process.exit(exitCode)
