<script lang="ts">
  /**
   * 目录选择框（分批第 229 批）：「新建对话」与「新建任务」里的工作目录，从**手打路径**
   * 变成**点着选**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么是一个页面里的框，而不是系统原生的选择框
   * ══════════════════════════════════════════════════════════════════
   *
   * 浏览器给不了绝对路径：`<input type="file" webkitdirectory>` 交出的是文件本身与
   * **相对**路径。而工作目录要的是一个绝对路径（它会写进 `conversation.workDir`，
   * daemon 再 `chdir` 过去）。所以只能由 daemon 列目录（`GET /api/fs/dirs`）、页面画出来。
   *
   * 这个框只做一件事：**让人看见"这个目录里到底有什么"再决定**。所以文件也列
   * （不可选，只是佐证"就是我的仓库"）——只列目录的话，"选的是哪个 repo"仍然得靠记忆。
   *
   * ⚠️ 输入框**始终留着**（上面那条路径）：选择框不是唯一的入口，手打永远可用——它是
   *    所有失败情况的退路（隐藏目录、网络盘、拼出来的路径）。
   */
  import { untrack } from 'svelte'
  import { Modal } from '@agentdeck/ui/components'
  import { api, ApiError } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'

  interface Entry {
    name: string
    path: string
    kind: 'dir' | 'file'
  }
  interface Listing {
    path: string
    parent: string | null
    home: string
    workRoot: string
    entries: Entry[]
    truncated: boolean
  }

  let {
    /** 开关（`bind:open`：表单上那颗「浏览…」把它置真，选完/关掉由这里置回）。 */
    open = $bindable(false),
    /** 与表单那个输入框**同一个值**（`bind:value`）：打开时从它开始，选中时写回它。 */
    value = $bindable(''),
  }: { open?: boolean; value?: string } = $props()

  let listing = $state<Listing | null>(null)
  let jump = $state('')
  let busy = $state(false)
  let error = $state('')

  /** 失败按**码**说话（界面可能切英文，而 daemon 那句 `error` 只有中文）。 */
  function describeError(err: unknown): string {
    const body = err instanceof ApiError ? (err.body as { code?: string; error?: string } | null) : null
    const code = body?.code ?? ''
    if (code === 'not_found') return $t('dirs.err.not_found')
    if (code === 'not_a_dir') return $t('dirs.err.not_a_dir')
    if (code === 'denied') return $t('dirs.err.denied')
    if (code === 'not_absolute') return $t('dirs.err.not_absolute')
    /**
     * ★ 没有 `code` 的 404 = **这个 daemon 还没有这条接口**（先起的 daemon、后换的界面）。
     *   这条分支不是理论情况：本地开发时界面是构建产物（换了就是新的），而 daemon 进程
     *   还是旧的那一个——不说清楚，人只会看到"读不出这个目录"，然后去查权限。
     *   界面与 daemon 同源同版本发布，所以这条只在"重启前的那一段"出现。
     */
    if (err instanceof ApiError && err.status === 404 && code === '') return $t('dirs.err.noRoute')
    return $t('dirs.err.unknown', { reason: err instanceof Error ? err.message : String(err) })
  }

  /** 列一个目录。**成功才换清单**，失败只动 `error`（人还站在原来那一层）。 */
  async function load(path: string): Promise<boolean> {
    busy = true
    try {
      const res = await api<Listing>(`/api/fs/dirs?path=${encodeURIComponent(path)}`)
      listing = res
      jump = res.path
      return true
    } catch (err) {
      error = describeError(err)
      return false
    } finally {
      busy = false
    }
  }

  /**
   * 从"表单里当前那个值"开始。
   *
   * ⚠️ 打不通（手打的路径写错了、目录已经删了）时**照样把家目录列出来**：留一个空框
   *    比什么都不显示更让人以为界面坏了；而错误那句话仍然留着，指向真正的问题。
   */
  async function openAt(start: string): Promise<void> {
    error = ''
    const asked = start.trim()
    if (asked === '') {
      await load('')
      return
    }
    if (await load(asked)) return
    const saved = error
    if (await load('')) error = saved
  }

  let wasOpen = false
  $effect(() => {
    if (open === wasOpen) return
    wasOpen = open
    if (!open) return
    // ★ 读 `value` 但不追踪它：这个效果只该由"打开"触发；把 `value` 写进依赖会让
    //   选中之后（`value` 变了）又重跑一次，清单跟着跳回家目录。
    const start = untrack(() => value)
    void openAt(start)
  })

  function pick(): void {
    if (listing === null) return
    value = listing.path
    open = false
  }
</script>

<Modal
  {open}
  title={$t('dirs.title')}
  subtitle={$t('dirs.subtitle')}
  closeLabel={$t('common.close')}
  onclose={() => (open = false)}
>
  <div class="picker">
    <!-- 路径：可以打、可以回车（隐藏目录、网络盘这些只能打出来的路径都靠它） -->
    <div class="path-row">
      <input
        class="mono"
        bind:value={jump}
        aria-label={$t('dirs.pathLabel')}
        data-dir-picker-input
        autocomplete="off"
        spellcheck="false"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void load(jump.trim())
          }
        }}
      />
      <button type="button" class="btn btn--ghost" onclick={() => void load(jump.trim())}>
        {$t('dirs.go')}
      </button>
    </div>

    <div class="nav-row">
      <button
        type="button"
        class="btn btn--ghost"
        disabled={listing?.parent === null || listing === null}
        data-dir-picker-up
        onclick={() => {
          if (listing?.parent) void load(listing.parent)
        }}
      >{$t('dirs.up')}</button>
      <button type="button" class="btn btn--ghost" onclick={() => void load('')}>{$t('dirs.home')}</button>
      <button
        type="button"
        class="btn btn--ghost"
        onclick={() => {
          if (listing?.workRoot) void load(listing.workRoot)
        }}
      >{$t('dirs.workRoot')}</button>
      <button
        type="button"
        class="btn btn--ghost"
        onclick={() => void load(listing?.path ?? '')}
      >{$t('dirs.refresh')}</button>
      {#if listing !== null}
        <span class="faint fs-xs counts" data-dir-picker-counts>
          {$t('dirs.count', {
            dirs: String(listing.entries.filter((e) => e.kind === 'dir').length),
            files: String(listing.entries.filter((e) => e.kind === 'file').length),
          })}
        </span>
      {/if}
    </div>

    {#if error !== ''}
      <p class="notice bad" data-dir-picker-error>{error}</p>
    {/if}

    <div class="list" data-dir-picker-list>
      {#each listing?.entries ?? [] as entry (entry.path)}
        {#if entry.kind === 'dir'}
          <button
            type="button"
            class="row dir"
            title={entry.path}
            data-dir-entry="dir"
            onclick={() => void load(entry.path)}
          >
            <span class="glyph" aria-hidden="true">▸</span>
            <span class="name mono">{entry.name}</span>
          </button>
        {:else}
          <!-- 文件不可选：列出来只为了让人确认"这个目录里确实是我的东西" -->
          <span class="row file" title={entry.path} data-dir-entry="file">
            <span class="glyph" aria-hidden="true">·</span>
            <span class="name mono">{entry.name}</span>
          </span>
        {/if}
      {:else}
        {#if !busy}
          <p class="hint empty">{listing === null ? '' : $t('dirs.empty')}</p>
        {/if}
      {/each}
    </div>

    <p class="hint">{busy ? $t('dirs.loading') : ''}{busy ? ' ' : ''}{$t('dirs.filesPreview')}</p>
    {#if listing?.truncated}
      <p class="hint" data-dir-picker-truncated>
        {$t('dirs.truncated', { n: String(listing.entries.length) })}
      </p>
    {/if}

    <div class="actions">
      <code class="mono now" data-dir-picker-current>{listing?.path ?? ''}</code>
      <button type="button" class="btn btn--ghost" onclick={() => (open = false)}>{$t('common.cancel')}</button>
      <button
        type="button"
        class="btn btn--primary"
        data-dir-picker-pick
        disabled={listing === null || busy}
        onclick={pick}
      >{$t('dirs.pick')}</button>
    </div>
  </div>
</Modal>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .path-row {
    display: flex;
    gap: var(--sp-2);
  }
  .path-row input {
    flex: 1 1 auto;
    min-width: 0;
  }
  /**
   * ★ 分批第 230 批：这一框里的按钮（「去」「上一级」「家目录」「工作区」「刷新」
   * 「取消」「选这个目录」）**不许被挤窄**。
   *
   * 使用者报的："新加的『浏览』2 个字，都换行了"——同一个根因：它们每个都是 flex 项，
   * 空间不够时和输入框一起收缩，而中文的最小内容宽度是**一个字**（每个汉字都是断行点），
   * 于是「浏览…」被压到一个字宽就折成两行。`flex: 0 0 auto` 把收缩全推给输入框，
   * `white-space: nowrap` 兜底（宁可溢出，也不要断在字中间）。
   */
  .path-row > button,
  .nav-row > button,
  .actions > button {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .nav-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .nav-row .counts {
    margin-left: auto;
  }
  /* 清单自己滚：一个仓库根目录可能有几十个目录，框不该跟着长到屏幕外 */
  .list {
    max-height: 18rem;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--sp-1);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0.15rem 0.35rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    width: 100%;
    color: inherit;
    font: inherit;
  }
  .row.dir {
    cursor: pointer;
  }
  .row.dir:hover {
    background: var(--surface-hover);
  }
  /* 文件淡一档：一眼就能看出"这些不是能点的" */
  .row.file {
    color: var(--text-faint);
  }
  .row .glyph {
    width: 0.8rem;
    color: var(--text-faint);
  }
  .row .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: var(--sp-2);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-top: var(--sp-1);
  }
  .actions .now {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
  }
</style>
