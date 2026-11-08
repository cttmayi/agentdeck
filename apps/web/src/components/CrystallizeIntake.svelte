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
    /**
     * 技能的 slug（daemon 两处来源都给）。**只作显示名的兜底**：万一某条记录的名字是空的，
     * 那一行不能只剩一个徽标（使用者报过"第一个选项只显示了『安装的』"那种形状）。
     */
    slug?: string
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

  /**
   * 选项上那个**名字**：名字 → slug → id。
   *
   * 一个选项必须能回答"这是哪一份"，所以三级兜底都要有——只剩一个「安装的」徽标，
   * 等于让人对着两个看不出差别的按钮猜。
   */
  function optionLabel(option: LoadedSkill): string {
    if (option.name !== '') return option.name
    const slug = option.slug ?? ''
    return slug !== '' ? slug : option.id
  }

  function pickDetail(id: string): void {
    if (kind === 'update') skillId = id
    stage = 'purpose'
  }

  const purposeMissing = $derived(kind === 'new' && purpose.trim() === '')

  /**
   * 前几问都答了才能发起。⚠️ 分批第 225 批：原来这里**静默 return**——更新场景没选到技能时
   * 点「开始提炼」什么都不发生（使用者报的"没有反应"就是这一类）。现在把原因挂在按钮下面。
   */
  const cannotStart = $derived(
    kind === 'update' && skillId === '' ? '还没选定要更新的技能（上面那份清单里点一个）' : '',
  )

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
            新建一份技能<span class="faint fs-xs">从这次的过程里提炼出做法</span>
          </button>
          {#if skills.length > 0}
            <button type="button" class="intake-choice" onclick={() => pickStart('update')}>
              优化已有技能
              <!-- 分批第 235 批：长括注（"更新目标就是它（提炼的=进化…）"）不再塞进选项——
                   两种来源的区别由下一屏「是哪一份？」里那一句统一说。 -->
              <span class="faint fs-xs">{$t('crystallize.loadedCount', { n: String(skills.length) })}</span>
            </button>
          {/if}
        </div>
      </ChatBubble>
    {:else if stage === 'detail'}
      <ChatBubble role="agent" who={speaker}>
        <p class="intake-q">是哪一份？</p>
        <div class="intake-choices">
          {#if kind === 'update'}
            <!--
              ★ 分批第 235 批（使用者："下面有2个选项，说是什么呀"）：
              每个选项原来是"名字 + 描述 + 徽标 + 一长串括注"糊成两三行，人读不出
              "这到底是哪一份、选了会怎样"。现在拆成 **名字一行（徽标在右）+ 描述一行**，
              长解释收进徽标自己的 `title`（悬停才出），下面整段只出现**一次**。
            -->
            {#each skills as option (option.id)}
              <button
                type="button"
                class="intake-choice skill-choice"
                data-skill-option
                onclick={() => pickDetail(option.id)}
              >
                <span class="skill-head">
                  <!-- 名字是主角；万一那条记录没有名字，退回 slug / id——绝不能只剩一个徽标 -->
                  <span class="skill-name" title={optionLabel(option)}>{optionLabel(option)}</span>
                  <span
                    class="skill-badge"
                    data-skill-source={option.source}
                    title={option.source === 'mine'
                      ? $t('crystallize.updateIsEvolve')
                      : $t('crystallize.updateIsShadow')}
                  >{option.source === 'mine'
                    ? $t('crystallize.badgeMine')
                    : $t('crystallize.badgeInstalled')}</span>
                </span>
                {#if (option.description ?? '') !== ''}
                  <!-- 两行夹断（见样式）；全文挂在 `title` 上，悬停能读全 -->
                  <span class="skill-desc" title={option.description}>{option.description}</span>
                {/if}
              </button>
            {/each}
          {/if}
        </div>
        <!-- 两种来源各是什么意思：整段只说一次（每个选项里再抄一遍就是噪音） -->
        <p class="intake-note">{$t('crystallize.updateChoiceNote')}</p>
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
          <p class="faint fs-xs">{$t('crystallize.purposeHint')}——这一条必答：没有靶子，起草者只能凭素材猜。</p>
        {/if}
        <div class="intake-actions">
          <button type="button" class="btn btn--primary" disabled={purposeMissing} onclick={afterPurpose}>下一步</button>
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
                  class="btn btn--ghost btn--sm"
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
            class="btn btn--ghost"
            disabled={materialDraft.trim() === ''}
            onclick={addMaterial}>加上这一份</button
          >
          <button type="button" class="btn btn--primary" onclick={() => (stage = 'ready')}>
            {blankMaterials.length === 0 ? '跳过' : '下一步'}
          </button>
        </div>
        <p class="faint fs-xs">
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
          <p class="faint fs-xs" data-intake-blocked>{blocked}</p>
        {/if}
        {#if cannotStart !== ''}
          <p class="faint fs-xs" data-intake-blocked>{cannotStart}</p>
        {/if}
        <div class="intake-actions">
          <button
            type="button"
            class="btn btn--primary"
            disabled={blocked !== undefined}
            title={blocked}
            onclick={finish}>开始提炼</button
          >
          <button type="button" class="btn btn--ghost" onclick={() => (stage = 'start')}>重答</button>
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
  /* 「是哪一份？」那一屏的选项：名字与徽标一行、描述一行（分批第 235 批） */
  /**
   * ★ 分批第 236 批（使用者："第一个选项只显示了『安装的』，第二个选项是一段英文，
   * 不是应该是 SKILL 名字"）：**名字是主角**。
   *
   * 上一版把名字排在 14px 常规字重里，下面紧跟一段同样大小的描述——于是有描述的那一项
   * 读起来像"一段英文"，没描述的那一项只剩个徽标。名字是 slug 形态的标识（含连字符、
   * 无空格），用等宽字体 + 字重才是它该有的样子：一眼就是"这一份叫什么"。
   */
  /* 统一高度：有描述（两行）与没描述（一行）看起来一样高——否则列表参差，不好扫 */
  .skill-choice { width: 100%; gap: 0.15rem; min-height: 3.9rem; justify-content: center; }
  .skill-head { display: flex; align-items: baseline; gap: var(--sp-2); width: 100%; }
  .skill-name {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: var(--fs-base);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* 徽标：极淡的胶囊，一眼分得清「你的 / 安装的」而不抢名字 */
  .skill-badge {
    margin-left: auto;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 0.4rem;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  /**
   * 描述**最多两行**（超了省略，全文在徽标那一堆 `title`…不，在这里另给一个 `title`）。
   *
   * 为什么必须夹住：技能库里那些 description 是三五十个字起步（`algorithmic-art` 那条约
   * 200 字），十份列出来每个选项 200px 高——"挑哪一份"变成"读一篇文档"。挑的时候只要
   * 认出是它，所以两行 + 悬停可读全文是够的。
   */
  /**
   * 描述退到**一行**、更淡更小：它只是"这份技能大概是干什么的"，不是让选项变成一段英文。
   * 全文仍在 `title` 里（悬停可读）。`fireworks-tech-graph` 那种**没有描述**的，这一行
   * 干脆不画（`min-height` 让两种选项看起来还是一样高）。
   */
  .skill-desc {
    color: var(--text-faint);
    font-size: var(--fs-xs);
    text-align: left;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .intake-note { margin: var(--sp-1) 0 0; color: var(--text-faint); font-size: var(--fs-xs); }
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
