<script lang="ts">
  import {
    api,
    newRunId,
    groupWorkDirFiles,
    type RunMessage,
    type RunSummary,
    type VerdictView,
    type WorkDirListing,
  } from '../lib/api.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { agents, issues, loadIssues, loadRuns, loading, loadError, runs } from '../lib/stores.ts'
  import { selectedIssueId } from '../lib/view.ts'
  import { PIPELINE_COLUMNS as COLUMNS, runsForIssue, stageOf } from '../lib/pipeline.ts'
  import RunLog from '../components/RunLog.svelte'

  /**
   * 任务清单 + 任务详情。
   *
   * ══════════════════════════════════════════════════════════════════
   * 跑完之后是「最后结果」，不是「实时输出」
   * ══════════════════════════════════════════════════════════════════
   *
   * 执行中要的是"它现在在干什么"（原始日志、按 seq 追加）；跑完之后要的是
   * "它做成了什么"——那是**结论**，不是流水。同一块地方在两种状态下显示同一种
   * 东西，等于让使用者自己从几十条工具调用里翻出最后那段话。
   *
   * 所以跑完切成左右两栏：左边是最后那段产出（按 Markdown 渲染，图也显示出来），
   * 右边是工作目录里的文件（产出就在那儿，可以直接点开）。原始日志仍然可翻。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两种视图各有各的用途，都要有（FR-ISSUE-04）
   * ══════════════════════════════════════════════════════════════════
   *
   * 列表适合"找一条具体的任务"，看板适合"看整体堆在哪里"。只留一个会逼着
   * 使用者用错误的工具回答其中一半的问题。
   *
   * 执行记录与实时日志放在**任务详情**里，而不是单独一栏——执行属于某个
   * 任务，"我在看哪个任务的执行"这个问题本来就不该由使用者自己拼。
   */
  const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']
  const LABELS: Record<string, string> = {
    backlog: '待办池',
    todo: '待做',
    in_progress: '进行中',
    in_review: '待审核',
    done: '已完成',
    blocked: '受阻',
    cancelled: '已取消',
  }

  $: staged = visible.map((issue) => ({ issue, info: stageOf(issue.id, $runs) }))

  const VIEW_KEY = 'alpha-helper.issue-view'
  let mode: 'list' | 'board' = localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'

  function setMode(next: 'list' | 'board'): void {
    mode = next
    localStorage.setItem(VIEW_KEY, next)
  }

  let filter = ''

  $: visible = $issues.filter((i) => {
    if (!filter.trim()) return true
    const q = filter.trim().toLowerCase()
    return i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
  })

  $: selected = $issues.find((i) => i.id === $selectedIssueId) ?? null
  // ⚠️ 不能只按 `subject.id === issue.id` 过滤：**review run 的 subject 是那条
  //   执行 run 的 id**，不是 issue。那样过滤会漏掉所有审查 run ——
  //   表现就是"看板说已审查完成，点进来却看不到审查结论"。
  //   归属规则与看板共用同一个纯函数（见 lib/pipeline.ts）。
  $: issueRuns = selected ? runsForIssue(selected.id, $runs) : []

  function agentName(id: string | null): string {
    if (!id) return '未指派'
    return $agents.find((a) => a.id === id)?.name ?? id
  }

  // ── 任务详情 ──

  let activeRun: RunSummary | null = null
  // ── 最后结果（跑完之后）──
  /** 这次执行的最后一段产出（最后一条 text 消息）。 */
  let finalOutput = ''
  let finalOutputFor: string | null = null
  let listing: WorkDirListing | null = null
  let listingFor: string | null = null
  /** 取文件列表失败的原因——必须显示出来，见 loadResult 里的说明。 */
  let listingError = ''
  let showRawLog = false

  $: activeIsTerminal =
    activeRun !== null && ['completed', 'failed', 'cancelled'].includes(activeRun.status)

  async function loadResult(run: RunSummary): Promise<void> {
    // 最后一段 text 就是"产出"。取最后一条而不是拼接：中间那些
    // "我先看一下目录" 之类的过程话不属于结论。
    try {
      const out = await api<{ messages: RunMessage[] }>(`/api/runs/${run.runId}/messages`)
      const texts = (out.messages ?? []).filter((m) => m.type === 'text' && m.content.trim() !== '')
      finalOutput = texts.length > 0 ? texts[texts.length - 1]!.content : ''
    } catch {
      finalOutput = ''
    }
    finalOutputFor = run.runId

    try {
      listing = await api<WorkDirListing>(`/api/runs/${run.runId}/files`)
      listingError = ''
    } catch (err) {
      // ★ 失败必须**说出来**。第一版这里是 `catch { listing = null }`，而界面把
      //   null 渲染成骨架屏 —— 于是"接口取不到"和"还在加载"长得一模一样，
      //   使用者看到的就是"这一栏什么都没有"（实测撞到过一次：daemon 还是旧
      //   代码，`/files` 返回 404，而那一栏只是安静地空着）。
      listing = null
      listingError = err instanceof Error ? err.message : String(err)
    }
    listingFor = run.runId
  }

  /** 工作目录里的相对路径 → 能取的地址（Markdown 里的图片靠它显示）。 */
  function resolveAsset(href: string, runId: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href // 外部绝对地址
    return `/api/runs/${runId}/file?path=${encodeURIComponent(href)}`
  }

  $: renderedResult =
    activeRun && finalOutputFor === activeRun.runId && finalOutput !== ''
      ? renderMarkdown(finalOutput, { resolveAsset: (href) => resolveAsset(href, activeRun!.runId) })
      : ''

  function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  let verdicts: VerdictView[] = []
  let verdictsFor: string | null = null

  $: if (issueRuns.length > 0 && (!activeRun || !issueRuns.some((r) => r.runId === activeRun!.runId))) {
    activeRun = issueRuns[0]!
  }

  async function loadVerdicts(runId: string): Promise<void> {
    verdictsFor = runId
    try {
      const out = await api<{ verdicts: VerdictView[] }>(`/api/runs/${runId}/verdicts`)
      verdicts = out.verdicts ?? []
    } catch {
      verdicts = []
    }
  }

  async function cancel(runId: string): Promise<void> {
    await api(`/api/runs/${runId}/cancel`, { method: 'POST' })
    await loadRuns()
  }

  async function selectRun(run: RunSummary): Promise<void> {
    activeRun = run
    showRawLog = false
    finalOutput = ''
    finalOutputFor = null
    listing = null
    listingFor = null
    listingError = ''
    await Promise.all([
      loadVerdicts(run.runId),
      // 跑完的才去取结果；还在跑的时候右边是实时日志，没必要多拉一次
      ['completed', 'failed', 'cancelled'].includes(run.status)
        ? loadResult(run)
        : Promise.resolve(),
    ])
  }

  // ── 接着沟通（在同一任务上继续）──
  /**
   * ══════════════════════════════════════════════════════════════════
   * 为什么这是"再起一条 run"，而不是"给已有 run 追加消息"
   * ══════════════════════════════════════════════════════════════════
   *
   * 一次 run 的产出是**不可变快照**（连消息流都按 seq 单调追加）。往里塞新
   * 输入会让"这条 run 当时到底收到了什么"变得不可回答，审计链也就断了。
   *
   * 所以"接着说"= 同一任务上**新起一条 execute run**，并用 `resumeFromRunId`
   * 指向上一次：
   *
   *   - **工作目录**按任务分配（D27），所以两条 run 落在同一个目录里——
   *     agent 上次留下的文件还在；
   *   - **会话**由 daemon 去取上一次的 sessionId 并交给 CLI 恢复（FR-CLI-06），
   *     于是它是"接着上次说"，而不是"从头再来一遍"。
   *
   * 恢复是**尽力而为**：CLI 可能拒绝（换了版本、会话过期），那时它会在日志里
   * 说明"恢复被拒、本次将没有上文"，而不是假装恢复成功。
   */
  let followUp = ''
  let sending = false
  let sendError = ''

  /** 这个任务上**最新的一次执行**——接着沟通就是接在它后面。 */
  $: lastExecuteRun = issueRuns.find((r) => r.kind === 'execute') ?? null
  $: canFollowUp =
    lastExecuteRun !== null && ['completed', 'failed', 'cancelled'].includes(lastExecuteRun.status)

  async function sendFollowUp(): Promise<void> {
    const message = followUp.trim()
    if (message === '' || !selected || !lastExecuteRun) return

    const agent = $agents.find((a) => a.id === lastExecuteRun!.agentId)
    if (!agent) {
      sendError = '这条执行用的 agent 已经不在了，无法继续。请新建任务并指定一个 agent。'
      return
    }

    sending = true
    sendError = ''
    try {
      const runId = newRunId()
      await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
          // 不传 skills：由 daemon 按这个 agent 的配置解析（同 NewTask）
          subject: { type: 'issue', id: selected.id },
          prompt: message,
          // ★ 指向上一次执行 ⇒ daemon 会取它的 sessionId 交给 CLI 恢复
          resumeFromRunId: lastExecuteRun.runId,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      followUp = ''
      await refresh()
      // 立刻切到新那条 run：使用者刚说了话，想看的是它的实时输出
      const created = $runs.find((r) => r.runId === runId)
      if (created) await selectRun(created)
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err)
    } finally {
      sending = false
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadIssues(), loadRuns()])
    if (!activeRun) return
    // 刷新后 activeRun 可能是**旧对象**（`$runs` 换了引用，但这个变量还指着
    // 上一份），状态可能已经从"进行中"变成"跑完了" —— 所以按 runId 取最新的
    // 那一份，否则"跑完切到结果视图"这个切换永远不会发生。
    const fresh = $runs.find((r) => r.runId === activeRun!.runId) ?? activeRun
    activeRun = fresh
    await Promise.all([
      loadVerdicts(fresh.runId),
      ['completed', 'failed', 'cancelled'].includes(fresh.status)
        ? loadResult(fresh)
        : Promise.resolve(),
    ])
  }
</script>

{#if selected}
  <!-- ══════════ 任务详情 ══════════ -->
  <div class="view-head">
    <div>
      <button type="button" class="ghost small" onclick={() => selectedIssueId.set(null)}>
        ← 返回任务清单
      </button>
      <h2 style="margin-top:var(--sp-2)">{selected.title}</h2>
      <p>
        <span class="badge {selected.status}">{LABELS[selected.status] ?? selected.status}</span>
        <span style="margin-left:var(--sp-2)">{agentName(selected.assignee?.id ?? null)}</span>
      </p>
    </div>
    <button type="button" class="secondary" onclick={refresh}>刷新</button>
  </div>

  {#if selected.description}
    <section class="drawer-section">
      <h3>说明</h3>
      <p class="hint" style="white-space:pre-wrap">{selected.description}</p>
    </section>
  {/if}

  <section class="drawer-section">
    <h3>执行记录 <span class="faint small">（{issueRuns.length}）</span></h3>

    {#if issueRuns.length === 0}
      <div class="empty">
        <strong>这个任务还没有执行过</strong>
        在「新建任务」里创建时会自动派发一次。
      </div>
    {:else}
      <div class="run-tabs">
        {#each issueRuns as run (run.runId)}
          <button
            type="button"
            class="run-tab"
            class:active={activeRun?.runId === run.runId}
            onclick={() => selectRun(run)}
          >
            <span class="badge {run.status}">{run.status}</span>
            <span class="mono faint small">{run.runId.slice(-8)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  {#if activeRun}
    <section class="drawer-section">
      <h3>
        {activeIsTerminal && !showRawLog ? '最后结果' : '实时输出'}
        <span class="faint small mono">run {activeRun.runId.slice(-8)}</span>
        {#if activeIsTerminal}
          <!-- 跑完之后默认给结论；原始流水仍然一条不少，按需翻 -->
          <button
            type="button"
            class="ghost small"
            style="margin-left:var(--sp-3)"
            onclick={() => (showRawLog = !showRawLog)}
          >
            {showRawLog ? '看最后结果' : '看完整日志'}
          </button>
        {/if}
      </h3>

      <dl class="meta-grid">
        <dt>工作目录</dt>
        <dd class="mono">{activeRun.workDir ?? '—'}</dd>
        <dt>类型</dt>
        <dd>{activeRun.kind === 'review' ? '审核' : '执行'}</dd>
        {#if activeRun.finishedAt}
          <dt>耗时</dt>
          <dd>{((activeRun.finishedAt - activeRun.queuedAt) / 1000).toFixed(1)} 秒</dd>
        {/if}
      </dl>

      {#if activeIsTerminal && !showRawLog}
        <!-- ══════════ 最后结果：左结论 / 右产出文件 ══════════ -->
        <div class="result-grid">
          <div class="result-main">
            {#if renderedResult}
              <article class="markdown">{@html renderedResult}</article>
            {:else if finalOutputFor === activeRun.runId && finalOutput === ''}
              <div class="empty">
                <strong>这次执行没有留下文字产出</strong>
                它可能只改了文件、或者中途失败了。完整过程在「看完整日志」里。
              </div>
            {:else}
              <div class="skeleton"></div>
            {/if}
          </div>

          <aside class="result-files">
            <h4>工作目录的文件</h4>
            {#if listingFor === activeRun.runId && listing}
              {@const grouped = groupWorkDirFiles(listing.entries)}
              <p class="faint small mono" style="word-break:break-all">
                {listing.workDir ?? '—'}
              </p>
              {#if grouped.isEmpty}
                <p class="hint">这个目录还是空的。</p>
              {:else}
                <ul>
                  {#each grouped.outputs as entry (entry.path)}
                    <li class={entry.kind === 'dir' ? 'is-dir' : ''}>
                      {#if entry.kind === 'file'}
                        <a
                          href="/api/runs/{activeRun.runId}/file?path={encodeURIComponent(entry.path)}"
                          target="_blank"
                          rel="noreferrer noopener"
                        >{entry.path}</a>
                        <span class="faint small">{humanSize(entry.sizeBytes)}</span>
                      {:else}
                        <span class="mono">{entry.path}/</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
                {#if grouped.injected.length > 0}
                  <!-- 平台写进去的东西（技能、上下文文件）也**列出来**，只是排在
                       后面并标一下。藏起来是不对的：使用者要能看见它们、
                       点开看，那正是他要求保留它们的原因。 -->
                  <h4 style="margin-top:var(--sp-3)">平台注入（{grouped.injected.length}）</h4>
                  <p class="faint small">
                    这次任务在什么标准、什么上下文下跑的——不是 agent 的产出。
                  </p>
                  <ul>
                    {#each grouped.injected as entry (entry.path)}
                      <li class={entry.kind === 'dir' ? 'is-dir' : ''}>
                        {#if entry.kind === 'file'}
                          <a
                            href="/api/runs/{activeRun.runId}/file?path={encodeURIComponent(entry.path)}"
                            target="_blank"
                            rel="noreferrer noopener"
                          >{entry.path}</a>
                          <span class="faint small">{humanSize(entry.sizeBytes)}</span>
                        {:else}
                          <span class="mono">{entry.path}/</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if listing.truncated}
                  <p class="faint small">（列到上限了，还有更多——请直接在磁盘上看）</p>
                {/if}
              {/if}
            {:else if listingError}
              <div class="notice bad">
                取不到工作目录的文件
                <p class="faint small" style="margin:var(--sp-2) 0 0">{listingError}</p>
                <p class="faint small" style="margin:var(--sp-2) 0 0">
                  （如果 daemon 刚更新过，重启它再试——新接口要重启才生效）
                </p>
              </div>
            {:else}
              <div class="skeleton" style="width:70%"></div>
            {/if}
          </aside>
        </div>
      {:else}
        <!-- ⚠️ 这里曾经传 `since={activeRun.lastSeq}`，而那个字段是"库里已有的最后
             一条消息的序号"。`since` 的语义是"跳过它及之前的一切"，于是打开一条
             已经跑完的任务时全部历史都被跳过 —— 日志空的，agent 的最后产出看不到。
             订阅游标现在由 RunLog 自己持有，父组件没有机会传错。 -->
        <RunLog runId={activeRun.runId} onterminal={() => void refresh()} />
      {/if}

      <!-- ══════════ 接着沟通 ══════════ -->
      {#if canFollowUp && lastExecuteRun}
        <section class="follow-up">
          <h4>继续沟通</h4>
          <p class="hint">
            不满意这次的产出？直接说下一步要它做什么。会**接着上一次的会话**继续
            （复用同一个工作目录 <code class="mono">{lastExecuteRun.workDir ?? '（自动分配）'}</code>，
            并让 CLI 恢复上次的上下文）；恢复被拒时日志里会说明，不会假装接上了。
          </p>
          <textarea
            bind:value={followUp}
            rows="3"
            placeholder="例如：把流程图的配色改成浅色系，并把结论写在文件开头"
            disabled={sending}
          ></textarea>
          <div class="follow-actions">
            <button type="button" disabled={sending || followUp.trim() === ''} onclick={sendFollowUp}>
              {sending ? '正在派发…' : '发送并继续'}
            </button>
            <span class="faint small">
              跑完仍会按这个 agent 的配置自动派审核
            </span>
          </div>
          {#if sendError}
            <div class="notice bad" style="margin-top:var(--sp-2)">{sendError}</div>
          {/if}
        </section>
      {/if}

      <div style="margin-top:var(--sp-3);display:flex;gap:var(--sp-2)">
        <button
          type="button"
          class="danger"
          disabled={['completed', 'failed', 'cancelled'].includes(activeRun.status)}
          onclick={() => cancel(activeRun!.runId)}
        >
          取消这次执行
        </button>
        <button type="button" class="secondary" onclick={() => loadVerdicts(activeRun!.runId)}>
          读取判决
        </button>
      </div>

      {#if verdictsFor === activeRun.runId && verdicts.length > 0}
        <h4 style="margin-top:var(--sp-4)">判决</h4>
        {#each verdicts as v (v.id)}
          <article class="notice" style="margin-bottom:var(--sp-2);flex-direction:column">
            <div style="display:flex;gap:var(--sp-2);align-items:center">
              <span class="badge {v.conclusion === 'pass' ? 'done' : v.conclusion === 'fail' ? 'failed' : 'blocked'}">
                {v.conclusion}
              </span>
              <span class="mono small faint">{v.reasonCode}</span>
              <span class="faint small">置信度 {Math.round(v.confidence * 100)}%</span>
            </div>
            {#if v.action}
              <div class="small">建议动作：<code>{v.action.type}</code></div>
            {/if}
            {#if v.escalateReason}
              <div class="small warn">需要你判断：{v.escalateReason}</div>
            {/if}
            {#if v.findings.length > 0}
              <ul class="plain small" style="margin:0">
                {#each v.findings as f}
                  <li>[{f.severity}] {f.summary}</li>
                {/each}
              </ul>
            {:else}
              <div class="faint small">（没有具体发现项）</div>
            {/if}
          </article>
        {/each}
      {/if}
    </section>
  {/if}

{:else}
  <!-- ══════════ 清单 / 看板 ══════════ -->
  <div class="view-head">
    <div>
      <h2>任务清单</h2>
      <p>
        按<strong>实际进行到哪一步</strong>分列——不是按人工维护的状态字段，
        而是从执行记录推出来的事实。点任意一条看它的执行记录与实时输出。
      </p>
    </div>
    <div style="display:flex;gap:var(--sp-2)">
      <button type="button" class="ghost" class:active={mode === 'list'} onclick={() => setMode('list')}>
        列表
      </button>
      <button type="button" class="ghost" class:active={mode === 'board'} onclick={() => setMode('board')}>
        看板
      </button>
      <button type="button" class="secondary" onclick={refresh}>刷新</button>
    </div>
  </div>

  <input
    bind:value={filter}
    placeholder="搜索标题或说明…"
    style="max-width:22rem;margin-bottom:var(--sp-4)"
    autocomplete="off"
  />

  {#if $loading['issues'] && $issues.length === 0}
    <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
    <div class="skeleton" style="width:70%"></div>
  {:else if $loadError['issues']}
    <div class="notice bad">{$loadError['issues']}</div>
  {:else if visible.length === 0}
    <div class="empty">
      <strong>{filter ? '没有匹配的任务' : '还没有任务'}</strong>
      {filter ? '换个关键词试试。' : '去「新建任务」建一个，它会立刻派给 agent。'}
    </div>
  {:else if mode === 'board'}
    <div class="board board-3">
      {#each COLUMNS as col (col.id)}
        {@const items = staged.filter((x) => x.info.stage === col.id)}
        <div class="column">
          <h4>
            <span>{col.title} <span class="faint">{items.length}</span></span>
            <span class="col-hint">{col.hint}</span>
          </h4>

          {#if items.length === 0}
            <p class="col-empty faint small">（空）</p>
          {/if}

          {#each items as { issue, info } (issue.id)}
            <button type="button" class="card" onclick={() => selectedIssueId.set(issue.id)}>
              <span class="card-title">{issue.title}</span>
              <span class="card-meta">
                <span class="faint small">{agentName(issue.assignee?.id ?? null)}</span>
                <span class="faint small">{info.detail}</span>
              </span>
              {#if info.warning}
                <span class="card-warning">{info.warning}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/each}
    </div>

  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>任务</th><th>状态</th><th>指派给</th><th>更新于</th></tr>
        </thead>
        <tbody>
          {#each visible as issue (issue.id)}
            <tr onclick={() => selectedIssueId.set(issue.id)} style="cursor:pointer">
              <td><strong>{issue.title}</strong></td>
              <td><span class="badge {issue.status}">{LABELS[issue.status] ?? issue.status}</span></td>
              <td class="muted">{agentName(issue.assignee?.id ?? null)}</td>
              <td class="faint small">{new Date(issue.updatedAt).toLocaleString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
  /* 跑完之后：左边结论、右边产出文件 */
  .result-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
    gap: var(--sp-4);
    align-items: start;
  }

  @media (max-width: 60rem) {
    /* 窄屏堆起来：两栏挤在 800px 里两边都不能读 */
    .result-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .markdown {
    font-size: var(--fs-sm);
    line-height: 1.7;
    word-break: break-word;
  }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    margin: var(--sp-4) 0 var(--sp-2);
    line-height: 1.3;
  }

  .markdown :global(h1) { font-size: 1.4em; }
  .markdown :global(h2) { font-size: 1.2em; }
  .markdown :global(h3) { font-size: 1.05em; }

  .markdown :global(p) { margin: 0 0 var(--sp-3); }

  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0 0 var(--sp-3);
    padding-left: 1.4em;
  }

  .markdown :global(li) { margin-bottom: var(--sp-1); }

  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 0.3em;
  }

  .markdown :global(pre) {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-3);
    overflow-x: auto;
  }

  .markdown :global(pre code) {
    background: none;
    border: 0;
    padding: 0;
  }

  .markdown :global(blockquote) {
    margin: 0 0 var(--sp-3);
    padding-left: var(--sp-3);
    border-left: 3px solid var(--line);
    color: var(--text-faint);
  }

  .markdown :global(table) {
    border-collapse: collapse;
    margin: 0 0 var(--sp-3);
    width: 100%;
  }

  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--line);
    padding: var(--sp-1) var(--sp-2);
    text-align: left;
  }

  .markdown :global(img) {
    max-width: 100%;
    border-radius: var(--radius);
    border: 1px solid var(--line);
  }

  .result-files {
    border-left: 1px solid var(--line);
    padding-left: var(--sp-4);
  }

  .result-files h4 {
    margin: 0 0 var(--sp-2);
  }

  .result-files ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .result-files li {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-1) 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    word-break: break-all;
  }

  .result-files li.is-dir { color: var(--text-faint); }

  .follow-up {
    margin-top: var(--sp-4);
    padding: var(--sp-3);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .follow-up h4 {
    margin: 0 0 var(--sp-2);
  }

  .follow-up textarea {
    width: 100%;
    font-family: inherit;
    font-size: var(--fs-sm);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text);
    resize: vertical;
  }

  .follow-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
  }

  /* ── 三列流水线 ── */
  .board-3 {
    /* 固定三列（而不是 auto-fit）：三列就是流水线的三个阶段，
       少一列会让人以为那一阶段不存在 */
    grid-template-columns: repeat(3, 1fr);
    gap: var(--sp-4);
  }

  .col-hint {
    display: block;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-top: 2px;
  }

  .column h4 {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }

  .col-empty {
    padding: var(--sp-3) var(--sp-2);
    margin: 0;
  }

  .card-meta {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  /* 需要留意的情况用一条左侧色条，而不是整块变红——
     整块变红会让"有一处小问题"看起来像"这张卡坏了" */
  .card-warning {
    display: block;
    font-size: var(--fs-xs);
    color: var(--warn);
    border-left: 2px solid var(--warn);
    padding-left: var(--sp-2);
    margin-top: var(--sp-1);
  }

  /* ── 看板 ── */
  .board {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--sp-3);
    align-items: start;
  }

  .column {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    min-height: 5rem;
  }

  .column h4 {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    margin: var(--sp-1) var(--sp-2) var(--sp-2);
    display: flex;
    justify-content: space-between;
  }

  .card {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--surface-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    margin-bottom: var(--sp-1);
    cursor: pointer;
    color: var(--text);
  }

  .card:hover {
    background: var(--surface-hover);
    border-color: var(--line-strong);
    filter: none;
  }

  .card-title {
    display: block;
    font-size: var(--fs-sm);
    margin-bottom: 2px;
  }

  /* ── 执行记录标签 ── */
  .run-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }

  .run-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--text-dim);
    padding: var(--sp-1) var(--sp-3);
    border-radius: 100px;
  }

  .run-tab.active {
    border-color: var(--accent);
    color: var(--text);
  }

  /* ── 元信息栅格 ── */
  .meta-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--sp-1) var(--sp-4);
    margin: 0 0 var(--sp-3);
    font-size: var(--fs-sm);
  }

  .meta-grid dt { color: var(--text-faint); }
  .meta-grid dd { margin: 0; word-break: break-all; }

  :global(button.ghost.active) {
    background: var(--surface-2);
    color: var(--text);
  }
</style>
