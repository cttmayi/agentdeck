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
import vm from 'node:vm'

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
/**
 * 「配过、但包已经卸载」那条权限的**宿主组**（D41 那一族的夹具）。
 *
 * ⚠️ 必须在这里造（真实时间、包还装着的时候）：写入口**会拒**"动作来自还没装的
 *    工具包"（`POST /api/agent-groups` 的 400 说得很清楚），所以"先配上、再把包卸掉"
 *    是造这个状态的唯一路径——顺序反了就造不出来（curl 试过：先传 `nope.missing`
 *    当场被拒）。当年这条状态住在 **agent** 上，2026-10 起动作权限只属于组。
 */
// （那个夹具组由探针页自己造，见 `probe.html` 的 ④.5；名字与动作名写在那一边，
//   因为造它的那一刻才装好 `probe-tool-ui`。）

const CHECKS = [
  // ══════════════════════════════════════════════════════════════════
  // 新建任务（2026-10 简化版）：一句话 ⇒ 交给谁（智能体 / 智能体组）⇒ 只读摘要 ⇒ 提交
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 原来这里量的是**三步链**（① 执行 / ② 审核 / ③ 行动 + ③ 里的左选右配选择器 +
  //    D44 固定参数编辑器 + D43 开关 + 「这一次」三态覆盖），那 66 条在重做之后
  //    **界面上没有宿主**（一直红）。权威搬到**智能体组**，这一页只问两件事、给一张
  //    只读摘要。所以判据也换了——**红得久了，真坏了也看不出来**（前三批的教训）。
  {
    view: '新建任务',
    key: 'newtask.pageOpened',
    label: '前提：新建任务页打开了（`#/new` 有「交给谁」那张卡片）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务',
    key: 'newtask.titleAbovePick',
    label: '★「要做什么」在「交给谁」**上面**（先说要做什么、再决定谁做；顺序反过来就成了"先指派一个不认识任务的人"）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务',
    key: 'newtask.pickCardTitle',
    label: '★ 那张卡片问的是「交给谁」（一句话 + 一张卡片 = 这一页的全部问题）',
    ok: (v) => typeof v === 'string' && v.includes('交给'),
  },
  {
    view: '新建任务',
    key: 'newtask.sourceToggleFound',
    label: '★★★ 有「智能体 / 智能体组」互斥两档——组是"执行→审核→行动"的**默认配置**，'
      + '没有这一档，「谁审、判完能做什么」就没有入口（实验过：只有智能体那一档时，'
      + '这条任务的审核标准只能靠人另外再去组页配）',
    ok: (v) => v === true,
    show: (v, f) => `${v}　两档：${JSON.stringify(f['newtask.sourceToggleLabels'] ?? null)}`,
  },
  {
    view: '新建任务',
    key: 'newtask.agentSummaryTitle',
    label: '★ 摘要标题随选中对象走（智能体 ⇒「智能体摘要」，组 ⇒「智能体组摘要」）：'
      + '同一张卡在两档里说的事不一样，标题不说清就读不懂那几行是谁的配置',
    ok: (v) => v === '智能体摘要',
    show: (v, f) => `${JSON.stringify(v)}　行：${JSON.stringify(f['newtask.agentSummaryKeys'] ?? null)}`,
  },
  {
    view: '新建任务',
    key: 'newtask.agentNoReviewerText',
    label: '★★★ 选**单个智能体**时摘要必须说出「**没有**——选单个智能体不会自动审核」'
      + '（2026-10 起 agent 上那条「由谁来审它」撤了 ⇒ 这一档谁也不审）。'
      + '画成一行"未配置"或干脆不画，都会让人以为还是有人审',
    ok: (v) => typeof v === 'string' && v.includes('不会自动审核'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '新建任务',
    key: 'newtask.agentFootSummary',
    label: '★★ 提交栏那一行说清"我即将提交的是什么"（交给谁 · 谁审 · 允许几个动作）——'
      + '滚下去看高级选项时它是唯一还在的上下文',
    ok: (v) => typeof v === 'string' && v.includes('交给') && v.includes('不自动审核'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '新建任务',
    key: 'newtask.summaryControlCount',
    label: '★★★ 摘要里**没有任何控件**（input/select/textarea/button 全为 0）：这一页是'
      + '**只读**的——"这次怎么走"全部来自长期配置或组。原来说好的"这一次覆盖"整块撤了，'
      + '所以"摘要不能改"这条本身要成为判据（否则哪天又长出半个编辑态，谁也不记得它不该在）',
    ok: (v) => v === 0,
    show: (v) => `${v} 个控件`,
  },
  {
    view: '新建任务',
    key: 'newtask.pickerOrParamsOnPage',
    label: '★★★ 整页**没有**动作选择器 / 勾选框 / 固定参数编辑器 / 浮层：'
      + '那几个东西搬去了智能体组页的 ③ 行动（同一件事只有一个入口——'
      + '两个入口必然分叉），这一页只剩摘要与提交',
    ok: (v) =>
      !!v &&
      v['选择器'] === 0 &&
      v['勾选框'] === 0 &&
      v['固定参数'] === 0 &&
      v['对话框'] === 0,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '新建任务',
    key: 'newtask.groupTabFound',
    label: '前提：切到「智能体组」那一档（夹具里有一个启用的组）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务',
    key: 'newtask.groupSelectApplied',
    label: '前提：真的选中了夹具那个组（占位项不可选 ⇒ 必须显式选一个）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupSummaryTitle',
    label: '★ 组那一档的摘要标题是「智能体组摘要」',
    ok: (v) => v === '智能体组摘要',
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupSummaryMatchesGroup',
    label: '★★★ 摘要上那几行**逐项等于组上的配置**（审核者有人名 / 允许的动作数 = 组配的条数 / '
      + '返工 = 组的默认）——这一页显示的必须是组那一份，不是"第一个审核者"之类的猜测',
    ok: (v) => v === true,
    show: (v, f) =>
      `${v}　摘要：${JSON.stringify(f['newtask.groupSummaryRows'] ?? null)}　` +
      `组：${JSON.stringify(f['newtask.groupRecordRead'] ?? null)}`,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupFootSummary',
    label: '★★ 组那一档的提交栏同样说清"交给谁 · 谁审 · 允许几个动作"（与智能体那一档同一口径）',
    ok: (v) => typeof v === 'string' && v.includes('交给') && !v.includes('不自动审核'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.agentSubmitReachedTasks',
    label: '★★★ 端到端 A：选**单个智能体**、写上一句话就能提交，而且那条 run 真的出现在接口上'
      + '（这一段最贵的错误是"界面上选的"与"发出去的请求体"不是同一件事，只有走完真入口才看得见）',
    ok: (v) => v === true,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.agentRunAgentId',
    label: '★★★ 端到端 A：接口上那条 run 的执行者**就是**界面上选的那个人（不是默认执行者）',
    ok: (v, f) => v !== null && v === f['newtask.fixtureExecutorId'],
    show: (v, f) => `${JSON.stringify(v)}　界面选的：${JSON.stringify(f['newtask.fixtureExecutorId'] ?? null)}`,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.agentRunHasAllowedActionsKey',
    label: '★★★ 端到端 A：接口上那条 run **没有** `allowedActions` 这个键——选智能体这条路不给动作。'
      + '（键在且为空数组是**另一件事**：那是"这一次一个都不许动"的显式决定。省略 ≠ 空数组，'
      + '上一版探针就是靠这对差别钉死三态纪律的，这里保留同一条口径）',
    ok: (v) => v === false,
    show: (v, f) => `${v}　值：${JSON.stringify(f['newtask.agentRunAllowedActions'] ?? null)}`,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.agentRunReviewerMode',
    label: '★★★ 端到端 A：接口上那条 run 的 `reviewer.mode` 是 **`none`**（"这条任务没人审"'
      + '要是一个**说得出口的状态**，而不是一个读不出意思的 `null`）',
    ok: (v) => v === 'none',
    show: (v, f) => `${JSON.stringify(v)}　有 reviewerAgentId 吗：${f['newtask.agentRunHasReviewerId']}`,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupRunReviewerMode',
    label: '★★★ 端到端 B：接口上那条 run 的 `reviewer.mode` 是 **`assigned`**（有审核者，'
      + '而且它是**组**给的 ⇒ 配合下面那条 `groupId` 就能回答"审核者从哪来"）',
    ok: (v) => v === 'assigned',
    show: (v, f) => `${JSON.stringify(v)}　groupId：${JSON.stringify(f['newtask.groupRunGroupId'] ?? null)}`,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupSubmitReachedTasks',
    label: '★★★ 端到端 B：选**智能体组**提交，那条 run 也真的出现在接口上',
    ok: (v) => v === true,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupRunGroupId',
    label: '★★★ 端到端 B：落库那条 run 上带着 **`groupId`**（记录用：判过之后要能回答'
      + '"这条链的配置是从哪个组来的"）',
    ok: (v, f) => v !== null && v === f['newtask.fixtureGroupId'],
    show: (v, f) => `${JSON.stringify(v)}　夹具那个组：${JSON.stringify(f['newtask.fixtureGroupId'] ?? null)}`,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupRunReviewerId',
    label: '★★★ 端到端 B：审核者由**组展开**而来（接口上的 `reviewerAgentId` = 组里那个审核者）——'
      + '这一条与上面那条一起钉住"摘要上说的、发出去的、落库的是同一件事"',
    ok: (v, f) => v !== null && v === f['newtask.fixtureReviewerId'],
    show: (v, f) => `${JSON.stringify(v)}　组里的审核者：${JSON.stringify(f['newtask.fixtureReviewerId'] ?? null)}`,
  },
  {
    view: '新建任务 · 链',
    key: 'newtask.groupRunAllowedActions',
    label: '★★★ 端到端 B：允许的动作由组展开（那一条 `probe-tool.clean-notes`）——'
      + '选组这条路**不给动作**就等于"组配了但从来不会动"',
    ok: (v, f) =>
      Array.isArray(v) && v.length === 1 && v[0] === f['newtask.fixtureAction'],
    show: (v, f) => `${JSON.stringify(v)}　夹具那条：${JSON.stringify(f['newtask.fixtureAction'] ?? null)}`,
  },
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
    key: 'agents.drafterRowFound',
    label: '夹具：内置起草者那一行在列表里（下面两条量的是它的角色徽标）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.drafterRowBadge',
    label:
      '★★★ 内置起草者的徽标说「起草」而**不是「执行」**（2026-10 实修：列表原先只会说 执行/审核，加了两个内置角色后它们被标成执行者）',
    ok: (v) => v === '起草',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '智能体',
    key: 'agents.skillAuditorRowFound',
    label: '夹具：内置 skill 审核者那一行在列表里（§10 第 ④ 条新建的第二个内置智能体）',
    ok: (v) => v === true,
  },
  {
    view: '智能体',
    key: 'agents.skillAuditorRowBadge',
    label: '★★★ 它的徽标说「审核沉淀」——两个内置角色的徽标要**分得开**，不能都叫"审核"',
    ok: (v) => v === '审核沉淀',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '智能体',
    key: 'agents.runtimeOptionsNoDefault',
    label:
      'runtime 选择器的**具体 runtime** 选项与身份接口一致（加/删一个 runtime 时写死的界面会在这里暴露）',
    // ⚠️ 比的是**排掉 `default` 之后**的选项：`default` 是"跟随全局默认"的伪值，不是 runtime。
    //    2026-10 加了那一项之后这条断言就红了（实测：DOM 是 claude | codex | default，
    //    身份接口是 claude | codex）——**界面是对的，判据要跟上**。排掉它并不放松：
    //    下面紧接着一条专门量 `default` 还在不在、是不是第一项。
    ok: (v, facts) =>
      Array.isArray(v) &&
      v.length > 0 &&
      JSON.stringify(v) === JSON.stringify(facts['agents.identityRuntimeKeys']),
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '智能体',
    key: 'agents.runtimeFollowDefaultFirst',
    label:
      '★★ 「跟随全局默认」（`default`）在选择器里、而且是**第一项**（少了它，打开编辑页什么都没做、保存就把这个 agent 的默认改掉了）',
    ok: (v) => v === true,
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
  // ══════════════════════════════════════════════════════════════════
  // 「从本地安装」：D73 之后的形状（扫已知目录 ⇒ 逐条点装 ⇒ 能挂给智能体）
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 原来这一族量的是**顶栏「设置」抽屉 + 勾目录**（那套 2026-10 撤了，见 probe.html
  //    那一段开头的说明）：抽屉、勾选框、「自己填一个路径」、以及「表里出现夹具那两个
  //    skill」。撤掉之后那些断言在界面上**没有宿主**（一直红），所以换成下面这些——
  //    它们钉的是**现在的**形状，而且把"不再勾目录"这件事本身变成判据。
  {
    view: '技能',
    key: 'skills.localPanelButtonFound',
    label: '前提：Skills 页顶栏那颗「安装技能」在（「从本地安装」是**安装面板里的**一个页签，'
      + '不是列表上的页签）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.localTabFound',
    label: '★★★ 「从本地安装」页签在（D73 之后本地安装就住在这儿；找不到它这一段全空过）',
    ok: (v) => v === true,
    show: (v, f) => `${v}　四个页签：${JSON.stringify(f['skills.tabTexts'] ?? null)}`,
  },
  {
    view: '技能',
    key: 'skills.localTabActive',
    label: '★ 点得动：点它之后它自己变成选中的那个页签',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.localGroupCount',
    label: '★★ 扫到的那几个目录**各自成组**（内置候选表：Claude Code / Codex / Cursor / '
      + 'AGENTS 约定目录——一个都没扫到就说明这条链根本没通）',
    ok: (v) => typeof v === 'number' && v >= 1,
    show: (v, f) => `${v} 组：${JSON.stringify(f['skills.localGroupLabels'] ?? null)}`,
  },
  {
    view: '技能',
    key: 'skills.localGroupsAllHavePath',
    label: '★★★ 每个目录都把**路径**写出来（"哪个目录"是这一页唯一的上下文；只说'
      + '「Claude Code 里 3 个」等于让使用者自己去猜是哪个文件夹）',
    ok: (v) => v === true,
    show: (v, f) => `${v}　实测：${JSON.stringify(f['skills.localGroupPaths'] ?? null)}`,
  },
  {
    view: '技能',
    key: 'skills.localTabNoCheckbox',
    label: '★★★ D73 之后**目录那一栏里**一个勾选框都没有（只数表里的）：装不装是逐条点的事，'
      + '不再"勾上目录 ⇒ 后台自动对账读进库"。⚠️ 面板里那颗「覆盖已存在的技能」是另一件事，'
      + '不该被算进来',
    ok: (v) => v === true,
    show: (v, f) => `${v}　表里勾选框 ${f['skills.localTabNoCheckboxCount'] ?? '?'} 个`,
  },
  {
    view: '技能',
    key: 'skills.localGroupCounts',
    label: '★ 每个目录先说清里面**几个**技能（折叠着也要能给个数——不然使用者不知道要不要展开）',
    ok: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '技能',
    key: 'skills.localGroupExpands',
    label: '★★ 点目录那一行能**展开**（整行一个真按钮：点哪儿都能折）；展开之后露出里面的技能行',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.localRowsAllHaveInstallButton',
    label: '★★★ 展开后**每一条**都有自己的「安装」（不是整目录一键装——那会把使用者还没'
      + '看过的也一起装进来）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.localSlugWasNew',
    label: '前提：挑中的那条**此前没装过**（否则"装上去了"是假的）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.localInstallLandedOnServer',
    label: '★★★ 点「安装」之后，**接口上**真的多出那条技能（`GET /api/skills`；不是只把'
      + '按钮变灰——那是本地状态）',
    ok: (v) => v === true,
    show: (v, f) => `${v}　实测装的是：${String(f['skills.localInstalledSlug'] ?? '')}`,
  },
  {
    view: '技能',
    key: 'skills.localInstallSourceKind',
    // ⚠️ 从本地目录装进来的那条，库里的 `source` 是 **`local`**（不是 `path`——`path`
    //    是**扫描**时那个 spec 的 kind），来源目录落在 `localDir` 上。第一版按 `path`
    //    写：量到 `local` ⇒ 红，而界面其实是对的（判据写错了，不是界面错了）。
    label: '★ 装进来的那条来源是**本地**（`source === "local"`，且 `localDir` 就是那个来源目录）'
      + '——列表那枚徽标靠它才能指回来源目录',
    ok: (v, f) => v === 'local' && typeof f['skills.localInstallSourcePath'] === 'string',
    show: (v, f) => `${JSON.stringify(v)}　来源目录：${String(f['skills.localInstallSourcePath'] ?? '')}`,
  },
  {
    view: '技能',
    key: 'skills.localRowInList',
    label: '★★★ 关掉面板回到列表，装进来的那条**真的在那张表里**（列表与面板是两份渲染，'
      + '中间断了就表现成"装完看不见"）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.localBadgeHasPath',
    label: '★★★ 列表里那枚来源徽标里**带着来源目录的路径**（不是笼统的「本机自建」：装进来的'
      + '正文已经落在我们自己的 skills 目录下，徽标是唯一能追回去的线索）',
    ok: (v) => v === true,
    show: (v, f) =>
      `${v}　接口上的 localDir：${JSON.stringify(f['skills.localInstallSourcePath'] ?? null)}`,
  },
  {
    view: '技能',
    key: 'skills.dirsSkipNote',
    label: '★ 看到了却没当成技能的东西「一直挂着说清理由」（没有 SKILL.md / 太深 / 解析不了…）'
      + '——否则就是"少了一个"，还会让人去查权限、查扫描是不是坏了',
    ok: (v) => v === true || v === null,
    show: (v, f) =>
      `${v}（本机没有被跳过的条目时如实记 null；实测 ${JSON.stringify(v)}）`,
  },
  {
    view: '技能',
    key: 'skills.dirEmptyReported',
    label: '★★ 空目录要**如实说**「里面没有技能」（不是一行空白，也不是干脆不列这个目录）',
    ok: (v) => v === true || v === null,
    show: (v, f) => `${v}（本机 ${f['skills.dirEmptyGroupCount'] ?? '?'} 个空目录）`,
  },
  {
    view: '技能',
    key: 'skills.dirReadErrorShown',
    label: '★ 目录读不了时说读不了（`notice.warn`，不是一张空表）——这一档要有"读不了的'
      + '目录"才量得到，没造出来时如实记 false',
    ok: (v) => typeof v === 'boolean',
    show: (v) => `${v}（如实报，不假装通过）`,
  },
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
  // ── P2：历史（git）那一节（只有 source:'mine' 才有）──────────────
  //
  // 夹具是真入库的 `probe-mine`（daemon 真打了一条 commit）。这一族量四件事：它在
  // mine 出现、**不在安装来的技能上出现**、默认选中最新那条、界面上列的文件数与
  // **后端算的那一份**一一对上（前端只渲染，不许自己算）。
  {
    view: '技能',
    key: 'skills.historyMineRowFound',
    label: '★ 夹具「probe-mine」（真入库 ⇒ 有 git 历史）那一行在表里——这一族判据全靠它',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.historySectionOnMine',
    label: '★★★ 展开「我提炼的」那一行 ⇒ 里面有「历史（git）」这一节',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.historyFoldTag',
    label: '折叠入口是**真按钮**（tab 能到、读屏器能读）——不是标题文字假装的',
    ok: (v) => v === 'BUTTON',
  },
  {
    view: '技能',
    key: 'skills.historyAbsentOnInstalled',
    label: '★★★ 安装来的技能**没有**这一节（外部内容重新装就行；点开看到"版本管理未启用"是噪音）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.historyEntryCount',
    label: '★★★ 历史列表里**真的**列出了提交（≥1 条；0 = 接口或夹具没通）',
    ok: (v) => typeof v === 'number' && v >= 1,
    show: (v) => `${v} 条`,
  },
  {
    view: '技能',
    key: 'skills.historyTopActive',
    label: '★★★ 默认选中**最新**那条（打开这一节想问的是"最近改了什么"）',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.historyFirstVersionBadge',
    label: '★ 只有一条提交时标出「首次入库（全部新增）」——否则最早那条会被读成"改了什么"',
    ok: (v) => v === true,
  },
  {
    view: '技能',
    key: 'skills.historyDiffFileCount',
    label: '★★★ 选中之后**真的**渲染出逐文件差异（≥1 个文件块）',
    ok: (v) => typeof v === 'number' && v >= 1,
    show: (v) => `${v} 个文件`,
  },
  {
    view: '技能',
    key: 'skills.historyDiffHunkCount',
    label: '★ 差异里有 hunk 头（@@ … @@）——不是只列了文件名',
    ok: (v) => typeof v === 'number' && v >= 1,
    show: (v) => `${v} 个 hunk`,
  },
  {
    view: '技能',
    key: 'skills.historyDiffChangeBadges',
    label: '★★★ 首次入库那一版全是「新增」——对着空目录比，不该出现修改/删除',
    ok: (v) => Array.isArray(v) && v.length >= 1 && v.every((x) => x === '新增'),
    show: (v) => (Array.isArray(v) ? v.join(' / ') : String(v)),
  },
  {
    view: '技能',
    key: 'skills.historyDiffMatchesApi',
    label: '★★★ 界面列出的文件数 == 后端 /compare 算出来的"非 same"文件数（前端只渲染、不自己算）',
    ok: (v) => !!v && v.界面上 === v.后端算的,
    show: (v) => (v ? `界面 ${v.界面上} / 后端 ${v.后端算的}` : '没量到这个值'),
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
  {
    view: '技能',
    key: 'skills.tabCount',
    // ⚠️ 原来是 3（路径/GitHub · 远端目录 · 本地清单）——D73 之后多了「从本地安装」
    //    那一档（勾目录那套撤了，改成一个页签）。**数目要跟着改，而不是把断言放宽成
    //    ">=3"**：数目正是"有没有人多塞一个页签/少一个"的判据。
    label: '四个来源页签都在（路径/GitHub · **从本地安装** · 远端目录 · 本地清单）',
    ok: (v) => v === 4,
    show: (v, f) => `${v} 个：${JSON.stringify(f['skills.tabTexts'] ?? null)}`,
  },
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
    // ★ 2026-10（D73/D75）：「沉淀」加在最后——那是技能**自己长出来**的资产，
    //   排在"装/配/用"那一串之后（先把工具与技能用起来，才谈得上沉淀）。
    //   ⚠️ 这一条是**滞后了**的：原来写六项，加了一项之后一直红。数字型断言最容易
    //   这样——它不是"界面坏了"，而是"我们长了一项但没回来改判据"。改的时候把
    //   **为什么是这一项、为什么排这儿**写进注释，下次加项才找得到该改哪儿。
    label: '★ 侧边栏是**七项**（聊天最轻、排第一；D58 把「新建任务」并进「任务」、'
      + 'D70 加了「智能体组」、D75 加了「沉淀」）',
    ok: (v) => v === 7,
    show: (v) => `${v} 项`,
  },
  {
    view: '工具（D40）',
    key: 'shell.navLastItem',
    label: '★ 最后一项现在是「沉淀」（「工具」在它前面：先有工具与技能，才谈得上沉淀）',
    ok: (v) => v === '沉淀',
    show: (v, f) => `${JSON.stringify(v)}　完整一串：${JSON.stringify(f['shell.navItems'] ?? null)}`,
  },
  {
    view: '工具（D40）',
    key: 'shell.navItems',
    label:
      '★★ 侧边栏**整串顺序**就是这七项（顺序错、中间少/换一项、多出一项都会红——'
      + '只数个数＋看末项会漏掉中间那几种）',
    ok: (v) =>
      JSON.stringify(v) ===
      // ★ 聊天排在最前：它是最轻的入口（先聊清楚），而且它要管多个对话，
      //   本身就是一个完整页面。
      // ★ 2026-10（D58）：「新建任务」不再是侧栏一项——它并进了「任务」，
      //   建任务变成那一页右上角的主操作（下面那条 `tasks.createAction*` 钉它）。
      // ★ 2026-10（D70）：「智能体组」插在「智能体」后面——组是"队"，
      //   紧跟在"人"后面读起来才顺（`Sidebar.svelte` 的 `ITEMS` 是唯一出处）。
      // ★ 2026-10（D75）：「沉淀」排最后（见上面 `navItemCount` 那条的理由）。
      JSON.stringify(['聊天', '任务', '智能体', '智能体组', '技能', '工具', '沉淀']),
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
  // ⚠️ 这里原来有两条："新建表单的「行动权限」里能勾到已装工具的动作" 与
  //    "那个动作旁边带着它的 `summary`"。两者量的都是 `ActionPicker` 里的
  //    `.ap-ck` / `.action-summary`，而那个控件 **2026-10 从 agent 上整个撤掉了**
  //    （动作属于"这条链"，唯一权威是智能体组页的 ③ 行动）⇒ 这里没有宿主了。
  //    ⚠️ 这两件事**必须继续有人看着**（勾不到第三方动作 ⇒ 装了工具也永远用不上），
  //    它们搬到**智能体组页**去量——见 `docs/README.md` 的探针待办；不是取消。

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
  {
    view: '新建表单 / 设置',
    // ⚠️ 原来是"有背景遮罩（点它可关）"——那是**抽屉**的判据。表单搬进正文之后
    //    正确的期望反过来：**不许有遮罩**（底色之后的东西都还在，读屏器也不该被
    //    告知"这里有个模态框"——那会让它把后面的列表当成不可达）。
    key: 'template.formHasBackdrop',
    label: '★★ 没有遮罩（正文里的表单不是浮层：底色之后的东西都还在，读屏器也不该被告知'
      + '"这里有个模态框"）',
    ok: (v) => v === false,
  },
  {
    view: '新建表单 / 设置',
    // ⚠️「贴右边」是**抽屉**的判据；正文里的表单用"不是浮层"来钉（position: static）
    key: 'template.formPosition',
    label: '★★ 表单是**正文**不是浮层（`position: static`）——浮层会遮住列表、'
      + '还会跟着视口滚，与编辑态的表现分叉',
    ok: (v) => v === 'static',
    show: (v) => `position: ${JSON.stringify(v)}`,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formFillsPane',
    label: '★ 表单**填满右栏正文**（宽度 ≈ 正文宽度的 90% 以上；不是某个固定抽屉宽度）——'
      + '与编辑态同一个宽度，扫一眼就知道"这是同一块地方"',
    ok: (v) => typeof v === 'number' && v >= 0.9,
    show: (v, f) => `${typeof v === 'number' ? v.toFixed(2) : String(v)} × 正文　（${f['template.formWidthPx']}px）`,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formInsidePane',
    label: '★★★ 新建表单就在**右栏正文那一块**（与编辑态同一个容器）——搬过一次家，'
      + '"新建住在哪"这条要钉住，否则哪天又飘回抽屉里而没人发现',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.chromeStaysPut',
    // ⚠️ 原来是"打开**抽屉**前后主区每一块都没动"（抽屉是浮层，所以那条成立）。
    //    表单搬进正文之后，"每一块都没动"不再成立（右栏本来就要从空变成表单）——
    //    但那次事故（表单被渲染进**栏头**，栏头 167px → 1070px、整垮主从布局）真正
    //    坏掉的是顶栏与侧边栏。所以判据收窄到那两块：**它们一格都不许动**。
    label: '★★★ 开表单不会动**顶栏与侧边栏**（2026-09 那次事故就是把表单渲染进栏头，'
      + '栏头从 167px 被撑到 1070px、整垮主从布局）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'template.detailHeadHeight',
    label: '★ 右栏**栏头**没有被表单撑开（有栏头时量到 < 200px；这一页的右栏本来就没有栏头'
      + '——页名在顶栏一字不差——那时如实记 null 并算通过，不假装量到一个 0）',
    ok: (v) => v === null || (typeof v === 'number' && v < 200),
    show: (v) => (v === null ? '这一页右栏没有栏头（如实记 null）' : `${v}px`),
  },
  {
    view: '新建表单 / 设置',
    key: 'template.formOverflowX',
    label: '表单内部没有横向溢出',
    ok: (v) => v === 0,
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
    label: '★★ 点「取消」能关掉它（正文里的表单没有 Esc 那一层，出口是它自己的「取消」）',
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
  {
    view: '新建表单 / 设置',
    key: 'settings.defaultRuntimePresent',
    label:
      '★★ 设置抽屉里有「全局 runtime 默认值」那一段（§9/D81 第 ⑤ 条：只能改接口 = 这条决定在界面上没有落点）',
    ok: (v) => v === true,
  },
  {
    view: '新建表单 / 设置',
    key: 'settings.defaultRuntimeFirstIsAuto',
    label:
      '★★★ 它的第一项是**「自动侦测」**且值为**空串**（空串 = 跟随启动时侦测到的那个——这条语义只有界面上说出来才算落地）',
    ok: (v) => v === true,
  },
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
    // ══════════════════════════════════════════════════════════════════
  // 智能体详情的判断依据（2026-10 对齐：只有一张可编辑卡片）
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 这一族原来钉的是**查看态**：只读那一行里的正文、`.std-name-badge`、
  //    点「编辑」进编辑态、只读 chips 逐字等于接口的 `allowedActions`、
  //    "在详情里勾一个动作再保存真的写进去"……**那一整套随查看态一起删了**
  //    （`AgentDetail.svelte` 开头写着"使用者拍板：没有预览页了"），而
  //    agent 上的行动权限也整个搬去了**智能体组页的 ③ 行动**。
  //    ⇒ 这里删掉的条目不是"放宽"，是**那件事已经没有宿主**：
  //      · "勾一个动作 → 保存 → 接口上真的变了" → 搬去组页（下一批补，那里才是宿主）
  //      · "编辑态/只读态两态" → 概念不存在了
  //    留下的判据全部改量**单态卡片**（`.card.agent-card` 的 `.cell-label`）。
  {
    view: '审核标准',
    key: 'standard.detailHasNoNameBadge',
    label: '★ 审核者详情里**没有**"标准的名字"徽标（那个字段已删）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.detailShowsBody',
    label: '★★ 判断依据写在「指令」那一格里，而且**就在能改的地方**（从只看改为可编辑：它现在是唯一的出处）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.noStandardRowLabel',
    label: '★★ 卡片里**没有任何一格**叫「审核标准」（使用者的要求：「移除审核智能体的『审核标准』」）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.noStandardSectionTitle',
    label: '★★ 也没有「用什么标准」那个小标题（删的是整段，不是把标签换个说法）',
    ok: (v) => v === true,
    show: (v, f) => `${v}　实测各格标题：${JSON.stringify(f['standard.detailCellLabels'] ?? null)}`,
  },
  {
    view: '审核标准',
    key: 'standard.skillsSectionStillThere',
    label: '★ 「技能」那一格还在（删的是"标准"，不是"挂载"——skill 的勾选一条都没少）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.detailHasActionsCell',
    label: '★★ 审核者卡片里**有**「行动权限…」那一格（动作权限这件事仍然要在界面上有个去处，哪怕只是一句指路）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.detailActionsCellTitle',
    label: '★★ 那一格的小标题自己说了**由谁决定**（「行动权限：由智能体组决定」）——只写"行动权限"会让人以为就在这儿配',
    ok: (v) => typeof v === 'string' && v.includes('智能体组'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '审核标准',
    key: 'standard.actionsPointerOnly',
    label: '★★★ 那一格里**只有一句话、一个可操作控件都没有**（不复用 `ActionPicker`：两处长得一模一样、只有一处生效，是最坏的一种界面）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.actionsPointerText',
    label: '★★★ 那句话给出了**可照做的下一步**（说清"动作属于这条链"、"去智能体组页的 ③ 行动里勾"）',
    ok: (v) => typeof v === 'string' && v.includes('智能体组') && v.includes('行动'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '审核标准',
    key: 'standard.actionsHintAbsentWhenSet',
    label: '★ 那一格**不**说"动作也来自这些技能"（那是给另一种情形解释出处的句子，混进来就是假话）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.executorHasNoActionsSection',
    label: '★★ 执行者的卡片里**没有**「行动权限」那一格（它的能力是工具，不给一个必然失败的勾选）',
    ok: (v) => v === true,
    show: (v, f) => `实测各格：${JSON.stringify(f['standard.executorSectionHeadings'] ?? null)}`,
  },
  {
    view: '审核标准',
    key: 'standard.formActionsAbsentForExecutor',
    label: '★ 新建表单里执行者那一档也没有行动权限那一段',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formStandardEditorRemoved',
    label: '★ 新建表单里没有「审核标准」编辑器（依据写在「指令」里）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formHasMergedHint',
    label: '★★ 而给了那句话（"判断依据写在上面那条「指令」里"）——删掉一栏必须留下它的去处',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formMentionsNoSkillNeeded',
    label: '★★ 那句话说的是**「指令」**（不是"上面那条审核标准"——那个字段界面上已经没有了）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formActionsPointerOnly',
    label: '★★★ 新建表单里「行动权限」那一段也**只剩一句话**：没有 `ActionPicker`、没有勾选框、没有按钮（两处各画一个只有一处生效的选择器是最坏的界面）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.formHasNoPickerAnywhere',
    label: '★★ 整张新建表单里**一个 `ActionPicker` 都没有**（不是"挪到别处去了"——是这类控件不该在 agent 上）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.emptyReviewerFixtureFound',
    label: '夹具：那个"没写指令"的审核者卡片在（没它的话下面的缺口记录会空过）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.emptyReviewerSwitched',
    label: '★ 右栏真的换成了它（否则量到的是上一个人）',
    ok: (v) => v === true,
  },
  {
    view: '审核标准',
    key: 'standard.noCriteriaExplanationAnywhere',
    label: '⚠️ **事实（当前是个真缺口）**：没写「指令」的审核者，界面上**一句解释都没有**了——'
      + '那句"它审不了任何东西…"原来住在被删掉的查看态上，'
      + '`agents.headlineNoInstructions` 现在全仓库没有任何代码引用（死词条）。'
      + '这条只如实记下现状，供报告点名；要修就是加回一句提示（那时这条会红，提醒同步）。',
    ok: (v) => typeof v === 'boolean',
    show: (v) => (v === true ? '现在：没有任何解释（缺口）' : '现在：有解释'),
  },

  // ══════════════════════════════════════════════════════════════════
  // 老形态依据（来自挂载的 skill）：现在还有没有出路
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 使用者当年的处境：删不掉 `general-review`，因为审核者还挂着它、依据正来自它。
  //    当时的出路是**只读态里那颗「并进」按钮**（正文并进「指令」+ 同时摘挂载）。
  //    查看态删掉之后那颗按钮也没有了 ⇒ 这一族从"按钮点了会发生什么"改成：
  //    ① 依据有没有丢（服务端不变量）；② 界面上还剩什么出路（挂载可以在卡片里取消）
  //    + 一条**缺口事实**（老形态的提示与按钮都没了、词条成了死词条）。
  {
    view: '迁移（D38）',
    key: 'migrate.legacyFixtureFound',
    label: '夹具：那个"依据来自挂载 skill"的审核者卡片在（没它的话这一族全空过）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.legacyAgentFound',
    label: '夹具：接口上也读得到它（下面的挂载判据以接口为准，不扫页面文字）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.skillCellShowsMount',
    label: '★★ 「技能」那一格里**看得见那个挂载**（`general-review`）——它是拆掉这条老依据的唯一入口，看不见就等于拆不掉',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.skillCellMountUncheckable',
    label: '★★ 那个挂载的勾选框是**勾着的**（使用者能自己取消它——手工把正文抄进「指令」再取消，是现在唯一剩下的路）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.noFalseAdoptClaim',
    label: '★★★ 界面上**不许出现**指向不存在按钮的话（原句"下面那颗按钮"——按钮随查看态删掉了，这句话现在只会在词条表里，一旦有人把它渲染出来就是骗人）',
    ok: (v) => v === true,
  },
  {
    view: '迁移（D38）',
    key: 'migrate.skillSourcedNoticeOrButtonGone',
    label: '⚠️ **事实（当前是个真缺口）**：老形态（依据来自挂载 skill）那一句提示**与**那颗「并进」按钮都没有了——'
      + '`agents.standardLegacyNoticeFromSkill` 这句词条已无人引用。'
      + '后果：这种 agent 的判断依据与挂载绑在一起，而界面既不说明也不给一键拆开（只剩"自己抄 + 取消勾选"）。'
      + '这条只记录现状，供报告点名。',
    ok: (v) => typeof v === 'boolean',
    show: (v) => (v === true ? '现在：提示与按钮都没了（缺口）' : '现在：还在'),
  },

  // ══════════════════════════════════════════════════════════════════
  // 保存一次就把"老的信息"清掉（2026-09）
  // ══════════════════════════════════════════════════════════════════
  //
  // 判据仍然是**两半**（只量"提示没了"会把"顺手丢掉一段判断依据"判成绿）：
  // ① 老字段真的清掉了；② 投递出去的那段文字**逐字节相同**。
  // ⚠️ 动作变了：原来要"进编辑态 → 保存"，现在只有一张卡片（选中即编辑），
  //    所以是"改个别的字段 → 保存"，等的是**那句老提示消失**（不是"退出编辑态"）。
  {
    view: '老信息清理（保存时）',
    key: 'fold.fixtureFound',
    label: '夹具：那个"内联老标准"的审核者卡片在（没它的话这一族全空过）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.detailSwitched',
    label: '★ 右栏真的换成了它（判据是卡片里名字框的值，不是"详情在不在"——后者立刻成立会量错人）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.noticeBefore',
    label: '前提：保存**之前**那条"还带着老的字段"的提示确实在（不然"它消失了"没法量）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.editHintWarns',
    label: '★★ 那句提示**提前说清**保存会发生什么（"我的指令怎么多了一段"不该是一次没预告的改动）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.saveButtonFound',
    label: '★ 卡片底部有「保存」（单态卡片里它就是唯一的写入口）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.noticeCleared',
    label: '★★ 保存之后那条老提示**消失了**（使用者要的正是这一条：重新编辑保存后旧资讯就该没了）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.reviewStandardAfter',
    label: '★★★ 老字段真的清掉了（问接口：`reviewStandard` 是 `null`；界面「no-agent」= 接口根本没读到，那也不算通过）',
    ok: (v) => v === null,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.instructionsGotBody',
    label: '★★★ 老标准的正文**进了「指令」**（不是被删掉）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.identityUnchanged',
    label: '★★★ 而**投递出去的那段文字逐字节相同**（前后各自按 `[指令, 老标准]` 拼一遍比）——"顺手清理"不许变成"顺手丢一段判断依据"',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.noticeAfter',
    label: '★ 界面上那条老提示也没了（不是只把库改了）',
    ok: (v) => v === false,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.editorShowsMerged',
    label: '★★★ 保存之后卡片里「指令」那一格**就是服务端那份**（并进来的正文看得见）——'
      + '★ 这条曾经是红的（真缺陷）：服务端把老正文并进 `instructions`，而组件的草稿只在"换了人"时作废，'
      + '于是界面看不见刚并进来的正文。修法是 `AgentDetail.save()` 收下返回值里被服务端改过的字段；'
      + '⚠️ 基准值必须在 `await` **之前**取（`updateAgent` 内部会 `loadAgents()`，await 之后 `agent` 已经是服务端那份，'
      + '自己跟自己比永远相等——第一版就是这么坏的）。',
    ok: (v) => v === true,
    show: (v, f) => `${v}　实测指令框开头：${JSON.stringify(f['fold.editorTextAfterSave'] ?? null)}`,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.editorVsApiSamples',
    label: '★★★ 保存之后连续的几次取样里，界面那一格与**接口那份逐字相同**（不是"最终会一致"——'
      + '使用者可能立刻就在那一格里继续打字，差一瞬就等于把服务端刚并进来的正文覆盖掉）',
    ok: (v) =>
      Array.isArray(v) && v.length > 0 && v.every((x) => (x?.editor ?? '') === (x?.api ?? '')),
    show: (v) =>
      Array.isArray(v)
        ? v.map((x) => `#${x.t} 界面${(x.editor ?? '').length}字/接口${(x.api ?? '').length}字`).join(' · ')
        : String(v),
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.editAfterSaveLanded',
    label: '★ 前提：保存之后那次改动真的落库了（等的是接口里那段文字，不是输入框里的字）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.editAfterSaveKeepsCriteria',
    label: '★★★ 保存之后再改「指令」并保存一次 ⇒ 投递出去的那段文字里**判断依据还在**'
      + '（在 `instructions` 里还是在老字段里是"住在哪"的问题，住哪儿都不许丢——`identityFrom` 存在的理由）',
    ok: (v) => v === true,
  },
  {
    view: '老信息清理（保存时）',
    key: 'fold.editAfterSaveResurrectsLegacy',
    label: '★★★ 那一轮保存**不许**把刚清掉的老字段写回来（`reviewStandard` 必须还是 `null`）——'
      + '★ 这条曾经是红的（真缺陷）：草稿里那个老对象被 `buildPatch()` 判成"变了"、整份 PATCH 回去，'
      + '界面上那条老提示重新出现、库里刚清理掉的形状被界面自动撤销（同 `fold.editorShowsMerged` 的病根）。',
    ok: (v) => v === false,
    show: (v, f) => `${v}　老字段：${JSON.stringify(f['fold.instructionsAfterEdit'] ?? null)?.slice(0, 40)}`,
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
  // ⚠️ 这里原来是"详情里那串契约值 `probe-tool.append-note` 切英文时不翻译"。
  //    它量的是审核者详情里的动作 chip，而**那一栏已经不在 agent 上了**
  //    （动作权限搬到智能体组页）⇒ 在 agent 详情上写这条就是空过。
  //    同一件事（契约值原样显示、不翻译）搬到**智能体组页的选择器**上去量。
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
  // ══════════════════════════════════════════════════════════════════
  // 智能体组页 ③ 行动：D41 那一族的**新宿主**（动作权限 2026-10 从 agent 搬到组）
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 这一段是**新增的覆盖**，不是把旧断言改个选择器：宿主换了，"谁持有这份权限"
  //    也跟着换（组的 `allowedActions`）。旧的（agent 详情/表单上那些）在同一批里
  //    按"宿主不在了"处理——见下面 `行动权限空态（D41）` 那一段开头的说明。
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.chainGroupRowFound',
    label: '前提：三步链那个组在列表里（它身上配着一条权限、还钉了固定参数）',
    ok: (v) => v === true,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.checkedEqualsServerAllowed',
    label: '★★★ 组页 ③ 行动里**勾着的那些**逐条等于**接口上这个组的 `allowedActions`**'
      + '（不是"我期待那一个名字"：界面上显示的与库里那份必须是同一件事）',
    ok: (v) => v === true,
    show: (v, f) =>
      `${v}　界面：${JSON.stringify(f['groups.checkedBoxes'] ?? null)} / 接口：${JSON.stringify(f['groups.serverAllowedActions'] ?? null)}`,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadFixtureFound',
    label: '夹具：「配过、但包已卸载」那个组在（它的 `allowedActions` 里有一条已经没有出处的动作；'
      + '⚠️ 只能"先配上、再卸包"造出来——写入口拒收来自没装的包的动作）',
    ok: (v) => v === true,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.detailShown',
    label: '★ 点那一行之后组的详情真的出来了（`picker-wrap`）——不然下面量到的是上一个组',
    ok: (v) => v === true,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.pickerShown',
    label: '★★ ③ 行动里就是那个共用选择器（组页与智能体页同一套判据：动作只能来自已装的包）',
    ok: (v) => v === true,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.emptyStateInNormalCase',
    label: '★ 装了包、也有可勾的动作时**不是**空态（空态那一档由下面单独造，两档不能混成一个）',
    ok: (v) => v === false,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadGroupShown',
    label: '★★★ 「配过、但解析不出来」那一组**出现在组页上**（同一条欠债在 agent 上已经无处安放）',
    ok: (v) => v === true,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadTypes',
    label: '★★★ 那一组里就是那条**没有出处的契约值**（按 `data-type` 逐字比：'
      + '不静默过滤掉——"配过"这件事不能抹，也不能换成别的名字）',
    ok: (v) => Array.isArray(v) && v.includes('probe-tool-ui.ping'),
    show: (v) => (Array.isArray(v) ? v.join(' | ') || '(空)' : String(v)),
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadRowContractValue',
    label: '★★ 那一行的契约值**原样显示**（`<包 slug>.<动作名>`，不翻译、不概括）',
    ok: (v) => v === 'probe-tool-ui.ping',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadRowMarked',
    label: '★★★ 旁边明说它**当前不可用**（不能与一条真的能触发的动作长得一模一样——'
      + '否则使用者以为它还在生效）',
    ok: (v) => typeof v === 'string' && v.includes('不可用'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadRowDropButton',
    label: '★★★ 那一行有「移除」（否则一保存就被服务端 400 拒，而错误里点名的动作在界面上不存在——死胡同）',
    ok: (v) => v === true,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadHint',
    label: '★★ 那一组下面说清了**为什么**（找不到出处）与**下一步**（点「移除」；'
      + '只是包被卸了的话也可以先去「工具」页把包装回来）',
    ok: (v) => typeof v === 'string' && v.includes('移除') && v.includes('工具'),
    show: (v) => JSON.stringify(String(v ?? '').slice(0, 80)),
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.pickerBoxAllContractValues',
    label: '★★★ 选择器里**每一个**勾选项都是契约值形状（`<包 slug>.<动作名>`）——'
      + 'D41 把内置动作整组移除之后，裸名不许再出现在这一栏里',
    ok: (v) => v === true,
    show: (v, f) => `${v}　实测：${JSON.stringify(f['groups.pickerBoxValues'] ?? null)}`,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.pickerBoxCount',
    label: '★★ 框的条数 = 已装工具声明的**动作总数**（不是"这个组已有的那几条"——'
      + '写成只画已配的那几条就只能减不能加）',
    ok: (v, f) => typeof v === 'number' && v === f['groups.installedActionTotal'],
    show: (v, f) =>
      `${v} 个框 / 已装工具共 ${f['groups.installedActionTotal']} 个动作`,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.deadDroppedOnServer',
    label: '★★★ 点「移除」→ 保存 ⇒ **接口上**那条权限真的没了（不是个死胡同：'
      + '界面干净了、库里还留着，下次打开又出现）',
    ok: (v) => v === true,
    show: (v, f) => `${v}　移除后：${JSON.stringify(f['groups.allowedAfterDrop'] ?? null)}`,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.emptyStateShown',
    label: '★★★ 一个工具包都没装 ⇒ 组页这一栏也走**空态**（说清"为什么没有"，不是画一条空的清单）',
    ok: (v) => v === true,
    show: (v, f) => `${v}　实测：「${String(f['groups.emptyStateText'] ?? '').slice(0, 60)}」`,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.emptyStateNoCheckbox',
    label: '★★★ 空态里**一个复选框都没有**（没有可勾的东西就别画勾选框）',
    ok: (v) => v === true,
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.emptyStateGoButton',
    label: '★★★ 空态**指向「工具」页**（一个可点的去处，不是一句干话）',
    ok: (v) => typeof v === 'string' && v.includes('工具'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '组页 ③ 行动（D41）',
    key: 'groups.emptyStateLinkNavigates',
    label: '★★★ 而且那个去处**真的通**：点一下落到「工具」页（画一个点不动的按钮是最坏的一种）',
    ok: (v) => v === true,
  },

  {
    view: '工具页空态（D41）',
    key: 'noTools.refusals',
    label: '★ 摘挂与卸载都没被拒（被拒的话下面的空态根本没造出来）',
    ok: (v) => v === 0,
  },
  {
    view: '工具页空态（D41）',
    key: 'noTools.refreshButtonFound',
    label: '「工具」页有那个刷新按钮（探针靠它让界面的 `$tools` 真的空掉）',
    ok: (v) => v === true,
  },
  {
    view: '工具页空态（D41）',
    key: 'noTools.viewEmptyState',
    label: '工具页自己显示的是空态（列表确实空了）',
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
    view: '新建任务 · 链',
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
    view: '新建任务 · 链',
    key: 'newtask.executorSelectApplied',
    label: '① 前提：真的把下拉选成了**夹具那个执行者**（不是列表里的第一个）——'
      + '②③ 那几条都以它为基准，选错人时它们量的是别人的配置',
    ok: (v) => v === true,
    show: (v, f) => `${v}　夹具执行者：${String(f['newtask.fixtureExecutorId'] ?? '').slice(-6)}`
  },
  // ══════════════════════════════════════════════════════════════════
  // ★ 版面：三步排成一行 + 首屏看得见三个问题
  // ══════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════
  // ★「要做什么」：两个字段合并成一个多行框
  // ══════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════
  // ★ ③ 行动：从"铺一整段选择器"改成"一个按钮 + 居中对话框"
  // ══════════════════════════════════════════════════════════════════
  // ── ★ 改写之一：`newtask.actionChips`（③ 只读 ⇒ 契约值画在 `.chip` 里）──
  //
  // 为什么原来那条不再成立：③ 从**只读**改成了**可勾**（智能体页「行动权限」那个
  // 形状）。可勾那一档的契约值画在**勾选框旁边**（`label.action-option > code`），
  // 不再有 `.chip` 可选那一档的判据必须整个换口径：从"有一段只读文字里出现了
  // 契约值"变成"**框里那个动作**就是它、而且框旁边逐字写着它的 `summary`"。
  // ⚠️ 它**不是被放松**：原来只要求"字符串在页面上出现过"，现在要求"框的
  //    `value` / 旁边的 `code` / 旁边的 `summary` 三样都对上接口里那一份"。

  // ── ★ 新不变量：那句「只对这一次任务生效」**只在改过之后**出现 ──
  //
  // 默认状态（一下都没碰过）出现它 = 对使用者说"你改了它的长期权限"——假话；
  // 动一下（取消一个勾）不出现它 = 他这一次的收紧会被当成长期安排。

  // ── ★ 档三：工具清单没到 ⇒ **一个勾选框都不画** ──
  //
  // 现场是"让 `/api/tools` 真的失败"再造出来的（`$tools` 那一刻还留着上一次取到的
  // 清单 ⇒ 与"一个包都没装"长得一样，而这一栏必须说"说不准"）。

  // ── ★ 档四：这个 daemon **兑现不了这一栏的覆盖** ⇒ 退回只读（画 chip）──
  //
  // 现场是把 `/api/identity` 的 `capabilities` 里 `task-action-whitelist` **只去掉
  // 这一个**（`reviewer-override` 留着）：这正是"只重建了一半"的中间态，也是
  // 那两个标志**必须分开**的理由。

  // ── D45：返工次数（界面 ↔ 请求体 ↔ 落库）──

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
      '★★★ 1280 的窗口下右栏只有 624px ⇒ 表单是单列（与上面那条宽窗口的一列配对：'
      + '简化版**不随宽度换列数**）',
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
    // ⚠️ 这一条原来是"宽窗口 ⇒ 回到**两列**"（配上面那条窄窗口单列，一起证"按容器判
    //    而不是按窗口判"）。2026-10 简化版把表单做成**一列到底**了
    //    （`NewTaskForm.svelte` 里的注释写明了：不再需要两列网格 / `@container`），
    //    所以"两列"这个期望已经没有宿主。留着它只会让人以为"宽窗口该并排"。
    //    现在的判据：**任何宽度都是一列**——两条一起钉住这个决定本身。
    label:
      '★★★ 窗口画宽到 1600（右栏约 943px）表单**仍然是一列**——2026-10 简化版明确决定'
      + '"一列到底"（`NewTaskForm.svelte`：不再需要两列网格 / `@container`）。'
      + '⚠️ 与上面那条窄窗口的一列配对：它钉的是"不再随宽度换列数"这个决定',
    ok: (v) => v === 1,
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
    key: 'crystal.reviewTabTexts',
    label: '★★★ 审阅屏是**三个 tab**：草稿 / 依据 / 过程（2026-10-21 第 3 批决定的信息分层）',
    ok: (v) =>
      Array.isArray(v) && JSON.stringify(v.slice(0, 3)) === JSON.stringify(['草稿', '依据', '过程']),
    show: (v, f) => `${JSON.stringify(v)}　默认停在 ${JSON.stringify(f['crystal.reviewTabDefault'])}`,
  },
  {
    view: '沉淀',
    key: 'crystal.defaultTabIsDraft',
    label: '★★★ 默认停在**草稿**、而且编辑器当场可用（这一屏要动手的就是它，不该先点一下）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.tabStripBox',
    label: '★★ tab 条只占**一行**（高 ≤ 40px）：它是导航，不该再吃掉半个首屏',
    ok: (v) => v !== null && typeof v === 'object' && v.h <= 40,
    show: (v) => (v ? `${Math.round(v.w)}×${Math.round(v.h)}` : 'null'),
  },
  {
    view: '沉淀',
    key: 'crystal.belowPaneBlocks',
    label:
      '★★★ 主区下面**不再有任何参照信息**（改前：素材折在 y≈842、起草 run 在 y≈1002——纪律"参照信息不抢要动手的位置"没变，实现从"摞在下面"改成"切过去看"）',
    ok: (v) => Array.isArray(v) && v.length === 0,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.evidenceOpens',
    label: '★★ 「依据」tab 里看得到起草者读过的素材（清单真的列出来）',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify(f['crystal.evidenceRows']),
  },
  {
    view: '沉淀',
    key: 'crystal.evidencePreviewLen',
    label: '★★ 素材正文真的渲染出来（只列文件名不叫"依据"）',
    ok: (v) => typeof v === 'number' && v > 0,
    show: (v) => `${v} 字`,
  },
  {
    view: '沉淀',
    key: 'crystal.evidenceNoFold',
    label: '★ 依据 tab 里**没有**折叠段了：搬进 tab 之后再折一层等于多一次点击',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.evidenceInFirstScreen',
    label: '★★ 依据那一屏**整个**落在首屏里（改前素材折在 y≈842，展开后还要在下面滚）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.evidencePaneCols',
    label: '★ 依据 tab 也是**真并排**两列（清单 + 正文），与审阅主区同一套观感',
    ok: (v) => typeof v === 'string' && v.split(' ').filter(Boolean).length >= 2,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.processOpens',
    label: '★★ 「过程」tab 打得开（审核日志与起草 run 都住在这里）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.previewFoldGone',
    label: '★★ 审阅屏**没有**「预览」折叠段了（2026-10-21 使用者："不需要「预览」"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.previewElementGone',
    label:
      '★★ 页面上也没有 `.preview` 元素（与上一条一起判：只判折叠段的话，把预览换个名字/搬个位置照样过）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.processSubTabs',
    label:
      '★★★ 「过程」那一格是**两个子 tab**：「草稿过程」/「审核过程」（使用者："过程分成草稿过程和审核过程，分 2 tab 页显示"——原来三块竖着摞在同一个 pane 里）',
    ok: (v) => Array.isArray(v) && v[0] === '草稿过程' && v[1] === '审核过程',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.processDefaultTab',
    label:
      '★★ 没审过的草稿默认停在**「草稿过程」**（停在审核过程的话那一格只有一句"还没审过"，唯一的实时信息被藏起来）',
    ok: (v) => v === '草稿过程',
  },
  {
    view: '沉淀',
    key: 'crystal.processDraftHasRunBlock',
    label: '★ 「草稿过程」里有「起草 run」那一块（它才是起草过程的内容）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.processAuditPaneHasNoDraftBlock',
    label:
      '★★★ ★ 切到「审核过程」之后，页面上**没有**「起草 run」那一块——这条才是"真劈开了"：只量"两个 tab 存在"的话，把三块摞在同一个 pane 里照样过',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.draftSectionFound',
    label:
      '夹具：切到「过程」tab 后找得到「起草 run」那一块（下面四条量的是它的两态；第 3 批把它从主区下方搬进了这里）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.draftFinalText',
    label:
      '★★★ 「起草 run」默认显示**最后结果**（那条 run 的最后一段正文）——改之前展开全是原始流水，人得自己在里面找最后那段话',
    ok: (v) => typeof v === 'string' && v.includes('探针夹具的最后结果'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.draftLogAfterToggle',
    label: '★★★ 点按钮之后**换成完整日志**（与任务页「最后结果 / 完整日志」同一个交互：同一块位置换内容）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.draftBackToFinal',
    label: '★ 再点一次能切回最后结果（两态都要走得通，不能单程）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditAutoSwitchedToProcess',
    label:
      '★★★ 点「开始审核」界面**自动切到「过程」**——日志住在那个 tab 里，不切过去就等于"点了没反应"（第 ① 条"审核的过程看不到"就靠这一下守住）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditFailFindingsTab',
    label:
      '★★ 结论条上的「看 N 条问题」**切到「过程」并且真的列出问题**（第 3 批把它从"展开折叠"改成"切 tab"——切不过去就是个摆设）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditLiveStartButton',
    label:
      '夹具：审阅屏上有「开始审核」——下面几条要**点它**，让 daemon 真的 spawn 一条审核 run（假 `agent-cli`，不花额度）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditLiveSubTab',
    label:
      '★★★ 点「开始审核」之后**子 tab 也切到「审核过程」**——只切外层的话人落回"草稿过程"，审核输出一个字都看不到（第 ③ 批那条"感觉一直没结束"就是这样复发的）',
    ok: (v) => v === '审核过程',
    show: (v, f) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.loopState',
    label:
      '★★★ 有判决的草稿上要挂着「循环状态」（running/passed/exhausted/stopped）——使用者原话「看不出来是否已经结束了」，这一格就是他看的那一眼',
    ok: (v) => ['running', 'passed', 'exhausted', 'stopped', 'idle'].includes(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditLiveLogBox',
    label:
      '★★★ 审核**真跑起来**的时候，实时输出就铺在面板里（使用者："审核的过程看不到，感觉一直没结束呢"——原来只有一句"审核中…跑完再看这里"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditLiveLogText',
    label: '★★★ 而且那日志**真有内容**（不是铺了个空的框就算过——假 CLI 吐的那句话必须在里面）',
    ok: (v) => typeof v === 'string' && v.includes('正在跑'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditLiveBadge',
    label: '★★ 跑着的时候有 run **状态徽标**（"它到底在跑还是在等"要一眼看得出来）',
    ok: (v) => v === '运行中',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditLiveCancelButton',
    label: '★★ 跑着的时候给得出「取消审核」（"感觉一直没结束"的另一半：得有一条退出路）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditAfterCancelStillRunning',
    label:
      '★★★ 点了「取消审核」之后**不许**还在说"审核正在进行"（这条量的是真的取消：run 落到终态、界面跟着改口）',
    ok: (v) => v === false,
    show: (v) => String(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditAfterCancelRetry',
    label: '★★ 取消之后给得出「重新审核」（取消了就是没审成，得能再来一次）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditDeadEntered',
    label: '夹具：审核"没跑成"那条草稿挂得上（patch 前它永远显示"审核中"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditDeadSaysRunning',
    label:
      '★★★ 审核 run **失败**时**不许**再说"审核正在进行 / 跑完再看这里"（这就是使用者"感觉一直没结束"的根因：判据只看"有没有判决"）',
    ok: (v) => v === false,
    show: (v) => String(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditDeadText',
    label: '★★★ 它要**明说没跑成**并给「重新审核」（失败必须说出来，而不是让人继续等）',
    ok: (v) => typeof v === 'string' && v.includes('审核没跑成') && v.includes('重新审核'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.stepLabels',
    label:
      '★★ 步骤条是**三步**（目标 → 起草 run → 审阅入库）——审核**不是**一步，它是审阅屏里的一个动作',
    // ⚠️ 只量"文本里有审核"是不够的：那样"审核被画成第 4 步"也照样通过。反过来，
    //    只量"没有审核"也不够：顺序错了（比如入库排到起草之前）是另一种坏法。
    //    所以两条一起量：**恰好这三步、顺序一致**（`crystal.stepAuditNotAStep` 再钉住"审核不占一格"）。
    ok: (v) =>
      Array.isArray(v) && v.length === 3 && v[0] === '沉淀目标' && v[1] === '起草 run' && v[2] === '审阅入库',
    show: (v) => (Array.isArray(v) ? v.join(' → ') : String(v)),
  },
  {
    view: '沉淀',
    key: 'crystal.stepAuditNotAStep',
    label:
      '★★ 步骤条里**没有**「审核」这一格（2026-10-21 确认：它不是入库的门，画成一步会让人以为必须等它）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.statsHits',
    label:
      '★ 同一份「…次工具调用」在一屏里只出现**一次**（原来副标题一次、素材摘要分节又一次：同一句话写两遍）',
    ok: (v) => v === 1,
    show: (v) => `${v} 次`,
  },
  {
    view: '沉淀',
    key: 'crystal.conclusionBarCount',
    label:
      '★★★ 审阅态只有**一条**结论条（原来三条横条竖着摞：审核块 + 草稿校验条 + frontmatter 摘要，实测共 ~240px）',
    ok: (v) => v === 1,
    show: (v) => `${v} 条`,
  },
  {
    view: '沉淀',
    key: 'crystal.legacyBarsGone',
    label: '★★ 两条老横条的结构都不在了（`.review-bar-block` / `.audit-block`——留着就是两套并存）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.paneTopY',
    label:
      '★★★ 编辑窗格起点 y ≤ 380（第 2 批把三条横条并成一条之后是 323；第 3 批的 tab 条是**必须占**的一行 32px ⇒ 363。改前：490）',
    ok: (v) => typeof v === 'number' && v <= 380,
    show: (v) => `y=${v}`,
  },
  {
    view: '沉淀',
    key: 'crystal.auditStartButtonBox',
    label:
      '★★「开始审核」按钮**不许折行**：高 ≤ 40（改前实测 69×54——文案在 69px 宽里折成 3 行）',
    ok: (v) => v !== null && typeof v === 'object' && v.h <= 40,
    show: (v) => (v ? `${Math.round(v.w)}×${Math.round(v.h)}` : 'null'),
  },
  {
    view: '沉淀',
    key: 'crystal.barNarrowBox',
    label:
      '★★ 把窗口收窄到 1000px 再量一次：结论条仍是**一条**（高不变）且按钮没有被挤出条外——「开始审核」曾经在 69px 里折成 3 行、高 54px，而那个条件**只在窄的时候出现**',
    ok: (v) => v !== null && typeof v === 'object' && v.h <= 46 && v.buttonsInside === true,
    show: (v) => (v ? `${v.w}×${v.h} 按钮在条内=${v.buttonsInside}` : 'null'),
  },
  {
    view: '沉淀',
    key: 'crystal.auditPresent',
    label: '★★ 审核区块**常驻**在审阅态里（结论与问题清单要有地方落，不能只在有结论时才出现）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditText',
    label:
      '★ 还没审核时条上就四个字「还没审核过」——**不是 ✓ 也不是 ✗**（既没通过也没被否，画对勾是撒谎）',
    ok: (v) => typeof v === 'string' && v.includes('还没审核过') && v.includes('○'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditStartButtonTitle',
    label:
      '★★ 那句"这是预筛、不替你做入库决定"搬进了「开始审核」的悬停提示——**它必须还在**（2026-10-21 把它从 42px 的段落里挪走，是为了让编辑器上移，不是把话删掉）',
    ok: (v) => typeof v === 'string' && v.includes('预筛') && v.includes('入库决定'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditStartButton',
    label: '★ 未审核态给得出「开始审核」这个入口（少了它，这一步只能靠接口触发）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditFailEntered',
    label:
      '夹具：判决 `fail` + 配额用尽那条草稿挂得上（下面四条量的是"审核未通过"那一屏）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.auditFailText',
    label:
      '★★ 未通过时结论条说清三件事：**不通过** + 理由码 + **配额已用尽**（人要知道为什么停在它这儿），并且"按意见改一版"这个出口在',
    ok: (v) =>
      typeof v === 'string' &&
      v.includes('不通过') &&
      v.includes('style_violation') &&
      // ⚠️ 分批第 12 批：这里原来查的是「重新起草」（那个按钮点了**立刻提交**，已撤掉），
      //    中途一度改查「填入审核问题」（我第一版把"填"做成独立按钮，多要了人一次点击，
      //    也被使用者否掉了）。现在的口径是"开框即填好"⇒ 结论条上只需要**一个**出口。
      // ★ 分批第 17 批：按钮改名「反馈」（见 probe.html 同一条的注释）
    v.includes('反馈'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditFailFindingsButton',
    label: '★★ 问题清单**数得出来**（"看 N 条问题"——判决里几条，这里就该是几条）',
    ok: (v) => typeof v === 'string' && /看 3 条问题/.test(v),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.auditFailFindingCount',
    label: '★★ 点开之后**真的列出 3 条**问题（按钮在、点了什么都没有是这类改动最容易出的错）',
    ok: (v) => v === 3,
  },
  {
    view: '沉淀',
    key: 'crystal.auditFailSeverities',
    label: '★ 每条带**严重度**（high/medium/low 原样给出来，不折叠成一个"有问题"）',
    ok: (v) => Array.isArray(v) && v.join(',') === 'high,medium,low',
    show: (v) => (Array.isArray(v) ? v.join(' | ') : String(v)),
  },
  {
    view: '沉淀',
    key: 'crystal.reviseToggleButton',
    label:
      '★★ 停在未通过态时给得出「反馈」（第 ② 条决定的出口；第 17 批改名前叫「按意见再改一版」）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.redraftOldButtonsGone',
    label:
      '★★★ 同一个动作**只有一个入口**：「按意见重新起草」（点了立刻提交）与「填入审核问题」（要人再点一次才填）两个按钮都撤掉了',
    ok: (v) => v === true,
  },
  // ══════════════════════════════════════════════════════════════════
  // ★★★ 审核问题清单**填进意见框**，由人点提交（2026-10-21 分批第 12 批）
  // ══════════════════════════════════════════════════════════════════
  //
  // 使用者原话：「审核不过后，是否可以将"审核问题清单"直接填入"按意见重新起草"的框中，
  // **让用户点反馈**」。改之前那个按钮**填完立刻提交**（人连自己要发出去的话都没看见），
  // 而且只填 `[严重度] 一句话`（位置与原文都丢了）。这一族判据钉住四件事：
  //   ① 点它 ⇒ 意见框出现且**已填**；② 填进去的带位置与原文；③ 光标落在框里；
  //   ④ **没有自己跑起来**（框与提交按钮仍然在，这一屏没切到"起草中"）。
  {
    view: '沉淀',
    key: 'crystal.redraftBoxOpened',
    label:
      '★★★ 点「反馈」⇒ 意见框打开，而且**里面已经有审核者的反馈**（使用者要的形状："一开就有"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.redraftHasReasonCode',
    label: '★ 填进去的话里带**理由码**（起草者要知道"为什么不合格"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.redraftHasLocator',
    label:
      '★★★ 填进去的话里带**位置**（`SKILL.md` 这类）——没有位置，起草者只能猜着改（第 10 批把返工改成"基于上一版改"之后这条更要紧）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.redraftHasExcerpt',
    label: '★★ 填进去的话里带**原文摘录**（行号是软信息，原文才让人找得准）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.redraftFocused',
    label: '★ 光标落在意见框里（让人一眼看到"要发出去的是这些"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.redraftSubmitEnabled',
    label: '★★ 填完「提交反馈」可点（最终决定权在人手里）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.redraftStillEditing',
    label:
      '★★★ 点了「反馈」**没有**自己开始起草：意见框与提交按钮都还在（真跑起来这一屏会切到"起草中"）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.revisePrefilledHint',
    label:
      '★★ 意见框里有一句说清"这段是哪来的"（框里凭空有内容，人得知道它是审核者的反馈）',
    ok: (v) => typeof v === 'string' && v.includes('审核者') && v.includes('反馈'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.reviseKeepsHumanEdit',
    label:
      '★★★ 人改过之后收起再打开，**还是人改的那句**（界面替人改掉一个字，比少填一点严重得多）',
    ok: (v) => v === '我自己写的意见',
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.redraftFilled',
    label: '★ 填进去的是一整份清单（不是一个空框或一句占位）',
    ok: (v) => typeof v === 'string' && v.split('\n').length >= 4,
    show: (v) => JSON.stringify(String(v).split('\n').slice(0, 6)),
  },
  {
    view: '沉淀',
    key: 'crystal.auditFailSaveDisabled',
    label:
      '★★★ 审核不通过**也没有**把「确认入库」灰掉（第 ① 条决定：审核是**预筛**，入库仍由人按——按钮一灰就等于把预筛变成了闸）',
    ok: (v) => v === false,
    show: (v) => String(v),
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
  // ══════════════ 人改草稿（2026-10-21 分批第 8 批）══════════════
  {
    view: '沉淀',
    key: 'crystal.manualBeforeButtons',
    label:
      '★ 刚进审阅屏（没动过编辑器）时**没有**「保存改动」——没有未保存改动就不该挂一个点不动的按钮',
    ok: (v) => Array.isArray(v) && !v.some((b) => b.includes('保存改动')),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.manualStaleBefore',
    label:
      '★ 没改过内容时**没有**「结论已过期」标记（夹具里的指纹就是按当前内容钉的）——只在真改过时出现',
    ok: (v) => v === false,
    show: (v) => String(v),
  },
  {
    view: '沉淀',
    key: 'crystal.manualDirtySaveButton',
    label: '★★ 在编辑器里打字 ⇒ 出现「保存改动」（改动只活在内存里，得有个出口把它落盘）',
    ok: (v) => v === true,
    show: (v) => String(v),
  },
  {
    view: '沉淀',
    key: 'crystal.manualStaleAfterSave',
    label:
      '★★★ 保存之后结论条出现「内容已改 —— 这个结论是改之前的」（使用者原话："缺少一个可以改的地方"；改完不算数等于没得改）',
    ok: (v) => v === true,
    show: (v, f) => `${String(v)}　标记文案 ${JSON.stringify((f['crystal.manualStaleText'] ?? '').slice(0, 30))}`,
  },
  {
    view: '沉淀',
    key: 'crystal.manualRetryAfterSave',
    label: '★★ 出现「重新审核」——原来这个按钮只在**还没判决**时才有，一旦审出结论同一版再也审不了',
    ok: (v) => v === true,
    show: (v) => String(v),
  },
  {
    view: '沉淀',
    key: 'crystal.manualSaveButtonGone',
    label: '★ 保存之后「保存改动」自己收起来（没有未保存改动了）',
    ok: (v) => v === true,
    show: (v) => String(v),
  },
  {
    view: '沉淀',
    key: 'crystal.manualOnDiskHasEdit',
    label:
      '★★★ 保存**真的写到了磁盘**：重读 artifacts（它读的就是草稿小屋的 `skill/`）里能看到那句手写的改动',
    ok: (v) => v === true,
    show: (v) => String(v),
  },
  // ══════════════ 深链语义（2026-10-21 第 7 批：真机上量出来的缺陷）══════════════
  {
    view: '沉淀',
    key: 'crystal.deepLinkSiblingRows',
    label:
      '★★★ 深链 `#/crystallize/<草稿id>` 打开的就是**那一条**草稿（夹具里那条兄妹草稿只有 1 个文件；改前这个 id 被丢掉、一律挂"该来源最新那条"）',
    ok: (v) => Array.isArray(v) && v.length === 1,
    show: (v, f) => `${JSON.stringify(v)}　结论条 ${JSON.stringify((f['crystal.deepLinkSiblingBar'] ?? '').slice(0, 40))}`,
  },
  {
    view: '沉淀',
    key: 'crystal.deepLinkSiblingBar',
    label:
      '★★ 深链打开的那条**判决也是它自己的**（兄妹草稿没审过 ⇒ 结论条说"还没审核过"）——改前显示的是最新那条的判决，真机上"花钱审出来的结论在界面上打不开"就是这么来的',
    ok: (v) => typeof v === 'string' && v.includes('还没审核过'),
    show: (v) => JSON.stringify((v ?? '').slice(0, 60)),
  },
  {
    view: '沉淀',
    key: 'crystal.sourceEntryRows',
    label:
      '★★ 从**来源**进来（URL 给的是来源 run）仍然是"最近那条未入库的草稿"（3 个文件）——与上一条配对：修"深链失效"不许把来源入口也改坏',
    ok: (v) => Array.isArray(v) && v.length === 3,
    show: (v) => JSON.stringify(v),
  },
  // ══════════════ 目标态那一屏（2026-10-21 第 5 批）══════════════
  //
  // 它是这一屏的**入口**，却一直是探针的空白（夹具都挂在"已完成草稿"上）。
  // 这一节钉的是使用者确认过的第 ③ 条决定：目标态**不做 tab**（表单 + 一行素材判据）。
  {
    view: '沉淀',
    key: 'crystal.targetAttached',
    label:
      '夹具：目标态那一屏挂得上（源任务没有草稿 ⇒ 进来就是表单，不用点「继续」）——不成立的话下面一整组都空过',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.targetStepText',
    label: '★★ 目标态停在**第 1 步**（"沉淀目标"是当前步）',
    ok: (v) => typeof v === 'string' && v.includes('沉淀目标'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.targetTabCount',
    label:
      '★★★ 目标态**不做 tab**（2026-10-21 使用者确认的第 ③ 条：这一屏是"填一句话就动手"，tab 反而把唯一的动作藏起来）',
    ok: (v) => v === 0,
    show: (v) => `tab 条 ${v} 个`,
  },
  {
    view: '沉淀',
    key: 'crystal.targetFormRows',
    label: '★★ 目标态那两个目标选项（新建 / 更新）都在表单里',
    ok: (v) => typeof v === 'number' && v === 2,
    show: (v) => `${v} 行`,
  },
  {
    view: '沉淀',
    key: 'crystal.targetMaterialLine',
    label:
      '★★★ 素材判据**就一行**（来源是对话还是任务 / 有没有审核结论）——改前它是一个分节（h3 + 外壳白占 87px），而那行字在副标题里已经写过一遍',
    ok: (v) => typeof v === 'string' && v.length > 0 && !v.includes('\n'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.targetStartButton',
    label: '★★ 「开始沉淀」在，而且悬停就说得清判据（素材为空 / 门槛不过要分开说——第 ① 条"点了没反应"的常见形态）',
    ok: (v) => typeof v === 'string' && v.length > 0,
    show: (v, f) => `${JSON.stringify(v)}　title ${JSON.stringify((f['crystal.targetStartButtonTitle'] ?? '').slice(0, 40))}`,
  },
  {
    view: '沉淀',
    key: 'crystal.targetFoldCount',
    label:
      '★★ 起草**之前**不画素材折叠：那一刻 `material/` 还没落盘（素材是起草请求时写的），画一行"0 个文件"就是一格死 UI',
    ok: (v) => v === 0,
    show: (v, f) => `${v} 个${f['crystal.targetFoldHead'] ? `（${f['crystal.targetFoldHead']}）` : ''}`,
  },
  {
    view: '沉淀',
    key: 'crystal.targetPageFits',
    label: '★★ 目标态不整页滚（表单 + 那一行判据都在首屏里）',
    ok: (v) => v === true,
    show: (v, f) => `文档 ${f['crystal.targetScrollH']}px / 视口 ${f['crystal.viewportH']}px`,
  },
  {
    view: '沉淀',
    key: 'crystal.targetFormInsidePane',
    label: '★★ 表单**没有越过主区右边界**（布局类缺陷只有量得出来：改前新建智能体的表单就横着盖住过右栏）',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify(f['crystal.targetFormBox']),
  },
  // ══════════════ 起草中那一屏（2026-10-21 第 4 批）══════════════
  //
  // 这一屏以前**没有任何判据**（夹具都是已完成草稿），所以下面这几条是新地面的第一批桩：
  // 夹具在 Node 侧真发起一条起草 run（假 `agent-cli`），量的是真 running / 真日志。
  {
    view: '沉淀',
    key: 'crystal.draftingAttached',
    label:
      '夹具：起草中那一屏挂得上（点「继续」接到那条真在跑的起草 run 上）——不成立的话下面一整组都空过',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.draftingStepText',
    label: '★★ 起草中停在**第 2 步**（"起草 run"是当前步；第 1 步已打勾）',
    ok: (v) => typeof v === 'string' && v.includes('起草 run'),
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.draftingTabTexts',
    label: '★★★ 起草中是**两个 tab**：产出 / 依据（2026-10-21 第 4 批；原来这块是"目标摘要 + 起草 run + 素材折叠"竖着摞，实时输出夹在中间）',
    ok: (v) => Array.isArray(v) && JSON.stringify(v) === JSON.stringify(['产出', '依据']),
    show: (v, f) => `${JSON.stringify(v)}　默认停在 ${JSON.stringify(f['crystal.draftingTabDefault'])}`,
  },
  {
    view: '沉淀',
    key: 'crystal.draftingTabDefault',
    label: '★★★ 默认停在**产出**——跑着的时候它是唯一的实时信息，不该先点一下才看得到',
    ok: (v) => v === '产出',
  },
  {
    view: '沉淀',
    key: 'crystal.draftingLogLive',
    label:
      '★★★ 产出里那行日志是**真的流下来的**（假 CLI 吐的一行，经 daemon 解析再经 SSE 落到页面）——这一条量的是"跑着的时候人看得到东西"',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify((f['crystal.draftingLogText'] ?? '').slice(0, 60)),
  },
  {
    view: '沉淀',
    key: 'crystal.draftingTargetSectionGone',
    label:
      '★★ 目标那一块**表单**不再占主区（它进了「依据」tab）——起草中要动手的只有"停止"，剩下地方全归产出',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.draftingPageFits',
    label: '★★ 起草中那一屏也不整页滚',
    ok: (v) => v === true,
    show: (v, f) => `文档 ${f['crystal.draftingScrollH']}px / 视口 ${f['crystal.viewportH']}px`,
  },
  {
    view: '沉淀',
    key: 'crystal.draftingEvidenceOpens',
    label: '★★「依据」tab 里打得开：**目标摘要 + 素材**两块',
    ok: (v) => v === true,
    show: (v, f) =>
      `${JSON.stringify(f['crystal.draftingEvidenceBlocks'])}　目标 ${JSON.stringify(f['crystal.draftingEvidenceTarget'])}`,
  },
  {
    view: '沉淀',
    key: 'crystal.draftingEvidenceRows',
    label: '★「依据」里的素材清单真的列出来（起草者按需读的就是这些）',
    ok: (v) => Array.isArray(v) && v.length >= 1,
    show: (v) => JSON.stringify(v),
  },
  {
    view: '沉淀',
    key: 'crystal.draftingEvidenceNoFold',
    label: '★ 依据里**没有**折叠段：进了 tab 再折一层就是多一次点击',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.stoppedBackToTarget',
    label:
      '★★★ 起草中点「停止」⇒ **回到目标态**（表单又在、tab 条不在）——这是真会发生的路：起草跑歪了，停下，回头看看素材',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.stoppedTabCount',
    label: '★★ 回到目标态之后**没有 tab 条**（与"目标态不做 tab"同一条：这一屏是表单，不是分层浏览）',
    ok: (v) => v === 0,
    show: (v) => `${v} 个`,
  },
  {
    view: '沉淀',
    key: 'crystal.stoppedFoldHead',
    label:
      '★★★ 停止之后**素材折叠在这儿**、且默认收起——★ 这一条钉的是一个**只在这条路径上才到达**的分支：第 4 批把它的条件收窄成"有草稿且停在目标态"，不量的话那支标记就是"看着在、其实没人能到达"的疑似死代码',
    ok: (v, f) => typeof v === 'string' && v.includes('素材') && f['crystal.stoppedFoldClosed'] === true,
    show: (v, f) => `${JSON.stringify(v)}　默认收起 ${f['crystal.stoppedFoldClosed']}`,
  },
  {
    view: '沉淀',
    key: 'crystal.stoppedFoldOpens',
    label: '★ 展开它真的列出素材（起草过一版 ⇒ `material/` 已在磁盘上，不是一行空壳）',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify(f['crystal.stoppedFoldRows']),
  },
  {
    view: '沉淀',
    key: 'crystal.stoppedStartButtonDisabled',
    label: '★★ 停下来之后「开始沉淀」是**可按的**（不是灰着让人对着它发呆）',
    ok: (v) => v === false,
  },
  {
    view: '沉淀',
    key: 'crystal.draftingEvidenceFits',
    label: '★ 依据那一屏整个落在首屏里',
    ok: (v) => v === true,
    show: (v, f) => JSON.stringify(f['crystal.draftingEvidenceBox']),
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
    show: (v, f) => `树 ${f['crystal.treeW']}px　窗格高 ${f['crystal.paneH']}px（底边差 ${f['crystal.paneBottomGap']}px）`,
  },
  {
    view: '沉淀',
    key: 'crystal.paneH',
    label:
      '★★ 窗格高度 ≥ 22rem（352px）——保底：窗口再矮也不把编辑器压到只剩几行（分批第 30 批取消了 58vh 与 640px 上限，改由"吃剩余高度"决定）',
    ok: (v) => typeof v === 'number' && v >= 351,
    show: (v, f) => `${v}px（视口 ${f['crystal.viewportH']}）`,
  },
  {
    view: '沉淀',
    key: 'crystal.paneBottomGap',
    label:
      '★★★ 主区底边**贴着视口底**（差 ≤ 1% 视口高）——「沉淀页要自适应高度」：改之前格子按 `58vh` 估，窗口一高就留白（1600 高时差 277px）、窗口一矮就整页滚',
    // 两档都算过：① 填满了（差 0±1%视口高）；② 窗口太矮、`.pane-body` 真在滚（主区压到 22rem 保底，
    // 底边被推到视口外是对的——不这么留后手，判据会把"窗口太小时的合理退化"判成缺陷）
    ok: (v, f) =>
      typeof v === 'number' &&
      ((v >= 0 && v <= Math.max(8, Math.round(Number(f['crystal.viewportH']) * 0.01))) ||
        (v < 0 && f['crystal.paneBodyScrollable'] === true)),
    show: (v, f) =>
      `差 ${v}px（视口 ${f['crystal.viewportH']}${f['crystal.paneBodyScrollable'] ? '，主区在滚' : ''}）`,
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
    key: 'crystal.reviseRowHiddenInitially',
    label: '★★「按意见改一版」的输入框**默认不占高度**（点开才出现——它是"有时要用"的动作，不是常驻表单）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.reviseButtonName',
    label: '★★ 入口规规矩矩叫「反馈」（使用者定稿："原则上，应该叫反馈，在原任务中执行"——名字与行为要对上）',
    ok: (v) => v === '反馈',
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
    label:
      '★★★ 改版草稿默认停在**「对比原 skill」**——使用者定稿："skill 差异对比也应该是原 skill 变化"（第 14 批曾定"默认对比上一版"，第 18 批按这句话翻过来）',
    ok: (v) => v === '对比原 skill',
    show: (v, f) => `停在 ${JSON.stringify(v)}　按钮 ${JSON.stringify(f['crystal.revisedSwitchButtons'])}`,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedHasOriginalSwitch',
    label: '★★ 「对比原 skill」这条基线常驻（新建 = 第一版；更新 = 任务开始时库里那一份）',
    ok: (v) => v === true,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedHasBaselineSwitch',
    label: '★ 改版草稿能切到"对比当前版本"（已经入库的那份才是"当前版本"）',
    ok: (v) => v === true,
  },
  // ⚠️ 分批第 18 批**删掉**了这里的一条旧判据（`crystal.revisedDiffLineCount`：DOM 里 `.diff-line`
  //    小于 10 行）。不是放宽，是它已经量不动它想量的事了：`.diff-line` 数的是**渲染出来的**行
  //    （含上下文），夹具里改 2 行也会渲染 10 行 ⇒ 它无法区分"真差"与"整份都算新增"。
  //    同一件事现在由下面两条精确量（`+N` 等于 2 / 切到上一版后等于 1），量的是结论条上那个数字。
  {
    view: '沉淀',
    key: 'crystal.revisedDiffAdded',
    label:
      '★★★ 默认停在原 skill ⇒ 结论条上的 `+N` 是**第一版到现在**的改动（夹具那条链三版，每版差一行 ⇒ 应是 2 行）',
    ok: (v) => v === 2,
    show: (v, f) => `+${v}　条上 ${JSON.stringify(f['crystal.revisedBarText'])}`,
  },
  {
    view: '沉淀',
    key: 'crystal.revisedDiffAddedPrevious',
    label:
      '★★★ 切到「对比上一版草稿」之后 `+N` 变成 1——★ 这条与上面那条成对：只量一次的话两条基线的值可能一样，"默认到底是哪条"就测不出来',
    ok: (v) => v === 1,
    show: (v, f) => `+${v}`,
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
const probeHtml = fs.readFileSync(probeSrc, 'utf8')

/**
 * ★ 起 Chrome 之前，先给探针页里的脚本做一次**语法检查**。
 *
 * 为什么非要有这一步：`probe.html` 里的脚本**不经过 typecheck / svelte-check**
 * （它不是 `.ts`、也不是 `.svelte`），所以里面一个语法错会让**整个脚本解析失败**——
 * 一个 fact 都发不出来，`#out` 停在 `pending`，外面只看到"探针没在超时前给出结果
 * （dump 里没有 done:true）"，而真正的原因（"变量名写重了"）离这条消息隔了三层。
 *
 * 实测代价：2026-10-21 给"编辑窗格起点"加测量时把 `cyPaneRect`（下面已有同名变量）
 * 又声明了一遍，探针连着两次跑满超时、一个字都没发出来，我先误判成
 * "虚拟时钟下 iframe 的 load 事件会错过"，绕了 20 分钟才回到这里。**这一层就是为了
 * 让下一次不必绕**：错在第几行、错在哪个标识符，当场打出来。
 */
function assertProbeScriptParses(html) {
  const m = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!m) {
    log(red('✗ 探针页里找不到 <script> 段——探针不会跑，先修 probe.html'))
    process.exit(2)
  }
  const src = m[1]
  const scriptStartLine = html.slice(0, m.index).split('\n').length
  try {
    new vm.Script(src, { filename: 'probe.html(script)' })
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    // 尽力把"脚本内的行号"换回"HTML 里的行号"：报错行在源里找得到就找它
    const hit = /^(.*?):(\d+)$/m.exec((err && err.stack ? err.stack : '').split('\n')[1] ?? '')
    const innerLine = hit ? Number(hit[2]) : null
    log(red('✗ 探针脚本有语法错，整份探针一个字都发不出来：'))
    log('  ' + msg)
    if (innerLine !== null) {
      const htmlLine = scriptStartLine + innerLine - 1
      log('  probe.html 第 ' + htmlLine + ' 行附近：')
      log('    ' + (html.split('\n')[htmlLine - 1] ?? '').trim())
    }
    log(dim('  （probe.html 不受 typecheck / svelte-check 覆盖，所以这一步是唯一的兜底）'))
    process.exit(2)
  }
}

assertProbeScriptParses(probeHtml)
fs.writeFileSync(probeDst, probeHtml)

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

/**
 * ★★ 假 `agent-cli`（2026-10-21）——为了量"**审核跑着的时候**界面长什么样"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能再用"夹具插一条 running 的 run"
 * ══════════════════════════════════════════════════════════════════
 *
 * 试过了，量出来的是**假的绿**：夹具注入发生在 daemon 停机的那一段，而 daemon 起来时
 * `reconcileInterruptedRuns`（FR-RUNTIME-11）会把所有非终态 run 收口成 `failed`
 * ——"数据里写着正在进行、其实没人在进行"正是它要消灭的东西。于是那一屏量到的
 * 其实是"没跑成"那一屏，两条判据（有日志、日志有内容）**碰巧**都成立：
 * 假的绿比红更危险。
 *
 * 所以这里反过来：**让一条真的 run 跑起来**——把 PATH 前面塞一个叫 `agent-cli` 的
 * 假可执行文件（通用 runtime 的命令名），它吐一行 NDJSON 然后**挂着不退出**。
 * 于是：
 *   · 探针点界面上真的「开始审核」⇒ daemon 真的 spawn 一个进程 ⇒ run 真的是 `running`；
 *   · 实时输出、状态徽标、取消按钮量的都是**真现场**；
 *   · 点「取消审核」真的把它杀掉 —— 顺带把"daemon 自己发起的审核 run"这条
 *     以前只能在真机上做（要花真额度）的证据，在假 CLI 上补上。
 *
 * ⚠️ 假 CLI **只回答 `--version` 并吐一行就睡**：它不读 prompt、不改文件、不花额度。
 *    （与 `packages/agent-generic/src/testing/fake-cli.ts` 同一个立场：NFR-T-01。）
 */
const stubBinDir = path.join(SCRATCH, 'bin')
function writeFakeGenericCli() {
  fs.mkdirSync(stubBinDir, { recursive: true })
  const script = path.join(stubBinDir, 'agent-cli')
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      '# 探针夹具：假装成通用 runtime 的 CLI。',
      '#',
      '# ★ 只对**审核那条 run** 挂着不退出（量"审核跑着的时候界面长什么样"）；',
      '#   别的 run 一律立刻失败退出——探针里那几条夹具（对话第一句话 / 三步链派发）',
      '#   本来就是靠"`agent-cli` 不存在 ⇒ 立刻 ENOENT 失败"来避免真跑 CLI 的。',
      '#   ⚠️ 第一版假 CLI 对**谁都**挂 600 秒，于是那几条 run 一直"运行中"、任务页与',
      '#   聊天页的 RunLog 一直开着 SSE —— 而 Chrome 的虚拟时钟在 fetch 没结束时**完全',
      '#   不走**（实测 `setInterval` 的 tick 是 0、dump 永远写不出来），整个探针挂到超时。',
      '#   这个坑花了两轮才定位：症状（探针超时、dump 空）离原因（假 CLI）隔了三层。',
      'if [ "$1" = "--version" ]; then echo "agent-cli 0.0-probe"; exit 0; fi',
      'case "$*" in',
      `  *${PROBE_AUDIT_MARKER}*) printf '{"type":"text","text":"${PROBE_STUB_LINE}"}\n'; sleep 600 ;;`,
      // ★ 第 4 批加的第二条：**起草中那一屏**。它比审核那条更早被点着（夹具在起 Chrome
      //   之前就发起），所以挂得久一些（1800s）——不然跑到沉淀那一节时它已经自己退出了，
      //   量到的就是"起草 run 跑完了"，而那正是这一批要量的那一屏的**反例**。
      `  *${PROBE_DRAFT_MARKER}*) printf '{"type":"text","text":"${PROBE_STUB_DRAFT_LINE}"}\n'; sleep 1800 ;;`,
      '  *) echo "agent-cli: 探针假 CLI 只服务审核那一屏（其余 run 保持"跑不起来"的原样）" >&2; exit 127 ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8',
  )
  fs.chmodSync(script, 0o755)
}
/** 假 CLI 吐的那一行（`probe.html` 里按它判"日志真有内容"）。 */
const PROBE_STUB_LINE = '探针夹具：审核 run 正在跑（假 CLI 的一条输出）。'
/**
 * 起草中那一屏的假 CLI 输出行 + 记号。
 *
 * ⚠️ 这两条**必须分开**：只用一个记号的话，量"审阅屏里审核跑着"那一节会连带把起草
 *    那条 run 也点着/或反过来，于是两屏互相污染（夹具之间不许互相消费，这个仓库踩过）。
 */
const PROBE_STUB_DRAFT_LINE = '探针夹具：起草 run 正在跑（假 CLI 的一条输出）。'
const PROBE_DRAFT_MARKER = 'PROBE-STUB-DRAFT-ONLY'
/**
 * 假 CLI 凭什么认出"这是审核那条 run"：**内置 skill 审核者的身份里塞了这个记号**
 * （见下面那次 PATCH），而审核 run 的第一句话里带审核者的身份。
 *
 * 为什么不用 prompt 里的中文（"审核"/"脚本"之类）判：那是实现细节，改一句文案这条链
 * 就悄悄断了——而断了的表现是"审核 run 秒退"，看起来像"审核跑不起来"。
 */
const PROBE_AUDIT_MARKER = 'PROBE-STUB-AUDIT-ONLY'

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
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // ★ 把假 `agent-cli` 垫在 PATH 最前面（见 `writeFakeGenericCli`）：daemon 只在
      //   **启动时**读一次 PATH，所以要在这里给，不能等起来之后再改。
      env: { ...process.env, PATH: `${stubBinDir}:${process.env.PATH ?? ''}` },
    },
  )
  child.stdout.on('data', (b) => (daemonLog += b))
  child.stderr.on('data', (b) => (daemonLog += b))
  return child
}

writeFakeGenericCli()
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

/** 收尾：把假 `agent-cli` 的残留进程杀掉（取消没成功时它会一直 sleep 着）。 */
function killFakeCli() {
  try {
    spawnSync('pkill', ['-f', path.join(stubBinDir, 'agent-cli')], { stdio: 'ignore' })
  } catch {}
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

  // ★ 再造一个**老形态的审核者**（D38 的迁移夹具）：只挂 skill、没有内联标准。
  //   探针要走一遍"把判断依据并进「指令」→ 那条 skill 才卸得掉"。
  // ⚠️ 这条 `POST /api/skills` 必须在**下面这次查找之前**执行：第一版把它写在文件
  //    后半（3800 行之外，第二次 daemon 起来之后），而迁移（D38）那一族在这里就
  //    `skills.find(s => s.slug === 'probe-skill')` —— 找不到就只打一句 ⚠、整族
  //    空过，于是判据量着空态还报绿（2026-10 掀出来的假绿，与 `issueFixtureId`
  //    那处 TDZ 同一类病：**夹具被用在它存在之前**）。
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

    // ⚠️ 「配过、但包已经卸载」那个夹具组**不在这里造**：`probe-tool-ui` 是探针
    //    在界面里那次真实安装装进来的（下面那个 slug 只登记了目录项），所以
    //    "先配上、再卸包"这个顺序只能在**探针页里、那次安装之后**做——见
    //    `probe.html` 的「④.5 造『配过、但包已卸载』那个组」。第一版写在这里，
    //    那一刻包还没装 ⇒ POST 400、组没造出来、整段空过（踩过）。
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
  // 把内置 skill 审核者改挂 `generic`（探针这台一次性 daemon 上的临时改动）
  // ══════════════════════════════════════════════════════════════════
  //
  // 为什么：`probe.html` 要**点界面上真的「开始审核」**，量"审核跑着的时候"那一屏。
  // 内置审核者的 `runtimeKey` 是 `default`（跟随全局默认 ⇒ 这台机器上侦测到的是
  // claude），照原样点下去会**真的拉起一个模型**——探针不许花使用者的额度（NFR-T-01）。
  // 改成 `generic` 之后，daemon spawn 的是 PATH 最前面那个假 `agent-cli`
  // （见 `writeFakeGenericCli`）：真 spawn、真 running、真日志、真取消，一个额度不花。
  //
  // ⚠️ 只改这一个 agent、只改这一个 runtime 字段，而且探针的 daemon 用完就整目录删掉；
  //    没有任何判据依赖这个内置审核者的 runtimeKey（`agents.*` 那组量的是徽标与
  //    选择器的**选项**），所以不会污染别的断言。
  try {
    const agentsRes = await fetch(`${base}/api/agents`)
    const agentsPage = await agentsRes.json()
    const skillReviewer = (agentsPage.items ?? agentsPage.agents ?? []).find(
      (a) => a.role === 'skill-reviewer',
    )
    if (!skillReviewer) {
      log(yellow('⚠ 没找到内置的 skill 审核者——"审核跑着"那一屏会量不到'))
    } else {
      const patchRes = await fetch(`${base}/api/agents/${encodeURIComponent(skillReviewer.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtimeKey: 'generic',
          // ★ 身份里带一个记号：假 CLI 只对**带这个记号的 run** 挂着不退出（见 PROBE_AUDIT_MARKER）。
          instructions: `${PROBE_AUDIT_MARKER}\n探针夹具：这条内置审核者的身份在探针的一次性 daemon 上被临时改过。`,
        }),
      })
      if (!patchRes.ok) {
        log(yellow(`⚠ 内置 skill 审核者改挂 generic 失败：HTTP ${patchRes.status}`))
      }
    }
  } catch (err) {
    log(yellow(`⚠ 内置 skill 审核者改挂 generic 时出错：${err}`))
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
  // ⚠️ 声明必须**在注入 phase 之前**：下面造源 run 的 `subject: {id: issueFixtureId}`
  //    用它，而这个 `let` 从前写在 4360（phase 之后）⇒ `let` 的暂时性死区让整段注入
  //    抛 `Cannot access 'issueFixtureId' before initialization`，被那一句 catch 吞成
  //    一句 ⚠ ⇒ 沉淀草稿夹具**从来没造出来**，而相关判据在量空态还报绿（2026-10 实测：
  //    探针日志里那句 ⚠ 就是它）。
  let issueFixtureId = ''

  // ⚠️ `mineDraftRunId` 必须是**独立的一条**：下面 P2 那段会把它**入库**，而入库路由会给
  //    它打 `crystallized: true` ⇒ `findActiveDraft` 从此跳过它（见 crystallize.ts:181）——
  //    第一次用 `draftRunId` 去入库，直接把「沉淀」那一族 17 条判据打成红（它要的就是
  //    "那条未入库的草稿挂得上"）。夹具之间**不许互相消费**。
  const crystalFixture = {
    draftRunId: '',
    revisedRunId: '',
    sourceRunId: '',
    mineDraftRunId: '',
    auditFailRunId: '',
    auditDeadRunId: '',
    // ★ 第 4 批：**真跑起来**的起草 run（量"起草中那一屏"）——它不能是写进去的夹具：
    //   daemon 起的时候 `reconcileInterruptedRuns` 会把非终态 run 收成 failed，
    //   写进去的"running"夹具量到的是"没跑成"那一屏（这个坑审核那一节踩过一次）。
    draftingRunId: '',
    draftingSourceRunId: '',
    targetSourceRunId: '',
    // ★ 第 7 批：**同来源**的第二条草稿（"兄妹草稿"）——只给"深链指名哪条就是哪条"那一组用。
    //   它必须**比 draftRunId 旧**：来源入口取的是"最近那条"，旧了才不会动上面那一大族判据
    //   （它们量的是 draftRunId 的现场）。queuedAt 由 extra 覆盖（makeDraft 里 `...rest`
    //   在后面展开，见那段注释）。
    siblingDraftRunId: '',
  }
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
        // 第三条源 + 第三条草稿：**只给 P2 的入库夹具用**（它会被 crystallized，见上）
        const mineSourceRunId = await makeSource()

        /**
         * ★★ 第四条源：**只给"起草中"那一屏用**（2026-10-21 第 4 批）。
         *
         * 它必须满足任务场景的门槛（设计 §4.3：有用户反馈 或 **审核过**）——否则
         * `POST /api/crystallize/draft` 直接 400 `task_gate`，那一屏的夹具就起不来。
         * `hasUserFeedback` 当前恒 false，所以门槛 = 该源 run 有一条 **completed 的
         * review run**（`subject: {type:'run', id: 源run}`，见 `crystallizeTargets`）。
         *
         * ⚠️ 为什么不拿一条**对话**当源（那样就没有门槛）：探针那一屏的对话是**探针页
         *    在浏览器里**造的，Node 侧这一刻数据目录还干净；而我第一版改成"运行时造一条
         *    对话"之后，聊天那一节**整片红了**——它依赖"列表里就是它自己造的那几条"。
         *    （那次的症状记在这里，免得下次又图省事去造对话。）
         */
        const draftingSourceRunId = await makeSource()
        crystalFixture.draftingSourceRunId = draftingSourceRunId

        /**
         * ★ 第五条源：**只给"目标态"那一屏用**（2026-10-21 第 5 批）。
         *
         * 为什么另起一条、不共用上面那条：`POST /api/crystallize/draft` 会给源 run
         * **挂上一条草稿**，挂上之后这一屏就不是"目标态"了（会变成审阅态/继续态）
         * ——夹具之间不许互相消费（这个仓库的老规矩，见 `findActiveDraft` 那段注释）。
         * 这一条源**永远不起草**，所以它进页面时停在目标态：表单 + 那一行素材判据。
         * 同样要过 §4.3 门槛（否则「开始沉淀」按不动、点下去 400），所以也配一条
         * completed 的 review run。
         */
        const targetSourceRunId = await makeSource()
        crystalFixture.targetSourceRunId = targetSourceRunId
        {
          const gateRunId = ulid()
          await store.insertRun({
            id: gateRunId,
            workspaceId,
            kind: 'review',
            status: 'completed',
            agentId: executor.id,
            agentName: executor.name,
            subject: { type: 'run', id: targetSourceRunId },
            prompt: '探针夹具：为了让"目标态"那一屏的源任务过门槛而写的审核 run',
            queuedAt: now - 36_000,
            startedAt: now - 35_000,
            finishedAt: now - 34_000,
          })
        }
        {
          const gateRunId = ulid()
          await store.insertRun({
            id: gateRunId,
            workspaceId,
            kind: 'review',
            status: 'completed',
            agentId: executor.id,
            agentName: executor.name,
            // ⚠️ `subject.id` 必须是**源执行 run 的 id**、`type` 必须是 `run`
            //    （`crystallizeTargets` 就按这两个字段判"审核过"）。
            subject: { type: 'run', id: draftingSourceRunId },
            prompt: '探针夹具：为了让"起草中"那一屏的源任务过门槛而写的审核 run',
            queuedAt: now - 40_000,
            startedAt: now - 39_000,
            finishedAt: now - 38_000,
          })
        }

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
        /** 把一份产出写进某个小屋的 `skill/` 下（分批第 16 批抽出来：改版的那一间是**同一个目录**）。 */
        const writeSkillInto = (dir, files) => {
          for (const [rel, text] of Object.entries(files)) {
            const full = path.join(dir, 'skill', rel)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            fs.writeFileSync(full, text)
          }
        }
        const makeDraft = async (id, files, extra = {}) => {
          const { sourceRunId: draftSourceId = sourceRunId, workDir: draftWorkDir, ...rest } = extra
          const dir = path.join(workRoot, `skill-draft-${id}`)
          writeSkillInto(dir, files)
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
            // 工作目录：默认 = 这一版自己的小屋；分批第 16 批起"改版"那一版要显式指回**任务目录**
            workDir: draftWorkDir ?? dir,
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
        /**
         * ★★ 第 7 批：**同来源**的第二条草稿（"兄妹草稿"）。
         *
         * 为什么需要它：真机上量出一个缺陷——`#/crystallize/<草稿id>` 里那个 id 原来被丢掉，
         * 一律挂"该来源最新那条"⇒ 同一个来源下几条草稿在「沉淀」列表里是几行、点开却是同一条
         * （真机上：同一对话来源下 4 条草稿，只有最新那条能看，其余几条**花钱审出来的判决
         * 在界面上打不开**）。修法是"深链指名的那条优先"。这一对夹具就是为那条判据造的：
         * 兄妹草稿只有 1 个文件、草稿本体有 3 个 ⇒ 量文件数就能分辨挂上的是哪一条。
         *
         * ⚠️ 它必须**旧**（queuedAt 更小）：来源入口取"最近那条"，旧了才不影响上面那一族
         *    判据（它们量的都是 draftRunId 的现场）。
         */
        crystalFixture.siblingDraftRunId = await makeDraft(
          ulid(),
          { 'SKILL.md': skillMd('兄妹版') },
          { sourceRunId: crystalFixture.sourceRunId, queuedAt: now - 90_000 },
        )
        // ══════════════════════════════════════════════════════════════════
        // 第二版：`revisedFrom` 指着第一版（界面据此给「对比上一版」）
        // ══════════════════════════════════════════════════════════════════
        //
        // ⚠️ 夹具的形状**必须**跟着产品走，否则量到的是假的现场。这里踩过两次：
        //    ① 第 16 批改成"一个任务一个目录"时，夹具还按老形状（第 2 版自己一间小屋）
        //       ⇒ 改版那一屏量到的是**首版**的字（编辑器里是"第二步"而不是"第二步（已按意见改）"）；
        //    ② 我一度想"两屏各占一个任务"来绕开审核守卫，结果 `revisedFrom` 跨了任务 ⇒
        //       解析不到任务目录（`.versions.json` 与快照都不在）⇒ 两屏都量错。
        //    现在就是真形状：**同一个任务目录**，首版进 `history/<首版>/skill/`，当前内容 = 第 2 版。
        //    而"审核真跑起来"那一屏另用一条**独立单版**夹具（`auditLiveRunId`）——审核只对
        //    当前版本成立（第 17 批的守卫），首版在这里已经是历史版本了。
        /**
         * ★ 第 16/17 批：「改版草稿」那一屏（量基线切换、"编辑器里是这一版的字"）用**任务 B**。
         *
         * 为什么另起一个任务：这一屏要的两块内容（首版 3 个文件 vs 改版"已按意见改"）与任务 A
         * 已经不一样了——一个任务目录只能有一份"当前内容"，两个夹具抢同一个目录就会互相覆盖
         * （实测踩过：改版那一屏量到的是兄妹那一版的 1 个文件）。
         * 任务 B 自己一把尺：基线草稿（3 个文件）+ 改版那一版（同目录、差一行）⇒ 版本表两版。
         */
        const revisedBaseId = await makeDraft(
          ulid(),
          {
            'SKILL.md': skillMd('第二步'),
            'references/notes.md': '# 说明\n\n第一版。\n',
            'scripts/check.sh': '#!/bin/sh\necho probe\n',
          },
          { sourceRunId: revisedSourceRunId },
        )
        // ★ 分批第 18 批把任务 B 加成**三版**。为什么非加不可：两版链里"第一版"就是"上一版"，
        //   "对比原 skill"与"对比上一版"量出来的行数一模一样 ⇒ 那条判据分不开两条基线，
        //   把默认从 previous 改成 original 也照样绿（判据就成了摆设）。
        //   三版各差一行 ⇒ 相对第一版 2 行、相对上一版 1 行，判据才咬得住。
        const revisedV2Id = ulid()
        const revisedId = ulid()
        const revisedTaskDir = path.join(workRoot, `skill-draft-${revisedBaseId}`)
        {
          const put = (rel, text) => {
            const full = path.join(revisedTaskDir, rel)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            fs.writeFileSync(full, text)
          }
          const v1Files = {
            'SKILL.md': skillMd('第二步'),
            'references/notes.md': '# 说明\n\n第一版。\n',
            'scripts/check.sh': '#!/bin/sh\necho probe\n',
          }
          const v2Files = { ...v1Files, 'SKILL.md': skillMd('第二步（已按意见改）') }
          // ⚠️ 第三版必须改到**另一行**（第一版 → 第二版改的是 Procedure 第 2 步，这里改 Verification）：
          //    我第一版让三版都改同一行 ⇒ 相对第一版与相对上一版都量到 "+1 −1"，
          //    判据就算我把默认基线说反了也照样绿（实测就是这么红的：`+1` vs 期望 `2`）。
          const v3Skill = v2Files['SKILL.md'].replace('- 探针全绿', '- 探针全绿（已按意见补一条）')
          // 快照：第一版（"原 skill"读它）、第二版（"上一版"读它）
          for (const [rel, text] of Object.entries(v1Files)) put(`history/${revisedBaseId}/skill/${rel}`, text)
          for (const [rel, text] of Object.entries(v2Files)) put(`history/${revisedV2Id}/skill/${rel}`, text)
          // 当前（第三版）：比第二版又多改一行
          writeSkillInto(revisedTaskDir, { ...v1Files, 'SKILL.md': v3Skill })
          put(
            '.versions.json',
            `${JSON.stringify(
              {
                versions: [
                  {
                    runId: revisedBaseId,
                    at: now - 30_000,
                    humanEdited: false,
                    snapshot: `history/${revisedBaseId}`,
                  },
                  {
                    runId: revisedV2Id,
                    at: now - 25_000,
                    humanEdited: false,
                    snapshot: `history/${revisedV2Id}`,
                  },
                  { runId: revisedId, at: now - 20_000, humanEdited: false, snapshot: null },
                ],
                healedAt: null,
              },
              null,
              2,
            )}\n`,
          )
        }
        await makeDraft(revisedV2Id, {}, {
          revisedFrom: revisedBaseId,
          sourceRunId: revisedSourceRunId,
          workDir: revisedTaskDir,
        })
        crystalFixture.revisedRunId = await makeDraft(
          revisedId,
          {},
          { revisedFrom: revisedV2Id, sourceRunId: revisedSourceRunId, workDir: revisedTaskDir },
        )

        crystalFixture.auditLiveRunId = await makeDraft(
          ulid(),
          {
            'SKILL.md': skillMd('第二步'),
            'references/notes.md': '# 说明\n\n第一版。\n',
            'scripts/check.sh': '#!/bin/sh\necho probe\n',
          },
          { sourceRunId: await makeSource() },
        )
        // 专供 P2：一条**会被入库**的草稿（它自己一个源 run ⇒ 不影响上面两条）
        crystalFixture.mineDraftRunId = await makeDraft(
          ulid(),
          { 'SKILL.md': skillMd('第二步') },
          { sourceRunId: mineSourceRunId },
        )

        /**
         * ★ 第四条草稿：**只给"审核未通过"那一屏用**（§10.5 第 ③ 条的界面形态）。
         *
         * ⚠️ 为什么要单独一条草稿：审核结论会**改写结论条与审核区块**，挂在上面那两条
         *    草稿上会把"新建 / 改版"那两组判据的现场改掉（它们的结论条数字是量过的）。
         * ⚠️ 判决是**直写 store**（与这一组夹具同一个理由：走接口会 spawn 真 CLI，而探针
         *    的边界是"基本不造 run"）。状态取 `escalated` = **配额用尽**，也就是
         *    "停在未通过态等人"那一支——正是第 ② 条决定里最需要看得见的一屏。
         */
        crystalFixture.auditFailRunId = await makeDraft(
          ulid(),
          { 'SKILL.md': skillMd('第三步') },
          { sourceRunId: await makeSource() },
        )
        {
          const auditRunId = ulid()
          await store.insertRun({
            id: auditRunId,
            workspaceId,
            kind: 'review',
            status: 'completed',
            agentId: executor.id,
            agentName: executor.name,
            // ⚠️ `subject.id` 必须是**那条起草 run 的 id**：读接口就是按它找审核 run 的
            //    （`subject.type === 'skill-draft-review' && subject.id === draftRunId`）。
            subject: { type: 'skill-draft-review', id: crystalFixture.auditFailRunId },
            prompt: '探针夹具：审核',
            queuedAt: now - 20_000,
            startedAt: now - 19_000,
            finishedAt: now - 18_000,
          })
          await store.insertVerdict({
            id: ulid(),
            workspaceId,
            runId: auditRunId,
            subject: { type: 'skill-draft-review', id: crystalFixture.auditFailRunId },
            status: 'escalated',
            conclusion: 'fail',
            reasonCode: 'style_violation',
            confidence: 0.8,
            findings: [
              {
                severity: 'high',
                summary: '「Procedure」第 2 步没有说明命令从哪个目录跑',
                evidence: [{ blobRef: null, locator: 'skill/SKILL.md:12', excerpt: '运行 marker.sh' }],
              },
              {
                severity: 'medium',
                summary: '脚本没有退出码检查，失败时会被当成成功',
                evidence: [{ blobRef: null, locator: 'skill/scripts/marker.sh:4', excerpt: null }],
              },
              {
                severity: 'low',
                summary: 'description 里没有说清适用边界',
                evidence: [],
              },
            ],
            action: null,
            escalateReason: null,
            invalidResolution: null,
            skillRefs: [],
            modelId: null,
            promptHash: null,
            createdAt: now - 18_000,
          })
          // ★ 分批第 8 批：补上"审核当时钉下的指纹"。
          //
          // 真链路上这个文件是**审核路由**写的（`writeAuditStamp`）；夹具直写 store ⇒
          // 没有路由 ⇒ 没有指纹 ⇒ 界面判不出"过期"（`stale` 恒为 null）。
          // 而那一节量的是"改完之后出现过期标记"——没有指纹时它**永远不出现**，
          // 看起来就像"没改过"，正是"假绿"的样子。所以夹具必须把指纹补齐。
          //
          // ⚠️ 这里**不能**手写 hash：抄一份算法就有两个出处，哪天算法改了探针还在给旧指纹。
          //    直接引 daemon 的那份实现（探针脚本是 Node 跑的，能 import .ts）。
          {
            const { hashDraftDir, writeAuditStamp } = await import(
              '../../apps/daemon/src/crystallize-artifacts.ts'
            )
            const failHut = path.join(workRoot, `skill-draft-${crystalFixture.auditFailRunId}`)
            await writeAuditStamp(failHut, {
              reviewRunId: auditRunId,
              hash: await hashDraftDir(path.join(failHut, 'skill')),
              at: now - 18_000,
            })
          }
        }

        /**
         * ★ 审核**没跑成**那一条 —— 这是本节最要紧的一条判据。
         *
         * run 状态是 `failed`、**没有判决**。改之前审核区只判"有没有判决"，于是这一格
         * 永远显示"审核中…（跑完再看这里）"：使用者对着一条**早就失败**的审核 run 一直等。
         */
        crystalFixture.auditDeadRunId = await makeDraft(
          ulid(),
          { 'SKILL.md': skillMd('第五步') },
          { sourceRunId: await makeSource() },
        )
        {
          const deadReviewRunId = ulid()
          await store.insertRun({
            id: deadReviewRunId,
            workspaceId,
            kind: 'review',
            status: 'failed',
            agentId: executor.id,
            agentName: executor.name,
            subject: { type: 'skill-draft-review', id: crystalFixture.auditDeadRunId },
            prompt: '探针夹具：审核（失败）',
            queuedAt: now - 7_000,
            startedAt: now - 6_000,
            finishedAt: now - 5_000,
            failureReason: '探针夹具：假装审核跑挂了',
          })
          await store.appendRunMessage(deadReviewRunId, {
            seq: 1,
            type: 'text',
            tool: null,
            content: '探针夹具：审核 run 失败现场。',
            input: null,
            output: null,
            outputTruncated: false,
            at: now - 5_500,
          })
        }

        // ★ 给**第一条草稿**一段文字产出：审阅态那块默认要显示的就是它（"最后结果"）。
        //   没有这条消息，量到的只会是"这次起草没有留下文字产出"那个空态。
        await store.appendRunMessage(crystalFixture.draftRunId, {
          seq: 1,
          type: 'text',
          tool: null,
          content: '探针夹具的最后结果：我把这段做法写成了 skill，产出在 skill/ 目录里。',
          input: null,
          output: null,
          outputTruncated: false,
          at: now - 27_000,
        })
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

  // ══════════════════════════════════════════════════════════════════
  // ★ 起一条**真的在跑**的起草 run（量"起草中那一屏"，2026-10-21 第 4 批）
  //
  // ⚠️ 位置有讲究：必须**在第二次起 daemon 之后**。第一版我把这一段写进了上面那段
  //    HTTP 夹具里，`crystalFixture` 那一刻还不可见 ⇒ `ReferenceError: Cannot access
  //    'crystalFixture' before initialization`（同一个坑这份文件里早有一条注释记着，
  //    我还是踩了——所以这次把理由写在这里）。
  // ══════════════════════════════════════════════════════════════════
  //
  // 为什么要真跑：这一屏的判据全是"跑着的时候"的样子（实时日志、产出/依据两个 tab、
  // 默认停在产出）。写一条 `running` 的夹具 run 会**假绿**——daemon 起的时候
  // `reconcileInterruptedRuns`（FR-RUNTIME-11）把非终态 run 收成 `failed`，
  // 于是界面上是"起草没跑成"那一屏，两条判据碰巧都成立（审核那一节踩过同一个坑）。
  //
  // 做法与审核那一节完全同构：
  //   ① 内置起草者的身份里塞记号 + 改挂 `generic`（探针的一次性 daemon 上，用完即删）；
  //   ② 假 `agent-cli` 认出这个记号就吐一行、然后挂住（不读 prompt、不改文件、不花额度）；
  //   ③ **用一条已有对话的 run 当素材源**（对话场景没有"审核过才算数"那道门槛，
  //      见设计 §4.3 的 task_gate：任务场景要审核结论或用户反馈，对话场景不用）。
  //
  // ⚠️ 素材源用**夹具对话**（`conversation.jsonl` 里那条，它的 run 因为假 CLI 立刻
  //    127 而 failed）——起草只读对话的轮次，源 run 成没成功不影响（实测：turns = 1）。
  try {
    const agentsPage = await (await fetch(`${base}/api/agents`)).json()
    const drafter = (agentsPage.items ?? agentsPage.agents ?? []).find((a) => a.role === 'drafter')
    if (!drafter) {
      log(yellow('⚠ 没找到内置起草者——"起草中"那一屏会量不到'))
    } else {
      const patchRes = await fetch(`${base}/api/agents/${encodeURIComponent(drafter.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtimeKey: 'generic',
          instructions: `${PROBE_DRAFT_MARKER}\n探针夹具：这条内置起草者的身份在探针的一次性 daemon 上被临时改过。`,
        }),
      })
      if (!patchRes.ok) log(yellow(`⚠ 内置起草者改挂 generic 失败：HTTP ${patchRes.status}`))

      // ── 素材源：夹具阶段造的那条**已审核过**的执行 run（过 §4.3 的任务门槛）──
      const sourceRun = crystalFixture.draftingSourceRunId
        ? { runId: crystalFixture.draftingSourceRunId }
        : null
      if (!sourceRun) {
        // 什么都不做：那一节会以"没量到"的形式点名自己（不许静默空过）
        log(yellow('⚠ 没有"起草中"那一屏的素材源 run——那一节会量不到（见夹具阶段的注释）'))
      } else {
        const draftRes = await fetch(`${base}/api/crystallize/draft`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId: sourceRun.runId,
            target: { kind: 'new', purpose: '探针夹具：量起草中那一屏' },
          }),
        })
        const draftBody = await draftRes.json().catch(() => ({}))
        if (!draftRes.ok || typeof draftBody.draftRunId !== 'string') {
          log(yellow(`⚠ 发起起草夹具失败：HTTP ${draftRes.status} ${JSON.stringify(draftBody)}`))
        } else {
          crystalFixture.draftingRunId = draftBody.draftRunId
          // ★ 确认它**真的是 running**（不是秒退）：这一屏的判据全指着这一点。
          //   秒退说明假 CLI 没认出记号（比如 PATCH 没生效 / 记号拼错），
          //   而那种情况下量到的是"起草没跑成"，不是"起草中"。
          let status = ''
          for (let i = 0; i < 40; i += 1) {
            const one = await (await fetch(`${base}/api/runs/${crystalFixture.draftingRunId}`)).json()
            status = String(one.status ?? '')
            if (status !== 'queued' && status !== 'dispatched') break
            await sleep(50)
          }
          if (status !== 'running') {
            log(
              yellow(
                `⚠ 起草夹具 run 不是 running（实测 ${status || '(取不到)'}）——` +
                  '"起草中"那一屏的判据会红，而且红得有道理（先查假 CLI 记号）',
              ),
            )
          } else {
            log(`  起草夹具：一条真在跑的起草 run（${crystalFixture.draftingRunId}）`)
          }
        }
      }
    }
  } catch (err) {
    log(yellow(`⚠ 起起草夹具时出错：${err}`))
  }

  // ⚠️ 这一段必须在这里，不能写在 HTTP 夹具那一段（第一版就是那样，探针日志里报
  //    `ReferenceError: Cannot access 'crystalFixture' before initialization`）：
  //    夹具草稿是**上面直写 store** 造的（那时 daemon 停着），`crystalFixture` 到
  //    这一刻才有值；而入库又只能走 HTTP（git 由 daemon 自己 spawn）。
  // ══════════════ P2 夹具：一条**真有 git 历史**的 mine 技能 ══════════════
  //
  // 「历史（git）」那一节只对 `source: 'mine'` 出现，而且它的内容**真的来自 git**
  // ——注入一条 `source:'mine'` 的技能只能量到「还没有历史」（那也是一种状态，但
  // 量不到列表与 diff）。所以这里走**真接口**把它入库：
  //
  //   POST /api/crystallize/commit  ⇒ daemon 自己 ensureMineRepo + commitMine
  //   （skills-mine 落在探针的 scratch 数据目录里，不碰真家目录）
  //
  // 用 `crystalFixture.draftRunId` 那份草稿（它的 `crystallizeTarget` 是 `new`，
  // 而且 `skill/` 里已经有三个文件）——`files` 也照传，正文必须是**能过入库校验**
  // 的最小合法形状（缺 `## When to Use` / `## Procedure` 会 400，而那条错看起来像
  // 历史接口坏了）。
  //
  // ⚠️ 第二次入库（进化）会多一条 commit，但探针只需要"有一条历史 + 它是首次入库"
  //    这两件事：一条提交就能把这一节的列表、首次入库标记、全部新增的 diff 都量到。
  try {
    const skillMd =
      '---\n' +
      'name: probe-mine\n' +
      'description: 探针夹具：给「历史（git）」那一节量排版用。\n' +
      '---\n\n' +
      '# 探针提炼的\n\n' +
      '## When to Use\n\n- 探针量历史那一节时\n\n' +
      '## Procedure\n\n1. 第一步\n2. 第二步\n\n' +
      '## Verification\n\n- 探针全绿\n'
    const res = await fetch(`${base}/api/crystallize/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftRunId: crystalFixture.mineDraftRunId,
        target: { kind: 'new' },
        slug: 'probe-mine',
        files: { 'SKILL.md': skillMd, 'references/notes.md': '# 说明\n\n第一版。\n' },
      }),
    })
    if (!res.ok) {
      // ⚠️ 必须把**响应体**打出来：第一版只打了状态码，看到 400 却不知道是
      //    `invalid_artifacts`（校验不过）/ `slug_required` / `skill_md_required`…
      //    而这条路由的 400 有六种理由，白跑一轮探针只为猜一个。
      log(
        yellow(
          `⚠ 造 mine 夹具（真入库）失败（HTTP ${res.status}）：${(await res.text()).slice(0, 300)}`,
        ),
      )
    } else {
      const body = await res.json()
      // git 不可用是**正常状态**（§7.3.1）：这一节会显示"版本管理未启用"，
      // 那几条判据届时是红的——但理由如实打在日志里，不会被读成界面坏了。
      if (body?.versioning?.enabled === false) {
        log(yellow(`⚠ 版本管理未启用（${body.versioning.note ?? '没有理由'}）——历史那几条会红`))
      }
    }
  } catch (err) {
    log(yellow(`⚠ 造 mine 夹具时出错：${err}`))
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
        `&crystalAuditLive=${encodeURIComponent(crystalFixture.auditLiveRunId)}` +
        `&crystalDrafting=${encodeURIComponent(crystalFixture.draftingRunId)}` +
        `&crystalTarget=${encodeURIComponent(crystalFixture.targetSourceRunId)}` +
        `&crystalSibling=${encodeURIComponent(crystalFixture.siblingDraftRunId)}` +
        `&crystalSource=${encodeURIComponent(crystalFixture.sourceRunId)}` +
        `&crystalRevised=${encodeURIComponent(crystalFixture.revisedRunId)}` +
        `&crystalAuditFail=${encodeURIComponent(crystalFixture.auditFailRunId)}` +
        `&crystalAuditDead=${encodeURIComponent(crystalFixture.auditDeadRunId)}` +
        `&localSkillsDir=${encodeURIComponent(fixtureLocalSkillsRoot)}` +
        (chatFilesWorkDir ? `&chatFilesWorkDir=${encodeURIComponent(chatFilesWorkDir)}` : '') +
        // 分批第 30 批：`PROBE_IFRAME_H` 换 iframe 高度，用来量"窗口高/矮时界面是否自适应"。
        // ⚠️ `--window-size` 在这里**没有用**（探针量的是 iframe 视口）；第一版改的是它，
        //    两档跑出来都是一模一样的 880 才发现量错了对象。
        (process.env['PROBE_IFRAME_H'] ? `&h=${encodeURIComponent(process.env['PROBE_IFRAME_H'])}` : '') +
        (process.env['PROBE_IFRAME_W'] ? `&w=${encodeURIComponent(process.env['PROBE_IFRAME_W'])}` : ''),
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
  // ★ 假 `agent-cli` 的残留：取消那一步成功的话它早就被杀掉了；没成功时它会 sleep 到底，
  //   所以这里无条件清一遍（探针不许在机器上留下自己拉的进程）。
  killFakeCli()
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
