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
  /**
   * 日志行。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么必须带上 `input` 与 `output`
   * ══════════════════════════════════════════════════════════════════
   *
   * 它们**一直在数据里**：解析器抓了、执行器落库了、接口也发了——
   * 只有界面从来没用过。于是日志里只有一行"调用工具 Bash"，
   * **看不到它到底跑了什么命令**。而排查时那正是要看的东西。
   *
   * 这个缺失很隐蔽：数据链路每一段都是对的，只有最后一段没接上，
   * 所以任何后端测试都发现不了。
   */
  let rows: Array<{
    seq: number | null
    kind: string
    text: string
    tool: string | null
    input: Record<string, unknown> | null
    output: string | null
    outputTruncated: boolean
  }> = []

  /** 展开的行（长输入/输出默认折叠）。 */
  let expanded = new Set<number>()

  function toggleRow(i: number): void {
    const next = new Set(expanded)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    expanded = next
  }

  /** 把结构化输入渲染成人能读的样子。 */
  function formatInput(input: Record<string, unknown> | null): string {
    if (!input) return ''
    const keys = Object.keys(input)
    // 单键且值是短字符串时直接给值——`{"command": "ls"}` 那种包一层反而难读
    if (keys.length === 1) {
      const only = input[keys[0]!]
      if (typeof only === 'string') return only
    }
    try {
      return JSON.stringify(input, null, 2)
    } catch {
      return String(input)
    }
  }

  /**
   * 折叠阈值。
   *
   * 工具的输入/输出可能是几 KB 的内容（读一个文件、跑一条长命令）。
   * 全部铺开会把日志冲掉，而**被冲掉的日志等于没有日志**——所以默认折叠、
   * 只给一行预览，需要时再展开。
   */
  const PREVIEW_CHARS = 160

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
      // ⚠️ 这里不能直接拼对象字面量：会漏掉 tool/input/output 四个字段，
      //    而类型检查会（也应该）因此报错。`push` 在 `apply()` 里，
      //    作用域够不到，所以给一个等价的、字段齐全的构造。
      //
      //    这处"漏字段"不是纯理论——它正是被类型检查当场抓出来的。
      rows = [
        ...rows,
        {
          seq: null,
          kind: 'status',
          text: '连接中断，正在重连…',
          tool: null,
          input: null,
          output: null,
          outputTruncated: false,
        },
      ]
    }
  }

  function apply(event: { seq?: number; t?: string; [k: string]: unknown }): void {
    const seq = typeof event.seq === 'number' ? event.seq : null
    if (seq !== null) {
      if (seq <= lastSeq) return // 去重
      lastSeq = seq
    }
    const push = (
      kind: string,
      text: string,
      extra: Partial<{
        tool: string | null
        input: Record<string, unknown> | null
        output: string | null
        outputTruncated: boolean
      }> = {},
    ): void => {
      rows = [
        ...rows,
        {
          seq,
          kind,
          text,
          tool: extra.tool ?? null,
          input: extra.input ?? null,
          output: extra.output ?? null,
          outputTruncated: extra.outputTruncated ?? false,
        },
      ]
    }

    switch (event['t']) {
      case 'message': {
        const m = event['message'] as RunMessage
        // ★ 把 input / output 一起带上——它们本来就在消息里，只是原来被丢掉了
        push(m.type, m.content, {
          tool: m.tool,
          input: m.input,
          output: m.output,
          outputTruncated: m.outputTruncated,
        })
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
      {@const payload = row.kind === 'tool_use' ? formatInput(row.input) : (row.output ?? '')}
      {@const isLong = payload.length > PREVIEW_CHARS}
      {@const open = expanded.has(i)}
      <div class="log-row">
        <span class="log-seq">{row.seq ?? '·'}</span>
        <div class="log-body">
          <span class="log-text {row.kind}">
            {#if row.kind === 'thinking'}<span class="thinking-tag">思考</span>{/if}
            {row.text}
            {#if row.kind === 'tool_use' && row.tool}
              <span class="tool-name">{row.tool}</span>
            {/if}
          </span>

          <!--
            ★ 工具的**输入**与**输出**。
              它们一直在数据里（解析器抓了、执行器落库了、接口也发了），
              只有界面从来没用过——于是日志里只有"调用工具 Bash"，
              看不到它到底跑了什么命令。
          -->
          {#if payload.trim()}
            <pre class="payload">{open || !isLong ? payload : payload.slice(0, PREVIEW_CHARS) + '…'}</pre>
            {#if isLong}
              <button type="button" class="ghost tiny" onclick={() => toggleRow(i)}>
                {open ? '收起' : `展开全部（${payload.length} 字符）`}
              </button>
            {/if}
            {#if row.outputTruncated}
              <span class="faint small">（这段输出在采集时已被截断，原文更长）</span>
            {/if}
          {/if}
        </div>
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
    padding: var(--sp-1) 0;
  }

  /* 序号用固定宽度并右对齐：运行中它会不断变宽，不定宽会让整列文字
     在每一行重排时轻微横移，看久了很晃 */
  .log-seq {
    flex: 0 0 2.5rem;
    text-align: right;
    color: var(--text-faint);
    user-select: none;
  }

  .log-body {
    flex: 1;
    min-width: 0;
  }

  .log-text {
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-dim);
    display: block;
  }

  /* 工具名单独一个标签：它与"调用工具 X"那句是重复信息，
     但重复在这里有用——扫一眼就能定位到用了哪个工具 */
  .tool-name {
    display: inline-block;
    margin-left: var(--sp-2);
    padding: 0 var(--sp-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: 0.9em;
    user-select: none;
  }

  /**
   * 工具输入 / 输出的正文。
   *
   * 用 `<pre>` 是因为它们本质上是**结构化数据的原文**（JSON、文件内容、
   * 命令输出）——按普通文字排版会把缩进和换行吃掉，而那恰恰是排查时
   * 最需要保留的东西。
   */
  .payload {
    margin: var(--sp-1) 0 0;
    padding: var(--sp-2);
    background: var(--bg);
    border-left: 2px solid var(--line-strong);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-dim);
    font-size: 0.95em;
    max-height: 22rem;
    overflow-y: auto;
  }

  .log-row + .log-row {
    border-top: 1px solid rgba(255, 255, 255, 0.03);
  }

  .tiny {
    padding: 0 var(--sp-2);
    font-size: var(--fs-xs);
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
