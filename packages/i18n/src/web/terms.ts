import type { TextCatalog } from '../text.ts'

/**
 * 术语显示名（D39）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 契约值**不翻译**，只加显示名
 * ══════════════════════════════════════════════════════════════════
 *
 * `pass` / `meets_criteria` / `in_progress` 这些值出现在判决
 * JSON、接口与日志里，是**机器值**：翻译它们等于让界面显示的东西与库里存的、
 * 与接口返回的对不上。
 *
 * 但使用者又要看得懂。所以规则是：
 *
 *   · **值照原样、等宽显示**（界面上的 `<code>pass</code>`）；
 *   · **旁边给一个本地化的显示名**（通过 / Pass）；
 *   · 显示名只用于显示，**永远不参与**任何判断、也不写回任何地方。
 *
 * 这就是"中英混排显得乱"的解法：把"哪部分是代码、哪部分是话"在排版上分开，
 * 而不是把代码翻成人话。
 *
 * ⚠️ 键名用 `term.<族>.<值>`：值本身直接进键名（`term.reasonCode.missing_tests`），
 *    于是"这个枚举措辞改了"会在**编译期**以缺键的形式暴露出来，而不是界面上
 *    悄悄显示成键名。缺键时 renderText 会返回键名——看得见，好排查。
 */
/**
 * ⚠️ 2026-10 收口：这里**删掉了 18 条没人引用的词条**——`term.verdictStatus.*`（7）、
 *    `term.role.*` / `term.kind.*` / `term.source.*`（各 2）、`term.evidence.*`（5）。
 *    它们与本文件里那条 `term.action.*` 的旧注释同一个病：**词表里备着、界面上
 *    没有任何地方用**（角色、来源、判决状态各页面都写了自己的键）。留着的后果
 *    不是"以后可能用得上"，而是下一个人会以为"这些东西已经在界面上显示了"。
 *    本项目对词表的纪律写在 `common.ts` 顶部：**只放有人在用的**。
 *
 *    在用的那些一个字没动：`term.conclusion.*`（判决结论）、`term.reasonCode.*`、
 *    `term.actionStatus.*`、`term.runStatus.*`（执行记录与聊天那一轮的状态徽标）、
 *    `term.stage.*`（任务阶段短标签）。
 */
export const termsText = {
  // ── 判决结论 ──
  'term.conclusion.pass': { zh: '通过', en: 'Pass' },
  'term.conclusion.fail': { zh: '未通过', en: 'Fail' },
  'term.conclusion.needs_human': { zh: '需人工判断', en: 'Needs a human' },

  // ── 理由码（16 个，与协议里的 ReasonCode 一一对应）──
  'term.reasonCode.meets_criteria': { zh: '符合标准', en: 'Meets the criteria' },
  'term.reasonCode.missing_tests': { zh: '缺少测试', en: 'Missing tests' },
  'term.reasonCode.failing_tests': { zh: '测试未通过', en: 'Failing tests' },
  'term.reasonCode.style_violation': { zh: '风格违规', en: 'Style violation' },
  'term.reasonCode.logic_error': { zh: '逻辑错误', en: 'Logic error' },
  'term.reasonCode.type_error': { zh: '类型错误', en: 'Type error' },
  'term.reasonCode.broken_reference': { zh: '引用失效', en: 'Broken reference' },
  'term.reasonCode.known_vulnerability': { zh: '已知漏洞', en: 'Known vulnerability' },
  'term.reasonCode.secret_exposed': { zh: '密钥泄露', en: 'Secret exposed' },
  'term.reasonCode.unsafe_permission': { zh: '权限不安全', en: 'Unsafe permission' },
  'term.reasonCode.scope_creep': { zh: '范围蔓延', en: 'Scope creep' },
  'term.reasonCode.out_of_scope': { zh: '超出范围', en: 'Out of scope' },
  'term.reasonCode.insufficient_context': { zh: '依据不足', en: 'Insufficient context' },
  'term.reasonCode.conflicting_criteria': { zh: '标准互相冲突', en: 'Conflicting criteria' },
  'term.reasonCode.criteria_not_applicable': { zh: '标准不适用', en: 'Criteria not applicable' },
  'term.reasonCode.internal_error': { zh: '内部错误', en: 'Internal error' },
  // ★ 人工裁决（D46）：理由在自由文本里，不在这套分类里。标签要说清这一点，
  //   否则读的人会去上面那堆码里找"它到底属于哪一类"。
  'term.reasonCode.human_decision': { zh: '人工裁决', en: 'Decided by hand' },

  // ── 动作 ──
  //
  // ⚠️ 这里原来有六条 `term.action.*`（`comment.create` / `issue.update_status` /
  //    `issue.add_label` / `issue.create` / `issue.assign_agent` / `notify.emit`）
  //    ——它们是平台**内置动作**的中文名。使用者把内置动作整组移除之后，那六个
  //    名字已经不是任何动作了：动作只能来自装进来的工具包（`<包 slug>.<动作名>`，
  //    动作名由包的作者定，没有一份可以预先翻译的清单）。留着这些词条的后果很
  //    具体：下一个人会以为"平台还有这几个动作，只是界面上没显示"。

  // ── 运行状态（`RunStatus` 的 8 个值；执行记录徽标与聊天那一轮的状态都用它）──
  'term.runStatus.deferred': { zh: '已延后', en: 'Deferred' },
  'term.runStatus.queued': { zh: '排队中', en: 'Queued' },
  'term.runStatus.dispatched': { zh: '已派发', en: 'Dispatched' },
  'term.runStatus.waiting_local_directory': { zh: '等目录', en: 'Waiting for directory' },
  'term.runStatus.running': { zh: '运行中', en: 'Running' },
  'term.runStatus.completed': { zh: '已完成', en: 'Completed' },
  'term.runStatus.failed': { zh: '已失败', en: 'Failed' },
  'term.runStatus.cancelled': { zh: '已取消', en: 'Cancelled' },

  // ── 任务阶段（页面上从执行记录推出来的那一档）──
  // ⚠️ 这几条是**表格单元格里的短标签**，"已完成执行 · 待审查"那种长句是列头
  //    （`tasks.col.*`）。英文也要短到放得下（`pipeline.test.ts` 里有长度闸门）。
  'term.stage.executing': { zh: '执行中', en: 'Running' },
  'term.stage.awaiting_review': { zh: '待审查', en: 'To review' },
  // ── 动作状态（`ActionStatus`；值不翻译，这里只是它的标签）──
  'term.actionStatus.proposed': { zh: '已提出', en: 'Proposed' },
  'term.actionStatus.auto_approved': { zh: '已自动批准', en: 'Auto-approved' },
  'term.actionStatus.awaiting_approval': { zh: '等待批准', en: 'Awaiting approval' },
  'term.actionStatus.executing': { zh: '执行中', en: 'Executing' },
  'term.actionStatus.executed': { zh: '已完成', en: 'Done' },
  'term.actionStatus.failed': { zh: '失败', en: 'Failed' },
  'term.actionStatus.skipped': { zh: '已跳过（重复触发）', en: 'Skipped (duplicate)' },
  'term.actionStatus.rolled_back': { zh: '已回滚', en: 'Rolled back' },

  'term.stage.action_running': { zh: '行动中', en: 'Acting' },
  'term.stage.action_failed': { zh: '行动失败', en: 'Action failed' },
  'term.stage.needs_human': { zh: '待人工', en: 'Needs you' },
  'term.stage.reviewed': { zh: '已审查', en: 'Reviewed' },
  // ★ D47：放弃。措辞用「已放弃」而不是「已取消」——`cancelled` 是**契约值**
  //   （它同时是 run 的状态之一），而这一档说的是"你决定不管它了"。
  'term.stage.abandoned': { zh: '已放弃', en: 'Dropped' },

  // ── 证据等级 / 版本判定（runtime 卡片与编辑态）──
} as const satisfies TextCatalog
