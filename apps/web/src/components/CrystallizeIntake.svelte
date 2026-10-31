<script lang="ts">
  /**
   * 沉淀的**逐个问**入口（分批第 103 批，U2 提问半）。§12.13：一屏一问；必答只有起点与作用描述。
   * §12.22/§12.25：换 UI 之前已立好状态锚点、入口断言与组间隔离，这批只换目标屏内部。
   * ⚠️ 语言与 persona 轨**不问**——`POST /api/crystallize/draft` 没有对应入参，问了就是死接口。
   */
  // ★ 分批第 194 批：问答的**气泡形状**与聊天页同一份（`@agentdeck/ui` 的 ChatBubble）。
  //   原来这里是第三套（`.qa-msg`：助手 = 深底、人 = 虚线框 + 左缩进），聊天页却是
  //   "人靠右、助手满宽"。使用者连提两次「应该像聊天那页的对话方式」，所以收成一份。
  import { ChatBubble } from '@agentdeck/ui/components'
  import { t } from '../lib/i18n.ts'
  import { api } from '../lib/api.ts'

  interface LoadedSkill {
    id: string
    name: string
    description: string | null
    /** 技能来源（`mine` = 你提炼的 / `installed` = 装的）：决定"更新"是进化还是遮蔽。 */
    source?: string
  }
  interface Targets {
    loadedSkills: LoadedSkill[]
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
      kind: 'new' | 'update'
      skillId: string
      purpose: string
      feedback: string
      blank?: boolean
      /** ★ 分批第 166 批：空白起的材料是**一组**（可以零份、可以多份）。 */
      materials?: Array<{ text: string }>
    }) => void
  } = $props()

  type Stage = 'start' | 'detail' | 'purpose' | 'blankMaterial' | 'ready'
  // 空白起：起点已经定了（用户在「新建沉淀」里选了它），从这里直接问作用描述——不再多问一遍。
  // ⚠️ 起始值由父级给（`bind:stage`），这里只保证"blank 时候不会停在 start 那一问上"。
  /**
   * ★ 分批第 165 批：空白起的**第一问回来了**——但要问的是"新建一份，还是改一份已有的"
   * （不是问来源：来源在入口那一屏已经定了"空白起"）。原来这里直接把 stage 推到 `purpose`，
   * 于是"改已有技能"这条路在空白起根本不存在。
   */

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
      // ★ 分批第 166 批：这句话是**再加一份材料**，不是"这一问的答案"⇒ 加进列表、停在原处
      //   （还能继续加，或者点「下一步」）
      materialSeq += 1
      blankMaterials = [...blankMaterials, { id: materialSeq, text }]
      materialDraft = ''
      return 'blankMaterial'
    }
    return null
  }
  /**
   * 目标种类。**初始值不在这里读 `blank`**：在 `$state(...)` 的初始化里读 prop，svelte-check 会
   * 提醒"只捕获了它的初始值"，而且那样写的意图也含糊。改由下面那个已有的 `$effect` 补：
   * 空白起没有来源 run ⇒ 目标只能是"新建"（但它是**可改的**，所以不能做成 `$derived`）。
   */
  let kind = $state<'new' | 'update' | ''>('')
  let skillId = $state('')
  let purpose = $state('')
  let feedback = $state('')
  /**
   * ★ 分批第 166 批（§12.59，使用者定）：**空白起的材料可以给多段**。
   *
   * 以前只有 `materialText` 一段（超过 100 KB 整段拒）。但"我手上有几份笔记"是常态，
   * 逼人先合并成一段，等于让人在**粘之前**先做一次编辑——而材料本来就是"原样交给起草者"。
   * 现在是一份列表（可加、可删），提交时照 daemon 的 `materials: [{name?, text}]` 发。
   */
  let blankMaterials = $state<Array<{ id: number; text: string }>>([])
  /** 正在输入、还没「加上」的那一段。 */
  let materialDraft = $state('')
  let materialSeq = 0

  function addMaterial(): void {
    const text = materialDraft.trim()
    if (text === '') return
    materialSeq += 1
    blankMaterials = [...blankMaterials, { id: materialSeq, text }]
    materialDraft = ''
  }

  function removeMaterial(id: number): void {
    blankMaterials = blankMaterials.filter((m) => m.id !== id)
  }

  /**
   * ★ 分批第 165 批（§12.58）：**空白起也能更新一份已有技能**。
   *
   * 空白起没有来源 run ⇒ 没有 `targets` ⇒ `loadedSkills` 为空，"改哪一份"就没得选。
   * 但候选本来就该是**技能库里的全部技能**（"上一版"是库里那条，跟来源 run 无关），
   * 所以空白起时直接问 `GET /api/skills`。
   */
  let blankSkills = $state<Array<{ id: string; slug: string; name: string; description: string | null; source: 'mine' | 'installed' }>>([])
  $effect(() => {
    if (!blank) return
    void (async () => {
      try {
        const res = await api<{ skills: typeof blankSkills }>('/api/skills')
        blankSkills = res.skills ?? []
      } catch {
        blankSkills = []
      }
    })()
  })
  const skills = $derived(blank ? blankSkills : (targets?.loadedSkills ?? []))
  const stats = $derived(targets?.materialStats ?? null)
  /** 气泡上方那行小字里的"谁在说"（与聊天页 `chat.you` 同一位置）。 */
  const speaker = $derived($t('crystallize.speakerDrafter'))
  const you = $derived($t('crystallize.speakerYou'))

  function pickStart(next: 'new' | 'update'): void {
    kind = next
    if (next === 'update' && skills.length === 1) { skillId = skills[0]?.id ?? ''; stage = 'purpose'; return }
    stage = next === 'new' ? 'purpose' : 'detail'
  }

  function pickDetail(id: string): void {
    if (kind === 'update') skillId = id
    stage = 'purpose'
  }

  const purposeMissing = $derived(kind === 'new' && purpose.trim() === '')

  function finish(): void {
    if (kind === '' || purposeMissing) return
    if (kind === 'update' && skillId === '') return
    onfinish({
      kind,
      skillId,
      purpose: purpose.trim(),
      feedback: feedback.trim(),
      ...(blank
        ? {
            blank: true,
            materials: blankMaterials.map((m) => ({ text: m.text })),
          }
        : {}),
    })
  }

  /** 作用描述之后：空白起再问一句材料（可跳过），其余直接进确认。 */
  function afterPurpose(): void {
    stage = blank ? 'blankMaterial' : 'ready'
  }

  const startLabel = $derived(kind === 'new' ? '新建一份技能' : kind === 'update' ? '优化已有技能' : '')
  const detailLabel = $derived(kind === 'update' ? (skills.find((s) => s.id === skillId)?.name ?? '') : '')
</script>

<div class="intake">
  {#if targets === null && !blank}
    <div class="skeleton" style="height:1.1rem"></div>
  {:else}
    <!-- ★ 分批第 165 批：空白起也有第一问（新建 / 改一份已有的），只是不问"从哪来" -->
    {#if stage !== 'start'}
      <ChatBubble role="agent" who={speaker}>
        <p class="intake-q">这次要沉淀成什么？</p>
      </ChatBubble>
      <ChatBubble role="user" who={you} text={startLabel} />
    {/if}

    {#if stage === 'start'}
      <ChatBubble role="agent" who={speaker}>
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
        </div>
      </ChatBubble>
    {:else if stage === 'detail'}
      <ChatBubble role="agent" who={speaker}>
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
          {/if}
        </div>
      </ChatBubble>
    {:else if stage === 'purpose'}
      {#if detailLabel !== ''}
        <ChatBubble role="agent" who={speaker}>
          <p class="intake-q">是哪一份？</p>
        </ChatBubble>
        <ChatBubble role="user" who={you} text={detailLabel} />
      {/if}
      <ChatBubble role="agent" who={speaker}>
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
      </ChatBubble>
    {:else if stage === 'blankMaterial'}
      <ChatBubble role="agent" who={speaker}>
        <p class="intake-q">
          {kind === 'new' ? $t('crystallize.purposeLabel') : $t('crystallize.userFeedbackLabel')}
        </p>
      </ChatBubble>
      <ChatBubble role="user" who={you} text={kind === 'new' ? purpose : feedback} />
      <ChatBubble role="agent" who={speaker}>
        <p class="intake-q">材料（可选）：给起草者的资料，可以一份一份加</p>
        {#if blankMaterials.length > 0}
          <ul class="mat-list" data-blank-materials>
            {#each blankMaterials as item (item.id)}
              <li>
                <span class="mat-text">{item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text}</span>
                <button
                  type="button"
                  class="ghost small"
                  aria-label="删掉这一份"
                  onclick={() => removeMaterial(item.id)}>删掉</button
                >
              </li>
            {/each}
          </ul>
        {/if}
        <textarea
          class="intake-input"
          rows="3"
          bind:value={materialDraft}
          placeholder="比如：团队的规范、上次复盘的结论、要遵守的约定……没有就跳过，直接按作用描述写一版。"
        ></textarea>
        <div class="intake-actions">
          <button
            type="button"
            class="ghost"
            disabled={materialDraft.trim() === ''}
            onclick={addMaterial}>加上这一份</button
          >
          <button type="button" class="primary" onclick={() => (stage = 'ready')}>
            {blankMaterials.length === 0 ? '跳过' : '下一步'}
          </button>
        </div>
        <p class="faint small">
          这次没有来源 run：材料只有你给的这些（可以零份、可以多份）。起草完之后还能在右栏继续加。
        </p>
      </ChatBubble>
    {:else}
      <!-- ready：前面几问都已答 ⇒ 按"问 / 答"两条消息回放，最后一条是**开始提炼** -->
      {#if detailLabel !== ''}
        <ChatBubble role="agent" who={speaker}>
          <p class="intake-q">是哪一份？</p>
        </ChatBubble>
        <ChatBubble role="user" who={you} text={detailLabel} />
      {/if}
      <ChatBubble role="agent" who={speaker}>
        <p class="intake-q">
          {kind === 'new' ? $t('crystallize.purposeLabel') : $t('crystallize.userFeedbackLabel')}
        </p>
      </ChatBubble>
      <ChatBubble role="user" who={you} text={kind === 'new' ? purpose : feedback} />
      {#if blank}
        <ChatBubble role="agent" who={speaker}>
          <p class="intake-q">材料（可选）：给起草者的资料</p>
        </ChatBubble>
        <ChatBubble
          role="user"
          who={you}
          text={blankMaterials.length === 0
            ? '（跳过）'
            : `${blankMaterials.length} 份：${blankMaterials.map((m) => (m.text.length > 20 ? `${m.text.slice(0, 20)}…` : m.text)).join('、')}`}
        />
      {/if}
      <ChatBubble role="agent" who={speaker}>
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
      </ChatBubble>
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
  /* ★ 分批第 194 批：`.qa-msg` / `.qa-text` 删了——气泡的观感搬进 `ChatBubble`
     （聊天页与沉淀页共用一份）。这里只剩"问题行与下面的选项之间那一格间距"。 */
  .intake-q { margin-bottom: var(--sp-2); }
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

  /* ★ 分批第 166 批：空白起的材料清单（一份一行、可删） */
  .mat-list {
    list-style: none;
    margin: 0 0 var(--sp-1);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 9rem;
    overflow: auto;
  }

  .mat-list li {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .mat-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
