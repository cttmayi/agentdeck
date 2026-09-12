/**
 * 远端能力面板的渲染（M3 浏览器侧）。
 *
 * 与 `remote.js` 分开：那边只管"怎么调远端"，这边只管"长什么样"。
 * 混在一起的话，想在别处复用远端调用就得连 DOM 一起拖过去。
 *
 * ══════════════════════════════════════════════════════════════════
 * 一条设计取向：登录不是门槛
 * ══════════════════════════════════════════════════════════════════
 *
 * 远端能力（目录、第三方查询、统计）是**补充**，不是本机工作的前提。
 * 所以：
 *   - 远端没起来 → 面板显示"未连接"+ 启动提示，**页面其余部分照常可用**；
 *   - 未登录 → 显示登录表单，同样不挡住本机任务。
 *
 * 把远端做成硬门槛会违背这个产品的定位：它首先是一个**本机**工具。
 */

import { getRemoteUrl, isLoggedIn, remote, setRemoteUrl } from './remote.js'
import { api } from './sync.js'

/** 把远端设定同步给同步循环——它决定轮询间隔与上报开关（FR-AUTH-08/10）。 */
let onSettingsLoaded = null
export function setSettingsListener(fn) {
  onSettingsLoaded = fn
}

const $ = (id) => document.getElementById(id)

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

/** 远端地址不是本页的 daemon —— 只有这一处需要跨源。 */
function renderConnection(status, detail) {
  const el = $('remote-status')
  if (!el) return
  const cls = status === 'ok' ? 'good' : status === 'error' ? 'bad' : 'muted'
  el.innerHTML = `<span class="${cls}">${escapeHtml(detail)}</span>`
}

function renderLoginForm() {
  $('remote-login').hidden = false
  $('remote-main').hidden = true
  $('remote-url').value = getRemoteUrl()
}

function renderLoggedIn(account) {
  $('remote-login').hidden = true
  $('remote-main').hidden = false
  $('remote-account').textContent = account
    ? `${account.displayName} <${account.email}>`
    : '已登录'
}

/** 能力目录：只读列表，"有哪些能力、怎么拿"。 */
/**
 * 从远端目录下载 skill 并交给本机 daemon（FR-AGENT-09/10）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 冲突必须**看得见**
 * ══════════════════════════════════════════════════════════════════
 *
 * FR-AGENT-11 要求"同名冲突必须有确定的优先级与明确提示，**不得静默覆盖
 * 使用者的本地内容**"。daemon 那边已经拒绝同名写入，但如果页面只显示
 * "下载完成"，使用者就会以为装上了——**那就是静默**。
 *
 * 所以这里把 `skipped` 原样摆出来，包括冲突与原因。
 */
async function installSkillFromCatalog(slug) {
  const el = $('remote-install-result')
  if (el) el.textContent = `正在下载 ${slug}…`
  try {
    const catalog = await remote.catalog()
    const skill = (catalog.skills ?? []).find((s) => s.slug === slug)
    if (!skill) {
      if (el) el.textContent = `目录里没有 ${slug}`
      return
    }

    // ★ 交给**本机 daemon**（同源）。远端没有写本机文件的能力，也不该有。
    const result = await api('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        batchId: `dl-${Date.now()}`,
        skills: [
          {
            slug: skill.slug,
            name: skill.slug,
            body: skill.content ?? '',
            // 来源如实声明：这条路是"从目录下载的"，不是使用者自建
            source: 'remote',
            sourceRef: `remote:${skill.slug}@${skill.version ?? '?'}`,
          },
        ],
      }),
    })

    const skipped = result?.skipped ?? []
    const installed = result?.installed ?? []
    if (el) {
      el.innerHTML =
        installed.length > 0
          ? `<span class="good">已安装 ${escapeHtml(slug)}</span>` +
            (skipped.length > 0
              ? `<br><span class="bad">有 ${skipped.length} 项被跳过：${escapeHtml(
                  skipped.map((s) => s.reason).join('；'),
                )}</span>`
              : '')
          : `<span class="bad">未安装：${escapeHtml(
              skipped.map((s) => s.reason).join('；') || '未知原因',
            )}</span>`
    }
  } catch (err) {
    if (el) el.textContent = `安装失败：${err.message}`
  }
}

function renderCatalog(catalog) {
  const skills = (catalog.skills || [])
    .map(
      (s) =>
        `<li><code>${escapeHtml(s.slug)}</code> <span class="muted">${escapeHtml(s.version)}</span>` +
        ` <button type="button" class="secondary install-skill" data-slug="${escapeHtml(s.slug)}">下载到本机</button>` +
        `<br>${escapeHtml(s.summary)}</li>`,
    )
    .join('')
  const tools = (catalog.tools || [])
    .map((t) => `<li><code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.summary)}</li>`)
    .join('')
  const methods = (catalog.loginMethods || [])
    .map((m) => `<li><code>${escapeHtml(m.name)}</code> — ${escapeHtml(m.summary)}</li>`)
    .join('')

  $('remote-catalog').innerHTML = `
    <h3>公共 SKILL</h3><ul>${skills || '<li class="muted">（空）</li>'}</ul>
    <div id="remote-install-result"></div>
    <h3>公共 TOOL</h3><ul>${tools || '<li class="muted">（空）</li>'}</ul>
    <h3>可用登录方式</h3><ul>${methods || '<li class="muted">（空）</li>'}</ul>
  `
}

/**
 * 插件清单（FR-PLUGIN-10）。
 *
 * ★ 三个字段必须**分开**显示，不能合成一个"可用/不可用"：
 *   一个插件可能"加载成功但被使用者停用"，也可能"加载失败所以谈不上启用"。
 *   混成一个布尔会让人分不清是代码坏了还是自己关掉了——而这两件事的
 *   下一步动作完全不同。
 *
 * ★ 密钥只显示**键名**，绝不显示值。清单是页面要渲染的东西，
 *   值一旦进去就会出现在浏览器内存、截图、以及任何往里加 console.log 的调试里。
 */
function renderPlugins(plugins) {
  const el = $('remote-plugins')
  if (!el) return
  if (!plugins || plugins.length === 0) {
    el.innerHTML = '<p class="muted">没有加载任何插件。</p>'
    return
  }
  const rows = plugins
    .map((p) => {
      const status = !p.loaded
        ? `<span class="bad">加载失败</span>`
        : p.enabled
          ? '<span class="good">已启用</span>'
          : '<span class="muted">已停用</span>'
      return `
        <tr>
          <td><code>${escapeHtml(p.name)}</code></td>
          <td>${escapeHtml(p.capability)}</td>
          <td>${escapeHtml(p.version)}</td>
          <td>${status}</td>
          <td class="muted">${p.secretKeys.length > 0 ? escapeHtml(p.secretKeys.join(', ')) : '—'}</td>
          <td class="muted">${p.error ? escapeHtml(p.error) : '—'}</td>
          <td>${
            p.loaded
              ? `<button type="button" class="secondary plugin-toggle" data-name="${escapeHtml(p.name)}" data-enable="${p.enabled ? 'false' : 'true'}">${
                  p.enabled ? '停用' : '启用'
                }</button>`
              : ''
          }</td>
        </tr>`
    })
    .join('')
  el.innerHTML = `
    <table>
      <thead><tr><th>插件</th><th>能力</th><th>版本</th><th>状态</th><th>已配置的密钥</th><th>失败原因</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint">
      密钥值**不会**显示在这里，也不会经过任何读取接口——接口只回答"设没设"。
      需要设置密钥请写入远端数据目录下的 <code>plugins.secrets.json</code>（权限 0600）。
    </p>
  `

  for (const button of el.querySelectorAll('.plugin-toggle')) {
    button.addEventListener('click', async () => {
      const name = button.getAttribute('data-name')
      const enable = button.getAttribute('data-enable') === 'true'
      try {
        await remote.setPluginEnabled(name, enable)
        await refreshRemotePanel()
      } catch (err) {
        $('remote-settings-error').textContent = err.message
      }
    })
  }
}

function renderSettings(settings) {
  const rows = Object.entries(settings || {})
    .map(
      ([k, v]) =>
        `<li><code>${escapeHtml(k)}</code> = ${escapeHtml(JSON.stringify(v))}</li>`,
    )
    .join('')
  $('remote-settings-view').innerHTML = rows || '<li class="muted">（还没有设定）</li>'
}

/**
 * 刷新整个面板。
 *
 * 失败时**不抛出去**：远端不可用不该让页面其余部分崩掉，也不该在控制台
 * 留下一堆未处理的 rejection。这里把失败变成"面板上的状态"。
 */
export async function refreshRemotePanel() {
  const button = $('remote-logout')
  if (button) button.hidden = !isLoggedIn()

  try {
    const catalog = await remote.catalog()
    renderCatalog(catalog)
    // 目录里的"下载到本机"按钮（FR-AGENT-09）
    for (const button of $('remote-catalog').querySelectorAll('.install-skill')) {
      button.addEventListener('click', () => void installSkillFromCatalog(button.dataset.slug))
    }
    renderConnection('ok', `已连接 ${getRemoteUrl()}`)
  } catch (err) {
    renderConnection('error', err.message)
    $('remote-catalog').innerHTML = `<p class="muted">远端不可用，能力目录暂时看不到。</p>`
    return
  }

  if (!isLoggedIn()) {
    renderLoginForm()
    return
  }

  try {
    const me = await remote.me()
    renderLoggedIn(me.account)
    renderPlugins(me.plugins)
    const settings = await remote.settings()
    renderSettings(settings)
    // ★ 设定要**立即生效**，不要求重启（FR-AUTH-09）。
    //   同步循环每轮都重新读一次，所以这里只是把它递过去。
    onSettingsLoaded?.(settings)
  } catch (err) {
    // ★ 401 是"凭证过期了"，不是"远端坏了"——要区别对待，否则用户会去重启服务
    if (err.status === 401) {
      remote.logout()
      renderLoginForm()
      renderConnection('error', '登录已失效，请重新登录')
    } else {
      renderConnection('error', err.message)
    }
  }
}

export function wireRemotePanel() {
  const form = $('remote-login-form')
  if (!form) return

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const email = $('remote-email').value.trim()
    const password = $('remote-password').value
    const mode = event.submitter?.value ?? 'login'
    $('remote-login-error').textContent = ''

    try {
      if (mode === 'register') await remote.register(email, password)
      else await remote.login(email, password)
      $('remote-password').value = ''
      await refreshRemotePanel()
    } catch (err) {
      $('remote-login-error').textContent = err.message
    }
  })

  $('remote-logout').addEventListener('click', async () => {
    remote.logout()
    await refreshRemotePanel()
  })

  $('remote-url-save').addEventListener('click', async () => {
    setRemoteUrl($('remote-url').value.trim())
    await refreshRemotePanel()
  })

  $('remote-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const theme = $('remote-theme').value.trim()
    if (!theme) return
    try {
      renderSettings(await remote.saveSettings({ theme }))
      $('remote-settings-error').textContent = ''
    } catch (err) {
      $('remote-settings-error').textContent = err.message
    }
  })
}
