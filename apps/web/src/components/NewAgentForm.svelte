<script lang="ts">
  import { agents, createAgent, identity, skills } from '../lib/stores.ts'
  import type { AgentRole, ReviewStandard } from '../lib/api.ts'
  import ReviewStandardEditor from './ReviewStandardEditor.svelte'
  import { showToast } from '../lib/view.ts'
  import Drawer from './Drawer.svelte'

  /**
   * 新建智能体（D28）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两个字段决定了这个 agent 的"身份"
   * ══════════════════════════════════════════════════════════════════
   *
   * **角色**：它是干活的还是审的。这一个选择取代了原来四个互相牵扯的开关
   * （认哪些 kind、兜底审核者、自动审核、并发上限）——那些合起来表达的
   * 其实只有两件事，而其中两件是通配模式字符串，需要学。
   *
   * **由谁审我**：只在"执行"角色下出现。选一个审核 agent 的名字即可，
   * 不需要理解路由规则。
   *
   * 其余字段（skill、runtime、工作目录）是"这个 agent 怎么干活"，
   * 各自独立，不参与身份判断。
   */
  /**
   * ══════════════════════════════════════════════════════════════════
   * 受控组件 + **右侧抽屉**：开关由父组件拿着，内容画在抽屉里
   * ══════════════════════════════════════════════════════════════════
   *
   * 这个表单在左栏里待过两版，都不行：
   *
   *   1. 挂在按钮旁边（组件自己管开关）⇒ 它俩必然在同一个容器里，而那个容器
   *      是 416px 宽的头部行；表单按 `max-width: 46rem` 画成 736px，横着盖住
   *      右栏、头部涨到 1070px、清单被顶出视口；
   *   2. 放进左栏正文 ⇒ 不溢出了，但**太窄**：技能多选、runtime、工作目录挤在
   *      358px 里，读起来憋。
   *
   * 现在它是右侧抽屉（46rem = 736px，与「安装 skill」同宽）：浮在主从布局
   * 上面、不动清单，关掉就回到原地。字段宽度交给抽屉，不写死。
   */
  export let open = false
  export let onclose: () => void = () => {}
  export let oncreated: () => void = () => {}

  let name = ''
  let role: AgentRole = 'executor'
  let instructions = ''
  /**
   * 审核标准（D37）——只对审核者有意义。
   *
   * 与「第一句话模版」那个全局配置不同，标准是**每个审核者一份**（不同的领域
   * 用不同的标准，这是 D22 的立场）。执行者保持 `null`。
   */
  let reviewStandard: ReviewStandard | null = null
  let selectedSkills: string[] = []
  let reviewerAgentId = ''
  /**
   * 可选的 runtime —— 从**身份接口**来，不写死两项。
   *
   * 写死的话，新加一个 runtime 之后这个表单里根本选不到它（只有直接调接口
   * 才行）。初始化取第一个可用项，而不是硬编码 'claude'。
   */
  $: runtimeOptions = $identity?.runtimes.map((r) => r.key) ?? []
  let runtimeKey = 'claude'
  let workDir = ''
  let busy = false
  let error = ''

  // 只有"审核"角色才谈得上"由谁审我"
  $: reviewers = $agents.filter((a) => a.role === 'reviewer')


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
        reviewerAgentId: role === 'executor' && reviewerAgentId ? reviewerAgentId : null,
        runtimeKey,
        workDir,
        reviewStandard: role === 'reviewer' ? reviewStandard : null,
      })
      name = ''
      instructions = ''
      reviewStandard = null
      selectedSkills = []
      reviewerAgentId = ''
      workDir = ''
      role = 'executor'
      showToast('智能体已创建')
      // 关不关由父组件决定（它是"正在新建"这个状态的持有者）
      oncreated()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

{#if open}
  <Drawer
    {open}
    wide
    title="新建智能体"
    subtitle={'建好之后它就会按「设置」里那份第一句话模版接活；' +
      '这一段会作为 {{instructions}} 插进模版。'}
    {onclose}
  >
  <form onsubmit={submit} class="agent-form" id="new-agent-form">

    <label>
      名称
      <input bind:value={name} placeholder="例如：安全审核员" required autocomplete="off" />
    </label>

    <!-- 角色：用两个大按钮而不是下拉或单选圆圈——这是一个"选边"的决定，
         值得占视觉重量；下拉会让人一扫而过 -->
    <div class="field">
      <span class="field-label">它是做什么的</span>
      <div class="role-picker">
        <button
          type="button"
          class="role-card"
          class:active={role === 'executor'}
          onclick={() => (role = 'executor')}
        >
          <strong>执行</strong>
          <span>接到任务后动手干活</span>
        </button>
        <button
          type="button"
          class="role-card"
          class:active={role === 'reviewer'}
          onclick={() => (role = 'reviewer')}
        >
          <strong>审核</strong>
          <span>按标准审别人的产出，给判决</span>
        </button>
      </div>
    </div>

    {#if role === 'executor'}
      <label>
        由谁来审它
        {#if reviewers.length === 0}
          <select disabled><option>（还没有审核角色的智能体）</option></select>
          <span class="hint">
            先去建一个「审核」角色的智能体。没有审核者时，执行产出不会被自动审核。
          </span>
        {:else}
          <select bind:value={reviewerAgentId}>
            <option value="">不自动审核</option>
            {#each reviewers as r (r.id)}
              <option value={r.id}>{r.name}</option>
            {/each}
          </select>
          <span class="hint">
            执行完由它审。选「不自动审核」也是一个明确的选择——不配时每个任务都多跑
            一次审核会既费钱又吵。
          </span>
        {/if}
      </label>
    {/if}

    <label>
      指令
      <textarea
        bind:value={instructions}
        rows="3"
        placeholder={role === 'reviewer'
          ? '它按什么态度审：严格还是宽松、拿不准时怎么办'
          : '它是谁、怎么干活。这段会进它的上下文。'}
      ></textarea>
      <span class="hint">
        这一段会填进第一句话模版的 <code>{'{{instructions}}'}</code>。留空也行——那就只有任务本身。
      </span>
    </label>

    {#if role === 'reviewer'}
      <!-- D37：标准是审核者的判断依据，写在它自己身上 -->
      <ReviewStandardEditor bind:value={reviewStandard} />
    {/if}

    <label>
      挂载的 skill
      {#if $skills.length === 0}
        <select disabled><option>（还没有 skill）</option></select>
      {:else}
        <div class="skill-picker">
          {#each $skills as s (s.id)}
            <label class="skill-option">
              <input type="checkbox" value={s.id} bind:group={selectedSkills} />
              <span><code>{s.slug}</code> <span class="faint small">{s.name}</span></span>
            </label>
          {/each}
        </div>
      {/if}
      {#if role === 'reviewer'}
        <span class="hint">
          审核者的判断依据是上面那条<strong>审核标准</strong>，skill 对它只是可选的
          参考/支持文件（挂上就会随审核一起送过去）。
        </span>
      {:else}
        <span class="hint">执行者可以不挂 skill（它的产出由审核者按标准来判）。</span>
      {/if}
    </label>

    <div class="row">
      <label>
        用哪个 runtime
        <select bind:value={runtimeKey}>
          {#each runtimeOptions as key (key)}
            {@const r = $identity?.runtimes.find((x) => x.key === key)}
            <option value={key}>
              {key}{r && r.evidence !== 'verified' ? '（未对照真实程序）' : ''}
            </option>
          {/each}
          {#if !runtimeOptions.includes(runtimeKey)}
            <option value={runtimeKey}>{runtimeKey}（当前）</option>
          {/if}
        </select>
      </label>
      <label>
        默认工作目录（可选）
        <input bind:value={workDir} placeholder="留空 = 每个任务自动分配" />
      </label>
    </div>

  </form>

    <!-- 主操作常驻底部：表单很长，正文一长就不该让人先滚到底才能按 -->
    <svelte:fragment slot="foot">
      <button type="submit" form="new-agent-form" disabled={busy || !name.trim()}>
        {busy ? '创建中…' : '创建'}
      </button>
      <button type="button" class="secondary" onclick={onclose} disabled={busy}>取消</button>
      {#if error}
        <span class="bad small">{error}</span>
      {/if}
    </svelte:fragment>
  </Drawer>
{/if}

<style>
  /**
   * ⚠️ 这里曾经有一个 `max-width: 46rem`：它在 416px 宽的 flex 行里不会收缩，
   *    于是把表单画成 736px、横着盖住右栏。现在**宽度由抽屉决定**，
   *    这里只管排版（外面有 `.drawer-body` 的 padding）。
   */
  .agent-form {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  .field { margin-bottom: var(--sp-3); }

  .field-label {
    display: block;
    font-size: var(--fs-sm);
    color: var(--text-dim);
    margin-bottom: var(--sp-1);
  }

  /**
   * 两张角色卡在 416px 的栏里并排只剩 ~150px 一张（说明文字会挤成几行），
   * 所以按容器宽度自动决定：宽了并排、窄了竖着——同一个 `auto-fit` 套路。
   */
  .role-picker {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
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
   * 两列字段（runtime / 工作目录）按**容器**宽度决定列数：宽了并排、窄了一列。
   * 用 `auto-fit` + `minmax` 而不是媒体查询——这个表单待在抽屉里，抽屉宽度
   * 与视口宽度不是一回事。
   */
  .row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--sp-3);
  }

  .skill-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: var(--sp-1);
    margin-top: var(--sp-2);
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    background: var(--bg);
  }

  .skill-option { display: flex; align-items: center; gap: var(--sp-2); margin: 0; cursor: pointer; }
  .skill-option input { width: auto; }
</style>
