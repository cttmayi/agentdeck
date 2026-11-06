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
  size="wide"
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
        <!--
          ★ 分批第 246 批：**三列栅格**（勾选框 / 正文+出处 / 类型）。
          第一版是 flex + `align-items: center`：一行里正文两行、下一行正文一行，
          于是勾选框在每一行的"竖直中心"——**看起来一个高一个低**；而正文是
          `flex: 1 1 auto` + `field-sizing: content`，短句撑不满同一宽度，**每条宽度都不一样**。
          栅格把三列的宽度与左边缘钉死（`auto 1fr auto`），对齐就由布局本身保证，
          不靠"大家都一样高"这种运气。
        -->
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
              <span
                class="tidy-from"
                class:bad={!row.grounded}
                data-tidy-from
                title={row.grounded
                  ? $t('chat.tidyFrom', { quote: row.from })
                  : $t('chat.tidyFromUnverified', { quote: row.from })}
              >
                <!-- ★ 只显示**一行**（超出省略、全文在 title 里）：出处是给"它是不是编的"
                     一个凭据，不是给人逐字读的正文——摊成两三行会让整个列表变得很长。 -->
                <span class="tidy-from-mark" aria-hidden="true">{row.grounded ? '✓' : '⚠'}</span>
                <span class="tidy-from-t">
                  {row.grounded ? row.from : $t('chat.tidyFromUnverifiedShort', { quote: row.from })}
                </span>
              </span>
            {:else}
              <span class="tidy-from bad" data-tidy-from title={$t('chat.tidyNoFrom')}>
                <span class="tidy-from-mark" aria-hidden="true">⚠</span>
                <span class="tidy-from-t">{$t('chat.tidyNoFrom')}</span>
              </span>
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
      <!--
        ★ 分批第 248 批：把"泛不泛化"这道自检也摆到人面前。
        使用者打回过一条「不要把 Distilly 比喻成编译器」——那段对话是**调研 Distilly**，
        这条只在又聊到 Distilly 时成立，是这次的记录而不是经验，还会挤掉通用条目
        （每个智能体只有 40 条 / 1200 字预算）。规矩写进了整理者的身份，这里给人同一个尺子。
      -->
      <span class="hint faint" data-tidy-generalize>{$t('chat.tidyGeneralizeHint')}</span>
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
  /*
   * ★ 分批第 246 批（使用者："位置很丑，选中框没有对齐，每一条的宽度也不一样"）：
   *   · **栅格**而不是 flex：三列（勾选框 / 正文+出处 / 类型）的宽度与左边缘都由布局钉死；
   *   · 三列**顶部对齐**（`align-items: start`）：正文两行时勾选框也贴着第一行，
   *     不再"高一行低一行"；
   *   · 正文列 `1fr`（等宽），不许被内容撑开——每一行的文字左边缘与右边缘都在同一条线上；
   *   · 出处只占一行（省略号 + title 全文）：出处是凭据，不是正文，摊两行会把列表拉长一倍。
   */
  .tidy-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
    max-height: 62vh;
    overflow-y: auto;
  }
  .tidy-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--sp-2) var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    border-top: 1px solid var(--line);
  }
  .tidy-row:first-child {
    border-top: 0;
  }
  .tidy-row.on {
    background: var(--surface-hover);
  }
  /* 勾选框：与第一行文字**垂直居中**（不是与整块居中）——`0.36em` 是让方框落在
     首行文字的中线上；每行一样，所以上下行的方框必然齐。 */
  .tidy-row > input[type='checkbox'] {
    margin: 0.36em 0 0;
    width: 1em;
    height: 1em;
  }
  .tidy-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  /*
   * 正文可改（分析出来的说法未必要原样收下）。`rows=1` + `field-sizing: content`
   * 让短句就是一行、长句自己长高；`max-height` 卡在两行多，再长就内部滚动
   * （候选正文上限 400 字，但列表里不需要一次显示完）。
   */
  .tidy-text {
    width: 100%;
    resize: none;
    font-size: var(--fs-sm);
    line-height: 1.45;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 4px);
    padding: 1px 4px;
    color: var(--text-dim);
    field-sizing: content;
    /* ⚠️ 必须显式压掉全局那条 `textarea { min-height: 4rem }`（`app.css` 里给表单写的）：
       留着它，一行高的候选也会被撑到 64px，加上出处那行整行 100px——
       实测就是这个数（行高 [101,102,102]），列表凭空长出两倍。 */
    min-height: 0;
    height: auto;
    max-height: 4.4em;
    overflow-y: auto;
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
  /* 出处：**一行**，超出省略（全文在 title 里） */
  .tidy-from {
    display: block;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    padding-left: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tidy-from.bad {
    color: var(--text-warn, #b9770e);
  }
  .tidy-from-mark {
    margin-right: 4px;
  }
  .tidy-row.ungrounded {
    /* 出处对不上的整行压暗：它默认不勾，视觉上也别和有出处的混在一起 */
    opacity: 0.75;
  }
  /* 类型选择器：**固定宽度**，所有行的下拉右边缘对齐（宽度随最长选项定死，
     不随当前选中的那个词伸缩——那就是第一版"每一条宽度都不一样"的另一半）。 */
  .tidy-row select {
    width: 5.2em;
    margin-top: 2px;
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
