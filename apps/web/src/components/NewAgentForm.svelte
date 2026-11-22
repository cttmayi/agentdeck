<script lang="ts">
  import { createAgent, identity, skills, workflows } from '../lib/stores.ts'
  import { api, type ReviewStandard, type Workflow } from '../lib/api.ts'
  import { showToast } from '../lib/view.ts'
  import PromptField from './PromptField.svelte'
  import SettingsPanel from './SettingsPanel.svelte'
  import { USER_ENTRY_CHOICES, USER_ENTRY_LABEL_KEYS, hasAnyEntry } from '../lib/members.ts'
  import { t, tx } from '../lib/i18n.ts'

  /**
   * 新建智能体（D28）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 一个字段决定了这个 agent 的"身份"
   * ══════════════════════════════════════════════════════════════════
   *
   * **角色**：它是干活的还是审的。这一个选择取代了原来四个互相牵扯的开关
   * （认哪些 kind、兜底审核者、自动审核、并发上限）——那些合起来表达的
   * 其实只有两件事，而其中两件是通配模式字符串，需要学。
   *
   * ⚠️ 2026-10（使用者的决定）：**「由谁审它」这个设置整段拿掉了**——审核
   *    不再由执行者自己配，而是走智能体组（组的审核者）。**「默认工作目录」也
   *    拿掉了**——工作目录是任务级的（新建任务页的「高级」里填）。这两个字段
   *    的数据与协议原样保留（老数据继续有效），只是这一页不再生成它们。
   *
   * 其余字段（skill、runtime）是"这个 agent 怎么干活"，各自独立，不参与身份判断。
   */
  /**
   * ══════════════════════════════════════════════════════════════════
   * 受控组件 + **主区右栏原位**：开关由父组件拿着，内容画在右栏（与
   * `AgentDetail` 编辑态同款——2026-10 起不再是右侧抽屉，使用者明确要求
   * "类似智能体编辑状态"，而编辑态就是在右栏里改）。
   * ══════════════════════════════════════════════════════════════════
   *
   * 这个表单在左栏里待过两版，都不行：
   *
   *   1. 挂在按钮旁边（组件自己管开关）⇒ 它俩必然在同一个容器里，而那个容器
   *      是 416px 宽的头部行；表单按 `max-width: 46rem` 画成 736px，横着盖住
   *      右栏、头部涨到 1070px、清单被顶出视口；
   *   2. 放进左栏正文 ⇒ 不溢出了，但**太窄**：技能多选、runtime 挤在 358px
   *      里，读起来憋。
   *
   * 抽屉也用过（58rem = 928px）——2026-10 使用者说"还是右侧弹框出来的"，
   * 要求改成与编辑态一样的原位形态：父组件在 `MainArea` 里 `{#if creating}`
   * 直接渲染本组件（右栏正文），宽窄交给右栏。
   */
  export let onclose: () => void = () => {}
  export let oncreated: () => void = () => {}
  /**
   * ★★ 2026-11（D238）：**同一个表单服务两种智能体**。
   *
   * `{ kind: 'workflow' }` = 编排内建智能体（`workflows/<id>/agents/<名字>/`，D234）：
   * 使用者要求"编排的新建智能体要和智能体的新建智能体页面**一致、最好复用**"，
   * 所以复用这一个组件，只差三件事——落库地址、**入口固定只有「编排」**、没有 CLI 那一格
   * （`WorkflowInlineAgent` 没有 `runtimeKey`，跑的时候跟工作区默认；给一个选不动的下拉
   * 才是假控件）。
   */
  export let scope: { kind: 'agent' } | { kind: 'workflow'; workflowId: string; workflowName?: string } =
    { kind: 'agent' }
  $: isWf = scope.kind === 'workflow'
  /**
   * ★★ 2026-11（D164）：**预填**（复制智能体时用）。
   *
   * 使用者："复制智能体，属于新建状态，点保存才保存"——所以复制不是一条立刻落库的接口，
   * 而是"拿那条的配置预填这张表单"。于是它与手写新建完全同一条路：能改、能取消、
   * 点「创建」才写库（连同服务端的校验与**重名检查**）。
   *
   * ⚠️ 传进来的是 `rawInstructions`（库里存的**原文**）：拿组装后的全文预填，会把平台
   *    守则变成"使用者写的"文本，而副本作为自建智能体不会再组装一次。
   */
  export let prefill:
    | {
        name: string
        instructions: string
        skillIds: string[]
        runtimeKey: string
        entries: string[]
      }
    | undefined = undefined

  let name = prefill?.name ?? ''
  /*
   * ⚠️ 2026-11（S4，D127）：这里原来是 `let role: AgentRole = 'executor'`——新建
   *   agent 时选「执行 / 审核」。**角色退场** ⇒ 新建的 agent 就是 agent，没有角色可问。
   */  /**
   * ★ 分批第 47 批：**初值 = 工作区里的「默认工作守则」**（设置页那个框）。
   *
   * 为什么不在服务端"偷偷补"就完事：那样使用者看到的是**空输入框**，保存后
   * 再打开才发现里面多了一段——"我什么都没写，它自己长出了规矩"是最难接受的一类。
   * 服务端 `POST /api/agents` 确实也会在"指令为空"时预填（那是给别的客户端兜底），
   * 但界面上必须**先看见**，才能改、才能删。
   */
  let instructions = prefill?.instructions ?? $identity?.defaultAgentConduct ?? ''

  /**
   * 审核标准（D37）——只对审核者有意义。
   *
   * 与「第一句话模版」那个全局配置不同，标准是**每个审核者一份**（不同的领域
   * 用不同的标准，这是 D22 的立场）。执行者保持 `null`。
   */
  let reviewStandard: ReviewStandard | null = null
  /**
   * ⚠️ 2026-10：这里原来有**行动权限**那一整段（`allowedActions` / `actionParams` /
   *    `debugActions` 三个状态 + 一个 `ActionPicker`）。
   *
   *    **整个能力从 agent 上撤掉了**：动作属于**这条链**（这队人的活判过之后允许
   *    做什么），不属于某个审核者个人——同一个审核者在不同组里本来就该配不同的
   *    权限，挂在人身上只能共用一份。
   *
   *    ⚠️ 2026-11（D123）：**动作能力本身也退场了**——判决只记录结论，不再触发任何
   *    动作。所以这段注释原来的落点（"唯一权威是 `AgentGroup` 上那三个同名字段，
   *    配的地方是智能体组页的 ③ 行动"）已经不存在：组上也没有动作可配。
   *
   *    ★ 新建一个 agent 时**没有任何动作要配**，那个选择器在这页是纯噪音：
   *      使用者会在"这个人能做什么"的地方勾一遍，然后在组里再勾一遍——两处长得
   *      一样、只有一处生效，是最坏的一种界面。
   *
   *    ⚠️ 也别把它加回来"做兼容"：服务端会把这三个键当成**不认识的字段**拒掉
   *      （400），留在这里只会变成一个必然失败的提交。
   */
  let selectedSkills: string[] = [...(prefill?.skillIds ?? [])]
  /**
   * ★ 2026-11（D146）：**入口**——它能被谁叫（对话 / 任务 / 编排）。
   *
   * 使用者原话：「我新建智能体，怎么没看到选项呢」。`chat` / `task` / `workflow` 这三个
   * 接入点以前只由服务端按"是不是内置"推出来（`entriesOf()`），界面上一个字都看不到
   * ——也就是说这一期引入的属性里，只有平台成员那半边是"看得见"的。
   *
   * 默认**三项全勾**：与 `entriesOf()` 对用户记录的回退、以及服务端不传 `entries` 时的
   * 落库值完全一致——所以这一格加进来**不改变任何默认行为**，只是把它变成可改。
   */
  /*
   * ⚠️ 用 `scope.kind` 直接判，不要用 `$: isWf`：legacy 模式下 `$:` 在本行**之后**才跑，
   *    初始化时 `isWf` 还是 undefined ⇒ 编排那条的入口会先被填成三项（D241 实测到过：
   *    "三项都勾着、都禁用"，看起来像它同时接对话和任务）。
   */
  let selectedEntries: string[] = prefill?.entries?.length
    ? [...prefill.entries]
    : scope.kind === 'workflow'
      ? ['workflow']
      : [...USER_ENTRY_CHOICES]
  /**
   * 可选的 runtime —— 从**身份接口**来，不写死两项。
   *
   * 写死的话，新加一个 runtime 之后这个表单里根本选不到它（只有直接调接口
   * 才行）。初始化取第一个可用项，而不是硬编码 'claude'。
   */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []
  /*
   * ★ D242：缺省 `'default'`（= 跟随全局默认），并把它作为下拉**第一项**。
   *   改之前这里写死 `'claude'`、下拉里也没有 `default` 这一项——于是"新建的智能体
   *   一律被烙上 claude"，与服务端 `resolveRuntimeKey` 的决定（2026-10：
   *   "新 agent 一律跟随全局默认，而不是把当时的默认值烙进记录里"）**相反**。
   *   `AgentDetail` 那边一直有这一项，两份表单从这里开始对齐。
   */
  let runtimeKey = prefill?.runtimeKey ?? 'default'
  let busy = false
  let error = ''

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = ''
    busy = true
    try {
      if (scope.kind === 'workflow') {
        // 编排内建智能体：没有 runtime / 入口（固定「编排」）/ 审核标准，只有名字+指令+技能
        await api(`/api/workflows/${encodeURIComponent(scope.workflowId)}/agents`, {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            instructions,
            skillIds: selectedSkills,
            runtimeKey,
          }),
        })
        const out = await api<{ items: Workflow[] }>('/api/workflows')
        workflows.set(out.items ?? [])
      } else await createAgent({
        name,
        instructions,
        skillIds: selectedSkills,
        runtimeKey,
        reviewStandard,
        entries: selectedEntries,
        // ⚠️ 这里原来还送 `allowedActions` / `actionParams` / `debugActions`。
        //    那三个字段已经从 agent 上撤掉（动作只属于组），再送就是 400
        //    「不认识的字段」——所以整段删掉，而不是送空数组。
      })
      name = ''
      // 建完回到"默认守则"，而不是空串——下一次新建不该是空身份
      instructions = $identity?.defaultAgentConduct ?? ''
      reviewStandard = null
      // 回到表单的默认值
      selectedSkills = []
      selectedEntries = [...USER_ENTRY_CHOICES]
      showToast(tx('agents.created'))
      // 关不关由父组件决定（它是"正在新建"这个状态的持有者）
      oncreated()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<!--
  ══════════════════════════════════════════════════════════════════
  ★★ 2026-11（D214，使用者：「新建智能体 就没有行头」）：**这一页原来没有栏头**。

  它是"整块换掉右栏"的面板，而 `ui-style.md` §2.4 对这种面板的规矩是固定的：
  `.main-panel` + 头（`h2` + 返回）+ 体 + 底栏，**主操作在底栏**——两个设置面板
  （`WorkspaceSettings` / `ChatSettings` / `CrystallizeSettings`）早就这样了，
  只有新建智能体是一个"裸表单"，进来不知道自己在哪、也没有"回哪去"的出口。

  现在它套进共享外壳 `SettingsPanel`（与设置面板**同一份**头/体/底），
  按钮用 `form="new-agent-form"` 关联到体内那个 `<form>`（HTML 原生做法，
  底栏在 form 元素外面也能提交）。
  ══════════════════════════════════════════════════════════════════
-->
<SettingsPanel
  title={$t('agents.newTitle')}
  subtitle={isWf && scope.kind === 'workflow' ? $t('workflows.agentsOfWorkflow', { name: scope.workflowName ?? '' }) : ''}
  onback={onclose}
  ariaLabel={$t('agents.newTitle')}
>
  {#snippet body()}
<form onsubmit={submit} class="agent-form" id="new-agent-form">
  {#if error}
    <!-- ★ 与其它页面的保存失败同一呈现（`.notice bad`） -->
    <div class="notice bad">{error}</div>
  {/if}

  <!--
      ⚠️ 2026-10（使用者的决定）：「由谁来审它」整段拿掉了——审核不再由执行者
      自己配，而是走智能体组（组的审核者）。老数据的 `reviewerAgentId` 原样
      保留（单发任务跟随它），只是这里不再生成它。原位置见头部注释。
    -->

    <!--
      ⚠️ 2026-10（使用者的决定）：「由谁来审它」整段拿掉了——审核不再由执行者
      自己配，而是走智能体组（组的审核者）。老数据的 `reviewerAgentId` 原样
      保留（单发任务跟随它），只是这里不再生成它。原位置见头部注释。
    -->

    <!--
      ★ 2026-10：新建表单与**智能体详情编辑态**同款——一张卡片（两列网格，
         对齐组里「新建私有」的 `.grid-form`）。角色在卡片第一行（占整行），
         名字 / CLI 一行，指令 / 技能一行。（行动权限那一行 2026-11 随动作能力退场删了。）
    -->
    <!-- ★ D187：两列排法用全局 `.pair-field`（字段对：等宽两列 + gap 12） -->
    <section class="card agent-card pair-field">
      <!--
        ⚠️ 2026-11（S4，D127）：这里原来有两个大按钮让使用者"选边"（执行 / 审核）。
        **角色退场** ⇒ 新建一个 agent 不再问它是哪一种；这一页从"选角色 + 填名字"变成
        "填名字"，所以整块删掉（不留一个只有一项的选择器）。
      -->

      <!--
        ★ D240：编排内建智能体没有「用哪个 CLI」那一格（见下面那条注释），而这一张
        卡是**两列**网格（`.pair-field`）——少一格之后「名字」的右边空着、**「指令」
        被挤到第 2 列**，整张卡错位（使用者："CLI 不见了，导致错位"）。
        所以编排那条让「名字」**占整行**（与 `AgentDetail` 第 272 批同一条处置：
        半行没人陪的格子自己吃满一行；探针 `agents.cardNoHoles` 钉的是同一件事）。
      -->
      <label class="cell">
        {$t('agents.nameLabel')}
        <input bind:value={name} placeholder={$t('agents.namePlaceholder')} required autocomplete="off" />
      </label>

      <!--
        ★ D241：**「用哪个 CLI」对编排内建智能体也是真字段**（落在 `agent.json` 的
        `runtimeKey`，执行器按它解析 backend——`/api/workflows/:id/agents` 与智能体页
        同一关校验）。所以这一格两边都在、都不删：删格子会把两列网格挤塌。
      -->
      <label class="cell">
        {$t('agents.runtimeFieldLabel')}
        <select bind:value={runtimeKey}>
          <!-- ★ D242：与 `AgentDetail` 同一个第一项（"跟随全局默认"是一种状态，不是一个 runtime） -->
          <option value="default" title={$t('agents.runtimeFollowDefaultHint')}
            >{$t('agents.runtimeFollowDefault')}</option
          >
          {#each runtimeOptions as key (key)}
            {@const r = $identity?.runtimes.find((x) => x.key === key)}
            <option value={key}>
              {key}{r && r.evidence !== 'verified' ? $t('agents.runtimeUnverified') : ''}
            </option>
          {/each}
          {#if runtimeKey !== 'default' && !runtimeOptions.includes(runtimeKey)}
            <option value={runtimeKey}>{$t('agents.runtimeCurrent', { key: runtimeKey })}</option>
          {/if}
        </select>
      </label>

      <label class="cell instructions-cell">
        <!-- ★ 分批第 53 批：点明「指令」= 第一句话的 ② 身份。
             ⚠️ 只放**一行标签**，不放大段说明：新建表单每加两行文字，「创建」按钮就会被挤出
             视口（探针 `template.footVisible` 当场量到过）；完整说明在智能体详情的编辑态里。 -->
        {$t('agents.instructionsLabel')}
        <span class="muted fs-xs" data-instructions-identity>{$t('agents.instructionsIdentityTag')}</span>
        <!--
          ★ 指令是**一份文档**，不是一行备注（D48）。

          ⚠️ `rows` 只是**没有 CSS 时的兜底**，真正的高度下限在下面
             `.instructions` 的 `min-height`（与 `AgentDetail.svelte` 里那一份
             必须一致）。
        -->
        <!-- 2026-11（使用者：指令可能写很长）：PromptField（右下角「⛶」展开大编辑器） -->
        <PromptField
          class="instructions"
          bind:value={instructions}
          label={$t('agents.instructionsLabel')}
          rows={6}
          placeholder={$t('agents.instructionsPlaceholderPlain')}
        />

      </label>

      <!--
        ★ D242：技能那一格与**智能体编辑页**同一个 `.skill-box`（带边框、`flex:1`
        撑满行高、上限 22rem 与指令框同高）。改之前这里是"picker 自己带边框 +
        底下一行 hint"⇒ 右边那一格只有 154 高、左边的指令框 406 高，两个框的底边
        差 252px（使用者："挂载的技能下面的框没有对齐，编辑智能体就是有对齐的"）。
      -->
      <div class="cell skills-cell">
        <span class="cell-label">{$t('agents.attachedSkillsLabel')}</span>
        <div class="skill-box">
          {#if $skills.length === 0}
            <p class="hint">{$t('agents.noSkillsOption')}</p>
          {:else}
            <div class="skill-picker">
              {#each $skills as s (s.id)}
                <label class="skill-option">
                  <input type="checkbox" value={s.id} bind:group={selectedSkills} />
                  <!-- ★ D236：一个技能只有一个名字（规范里的 `name`，也是目录名） -->
                  <span>{s.name}</span>
                </label>
              {/each}
            </div>
          {/if}
          <span class="hint">{$t('agents.executorSkillsHint')}</span>
        </div>
      </div>

      <!--
        ══════════ 入口（2026-11，D146）══════════
        ★ 占整行放卡片最后：它是"这个智能体能被谁叫"，与上面三格（叫什么 / 怎么跑 /
          干什么）不是同一类问题，挤进半格会把「挂载的技能」压得更窄。
        ★ 三个勾选框，默认全勾；**一个都不勾**时下方的「创建」按钮置灰并给一句原因
          （那样造出来的智能体在每一个入口里都叫不出来——服务端同样会拒）。
      -->
      <div class="cell entry-cell" data-agent-entries>
        <span class="cell-label">{$t('agents.entriesLabel')}</span>
        <!--
          ★ D241（使用者："不需要的字段尽量用**置灰不能改**，而不是删除，这样避免布局问题"）：
          编排内建智能体的入口**三项都画出来、都置灰**，只有「编排」勾着——它确实只能被
          编排调用，但那三个位置该长什么样与智能体页一致，不缩成一项。
        -->
        <div class="entry-picker" class:locked={isWf}>
          {#each USER_ENTRY_CHOICES as entry (entry)}
            <label class="entry-option">
              <input
                type="checkbox"
                value={entry}
                bind:group={selectedEntries}
                disabled={isWf}
                title={isWf ? $t('workflows.agentsEntryLockedHint') : ''}
              />
              <span>{$t(USER_ENTRY_LABEL_KEYS[entry])}</span>
            </label>
          {/each}
        </div>
        {#if !isWf && !hasAnyEntry(selectedEntries)}
          <p class="hint entry-warning" data-entries-empty>{$t('agents.entriesEmpty')}</p>
        {/if}
      </div>

      <!--
        ⚠️ 2026-11（S4，D127）：那一格「标准已并进指令」原来只在**审核者**形态下出现
        （`{#if role === 'reviewer'}`）。角色退场 ⇒ 新建表单里不再有那一格；老数据的
        `reviewStandard` 仍然在详情页可见、可搬进「指令」。
      -->
    </section>

</form>
  {/snippet}
  {#snippet foot()}
    <!--
      ★ 2026-11（D146）：`!hasAnyEntry(...)` 与"名字空"同一档——都只是**挡住提交**，
         理由分别写在各自那一格下面（不是弹一个笼统的错误）。
      ★ D214：底栏与 `.main-panel-foot` 同族 ⇒ 主操作（创建）在这里，取消在它旁边；
         `form="new-agent-form"` 把它关联到体内那个表单（点它等于 submit 那个 form）。
    -->
    <button
      type="submit"
      form="new-agent-form"
      class="btn btn--primary"
      disabled={busy || !name.trim() || (!isWf && !hasAnyEntry(selectedEntries))}
    >
      {busy ? $t('common.creating') : $t('common.create')}
    </button>
    <button type="button" class="btn btn--ghost" onclick={onclose}>{$t('common.cancel')}</button>
  {/snippet}
</SettingsPanel>

<style>
  .agent-form {
    /* 与组表单同款：纵向一列（卡片 → 底部操作），宽度拉通右栏 */
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }


/**
   * ⚠️ 这里曾经有一个 `max-width: 46rem`：它在 416px 宽的 flex 行里不会收缩，
   *    于是把表单画成 736px、横着盖住右栏。现在**宽度由右栏决定**，
   *    这里只管排版。
   */
  .agent-form {
    /* 与组表单同款：纵向一列（卡片 → 底部操作），宽度拉通右栏 */
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }



  /**
   * ★ 2026-10：新建表单与**智能体详情编辑态**同款——一张卡片（两列网格，
   *    布局对齐组里「新建私有」的 `.grid-form`）。角色在卡片第一行（整行），
   *    名字 / CLI 一行，指令 / 技能一行。（行动权限那一行 2026-11 随动作能力退场删了。）
   *    `.card.agent-card` 的规则在 `AgentDetail.svelte` 里也有一份，两处一致。
   */
  /* ★ D187：**两列栅格不再写在这里**——它就是全局 `.pair-field`（字段对，gap 12）。
     这里只剩"卡片这张皮"（内距 / 描边 / 圆角）。`.agent-card` 另一份副本在
     `AgentDetail.svelte` 里也有，两处都改成一个 class，不再各写一条 `grid-template-columns`。 */
  .card.agent-card {
    margin: 0;
    padding: var(--sp-4);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
    /* ★ 第 255 批：清掉全局 `label { margin-bottom }`（并排的格子要一样高） */
    margin-bottom: 0;
  }

  .cell-label {
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }

  /* 角色（新建）：在卡片第一行，占整行（与编辑态同款） */
  .cell.role-cell {
    grid-column: 1 / -1;
  }

  /* ★ D240：编排内建智能体没有 CLI 那一格 ⇒「名字」占整行，否则后面的格子会掉到
     第 2 列（与 `AgentDetail` 的 `.name-cell` 同一条处置）。 */
  .cell.span-full {
    grid-column: 1 / -1;
  }

  /* ⚠️ 2026-11（D123）：这里原来有两条样式——「行动权限占整行」与它的展开/收起
     分段轨。动作能力退场后那一节不存在了，样式一并删。


  /**
   * 指令输入框：要能读完一份 800 字的角色设定（D48）。
   *
   * ★ 为什么高度写成 `min-height` 的 rem，而不是靠 `rows`：
   *   `rows` 是**行数**，它的像素高度随字号和行高变；而"能不能读完 800 字"是
   *   个长度问题。写成 rem 之后它锚在长度上。
   *
   * ★ 22rem = 352px 是**实测**出来的（不是估的）：当前 13px 字号、行高 1.6
   *   ⇒ 每行 20.8px ⇒ 框内可见 **16 行**。2026-10 起它住进半格（指令/技能
   *   并排），宽度变窄、一屏装下的字变少——但 800 字"能读完"的要求不变，
   *   高度下限维持 22rem（与 `AgentDetail.svelte` 里那一份必须一致）。
   *
   * ⚠️ 不要用 `height`：`resize: vertical` 拖出来的高度是**行内样式**，它会
   *    盖掉样式表里的 `height`，看起来"拖了没用"；而 `min-height` 只挡下限，
   *    往上拖永远有效。（代价是拖不到 22rem 以下——那正是这个下限的意思。）
   */
  /**
   * 角色选择：两个等宽卡片（2026-10 起与**智能体详情编辑态**同款 `1fr 1fr`）。
   * 原来用 `auto-fit` 是为了旧版单列窄栏（416px 里并排只剩 ~150px 一张）；
   * 现在角色在卡片第一行占整行，宽度足够，钉死两等宽卡片即可。
   */
  .role-picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
  }

  .role-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    text-align: left;
    padding: var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
  }

  .role-card strong { color: var(--text); font-size: var(--fs-md); }
  .role-card span { font-size: var(--fs-xs); color: var(--text-faint); }

  .role-card.active {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .role-card.active strong { color: var(--accent); }

  /**
   * ★ 技能区：**固定两列**的框内网格（2026-10 起与组里「新建私有」的
   *   `.skill-picker` 同款）。原来用 `repeat(auto-fill, minmax(13rem, 1fr))`，
   *   半格抽屉里会自动缩成一列，使用者要求的就是"两列"，钉死列数。
   */
  /*
   * ★ D242：技能那一格与**智能体编辑页同款**——外面一个 `.skill-box`（带边框、
   *   `flex: 1` 撑满行高、上限 22rem 与指令框同高），里面的 picker 吃掉剩余高度、
   *   装不下才滚。"两个框底边对齐"是这一族布局的判据（编辑页早就有，新建页漏了）。
   */
  .cell.instructions-cell,
  .cell.skills-cell {
    align-self: stretch;
    min-height: 0;
  }

  .skill-box {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    flex: 1 1 auto;
    max-height: 22rem;
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
  }

  .skills-cell .hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }

  .skill-picker {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-1) var(--sp-2);
    flex: 1 1 auto;
    max-height: 22rem;
    min-height: 0;
    overflow-y: auto;
    align-content: start;
    align-items: start;
    /* 边框/内距/底色由外面的 `.skill-box` 提供（这里再给一层就是双层内距） */
    text-align: left;
  }

  .skill-option { display: flex; align-items: center; gap: var(--sp-2); margin: 0; cursor: pointer; }
  .skill-option input { width: auto; }

  /* ★ 入口：占整行、三个勾选**并排一行**（竖向叠会被挤到下一屏，见上面那条注释） */
  .entry-cell {
    grid-column: 1 / -1;
  }

  .entry-picker {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-4);
  }

  .entry-option {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-dim);
    cursor: pointer;
  }

  .entry-option input { width: auto; }

  /* 一个都不勾的理由：与其它失败提示同色（它是**拦下来的原因**，不是说明文字） */
  .entry-warning {
    margin: 0;
    color: var(--warn);
  }

  /* 补充显示的名字之外的机器名：弱化，不抢主显示的存在感 */
  .skill-name {
    margin-left: var(--sp-1);
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
</style>
