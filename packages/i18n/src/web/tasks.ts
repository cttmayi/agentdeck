import type { TextCatalog } from '../text.ts'

/** 任务清单 / 执行记录 / 判决展示（`views/Tasks.svelte`、`components/RunLog.svelte`）。 */
export const tasksText = {
  'tasks.boardTitle': { zh: '任务看板', en: 'Task board' },
  /**
   * ⚠️ 这里**原有一个 `tasks.listTitle`**（`任务清单` / `Tasks`），2026-09 改版时
   *    删了：它是列表模式下栏头那个标题，与顶栏的页名**一字不差**（顶栏用的是
   *    `shell.navTasks`）——同一页上下两处写同一句话，看起来像渲染错了。
   *    现在列表模式的栏头**整个不存在**（顶栏页名说明"这是哪一页"），看板模式仍有
   *    一个「任务看板」作为分区标题。
   *
   * ⚠️ 同一次还删了 `tasks.listHint`（"点一条看它的执行记录与产出；需要看整体堆在
   *    哪一步时切到看板。"）：按要求去掉。它的内容**并进了右栏空态**
   *    （`tasks.pickOneHint`）——那句话说的正是"没选中任何东西时右边是什么"，
   *    放在空态里比压在清单上面更贴题，而且只在真的需要它的时候出现。
   */
  'tasks.boardHint1': { zh: '按实际进行到哪一步分列', en: 'Columns are where a task actually got to' },
  'tasks.boardHintBefore': { zh: '按', en: 'Columns show ' },
  'tasks.boardHintStrong': { zh: '实际进行到哪一步', en: 'where a task actually got to' },
  'tasks.boardHintAfter': {
    zh: '分列——不是按人工维护的状态字段，而是从执行记录推出来的事实。',
    en: ' — derived from run records, not from a hand-maintained status field.',
  },
  'tasks.modeList': { zh: '列表', en: 'List' },
  'tasks.modeBoard': { zh: '看板', en: 'Board' },
  'tasks.search': { zh: '搜索标题或说明…', en: 'Search title or description…' },
  'tasks.emptyFiltered': { zh: '没有匹配的任务', en: 'No matching tasks' },
  'tasks.empty': { zh: '还没有任务', en: 'No tasks yet' },
  'tasks.emptyFilteredHint': { zh: '换个关键词试试。', en: 'Try another keyword.' },
  // ⚠️ 2026-10（D58）：新建任务并进这一页之后，"去『新建任务』"这个指路要改成
  //    **指这一页自己的主操作**（顶栏），否则空态会把人指去一个不存在的侧栏项。
  //    ⚠️ 2026-10：原来写的是"右上角"——从 2026-09 起这一页的动作就搬到顶栏、而且是
  //    靠**左**的（与主区内容共一条竖线），所以那句话一直是错的。
  'tasks.emptyHint': { zh: '点顶栏的「新建任务」建一个，它会立刻派给智能体。', en: 'Use “New task” in the top bar — it is dispatched to an agent right away.' },
  /**
   * 离开「新建任务」那一栏时的确认框（D58）。
   *
   * ⚠️ 三条都只说**会发生什么**（写的东西不留），不说"确定吗"——按钮上写的是
   *    动作名（`leaveCreateConfirm` = 「放弃」），与平台上其他确认框同一个口径。
   */
  'tasks.leaveCreateTitle': { zh: '放弃这条还没建的任务？', en: 'Discard this unsaved task?' },
  'tasks.leaveCreateBody': {
    zh: '表单里已经写了内容，切走之后它不会留下——这条任务不会被创建。',
    en: 'The form has content in it. Leaving will not create the task, and what you wrote is not kept.',
  },
  'tasks.leaveCreateConfirm': { zh: '放弃', en: 'Discard' },
  'tasks.columnEmpty': { zh: '（空）', en: '(empty)' },
  /**
   * 列表模式栏头左侧的计数（D61）：搜索框并进栏头右侧之后，左边得有个同伴，
   * 否则栏头就是半空。数的是**当前列表里实际显示的条数**（过滤之后）。
   */
  'tasks.listCount': { zh: '共 {count} 条', en: '{count} tasks' },
  'tasks.attentionTitle': { zh: '需要注意（{count}）', en: 'Needs attention ({count})' },
  'tasks.restTitle': { zh: '其余任务（{count}）', en: 'Everything else ({count})' },
  'tasks.backToList': { zh: '← 返回任务清单', en: '← Back to tasks' },
  'tasks.updatedAt': { zh: '更新于 {time}', en: 'Updated {time}' },
  'tasks.descriptionHeading': { zh: '说明', en: 'Description' },
  'tasks.runsHeading': { zh: '执行记录', en: 'Runs' },
  /** 详情头里那行小字：`run 3f9a2c1b`（原来硬编码英文 "run"）。 */
  'tasks.runIdLabel': { zh: '执行 {id}', en: 'Run {id}' },
  'tasks.neverRunTitle': { zh: '这个任务还没有执行过', en: 'This task has not run yet' },
  'tasks.neverRunHint': { zh: '在「新建任务」里创建时会自动派发一次。', en: 'Creating it under “New task” dispatches a run automatically.' },
  'tasks.kindReview': { zh: '审核', en: 'Review' },
  'tasks.kindExecute': { zh: '执行', en: 'Execute' },
  'tasks.finalResult': { zh: '最后结果', en: 'Final result' },
  'tasks.rawLog': { zh: '实时输出', en: 'Live output' },
  'tasks.showFinalResult': { zh: '最后结果', en: 'Final result' },
  'tasks.showRawLog': { zh: '完整日志', en: 'Full log' },
  'tasks.workDir': { zh: '工作目录', en: 'Work directory' },
  'tasks.type': { zh: '类型', en: 'Type' },
  'tasks.duration': { zh: '耗时', en: 'Duration' },
  'tasks.seconds': { zh: '{seconds} 秒', en: '{seconds}s' },
  'tasks.noTextOutput': { zh: '这次执行没有留下文字产出', en: 'This run left no text output' },
  'tasks.noTextOutputHint': { zh: '它可能只改了文件、或者中途失败了。完整过程在「完整日志」里。', en: 'It may have only changed files, or failed midway. The full process is in “Full log”.' },
  /**
   * 正文里只有判决块的那种 run（审核常见）：剥掉机器读的那一段之后一个字都不剩。
   * ⚠️ 这时**不能**沿用 `noTextOutput`——"它可能只改了文件、或者中途失败了"是
   *    说错话：它明明产出了判决，只是那段是机器读的。
   * ⚠️ 措辞**不指向"下面那张卡片"**：判决没落库时那张卡片根本不渲染，而空态
   *    必须是**任何情况下都成立**的话（"由平台按项列出"说的是一般事实）。
   */
  'tasks.verdictOnly': { zh: '这次审核没有写解释文字，只给出了判决', en: 'This review wrote no explanation — it only gave a verdict' },
  'tasks.verdictOnlyHint': {
    zh: '判决本体是机器读的（结论、理由码、证据、行动），平台会按项列出；完整过程在「完整日志」里。',
    en: 'The verdict itself is machine-read (conclusion, reason code, evidence, action) and is listed by the platform item by item; the full process is in “Full log”.',
  },
  /** 放弃任务前的确认（它**会顺手取消正在跑的 run**，那一步不可逆）。 */
  'tasks.confirmAbandonTitle': { zh: '放弃这条任务', en: 'Drop this task' },
  'tasks.confirmAbandonBody': {
    zh: '放弃会顺手取消正在跑的那次执行——这一步不可逆。任务本身之后还能「恢复」，但被取消的执行不会自己接着跑。',
    en: 'Dropping also cancels the run in flight — that part cannot be undone. The task itself can be recovered later, but the cancelled run will not resume on its own.',
  },
  /** 取消执行的确认（停下来就不可逆）。 */
  'tasks.confirmCancelRunBody': {
    zh: '这次执行会被停下，而且不会自己接着跑——要接着做只能重新派一次。',
    en: 'This run will be stopped and will not resume on its own — carrying on means dispatching a new one.',
  },
  'tasks.cancelRun': { zh: '取消这次执行', en: 'Cancel this run' },
  'tasks.verdictHeading': { zh: '判决', en: 'Verdict' },
  'tasks.metaHeading': { zh: '执行信息', en: 'Run info' },
  'tasks.verdictDetails': { zh: '判决明细', en: 'Verdict details' },
  'tasks.verdictDetailCount': {
    zh: '{actions} 条行动 · {findings} 条发现',
    en: '{actions} actions · {findings} findings',
  },
  'tasks.confidence': { zh: '置信度 {percent}%', en: '{percent}% confidence' },
  'tasks.suggestedAction': { zh: '建议动作：', en: 'Suggested action: ' },
  'tasks.needsHuman': { zh: '需要你判断：{reason}', en: 'Needs your call: {reason}' },
  'tasks.noFindings': { zh: '（没有具体发现项）', en: '(No findings)' },
  /**
   * 右栏空态：**没有任何任务被选中时**右边是什么。
   *
   * ⚠️ 这里合并了原来压在清单上面那句提示（`tasks.listHint`，2026-09 删）：
   *    "点一条看它的执行记录与产出；需要看整体堆在哪一步时切到看板。"
   *    两句合成一句之后，使用者只在**真需要指引的那一刻**（什么都没选）看到它。
   *    "切到看板"的入口在顶栏——所以写"上方的「看板」"，不是"这一栏的某个开关"。
   */
  'tasks.pickOneTitle': { zh: '选一个任务看它的执行与产出', en: 'Pick a task to see its runs and output' },
  'tasks.pickOneHint': {
    zh: '点左边一条看它的执行记录与产出——这一栏会显示它做成了什么、工作目录里的文件、以及判决。需要看整体堆在哪一步时，切到上方的「看板」。',
    en: 'Open a row on the left to see its runs and output — this pane shows what it produced, the files in the work directory, and the verdict. Switch to Board above to see where everything is piling up.',
  },
  'tasks.unassigned': { zh: '未指派', en: 'Unassigned' },
  'tasks.agentGone': { zh: '这条执行用的智能体已经不在了，无法继续。请新建任务并指定一个智能体。', en: 'The agent for this run no longer exists, so it cannot continue. Create a task and pick an agent.' },
  'tasks.autoWorkDir': { zh: '（自动分配）', en: '(auto-assigned)' },

  // ── 阶段：看板列头、表格短标签、行内提示 ─────────────────────────────
  // ⚠️ 列头（`tasks.col.*`）与表格里的短标签（`term.stage.*`）**分开**：
  //    「已完成执行 · 待审查」塞进表格单元格会把那一列撑开、把标题挤没。
  'tasks.col.executing.title': { zh: '正在执行', en: 'Executing' },
  'tasks.col.executing.hint': { zh: '智能体正在干活', en: 'the agent is working' },
  'tasks.col.awaiting_review.title': { zh: '已完成执行 · 待审查', en: 'Executed · awaiting review' },
  'tasks.col.awaiting_review.hint': { zh: '等审核给出判决', en: 'waiting for the review verdict' },
  'tasks.col.action_running.title': { zh: '行动中', en: 'Acting' },
  'tasks.col.action_running.hint': { zh: '判决要求做一件事，平台正在做', en: 'the verdict asked for something and the platform is doing it' },
  'tasks.noteActionRunning': { zh: '正在执行判决要求的动作', en: 'Running the action the verdict asked for' },
  'tasks.actionFailed': { zh: '失败原因：{reason}', en: 'Why it failed: {reason}' },
  // ── 「这一次是谁审的」（D42）——只在偏离长期配置时显示 ──
  'tasks.reviewerHeading': { zh: '这次由谁审', en: 'Who reviews this one' },
  'tasks.reviewerNone': {
    zh: '这次没有自动审核——新建任务时选的。产出不会被审，也不会有审核结论。',
    en: 'No automatic review this time — that was the choice when the task was created. The output will not be reviewed and there will be no verdict.',
  },
  'tasks.reviewerOverridden': {
    zh: '（这一次单独指定的审核者，没有改它长期的「由谁来审它」）',
    en: '(reviewer picked for this task only; its long-term “who reviews it” setting is unchanged)',
  },
  'tasks.warnActionFailed': {
    zh: '行动失败：{reason}',
    en: 'The action failed: {reason}',
  },
  'tasks.warnActionFailedNoReason': {
    zh: '行动失败 —— 这一条要你处理（详情见这条审核的记录）',
    en: 'The action failed — this one is on you (see this review’s record)',
  },
  'tasks.col.needs_human.title': { zh: '等待人处理', en: 'Needs a human' },
  'tasks.col.needs_human.hint': {
    zh: '判决要求人介入，卡在你这里',
    en: 'the verdict asks for a human — it is blocked on you',
  },
  'tasks.col.reviewed.title': { zh: '已完成审查', en: 'Reviewed' },
  'tasks.col.reviewed.hint': { zh: '判决已经产出', en: 'the verdict is in' },
  // ★ D47：这一列**不是流水线的一站**（见 `PIPELINE_COLUMNS` 里的注释）。
  //   提示语要说出"它还能回来"，否则这一列看起来像个垃圾桶。
  'tasks.col.abandoned.title': { zh: '已放弃', en: 'Dropped' },
  'tasks.col.abandoned.hint': {
    zh: '你决定不管它了 · 还能恢复',
    en: 'you decided not to bother · recoverable',
  },

  // 行内 note：只给标签**之外**的信息（与标签重复的字样不要说）。
  'tasks.noteNotStarted': { zh: '还没开始执行', en: 'Not started yet' },
  'tasks.noteWaitingDir': { zh: '排队中（工作目录被占用）', en: 'Queued (work directory in use)' },
  'tasks.noteReviewing': { zh: '审核中', en: 'Reviewing' },

  // 行内 warning：只有"需要你介入"才会出现的那几句。
  'tasks.warnExecFailed': { zh: '执行失败了', en: 'Execution failed' },
  'tasks.warnExecFailedReason': { zh: '执行失败了（{reason}）', en: 'Execution failed ({reason})' },
  'tasks.warnExecCancelled': { zh: '执行被取消了', en: 'Execution was cancelled' },
  'tasks.warnExecCancelledReason': {
    zh: '执行被取消了（{reason}）',
    en: 'Execution was cancelled ({reason})',
  },
  'tasks.warnNoReview': {
    zh: '没有派审核 —— 检查这个智能体的「由谁来审它」',
    en: 'No review was dispatched — check this agent’s “who reviews it” setting',
  },
  'tasks.warnNeedsHuman': {
    zh: '判决要求人介入：{reason}',
    en: 'The verdict asks for a human: {reason}',
  },
  'tasks.warnNeedsHumanNoReason': {
    zh: '判决要求人介入（详见这条审核的判决）',
    en: 'The verdict asks for a human (see this review’s verdict)',
  },
  // ── D45：审核不通过、且没有返工可跑（用完了或没配）──
  'tasks.warnRejectedNoRework': {
    zh: '审核不通过，且没有返工可跑：这条任务没配返工，或次数已经用完。需要你来改。',
    en: 'The reviewer rejected the work and no rework is left: this task either has no rework budget or already used it. It needs you.',
  },
  // 判决已派返工、那条 run 还没出现在列表里的那一小段
  'tasks.noteReworking': {
    zh: '审核不通过，正在派返工重做',
    en: 'Rejected — dispatching a rework',
  },
  // 列表行上的返工计数（D45）：这条回路真的转过几圈
  'tasks.reworkedTag': {
    zh: '返工 {n} 次',
    en: 'reworked {n}×',
  },
  // ── 「行动」那一段的事实（D45 补的显示缺口：以前成功的动作只剩一句"已执行"）──
  'tasks.actionExitCode': { zh: '退出码 {code}', en: 'exit code {code}' },
  'tasks.actionDuration': { zh: '耗时 {ms} ms', en: 'took {ms} ms' },
  // ★ 2026-09：这条标记只来自「调试」（审核者行动权限里勾的）——不跑脚本、
  //   只记录动作与参数。文案说清"没跑"，不能只说"调试"两个字（那像是什么
  //   技术状态，而它是一条给使用者看的说明）。
  'tasks.actionDebug': {
    zh: '调试 · 未执行（没跑脚本）',
    en: 'debug — not executed (script not run)',
  },
  'tasks.actionParamsSummary': {
    zh: '它带着什么参数跑的',
    en: 'What parameters it ran with',
  },
  // ══════════════════════════════════════════════════════════════════
  // ── 人的三个出路：通过 / 反馈 / 放弃（D46 + D47）──
  // ══════════════════════════════════════════════════════════════════
  //
  // 这一组回答的是"卡住的任务，人怎么收场"。三个按钮，文案上有三条刻意的选择：
  //
  //   ① **说清「通过」不触发任何动作**。点它时最容易的误解是"我批准了，系统就会
  //      去做那件事"——不会，动作只能来自模型判决里的 `action`。这句必须写在
  //      按钮**旁边**，而不是藏在文档里。
  //   ② **说清理由什么时候必填**。通过 = 选填（逼人写"ok"只会换来噪音），
  //      反馈 = 必填（这段文字就是执行者拿到的依据，一句"不行"没法干活）。
  //      两个按钮共用一个输入框，所以这件事只能靠**按钮上的提示**说清。
  //   ③ **说清「放弃」会取消正在跑的 run**。那是这个功能唯一的副作用，
  //      不写出来就是让人在不知情的情况下丢掉一次正在跑的执行。
  'tasks.decidePassHint': {
    zh: '「通过」：把这条任务判为完成。不会触发任何动作——动作只能来自审核者判决里写的那一条。理由选填。',
    en: 'Pass: mark this task as done. It triggers no action — an action can only come from the one named in a reviewer’s verdict. The reason is optional.',
  },
  'tasks.decideFeedbackHint': {
    // ★ 原来那句「会复用同一个工作目录、并让 CLI 恢复上一次的会话；恢复被拒时
    //   日志里会说明」长得多，它是底栏那个「发送并继续」的 title。底栏撤掉之后
    //   这条信息跟着搬到这里——**不能丢**：它是"反馈"和"新建一个任务"的区别所在，
    //   而且"恢复是尽力而为"这件事不写出来，被拒时使用者会以为是 bug。
    zh: '「反馈」：把上面那段话作为要求发回给执行者重做——和以前的「发送并继续」是同一件事。理由必填。会复用同一个工作目录、并让 CLI 恢复上一次的会话；恢复被拒时日志里会说明，不会假装接上了。',
    en: 'Send back: hand the text above to the executor and have it redo the work — the same thing the old “send and continue” did. The reason is required. It reuses the same work directory and asks the CLI to resume the previous session; if the resume is refused the log says so instead of pretending.',
  },
  'tasks.decideAbandonHint': {
    zh: '「放弃」：不再管这条任务，它移出「需要注意」。正在跑的 run 会被取消；run、判决、审计都留着，随时可以恢复。',
    en: 'Drop: stop tracking this task — it leaves “needs attention”. A running run is cancelled; runs, verdicts and audits are all kept, and you can recover it any time.',
  },
  'tasks.decideReasonLabel': { zh: '理由 / 反馈内容', en: 'Reason / feedback' },
  'tasks.decideReasonPlaceholder': {
    zh: '通过时选填；反馈时必填（写清要改什么）。例如：产出里的三个问题我都核对过，第二个是误报。',
    en: 'Optional when passing, required when sending back (say what must change). For example: I checked all three findings; the second is a false positive.',
  },
  'tasks.decidePass': { zh: '通过', en: 'Pass' },
  'tasks.decideFeedback': { zh: '反馈', en: 'Send back' },
  'tasks.decideAbandon': { zh: '放弃', en: 'Drop' },
  'tasks.decideRecover': { zh: '恢复这条任务', en: 'Recover this task' },
  // ★ 反馈必须填理由 —— 这条规则的本体是这句话本身（「反馈」**不落记录**，
  //   所以没有 schema 可以挂）。界面在这里拦一次，是为了不让使用者白等一次往返。
  'tasks.needReasonForFeedback': {
    zh: '「反馈」必须写清要改什么 —— 这段文字就是执行者拿到的依据。',
    en: 'Sending back needs a reason — that text is what the executor works from.',
  },
  // ★ 反馈要接在**上一次执行**后面（`resumeFromRunId`），所以一次都没跑完时
  //   它不能点。单独一句，因为这一档和「通过」不能点的原因是两件事。
  'tasks.needRunForFeedback': {
    zh: '「反馈」要接在上一次执行后面，所以得等它先跑完（正在跑的那次还没落定，接不上去）。',
    en: 'Sending back continues from the last run, so that run has to finish first (a run still in flight has not settled, so there is nothing to continue from).',
  },
  'tasks.decidePassing': { zh: '正在记录…', en: 'Recording…' },
  'tasks.decideFeedbacking': { zh: '正在派发…', en: 'Dispatching…' },
  'tasks.decideAbandoning': { zh: '正在放弃…', en: 'Dropping…' },
  'tasks.humanVerdictBadge': { zh: '人工', en: 'human' },
  'tasks.humanVerdictReasonHeading': { zh: '人工裁决的理由', en: 'Why you decided this' },
  'tasks.humanVerdictAlready': {
    zh: '这条任务已经人工判过通过了（可以再判一次，历史会保留）。',
    en: 'This task was already passed by hand (you can pass it again; history is kept).',
  },
  'tasks.humanVerdictUnavailable': {
    zh: '「通过」暂时不可用：这条任务没有可裁决的结论（审核还在跑，或那条审核 run 没有产出判决）。「反馈」和「放弃」不受影响。',
    en: 'Pass is unavailable for now: there is no conclusion to decide on (the review is still running, or its run produced no verdict). Send back and Drop still work.',
  },
  // ★ 判决已经通过、卡住的是**动作**。这一档必须单独说：在这里点"通过"会让
  //   看板从「行动失败」跳到「已完成审查」——把一件没做成的事说成做完了。
  'tasks.humanVerdictActionFirst': {
    zh: '「通过」暂时不可用：这次判决已经通过了，卡住的是动作（还在跑，或者失败了）。人工通过只处理审核结论，不会把动作补上——要么等它，要么用「反馈」让它重做。「放弃」也可以。',
    en: 'Pass is unavailable: the verdict already passed — what is stuck is the action (still running, or failed). Passing settles the review conclusion only and will not carry the action out; either wait, or use Send back to have it redone. Drop also works.',
  },
  'tasks.abandonNote': {
    zh: '这条任务已经放弃了 —— 它不再出现在「需要注意」里。要接着做就点「恢复」。',
    en: 'This task was dropped — it no longer shows under “needs attention”. Recover it to pick it back up.',
  },
  // 删除任务（列表每项右侧的「×」）——与「放弃」不同：放弃只是改状态，
  // 删除是**连同全部执行记录一起删掉**（连带范围见 daemon 侧 `Store.deleteIssue`）。
  'tasks.delete': { zh: '删除任务', en: 'Delete task' },
  'tasks.deleteConfirm': {
    zh: '删除后，这条任务的执行记录（消息、审核结果、产物）会一起删掉，且无法找回。',
    en: 'Deleting this task also removes all of its runs (messages, verdicts, artifacts), and it cannot be recovered.',
  },
  'tasks.deleted': { zh: '任务已删除', en: 'Task deleted' },
} as const satisfies TextCatalog
