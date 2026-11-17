/**
 * 编排运行画面：**每个 run 一张卡片**的显示判据——纯函数（可单测）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 使用者的期望（2026-11，照他的原话）
 * ══════════════════════════════════════════════════════════════════
 *
 *   "Agent 已启动在卡片中显示出来，一直接受文字消息并显示，直到最后结束。
 *    不要 Agent 之间有依赖关系，这样就不存在相互影响。"
 *
 * 翻译成三条判据：
 *   ① **run 一提交就上卡片**（不等兄弟 run 的状态、不等"执行完"）；
 *   ② **边跑边显示文字**（非终态就一直重拉，终态再补一次全文，之后不动）；
 *   ③ **两个 run 之间没有任何显示依赖**：卡片画不画只看"这条 run 存不存在"，
 *      文字画什么只看"这条 run 自己的状态与产出"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 之前为什么 loop 的审核 agent 显示不出来（两个 bug 叠在一起）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **取数只看"最后一个 runId"**（`lastRunId(st)`）：loop 的
 *    `[执行1, 把关1, 执行2, …]` 里只有最新的那一条被拉过，前面几轮的 run 从来没取过数；
 * ② **取过一次就短路**（`if (execStatuses[rid] !== undefined) continue`）⇒ 状态是
 *    **快照**：执行 run 在"它还最新"的那几拍被取到（此时 `running`），把关 run 一提交
 *    它就不再是最新 ⇒ 再也不刷新 ⇒ 永远是 `running`。而把关者那一行的条件是
 *    "执行 run 已 `completed`" ⇒ **永远不成立** ⇒ 那一行永不出现。
 *
 * 修法就是使用者那三句话：**按 run 取数、非终态继续刷、按 run 独立渲染**。
 *
 * ⚠️ 抄一份终态常量是不理想的（前端不 import protocol 包，理由见 `api.ts` 顶部），
 *    所以由 `workflow-cards.test.ts` 钉住"这一列与协议里的终态逐项相同"
 *    ——与 `chat.ts` 同一个做法：抄一份而不钉住，才是真正危险的那种抄。
 */

/**
 * 已经结束的 run 状态（协议 `RunStatus` 里的终态子集）。
 *
 * ⚠️ 必须与 `packages/protocol/src/enums.ts` 的 `TERMINAL_RUN_STATUSES` 逐项相同。
 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const

/** 这个 run 状态是不是终态（`undefined` / `null` = 还不知道 ⇒ 不算终态）。 */
export function isRunTerminal(status: string | undefined | null): boolean {
  if (status === undefined || status === null) return false
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/**
 * 这条 run 的「状态 + 产出」还要不要再拉一次。
 *
 * @param status 界面此刻知道的状态（`undefined` = 还没取过）
 * @param hasOutput 已经有产出了吗
 *
 * 四种情形：
 *   · 从没取过 ⇒ 要（两条都要）；
 *   · **非终态 ⇒ 要**（「一直接受文字消息并显示」——这一条就是它）；
 *   · 终态但没有产出 ⇒ 要一次（终态那一刻的全文常常还没抓到）；
 *   · 终态且已有产出 ⇒ 不用（run 结束后产出不会变）。
 *
 * ⚠️ 这里**没有**"只取最后一个 runId"这回事：判据只问"这条 run 自己"，
 *    与它在步骤里的位置、与兄弟 run 的状态都无关（使用者的第 ③ 条）。
 */
export function needsFetch(status: string | undefined | null, hasOutput: boolean): boolean {
  if (status === undefined || status === null) return true
  if (!isRunTerminal(status)) return true
  return !hasOutput
}

/**
 * loop 步骤的「轮」：`step.runIds` 两两配对（执行者、把关者）。
 *
 * ⚠️ 引擎在 `while (attempt <= maxRounds)` 里**先执行再把关**，所以顺序恒为
 *    `[执行1, 把关1, 执行2, 把关2, …]`。奇数个（只可能出现在"把关者抛错"留下的
 *    半轮）时如实按半轮渲染，**不硬凑**一个空把关者。
 */
export function loopRounds(
  runIds: readonly string[],
): Array<{ exec: string; guard: string | null }> {
  const out: Array<{ exec: string; guard: string | null }> = []
  for (let i = 0; i < runIds.length; i += 2) {
    out.push({ exec: runIds[i]!, guard: runIds[i + 1] ?? null })
  }
  return out
}

/**
 * 这条 run 的卡片正文该画成什么。
 *
 *   · `text`   —— 有产出，画原文（边跑边刷出来的那段）；
 *   · `running`—— 非终态但还没吐字：给「（正在跑…）」。**这是"已启动"的样子**，
 *                 不是"没有产出"——那时候说没有产出是假话；
 *   · `empty`  —— 终态且确实没产出：给「（还没有产出）」。
 *
 * ⚠️ 三个分支只看**这条 run 自己**的状态与产出，不看兄弟 run（第 ③ 条）。
 */
export type RunCardBody = 'text' | 'running' | 'empty'

export function runCardBody(
  status: string | undefined | null,
  output: string | undefined,
): RunCardBody {
  if (output !== undefined && output.trim() !== '') return 'text'
  return isRunTerminal(status) ? 'empty' : 'running'
}

/**
 * 这个步骤**往下交**的是哪一条 run 的产出——卡头那行摘要就取它的第一个行。
 *
 * 使用者 2026-11："没有外围卡片在收起的时候，需要显示最后往下的输出，比如 loop
 * 如果成功，就应该显示写作者的输出。"
 *
 * 所以判据不是"最后一条 run"（那会取到 loop 的**把关者**意见），而是"**流向下一步**
 * 的那份产出"：
 *
 *   · `loop`：runIds 是 `[执行1, 把关1, 执行2, 把关2, …]`，引擎 `return` 出去的是
 *     执行者的产物 ⇒ 取**最后一个偶数位**（最后一次执行）；
 *   · `gate`：这一步不产生 run（人确认）⇒ `null`，调用方改显示等确认的那句文案；
 *   · 其它（flow / route / 单 agent / parallel 分支）：取**最后一条**（流水线最后一级）。
 *
 * ⚠️ `parallel` 每个分支**各自一步**（引擎在每个分支里 `nextStep`），所以它自己的
 *    步骤里只有一条 run ⇒ 走"最后一条"那一支，天然正确。
 */
export function stepSummaryRunId(step: {
  kind: string
  runIds: readonly string[]
}): string | null {
  if (step.runIds.length === 0) return null
  if (step.kind === 'loop') {
    // 最后一个"执行"位（偶数下标 0,2,4…）：奇数长度时最后一条就是执行
    const lastIndex = step.runIds.length - 1
    return step.runIds[lastIndex % 2 === 0 ? lastIndex : lastIndex - 1]!
  }
  return step.runIds[step.runIds.length - 1]!
}

/**
 * 这条 run 的日志现在该不该展开。
 *
 * @param manual 人手动设过的状态（`true` 展开 / `false` 收起 / `undefined` 没动过）
 * @param status 这条 run 的状态（`undefined` = 还没取到）
 *
 * 使用者 2026-11 定的默认："**只自动展开'正在跑'的那一条**"——所以：
 *   · 人点过 ⇒ 一律听人的（点了就一直是那个状态，刷新轮询不会把它收回去）；
 *   · 没点过 ⇒ **非终态自动展开**（正在跑的那条），终态自动收起。
 *
 * ⚠️ 用"非终态"而不是"等于 running"：`queued` / `dispatched` / `waiting_local_directory`
 *    也都是"还没结束"，它们同样应该把日志亮出来（否则刚提交的那两拍是空的）。
 */
export function logExpanded(
  manual: boolean | undefined,
  status: string | undefined | null,
): boolean {
  if (manual !== undefined) return manual
  return !isRunTerminal(status)
}

/**
 * 收起态卡头那块「最后往下的产出」预览：**取前几行、并限制总字数**。
 *
 * 使用者 2026-11："'步骤卡头只放摘要（第一行）'，这个不对，需求多放几行。也建议换行显示。"
 *
 * 所以这里返回的是**多行**文本（不是第一行 + 省略号），由界面用 `white-space: pre-wrap`
 * 换行显示。两个上限各管一件事：
 *   · `maxLines`（默认 12）：**滚动条**是给人"多看几行"用的，所以这里多留一些；
 *   · `maxChars`（默认 1200）：Markdown 里一句话可以很长，光按行数限不住体量。
 *
 * 截断时在末尾补 `…`（并如实标 `truncated: true`）——**不静默截**：
 * 收起的卡头只是入口，完整内容在展开后的正文里。
 */
export function stepPreview(
  output: string | undefined,
  maxLines = 12,
  maxChars = 1200,
): { text: string; truncated: boolean } {
  if (output === undefined) return { text: '', truncated: false }
  const all = output.replace(/\r\n/g, '\n').split('\n')
  // 去掉行尾空格；空行保留（Markdown 的段落靠它分段），但**开头/结尾的空行**去掉
  let lines = all.map((l) => l.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  if (lines.length === 0) return { text: '', truncated: false }

  let truncated = false
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines)
    truncated = true
  }
  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  return { text: truncated ? `${text}…` : text, truncated }
}

/**
 * 步骤自己的终态（`WorkflowStep.status`，注意与 run 的状态**不是**一套词）。
 */
export const STEP_TERMINAL_STATUSES = ['done', 'failed', 'skipped'] as const

/** 这个步骤状态是不是终态。 */
export function isStepTerminal(status: string | undefined | null): boolean {
  if (status === undefined || status === null) return false
  return (STEP_TERMINAL_STATUSES as readonly string[]).includes(status)
}

/**
 * 这个步骤的正文（= 里面那几张 Agent 卡片）现在展不展开。
 *
 * @param manual 人手动设过的状态（`true` 展开 / `false` 收起 / `undefined` 没动过）
 * @param status 步骤状态
 *
 * ⚠️ 使用者 2026-11 报的真缺陷：这里原来是**一个全局的 `expandedSeq`**——
 *   点开上面的步骤，自动展开的那一步（正在跑 / 等人确认）就被悄悄收起来了，
 *   于是"下面那张 Agent 卡片"看起来凭空消失、又凭空出现，像是多出来的。
 *   症状原话："如果把上面『把关循环』展开，下面多的卡片就不见了。"
 *
 *   现在每条步骤**各存各的**（与日志按 run 存同一个道理）：
 *     · 人点过 ⇒ 听人的；
 *     · 没点过 ⇒ **正在跑 / 等人确认的自动展开**，其余收起。
 */
export function stepExpanded(
  manual: boolean | undefined,
  status: string | undefined | null,
): boolean {
  if (manual !== undefined) return manual
  if (isStepTerminal(status)) return false
  return status === 'running' || status === 'waiting-human'
}

/* ══════════════════════════════════════════════════════════════════
 * 卡片树：把「一条编排 run 的一个步骤」拼成**可嵌套的卡片**
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者 2026-11："你先考虑卡片模块化的问题……因为有流程嵌套，也要支持卡片嵌套。"
 *
 * 所以界面不再由主流程挑"画几行"，而是先由这里把数据**拼成一棵树**，
 * 再由 `components/workflow/CardNode.svelte` 递归渲染。一件事一个出口：
 *   · 这张卡是什么类型、里面有哪些子卡 —— `buildCards`（纯函数、有单测）；
 *   · 卡片展不展开、日志开不开 —— **卡片自己**（组件局部状态，见 RunCard / ContainerCard）。
 *
 * ⚠️ 数据现状：引擎产出的步骤是**扁平**的（嵌套原语把 `owner` 往下传，步骤不再分层），
 *    所以"嵌套"要从**步骤原型 + run 的顺序**推导：
 *      · `loop` 的 `runIds` 两两成对 ⇒ 每个"执行 + 把关"是一轮（RoundCard）；
 *      · 轮的把关若是 `gate`（人确认）⇒ 那一位没有 run ⇒ 挂一张 GateCard；
 *      · 其它原型（flow / parallel / route / 单 agent）⇒ 每条 run 一张 RunCard。
 *    引擎哪天显式记录嵌套了，只改这个函数：界面（CardNode）不用动。
 */

/** 卡片树里的一个节点（四种卡，见 `CardNode.svelte`）。 */
export type CardNode =
  | {
      kind: 'step'
      key: string
      title: string
      /** 步骤原型（`flow` / `loop` / …）——卡头上那个灰框小标签 */
      stepKind: string
      /** `WorkflowStep.status`（pending / running / done / failed / waiting-human / skipped） */
      status: string
      /** 卡头右侧那个短 runId（流水线最后一级那条）。 */
      runId: string | null
      /** 收起时那块多行预览（`stepPreview` 的结果）。 */
      preview: string
      children: CardNode[]
    }
  | {
      kind: 'round'
      key: string
      /** 「第 N 轮」 */
      title: string
      status: string
      children: CardNode[]
    }
  | {
      kind: 'run'
      key: string
      runId: string
      /** 这个 agent 的名字（取不到时由调用方给通用说法） */
      name: string
      /** 例如「第 1 轮 · 执行」「流水线 2/3」 */
      meta: string
      /** `Run.status`（queued / running / completed / failed / cancelled …） */
      status: string
      /** 正文：最新一段文字；空串 = 还没有 */
      text: string
      /** 非终态 ⇒ 正文末尾画一个"还在收"的光标 */
      streaming: boolean
    }
  | {
      kind: 'gate'
      key: string
      /** 等人确认的那句文案 */
      text: string
    }

/** 构建卡片树要用到的查表（都由视图从轮询结果里拼好传进来）。 */
export interface CardLookups {
  /** 这条 run 的状态（`undefined` = 还没取到） */
  statusOf: (runId: string) => string | undefined
  /** 这条 run 的最新一段文字 */
  outputOf: (runId: string) => string | undefined
  /** 这条 run 的 agent 名字 */
  nameOf: (runId: string) => string | null
  /** 文案（i18n 从调用方传，纯函数不碰 `$t`） */
  text: {
    stepWorking: string
    noOutput: string
    loopReviewing: string
    roundTitle: (n: number) => string
    stepWaitingHuman: string
    execMeta: (n: number) => string
    guardMeta: (n: number) => string
    stageMeta: (i: number, total: number) => string
    execLabel: string
    guardLabel: string
  }
}

/** 一条 run 卡片（正文/状态/名字都按**这一条 run 自己**算，不看兄弟） */
function runNode(
  runId: string,
  role: 'exec' | 'guard' | 'sub',
  meta: string,
  look: CardLookups,
): CardNode {
  const status = look.statusOf(runId)
  const output = look.outputOf(runId)
  const body = runCardBody(status, output)
  const text =
    body === 'text'
      ? output!
      : body === 'running'
        ? role === 'guard'
          ? look.text.loopReviewing
          : look.text.stepWorking
        : look.text.noOutput
  const name = look.nameOf(runId) ?? (role === 'guard' ? look.text.guardLabel : role === 'exec' ? look.text.execLabel : runId.slice(-8))
  return {
    kind: 'run',
    key: `run:${runId}`,
    runId,
    name,
    meta,
    status: status ?? 'queued',
    text,
    streaming: !isRunTerminal(status),
  }
}

/**
 * 一条步骤 → 一棵卡片树。
 *
 * @param step 引擎记录的步骤（`seq` 稳定 ⇒ 卡片 key 稳定 ⇒ 展开状态在 2s 轮询里留得住）
 */
export function buildCards(
  step: {
    seq: number
    kind: string
    label: string
    status: string
    gateText: string | null
    runIds: readonly string[]
  },
  look: CardLookups,
): CardNode {
  const children: CardNode[] = []

  if (step.kind === 'loop') {
    const rounds = loopRounds(step.runIds)
    rounds.forEach((r, i) => {
      const roundChildren: CardNode[] = [
        runNode(r.exec, 'exec', look.text.execMeta(i + 1), look),
      ]
      if (r.guard !== null) {
        roundChildren.push(runNode(r.guard, 'guard', look.text.guardMeta(i + 1), look))
      }
      const isLast = i === rounds.length - 1
      // 轮的把关是 gate（人确认）⇒ 这一位没有 run：挂一张 GateCard 在**这一轮**里
      if (isLast && r.guard === null && step.gateText !== null && step.gateText !== '') {
        roundChildren.push({ kind: 'gate', key: `gate:${step.seq}`, text: step.gateText })
      }
      children.push({
        kind: 'round',
        key: `round:${step.seq}:${i}`,
        title: look.text.roundTitle(i + 1),
        // 这一轮的状态：轮到它（最后一行且步骤还没完）就跟随步骤，否则已完成
        status: isLast ? step.status : 'done',
        children: roundChildren,
      })
    })
    // 一步都没跑、但已经在等人确认（比如 gate 直接挂在 loop 外）——兜底也挂一张
    if (rounds.length === 0 && step.gateText !== null && step.gateText !== '') {
      children.push({ kind: 'gate', key: `gate:${step.seq}`, text: step.gateText })
    }
  } else if (step.kind === 'gate') {
    children.push({ kind: 'gate', key: `gate:${step.seq}`, text: step.gateText ?? '' })
  } else {
    // flow / parallel / route / 单 agent：每条 run 一张卡
    const total = step.runIds.length
    step.runIds.forEach((rid, i) => {
      const meta =
        step.kind === 'flow'
          ? look.text.stageMeta(i + 1, total)
          : step.kind === 'parallel'
            ? look.text.stageMeta(i + 1, total)
            : ''
      children.push(runNode(rid, 'sub', meta, look))
    })
  }

  /**
   * 卡头那块预览。
   *
   * ★★ 2026-11 使用者："loop 还没有完毕，就有 loop 卡片的输出显示了。"
   *    —— 对的，而且这是**假信息**：loop 的语义是"执行 → 把关 → 不过就重写，
   *    直到通过"，中途那一版是**草稿**，不是这一步的产出。贴在卡头上，读起来像
   *    "这一步已经交出品了 / 已经过了"。
   *
   *    所以规则收成一句：**产出预览只属于"已经交出东西"的步骤**——
   *      · `done` / `failed` ⇒ 产出（失败时最后那份是排查线索，也要给）；
   *      · 还在等（`pending` / `running`）⇒ 「（进行中…）」，不贴产出；
   *      · `waiting-human` ⇒ **只给"等你确认"那句**（问的是"你要不要放行"，
   *        不是"它交出了什么"）。要看内容就展开——里面每张 Agent 卡是实时的。
   *    ⚠️ 这条只约束**步骤卡头**；展开后每个 Agent 卡的实时文字照旧（如实显示它正在写什么），
   *       两件事不冲突：卡头说"这一步的结论"，卡片说"这一条 run 的过程"。
   */
  const finished = step.status === 'done' || step.status === 'failed'
  const waiting = step.status === 'waiting-human'

  const summaryId = stepSummaryRunId(step)
  const out = summaryId === null ? undefined : look.outputOf(summaryId)
  const perRun = summaryId === null ? undefined : look.statusOf(summaryId)
  const preview = (() => {
    if (step.kind === 'gate' || waiting) {
      const text = (step.gateText ?? '').trim()
      return text === '' ? look.text.stepWaitingHuman : `"${text}"`
    }
    if (!finished) return look.text.stepWorking
    if (out !== undefined && out.trim() !== '') return stepPreview(out).text
    // 终态但没有产出：只有 run 也终态时"没有产出"才是实话（run 可能还在收尾）
    return isRunTerminal(perRun) ? look.text.noOutput : look.text.stepWorking
  })()

  return {
    kind: 'step',
    key: `step:${step.seq}`,
    title: step.label,
    stepKind: step.kind,
    status: step.status,
    runId: summaryId,
    preview,
    children,
  }
}
