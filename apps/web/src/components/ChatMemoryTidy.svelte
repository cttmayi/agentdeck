<script lang="ts">
  /**
   * 「整理成记忆」（分批第 240 批起，**第 243 批改成"分析整段对话"**）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它怎么工作
   * ══════════════════════════════════════════════════════════════════
   *
   *   ① 点「开始分析」⇒ `POST /api/conversations/{id}/memory-tidy`：平台把整段对话
   *      落成 `transcript.md`，起一条**分析 run**（`subject.type: 'memory-tidy'`）；
   *   ② 轮询 `GET .../memory-tidy/{runId}`：跑着就显示"正在分析"，跑完拿到候选；
   *   ③ 候选摆在这里：**逐条可改正文、可换类型、可取消勾**（默认全勾——它挑出来的
   *      已经过了"下次还用得上"那一关，人只需要否掉不对的）；
   *   ④ 点「记下这 N 条」⇒ 交给调用方写库（对话框自己**不写**：写入口只有一个）。
   *
   * ★ 只有人能写这条铁律没有变。分析产出的是**候选**，它没有写权限——真正落进记忆的
   *   是人在这一步按下那一下。
   *
   * ⚠️ 第一版（第 240 批）是"把我说过的话逐字列出来让人勾"：原话多半是"这次"的话，
   *    勾了也不是经验，而 agent 自己说过的判断根本不在候选里。使用者的原话是
   *    「类似沉淀技能一样，分析整段对话」——所以现在是分析，不是摘录。
   */
  import { Modal } from '@agentdeck/ui/components'
  import { api } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'

  export type MemoryKindId = 'preference' | 'fact' | 'lesson' | 'commitment'

  /** 分析出来的候选（服务端解析好的形状；`id` 只是界面上的 key）。 */
  export interface TidyCandidate {
    id: string
    text: string
    kind: MemoryKindId
    /** 它声称的人的原话（逐字）；`null` = 没给。 */
    from: string | null
    /** 平台核对过：这段原话真的在人说过的话里。 */
    grounded: boolean
  }

  type Answer = {
    status: string
    candidates: Array<{ kind: MemoryKindId; text: string; from: string | null; grounded: boolean }> | null
    dropped: Array<{ text: string; reason: string }>
    parsed: boolean
    failure?: string | null
  }

  let {
    open = $bindable(false),
    /** 在哪条对话上整理（空 = 还没打开任何对话，按钮不该可用）。 */
    conversationId = '',
    onconfirm,
    oncancel,
  }: {
    open?: boolean
    conversationId?: string
    onconfirm: (items: Array<{ text: string; kind: MemoryKindId; evidence?: string }>) => void
    oncancel: () => void
  } = $props()

  type Phase = 'idle' | 'running' | 'review' | 'empty' | 'error'
  let phase = $state<Phase>('idle')
  let errorText = $state('')
  /**
   * 候选行。`on` 的初值 = **`grounded`**（分批第 244 批）。
   *
   * 出处对不上的默认**不勾**：那是它自己编的或者记岔的（使用者举的例子：人只说了一句
   * "分析这个仓库"，却整理出了记忆）。人仍然可以亲手勾上——决定权在他，但默认不给。
   */
  let rows = $state<
    Array<{
      id: string
      text: string
      kind: MemoryKindId
      from: string | null
      grounded: boolean
      on: boolean
    }>
  >([])
  let droppedNote = $state('')
  let tidyRunId = $state('')
  let elapsed = $state(0)
  let timer: ReturnType<typeof setInterval> | null = null
  let ticker: ReturnType<typeof setInterval> | null = null

  function stopTimers(): void {
    if (timer !== null) clearInterval(timer)
    if (ticker !== null) clearInterval(ticker)
    timer = null
    ticker = null
  }

  /** 关掉时把这一切都收掉：轮询不能留着（它会一直打服务端）。 */
  function reset(): void {
    stopTimers()
    phase = 'idle'
    errorText = ''
    rows = []
    droppedNote = ''
    tidyRunId = ''
    elapsed = 0
  }

  /**
   * 开始分析。
   *
   * ⚠️ 轮询而不是阻塞等待：一次分析要几十秒到几分钟（它要把整段对话读一遍）。
   *    阻塞的话浏览器/代理超时，而人看不到"它到底在动没有"——所以有秒数在跳。
   */
  async function start(): Promise<void> {
    if (conversationId === '') return
    reset()
    phase = 'running'
    const startedAt = Date.now()
    ticker = setInterval(() => {
      elapsed = Math.round((Date.now() - startedAt) / 1000)
    }, 500)
    let runId = ''
    try {
      const out = await api<{ tidyRunId: string }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/memory-tidy`,
        { method: 'POST' },
      )
      runId = out.tidyRunId
      tidyRunId = runId
    } catch (err) {
      stopTimers()
      phase = 'error'
      errorText = err instanceof Error ? err.message : String(err)
      return
    }
    timer = setInterval(() => {
      void poll(runId)
    }, 1500)
    void poll(runId)
  }

  async function poll(runId: string): Promise<void> {
    try {
      const out = await api<Answer>(
        `/api/conversations/${encodeURIComponent(conversationId)}/memory-tidy/${encodeURIComponent(runId)}`,
      )
      if (out.candidates === null) return // 还在跑
      stopTimers()
      if (out.candidates.length === 0) {
        phase = 'empty'
        droppedNote = out.parsed
          ? ''
          : $t('chat.tidyUnparsed')
        if (out.failure) errorText = out.failure
        return
      }
      rows = out.candidates.map((c, i) => ({
        id: `${String(i)}-${c.text.slice(0, 12)}`,
        text: c.text,
        kind: c.kind,
        from: c.from,
        grounded: c.grounded,
        on: c.grounded,
      }))
      const dropped = out.dropped.length
      droppedNote = dropped === 0 ? '' : $t('chat.tidyDropped', { n: String(dropped) })
      phase = 'review'
    } catch (err) {
      stopTimers()
      phase = 'error'
      errorText = err instanceof Error ? err.message : String(err)
    }
  }

  const chosen = $derived(rows.filter((r) => r.on && r.text.trim() !== ''))

  function confirm(): void {
    onconfirm(
      chosen.map((r) => ({
        text: r.text.trim(),
        kind: r.kind,
        // 出处：这次整理那条 run（"这条记忆是哪次整理挑出来的"以后查得到）
        ...(tidyRunId === '' ? {} : { evidence: tidyRunId }),
      })),
    )
    open = false
    reset()
  }

  function close(): void {
    open = false
    reset()
    oncancel()
  }
</script>

<Modal
  {open}
  title={$t('chat.tidyTitle')}
  subtitle={$t('chat.tidyHint')}
  closeLabel={$t('common.close')}
  onclose={close}
>
  {#if phase === 'idle'}
    <div class="tidy-intro" data-tidy-intro>
      <p class="hint">{$t('chat.tidyExplain')}</p>
      <button
        type="button"
        class="primary"
        data-tidy-start
        disabled={conversationId === ''}
        onclick={() => void start()}>{$t('chat.tidyStart')}</button
      >
      {#if conversationId === ''}
        <span class="hint">{$t('chat.tidyNoConversation')}</span>
      {/if}
    </div>
  {:else if phase === 'running'}
    <div class="tidy-running" data-tidy-running>
      <p class="hint">{$t('chat.tidyRunning', { s: String(elapsed) })}</p>
      <p class="hint faint">{$t('chat.tidyRunningHint')}</p>
    </div>
  {:else if phase === 'error'}
    <p class="notice bad" data-tidy-error>{errorText}</p>
    <div class="tidy-actions">
      <span class="spacer"></span>
      <button type="button" class="ghost" onclick={close}>{$t('common.close')}</button>
      <button type="button" class="secondary" onclick={() => void start()}>
        {$t('chat.tidyRetry')}
      </button>
    </div>
  {:else if phase === 'empty'}
    <div data-tidy-empty>
      <p class="hint">{$t('chat.tidyNone')}</p>
      {#if droppedNote}<p class="hint faint">{droppedNote}</p>{/if}
      {#if errorText !== ''}<p class="hint faint">{errorText}</p>{/if}
    </div>
    <div class="tidy-actions">
      <span class="spacer"></span>
      <button type="button" class="ghost" onclick={close}>{$t('common.close')}</button>
      <button type="button" class="secondary" onclick={() => void start()}>
        {$t('chat.tidyRetry')}
      </button>
    </div>
  {:else}
    {#if droppedNote}<p class="hint" data-tidy-dropped>{droppedNote}</p>{/if}
    <div class="tidy-list" data-tidy-list>
      {#each rows as row (row.id)}
        <div class="tidy-row" class:on={row.on} class:ungrounded={!row.grounded}>
          <input
            type="checkbox"
            data-tidy-check
            checked={row.on}
            onchange={(e) => {
              const on = (e.currentTarget as HTMLInputElement).checked
              rows = rows.map((r) => (r.id === row.id ? { ...r, on } : r))
            }}
          />
          <span class="tidy-main">
            <textarea
              class="tidy-text"
              data-tidy-text
              rows={1}
              value={row.text}
              oninput={(e) => {
                const text = (e.currentTarget as HTMLTextAreaElement).value
                rows = rows.map((r) => (r.id === row.id ? { ...r, text } : r))
              }}
            ></textarea>
            <!--
              ★ 出处（分批第 244 批）：记忆的源头必须是**人的话**。这一行让"它是不是编的"
                一眼可判——`grounded` 是平台核对的，不是它自己说的。
            -->
            {#if row.from !== null}
              <span class="tidy-from" class:bad={!row.grounded} data-tidy-from>
                {row.grounded
                  ? $t('chat.tidyFrom', { quote: row.from })
                  : $t('chat.tidyFromUnverified', { quote: row.from })}
              </span>
            {:else}
              <span class="tidy-from bad" data-tidy-from>{$t('chat.tidyNoFrom')}</span>
            {/if}
          </span>
          <select
            aria-label={$t('agents.memoryKindLabel')}
            value={row.kind}
            onchange={(e) => {
              const kind = (e.currentTarget as HTMLSelectElement).value as MemoryKindId
              rows = rows.map((r) => (r.id === row.id ? { ...r, kind } : r))
            }}
          >
            <option value="preference">{$t('agents.memoryKind.preference')}</option>
            <option value="fact">{$t('agents.memoryKind.fact')}</option>
            <option value="lesson">{$t('agents.memoryKind.lesson')}</option>
            <option value="commitment">{$t('agents.memoryKind.commitment')}</option>
          </select>
        </div>
      {/each}
    </div>
  {/if}

  {#if phase === 'review'}
    <div class="tidy-actions">
      <span class="hint" data-tidy-count>{$t('chat.tidyCount', { n: String(chosen.length) })}</span>
      <span class="spacer"></span>
      <button type="button" class="ghost" onclick={close}>{$t('common.cancel')}</button>
      <button
        type="button"
        class="primary"
        data-tidy-confirm
        disabled={chosen.length === 0}
        onclick={confirm}>{$t('chat.tidyConfirm', { n: String(chosen.length) })}</button
      >
    </div>
  {/if}
</Modal>

<style>
  .tidy-intro {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-2);
  }
  .tidy-running {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .tidy-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    max-height: 60vh;
    overflow-y: auto;
  }
  .tidy-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--line);
  }
  .tidy-row:first-child {
    border-top: 0;
  }
  .tidy-row.on {
    background: var(--surface-hover);
  }
  /*
   * 正文可改（分析出来的说法未必要原样收下）。用 textarea 而不是 input：
   * 一条记忆可以写到几十个字，单行输入框里改长句是在盲改。`rows=1` + 自动长高
   * 由 `field-sizing` 兼顾不了的浏览器保持一行高——不折行也比看不见后半句强。
   */
  .tidy-text {
    flex: 1 1 auto;
    min-width: 0;
    resize: vertical;
    font-size: var(--fs-sm);
    line-height: 1.45;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 4px);
    padding: 2px 4px;
    color: var(--text-dim);
    field-sizing: content;
  }
  .tidy-row.on .tidy-text {
    color: var(--text);
    border-color: var(--line);
    background: var(--surface);
  }
  .tidy-text:focus {
    outline: none;
    border-color: var(--accent);
  }
  /* 正文 + 出处上下排：正文可改，出处只读（它是核对结果，不是可编辑的内容） */
  .tidy-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .tidy-from {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    /* 原话可能很长：折两行够了，再多就靠 hover */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tidy-from.bad {
    color: var(--text-warn, #b9770e);
  }
  .tidy-row.ungrounded {
    /* 出处对不上的整行压暗：它默认不勾，视觉上也别和"有出处"的混在一起 */
    opacity: 0.75;
  }
  .tidy-row select {
    flex: 0 0 auto;
    width: auto;
    font-size: var(--fs-xs);
  }
  .tidy-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
  }
  .tidy-actions .spacer {
    flex: 1;
  }
  .hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin: 0;
  }
</style>
