<script lang="ts">
  import { createAgent, skills } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'

  /**
   * 新建智能体。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两个字段最容易被填错，所以各给一句解释
   * ══════════════════════════════════════════════════════════════════
   *
   * **指令**是"这个 agent 是谁、怎么干活"，会进它的上下文；
   * **认哪些 kind** 是路由键——它决定"什么样的报告交给它审"。
   * 后者尤其容易空着，而空着的后果是"它谁也接不到"，且**没有任何报错**。
   *
   * 兜底审核者是"没人认领的 kind 归它"——只能有一个才有意义，所以界面上
   * 明说了这一点。
   */
  export let oncreated: () => void = () => {}

  let open = false
  let name = ''
  let instructions = ''
  let selectedSkills: string[] = []
  let kindPatterns = ''
  let isFallbackReviewer = false
  let autoReview = true
  let maxConcurrentRuns = 1
  let workDir = ''
  let busy = false
  let error = ''

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    error = ''
    busy = true
    try {
      await createAgent({
        name,
        instructions,
        skillIds: selectedSkills,
        kindPatterns: kindPatterns
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        isFallbackReviewer,
        autoReview,
        maxConcurrentRuns,
        workDir,
      })
      name = ''
      instructions = ''
      selectedSkills = []
      kindPatterns = ''
      isFallbackReviewer = false
      workDir = ''
      open = false
      showToast('智能体已创建')
      oncreated()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

{#if !open}
  <button type="button" onclick={() => (open = true)}>新建智能体</button>
{:else}
  <form onsubmit={submit} class="agent-form">
    <h3>新建智能体</h3>

    <label>
      名称
      <input bind:value={name} placeholder="例如：安全审核员" required autocomplete="off" />
    </label>

    <label>
      指令
      <textarea
        bind:value={instructions}
        rows="3"
        placeholder="描述它是谁、怎么干活。这段会进它的上下文。"
      ></textarea>
    </label>

    <label>
      挂载的 skill（决定它用什么<strong>审核标准</strong>）
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
      <span class="hint">
        没挂 skill 的 agent <strong>不能承担审核</strong>——审核标准就写在 skill 里。
      </span>
    </label>

    <label>
      认哪些 kind（逗号分隔，支持通配）
      <input bind:value={kindPatterns} placeholder="ci-failure, security-*, *" autocomplete="off" />
      <span class="hint">
        这是<strong>路由键</strong>：报告按它的 kind 决定交给谁审。
        填 <code>*</code> 表示什么都接；<strong>留空则谁也接不到</strong>。
      </span>
    </label>

    <div class="row">
      <label class="inline">
        <input type="checkbox" bind:checked={isFallbackReviewer} />
        作为兜底审核者
      </label>
      <label class="inline">
        <input type="checkbox" bind:checked={autoReview} />
        执行完自动接一次审核
      </label>
    </div>
    {#if isFallbackReviewer}
      <p class="hint">
        兜底审核者接住<strong>没有 agent 认领的 kind</strong>。配一个就够——
        多个兜底者的优先级没有定义，那属于配置错误。
      </p>
    {/if}

    <div class="row">
      <label>
        并发上限
        <input type="number" min="1" bind:value={maxConcurrentRuns} />
      </label>
      <label>
        默认工作目录（可选）
        <input bind:value={workDir} placeholder="留空 = 每个任务自动分配" />
      </label>
    </div>

    {#if error}
      <div class="notice bad" style="margin-bottom:var(--sp-3)">{error}</div>
    {/if}

    <div style="display:flex;gap:var(--sp-2)">
      <button type="submit" disabled={busy || !name.trim()}>
        {busy ? '创建中…' : '创建'}
      </button>
      <button type="button" class="secondary" onclick={() => (open = false)}>取消</button>
    </div>
  </form>
{/if}

<style>
  /* 表单直接铺在内容里（而不是弹窗）：建 agent 是个需要边看 skill 列表
     边填的动作，弹窗会挡住它要参考的东西 */
  .agent-form {
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    padding: var(--sp-4);
    margin-bottom: var(--sp-5);
    max-width: 46rem;
  }

  .agent-form h3 { margin-bottom: var(--sp-4); }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
  }

  .inline {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .inline input { width: auto; }

  /* skill 多选做成栅格而不是原生多选框：原生 <select multiple> 在
     macOS 上要按着 Cmd 点，几乎没人知道 */
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

  .skill-option {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: 0;
    cursor: pointer;
  }

  .skill-option input { width: auto; }
</style>
