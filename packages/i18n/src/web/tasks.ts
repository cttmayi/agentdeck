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
  'tasks.boardHintBefore': { zh: '按', en: 'Columns show ' },
  'tasks.boardHintStrong': { zh: '实际进行到哪一步', en: 'where a task actually got to' },
  'tasks.boardHintAfter': {
    zh: '分列——不是按人工维护的状态字段，而是从执行记录推出来的事实。',
    en: ' — derived from run records, not from a hand-maintained status field.',
  },
  'tasks.modeList': { zh: '列表', en: 'List' },
  'tasks.modeBoard': { zh: '看板', en: 'Board' },
  'tasks.search': { zh: '搜索标题或说明…', en: 'Search title or description…' },
  // ★ 2026-11（使用者立项）：任务列表分组 + 状态筛选（demo v3 拍板）。
  'tasks.viewGroup': { zh: '分组', en: 'Grouped' },
  'tasks.viewFlat': { zh: '平铺', en: 'Flat' },
  'tasks.viewSwitchLabel': { zh: '列表呈现', en: 'List view' },
  'tasks.filterLabel': { zh: '按状态筛选', en: 'Filter by stage' },
  'tasks.filterAll': { zh: '全部', en: 'All' },
  'tasks.manualGroup': { zh: '手动创建', en: 'Manually created' },
  'tasks.groupCount': { zh: '{n} 个任务', en: '{n} tasks' },
  'tasks.emptyFiltered': { zh: '没有匹配的任务', en: 'No matching tasks' },
  'tasks.empty': { zh: '还没有任务', en: 'No tasks yet' },
  // ★ 2026-11：状态筛选出的空态——"还没有任务"在筛选时是假话（任务都在，
  //   只是这一档没有），空态文案分开说；工具条在 top 插槽里常驻，不会锁死。
  'tasks.emptyStage': { zh: '没有「{stage}」的任务', en: 'No tasks in “{stage}”' },
  'tasks.emptyStageHint': {
    zh: '这一档现在没有任务——点「全部」看全部',
    en: 'Nothing in this stage right now — switch back to “All”',
  },
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
  'tasks.metaHeading': { zh: '执行信息', en: 'Run info' },
  /*
   * ⚠️ 2026-11（D125）：这里原来还有判决卡上的五条词条——`tasks.verdictHeading`
   *   （判决）、`tasks.verdictDetails` / `verdictDetailCount`（明细与"N 条发现"）、
   *   `tasks.confidence`（置信度 N%）、`tasks.needsHuman`（需要你判断：{reason}）、
   *   `tasks.noFindings`（没有具体发现项）。判决退场 ⇒ 五条全删。
   */
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

  // ── 阶段：看板列头、表格短标签、行内提示 ─────────────────────────────
  // ⚠️ 列头（`tasks.col.*`）与表格里的短标签（`term.stage.*`）**分开**：
  //   列头是**粗分组**（2026-11 精简后只有三列：进行中 / 待处理 / 已结束），
  //   短标签才是每一档的名字（卡片/行内显示它）。
  // ★ 2026-11 精简（使用者：「太多了，精简一下，同步看板也精简」）：六列并三列，
  //   旧六组词条（executing/awaiting_review/action_running/needs_human/reviewed/
  //   abandoned 的 title/hint）随列一起删——死键 i18n.test 会拦。
  'tasks.col.ongoing.title': { zh: '进行中', en: 'Ongoing' },
  'tasks.col.ongoing.hint': {
    zh: '平台正在推进（执行还在跑）',
    en: 'the platform is working (the run is still executing)',
  },
  /*
   * ⚠️ 2026-11（D125）：这里原来还有「待处理」那一列的两条词条
   *   （`tasks.col.pending.title` / `.hint`）——它收的是"等审核判决"与"判决说
   *   得人来定"两档。审核 run 与判决一起退场 ⇒ 没有"等审核"，那一列删。
   *   代价说清：**看板上不再有"这件事还等着你"的位置**（见 `pipeline.ts` 里
   *   `PIPELINE_COLUMNS` 的说明）。
   */
  // 2026-11（使用者："任务里面，不需要显示「这次由谁审」"）：整个区连同四句词条
  //   （heading/none/fromGroup/overridden）一起删——死键 i18n.test 会拦
  /*
   * ⚠️ 2026-11（D123）：这里原来有三条词条——`tasks.noteActionRunning`（"正在执行
   *   判决要求的动作"）、`tasks.actionFailed`（"失败原因：{reason}"）、
   *   `tasks.warnActionFailed` / `tasks.warnActionFailedNoReason`（行动失败那一档的
   *   行内提示）。动作能力退场 ⇒ 没有"行动失败"这一档，四条一起删。
   */
  'tasks.col.finished.title': { zh: '已结束', en: 'Finished' },
  'tasks.col.finished.hint': {
    zh: '不再动了：执行跑完了（或失败了），或你决定不管它了（还能恢复）',
    en: 'no longer moving: the run finished (or failed), or you dropped it (recoverable)',
  },

  // 行内 note：只给标签**之外**的信息（与标签重复的字样不要说）。
  'tasks.noteNotStarted': { zh: '还没开始执行', en: 'Not started yet' },
  'tasks.noteWaitingDir': { zh: '排队中（工作目录被占用）', en: 'Queued (work directory in use)' },
  /*
   * ⚠️ 2026-11（D125）：`tasks.noteReviewing`（「审核中」）随审核 run 一起删。
   */

  // 行内 warning：只有"需要你介入"才会出现的那几句。
  'tasks.warnExecFailed': { zh: '执行失败了', en: 'Execution failed' },
  'tasks.warnExecFailedReason': { zh: '执行失败了（{reason}）', en: 'Execution failed ({reason})' },
  'tasks.warnExecCancelled': { zh: '执行被取消了', en: 'Execution was cancelled' },
  'tasks.warnExecCancelledReason': {
    zh: '执行被取消了（{reason}）',
    en: 'Execution was cancelled ({reason})',
  },
  /*
   * ⚠️ 2026-11（D125）：这一组原来有四条围着审核判决转的提示——
   *   `tasks.warnNoReview`（"没有派审核，去查『由谁审它』"）、`tasks.warnNeedsHuman`
   *   / `tasks.warnNeedsHumanNoReason`（"判决要求人介入"）与 `tasks.warnRejected`
   *   （"审核不通过，需要你来改"；D124 时它刚改过名）。
   *
   *   审核 run 与判决一起退场 ⇒ 四条全删。**"执行失败/取消"那两条留下**（它们
   *   说的是执行自己的事实，与审核无关）。
   *
   *   ⚠️ `tasks.warnRejected` 记的那条教训仍然成立：**平台自己不处置的事，就必须
   *   进人的队列**——否则"判了不通过"在界面上看起来和"一切正常"一模一样。
   */
  /*
   * ⚠️ 2026-11（D123）：这里原来是「行动」那一段的四个事实词条
   *   （`tasks.actionExitCode` / `tasks.actionDuration` / `tasks.actionDebug`
   *   / `tasks.actionParamsSummary`）。动作能力退场 ⇒ 界面不再画动作，四个一起删。
   */
  // ══════════════════════════════════════════════════════════════════
  // ── 人的出路：反馈 / 放弃（D47；D125 之后只剩这两个）──
  // ══════════════════════════════════════════════════════════════════
  //
  // ⚠️ 2026-11（D125）：这里原来还有「通过」那一支的全部词条——
  //   `tasks.decidePassHint` / `tasks.decidePass` / `tasks.decidePassing` /
  //   `tasks.humanVerdictBadge` / `humanVerdictReasonHeading` / `humanVerdictAlready`
  //   / `humanVerdictUnavailable`。**判决与人工裁决面板一起退场** ⇒ 全删。
  //
  //   剩下的两条各自说清一件事，这是刻意保留的措辞纪律：
  //
  //   ① **「反馈」= 再派一条普通任务**（原来的「发送并继续」）。它是"干活"，
  //      不是"下结论"——所以理由必填，而且它**不落任何记录**（派出去那条新 run
  //      本身就足以让看板回到"进行中"）。
  //   ② **「放弃」会取消正在跑的 run**。那是这个功能唯一的副作用，不写出来就是
  //      让人在不知情的情况下丢掉一次正在跑的执行。
  'tasks.decideFeedbackHint': {
    // ★ 原来那句「会复用同一个工作目录、并让 CLI 恢复上一次的会话；恢复被拒时
    //   日志里会说明」长得多，它是底栏那个「发送并继续」的 title。底栏撤掉之后
    //   这条信息跟着搬到这里——**不能丢**：它是"反馈"和"新建一个任务"的区别所在，
    //   而且"恢复是尽力而为"这件事不写出来，被拒时使用者会以为是 bug。
    zh: '「反馈」：把上面那段话作为要求发回给执行者重做——和以前的「发送并继续」是同一件事。理由必填。会复用同一个工作目录、并让 CLI 恢复上一次的会话；恢复被拒时日志里会说明，不会假装接上了。',
    en: 'Send back: hand the text above to the executor and have it redo the work — the same thing the old “send and continue” did. The reason is required. It reuses the same work directory and asks the CLI to resume the previous session; if the resume is refused the log says so instead of pretending.',
  },
  'tasks.decideAbandonHint': {
    zh: '「放弃」：不再管这条任务，它移出「需要注意」。正在跑的 run 会被取消；run 与审计都留着，随时可以恢复。',
    en: 'Drop: stop tracking this task — it leaves “needs attention”. A running run is cancelled; runs and audits are all kept, and you can recover it any time.',
  },
  'tasks.decideReasonLabel': { zh: '反馈内容', en: 'Feedback' },
  'tasks.decideReasonPlaceholder': {
    zh: '写清要改什么，例如：产出里的三个问题我都核对过，第二个是误报，其余两个请修掉。',
    en: 'Say what must change. For example: I checked all three findings; the second is a false positive, fix the other two.',
  },
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
  //   它不能点。
  'tasks.needRunForFeedback': {
    zh: '「反馈」要接在上一次执行后面，所以得等它先跑完（正在跑的那次还没落定，接不上去）。',
    en: 'Sending back continues from the last run, so that run has to finish first (a run still in flight has not settled, so there is nothing to continue from).',
  },
  'tasks.decideFeedbacking': { zh: '正在派发…', en: 'Dispatching…' },
  'tasks.decideAbandoning': { zh: '正在放弃…', en: 'Dropping…' },
  'tasks.abandonNote': {
    zh: '这条任务已经放弃了 —— 它不再出现在「需要注意」里。要接着做就点「恢复」。',
    en: 'This task was dropped — it no longer shows under “needs attention”. Recover it to pick it back up.',
  },
  // 删除任务（列表每项右侧的「×」）——与「放弃」不同：放弃只是改状态，
  // 删除是**连同全部执行记录一起删掉**（连带范围见 daemon 侧 `Store.deleteIssue`）。
  /*
   * 「沉淀技能」为什么还不能点：**这条 run 还没跑完**。
   * （⚠️ D125 之前这里说的是"没有审核结论或用户反馈"，那个门槛已经撤掉。）
   */
  'tasks.optimizeNeedsFinishedRun': {
    zh: '要等这条 run 跑完才能沉淀（沉淀的素材就是它的产出与过程）。',
    en: 'Wait for this run to finish — what gets crystallized is its output and process.',
  },
  'tasks.delete': { zh: '删除任务', en: 'Delete task' },
  'tasks.deleteConfirm': {
    zh: '删除后，这条任务的执行记录（消息、审核结果、产物）会一起删掉，且无法找回。',
    en: 'Deleting this task also removes all of its runs (messages, verdicts, artifacts), and it cannot be recovered.',
  },
  'tasks.deleted': { zh: '任务已删除', en: 'Task deleted' },
} as const satisfies TextCatalog
