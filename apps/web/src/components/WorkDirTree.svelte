<script lang="ts">
  /**
   * 「工作目录的文件」——任务详情右边那一栏，也是聊天右栏底部那一栏。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么是同一个组件
   * ══════════════════════════════════════════════════════════════════
   *
   * 两处的差别只有**问谁**：任务那条按某次执行的目录问（`run.workDir`），聊天按
   * 某个对话的目录问（`conversation.workDir`，空则由平台分配）。服务端两条路由
   * 返回同一个形状，所以这里只用一个 `base` 区分。
   *
   * 不写第二份的理由：这一栏的判据（谁排在前面、注入物怎么显示、一次列一层、
   * 取不到时说什么）每一条都是踩出来的（见 `lib/workdir-view.ts` 顶上那三个
   * 事故）。抄一份就是迟早只修一处。
   *
   * ══════════════════════════════════════════════════════════════════
   * 三件事刻意不写
   * ══════════════════════════════════════════════════════════════════
   *
   *   · **不递归列整棵树**：一个技能目录就能带出
   *     `.claude/skills/x/templates/viewer.html` 这种一长串路径，把真正的产出
   *     淹掉十几行。点开一层取一层。
   *   · **不显示整串路径**：层级靠缩进，路径在 `title` 里（悬停能看全）。
   *   · **不用文字说明"哪些是平台注入的"**：弱化显示就够了。`managed` 的判据
   *     来自该 runtime 的描述表，不是写死 `.claude/`——换个 CLI 注入物落在别处，
   *     写死的规则会把注入物当成产出显示，而那种错是静默的。
   */
  import FileViewer from './FileViewer.svelte'
  import { api, type WorkDirFile, type WorkDirListing } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { emptyDirNoticeKey, flattenWorkDir, humanSize } from '../lib/workdir-view.ts'

  /** 接口前缀：`/api/runs/<id>` 或 `/api/conversations/<id>`。 */
  export let base: string
  /**
   * 换了它就重新从顶层取。
   *
   * ⚠️ 与 `base` **分开**是刻意的：聊天那边目录本身可以被改（对话的
   *    「工作目录」输入框），改完 `base` 一个字都没变而列的东西必须重取。
   */
  export let reloadKey: string
  /**
   * 顶层有几项——**报给外面**（`bind:count`）。
   *
   * 聊天那边这一栏默认是**收起**的，收着的时候也得让使用者知道"值不值得点开"，
   * 所以条数写在头部那一行上。条数只有这里知道（列表住在这个组件里），
   * 与其让父组件再问一次接口，不如把它报上去。
   */
  export let count = 0

  let root: WorkDirFile[] = []
  /** 已经取回来的子层：目录路径 → 它的直接子项。 */
  let children: ReadonlyMap<string, WorkDirFile[]> = new Map()
  let expanded: ReadonlySet<string> = new Set()
  /** 正在取哪几层（键是目录路径，'' = 顶层）。 */
  let loading: ReadonlySet<string> = new Set()
  let truncated = false
  /** 目录存在吗（`undefined` = 旧 daemon 不返回这个字段，按"存在"处理）。 */
  let exists: boolean | undefined = undefined
  /** 顶层这一趟取完了没有——没取完画骨架屏，取完了才敢说"空的"。 */
  let ready = false
  /** 已经为哪个 key 取过。 */
  let loadedKey = ''
  /** 取目录失败的原因——必须**显示出来**，不能静默留空。 */
  let error = ''
  /**
   * 正在查看的文件（`null` = 查看器关着）。
   *
   * ★ 点文件**不再跳新标签页**，而是在这一页打开查看器（渲染 / 原文两面可切）。
   *   「在新标签页打开」仍然是查看器里的一个按钮——产出是 HTML 时（例如一个
   *   p5.js 画布页）全屏看才舒服。
   */
  let viewing: WorkDirFile | null = null

  // ★ `loadedKey` 在这里就写上，不是在 `await` 之后：写晚了的话，一次失败
  //   （error 变了、key 没变）不会触发重取，而一旦 key 变了却失败，就会变成
  //   "每次渲染都重取一次"。
  $: if (reloadKey !== loadedKey) void reset(reloadKey)
  $: rows = flattenWorkDir(root, children, expanded)
  // 报了顶层条数：子层的展开不影响它（头部那一行说的是"这个目录里有多少东西"）
  $: count = root.length
  $: emptyKey = emptyDirNoticeKey(exists)

  function mark(
    set: ReadonlySet<string>,
    path: string,
    on: boolean,
  ): ReadonlySet<string> {
    const next = new Set(set)
    if (on) next.add(path)
    else next.delete(path)
    return next
  }

  async function reset(next: string): Promise<void> {
    loadedKey = next
    ready = false
    root = []
    children = new Map()
    expanded = new Set()
    loading = new Set()
    truncated = false
    exists = undefined
    error = ''
    if (next === '') return
    await load('')
  }

  /** 取某一层目录（`dir` 为空串 = 顶层）。 */
  async function load(dir: string): Promise<void> {
    loading = mark(loading, dir, true)
    try {
      const suffix = dir === '' ? '' : `?dir=${encodeURIComponent(dir)}`
      const out = await api<WorkDirListing>(`${base}/files${suffix}`)
      if (dir === '') {
        root = out.entries
        truncated = out.truncated
        exists = out.exists
      } else {
        const next = new Map(children)
        next.set(dir, out.entries)
        children = next
      }
      error = ''
    } catch (err) {
      // ★ 失败必须**说出来**。第一版这里是 `catch { listing = null }`，而界面把
      //   null 渲染成骨架屏——于是"接口取不到"和"还在加载"长得一模一样，使用者
      //   看到的就是"这一栏什么都没有"（实测撞到过：daemon 还是旧代码，
      //   `/files` 返回 404，而那一栏只是安静地空着）。
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = mark(loading, dir, false)
      if (dir === '') ready = true
    }
  }

  /** 展开/收起一个目录。展开时如果还没取过它的子项，就去取一层。 */
  function toggleDir(entry: WorkDirFile): void {
    const next = new Set(expanded)
    if (next.has(entry.path)) {
      next.delete(entry.path)
    } else {
      next.add(entry.path)
      if (!children.has(entry.path)) void load(entry.path)
    }
    expanded = next
  }
</script>

{#if error}
  <div class="notice bad">
    {$t('files.error')}
    <p class="faint small" style="margin:var(--sp-2) 0 0">{error}</p>
    <p class="faint small" style="margin:var(--sp-2) 0 0">{$t('files.errorHint')}</p>
  </div>
{:else if !ready}
  <div class="skeleton" style="width:70%"></div>
{:else if rows.length === 0}
  <!--
    ★ 「还不存在」与「存在但是空的」分开说：两句给出的下一步不同。
      判据是服务端给的 `exists`，不是盯着空数组猜（见 `emptyDirNoticeKey`）。
  -->
  <p class="hint">{$t(emptyKey)}</p>
{:else}
  <ul class="wd">
    {#each rows as { entry, depth } (entry.path)}
      <li style="padding-left:{depth * 0.9}rem">
        {#if entry.kind === 'dir'}
          <button
            type="button"
            class="wd-dir"
            class:managed={entry.managed}
            title={entry.path}
            onclick={() => toggleDir(entry)}
          >
            <span class="wd-twisty">
              {entry.hasChildren ? (expanded.has(entry.path) ? '▾' : '▸') : '·'}
            </span>
            <span class="mono">{entry.name}</span>
          </button>
          {#if loading.has(entry.path)}
            <span class="faint small">{$t('files.reading')}</span>
          {/if}
        {:else}
          <!--
            点文件**就地打开查看器**（渲染 / 原文两面可切）。平台注入的
            （`.claude/**` 等）照旧能点开——树上已经弱化显示过"这不是它的产出"，
            而"到底注入了哪份 SKILL.md"恰恰是使用者会想确认的事。
          -->
          <button
            type="button"
            class="wd-file"
            class:managed={entry.managed}
            title={entry.path}
            onclick={() => (viewing = entry)}
          >{entry.name}</button>
          <span class="faint small">{humanSize(entry.sizeBytes)}</span>
        {/if}
      </li>
    {/each}
  </ul>
  {#if truncated}
    <p class="faint small">{$t('files.truncated')}</p>
  {/if}
{/if}

{#if viewing !== null}
  <FileViewer {base} entry={viewing} onclose={() => (viewing = null)} />
{/if}

<style>
  .wd {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .wd li {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 2px 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    min-width: 0;
  }

  .wd-dir {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    background: none;
    border: 0;
    padding: 0;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wd-dir:hover {
    color: var(--text);
  }

  /* 展开箭头定宽：不定宽时，目录名会随着 ▸/▾ 的宽度差左右抖 */
  .wd-twisty {
    width: 0.75rem;
    flex-shrink: 0;
    color: var(--text-faint);
  }

  .wd-file {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 平台注入的（技能、上下文文件）：弱化显示就够了，不再用一段文字去解释 */
  .wd-dir.managed,
  .wd-file.managed {
    color: var(--text-faint);
  }
</style>
