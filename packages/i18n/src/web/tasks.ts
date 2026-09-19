import type { TextCatalog } from '../text.ts'

/** 任务清单 / 执行记录 / 判决展示（`views/Tasks.svelte`、`components/RunLog.svelte`）。 */
export const tasksText = {
  'tasks.boardTitle': { zh: '任务看板', en: 'Task board' },
  'tasks.listTitle': { zh: '任务清单', en: 'Tasks' },
  'tasks.boardHint1': { zh: '按实际进行到哪一步分列', en: 'Columns are where a task actually got to' },
  'tasks.boardHintBefore': { zh: '按', en: 'Columns show ' },
  'tasks.boardHintStrong': { zh: '实际进行到哪一步', en: 'where a task actually got to' },
  'tasks.boardHintAfter': {
    zh: '分列——不是按人工维护的状态字段，而是从执行记录推出来的事实。',
    en: ' — derived from run records, not from a hand-maintained status field.',
  },
  'tasks.listHint': { zh: '点一条看它的执行记录与产出；需要看整体堆在哪一步时切到看板。', en: 'Open a row to see its runs and output; switch to the board to see where everything is piling up.' },
  'tasks.modeList': { zh: '列表', en: 'List' },
  'tasks.modeBoard': { zh: '看板', en: 'Board' },
  'tasks.search': { zh: '搜索标题或说明…', en: 'Search title or description…' },
  'tasks.emptyFiltered': { zh: '没有匹配的任务', en: 'No matching tasks' },
  'tasks.empty': { zh: '还没有任务', en: 'No tasks yet' },
  'tasks.emptyFilteredHint': { zh: '换个关键词试试。', en: 'Try another keyword.' },
  'tasks.emptyHint': { zh: '去「新建任务」建一个，它会立刻派给 agent。', en: 'Create one under “New task” — it is dispatched to an agent right away.' },
  'tasks.columnEmpty': { zh: '（空）', en: '(empty)' },
  'tasks.attentionTitle': { zh: '需要注意（{count}）', en: 'Needs attention ({count})' },
  'tasks.attentionHint': {
    zh: '—— 执行失败/被取消（不会有审核结果）、根本没派审核，或者**判决要求人介入**',
    en: '— run failed/cancelled (so no review), no review was dispatched at all, or the verdict asks for a human',
  },
  'tasks.restTitle': { zh: '其余任务（{count}）', en: 'Everything else ({count})' },
  'tasks.backToList': { zh: '← 返回任务清单', en: '← Back to tasks' },
  'tasks.updatedAt': { zh: '更新于 {time}', en: 'Updated {time}' },
  'tasks.descriptionHeading': { zh: '说明', en: 'Description' },
  'tasks.runsHeading': { zh: '执行记录', en: 'Runs' },
  'tasks.neverRunTitle': { zh: '这个任务还没有执行过', en: 'This task has not run yet' },
  'tasks.neverRunHint': { zh: '在「新建任务」里创建时会自动派发一次。', en: 'Creating it under “New task” dispatches a run automatically.' },
  'tasks.kindReview': { zh: '审核', en: 'Review' },
  'tasks.kindExecute': { zh: '执行', en: 'Execute' },
  'tasks.finalResult': { zh: '最后结果', en: 'Final result' },
  'tasks.rawLog': { zh: '实时输出', en: 'Live output' },
  'tasks.showFinalResult': { zh: '看最后结果', en: 'Final result' },
  'tasks.showRawLog': { zh: '看完整日志', en: 'Full log' },
  'tasks.workDir': { zh: '工作目录', en: 'Work directory' },
  'tasks.type': { zh: '类型', en: 'Type' },
  'tasks.duration': { zh: '耗时', en: 'Duration' },
  'tasks.seconds': { zh: '{seconds} 秒', en: '{seconds}s' },
  'tasks.noTextOutput': { zh: '这次执行没有留下文字产出', en: 'This run left no text output' },
  'tasks.noTextOutputHint': { zh: '它可能只改了文件、或者中途失败了。完整过程在「看完整日志」里。', en: 'It may have only changed files, or failed midway. The full process is in “Full log”.' },
  'tasks.filesHeading': { zh: '工作目录的文件', en: 'Files in the work directory' },
  'tasks.filesError': { zh: '取不到工作目录的文件', en: 'Could not read the work directory' },
  'tasks.filesErrorHint': { zh: '（如果 daemon 刚更新过，重启它再试——新接口要重启才生效）', en: '(If the daemon was just updated, restart it — new endpoints need a restart)' },
  'tasks.dirEmpty': { zh: '这个目录还是空的。', en: 'This directory is still empty.' },
  'tasks.reading': { zh: '正在读…', en: 'Reading…' },
  'tasks.truncated': { zh: '（列到上限了，还有更多——请直接在磁盘上看）', en: '(Hit the listing limit — there is more; look on disk)' },
  'tasks.cancelRun': { zh: '取消这次执行', en: 'Cancel this run' },
  'tasks.readVerdict': { zh: '读取判决', en: 'Load verdict' },
  'tasks.verdictHeading': { zh: '判决', en: 'Verdict' },
  'tasks.confidence': { zh: '置信度 {percent}%', en: '{percent}% confidence' },
  'tasks.suggestedAction': { zh: '建议动作：', en: 'Suggested action: ' },
  'tasks.needsHuman': { zh: '需要你判断：{reason}', en: 'Needs your call: {reason}' },
  'tasks.noFindings': { zh: '（没有具体发现项）', en: '(No findings)' },
  'tasks.continueHint': {
    zh: '会复用同一个工作目录（{dir}），并让 CLI 恢复上一次的会话；恢复被拒时日志里会说明，不会假装接上了。',
    en: 'Reuses the same work directory ({dir}) and asks the CLI to resume the previous session; if the resume is refused the log says so instead of pretending.',
  },
  'tasks.continuePlaceholder': { zh: '接着说下一步要它做什么…', en: 'Say what it should do next…' },
  'tasks.sending': { zh: '正在派发…', en: 'Dispatching…' },
  'tasks.sendAndContinue': { zh: '发送并继续', en: 'Send and continue' },
  'tasks.continueFooter': { zh: '接着上次的会话与工作目录 · ⌘↵ 发送', en: 'Continues the previous session and work directory · ⌘↵ to send' },
  'tasks.pickOneTitle': { zh: '选一个任务看它的执行与产出', en: 'Pick a task to see its runs and output' },
  'tasks.pickOneHint': { zh: '右边的这一栏会显示“它做成了什么”、工作目录里的文件、以及判决。', en: 'The right pane shows what it produced, the files in the work directory, and the verdict.' },
  'tasks.unassigned': { zh: '未指派', en: 'Unassigned' },
  'tasks.agentGone': { zh: '这条执行用的 agent 已经不在了，无法继续。请新建任务并指定一个 agent。', en: 'The agent for this run no longer exists, so it cannot continue. Create a task and pick an agent.' },
  'tasks.autoWorkDir': { zh: '（自动分配）', en: '(auto-assigned)' },

  // ── 阶段：看板列头、表格短标签、行内提示 ─────────────────────────────
  // ⚠️ 列头（`tasks.col.*`）与表格里的短标签（`term.stage.*`）**分开**：
  //    「已完成执行 · 待审查」塞进表格单元格会把那一列撑开、把标题挤没。
  'tasks.col.executing.title': { zh: '正在执行', en: 'Executing' },
  'tasks.col.executing.hint': { zh: 'agent 正在干活', en: 'the agent is working' },
  'tasks.col.awaiting_review.title': { zh: '已完成执行 · 待审查', en: 'Executed · awaiting review' },
  'tasks.col.awaiting_review.hint': { zh: '等审核给出判决', en: 'waiting for the review verdict' },
  'tasks.col.action_running.title': { zh: '行动中', en: 'Acting' },
  'tasks.col.action_running.hint': { zh: '判决要求做一件事，平台正在做', en: 'the verdict asked for something and the platform is doing it' },
  'tasks.noteActionRunning': { zh: '正在执行判决要求的动作', en: 'Running the action the verdict asked for' },
  'tasks.actionHeading': { zh: '这次触发的动作', en: 'The action this verdict triggered' },
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
    zh: '没有派审核 —— 检查这个 agent 的「由谁来审它」',
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
} as const satisfies TextCatalog
