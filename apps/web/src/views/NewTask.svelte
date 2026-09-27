<script lang="ts">
  import { onMount } from 'svelte'
  import { api, newRunId, type Issue } from '../lib/api.ts'
  import {
    agents,
    effectiveDefaultAgentId,
    identity,
    issues,
    loadError,
    loadIssues,
    loadRuns,
    loading,
    tools,
  } from '../lib/stores.ts'
  import { describeActionPicks } from '../lib/agent-actions.ts'
  import { newTaskDraft } from '../lib/view.ts'
  import { splitRequest } from '../lib/request-text.ts'
  import { installedActionCount } from '../lib/tool-view.ts'
  import {
    actionsRunField,
    defaultActionParams,
    defaultActionPicks,
    paramsMatchReviewer,
    paramsRunField,
    picksMatchReviewer,
    resolveNewTaskChain,
    reviewerCandidates,
    reviewerChoiceOf,
    reviewerRunField,
    toReviewerPick,
  } from '../lib/newtask-chain.ts'
  import ActionPicker from '../components/ActionPicker.svelte'
  import Modal from '../components/Modal.svelte'
  import { go, selectedIssueId, showToast } from '../lib/view.ts'
  import { t, tx } from '../lib/i18n.ts'

  /**
   * 新建任务。
   *
   * ══════════════════════════════════════════════════════════════════
   * 工作目录默认**不需要填**（D27）
   * ══════════════════════════════════════════════════════════════════
   *
   * 每个任务自动获得一个独立目录。填这里只在一种情况下有意义：你要让
   * agent 直接在你的仓库里干活。所以它收在「高级」折叠区里——**默认路径
   * 不该出现在必经之路上**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 智能体不再是"一个下拉"，而是**三步链**：执行 → 审核 → 行动
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来这一页只问一件事（交给谁执行），审核者是谁完全看不见——它藏在**执行者
   * 的长期配置**里（`Agent.reviewerAgentId`）。于是使用者遇到的所有情况都只能靠猜：
   * 这条任务会不会被审？由谁审？判完之后平台能替我做什么？
   *
   * 现在三步都是**看得见的**，而且后一步默认**由前一步推出来**：
   *
   *   ① 执行  ⇒ 只能从 `role === 'executor'` 里选（谁是默认那个见下）；
   *   ② 审核  ⇒ 默认「跟随「<执行者>」的设置」，也就是①的长期安排；也可以
   *              这一次换个人审，或者这一次不审；
   *   ③ 行动  ⇒ 默认**勾着**②最终那个审核者当前允许的动作；在这里加减任意一条
   *              就成了一次**只针对这条任务**的覆盖（长期那一份在「智能体」页）。
   *              ★ 与 ② 一样："没改"就**不带那个字段**（省略 = 跟随），
   *              详见 `lib/newtask-chain.ts` 里 `actionsRunField()` 那一段。
   *
   * ⚠️ **推导全在 `lib/newtask-chain.ts` 里**（纯函数、有单测），这一页只负责画。
   *    推错一格的后果不是排版：三种模式各自对应请求体里**不同的三态**
   *    （省略 / null / id），错一格就是"使用者选了一个安排，发出去的是另一个"。
   */
  let title = ''
  let workDir = ''

  /**
   * 聊天页那条桥：把聊出来的内容预填进来。
   *
   * ⚠️ 取走之后**必须清空**（`newTaskDraft.set(null)`）：留着的话，下次从侧边栏
   *    点「新建任务」，上次那段文字会莫名其妙又出现在框里——而那一刻使用者
   *    心里想的是"新建一个空白任务"。
   *
   * ⚠️ 也**不**顺手替他选执行者/审核者/动作：那三样正是"派活"这件事本身。
   *    这里只填内容，判断留给使用者在这一页做。
   */
  onMount(() => {
    const draft = $newTaskDraft
    if (draft !== null && draft.trim() !== '') {
      title = draft
      newTaskDraft.set(null)
    }
  })
  let agentId = ''
  let busy = false
  let error = ''

  /**
   * ① 上的「审核不通过时返工几次」（D45）。
   *
   * ★ 默认 `0` = 不返工：审核判 `fail` 时平台不动手，**直接把任务交给人**
   *   （看板「等待人处理」）。这是保守的默认——返工是**要花钱的**
   *   （每一次都真的再跑一遍 CLI），所以它必须由使用者按任务点出来，
   *   不能替他决定"多试几轮"。
   */
  let reworkCount = 0

  /**
   * 可选的返工次数。**0–5**，上限与 `SubmitRunRequest.maxReworks` 的 schema
   * 以及 daemon 的 `MAX_REWORKS` 是同一个数——三处不一致时，宽的那个才是实际
   * 生效的那个。
   *
   * 没有做"随便填一个数"的输入框：这是要花真钱跑 CLI 的次数，给它一个有限、
   * 可见的选择集，比让人填 99 再后悔合适。
   */
  const REWORK_CHOICES = [0, 1, 2, 3, 4, 5] as const

  /**
   * ② 上选了什么（下拉只能绑字符串，所以它是一个编码值）。
   *
   * ★ 初值是「跟随」：绝大多数任务照执行者的长期安排走（协议里 `reviewerAgentId`
   *   那条注释说的是同一件事）。**默认不替使用者做决定**——"这一次不审"必须是他
   *   点出来的，因为那会改变这条产出会不会被审。
   */
  let reviewerPick = toReviewerPick({ mode: 'follow' })

  /**
   * 能接任务的智能体：**只有执行者**。
   *
   * ⚠️ 这里是 D36 顺手补上的一个洞：原来选择器列的是**所有** agent，而预选是
   *    "列表里的第一个"——首启播种的列表里第一个恰恰是**审核员**，也就是说
   *   默认选项是一个不接任务的 agent。审核者是被动的那一方（它由执行者的
   *    `reviewerAgentId` 指过去），把任务交给它执行只会跑出一轮莫名其妙的结果。
   */
  $: executorAgents = $agents.filter((a) => a.role === 'executor')

  /**
   * 预选谁（D36）。
   *
   * 就是**生效中的默认**（设过的那个；没设过或那个已被删除时是第一个执行者）——
   * 界面上"必须有一个默认"这条由 `effectiveDefaultAgentId` 保证。
   * ⚠️ 只在"还没选过"时生效（`!agentId`）：使用者手动改过之后，列表或默认值的
   *    任何刷新都不该把他的选择覆盖掉。
   */
  $: if (!agentId && executorAgents.length > 0) {
    agentId = $effectiveDefaultAgentId ?? executorAgents[0]!.id
  }
  $: chosen = executorAgents.find((a) => a.id === agentId) ?? null

  /** ② 选了什么（三态里的哪一种）。 */
  $: reviewerChoice = reviewerChoiceOf(reviewerPick)

  /**
   * ★ **真正会发出去的那个选择**。
   *
   * 正常情况下它就等于 `reviewerChoice`；只有一种情况会不同：这个 daemon 不支持
   * 覆盖（`overrideSupported === false`）——那时不管下拉里残留着什么，一律按
   * **「跟随」**走。理由与 `overrideSupported` 那段注释同源：**不能把 daemon
   * 兑现不了的选择当成已经发生的事**。
   *
   * ⚠️ 界面显示与提交都必须用这一个值（`chain` 也由它推）：分两处判就会分叉，
   *    而分叉的表现是"页面上写着不审、实际审了"。
   */
  $: effectiveChoice = overrideSupported ? reviewerChoice : ({ mode: 'follow' } as const)

  /**
   * ★ 这条链的**全部推导**（② 是谁审、会不会审、③ 有哪些动作）。
   *
   * ⚠️ 输入里带 `$tools`：③ 要据它分辨"配过但解析不出来的动作"——那一份清单不在
   *    这里 join，交给 `agent-actions.ts`（与智能体页那一栏是同一个判据）。
   */
  $: chain = resolveNewTaskChain({
    executor: chosen,
    choice: effectiveChoice,
    agents: $agents,
    tools: $tools,
  })

  /**
   * 「跟随」那一项**自己**指向谁。
   *
   * ★ 与 `chain` 分开算：选项的文字说的是**那个选项**会怎么走（跟到谁），而
   *   `chain` 说的是**当前选中**的那一项会怎么走。使用者选了别人时两者不是一个人，
   *   拿 `chain` 去写选项文字，那一行就会随选择变来变去——一个"跟随 X"的选项
   *   在选中别人之后显示成"跟随 Y"，那就是在骗人。
   */
  $: followChain = resolveNewTaskChain({
    executor: chosen,
    choice: { mode: 'follow' },
    agents: $agents,
    tools: $tools,
  })

  /**
   * ★ 这个 daemon 支不支持"这一次换人审 / 这一次不审"（`Capability.ReviewerOverride`）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么页面要问这一句：界面与 daemon 是**两份产物**，而日常做法恰好
   * 容易造成版本错位——"重建前端 → 刷新页面"**不带**重启 daemon。
   * ══════════════════════════════════════════════════════════════════
   *
   * 旧 daemon 不认识 `reviewerAgentId` 这个字段，而请求体那层**没有**校验
   * （未知字段被直接忽略）。于是页面上那个「不自动审核（这一次）」会**静默失效**：
   * 使用者以为关掉了审核，任务照旧被审——两边都不报错，界面说的与实际发生的
   * 不一致。
   *
   * 所以宁可**不给这两个选项**（只留「跟随」= 旧行为，逐字一致），并在页面上
   * 说清"重启 daemon 之后才有"。能力标志优先于版本号，理由见协议里
   * `IdentityResponse.capabilities` 的说明。
   *
   * ⚠️ 身份还没到手时（`$identity === null`）按**不支持**处理：那一刻页面还
   *    不知道对面是谁，而"先给出来、到手后再收回去"会让使用者白选一次。
   */
  $: overrideSupported = ($identity?.capabilities ?? []).includes('reviewer-override')

  /**
   * ★ ③ 可勾那一档要**单独**的能力标志，不能复用上面那个。
   *
   * 两者是同一次交付里一起来的，看起来"总是一起在"，但 `allowedActions` 是
   * **另一个字段、另一份契约**。复用会出现一个真实的中间态：daemon 认识
   * `reviewerAgentId`、还不认识 `allowedActions`（只重建了一半、或回退到更早的
   * 构建）——那时页面照样画出勾选框，而勾选**被静默丢掉**（请求体那层没有校验，
   * 未知字段直接忽略）。使用者以为"这一次我允许了它动手"，实际什么都没发生。
   *
   * 理由与 `Capability.TaskActionWhitelist` 的注释同源。
   */
  $: whitelistSupported = ($identity?.capabilities ?? []).includes('task-action-whitelist')

  /** ② 的候选：审核者角色，**排除当前执行者**（INV-1；筛选规则在纯函数里）。 */
  $: reviewerOptions = reviewerCandidates(chosen, $agents)

  /** ② 上选的那个 id（没选人时是 null）。 */
  $: pickedId = reviewerChoice.mode === 'pick' ? reviewerChoice.agentId : null

  /**
   * ★ ② 上选的这个人**不在候选项里**了：界面开着的时候，他的角色被别人改成了执行者
   *   （候选按 `role === 'reviewer'` 筛）。
   *
   *   为什么必须补一个**回显用**的选项：取值在所有 `<option>` 里找不到匹配时，浏览器
   *   会把那个下拉变成**空选中**——使用者看到的是一个空白框，既看不出自己选的是谁，
   *   也看不出为什么。而这个人此刻仍然会被提交出去、由服务端回 `reviewer_role_mismatch`
   *   的原文（那才是该被看见的东西）。
   *
   *   ⚠️ 这里只把那一项画回来，**不替他改主意**（不退回「跟随」、也不清空）：那两种
   *   改法都会让提交出去的东西与他在界面上看到的不一致。
   */
  $: pickedMissing =
    pickedId !== null && !reviewerOptions.some((a) => a.id === pickedId)
  $: pickedAgent = pickedId === null ? null : ($agents.find((a) => a.id === pickedId) ?? null)

  /**
   * ★ 工具清单到了没有（D41 的教训，判据与 `ActionPicker.svelte` 同一条）。
   *
   * `$tools` 是启动时从接口取的：它到手之前**空数组**与"真的一个包都没装"长得
   * 一模一样。少了这道闸，打开这一页的那一瞬间会把使用者配得好好的动作全部标成
   * "当前不可用"，还会说"现在没有一个能用的动作"——一句关于**他自己的权限**的
   * 假话。取失败时同样不猜（那一档由「工具」页负责说）。
   */
  $: toolsKnown = !$loading['tools'] && !$loadError['tools']

  /**
   * ③ 此刻是**哪一档**——一个地方判，卡片与它下面的细节两块都读它。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么要有这个名字：③ 的内容现在分两处画
   * ══════════════════════════════════════════════════════════════════
   *
   * 三步排成一行之后，③ 那一格只有**一列宽**（约 350px），而"允许的动作"那几枚
   * 胶囊在全宽下才排得开（挤在一列里会折成四五行的窄条）。所以 ③ 拆成两块：
   * **卡片**里是标题 + 这一栏的主控件，**它下面全宽的那一条**是细节。
   *
   * ⚠️ 两块各自 `{#if}` 一遍档位，迟早会分叉（改了一处忘了另一处，症状是
   *    "卡片说只读、细节却画着勾选框"这类自相矛盾的画面）。所以档位在这里算一次，
   *    两块都只 switch 这个值。
   */
  $: actionsMode = !chain.reviewer
    ? 'no-reviewer'
    : !toolsKnown
      ? 'tools-unknown'
      : !whitelistSupported
        ? 'read-only'
        : 'editable'

  /**
   * ③ 上勾了哪些。
   *
   * ══════════════════════════════════════════════════════════════════
   * `null` = **还没碰过**（"跟随"），与"改成了一个空清单"是两件事
   * ══════════════════════════════════════════════════════════════════
   *
   * 未碰过时勾选状态**由纯函数现推**（`defaultActionPicks(chain)`），而不是在这里
   * 存一份初值。差别很具体：`$tools` 是启动时异步到手的，它到手之前
   * `chain.actions` 是空的——存初值的写法会把那一刻的"空"固化成交付出去的覆盖，
   * 于是**使用者什么都没做**，请求体里却出现了一份（空的）`allowedActions`：
   * 他把这个审核者的动作权静默地收紧了。现推就不会有这一刻（清单到手后那一份
   * 自己就变对了）。
   *
   * ⚠️ 一旦碰过就存下来（`actionPicks` 非 null）：那之后使用者勾的就是他的决定，
   *    不该被任何刷新覆盖。而"改回来了"（勾选结果又与审核者当前那份相等）由
   *    `actionsDirty` / `actionsRunField` 判——**不需要**再另立一个"碰过"的标记。
   */
  let actionPicks: string[] | null = null

  /**
   * ③ 那个挑选对话框开着没有。
   *
   * ⚠️ 它**不进请求体、也不进任何推导**——纯界面状态（与 `actionPicks` 那种
   *    "碰过没有"的语义完全无关，所以不放在一起）。关掉对话框**不撤销**里面的
   *    改动：那是草稿，提交点仍然是表单底部那颗按钮（与智能体页同一个口径）。
   */
  let actionsOpen = false

  /** 上面那份勾选是**给哪个审核者的**（`null` = 这次没有审核者）。 */
  let picksForReviewer: string | null = null

  /**
   * ★ 审核者一换，上一份勾选就作废。
   *
   * 那份勾选是"对**那个人**当前那份的取舍"，换人之后它对不上任何人：留着它会
   * 让 ③ 继续显示上一个人的动作（而 ② 那边已经说了"这一栏跟着换"），更糟的是
   * 它会被当成"这一次的覆盖"发给新那个人——一条谁都没做过的决定。
   *
   * ⚠️ 用**审核者 id** 判而不是 `chain` 整体：`$tools` 晚到、`$agents` 轮询刷新
   *    都会让 `chain` 换一个新对象，那不该把使用者正在勾的东西抹掉。
   */
  $: if (picksForReviewer !== (chain.reviewer?.id ?? null)) {
    picksForReviewer = chain.reviewer?.id ?? null
    actionPicks = null
  }

  /**
   * ③ 上真正生效的那一份（没碰过 ⇒ 审核者当前那份）。
   *
   * ⚠️ daemon 不支持这一栏的覆盖时（`whitelistSupported === false`）**一律按默认
   *    那一份**：那时勾选框根本不画，而"画过又收回"这种翻转（页面连上的 daemon
   *    换了）会留下一份**界面上看不见**的勾选——它要是被发出去，就正好是这一栏
   *    最不该发生的事：界面说的与实际发生的不一致。显示与提交同源，只判一处。
   */
  $: effectiveActionPicks = whitelistSupported
    ? (actionPicks ?? defaultActionPicks(chain))
    : defaultActionPicks(chain)

  /**
   * ③ 是"已改"吗（与审核者当前那份不一致）。
   *
   * ★ 判据在纯函数里（`picksMatchReviewer`，集合相等）：这一页只拿它决定"要不要
   *   显示那句只对这一次生效"，而**提交时那个 key 写不写**用的是同一个函数
   *   （`actionsRunField`）——两处各判一遍就会出现"页面说没改、请求体里带了覆盖"。
   */
  $: actionsDirty = !picksMatchReviewer(effectiveActionPicks, chain)

  /**
   * ③ 那一行要显示的**配置细节**（契约值 + 说明 + 固定值 + 还能不能用）。
   *
   * ★ 描述的是 `effectiveActionPicks`（**这一次真正生效的那一份**），不是
   *   `chain.actions`（那个审核者长期配的那几个）：使用者在这一页勾上的动作可能
   *   是它长期没有的（这正是这份覆盖的意义），拿长期那一份画出来的胶囊会说错。
   *
   * ⚠️ 这个 `$:` 必须在这里算（不能在模板里调函数）：Svelte 4 的模板只跟踪
   *    **那个表达式里看得见的标识符**，函数体里读的 `$tools` / `effectiveActionParams`
   *    它是看不见的——后果是勾了新动作、计数变了、胶囊却没变（同一个坑在
   *    `ActionPicker.svelte` 里踩过，那里留了注释）。
   */
  $: pickEntries = describeActionPicks(
    effectiveActionPicks,
    $tools,
    effectiveActionParams,
    chain.unavailableActions,
  )

  /**
   * ③ 上钉的固定参数（D43）：`null` = **还没碰过**（"跟随"）。
   *
   * 与 `actionPicks` 同一条"没碰过 = 现推"的规矩，但**不需要**"碰过"标记：
   * 钉值是逐项改的，"改回与审核者那份相等"由 `paramsMatchReviewer` 直接按值判
   * （键序无关），相等 ⇒ 提交时不带 key。审核者一换就重置（与 `actionPicks`
   * 同一个理由——对不上任何人的"这一次覆盖"不该发给新那个人）。
   */
  let actionParamsDraft: Record<string, Record<string, unknown>> | null = null
  let paramsForReviewer: string | null = null

  $: if (paramsForReviewer !== (chain.reviewer?.id ?? null)) {
    paramsForReviewer = chain.reviewer?.id ?? null
    actionParamsDraft = null
  }

  /**
   * ③ 上真正生效的那一份固定参数（没碰过 ⇒ 审核者长期那份）。
   *
   * ⚠️ 与 `effectiveActionPicks` 同一条 `whitelistSupported` 闸：daemon 兑现不了
   *    这一栏的覆盖时，钉值发过去会被**静默忽略**（未知字段不校验、不报错）——
   *    页面说"我固定了"，实际执行时模型照旧自己填。
   */
  $: effectiveActionParams = whitelistSupported
    ? (actionParamsDraft ?? defaultActionParams(chain))
    : defaultActionParams(chain)

  /** ③ 的固定参数是"已改"吗（与审核者当前那份不一致）——决定那句"只对这一次生效"。 */
  $: paramsDirty = !paramsMatchReviewer(effectiveActionParams, chain)

  /**
   * 提交前把固定参数**收窄到勾上的动作**。
   *
   * 没勾的动作这次不在白名单里，给它的固定参数没有落点（服务端按已装工具校验
   * 会放行，但它永远不会被用上）。收窄放在纯函数之外、提交前这一处——界面上的
   * 草稿保持"使用者改了什么就是什么"，只有发出去的那份才按这次的白名单取。
   */
  function pruneParamsToPicks(
    params: Record<string, Record<string, unknown>>,
    picks: readonly string[],
  ): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const action of picks) {
      if (params[action] && Object.keys(params[action]).length > 0) {
        out[action] = { ...params[action] }
      }
    }
    return out
  }

  /**
   * ② 说"它已经不在了"时，说的是**哪个 id**。
   *
   * 跟随那一档要读执行者的配置（不是 `chain.reviewer`——那是 null），选了人那一档
   * 要读选择本身。两者都拿不到时是空串（那种情况下 `notReviewing` 不会是
   * `dangling`，所以这一行不会显示）。
   */
  $: danglingId =
    reviewerChoice.mode === 'pick'
      ? reviewerChoice.agentId
      : reviewerChoice.mode === 'follow'
        ? (chosen?.reviewerAgentId ?? '')
        : ''

  /**
   * 多行框里的回车是**换行**，不再是提交——所以提交要多给一条快捷键。
   *
   * ⚠️ 不补这一条的话，习惯原来那个单行框的人会觉得"按回车没反应"（而原来那个
   *    框按回车就是提交）。`Ctrl/Cmd+Enter` 是这类表单的通行做法。
   *    走 `requestSubmit()` 而不是直接调 `submit()`：它会把浏览器那套校验
   *    （`required`）跑一遍，与点按钮完全同一条路。
   */
  /**
   * 「要做什么」那个框：**默认 3 行，写多了自己长高，到 15 行封顶**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么要长高，而不是给个固定高度
   * ══════════════════════════════════════════════════════════════════
   *
   * 这一页只有**一个**输入框，任务写长了（多段、带步骤、贴一段日志）是很正常
   * 的事。固定高度只有两种下场：给矮了——写第四行时就得在一个三行的小窗里滚动，
   * 看不到自己刚写的；给高了——空着的时候占掉小半屏，把下面三步挤下去。
   *
   * 所以：3 行起步（够写一句话，也是绝大多数任务的长度），随输入长高，**15 行
   * 封顶**（再多就自己滚——一个框吃掉整屏会让"提交"又跑到屏幕外，而这一页已经
   * 因为这件事改过一轮了）。
   *
   * ⚠️ 高度由 JS 设成 `scrollHeight`，上限交给 CSS 的 `max-height`（`lh` 单位
   *    算的 15 行）——两处都算一遍行高，迟早对不上（字号一改就分叉）。
   *    超上限时 `scrollHeight > max-height`，于是 `overflow-y` 切成 `auto`。
   *
   * ⚠️ `resize: vertical` 关掉了（见样式）：高度归自动加高管，手工拖出来的高度
   *    下一次敲键就被覆盖——留着一个按下去会弹回去的把手，比没有更让人困惑。
   */
  const TITLE_ROWS = 3
  const TITLE_MAX_ROWS = 15

  function autoGrow(
    node: HTMLTextAreaElement,
    _dep: unknown,
  ): { update: () => void; destroy: () => void } {
    const fit = (): void => {
      node.style.height = 'auto'
      const cs = getComputedStyle(node)
      const line = Number.parseFloat(cs.lineHeight) || 20
      const chrome =
        Number.parseFloat(cs.paddingTop) +
        Number.parseFloat(cs.paddingBottom) +
        Number.parseFloat(cs.borderTopWidth) +
        Number.parseFloat(cs.borderBottomWidth)
      const max = line * TITLE_MAX_ROWS + chrome
      const want = node.scrollHeight
      node.style.height = `${Math.min(want, max)}px`
      node.style.overflowY = want > max ? 'auto' : 'hidden'
    }
    node.addEventListener('input', fit)
    fit()
    return {
      // 参数是 `title`：**清空表单、粘贴、程序化改值**都要重新量一次
      // （只监听 `input` 会漏掉这些——它们的症状是"框里字很多，但框还是三行高"）。
      update: fit,
      destroy: () => node.removeEventListener('input', fit),
    }
  }

  function onTitleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    ;(event.currentTarget as HTMLTextAreaElement).closest('form')?.requestSubmit()
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = ''
    const trimmed = title.trim()
    if (!trimmed) return
    const { issueTitle, issueDescription } = splitRequest(trimmed)
    const agent = chosen
    if (!agent) {
      error = tx('newtask.noAgents')
      return
    }

    busy = true
    try {
      const issue = await api<Issue>('/api/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: issueTitle,
          description: issueDescription,
          assignee: { type: 'agent', id: agent.id },
        }),
      })

      // 建完立刻派一次执行——"建任务"的意图本来就是"让 agent 去做"，
      // 再让使用者点一次"跑一次"是多余的一步。
      const runId = newRunId()
      await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
          // ★ **不传 skills** —— 让 daemon 按这个 agent 的配置解析。
          //   这里原来硬编码 `skills: []`，后果是一个 skill 也没注入、
          //   Claude 用回它自己的默认行为，而 run 状态还是 completed。
          //   "审核标准由 skill 决定"是这个产品的核心，那条路径等于把它关掉了。
          subject: { type: 'issue', id: issue.id },
          // ★ 全文进 prompt（**不切**）：执行者要看到使用者写的每一个字。
          //   切分只影响"记录里怎么存"，不影响"agent 看到什么"。
          prompt: trimmed,
          // 只有真的填了才带这个字段：空字符串与"没指定"是两件事
          ...(workDir.trim() ? { workDir: workDir.trim() } : {}),
          // ★★ ② 的三态**原样**进请求体（省略 ≠ null ≠ id）：
          //   跟随 ⇒ 这个 key 根本不出现（照执行者的长期安排，daemon 去读配置）；
          //   不审 ⇒ 显式 `null`（这一次真的不审，库里留得下这条决定）；
          //   换人 ⇒ 那个 id（只影响这一条 run，不改长期配置）。
          //   映射写在纯函数里（`reviewerRunField`），有单测钉住"跟随不带 key"
          //   ——写成 `reviewerAgentId: null` 的后果是使用者以为照旧、实际关掉了审核。
          //
          // ⚠️ 送出去的是 `effectiveChoice`（不是 `reviewerChoice`）：daemon 不支持
          //    覆盖时，这里必须按「跟随」走——否则请求体里会带上一个对面兑现不了的
          //    选择，而它会被**静默忽略**（未知字段不报错），界面于是说了假话。
          ...reviewerRunField(effectiveChoice),
          // ★★ ③ 上那份勾选**只在改过的时候**进请求体（与 ② 同一条规矩）：
          //   一致 ⇒ `{}`（`allowedActions` 这个 key 根本不出现 = 跟随那个审核者的
          //   「行动权限」）；不一致 ⇒ 带上勾的那一份，而"一个都不勾"是 `[]`
          //   ——那是"这一次一个动作都不许触发"，合法而且有意义（略掉它等于跟随，
          //   使用者收的紧就静默失效了）。映射写在纯函数里，有单测钉住。
          //
          // ⚠️ 送的是 `effectiveActionPicks`（没碰过时它等于审核者当前那份 ⇒ 必然
          //    一致 ⇒ 不带 key）：③ 只读的那几档（没有审核者 / 清单没到 / 旧 daemon）
          //    因此天然什么都不带，不需要在这里再判一遍那些条件——多判一处就会分叉。
          ...actionsRunField(effectiveActionPicks, chain),
          // ★★ ③ 上钉的固定参数**只在改过的时候**进请求体（与白名单同一条规矩，
          //   D43）：一致 ⇒ `{}`（key 不出现 = 跟随审核者长期那份）；不一致 ⇒ 带上
          //   （空对象 = 这一次不固定任何参数，是**明确的选择**）。映射写在纯函数里
          //   （`paramsRunField`），有单测钉住"一致不带 key"。提交前先按勾选的动作
          //   收窄：没勾的动作的参数没有落点，发了也是死数据。
          ...paramsRunField(pruneParamsToPicks(effectiveActionParams, effectiveActionPicks), chain),
          // ★ 返工次数（D45）：`0` 与"没带"后果相同（都是不返工），所以这里
          //   不像上面三个覆盖那样需要三态——**只在真的要返工时带上**，
          //   不往请求体里塞一个恒为 0 的默认值。
          ...(reworkCount > 0 ? { maxReworks: reworkCount } : {}),
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      title = ''
      await Promise.all([loadIssues(), loadRuns()])
      // 切到任务清单并选中它——跳过这一步的话，使用者提交后停在原地，
      // 不知道到底成没成
      selectedIssueId.set(issue.id)
      go('tasks')
      showToast(tx('newtask.createdToast'))
    } catch (err) {
      // 服务端那几条校验的**原文**就这样显示出来：审核者那三条
      // （reviewer_not_found / reviewer_role_mismatch / reviewer_must_differ）
      // 与动作白名单那三条（allowed_actions_not_applicable /
      // allowed_actions_without_reviewer / allowed_actions_unresolvable）都是。
      // 这一页**不重写**它们，也不把它们翻译成自己的说法：判据分两处写就会分叉，
      // 而分叉的表现是"页面放行、服务端拒绝"——使用者点了提交，界面上却什么都没说。
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<!--
  ⚠️ 这一页**主区里没有页头**（2026-09）：
     · 标题 → 顶栏左侧的页名（`newtask.title` 与它重复，一起删了）
     · 副标题"写清楚要做什么，其余默认值不用动。" → 按要求去掉
     两样都搬走之后 `.view-intro` 是空的，所以整块删掉——**首屏因此多出约 60px**，
     正好给下面那三个问题（这块以前就为了首屏被砍短过一次）。
-->

<form onsubmit={submit} class="newtask-form">
  <!--
    ══════════════════════════════════════════════════════════════════
    一个问题，不是一个标题 + 一段补充说明
    ══════════════════════════════════════════════════════════════════

    ★ 原来这里是两个字段：「要做什么」是一个**单行** `input`，「补充说明」是一个
      4 行 textarea。两件事都不对：

      ① 单行框装不下真正要说的东西。使用者一按回车就提交了（表单里 `input` 的
         回车就是提交），而他想换行；写得长一点只能横着滚，看不到全句。
      ② "标题 + 补充说明"这个二分**是平台的分法，不是使用者的**。他要说的是
         "帮我做这件事"，至于哪半句算标题是**记录格式**的事——把一个格式问题
         摆成两个输入框，等于让他先做一次分类，而分类错了没有任何提示。

    所以：**一个多行框**装下全部内容。派发时按第一行切出 `Issue.title`
    （任务清单要一行标题），全文进 `prompt`，剩下的行进 `Issue.description`
    （见 `submit()`）。切分是**平台的**责任，不再是使用者要回答的问题。

    ⚠️ 回车键：`textarea` 里回车是换行（不是提交）。提交仍然是那个按钮 +
       `Ctrl/Cmd+Enter`（见下面的 `onkeydown`）——这是"多行框"必须配的一件事，
       否则习惯了单行框的人会觉得"按回车没反应"。
  -->
  <div class="form-lead">
    <label>
      {$t('newtask.titleLabel')}
      <textarea
        bind:value={title}
        use:autoGrow={title}
        rows={TITLE_ROWS}
        required
        autocomplete="off"
        placeholder={$t('newtask.titlePlaceholder')}
        onkeydown={onTitleKeydown}
      ></textarea>
      <!--
        ★ 切分规则必须**说出来**：不说的话，"我写的第二行去哪了"只能靠翻任务详情
          猜。一句话讲清"第一行当标题、其余进说明"，使用者就知道标题是可控的
          （想换标题按一下回车就行）。
      -->
      <span class="hint">{$t('newtask.titleSplitHint')}</span>
    </label>
  </div>

  <!-- ══════════════════ ① 执行 ══════════════════ -->
  <section class="chain-step step-exec">
    <span class="step-title">{$t('newtask.stepExecutor')}</span>
    <!--
      ★ 选择器**始终显示**，哪怕只有一个 agent。
        原来是"多于一个才显示"，理由是"只有一个时没得选"。但那个理由站不住：
        使用者需要**看见**这件事会交给谁——只显示一句"将由 X 执行"时，
        他没法确认这个 X 是不是自己想要的那个，尤其在他刚建过一个 agent 之后。
    -->
    <label>
      {$t('newtask.agentLabel')}
      {#if executorAgents.length === 0}
        <!-- 只有审核者时要说清楚为什么没人可选，而不是给一个空下拉 -->
        <select disabled><option>{$t('newtask.noExecutorOption')}</option></select>
        <span class="hint">
          {$t('newtask.createExecutorBefore')}<strong>{$t('newtask.executorStrong')}</strong>{$t('newtask.createExecutorAfter1')}
          {$t('newtask.createExecutorAfter2')}
        </span>
      {:else}
        <select bind:value={agentId}>
          {#each executorAgents as a (a.id)}
            <option value={a.id}>
              {a.name}{a.id === $effectiveDefaultAgentId ? $t('newtask.defaultSuffix') : ''}
            </option>
          {/each}
        </select>
        <span class="hint">
          {$t('newtask.defaultHint')}
        </span>
      {/if}
    </label>

    {#if chosen}
      <p class="hint">
        {#if chosen.instructions.trim()}
          {$t('newtask.instructionsPreview')}{chosen.instructions.slice(0, 80)}{chosen.instructions.length > 80 ? '…' : ''}
        {:else}
          <span class="warn">{$t('newtask.noInstructionsWarn')}</span>{$t('newtask.noInstructionsAfter')}
        {/if}
      </p>
    {/if}

    <!--
      ★ 返工次数（D45）：审核判 `fail` 时把意见交回**这个执行者**重做几次。
        放在 ① 执行 里，因为它管的是"这个执行者要不要重做"——②③ 管的是
        "判完怎么办"，而这一项在**判之前**就决定了回路会不会转。
    -->
    <label>
      {$t('newtask.reworkLabel')}
      <select bind:value={reworkCount}>
        {#each REWORK_CHOICES as n (n)}
          <option value={n}>{n === 0 ? $t('newtask.reworkZero') : $t('newtask.reworkTimes', { n })}</option>
        {/each}
      </select>
    </label>
    <p class="hint">
      {#if reworkCount === 0}
        {$t('newtask.reworkZeroHint')}
      {:else}
        {$t('newtask.reworkHintBefore')}<strong>{$t('newtask.reworkHintStrong', { n: reworkCount })}</strong>{$t('newtask.reworkHintAfter')}
      {/if}
    </p>
  </section>

  {#if chosen}
    <!-- ══════════════════ ② 审核 ══════════════════ -->
    <section class="chain-step step-review">
      <span class="step-title">{$t('newtask.stepReviewer')}</span>
      <label>
        {$t('newtask.reviewerLabel')}
        <!--
          ★ 三态对应三个选项，而**默认是"跟随"**：审核者原本是一件"这个执行者一贯
            由谁审"的长期安排，不该每个任务重选一遍（协议里那条注释是同一件事）。
            另外两项都要使用者显式点——它们的后果不同（一个不审、一个换人审）。

          ⚠️ 「跟随」那一项的文字用的是 `followChain`（**那个选项**会跟到谁），
            不是 `chain`（**当前选中**的那一项）：拿后者去写它，选中别人之后
            这一行会跟着变，一个"跟随 X"的选项显示成"跟随 Y"。
        -->
        <!-- ⚠️ 下面那一行必须写成**一整行**：`<option>` 里的换行与缩进会变成标签
             文字里的空白，而下拉收起时那点空白很显眼（尾巴上多一个空格）。 -->
        <select bind:value={reviewerPick}>
          <option value={toReviewerPick({ mode: 'follow' })}>{$t('newtask.reviewerFollowOption', { name: chosen.name })}{#if followChain.reviewer}{$t('newtask.reviewerFollowPointsTo', { name: followChain.reviewer.name })}{:else if followChain.notReviewing === 'dangling'}{$t('newtask.reviewerFollowGone')}{:else}{$t('newtask.reviewerFollowNotSet')}{/if}</option>
          <!--
            ★ 后两项只在**对面兑现得了**的时候才给（`overrideSupported`）。
              旧 daemon 会静默忽略 `reviewerAgentId`：给了这个选项，就会出现
              "页面上写了不审、实际审了"——两边都不报错。详见 script 里那段注释。
          -->
          {#if overrideSupported}
            {#each reviewerOptions as a (a.id)}
              <!-- 名字是**契约值**，原样显示、不翻译 -->
              <option value={toReviewerPick({ mode: 'pick', agentId: a.id })}>{a.name}</option>
            {/each}
            {#if pickedMissing && pickedAgent}
              <!-- ★ 回显用（见 script 里那条注释）：只补画回来，不替他改主意。 -->
              <option value={toReviewerPick({ mode: 'pick', agentId: pickedAgent.id })}>{pickedAgent.name}{$t('newtask.reviewerNotCandidate')}</option>
            {/if}
            <option value={toReviewerPick({ mode: 'none' })}>{$t('newtask.reviewerNoneOption')}</option>
          {/if}
        </select>
      </label>

      {#if !overrideSupported}
        <!--
          ★ 不是"功能没做"，是**这个 daemon 兑现不了**：它不认识那个字段，
            而且会**静默忽略**。所以这里不给选项，并把话说清楚（重启之后才有）。
        -->
        <p class="hint">{$t('newtask.overrideNeedsRestart')}</p>
      {/if}

      {#if overrideSupported && reviewerChoice.mode !== 'follow'}
        <!--
          ★ 选了非"跟随"的两项都要说清**范围**：它们只影响这一次，而界面上与"跟随"
            长得一样。少了这一句，在这里换人会被当成改了那个执行者的长期安排。
        -->
        <p class="hint">{$t('newtask.reviewerOnceOnly')}</p>
      {/if}

      <!--
        状态说明：三种**互斥**。它们都由 `chain.notReviewing` 驱动（纯函数推出来的），
        组件这里不自己判条件——两处各判一遍就会出现"文案与提交出去的东西不一致"。
      -->
      {#if chain.notReviewing === 'not_configured'}
        <p class="hint">
          <span class="warn">{$t('newtask.noReviewerWarn')}</span>{$t('newtask.noReviewerAfter')}{$t('newtask.reviewerFollowNoneHint')}
        </p>
      {:else if chain.notReviewing === 'explicit_none'}
        <p class="hint">{$t('newtask.reviewerNoneHint')}</p>
      {:else if chain.notReviewing === 'dangling'}
        <!-- ★ 明说"没了"并提示重选，而不是**静默退回「跟随」**：那会让界面显示
             一个使用者没选过的安排，而提交出去的正是那一个。 -->
        <p class="hint">
          <span class="warn">{$t('newtask.reviewerGoneWarn', { id: danglingId })}</span>{$t('newtask.reviewerGoneAfter')}
        </p>
      {/if}
    </section>

    <!-- ══════════════════ ③ 行动（可改，只对这一次生效） ══════════════════ -->
    <!--
      ★ 卡片里只有"这一栏此刻是什么状态"与它的主控件；**允许的动作那几枚胶囊
        在下面全宽的那一条里**（见 `actionsMode` 那段注释）。
    -->
    <section class="chain-step step-actions">
      <span class="step-title">{$t('newtask.stepActions')}</span>
      <span class="field-label">{$t('newtask.actionsLabel')}</span>

      {#if actionsMode === 'no-reviewer'}
        <!-- ② 上没有审核者 ⇒ 这一栏说的是"连判决都不会有"，而不是"没有动作"。 -->
        <p class="hint">
          <span class="warn">{$t('newtask.actionsNoReviewerStrong')}</span>{$t('newtask.actionsNoReviewerHint')}
        </p>
      {:else if actionsMode === 'tools-unknown'}
        <!-- 清单没到之前**一句关于动作的话都不说**（判据见 script 里 `toolsKnown`）。 -->
        <p class="hint">{$t('newtask.actionsToolsUnknown')}</p>
      {:else if actionsMode === 'read-only'}
        <!--
          ★ 旧 daemon 兑现不了**这一栏的**覆盖（`capabilities` 里没有
            `task-action-whitelist`）⇒ 退回只读，而且照旧画 chip。
            ⚠️ 判据是**这个字段自己的**标志，不是 `overrideSupported`：两者是同一次
            交付里一起来的，但一个决定"谁来审"、一个决定"这一次允许动什么"，是两个
            字段、两份契约。复用会在中间态上撒谎（见 script 里 `whitelistSupported`）。
            为什么不能画勾选框：那份覆盖发过去会被对面**静默忽略**（未知字段不校验、
            不报错），于是页面上写了"这一次只允许这两个动作"、实际照旧全都能触发——
            界面说的与实际发生的不一致，而**两边都不报错**。宁可只读 + 说清"重启
            daemon 之后才有"（与 ② 那条 `overrideNeedsRestart` 同一个补救动作）。
        -->
        <p class="hint">{$t('newtask.actionsOverrideNeedsRestart')}</p>
      {:else}
        <!--
          ══════════════════════════════════════════════════════════════════
          D44：与智能体页的「行动权限」**共用同一个** `ActionPicker`（左选右配），
          只差文案（`variant="task"`：这里的改动只对这一次任务生效）。
          ══════════════════════════════════════════════════════════════════

          ⚠️ 列的是**全部已装工具**的动作，不是"这个审核者挂的工具"：审核者根本不挂
             工具（它只判断、不动手），而覆盖的意义正在于**可以勾一个它长期配置里
             没有的动作**。空态（一个包都没装）由组件自己说清"为什么没有、下一步
             去哪"（与智能体页同一个口径）。

          ★ 选择器**不在这一页里**，改成一个按钮 + 居中对话框：它原来直接铺在这一段
            里，实测 412px 高（两栏各 ~480px，五行动作），加上前后的说明，整段 ③ 是
            537px——而它在 700px 高的视口里从 y=670 开始，等于"这一页的下半屏全是
            这一栏"。而 ③ 在多数任务里根本不用改（默认那一份就是审核者的长期配置）。
        -->
        <div class="actions-summary">
          <button type="button" class="secondary" onclick={() => (actionsOpen = true)}>
            {$t('newtask.actionsChoose')}
          </button>
          <span class="actions-count">
            {$t('newtask.actionsCount', {
              picked: effectiveActionPicks.length,
              // ★ 分母是**装进来的动作总数**（与选择器状态条同一个函数）：
              //   不是 `chain.actions.length`——那是这个审核者当前允许的几个，
              //   拿它当分母会写出"已允许 2 / 1 个动作"（实测踩过）。
              total: installedActionCount($tools),
            })}
          </span>
        </div>

        {#if actionsDirty && chain.reviewer}
          <!-- 改过 ⇒ 在**提交之前**就说清"只对这一次生效"（原来那句在对话框里，
               关上对话框就看不见了，而它是这一栏最容易误解的一件事）。
               ⚠️ `&& chain.reviewer` 看着多余（`actionsMode === 'editable'` 已经
               蕴含它有值），但类型系统看不出这层蕴含——少了它 svelte-check 报
               "'chain.reviewer' is possibly 'null'"。 -->
          <p class="hint warn">{$t('newtask.actionsOnceOnly', { name: chain.reviewer.name })}</p>
        {/if}
      {/if}

      <!--
        ══════════════════════════════════════════════════════════════════════
        ★★ 当前的配置**细节**：一个计数不算配置
        ══════════════════════════════════════════════════════════════════════

        「已允许 1 / 5 个动作」只说了**几个**，没说**是哪几个、各自干什么、
        钉了什么值**。选择器进了对话框之后，这一条是**不点开就唯一能看见配置的
        地方**——只给一个计数，等于把"这次到底允许它做什么"变成必须点开才知道，
        而那是收起来之前从来没有过的问题（原来铺在页面上，一眼就看全了）。

        形状与智能体页那个「行动权限」**逐字同款**（`AgentDetail.svelte`：
        契约值 + `summary` + 「当前不可用」 + 「固定值: name=value」）：同一件事
        （"现在允许它做什么"）在两个页面上必须是同一种画法，否则使用者要学两遍。

        ⚠️ **它必须在 ③ 这张卡片里面**——曾经挪出去过，做成三步那一行下面一条
           全宽的（理由是这一格只有一列宽、胶囊会折行）。那是拿"排版省事"换
           "它属于谁"：挪出去之后那一块读起来是**另一件事**（页面上多出一片没有
           归属的胶囊），而使用者问"这些是什么"时，答案在 ③ 里，不在外面。
           窄了就让它窄着折行：**位置对**比**一行放得下**重要。

        ⚠️ 契约值（`<包 slug>.<动作名>`）原样显示、**不翻译**：判决里写的就是
           这一串，翻译了就对不上了。
      -->
      {#if actionsMode === 'read-only' || actionsMode === 'editable'}
        <div class="actions-detail">
          {#if pickEntries.length === 0}
            <!--
              ★ 一个动作都没有 ⇒ 必须说清**后果**（判决只会给结论、不会触发任何操作）：
                "没勾动作"很容易被读成"这个人比较保守"，而它真正的意思是"这次跑完就
                到头了"——那是提交前最该知道的一件事。
              ⚠️ 两种情况分开说：**它本来就没有**（`actionsNoneStrong`）与**你这一次
                一个都不勾**（发出去的是空数组，那是一条决定，不是"没配"）。
            -->
            {#if actionsMode === 'read-only' || chain.actions.length === 0}
              <p class="hint">
                <strong>{$t('newtask.actionsNoneStrong')}</strong>{#if actionsMode === 'read-only'}{$t('newtask.actionsNoneHint')}{:else}{$t('newtask.actionsNoneEditableHint')}{/if}
              </p>
              {#if $tools.length === 0}
                <p class="hint">{$t('newtask.actionsNoTools')}</p>
              {/if}
            {:else}
              <p class="hint">
                <strong>{$t('newtask.actionsClearedStrong')}</strong>{$t('newtask.actionsClearedHint')}
              </p>
            {/if}
          {:else}
            <!--
              ══════════════════════════════════════════════════════════════════
              ★★ 当前的配置**细节**：一个计数不算配置
              ══════════════════════════════════════════════════════════════════

              「已允许 1 / 5 个动作」只说了**几个**，没说**是哪几个、各自干什么、
              钉了什么值**。选择器进了对话框之后，这一条是**不点开就唯一能看见配置的
              地方**——只给一个计数，等于把"这次到底允许它做什么"变成必须点开才知道，
              而那是收起来之前从来没有过的问题（原来铺在页面上，一眼就看全了）。

              形状与智能体页那个「行动权限」**逐字同款**（`AgentDetail.svelte`：
              契约值 + `summary` + 「当前不可用」+ 「固定值: name=value」）：同一件事
              （"现在允许它做什么"）在两个页面上必须是同一种画法，否则使用者要学两遍。

              ⚠️ 契约值（`<包 slug>.<动作名>`）原样显示、**不翻译**：判决里写的就是
              这一串，翻译了就对不上了。
            -->
            <div class="chips">
              {#each pickEntries as item (item.type)}
                <span class="chip">
                  <span class="chip-head">
                    <code>{item.type}</code>
                    {#if item.fixed.length > 0}
                      <!--
                        ★★ 钉死的固定值**与契约值同一行**（原来压在整枚胶囊的最后
                          一行，说明下面）。使用者要的是"看得见配置"：同一句"模拟
                          关闭单据"，钉了 `reason=巡检` 与没钉是两回事——不写出来
                          的话，他以为这次会带着上次钉的值去执行，而实际发出去的是
                          另一个（或者模型当场编一个）。
                        ⚠️ 它在**第一行**：与动作名一起读成"这个动作，这样调"。
                      -->
                      <span class="chip-sub fixed"
                        >{$t('tools.paramFixedChip')}:
                        {#each item.fixed as [name, value] (name)}
                          <code>{name}={value as string | number | boolean}</code>
                        {/each}
                      </span>
                    {/if}
                  </span>
                  {#if item.summary}
                    <span class="chip-sub">{item.summary}</span>
                  {:else if item.unavailable}
                    <!-- 配过、但现在没有出处：契约值照原样留着（那是"配过"的证据），
                         旁边明说它当前不可用——不能让它看着还能用。 -->
                    <span class="chip-sub bad">{$t('agents.actionsUnresolvedChip')}</span>
                  {/if}
                  <!--
                    ⚠️ 这里**只**列钉死的固定值（在上一行、与契约值同一行），不列
                       "由模型填 / 平台注入"——试过一版把三类参数都摆出来，结果是
                       每枚胶囊多两行机器名（`由模型填: reason`、`平台注入: dir、
                       workspace-id`），而这两行**使用者没法据它做任何决定**：
                       开放参数本来就会由模型填，平台注入的值他也改不了。
                       一屏里能改变决定的只有"哪些值被钉死了"。
                  -->
                </span>
              {/each}
            </div>
          {/if}

          {#if actionsMode === 'editable' && chain.reviewer && toolsKnown}
            <!-- 默认那一份是从哪来的：不点破的话，"预先就是这个样子"会被当成平台的
                 默认值（而不是那个审核者的长期配置）。 -->
            <p class="hint">{$t('newtask.actionsEditableSource', { name: chain.reviewer.name })}</p>
          {:else if chain.reviewer && toolsKnown}
            <!-- 只读那一档（旧 daemon）的出处句：它说的"要改，去「智能体」页改它"
                 在那里才是对的。 -->
            <p class="hint">{$t('newtask.actionsFromReviewer', { name: chain.reviewer.name })}</p>
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  <details class="form-advanced">
    <summary class="hint" style="cursor:pointer">{$t('newtask.advancedSummary')}</summary>
    <label style="margin-top:var(--sp-3)">
      {$t('newtask.workDirLabel')}
      <input bind:value={workDir} placeholder={$t('newtask.workDirPlaceholder')} />
    </label>
    <p class="hint">
      {$t('newtask.workDirHintBefore')}<strong>{$t('newtask.workDirHintStrong')}</strong>{$t('newtask.workDirHintAfter1')}
      {$t('newtask.workDirHintAfter2')}
      {$t('newtask.workDirHintAfter3')}
    </p>
  </details>

  <!--
    ══════════════════════════════════════════════════════════════════════
    提交栏：**吸底**
    ══════════════════════════════════════════════════════════════════════

    ★ 原来它是页面最后一行，实测在 y=891 而首屏只有 448px——这一页唯一要做的那件
      事要滚**两屏**才够得着。而把页面压到一屏是不现实的（那些提示文字都有用，
      不想靠藏起来换高度），所以改成**它跟着视口走**：无论滚到哪，按钮都在。

    ★ 错误提示搬进这一栏（原来在按钮上方一点）。吸底之后那个位置会跑到视口外，
      而**提交失败必须在按钮旁边看得见**——不然使用者点一下、没反应，再点一下。

    ★ 右边那一行是"我即将提交的是什么"：交给谁、谁审、允许几个动作。滚下去看
      高级选项时，它是唯一还在的上下文。
  -->
  <div class="form-foot">
    {#if error}
      <div class="notice bad">{error}</div>
    {/if}
    <div class="foot-row">
      <button type="submit" disabled={busy || !title.trim() || !chosen}>
        {busy ? $t('newtask.creating') : $t('newtask.createAndDispatch')}
      </button>
      {#if chosen}
        <span class="foot-summary">
          {$t('newtask.footExecutor', { name: chosen.name })}
          <span class="foot-sep">·</span>
          {#if chain.reviewer}
            {$t('newtask.footReviewer', { name: chain.reviewer.name })}
          {:else}
            {$t('newtask.footReviewerNone')}
          {/if}
          <span class="foot-sep">·</span>
          {$t('newtask.footActions', { n: effectiveActionPicks.length })}
        </span>
      {/if}
    </div>
  </div>
</form>

<!--
  ══════════════════ ③ 的挑选对话框 ══════════════════

  ⚠️ 放在 `<form>` **外面**：它是浮层，不是表单里的一栏。留在表单里的话，
     里面每个 `input` 都成了这个表单的控件（回车/校验都会牵进去），而对话框
     里那些勾选框**不是要提交的东西**——它们是草稿，提交时由
     `actionsRunField(effectiveActionPicks, chain)` 统一编码。
-->
{#if chosen && chain.reviewer && toolsKnown && whitelistSupported}
  <Modal
    open={actionsOpen}
    size="wide"
    title={$t('newtask.actionsLabel')}
    subtitle={$t('newtask.actionsDialogSubtitle', { name: chain.reviewer.name })}
    onclose={() => (actionsOpen = false)}
  >
    <ActionPicker
      variant="task"
      value={effectiveActionPicks}
      onchange={(next) => (actionPicks = next)}
      params={effectiveActionParams}
      onparams={(next) => (actionParamsDraft = next)}
    />

    {#if paramsDirty}
      <!-- 固定参数改过：与白名单那句"只对这一次生效"同一条口径。 -->
      <p class="hint warn">{$t('newtask.actionsParamsDirty')}</p>
    {/if}

    {#if chain.unavailableActions.length > 0}
      <!--
        ★ 「配过、但现在解析不出来」那一组（D41 收尾，措辞与智能体页同一口径）：
          动作是从**已装工具包的清单**画的，而这些名字现在没有出处（包被卸载了、
          或者名字来自很早以前的配置）。静默丢掉等于使用者没同意就改了权限，所以
          照原样列出来并明说**当前不可用**。
        ★ 它们**不可勾选、也不进发出去的数组**：带着它们提交必然被服务端拒
          （`allowed_actions_unresolvable` —— 判据与 agent 的「行动权限」同一套）。
          于是这里给的是"这一次它们不会被执行"，而不是一个"移除"入口：这一页删
          不了那个审核者的长期配置，给了按钮只会把人引到一个不存在的东西上。
      -->
      <div class="unresolved">
        <span class="field-label">{$t('newtask.actionsUnresolvedHeading')}</span>
        {#each chain.unavailableActions as type (type)}
          <div class="unresolved-row">
            <code>{type}</code>
            <span class="chip-sub bad">{$t('agents.actionsUnresolvedChip')}</span>
          </div>
        {/each}
        <p class="hint">{$t('newtask.actionsUnresolvedHint')}</p>
      </div>
    {/if}

    {#if chain.reviewerSource === 'override'}
      <!--
        ★ ② 上"这一次换人"会**连带换掉**这一栏：能触发什么本来是**那个人**的能力。
          不点破的话，"我换了审核者"与"这次能做什么也跟着变了"之间的因果只靠
          出处句暗示——而这是提交前最该知道的第二件事。
      -->
      <p class="hint">{$t('newtask.actionsFollowReviewerOnce')}</p>
    {/if}

    <svelte:fragment slot="foot">
      <button type="button" onclick={() => (actionsOpen = false)}>{$t('newtask.actionsDialogDone')}</button>
    </svelte:fragment>
  </Modal>
{/if}

<p class="hint" style="margin-top:var(--sp-5);max-width:52rem">
  ⚠️ <strong>{$t('newtask.footerStrong')}</strong>{$t('newtask.footerAfter1')}
  {$t('newtask.footerAfter2')}
</p>

<style>
  /*
    三步链的排版：每一步是一个块，靠标题区分。
    ★ 不用 <ol>：这三步不是"必须依次完成"的流程（后一步有默认值，可以直接提交），
      编上号是给读者一个"这一页在问哪几件事"的地图，不是进度条。

    ★★ 占满主区（D44 修）：原来整个表单被 `max-width:42rem` 卡在 672px，而主区
       有 1200px —— 内容全挤在左边、右栏空一大片，③ 里那个"左选右配"的
       ActionPicker 也被压成 309/335（原型是按接近整宽设计的），右栏挤得像没画。
       现在表单占满，靠**网格**把宽度分给该宽的那一块：
         · 标题 / 描述：一行两列，各自限宽（纯文本输入框拉满 1200px 很难读）；
         · ① 执行 / ② 审核：一行两列（各自只有一两个控件）；
         · ③ 行动：**独占整行**——它内部是两栏，最需要宽度；
         · 高级选项 / 错误 / 提交按钮：整行。
       窄屏（<72rem）退回单列，与原来一样。
  */
  /**
   * 两列：**左列 ① 执行（占满两行），右列 ② 审核在上、③ 行动在下**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 试过的三种排法，以及为什么是这一种
   * ══════════════════════════════════════════════════════════════════
   *
   * · **三列一行**（上一版）：三个问题确实同时可见，但三张卡片高矮差得太多
   *   （① 373 / ② 128 / ③ 427），② 那张下面空着一大片，整行看着是散的。
   * · **①② 一行 + ③ 独占下面一行**：③ 一宽，右上的 ② 下面还是空的。
   * · **现在这种**：左列一张高的 ①，右列 ② 压着 ③。两列各自成块，右列两块
   *   高度接近（128 + 427），左列拉伸到与右列齐平——**页面是一整块矩形**，
   *   没有哪个格子空着。
   *
   * ⚠️ ③ 必须在**②下面**（同一列）：它是"审完之后允许做什么"，与 ② 是同一条
   *    线上的两件事（先判、再动）。把它放到左列或独占一行，读起来就与 ② 脱钩了。
   */
  .newtask-form {
    width: 100%;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-4);
    align-items: start;
  }

  /**
   * ⚠️⚠️ 行号必须**显式**写出来，而且 `.form-lead` 要占第 1 行。
   *
   * 踩过的坑：`.step-exec` 写了 `grid-row: 1 / span 2`（显式行），而
   * `.form-lead` 只写了列（`grid-column: 1 / -1`）、行留给自动排布。CSS Grid 的
   * 排布顺序是**先把行列都确定的放好**，再放"只定了列"的——于是第 1、2 行已经被
   * 三步占满，「要做什么」被挤到第 3 行：**输入框跑到三步下面去了**。
   * （它还在 DOM 最前面，只是被网格挪走了——所以"看代码觉得没问题"。）
   *
   * 现在四块的行列全部写死，不再依赖自动排布的顺序。
   */
  .form-lead {
    grid-column: 1 / -1;
    grid-row: 1;
  }
  /* ① 占左列两行，并**拉伸**到与右列齐平（不拉伸的话左列第二格会空出一个洞） */
  .step-exec {
    grid-column: 1;
    grid-row: 2 / span 2;
    align-self: stretch;
  }
  /* ② 右上、③ 右下：一条线上的两件事（先判、再动） */
  .step-review {
    grid-column: 2;
    grid-row: 2;
  }
  .step-actions {
    grid-column: 2;
    grid-row: 3;
  }
  /* 高级设置与提交栏接在下面（也写死，免得自动排布又把它插到别处） */
  .form-advanced {
    grid-column: 1 / -1;
    grid-row: 4;
  }
  .form-foot {
    grid-column: 1 / -1;
    grid-row: 5;
  }

  /* 标题 + 描述：一行两列，各自限一个阅读宽度 */
  /* ③ 收成一行：按钮 + 计数（选择器搬进对话框了，见标记里那段注释） */
  .actions-summary {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-wrap: wrap;
  }
  .actions-count {
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .form-lead {
    grid-column: 1 / -1;
    display: grid;
    /* 只有一个字段了，不再分两栏（分栏会把框压到一半宽，而这一页唯一要写的
       东西就是它——实测原来只用了 544px / 1096px，右边一半是空的）。 */
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-4);
    align-items: start;
  }
  .form-lead > label {
    max-width: none;
    margin-bottom: 0;
  }
  /**
   * 「要做什么」那个框：默认 3 行，随输入长高，**15 行封顶**（见 `autoGrow()`）。
   *
   * ⚠️ `resize: none`：高度归自动加高管，手工拖出来的高度下一次敲键就被覆盖。
   *    留着一个按下去会弹回去的把手，比没有更让人困惑。
   * ⚠️ `max-height` 用 `lh` 算——行高只有 CSS 知道，JS 那边读 `scrollHeight`
   *    不需要知道它（超了就是超了）。
   */
  .form-lead textarea {
    resize: none;
    max-height: calc(15lh + 1.6rem);
  }

  /* 高级选项 / 提交栏占整行（③ 那张卡片自己占一列） */
  .form-advanced,
  .form-foot {
    grid-column: 1 / -1;
  }

  /**
   * ③ 里的配置细节（胶囊 + 出处句）。
   *
   * ⚠️ 它在 ③ **卡片里面**——曾经做成三步那一行下面一条全宽的，理由是这一格
   *    只有一列宽、胶囊会折行。那是拿"排版省事"换"它属于谁"：挪出去之后那一块
   *    读起来是另一件事。窄了就让它窄着排。
   */
  .actions-detail {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    min-width: 0;
  }

  /**
   * ★ 这一格里的胶囊**竖着排**（一个动作一行）。
   *
   * 横排（`.chips` 默认 `flex-wrap`）在一列宽里会变成"契约值半行、说明挤到下一
   * 行、下一枚胶囊又从半路接上"的乱条——竖排之后每一枚是完整的一行，扫下来就是
   * "允许这三个：A 干什么、B 干什么、C 干什么"。
   */
  .step-actions .chips {
    flex-direction: column;
    align-items: stretch;
  }
  /**
   * ★ 而且胶囊**内部**也要竖着排（契约值一行、说明另起一行）。
   *
   * ⚠️ 这一条是量出来的：`.chip` 默认是 `inline-flex` + `align-items: baseline`，
   *    三样东西（契约值 / `summary` / 固定值）**横着并排**。在智能体页那一栏
   *    （全宽）没问题，但 ③ 只有一列宽：306px 分给三样，说明那一段只剩几十像素，
   *    于是一句话折成二十来行——实测这一块 **590px**，整张 ③ 卡片 722px。
   *    竖排之后契约值占一行、说明用满宽度，同一块降到 ~120px。
   */
  .step-actions .chip {
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }
  /* 第一行：契约值 + 钉死的固定值（两样都在这一行，读成"这个动作，这样调"） */
  .step-actions .chip-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--sp-2);
    min-width: 0;
  }
  .step-actions .chip code,
  .step-actions .chip-sub {
    overflow-wrap: anywhere;
  }

  .form-advanced { margin: var(--sp-2) 0; }

  /**
   * 提交栏吸底。
   *
   * ⚠️ 负外边距是**故意的**：`.main` 自己有 `padding: var(--sp-5) var(--sp-6)`，
   *    不留负边距的话这一条会缩在那圈留白里，滚过去的内容会从它左右两侧露出来
   *    （看起来像"一条浮在中间的小横条"）。
   *
   * ⚠️ `background` 必须是**不透明**的：半透明的话下面的内容会透上来，而那正是
   *    它要挡住的东西。
   */
  .form-foot {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: var(--sp-3) calc(var(--sp-6) * -1) calc(var(--sp-5) * -1);
    padding: var(--sp-3) var(--sp-6);
    background: var(--bg);
    border-top: 1px solid var(--line);
  }

  .foot-row {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    flex-wrap: wrap;
  }

  .foot-summary {
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .foot-sep { margin: 0 var(--sp-1); opacity: 0.6; }

  .chain-step {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: 0;
    padding: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  /* ① ② 里的下拉不该被拉到整栏宽 */
  .step-exec label,
  .step-review label {
    max-width: 30rem;
  }

  @media (max-width: 72rem) {
    .newtask-form,
    .form-lead {
      grid-template-columns: minmax(0, 1fr);
    }
    /**
     * ⚠️ 单列时**必须把行列号一起松开**：`grid-column: 2` 在一列网格里会凭空
     *    造出第二列（宽度 0），③ 于是被挤成一条竖线——而它的内容还在，只是
     *    看不见，看起来像"行动那一栏没了"。
     */
    .form-lead,
    .step-exec,
    .step-review,
    .step-actions,
    .form-advanced,
    .form-foot {
      grid-column: 1;
      grid-row: auto;
      align-self: auto;
    }
    .form-lead > label,
    .step-exec label,
    .step-review label {
      max-width: none;
    }
  }

  .step-title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-dim);
  }

  /* 一栏的小标题（③ 那一栏里"判完之后允许触发的动作"），与智能体页同一形状 */
  .field-label {
    display: block;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin: 0;
  }

  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--line-strong);
    /**
     * ⚠️ 原来是 `100px`（"胶囊"造型）。一枚里只有一行字时它很好看，但 ③ 里的
     *    胶囊有 3~4 行（契约值 + 固定值 + 说明），`100px` 的圆角在那么高的框上
     *    会变成**两段夸张的弧**——左右两条直边几乎没了，看着像椭圆而不是框。
     *    改用普通圆角（`--radius`，8px）：与页面其它卡片同一套。
     */
    border-radius: var(--radius);
    background: var(--surface);
    font-size: var(--fs-sm);
  }

  .chip-sub {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  /* 「配过、现在解析不出来」那一组：与正常可用的动作分开，但不做成刺眼的警告色
     （它不一定是错——可能只是那个包暂时没装） */
  .unresolved {
    border-top: 1px dashed var(--line);
    padding-top: var(--sp-2);
  }

  .unresolved-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-1);
  }

  .unresolved-row code {
    color: var(--text-faint);
    text-decoration: line-through;
  }
</style>
