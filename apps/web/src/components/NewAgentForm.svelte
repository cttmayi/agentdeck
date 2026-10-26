<script lang="ts">
  import { createAgent, identity, skills } from '../lib/stores.ts'
  import type { AgentRole, ReviewStandard } from '../lib/api.ts'
  import { showToast } from '../lib/view.ts'
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

  let name = ''
  let role: AgentRole = 'executor'
  /**
   * ★ 分批第 47 批：**初值 = 工作区里的「默认工作守则」**（设置页那个框）。
   *
   * 为什么不在服务端"偷偷补"就完事：那样使用者看到的是**空输入框**，保存后
   * 再打开才发现里面多了一段——"我什么都没写，它自己长出了规矩"是最难接受的一类。
   * 服务端 `POST /api/agents` 确实也会在"指令为空"时预填（那是给别的客户端兜底），
   * 但界面上必须**先看见**，才能改、才能删。
   */
  let instructions = $identity?.defaultAgentConduct ?? ''
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
   *    权限，挂在人身上只能共用一份。唯一权威是 `AgentGroup` 上那三个同名字段，
   *    配的地方是**智能体组页的 ③ 行动**。
   *
   *    ★ 所以新建一个 agent 时**没有任何动作要配**，那个选择器在这页是纯噪音：
   *      使用者会在"这个人能做什么"的地方勾一遍，然后在组里再勾一遍——两处长得
   *      一样、只有一处生效，是最坏的一种界面。
   *
   *    ⚠️ 也别把它加回来"做兼容"：服务端会把这三个键当成**不认识的字段**拒掉
   *      （400），留在这里只会变成一个必然失败的提交。
   */
  let selectedSkills: string[] = []
  /**
   * 可选的 runtime —— 从**身份接口**来，不写死两项。
   *
   * 写死的话，新加一个 runtime 之后这个表单里根本选不到它（只有直接调接口
   * 才行）。初始化取第一个可用项，而不是硬编码 'claude'。
   */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []
  let runtimeKey = 'claude'
  let busy = false
  let error = ''

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = ''
    busy = true
    try {
      await createAgent({
        name,
        role,
        instructions,
        skillIds: selectedSkills,
        runtimeKey,
        reviewStandard: role === 'reviewer' ? reviewStandard : null,
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
      role = 'executor'
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
  ★ 2026-10（与智能体组页同款布局）：没有 hero 头——进来就是表单卡片，
  主操作（创建 / 取消）在底部 `.form-actions`。
  ══════════════════════════════════════════════════════════════════
-->
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
      ★ 2026-10：新建表单与**智能体详情编辑态**同款——一张卡片（两列网格，
         对齐组里「新建私有」的 `.grid-form`）。角色在卡片第一行（占整行），
         名字 / CLI 一行，指令 / 技能一行；行动权限（审核者）占整行、默认收起。
    -->
    <!--
      ⚠️ 2026-10（使用者的决定）：「由谁来审它」整段拿掉了——审核不再由执行者
      自己配，而是走智能体组（组的审核者）。老数据的 `reviewerAgentId` 原样
      保留（单发任务跟随它），只是这里不再生成它。原位置见头部注释。
    -->

    <!--
      ★ 2026-10：新建表单与**智能体详情编辑态**同款——一张卡片（两列网格，
         对齐组里「新建私有」的 `.grid-form`）。角色在卡片第一行（占整行），
         名字 / CLI 一行，指令 / 技能一行；行动权限（审核者）占整行、默认收起。
    -->
    <section class="card agent-card">
      <!-- 角色：占整行。用两个大按钮而不是下拉或单选圆圈——这是一个"选边"的
           决定，值得占视觉重量；下拉会让人一扫而过。 -->
      <div class="cell role-cell">
        <span class="cell-label">{$t('agents.roleFieldLabel')}</span>
        <div class="role-picker">
          <button
            type="button"
            class="role-card"
            class:active={role === 'executor'}
            onclick={() => (role = 'executor')}
          >
            <strong>{$t('agents.roleExecutor')}</strong>
            <span>{$t('agents.roleExecutorHint')}</span>
          </button>
          <button
            type="button"
            class="role-card"
            class:active={role === 'reviewer'}
            onclick={() => (role = 'reviewer')}
          >
            <strong>{$t('agents.roleReviewer')}</strong>
            <span>{$t('agents.roleReviewerHint')}</span>
          </button>
        </div>
      </div>

      <label class="cell">
        {$t('agents.nameLabel')}
        <input bind:value={name} placeholder={$t('agents.namePlaceholder')} required autocomplete="off" />
      </label>

      <label class="cell">
        {$t('agents.runtimeFieldLabel')}
        <select bind:value={runtimeKey}>
          {#each runtimeOptions as key (key)}
            {@const r = $identity?.runtimes.find((x) => x.key === key)}
            <option value={key}>
              {key}{r && r.evidence !== 'verified' ? $t('agents.runtimeUnverified') : ''}
            </option>
          {/each}
          {#if !runtimeOptions.includes(runtimeKey)}
            <option value={runtimeKey}>{$t('agents.runtimeCurrent', { key: runtimeKey })}</option>
          {/if}
        </select>
      </label>

      <label class="cell">
        <!-- ★ 分批第 53 批：点明「指令」= 第一句话的 ② 身份。
             ⚠️ 只放**一行标签**，不放大段说明：新建表单每加两行文字，「创建」按钮就会被挤出
             视口（探针 `template.footVisible` 当场量到过）；完整说明在智能体详情的编辑态里。 -->
        {$t('agents.instructionsLabel')}
        <span class="muted small" data-instructions-identity>{$t('agents.instructionsIdentityTag')}</span>
        <!--
          ★ 指令是**一份文档**，不是一行备注（D48）。

          ⚠️ `rows` 只是**没有 CSS 时的兜底**，真正的高度下限在下面
             `.instructions` 的 `min-height`（与 `AgentDetail.svelte` 里那一份
             必须一致）。
        -->
        <textarea
          class="instructions"
          bind:value={instructions}
          rows="6"
          placeholder={role === 'reviewer'
            ? $t('agents.instructionsPlaceholderReviewer')
            : $t('agents.instructionsPlaceholderExecutor')}
        ></textarea>

        <span class="hint">
          {$t('agents.instructionsHintBefore')}<strong>{$t('agents.instructionsFieldStrong')}</strong>{$t('agents.instructionsHintAfter')}
        </span>
      </label>

      <div class="cell">
        <span class="cell-label">{$t('agents.attachedSkillsLabel')}</span>
        {#if $skills.length === 0}
          <p class="hint">{$t('agents.noSkillsOption')}</p>
        {:else}
          <div class="skill-picker">
            {#each $skills as s (s.id)}
              <label class="skill-option">
                <input type="checkbox" value={s.id} bind:group={selectedSkills} />
                <!-- ★ 2026-10：以**名字**为主（与「新建私有」同款）；slug 只在和
                     名字不同时才补充（已安装技能名字常等于 slug，一起印会重复）。 -->
                <span>{s.name}{#if s.name !== s.slug}<code class="skill-slug">{s.slug}</code>{/if}</span>
              </label>
            {/each}
          </div>
        {/if}
        {#if role === 'reviewer'}
          <span class="hint">
            {$t('agents.reviewerSkillsHintBefore')}<strong>{$t('agents.instructionsLabel')}</strong>{$t('agents.reviewerSkillsHintAfter')}
          </span>
        {:else}
          <span class="hint">{$t('agents.executorSkillsHint')}</span>
        {/if}
      </div>

      {#if role === 'reviewer'}
        <!--
          ★ 2026-09：「标准」并进上面的「指令」，不再单独设置（使用者的决定）。

          ⚠️ 2026-10：这里原来还有一整段「行动权限」（`ActionPicker`）。**它搬到了
          智能体组**（组配置页 ③ 行动）——见上面状态变量那段注释里的理由。这里只
          留一句提示：判断依据写在「指令」里，而"判完允许动什么"在组上配。
        -->
        <div class="cell">
          <p class="hint" data-standard-merged>{$t('agents.standardMergedHint')}</p>
          <p class="hint">{$t('agents.actionsMovedToGroup')}</p>
        </div>
      {/if}
    </section>

  <!-- 主操作在底部（与组页同款）：创建 / 取消 -->
  <div class="form-actions">
    <button type="submit" class="primary" disabled={busy || !name.trim()}>
      {busy ? $t('common.creating') : $t('common.create')}
    </button>
    <button type="button" class="ghost" onclick={onclose}>{$t('common.cancel')}</button>
  </div>
</form>

<style>
  .agent-form {
    /* 与组表单同款：纵向一列（卡片 → 底部操作），宽度拉通右栏 */
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  /* 主操作在底部（与组页同款） */
  .form-actions {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
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

  /* 主操作在底部（与组页同款） */
  .form-actions {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }


  /**
   * ★ 2026-10：新建表单与**智能体详情编辑态**同款——一张卡片（两列网格，
   *    布局对齐组里「新建私有」的 `.grid-form`）。角色在卡片第一行（整行），
   *    名字 / CLI 一行，指令 / 技能一行；行动权限（审核者、整行、收起）。
   *    `.card.agent-card` 的规则在 `AgentDetail.svelte` 里也有一份，两处一致。
   */
  .card.agent-card {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-3);
    align-items: start;
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
  }

  .cell-label {
    font-size: 0.9em;
    color: var(--text-faint);
  }

  /* 角色（新建）：在卡片第一行，占整行（与编辑态同款） */
  .cell.role-cell {
    grid-column: 1 / -1;
  }

  /* 行动权限（审核者）：占整行（选择器"左选右配"，最需要宽度） */
  .cell.picker-cell {
    grid-column: 1 / -1;
  }

  /* 行动权限的展开/收起（2026-10：与顶栏「列表 / 看板」同款分段轨——
     与组里「选已有的/新建私有」、任务里「智能体/智能体组」同一套样式） */
  .slot-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .slot-source-toggle {
    display: flex;
    align-items: center;
    height: 1.9rem;
    box-sizing: border-box;
    padding: 0 var(--sp-1);
    gap: 2px;
    background: var(--line);
    border-radius: var(--radius);
  }
  .slot-source-toggle button {
    height: 1.5rem;
    padding: 0 var(--sp-3);
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-dim);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .slot-source-toggle button:hover:not(:disabled) {
    background: var(--surface);
    color: var(--text);
  }
  .slot-source-toggle button.active {
    /* ⚠️ 背景用 `--accent-dim` 而不是 `--accent`：暗色主题下 `--accent` 是浅蓝，
       白字配它看不见（与新建任务页的来源切换同款修法）。 */
    background: var(--accent-dim, #2f6fed);
    color: #fff;
  }

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
  .instructions {
    min-height: 22rem;
    line-height: 1.6;
    resize: vertical;
  }

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
  .skill-picker {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-1) var(--sp-2);
    margin-top: var(--sp-2);
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
    text-align: left;
  }

  .skill-option { display: flex; align-items: center; gap: var(--sp-2); margin: 0; cursor: pointer; }
  .skill-option input { width: auto; }

  /* 补充显示的名字之外的机器名：弱化，不抢主显示的存在感 */
  .skill-slug {
    margin-left: var(--sp-1);
    font-size: 0.9em;
    color: var(--text-faint);
  }
</style>
