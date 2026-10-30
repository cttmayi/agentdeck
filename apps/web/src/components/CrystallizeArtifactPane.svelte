<script lang="ts">
  /**
   * 沉淀页的**产物栏**（分批第 92 批，U1 骨架的第一块）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么这一栏要常驻（设计 §12.3 / §12.12）
   * ══════════════════════════════════════════════════════════════════
   * 沉淀页最终会变成"对话 + 产物"两件事：**产物必须一眼能看到**。原来它埋在
   * 流程页的第 ③ 步里（要点进分节、还要在"内容/差异"两个 tab 之间切），于是
   * "这次到底产出了什么、体检过没过"只能靠翻。这一栏把产物提成**常驻的第三列**：
   * 文件清单 + 机械体检 + 版本，跟中间那一栏的过程并列，谁也不遮谁。
   *
   * ★ 数据只用**已有接口**（`GET /api/crystallize/artifacts`）：U1 只搬位置，不造新状态。
   *   因此它读的是和流程页同一份产出、同一份校验结果——两处不一致这种病，这一批
   *   就不可能发生（真接了第二份数据源才会）。
   *
   * ⚠️ 窄屏（< 72rem）：主从布局本来就退化成"一次只显示一栏"，再塞第三列会挤成
   *    竖条。所以窄屏下这一栏变成**从右侧滑出的抽屉**，靠左缘那个"产物"小旗打开，
   *    关掉就回到单栏。宽屏时小旗不显示（`display:none`），栏是常驻的网格列。
   */
  import { t } from '../lib/i18n.ts'
  import { api } from '../lib/api.ts'

  /** `GET /api/crystallize/artifacts` 的返回（与流程页 `CrystallizeView` 同一份）。 */
  interface Artifacts {
    status: string
    mode: 'files' | 'text' | 'refused' | 'agent'
    refusalReason?: string
    files: Record<string, string>
    validation: { ok: boolean; problems: Array<{ file: string; message: string }> }
    target: { kind: string } | null
  }

  let {
    draftRunId,
    version = 1,
  }: {
    /** 选中的那条沉淀（最新那一版的 run id）。 */
    draftRunId: string
    /** 这是第几版（来自 `GET /api/crystallize/drafts` 的行）。 */
    version?: number
  } = $props()

  /**
   * ⚠️ 这几个必须 `$state`：本组件是 **runes 模式**（用了 `$props`），普通 `let` 不是
   *    响应式的——变是变了，界面不重渲染。第一版就是漏了它，真 Chrome 里的表现是
   *    "产物请求已经 200 拿到 4 个文件，右栏永远停在『载入产物…』"，而 console 打点
   *    显示 `loaded 4`。**这类 bug 看代码完全看不出来，只有量 DOM 才发现。**
   */
  /** `GET /api/crystallize/material` 的返回：这一版起草吃进去的素材文件。 */
  interface Material {
    dir: string
    items: Array<{ relPath: string; bytes: number; truncated: boolean; text: string }>
  }

  let artifacts = $state<Artifacts | null>(null)
  let material = $state<Material | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  /** 选中预览的文件（相对 skill/ 或 agent/ 目录）。空 = 还没选，默认给第一个。 */
  let selected = $state('')
  /** 窄屏抽屉此刻是否打开（宽屏用不到它）。 */
  let drawerOpen = $state(false)

  /** 一次只认一个 run：切换选中时旧的返回要丢掉（否则旧产物盖住新的）。 */
  let seq = 0

  /** 接口的 404/`ApiError(404)`：这条沉淀还没有产物，不算错误。 */
  function isMissing(err: unknown): boolean {
    const text = String(err)
    return text.includes('404')
  }

  async function load(id: string): Promise<void> {
    const mine = ++seq
    loading = true
    error = null
    try {
      const res = await api<Artifacts>(
        `/api/crystallize/artifacts?draftRunId=${encodeURIComponent(id)}`
      )
      if (mine !== seq) return
      artifacts = res
      const files = Object.keys(res.files ?? {})
      selected = files[0] ?? ''
      // 素材与产物是两个接口（语义不同：一个"吃了什么"、一个"产出了什么"），
      // 但都是**这一条沉淀的事实**，所以一起取、一起显示。
      // ⚠️ 它必须在这里（成功分支）——第一版误加进了 catch 里，于是只有**产物取失败**时
      //    才会去取材料，正常路径永远是"0 个素材文件"（探针当场抓到，见 §12.19）。
      try {
        material = await api<Material>(
          `/api/crystallize/material?draftRunId=${encodeURIComponent(id)}`
        )
      } catch {
        material = null
      }
    } catch (err) {
      if (mine !== seq) return
      // 没有产出（起草还没跑完 / 没跑成）时接口给 404：那是正常的空态，不当错误显示。
      // 其它错误**必须显示**——右栏静默变空，使用者只会以为"产物没了"。
      artifacts = null
      error = isMissing(err) ? null : String(err)
    } finally {
      if (mine === seq) loading = false
    }
  }

  $effect(() => {
    void load(draftRunId)
  })

  /**
   * 派生值走**显式签名的小函数**，不在 `$derived` 里直接窄化 `artifacts`：
   * `$derived(a === null ? [] : Object.keys(a.files))` 会被 tsc 窄成 `never`
   * （runes 里那个变量被包进闭包，控制流分析拿不到 `load()` 里的赋值）——
   * 第一次就是这么红的，改成传参的函数后类型就正常了。
   */
  function fileList(value: Artifacts | null): string[] {
    return value === null ? [] : Object.keys(value.files ?? {}).sort()
  }

  function problemList(value: Artifacts | null): Artifacts['validation']['problems'] {
    return value === null ? [] : value.validation.problems
  }

  function isOk(value: Artifacts | null): boolean {
    return value !== null && value.validation.ok
  }

  function materialList(value: Material | null): Material['items'] {
    return value === null ? [] : value.items
  }

  const materialItems = $derived(materialList(material))
  const files = $derived(fileList(artifacts))
  const current = $derived(files.includes(selected) ? selected : (files[0] ?? ''))
  const problems = $derived(problemList(artifacts))
  const checkTotal = $derived(problems.length)
  const checksOk = $derived(isOk(artifacts))
</script>

<!-- 窄屏的打开入口：宽屏不显示（栏本身就在网格里） -->
<button
  type="button"
  class="artifact-tab"
  aria-label={$t('crystallize.artifactOpen')}
  onclick={() => (drawerOpen = true)}
>
  {$t('crystallize.artifactOpen')}
</button>

<aside class="pane detail-pane artifact-pane" data-open={drawerOpen ? 'true' : 'false'}>
  <header class="pane-head detail-head">
    <h2>{$t('crystallize.artifactTitle')}</h2>
    <div class="pane-actions">
      {#if version > 1}<span class="faint small">{$t('crystallize.artifactVersion', { n: String(version) })}</span>{/if}
      <button type="button" class="ghost artifact-close" onclick={() => (drawerOpen = false)}>
        {$t('crystallize.artifactClose')}
      </button>
    </div>
  </header>

  <div class="pane-body artifact-body">
    {#if error !== null}
      <p class="notice bad small">{error}</p>
    {:else if loading}
      <p class="faint small">{$t('crystallize.artifactLoading')}</p>
    {:else if files.length === 0}
      <p class="faint artifact-empty">{$t('crystallize.artifactEmpty')}</p>
    {:else}
      <!-- 材料：这一版起草**吃进去**的东西（轨迹 / 判决 / 用户追加）。只读——
           增删要有写接口（daemon 目前没有），所以这里不放假按钮。 -->
      <section class="artifact-mats">
        <h3 class="artifact-sub">
          {$t('crystallize.artifactMaterial')}
          <span class="artifact-mat-count">{materialItems.length}</span>
        </h3>
        {#if materialItems.length === 0}
          <p class="faint small">{$t('crystallize.artifactMaterialEmpty')}</p>
        {:else}
          <ul class="artifact-mat-list">
            {#each materialItems as item (item.relPath)}
              <li>
                <span class="artifact-mat-name">{item.relPath}</span>
                <span class="faint small">{Math.round(item.bytes / 100) / 10} KB</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- 文件：点一个在下面预览。用 button 而不是 a：它只切换预览，不导航。 -->
      <section class="artifact-files">
        <h3 class="artifact-sub">{$t('crystallize.artifactFiles')}</h3>
        <ul>
          {#each files as file (file)}
            <li>
              <button
                type="button"
                class="artifact-file"
                class:active={file === current}
                onclick={() => (selected = file)}
              >
                <span class="artifact-file-name">{file}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>

      <section class="artifact-checks">
        <h3 class="artifact-sub">
          {$t('crystallize.artifactChecks')}
          <span class="artifact-check-count" class:ok={checksOk}>
            {checksOk
              ? $t('crystallize.artifactChecksPassed')
              : $t('crystallize.artifactChecksProblems', { n: String(checkTotal) })}
          </span>
        </h3>
        {#if problems.length === 0}
          <p class="small artifact-check-ok">✔</p>
        {:else}
          <ul class="artifact-problems">
            {#each problems as problem, i (i)}
              <li><span class="artifact-problem-file">{problem.file || '—'}</span>{problem.message}</li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="artifact-preview">
        <h3 class="artifact-sub">{current}</h3>
        <pre class="artifact-pre">{artifacts?.files[current] ?? ''}</pre>
      </section>
    {/if}
  </div>
</aside>

<style>
  /* 宽屏：网格里的第三列，自己管滚动（`.pane` 已经给了 flex 列） */
  .artifact-pane {
    border-left: 1px solid var(--line);
    background: var(--surface);
    min-width: 0;
  }

  /* 宽屏不需要"收起"：栏就在那儿 */
  .artifact-close {
    display: none;
  }

  /* 窄屏的入口小旗：宽屏隐藏 */
  .artifact-tab {
    display: none;
  }

  .artifact-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .artifact-sub {
    font-size: var(--fs-sm);
    color: var(--text-dim);
    margin-bottom: var(--sp-1);
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
  }

  .artifact-mat-count {
    color: var(--text-faint);
  }

  .artifact-mat-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: var(--fs-sm);
  }

  .artifact-mat-list li {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
    padding: 0.125rem 0;
  }

  .artifact-mat-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .artifact-files ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .artifact-file {
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    border-radius: var(--radius);
    padding: 0.1875rem var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .artifact-file:hover {
    background: var(--surface-hover);
  }

  .artifact-file.active {
    background: var(--surface-2);
    color: var(--text);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .artifact-file-name {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }

  .artifact-check-count {
    color: var(--bad);
  }

  .artifact-check-count.ok {
    color: var(--good);
  }

  .artifact-check-ok {
    color: var(--good);
  }

  .artifact-problems {
    margin: 0;
    padding-left: 1.1rem;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }

  .artifact-problem-file {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-right: var(--sp-1);
  }

  .artifact-pre {
    margin: 0;
    padding: var(--sp-2);
    background: var(--panel);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 22rem;
    overflow: auto;
    color: var(--text-dim);
  }

  .artifact-empty {
    margin: 0;
  }

  /* ══════════════ 不够宽（< 96rem）：第三列改成右侧抽屉，不占网格 ══════════════
     ⚠️ 断点必须与 `app.css` 里 `@media (min-width: 96rem)` 对齐：一个管"占不占列"，
     另一个管"长什么样"，两处不一致就会出现"网格里留了列、里面却是抽屉"的错位。 */
  @media (max-width: 95.99rem) {
    .artifact-pane {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(22rem, 86vw);
      transform: translateX(100%);
      transition: transform 0.18s ease;
      z-index: 40;
      box-shadow: -12px 0 32px rgba(16, 24, 40, 0.16);
    }

    .artifact-pane[data-open='true'] {
      transform: none;
    }

    .artifact-close {
      display: inline-flex;
    }

    /* 打开时贴在右缘上方：它是"钻进第三列"的入口，别和主操作抢顶栏 */
    .artifact-tab {
      display: inline-flex;
      position: fixed;
      right: 0;
      top: 40%;
      z-index: 30;
      border: 1px solid var(--line-strong);
      border-right: 0;
      border-radius: var(--radius) 0 0 var(--radius);
      background: var(--surface);
      color: var(--text-dim);
      padding: var(--sp-2) var(--sp-1);
      font-size: var(--fs-xs);
      writing-mode: vertical-rl;
    }
  }
</style>
