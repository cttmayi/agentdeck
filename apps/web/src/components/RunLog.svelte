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

<div class="log">
  {#if rows.length === 0}
    <div class="log-row"><span class="log-seq">·</span><span class="hint">等待输出…</span></div>
  {/if}
  {#each rows as row, i (i)}
    <div class="log-row">
      <span class="log-seq">{row.seq ?? '·'}</span>
      <span class="log-text {row.kind}">{row.text}</span>
    </div>
  {/each}
</div>

<style>
  .log {
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
  .log-text.tool_use { color: var(--accent); }
  .log-text.tool_result { color: var(--text-faint); }
  .log-text.status { color: var(--text-faint); font-style: italic; }
  .log-text.terminal { color: var(--good); }
  .log-text.error { color: var(--bad); }
</style>
