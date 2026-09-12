/**
 * alpha-helper M0 界面。
 *
 * 零构建：纯原生 ES 模块，由 daemon 直接托管。因为**页面与接口同源**，
 * 所有请求都是相对路径，不需要任何跨源协商。
 *
 * 这里只做 M0 闭环需要的事：看任务、建任务、派给 agent、看执行日志。
 * 判决渲染、通知中心、目录管理都在后续里程碑。
 */

import { refreshRemotePanel, setSettingsListener, wireRemotePanel } from './remote-panel.js'
import { startSyncLoop } from './sync.js'

const $ = (id) => document.getElementById(id)

const state = {
  agents: [],
  issues: [],
  /** 当前订阅的 run。 */
  currentRunId: null,
  /** 已渲染到第几号消息——重连时用它做 since。 */
  lastSeq: -1,
  /** 远端设定（同步循环读它拿轮询间隔与上报开关）。 */
  remoteSettings: null,
  eventSource: null,
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = body?.error ?? `${res.status} ${res.statusText}`
    const error = new Error(message)
    error.status = res.status
    error.body = body
    throw error
  }
  return body
}

// ─────────────────────────────────────────────────────────────
// 身份与能力
// ─────────────────────────────────────────────────────────────

async function loadIdentity() {
  const el = $('identity')
  try {
    const identity = await api('/api/identity')
    const current = identity.runtimes.find((r) => r.key === identity.currentRuntime) ??
      identity.runtimes[0]

    el.innerHTML = [
      `设备 <strong>${escapeHtml(identity.deviceName)}</strong>`,
      current?.available
        ? `<span class="good">${escapeHtml(current.command)} ${escapeHtml(current.cliVersion ?? '已就绪')}</span>`
        : `<span class="bad">未检测到 ${escapeHtml(current?.command ?? 'CLI')}</span>`,
    ].join(' · ')

    // ★ 证据等级与版本验证状态**必须显示**，不能只放在接口里。
    //
    //   `provisional` 的 runtime 与实测过的 runtime，可信度完全不同；
    //   `undeclared` 的版本范围意味着"我们没验证过这个版本"。
    //   把这些藏起来，使用者就会以为它们和 claude 一样可信。
    renderRuntimes(identity.runtimes)

    if (!current?.available) {
      showLog([
        [
          'error',
          `本机没有检测到 ${current?.command ?? 'CLI'} 可执行文件。` +
            '请先安装并在终端里完成登录，然后重启 daemon 以重新探测 PATH。',
        ],
      ])
    }
  } catch (err) {
    el.innerHTML = `<span class="bad">无法连接本机 daemon</span>`
    showLog([['error', `无法连接本机 daemon：${err.message}`]])
  }
}

/**
 * 同步状态（FR-REG-17 要求 UI 明示上报什么、去哪）。
 *
 * 显示得**具体**：上报了多少条、暂存了多少条、有没有第三方出问题。
 * 一句笼统的"同步中"等于没说——使用者没法据此判断要不要管它。
 */
function renderSyncStatus(status) {
  const el = $('sync-status')
  if (!el) return
  if (status.error) {
    el.innerHTML = `<span class="bad">${escapeHtml(status.error)}</span>`
    return
  }
  const parts = [`已上报 ${status.reported} 条`]
  if (status.queued > 0) parts.push(`暂存 ${status.queued} 条待补交`)
  if (status.fetched > 0) parts.push(`取回 ${status.fetched} 条待处理项`)
  if (status.skippedReporting) parts.push('上报已关闭')
  if ((status.warnings ?? []).length > 0) {
    parts.push(`<span class="bad">${status.warnings.length} 个第三方出问题</span>`)
  }
  el.innerHTML = `<span class="muted">${escapeHtml(parts.join(' · '))}</span>`

  // 第三方的失败要能看到**原因**——只报数量等于让使用者去猜
  const warnEl = $('sync-warnings')
  if (warnEl) {
    warnEl.innerHTML = (status.warnings ?? [])
      .map((w) => `<li><code>${escapeHtml(w.plugin)}</code>：${escapeHtml(w.reason)}</li>`)
      .join('')
  }
}

/** runtime 表格：证据等级、版本判定、会话状态都要看得见。 */
function renderRuntimes(runtimes) {
  const el = $('runtimes')
  if (!el) return
  el.innerHTML = (runtimes ?? [])
    .map((r) => {
      const support = r.versionSupport ?? {}
      // 只有 `verified` 才是"我们真的跑通过这个版本"
      const supportClass =
        support.status === 'verified' ? 'good'
        : support.status === 'out-of-range' ? 'bad'
        : 'muted'
      return `
        <tr>
          <td><code>${escapeHtml(r.key)}</code></td>
          <td>${r.available ? escapeHtml(r.cliVersion ?? '已就绪') : '<span class="bad">未找到</span>'}</td>
          <td class="${r.evidence === 'verified' ? 'good' : 'muted'}">${escapeHtml(r.evidence)}</td>
          <td class="${supportClass}">${escapeHtml(support.status ?? '—')}</td>
          <td class="muted">${escapeHtml(r.sessionState ?? '—')}</td>
        </tr>`
    })
    .join('')

  const unverified = (runtimes ?? []).filter((r) => r.versionSupport?.status !== 'verified')
  const note = $('runtimes-note')
  if (note) {
    note.textContent =
      unverified.length === 0
        ? '所有 runtime 的版本都实测过。'
        : `${unverified.length} 个 runtime 的版本**没有实测过**——按 FR-CLI-07，` +
          `凭文档推断的范围不算声明。用 \`pnpm run daemon --verify-runtime all\` 查看该做什么。`
  }
}

/** 成本：把"缺失用量"和"估算"都显式列出来，不能只给一个总数。 */
async function loadCosts() {
  const el = $('costs')
  if (!el) return
  try {
    const report = await api('/api/costs')
    const rows = (report.byKind ?? [])
      .map(
        (b) =>
          `<tr><td>${escapeHtml(b.key)}</td><td>${b.runs}</td>` +
          `<td>${(b.costUsdMicros / 1_000_000).toFixed(4)}</td>` +
          `<td class="muted">${b.estimatedRuns > 0 ? b.estimatedRuns + ' 条为估算' : '—'}</td></tr>`,
      )
      .join('')
    el.innerHTML = `
      <p>总计 <strong>${(report.total.costUsdMicros / 1_000_000).toFixed(4)}</strong> USD
         · ${report.total.runs} 次执行
         ${
           report.runsWithoutUsage > 0
             ? `<span class="bad">· 其中 ${report.runsWithoutUsage} 次没有上报用量</span>`
             : ''
         }
      </p>
      <table><thead><tr><th>类型</th><th>次数</th><th>成本 (USD)</th><th>备注</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">还没有执行记录</td></tr>'}</tbody></table>
      ${
        report.runsWithoutUsage > 0
          ? '<p class="hint">⚠️ 没有上报用量的执行**不计入**成本。' +
            '把缺失当零会让"总成本"变成一个误导性的数字。</p>'
          : ''
      }
    `
  } catch (err) {
    el.innerHTML = `<p class="bad">读取成本失败：${escapeHtml(err.message)}</p>`
  }
}

// ─────────────────────────────────────────────────────────────
// 任务
// ─────────────────────────────────────────────────────────────

async function loadIssues() {
  const [issuesPage, agentsPage] = await Promise.all([api('/api/issues'), api('/api/agents')])
  state.issues = issuesPage.items ?? []
  state.agents = agentsPage.agents ?? []
  renderIssues()
}

/**
 * 状态集合与顺序（FR-ISSUE-02）。
 *
 * 顺序**照抄协议里的枚举顺序**，不是随便排的：看板从左到右就是工作流
 * 的推进方向。顺序乱了，看板读起来就不像流程，而像一堆分类。
 */
const ISSUE_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
]

const STATUS_LABELS = {
  backlog: '待办池',
  todo: '待做',
  in_progress: '进行中',
  in_review: '待审核',
  done: '已完成',
  blocked: '受阻',
  cancelled: '已取消',
}

/** 视图偏好存在本地：这是"我怎么看"，不是"数据是什么"。 */
const VIEW_KEY = 'alpha-helper.issue-view'

function currentView() {
  const v = localStorage.getItem(VIEW_KEY)
  return v === 'board' ? 'board' : 'list'
}

function setView(view) {
  localStorage.setItem(VIEW_KEY, view)
  renderIssues()
}

/**
 * 渲染任务。
 *
 * ★ 看板与列表**都要有**（FR-ISSUE-04）。它们回答的问题不同：
 *   列表适合"找一条具体的任务"，看板适合"看整体堆在哪里"。
 *   只留一个会逼着使用者用错误的工具回答其中一半的问题。
 */
function renderIssues() {
  const container = $('issues')
  const view = currentView()

  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === view)
  }

  if (state.issues.length === 0) {
    container.className = 'list'
    container.innerHTML =
      '<div class="empty">还没有任务。在上面创建一个。这里会显示它们。</div>'
    renderAgents()
    return
  }

  if (view === 'board') {
    container.className = 'board'
    container.innerHTML = ISSUE_STATUSES.map((status) => {
      const items = state.issues.filter((i) => i.status === status)
      return `
        <div class="column" data-status="${status}">
          <h3>${escapeHtml(STATUS_LABELS[status] ?? status)}
            <span class="muted">${items.length}</span></h3>
          ${items
            .map(
              (issue) => `
            <div class="card">
              <div class="title">${escapeHtml(issue.title)}</div>
              <div class="meta">
                <span class="muted">${escapeHtml(
                  state.agents.find((a) => a.id === issue.assignee?.id)?.name ??
                    issue.assignee?.id ??
                    '未指派',
                )}</span>
                <button class="ghost" data-run="${escapeHtml(issue.id)}">跑一次</button>
              </div>
            </div>`,
            )
            .join('')}
        </div>`
    }).join('')
  } else {
    container.className = 'list'
    container.innerHTML = ''
    for (const issue of state.issues) {
      const item = document.createElement('div')
      item.className = 'item'
      item.innerHTML = `
        <div class="title">${escapeHtml(issue.title)}</div>
        <div class="meta">
          <span class="badge ${escapeHtml(issue.status)}">${escapeHtml(issue.status)}</span>
          <span>${escapeHtml(
            state.agents.find((a) => a.id === issue.assignee?.id)?.name ??
              issue.assignee?.id ??
              '未指派',
          )}</span>
          <button class="ghost" data-run="${escapeHtml(issue.id)}">跑一次</button>
        </div>
      `
      container.appendChild(item)
    }
  }

  for (const button of container.querySelectorAll('[data-run]')) {
    button.addEventListener('click', () => void startRunFor(button.dataset.run))
  }

  renderAgents()
}

/**
 * agent 统一视图（FR-AGENT-19）。
 *
 * 需求要的是"一眼看出每个 agent 配置了什么，便于对比与排错"。
 * 所以这里显示的是**会实际影响行为的那些字段**：指令摘要、技能数、
 * 认哪些 kind、是不是兜底审核者、并发上限、默认工作目录。
 *
 * 尤其是 `kindPatterns` 与 `isFallbackReviewer`——它们决定"报告会路由给谁"，
 * 而路由错了的时候，人第一反应通常是去查审核逻辑，而不是来看这张表。
 */
function renderAgents() {
  const el = $('agents')
  if (!el) return
  if (state.agents.length === 0) {
    el.innerHTML = '<p class="muted">还没有 agent。</p>'
    return
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr><th>agent</th><th>指令摘要</th><th>技能</th><th>认哪些 kind</th>
            <th>兜底审核</th><th>自动审核</th><th>并发</th><th>工作目录</th></tr>
      </thead>
      <tbody>
        ${state.agents
          .map(
            (a) => `
          <tr>
            <td><strong>${escapeHtml(a.name)}</strong></td>
            <td class="muted">${escapeHtml((a.instructions ?? '').slice(0, 40) || '—')}${
              (a.instructions ?? '').length > 40 ? '…' : ''
            }</td>
            <td>${(a.skillIds ?? []).length}</td>
            <td>${
              (a.kindPatterns ?? []).length > 0
                ? (a.kindPatterns ?? []).map((k) => `<code>${escapeHtml(k)}</code>`).join(' ')
                : '<span class="muted">—</span>'
            }</td>
            <td>${a.isFallbackReviewer ? '<span class="good">是</span>' : '<span class="muted">否</span>'}</td>
            <td>${a.autoReview ? '开' : '<span class="muted">关</span>'}</td>
            <td>${a.maxConcurrentRuns}</td>
            <td class="muted">${escapeHtml(a.workDir ?? '每任务自动分配')}</td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <p class="hint">
      「认哪些 kind」既是**路由键**也是**审核标准的选择键**——报告按它决定交给谁审，
      而每个 agent 挂的 skill 不同，所以换审核 agent 就等于换审核标准。
    </p>
  `
}

async function createIssue(event) {
  event.preventDefault()
  const title = $('issue-title').value.trim()
  const description = $('issue-desc').value.trim()
  // D27：工作目录**可选**。留空由 daemon 按任务自动分配一个独立目录。
  // D27：工作目录**可选**（默认自动分配），所以这里不再把它当成必填校验。
  const workDir = $('issue-workdir')?.value.trim() ?? ''
  if (!title) return

  const agent = state.agents[0]
  if (!agent) {
    showLog([['error', '还没有 agent，无法指派。']])
    return
  }

  try {
    const issue = await api('/api/issues', {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        assignee: { type: 'agent', id: agent.id },
      }),
    })
    $('issue-form').reset()
    // 高级选项里填过的目录保留下来（连续给同一个仓库派活是常见用法），
    // 但**不再**像以前那样每建一个任务都必须重新确认一次
    $('issue-workdir').value = workDir
    await loadIssues()
    await startRunFor(issue.id, title, description, workDir)
  } catch (err) {
    showLog([['error', `创建任务失败：${err.message}`]])
  }
}

// ─────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────

async function startRunFor(issueId, title, description, workDir) {
  const issue = state.issues.find((i) => i.id === issueId)
  const agent = state.agents.find((a) => a.id === issue?.assignee?.id) ?? state.agents[0]
  // 空字符串 = 没指定 ⇒ **不传这个字段**，让 daemon 按任务自动分配目录。
  // 传一个空串会被协议拒掉（min(1)），而"没指定"与"指定了一个空目录"
  // 是两件不同的事。
  const dir = workDir ?? $('issue-workdir')?.value.trim() ?? ''

  if (!agent) {
    showLog([['error', '没有可用的 agent。']])
    return
  }

  const prompt = [title ?? issue?.title, description ?? issue?.description]
    .filter((s) => s && s.length > 0)
    .join('\n\n')

  const runId = newRunId()
  resetLog(runId)

  try {
    const accepted = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt,
        // 只在真的填了才带上这个字段（D27）
        ...(dir ? { workDir: dir } : {}),
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    appendLog('status', `已受理（runId=${accepted.runId}${accepted.deduplicated ? '，重复提交已去重' : ''}）`)
    subscribe(runId, -1)
  } catch (err) {
    if (err.status === 429) {
      appendLog('status', '本机并发已满，请稍后重试。')
    } else {
      appendLog('error', `提交失败：${err.message}`)
    }
  }
}

/** 与 daemon 保持一致的 ULID 生成（客户端只负责给出 id，权威在 daemon）。 */
function newRunId() {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let time = Date.now()
  let timePart = ''
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[time % 32] + timePart
    time = Math.floor(time / 32)
  }
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let randPart = ''
  for (let i = 0; i < 16; i++) {
    randPart = ENCODING[Number(n & 31n)] + randPart
    n >>= 5n
  }
  return timePart + randPart
}

function subscribe(runId, since) {
  closeSubscription()
  state.currentRunId = runId
  state.lastSeq = since

  const source = new EventSource(`/api/runs/${runId}/events?since=${since}`)
  state.eventSource = source

  source.onmessage = (event) => {
    let payload
    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }
    applyEvent(payload)
  }

  source.onerror = () => {
    // 浏览器会自动重连；重连后从 lastSeq 继续，因此不会丢消息也不会重复
    appendLog('status', '连接中断，正在重连…')
  }
}

function closeSubscription() {
  state.eventSource?.close()
  state.eventSource = null
}

function applyEvent(event) {
  if (typeof event.seq === 'number') {
    if (event.seq <= state.lastSeq) return // 去重
    state.lastSeq = event.seq
  }

  switch (event.t) {
    case 'message':
      appendLog(event.message.type, event.message.content, event.message.seq)
      break
    case 'status':
      appendLog('status', `状态：${event.status}`)
      break
    case 'progress':
      appendLog('status', `${event.summary}（${event.step}/${event.total}）`)
      break
    case 'usage':
      appendLog(
        'status',
        `用量：输入 ${event.usage.inputTokens} / 输出 ${event.usage.outputTokens} / 成本 $${(
          event.usage.costUsdMicros / 1e6
        ).toFixed(4)}（${event.usage.costSource === 'provider' ? 'provider 上报' : '估算'}）`,
      )
      break
    case 'terminal':
      appendLog('terminal', `结束：${event.status}${event.error ? ` — ${event.error.message}` : ''}`)
      closeSubscription()
      void loadIssues()
      break
    default:
      break
  }
}

// ─────────────────────────────────────────────────────────────
// 日志渲染
// ─────────────────────────────────────────────────────────────

function resetLog(runId) {
  $('log').innerHTML = ''
  $('run-label').textContent = runId ? `run ${runId.slice(-8)}` : ''
  state.lastSeq = -1
}

function appendLog(kind, content, seq) {
  const log = $('log')
  const row = document.createElement('div')
  row.className = 'row'
  const seqCell = document.createElement('span')
  seqCell.className = 'seq'
  seqCell.textContent = typeof seq === 'number' ? String(seq) : '·'
  const text = document.createElement('span')
  text.className = `text ${kind}`
  text.textContent = content
  row.append(seqCell, text)
  log.appendChild(row)
  log.scrollTop = log.scrollHeight
}

function showLog(entries) {
  $('log').innerHTML = ''
  for (const [kind, content] of entries) appendLog(kind, content)
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

$('issue-form').addEventListener('submit', (e) => void createIssue(e))

// 视图切换（FR-ISSUE-04）
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => setView(button.dataset.view))
}

void (async () => {
  await loadIdentity()
  try {
    await loadIssues()
  } catch (err) {
    showLog([['error', `加载任务失败：${err.message}`]])
  }

  // 远端面板**独立启动**，且不 await 进主流程：
  // 远端没起来时页面其余部分必须照常可用（远端是补充，不是门槛）。
  wireRemotePanel()
  void refreshRemotePanel()
  void loadCosts()

  // ★ 同步循环（FR-REG-06/12）。
  //   它**独立于**本机功能：远端不可用时只影响这一行状态文字。
  setSettingsListener((settings) => {
    state.remoteSettings = settings
  })
  startSyncLoop({
    getSettings: () => state.remoteSettings,
    onStatus: (status) => renderSyncStatus(status),
  })

  // 审计导出是**下载**，不是页面内渲染——用链接让浏览器走原生下载语义
  $('audit-export')?.addEventListener('click', () => {
    window.location.href = '/api/audits/export'
  })
})()
