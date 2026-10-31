<script lang="ts">
  /**
   * 沉淀的**逐个问**入口（分批第 103 批，U2 提问半）。§12.13：一屏一问；必答只有起点与作用描述。
   * §12.22/§12.25：换 UI 之前已立好状态锚点、入口断言与组间隔离，这批只换目标屏内部。
   * ⚠️ 语言与 persona 轨**不问**——`POST /api/crystallize/draft` 没有对应入参，问了就是死接口。
   */
  import { t } from '../lib/i18n.ts'

  interface LoadedSkill {
    id: string
    name: string
    description: string | null
    /** 技能来源（`mine` = 你提炼的 / `installed` = 装的）：决定"更新"是进化还是遮蔽。 */
    source?: string
  }
  interface AgentBrief { id: string; name: string; role: string; instructionsChars: number; builtin: boolean }
  interface Targets {
    loadedSkills: LoadedSkill[]
    agentTargets: { executor: AgentBrief; reviewer: AgentBrief | null }
    materialStats: { turns: number; toolCalls: number } | null
  }
  let {
    targets,
    blank = false,
    /**
     * ★ 分批第 150 批：**开始提炼的门禁理由**（素材为空 / 任务没审过又没反馈 / 更新没选技能）。
     * 顶栏那个「开始提炼」删掉之后，这一问就是唯一入口 ⇒ 门禁必须说在这一问上，
     * 否则人会点了才收到服务端一句 `task_gate`（把"不能做"变成"做失败了"）。
     */
    blocked = undefined,
    /** ★ 分批第 145 批（U4c 补）：当前问到哪一步要**回传给父级**——栏脚输入条要靠它判断
        "这句话是不是在答问题"（§12.5：还有必答项没答 ⇒ brief 参数）。用 `$bindable` 双向绑。 */
    stage = $bindable('start'),
    onfinish,
  }: {
    targets: Targets | null
    /** ★ 分批第 133 批：「从空白/材料起」——没有来源 run（起点已由入口选定，不再问）。 */
    blank?: boolean
    /** 现在还不该开始的原因（空/undefined = 可以开始）。 */
    blocked?: string | undefined
    stage?: Stage
    onfinish: (p: {
      kind: 'new' | 'update' | 'agent'
      skillId: string
      agentId: string
      purpose: string
      feedback: string
      blank?: boolean
      material?: string
    }) => void
  } = $props()

  type Stage = 'start' | 'detail' | 'purpose' | 'blankMaterial' | 'ready'
  // 空白起：起点已经定了（用户在「新建沉淀」里选了它），从这里直接问作用描述——不再多问一遍。
  // ⚠️ 起始值由父级给（`bind:stage`），这里只保证"blank 时候不会停在 start 那一问上"。
  $effect(() => {
    if (blank && stage === 'start') stage = 'purpose'
  })

  /**
   * ★ 分批第 145 批（U4c 补，§12.5）：**栏脚输入条的作答落到当前这一问**。
   *
   * 设计原文是"自由作答走输入条"（"还有必答项没答 ⇒ brief 参数"）。父级（栏脚输入条）
   * 把这句话交进来，这里按当前 stage 落进对应的答案字段并前进：
   *   · `purpose` ⇒ 写进作用描述（新建）/ 希望改（更新/指令），然后进入下一步；
   *   · `blankMaterial` ⇒ 当作材料正文，直接进确认。
   * 返回 `false` = 这一问不是文字题（选择题/确认），让父级回执说清"点选项/点开始提炼"。
   *
   * ⚠️ 用**导出方法**而不是 prop：父组件是 legacy 模式（`export let`），实测把"第几次推"
   *    做成 prop 之后，父级的赋值没有让 runes 子组件重跑 effect（回执到了、问题没换）。
   *    `bind:this` + 方法调用没有这层跨模式传递问题。
   */
  export function answerFromComposer(raw: string): 'purpose' | 'blankMaterial' | null {
    const text = raw.trim()
    if (text === '') return null
    if (stage === 'purpose') {
      if (kind === 'new') purpose = text
      else feedback = text
      afterPurpose()
      return 'purpose'
    }
    if (stage === 'blankMaterial') {
      materialText = text
      stage = 'ready'
      return 'blankMaterial'
    }
    return null
  }
  let kind = $state<'new' | 'update' | 'agent' | ''>(blank ? 'new' : '')
  let skillId = $state('')
  let agentId = $state('')
  let purpose = $state('')
  let feedback = $state('')
  /** 空白起时使用者一开始给的材料（一段文本，可空）。 */
  let materialText = $state('')

  const skills = $derived(targets?.loadedSkills ?? [])
  /**
   * ⚠️ 防御式取值：`agentTargets` 在某些接口/夹具里可能缺省。第一版直接 `targets.agentTargets.executor`，
   * 一旦它是 undefined 就抛 TypeError——而**组件里未捕获的异常会整页崩**，表现是后面几十条判据
   * 全变成"没量到这个值"（连聊天的左栏右栏都量不到）。这类"改沉淀页、聊天页跟着红"的现象，
   * 就是整页崩掉而不是布局问题。
   */
  const agents = $derived.by(() => {
    const briefs = targets?.agentTargets
    if (!briefs) return []
    return [briefs.executor, ...(briefs.reviewer === null ? [] : [briefs.reviewer])].filter(
      (a): a is AgentBrief => a !== null && a !== undefined,
    )
  })
  const stats = $derived(targets?.materialStats ?? null)

  function pickStart(next: 'new' | 'update' | 'agent'): void {
    kind = next
    if (next === 'update' && skills.length === 1) { skillId = skills[0]?.id ?? ''; stage = 'purpose'; return }
    if (next === 'agent' && agents.length === 1) { agentId = agents[0]?.id ?? ''; stage = 'purpose'; return }
    stage = next === 'new' ? 'purpose' : 'detail'
  }

  function pickDetail(id: string): void {
    if (kind === 'update') skillId = id
    else agentId = id
    stage = 'purpose'
  }

  const purposeMissing = $derived(kind === 'new' && purpose.trim() === '')

  function finish(): void {
    if (kind === '' || purposeMissing) return
    if (kind === 'update' && skillId === '') return
    if (kind === 'agent' && agentId === '') return
    onfinish({
      kind,
      skillId,
      agentId,
      purpose: purpose.trim(),
      feedback: feedback.trim(),
      ...(blank ? { blank: true, material: materialText.trim() } : {}),
    })
  }

  /** 作用描述之后：空白起再问一句材料（可跳过），其余直接进确认。 */
  function afterPurpose(): void {
    stage = blank ? 'blankMaterial' : 'ready'
  }

  const startLabel = $derived(kind === 'new' ? '新建一份技能' : kind === 'update' ? '优化已有技能' : kind === 'agent' ? '优化智能体指令' : '')
  const detailLabel = $derived(kind === 'update' ? (skills.find((s) => s.id === skillId)?.name ?? '') : (agents.find((a) => a.id === agentId)?.name ?? ''))
</script>

<div class="intake">
  {#if targets === null && !blank}
    <div class="skeleton" style="height:1.1rem"></div>
  {:else}
    <!-- ★ 空白起（blank）没有"起点问"这一步（起点已在 `#/crystallize/new` 那一屏选过）⇒ 不回放它 -->
    {#if stage !== 'start' && !blank}
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">这次要沉淀成什么？</p>
      </div>
      <div class="qa-msg user" data-msg-role="user">
        <p class="qa-text">{startLabel}</p>
      </div>
    {/if}

    {#if stage === 'start'}
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">这次要沉淀成什么？</p>
        <div class="intake-choices">
          <button type="button" class="intake-choice" onclick={() => pickStart('new')}>
            新建一份技能<span class="faint small">从这次的过程里提炼出做法</span>
          </button>
          {#if skills.length > 0}
            <button type="button" class="intake-choice" onclick={() => pickStart('update')}>
              优化已有技能
              <span class="faint small"
                >这次加载过 {skills.length} 份 · {$t('crystallize.targetUpdateHint')}</span
              >
            </button>
          {/if}
          {#if agents.length > 0}
            <button type="button" class="intake-choice" onclick={() => pickStart('agent')}>
              优化智能体指令<span class="faint small">只改指令，不新建智能体</span>
            </button>
          {/if}
        </div>
      </div>
    {:else if stage === 'detail'}
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">是哪一份？</p>
        <div class="intake-choices">
          {#if kind === 'update'}
            {#each skills as option (option.id)}
              <button type="button" class="intake-choice" onclick={() => pickDetail(option.id)}>
                {option.name}
                <span class="faint small">
                  {option.description ?? ''}
                  · {option.source === 'mine'
                    ? $t('crystallize.badgeMine')
                    : $t('crystallize.badgeInstalled')}
                  （{option.source === 'mine'
                    ? $t('crystallize.updateIsEvolve')
                    : $t('crystallize.updateIsShadow')}）
                </span>
              </button>
            {/each}
          {:else}
            {#each agents as option (option.id)}
              <button type="button" class="intake-choice" onclick={() => pickDetail(option.id)}>
                {option.name}
                <span class="faint small">
                  {option.role === 'executor'
                    ? $t('crystallize.agentCandidateExecutor')
                    : $t('crystallize.agentCandidateReviewer')}
                  · {$t('crystallize.agentCharsHint', { chars: String(option.instructionsChars) })}
                  {#if option.builtin}· {$t('crystallize.agentBuiltinHint')}{/if}
                </span>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {:else if stage === 'purpose'}
      {#if detailLabel !== ''}
        <div class="qa-msg" data-msg-role="assistant">
          <p class="intake-q">是哪一份？</p>
        </div>
        <div class="qa-msg user" data-msg-role="user">
          <p class="qa-text">{detailLabel}</p>
        </div>
      {/if}
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">
          {kind === 'new' ? $t('crystallize.purposeLabel') : $t('crystallize.userFeedbackLabel')}
        </p>
        {#if kind === 'new'}
          <textarea
            class="intake-input"
            rows="3"
            bind:value={purpose}
            placeholder={$t('crystallize.purposePlaceholder')}
          ></textarea>
        {:else}
          <textarea
            class="intake-input"
            rows="3"
            bind:value={feedback}
            placeholder={$t('crystallize.userFeedbackPlaceholder')}
          ></textarea>
        {/if}
        {#if purposeMissing}
          <p class="faint small">{$t('crystallize.purposeHint')}——这一条必答：没有靶子，起草者只能凭素材猜。</p>
        {/if}
        <div class="intake-actions">
          <button type="button" class="primary" disabled={purposeMissing} onclick={afterPurpose}>下一步</button>
        </div>
      </div>
    {:else if stage === 'blankMaterial'}
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">
          {kind === 'new' ? $t('crystallize.purposeLabel') : $t('crystallize.userFeedbackLabel')}
        </p>
      </div>
      <div class="qa-msg user" data-msg-role="user">
        <p class="qa-text">{kind === 'new' ? purpose : feedback}</p>
      </div>
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">材料（可选）：粘贴要给起草者的资料</p>
        <textarea
          class="intake-input"
          rows="4"
          bind:value={materialText}
          placeholder="比如：团队的规范、上次复盘的结论、要遵守的约定……没有就跳过，直接按作用描述写一版。"
        ></textarea>
        <p class="faint small">
          这次没有来源 run：材料只有你给的这一段（可以不给）。追加更多材料可以在起草完之后用栏脚输入条。
        </p>
        <div class="intake-actions">
          <button type="button" class="primary" onclick={() => (stage = 'ready')}>下一步</button>
          <button type="button" class="ghost" onclick={() => { materialText = ''; stage = 'ready' }}>跳过</button>
        </div>
      </div>
    {:else}
      <!-- ready：前面几问都已答 ⇒ 按"问 / 答"两条消息回放，最后一条是**开始提炼** -->
      {#if detailLabel !== ''}
        <div class="qa-msg" data-msg-role="assistant">
          <p class="intake-q">是哪一份？</p>
        </div>
        <div class="qa-msg user" data-msg-role="user">
          <p class="qa-text">{detailLabel}</p>
        </div>
      {/if}
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">
          {kind === 'new' ? $t('crystallize.purposeLabel') : $t('crystallize.userFeedbackLabel')}
        </p>
      </div>
      <div class="qa-msg user" data-msg-role="user">
        <p class="qa-text">{kind === 'new' ? purpose : feedback}</p>
      </div>
      {#if blank}
        <div class="qa-msg" data-msg-role="assistant">
          <p class="intake-q">材料（可选）：粘贴要给起草者的资料</p>
        </div>
        <div class="qa-msg user" data-msg-role="user">
          <p class="qa-text">{materialText.trim() === '' ? '（跳过）' : materialText}</p>
        </div>
      {/if}
      <div class="qa-msg" data-msg-role="assistant">
        <p class="intake-q">开始提炼？</p>
        <dl class="intake-summary">
          <dt>沉淀成</dt><dd>{startLabel}</dd>
          {#if blank}<dt>起点</dt><dd>空白起（没有来源 run）</dd>{/if}
          {#if stats !== null}<dt>素材</dt><dd>轨迹 {stats.turns} 轮 · {stats.toolCalls} 次工具调用（起草时自动带上）</dd>{/if}
        </dl>
        {#if blocked !== undefined}
          <p class="faint small" data-intake-blocked>{blocked}</p>
        {/if}
        <div class="intake-actions">
          <button
            type="button"
            class="primary"
            disabled={blocked !== undefined}
            title={blocked}
            onclick={finish}>开始提炼</button
          >
          <button type="button" class="ghost" onclick={() => (stage = 'start')}>重答</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  /**
   * ★ 分批第 142 批（U4c，§12.12/§12.13）：目标态的问答**改成消息**——问题是一条助手消息、
   * 回答是一条用户消息（不再是一个"目标面板 + 分步向导"的壳）。选项/输入框仍然可点可写，
   * 但它们现在长在每条问题消息里，读起来就是一段对话。
   */
  .intake { display: flex; flex-direction: column; gap: var(--sp-2); }
  .qa-msg {
    background: var(--surface-2, #f4f4f5);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2) var(--sp-3);
  }
  .qa-msg.user {
    background: var(--surface);
    border-style: dashed;
    margin-left: var(--sp-6, 2rem);
  }
  .qa-msg .intake-q { margin-bottom: var(--sp-2); }
  .qa-text { margin: 0; white-space: pre-wrap; }
  .intake-q { font-size: var(--fs-base); color: var(--text); margin: 0; }
  .intake-choices { display: flex; flex-direction: column; gap: var(--sp-1); }
  .intake-choice {
    display: flex; flex-direction: column; align-items: flex-start; gap: 0.125rem; text-align: left;
    border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
    padding: var(--sp-2) var(--sp-3); font-size: var(--fs-base);
  }
  .intake-choice:hover { background: var(--surface-hover); border-color: var(--line-strong); }
  .intake-input {
    width: 100%; font: inherit; font-size: var(--fs-base); color: var(--text); background: var(--surface);
    border: 1px solid var(--line-strong); border-radius: var(--radius); padding: var(--sp-2); resize: vertical;
  }
  .intake-input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 40%, transparent); border-color: var(--accent); }
  .intake-actions { display: flex; gap: var(--sp-2); align-items: center; }
  .intake-summary { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 0.25rem var(--sp-2); font-size: var(--fs-sm); margin: 0; }
  .intake-summary dt { color: var(--text-faint); }
  .intake-summary dd { margin: 0; color: var(--text); }
</style>
