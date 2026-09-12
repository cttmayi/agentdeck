<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { RunMessage } from '../lib/api.ts'

  export let runId: string
  /** 已订阅到的最大 seq；重连时用它补齐错过的消息（FR-BRIDGE-04）。 */
  export let since = -1
  export let onterminal: (status: string) => void = () => {}

  /**
   * 实时日志。
   *
   * ══════════════════════════════════════════════════════════════════
   * seq 驱动，不靠时间戳
   * ══════════════════════════════════════════════════════════════════
   *
   * `since` 传的是**序号**而不是时间。时间戳做不到"补齐错过的消息"：
   * 同一毫秒可能有多条，本地时钟还可能回拨。序号单调，`since=N` 就是
   * "把 N 之后的都给我"（FR-BRIDGE-18）。
   *
   * 重连时浏览器会自动重发请求，我们从 `lastSeq` 继续，因此**既不丢也不重**。
   */
  let rows: Array<{ seq: number | null; kind: string; text: string }> = []

  /**
   * 是否显示模型的**思考过程**（`thinking` 消息）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这是从一次"这段文字是从哪来的"的疑问里加上的
   * ══════════════════════════════════════════════════════════════════
   *
   * Claude Code 会在 stream-json 里输出 `thinking` 块（它的内部推理），
   * 我们如实解析并落库——但它原来在界面上**和普通输出长得一模一样**
   *（没有 `.log-text.thinking` 这条样式规则，落到了默认色）。
   *
   * 于是使用者看到一段第一人称、英文、还在斟酌"这个任务到底要什么"的文字，
   * 而它看起来就是 agent 的正式回答。**看不出这是思考，就会以为它是结论。**
   *
   * 两件事一起做：**样式上区分开**，并且**默认折叠**——思考过程通常很长
   *（一次 run 里占掉大半篇幅），把它和真正的产出混排会把产出淹掉。
   * 要排查时打开即可，选择记在本地。
   */
  const THINKING_KEY = 'alpha-helper.show-thinking'
  let showThinking = localStorage.getItem(THINKING_KEY) === '1'

  function toggleThinking(): void {
    showThinking = !showThinking
    localStorage.setItem(THINKING_KEY, showThinking ? '1' : '0')
  }

  $: thinkingCount = rows.filter((r) => r.kind === 'thinking').length
  $: visibleRows = showThinking ? rows : rows.filter((r) => r.kind !== 'thinking')
  let source: EventSource | null = null
  let lastSeq = since
  let live = true

  function connect(id: string, from: number): void {
    close()
    source = new EventSource(`/api/runs/${id}/events?since=${from}`)
    source.onmessage = (event) => {
      let payload: { seq?: number; t?: string; [k: string]: unknown }
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      apply(payload)
    }
    source.onerror = () => {
      // 浏览器会自动重连；这里只记一行，不打断阅读
      rows = [...rows, { seq: null, kind: 'status', text: '连接中断，正在重连…' }]
    }
  }

  function apply(event: { seq?: number; t?: string; [k: string]: unknown }): void {
    const seq = typeof event.seq === 'number' ? event.seq : null
    if (seq !== null) {
      if (seq <= lastSeq) return // 去重
      lastSeq = seq
    }
    const push = (kind: string, text: string): void => {
      rows = [...rows, { seq, kind, text }]
    }

    switch (event['t']) {
      case 'message': {
        const m = event['message'] as RunMessage
        push(m.type, m.content)
        break
      }
      case 'status':
        push('status', `状态：${String(event['status'])}`)
        break
      case 'progress':
        push('status', `${String(event['summary'])}（${String(event['step'])}/${String(event['total'])}）`)
        break
      case 'usage': {
        const u = event['usage'] as { inputTokens: number; outputTokens: number; costUsdMicros: number; costSource: string }
        push(
          'status',
          `用量：输入 ${u.inputTokens} / 输出 ${u.outputTokens} / 成本 $${(u.costUsdMicros / 1e6).toFixed(4)}` +
            `（${u.costSource === 'provider' ? 'provider 上报' : '估算'}）`,
        )
        break
      }
      case 'terminal': {
        const err = event['error'] as { message?: string } | null
        push('terminal', `结束：${String(event['status'])}${err?.message ? ` — ${err.message}` : ''}`)
        live = false
        close()
        onterminal(String(event['status']))
        break
      }
      default:
        break
    }
  }

  function close(): void {
    source?.close()
    source = null
  }

  $: if (runId) connect(runId, since)

  onDestroy(close)
</script>

<div class="log-wrap">
  {#if thinkingCount > 0}
    <div class="log-toolbar">
      <button type="button" class="ghost small" onclick={toggleThinking}>
        {showThinking ? '隐藏' : '显示'}思考过程（{thinkingCount} 段）
      </button>
      <span class="faint small">
        思考过程是模型的内部推理，**不是**它给你的回答——两者在下面用样式区分
      </span>
    </div>
  {/if}

  <div class="log">
    {#if visibleRows.length === 0}
      <div class="log-row">
        <span class="log-seq">·</span>
        <span class="hint">
          {thinkingCount > 0 ? '（当前只隐藏了思考过程，没有别的输出）' : '等待输出…'}
        </span>
      </div>
    {/if}
    {#each visibleRows as row, i (i)}
      <div class="log-row">
        <span class="log-seq">{row.seq ?? '·'}</span>
        <span class="log-text {row.kind}">
          {#if row.kind === 'thinking'}<span class="thinking-tag">思考</span>{/if}
          {row.text}
        </span>
      </div>
    {/each}
  </div>
</div>

<style>
  .log-wrap {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .log-toolbar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .log-toolbar .ghost {
    padding: var(--sp-1) var(--sp-2);
  }

  .log {
    border: 0;
    border-radius: 0;
    max-height: 26rem;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2) var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.55;
  }

  .log-row {
    display: flex;
    gap: var(--sp-3);
    padding: 1px 0;
  }

  /* 序号用固定宽度并右对齐：运行中它会不断变宽，不定宽会让整列文字
     在每一行重排时轻微横移，看久了很晃 */
  .log-seq {
    flex: 0 0 2.5rem;
    text-align: right;
    color: var(--text-faint);
    user-select: none;
  }

  .log-text {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-dim);
  }

  /* 用颜色区分消息类型，但**克制**：只有真正需要区分的才上色 */
  .log-text.text { color: var(--text); }

  /**
   * ★ 思考过程必须**看得出来是思考**。
   *
   * 原来没有这条规则，于是它落到默认色，和正式输出长得一样——
   * 而它读起来是第一人称、还在斟酌任务的内部独白。**看不出这是思考，
   * 就会把它当成结论。**
   *
   * 用"更暗 + 斜体 + 左侧色条 + 前缀标签"四重区分：单靠颜色不够
   *（色弱、或者屏幕对比度低时就没了）。
   */
  .log-text.thinking {
    color: var(--text-faint);
    font-style: italic;
    border-left: 2px solid var(--line-strong);
    padding-left: var(--sp-3);
  }

  .thinking-tag {
    display: inline-block;
    margin-right: var(--sp-2);
    padding: 0 var(--sp-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    font-style: normal;
    font-size: 0.85em;
    color: var(--text-faint);
    user-select: none;
  }
  .log-text.tool_use { color: var(--accent); }
  .log-text.tool_result { color: var(--text-faint); }
  .log-text.status { color: var(--text-faint); font-style: italic; }
  .log-text.terminal { color: var(--good); }
  .log-text.error { color: var(--bad); }
</style>
