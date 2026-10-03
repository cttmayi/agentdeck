<script lang="ts">
  import { afterUpdate, onDestroy } from 'svelte'
  import type { RunMessage } from '../lib/api.ts'
  import { t, tx } from '../lib/i18n.ts'

  export let runId: string
  export let onterminal: (status: string) => void = () => {}
  /**
   * ★ D69.11：日志吃满一屏（详情页主视图用）。
   *   默认 `max-height: 26rem`——聊天轮次里那是"一段辅助输出"，够了；任务详情里
   *   点「看完整日志」时日志就是**主内容**，26rem 是"固定高低"、浪费可用屏。
   *   `fill` 后按视口定高（`calc(100vh - 19rem)`），不设 max-height。
   */
  export let fill: boolean = false

  /**
   * 实时日志。
   *
   * ══════════════════════════════════════════════════════════════════
   * seq 驱动，不靠时间戳（FR-BRIDGE-18）
   * ══════════════════════════════════════════════════════════════════
   *
   * 补历史用**序号**而不是时间：时间戳做不到"补齐错过的消息"——同一毫秒
   * 可能有多条，本地时钟还可能回拨。序号单调，`since=N` 就是"把 N 之后的
   * 都给我"。
   *
   * ══════════════════════════════════════════════════════════════════
   * ★ 订阅游标由**组件自己**持有，不接受外部传入
   * ══════════════════════════════════════════════════════════════════
   *
   * 这里原来有一个 `since` 属性，而父组件传的是 `runs` 接口给的那条 run 的
   * `lastSeq`。那个字段的语义是"**库里已有的最后一条消息的序号**"，
   * 而 `since=N` 的语义是"**跳过 N 及之前的一切**"——两者刚好相反。
   *
   * 后果：打开一条**已经跑完**的任务，订阅变成 `?since=69`，服务端把 0~69
   * 全部跳过，只补发一个终态事件。**日志是空的**，而 agent 的最后产出
   *（那条 `text` 消息）明明就在库里。
   *
   * 它看起来"能用"，是因为任务正在跑的时候 `lastSeq` 还小、后面新产生的
   * 消息照样会流进来——只有"事后回看"才什么都看不到，而那正是最常见的用法。
   *
   * 所以：**起点永远是 -1（从头发）**，游标只用于重连时接着上次的地方要，
   * 而且只有组件自己知道这个游标是什么。父组件再也没机会传错。
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
  /** 断线重连的退避：从 0.5s 起翻倍，封顶 10s。 */
  const INITIAL_RETRY_MS = 500
  const MAX_RETRY_MS = 10_000

  const THINKING_KEY = 'agentdeck.show-thinking'
  let showThinking = localStorage.getItem(THINKING_KEY) === '1'

  function toggleThinking(): void {
    showThinking = !showThinking
    localStorage.setItem(THINKING_KEY, showThinking ? '1' : '0')
  }

  $: thinkingCount = rows.filter((r) => r.kind === 'thinking').length
  $: visibleRows = showThinking ? rows : rows.filter((r) => r.kind !== 'thinking')
  /**
   * 日志容器。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么必须自动滚到底
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来**一点滚动都没有**：容器是 `max-height: 26rem; overflow-y: auto`，
   * 而打开一条已经跑完的任务时它是从**顶部**开始显示的。
   *
   * 于是一次 69 条消息的执行，使用者看到的是开头那几行，而**最后的产出**
   * （agent 那段正式的 `text`）在很下面——「任务执行完了，点进去看不到结果」
   * 有一半原因是这个（另一半是订阅参数用错，见文件头的说明）。
   *
   * 所以：新内容到达时自动贴底。
   */
  let logEl: HTMLDivElement
  /**
   * 使用者是不是"还在跟着看"。
   *
   * ★ 不能无条件贴底：他往上翻着读的时候，每来一条新输出就把他拽回去，
   *   等于**没法读**。所以只有他本来就在底部附近时才跟随。
   */
  let stick = true

  function onScroll(): void {
    if (!logEl) return
    const gap = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight
    stick = gap < 40
  }

  let source: EventSource | null = null
  /** 已经收到的最大 seq。**只用于重连时接着要**，不用于决定"从哪开始"。 */
  let lastSeq = -1
  let live = true
  let retryMs = INITIAL_RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前连的是哪条 run——用来判断"换了目标要整个重来"。 */
  let connectedRunId: string | null = null

  function connect(id: string): void {
    close()
    // 从组件自己的游标接着要。首次是 -1 ⇒ 服务端补发全部历史（FR-BRIDGE-04）。
    source = new EventSource(`/api/runs/${id}/events?since=${lastSeq}`)
    source.onmessage = (event) => {
      let payload: { seq?: number; t?: string; [k: string]: unknown }
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      retryMs = INITIAL_RETRY_MS // 收到东西了 ⇒ 退避复位
      apply(payload)
    }
    source.onerror = () => {
      // ══════════════════════════════════════════════════════════════
      // ★ 已经结束了就**不要再重连** —— 这是"一直重连"那个 bug 的客户端侧
      // ══════════════════════════════════════════════════════════════
      //
      // `EventSource` 在任何一次断开后都会**自动重连**，我们拦不住它——
      // 唯一能做的是 `close()`。所以只要已经收到终态，就必须关掉。
      //
      // 服务端那边也修了（晚订阅会补发 terminal 并结束流），两边一起
      // 才能保证：断一次 → 重连 → 拿到终态 → 关闭 → 停。
      if (!live) {
        close()
        return
      }

      // 没结束就真的断了（daemon 重启、网络抖动）：记录一行，但要**去重**。
      // 刷屏的"连接中断"会把有用的日志冲掉，而重复的行没有任何信息量。
      const last = rows[rows.length - 1]
      if (last?.kind !== 'disconnected') {
        rows = [
          ...rows,
          {
            seq: null,
            kind: 'disconnected',
            text: tx('runs.logDisconnected'),
            tool: null,
            input: null,
            output: null,
            outputTruncated: false,
          },
        ]
      }

      // ★ 自己接管重连：`close()` 之后浏览器就**不会**再自动重连了，
      //   于是重连的时机、间隔、以及从哪个序号接着要，全在我们手里。
      close()
      scheduleReconnect()
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
        push('status', tx('runs.logStatus', { status: String(event['status']) }))
        break
      case 'progress':
        push(
          'status',
          tx('runs.logProgress', {
            summary: String(event['summary']),
            step: String(event['step']),
            total: String(event['total']),
          }),
        )
        break
      case 'usage': {
        const u = event['usage'] as { inputTokens: number; outputTokens: number; costUsdMicros: number; costSource: string }
        push(
          'status',
          tx('runs.logUsage', {
            input: u.inputTokens,
            output: u.outputTokens,
            cost: (u.costUsdMicros / 1e6).toFixed(4),
            source: tx(u.costSource === 'provider' ? 'runs.costSourceProvider' : 'runs.costSourceEstimated'),
          }),
        )
        break
      }
      case 'terminal': {
        const err = event['error'] as { message?: string } | null
        push(
          'terminal',
          tx('runs.logFinished', { status: String(event['status']) }) +
            (err?.message ? ` — ${err.message}` : ''),
        )
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

  function cancelRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
  }

  /**
   * 断线后台重连。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么自己重连，而不是让 `EventSource` 自动重连
   * ══════════════════════════════════════════════════════════════════
   *
   * 浏览器的自动重连**只会重发同一个 URL**，而那个 URL 里的 `since` 是第一次
   * 连接时的值。跑得久了以后，重连会把整段日志**再replay一遍**（客户端靠
   * 去重挡住，但流量白费）。而且它的退避策略我们看不见、也拦不住——
   * 之前那个"日志刷屏『连接中断，正在重连…』"就是这么来的。
   *
   * 自己重连可以做对两件事：**带自己的游标**（不重复拉），以及**退避**
   *（daemon 没起来时不打空转）。
   */
  function scheduleReconnect(): void {
    if (!live) return
    cancelRetry()
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (live) connect(runId)
    }, retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }

  // ★ 换了一条 run 就**整个重来**：清空已显示的行、把游标归零、重新从头发。
  //
  //   这个组件是复用的（在任务详情里点另一条执行，`runId` 变了但组件实例
  //   没变）。不重置的话会有两种静默错误：上一条 run 的行留在屏幕上，
  //   而且游标停在上一条的序号上——新 run 的 `seq` 比它小，会被去重直接
  //   丢掉，于是**日志一片空白**。
  $: if (runId && runId !== connectedRunId) {
    connectedRunId = runId
    rows = []
    expanded = new Set()
    lastSeq = -1
    live = true
    retryMs = INITIAL_RETRY_MS
    stick = true // 新的一条 run：从底部开始跟
    cancelRetry()
    connect(runId)
  }

  // 每次渲染后：如果使用者还在跟着看，就贴到底部。
  // 首次渲染（打开一条已完成的任务）也走这里 —— 正是"要看到最后结果"的那一次。
  afterUpdate(() => {
    if (stick && logEl) logEl.scrollTop = logEl.scrollHeight
  })

  onDestroy(() => {
    cancelRetry()
    close()
  })
</script>

<div class="log-wrap" class:fill={fill}>
  {#if thinkingCount > 0}
    <div class="log-toolbar">
      <button type="button" class="ghost small" onclick={toggleThinking}>
        {$t(showThinking ? 'runs.hideThinking' : 'runs.showThinking', { count: thinkingCount })}
      </button>
      <span class="faint small">
        {$t('runs.thinkingNote')}
      </span>
    </div>
  {/if}

  <div class="log" class:fill={fill} bind:this={logEl} onscroll={onScroll}>
    {#if visibleRows.length === 0}
      <div class="log-row">
        <span class="log-seq">·</span>
        <span class="hint">
          {$t(thinkingCount > 0 ? 'runs.thinkingOnlyHidden' : 'runs.waitingOutput')}
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
            {#if row.kind === 'thinking'}<span class="thinking-tag">{$t('runs.thinkingTag')}</span>{/if}
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
            <!--
              ★ 2026-10（紧凑性）：折叠按钮与"输出已被截断"提示原来各占一行
                ——合并进同一行（按钮左、提示右，中间留 gap）。
            -->
            {#if isLong || row.outputTruncated}
              <span class="payload-meta">
                {#if isLong}
                  <button type="button" class="ghost tiny" onclick={() => toggleRow(i)}>
                    {$t(open ? 'runs.collapsePayload' : 'runs.expandPayload', { count: payload.length })}
                  </button>
                {/if}
                {#if row.outputTruncated}
                  <span class="faint small">{$t('runs.outputTruncated')}</span>
                {/if}
              </span>
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

  /* ★ D69.12：fill（详情页日志主视图）——作为 flex 链的中间环：
     run-section(flex col) → log-wrap(flex 1) → .log(flex 1 内部滚动)。
     `overflow: hidden` 保住圆角，内部滚动由 .log 自己负责。 */
  .log-wrap.fill {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
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

  /* ★ D69.12：详情页主视图的日志吃满剩余空间（flex:1 + min-height:0 内部滚动）。
     D69.11 用 `calc(100vh - 19rem)` 定高——但下面的判决/元数据区还在，整栏
     仍然溢出、出现**外置滚动条**（使用者报双滚动条）；flex 链精确吃掉剩余
     空间，外置滚动消失。 */
  .log.fill {
    max-height: none;
    height: auto;
    flex: 1 1 0;
    min-height: 0;
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
    /* ⚠️ 原来是 rgba(255,255,255,0.03)——暗色专用，亮色底下看不见分隔线 */
    border-top: 1px solid var(--line);
  }

  .tiny {
    padding: 0 var(--sp-2);
    font-size: var(--fs-xs);
  }

  .payload-meta {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-top: var(--sp-1);
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
  /* 断连用 warn 色：它是"需要注意"而不是"出错"——而且重复的那几行已被去重 */
  .log-text.disconnected { color: var(--warn); }
  .log-text.terminal { color: var(--good); }
  .log-text.error { color: var(--bad); }
</style>
