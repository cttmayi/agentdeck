<script lang="ts">
  import { loadSkills, loadError, loading, skills } from '../lib/stores.ts'
  import { remoteCatalog, remoteError, refreshRemote } from '../lib/remote-store.ts'
  import { isLoggedIn } from '../lib/remote.ts'
  import {
    ACTION_TYPES,
    DEFAULT_ACTIONS,
    InstallError,
    describeInstall,
    installErrorHint,
    installFromPathOrUrl,
    installRemoteEntry,
    type InstallResult,
  } from '../lib/skill-install.ts'

  /**
   * Skills。
   *
   * 每一项要显示**它允许触发哪些动作**——那是 skill 里最要紧的一条约束，
   * 也是"这个 skill 到底能改什么"的唯一答案。只列名字等于没说。
   */
  let expanded: string | null = null

  // ── 安装面板 ──
  /**
   * ══════════════════════════════════════════════════════════════════
   * 两个来源放在同一个面板里，而不是各做一个入口
   * ══════════════════════════════════════════════════════════════════
   *
   * "我要装一个 skill"是一个念头，不该先让使用者去判断"我这算远端还是本地"。
   * 所以一个按钮打开一个面板，里面两个页签：**路径 / GitHub** 与**远端目录**。
   */
  let panelOpen = false
  let tab: 'path' | 'remote' = 'path'
  let sourceInput = ''
  let slugInput = ''
  let actions: string[] = [...DEFAULT_ACTIONS]
  /**
   * 允许替换同名 skill。
   *
   * ★ 这个勾选框不是可选项，是**必要的逃生口**：daemon 对同名一律拒绝写入
   *   （避免"下载顺手覆盖了你自己的东西"），而它要求"确实要替换请显式传
   *   overwrite: true"。界面若不提供这个开关，同名冲突在浏览器里就是一条**死路**——
   *   使用者看到的是一句"请显式传 overwrite: true"，而他根本没有地方传。
   */
  let overwrite = false
  let busy = false
  let errorMessage = ''
  let errorHint = ''
  let result: InstallResult | null = null
  let note = ''

  function toggleAction(action: string): void {
    actions = actions.includes(action)
      ? actions.filter((a) => a !== action)
      : [...actions, action]
  }

  function resetFeedback(): void {
    errorMessage = ''
    errorHint = ''
    result = null
    note = ''
  }

  async function runInstall(fn: () => Promise<InstallResult>): Promise<void> {
    busy = true
    resetFeedback()
    try {
      result = await fn()
      note = describeInstall(result)
      // 装完立刻刷新列表：不然使用者看着"已安装"却看不到它出现在下面
      await loadSkills()
    } catch (err) {
      if (err instanceof InstallError) {
        errorMessage = err.message
        errorHint = installErrorHint(err.code)
        if (err.detail) errorMessage += `（${err.detail}）`
        note = `失败：${err.code}`
      } else {
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    } finally {
      busy = false
    }
  }

  /**
   * 从输入的内容猜是路径还是链接。
   *
   * 让使用者多做一次"选定类型"的下拉是没必要的：`/` 开头或 `~` 开头就是路径，
   * 有 `://` 就是链接。猜错也不要紧——填错了服务端会明确告诉他。
   */
  function submitPath(): void {
    const value = sourceInput.trim()
    if (value === '') {
      errorMessage = '请填一个本地目录的绝对路径，或一个 GitHub 链接。'
      return
    }
    const kind = /^[a-z]+:\/\//i.test(value) ? 'url' : 'path'
    void runInstall(() =>
      installFromPathOrUrl({
        kind,
        value,
        ...(slugInput.trim() ? { slug: slugInput.trim() } : {}),
        allowedActions: actions,
        ...(overwrite ? { overwrite: true } : {}),
      }),
    )
  }

  function installFromCatalog(slug: string): void {
    const entry = $remoteCatalog?.skills.find((s) => s.slug === slug)
    if (!entry) {
      errorMessage = `远端目录里没有 ${slug}`
      return
    }
    void runInstall(() =>
      installRemoteEntry({
        slug: entry.slug,
        // 远端目录给的是 SKILL.md 的正文；空的话服务端会拒绝并说清楚
        body: entry.content ?? '',
        sourceRef: `remote:${entry.slug}@${entry.version}`,
        allowedActions: actions,
        ...(overwrite ? { overwrite: true } : {}),
      }),
    )
  }

  function openPanel(): void {
    panelOpen = true
    resetFeedback()
    // 打开时顺手拉一次目录：远端可能没起、或者刚登录，看到的应当是当下的状态
    if (!isLoggedIn() || $remoteCatalog === null) void refreshRemote()
  }
</script>

<div class="view-head">
  <div>
    <h2>Skills</h2>
    <p>
      skill 携带三要素：<strong>审核标准</strong> + <strong>判决结构引用</strong> +
      <strong>允许执行的动作子集</strong>。动作子集是白名单——不在里面的动作会让整条判决
      判为不合规，而不是"忽略这个动作继续"。
    </p>
  </div>
  <div style="display:flex;gap:var(--sp-2)">
    <button type="button" class="secondary" onclick={loadSkills}>刷新</button>
    <button type="button" onclick={openPanel}>安装 skill</button>
  </div>
</div>

{#if panelOpen}
  <section class="install-panel">
    <div class="tabs">
      <button
        type="button"
        class={tab === 'path' ? 'tab active' : 'tab'}
        onclick={() => {
          tab = 'path'
          resetFeedback()
        }}
      >
        从路径 / GitHub 安装
      </button>
      <button
        type="button"
        class={tab === 'remote' ? 'tab active' : 'tab'}
        onclick={() => {
          tab = 'remote'
          resetFeedback()
          void refreshRemote()
        }}
      >
        从远端目录安装
      </button>
      <button type="button" class="ghost small close" onclick={() => (panelOpen = false)}>关闭</button>
    </div>

    {#if tab === 'path'}
      <div class="field">
        <label for="skill-source">本地目录的绝对路径，或 GitHub 链接</label>
        <input
          id="skill-source"
          bind:value={sourceInput}
          placeholder="https://github.com/owner/repo/tree/main/skills/foo 或 /Users/me/dev/my-skill"
          onkeydown={(e) => e.key === 'Enter' && submitPath()}
        />
        <p class="faint small">
          指向的目录里<strong>必须有 SKILL.md</strong>（大写）——技能就是靠"目录里有它"
          被 CLI 发现的，没有它装进来也不会生效，所以会当场拒绝。
          同目录下的其它文本文件会作为<strong>支持文件</strong>一起装上（二进制会被跳过并列出）。
        </p>
      </div>

      <div class="field">
        <label for="skill-slug">slug（留空则用目录名）</label>
        <input id="skill-slug" bind:value={slugInput} placeholder="my-skill" />
      </div>
    {:else}
      <div class="field">
        {#if remoteError}
          <div class="notice bad">
            远端不可用：{remoteError}
            <p class="faint small" style="margin:var(--sp-2) 0 0">
              远端目录在<strong>另一个进程</strong>上（默认 127.0.0.1:4518）。它没起来不影响本机——
              也可以直接用左边那个页签从 GitHub 或本地路径装。
            </p>
          </div>
        {:else if !isLoggedIn()}
          <div class="notice warn">
            还没有登录远端账号。
            <p class="faint small" style="margin:var(--sp-2) 0 0">
              目录是公开的，但登录后才会用你的账号去取。可以在顶栏的「远端」里登录；
              或者直接用「从路径 / GitHub 安装」。
            </p>
          </div>
        {/if}

        {#if $remoteCatalog}
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>slug</th><th>版本</th><th>说明</th><th></th></tr>
              </thead>
              <tbody>
                {#each $remoteCatalog.skills as s (s.slug)}
                  <tr>
                    <td><code>{s.slug}</code></td>
                    <td class="faint small">{s.version}</td>
                    <td class="faint small">{s.summary}</td>
                    <td>
                      <button
                        type="button"
                        class="secondary small"
                        disabled={busy}
                        onclick={() => installFromCatalog(s.slug)}
                      >
                        安装
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <fieldset class="field group">
      <legend>允许这个 skill 触发的动作</legend>
      <div class="actions">
        <!-- ★ 动作是**白名单**：不在里面的动作会让整条判决判为不合规。
             所以这里默认只勾最小权限（发评论），而不是"全都允许"。 -->
        {#each ACTION_TYPES as a (a)}
          <label class="action-chip">
            <input
              type="checkbox"
              checked={actions.includes(a)}
              onchange={() => toggleAction(a)}
            />
            <code>{a}</code>
          </label>
        {/each}
      </div>
      <p class="faint small">
        默认只允许 <code>comment.create</code>——最小权限。要从远端/GitHub 装一个
        会改状态的技能，请在这里显式勾上。
      </p>
    </fieldset>

    <div class="field">
      <label class="action-chip">
        <input type="checkbox" bind:checked={overwrite} />
        允许替换同名的 skill（会**覆盖**已有那个的内容）
      </label>
      <p class="faint small">
        默认不勾：同名一律拒绝写入，避免"下载顺手覆盖了你自己的东西"。
        确实要用新版本顶掉旧的（比如替换内置的 <code>general-review</code>）才勾上。
      </p>
    </div>

    {#if tab === 'path'}
      <button type="button" disabled={busy} onclick={submitPath}>
        {busy ? '正在检查并安装…' : '检查并安装'}
      </button>
    {:else}
      <p class="faint small">选一个条目，用上面勾选的动作装它。</p>
    {/if}

    {#if errorMessage}
      <div class="notice bad" style="margin-top:var(--sp-3)">
        <strong>没有装上</strong>
        <p style="margin:var(--sp-2) 0 0">{errorMessage}</p>
        {#if errorHint}<p class="faint small" style="margin:var(--sp-2) 0 0">{errorHint}</p>{/if}
      </div>
    {/if}

    {#if result}
      <div class="notice {result.installed.length > 0 ? 'good' : 'warn'}" style="margin-top:var(--sp-3)">
        <strong>{result.installed.length > 0 ? '已安装' : '没有改动'}</strong>
        <p style="margin:var(--sp-2) 0 0">{note}</p>

        <!-- ★ 装了什么、什么没装，都要列出来。只说"安装完成"会让使用者以为
             拿到了完整的技能，而实际可能只装了 SKILL.md。 -->
        {#if result.included.length > 0}
          <p class="faint small" style="margin:var(--sp-2) 0 0">
            装进来 {result.included.length} 个文件：
            {#each result.included as f (f.path)}<code>{f.path}</code>{/each}
          </p>
        {/if}
        {#if result.ignored.length > 0}
          <p class="faint small" style="margin:var(--sp-2) 0 0">
            没装进来：
            {#each result.ignored as i (i.path)}<code>{i.path}</code>（{i.reason}）{/each}
          </p>
        {/if}
        {#if result.sourceRef}
          <p class="faint small" style="margin:var(--sp-2) 0 0">来源：{result.sourceRef}</p>
        {/if}
      </div>
    {/if}
  </section>
{/if}

{#if $loading['skills'] && $skills.length === 0}
  <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
  <div class="skeleton" style="width:55%"></div>
{:else if $loadError['skills']}
  <div class="notice bad">{$loadError['skills']}</div>
{:else if $skills.length === 0}
  <div class="empty"><strong>还没有 skill</strong>daemon 首次启动会播种一个内置审核模板。</div>
{:else}
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>slug</th><th>名称</th><th>来源</th><th>文件</th><th>允许的动作</th><th>更新于</th><th></th></tr>
      </thead>
      <tbody>
        {#each $skills as s (s.id)}
          {@const fileCount = Object.keys(s.files ?? {}).length}
          <tr>
            <td><code>{s.slug}</code></td>
            <td>{s.name}</td>
            <td>
              <span class="badge {s.source === 'local' ? 'todo' : 'in_review'}">
                {s.source === 'local' ? '本机自建' : '远端下载'}
              </span>
              {#if s.sourceRef}
                <!-- 来源标识要能看见：出问题时第一件事就是"它到底从哪儿来的" -->
                <div class="faint small" title={s.sourceRef}>{s.sourceRef}</div>
              {/if}
            </td>
            <td class="faint small">
              SKILL.md{#if fileCount > 0} +{fileCount}{/if}
            </td>
            <td>
              {#each s.allowedActions as a (a)}<code style="margin-right:4px">{a}</code>{/each}
            </td>
            <td class="faint small">{new Date(s.updatedAt).toLocaleString()}</td>
            <td>
              <button
                type="button"
                class="ghost small"
                onclick={() => (expanded = expanded === s.id ? null : s.id)}
              >
                {expanded === s.id ? '收起标准' : '看标准'}
              </button>
            </td>
          </tr>
          {#if expanded === s.id}
            <tr>
              <td colspan="7">
                <pre class="skill-body">{s.body}</pre>
                {#if fileCount > 0}
                  <details class="support">
                    <summary>支持文件（{fileCount}）</summary>
                    {#each Object.entries(s.files ?? {}) as [path, content] (path)}
                      <p class="faint small" style="margin:var(--sp-2) 0 0"><code>{path}</code></p>
                      <pre class="skill-body">{content}</pre>
                    {/each}
                  </details>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .install-panel {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-4);
    margin-bottom: var(--sp-4);
    background: var(--surface);
  }

  .tabs {
    display: flex;
    gap: var(--sp-1);
    align-items: center;
    border-bottom: 1px solid var(--line);
    margin-bottom: var(--sp-3);
  }

  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: var(--sp-2) var(--sp-3);
    color: var(--text-faint);
    cursor: pointer;
    font-size: var(--fs-sm);
  }

  .tab.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }

  .close {
    margin-left: auto;
  }

  .field {
    margin-bottom: var(--sp-3);
  }

  .field > label,
  .group > legend {
    display: block;
    margin-bottom: var(--sp-1);
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }

  .group {
    border: none;
    padding: 0;
    margin-inline: 0;
  }

  .field > input {
    width: 100%;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-3);
  }

  .action-chip {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-xs);
    cursor: pointer;
  }

  .skill-body {
    margin: 0;
    padding: var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    white-space: pre-wrap;
    font-size: var(--fs-xs);
    line-height: 1.6;
    max-height: 24rem;
    overflow-y: auto;
  }

  .support {
    margin-top: var(--sp-2);
  }

  .support summary {
    cursor: pointer;
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
</style>
