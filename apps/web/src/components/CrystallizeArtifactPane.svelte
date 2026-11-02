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
  // ★ 分批第 155 批：编辑器（树 + 内容/差异 + 保存改动）搬进这一栏
  import CrystallizeDraftEditor from './CrystallizeDraftEditor.svelte'
  import { DISTILLY_SOURCE, draftSkill, editor, paneWide } from '../lib/crystallize-editor.svelte.ts'

  /** `GET /api/crystallize/artifacts` 的返回（与流程页 `CrystallizeView` 同一份）。 */
  interface Artifacts {
    status: string
    /** `files` = 交了东西；`none` = 这一轮只是说了话（没交 skill，分批第 211 批）。 */
    mode: 'files' | 'none'
    files: Record<string, string>
    validation: { ok: boolean; problems: Array<{ file: string; message: string }> }
    target: { kind: string } | null
  }

  let {
    draftRunId,
    /**
     * ★ 分批第 147 批：**材料被人从别处改过**的信号（追加材料 / 删掉材料）。
     *
     * 为什么需要它：材料有两个显示处——中间那栏的「依据」块（`CrystallizeView`）与本栏的
     * 材料清单——数据都来自 `GET /api/crystallize/material`。一处改了、另一处不刷新，
     * 使用者就会看到"刚追加了但右栏没有"（§12.14：两处必须由同一份数据现算，否则必漂）。
     * 父组件 `views/Crystallize.svelte` 持有这个计数，两边谁改了都把它 +1。
     */
    rev = 0,
    /** 这一栏自己改了材料（删掉一份）时通知父组件：让另一处也跟着重读。 */
    onchanged = () => {},
  }: {
    draftRunId: string
    rev?: number
    onchanged?: () => void
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
  /**
   * 窄屏抽屉的开关。**默认值由数据推**（不是 `$effect` 里"进审阅就置真"）：
   *
   * ★ 分批第 196 批：中栏那条"产物消息"删掉之后（中间只留对话），编辑器**只有右栏这一处**；
   *   而窄于 74rem 时右栏是移出视口的抽屉 ⇒ 草稿一出来就得把抽屉推开，否则使用者看到的是
   *   "它说写好了，但草稿在哪？"（第 168 批就因为同一件事被打回来过一次）。
   *
   * ⚠️ 第一版写成 `$effect`（"窄 + 有产物 ⇒ 置真"），探针量到 `data-open="false"`——
   *    那个 effect 在**宽度变化**时重跑不可靠（它读的是模块里的 `$state`，而 `$effect`
   *    的依赖收集在这种跨组件引用上没按预期触发）。改成 `$derived` 之后"该开"是**算出来的**，
   *    不存在时序问题；人手动关/开用 `drawerManual` 覆盖（`null` = 按默认推）。
   */
  let drawerManual = $state<boolean | null>(null)
  // 换草稿、或窗口跨过断点 ⇒ 回到"按数据推"的默认（人的手动关/开只对当前这一屏有效）
  $effect(() => {
    void draftRunId
    void paneWide.value
    drawerManual = null
  })
  const drawerOpen = $derived(
    drawerManual ?? (!paneWide.value && artifacts !== null && artifacts.mode === 'files'),
  )
  /**
   * ★ 分批第 173 批（使用者定："技能走注入，但**不要默认放项目中**，让用户自己装、建议一键安装"）：
   * 这一栏负责"这条沉淀用什么技能"——没装就给一键安装，装了就把 id 交给起草请求。
   */

  async function loadDraftSkill(): Promise<void> {
    try {
      const res = await api<{ skills: Array<{ id: string; slug: string; name: string }> }>('/api/skills')
      const found = res.skills.find((sk) => sk.slug === 'distilly' || sk.slug.startsWith('distilly'))
      draftSkill.id = found?.id ?? ''
      draftSkill.slug = found?.slug ?? ''
      draftSkill.name = found?.name ?? ''
      draftSkill.error = ''
    } catch (err) {
      draftSkill.error = String(err instanceof Error ? err.message : err)
    }
  }

  $effect(() => {
    void loadDraftSkill()
  })

  /** 一次只认一个 run：切换选中时旧的返回要丢掉（否则旧产物盖住新的）。 */
  let seq = 0
  /** 上一次 `load` 的那条沉淀（用来区分"换了一条"与"同一条、材料变了"）。 */
  let seenId = ''

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
      // ★ 分批第 155 批：编辑器（树 + 正文）在这一栏里渲染，它的数据在
      // `lib/crystallize-editor.svelte.ts`。**这一栏自己负责把它打开**：
      //   中间那栏只在"审阅态"才 `loadDraftOutput()`，而右栏在任何有产出的屏都要显示树——
      //   实测漏了这句时，起草中那一屏右栏画着"还没有产物"、编辑器空着（三条判据红）。
      //   `editor.open()` 自己挡重复（同一条 run 只重读、不清编辑现场）。
      if (res !== null && editor.runId !== id) void editor.open(id)
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
    // 读 `rev` 是**故意的**：材料在栏脚被追加/删掉之后，产物那一栏也可能要重算（§12.14 同源）。
    // ★ 分批第 197 批：材料本身搬去了栏脚（`CrystallizeMaterials`），所以这里只剩产物一条路。
    void rev
    // ★ 分批第 155 批：用**中间那栏实际挂上的草稿**（路由可能是来源 run，见 store 里
    //   `attachedRunId` 的注释）；中间那栏还没挂上时退回路由 id。
    void editor.attachedRunId
    const id = editor.attachedRunId !== '' ? editor.attachedRunId : draftRunId
    if (id !== seenId) {
      seenId = id
      void load(id)
    }
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
  /** ★ 分批第 211 批：没交 skill ⇒ 没有"体检"可言（它没有可体检的东西）。 */
  const noOutputMode = $derived(artifacts !== null && artifacts.mode === 'none')
  const checkTotal = $derived(problems.length)
  const checksOk = $derived(isOk(artifacts))
  /**
   * ★ 分批第 163 批（§12.41 不放假接口）：**材料能不能改**。
   *
   * daemon 那三条写接口（追加 / 删掉 / 从仓库拉）都要求"起草已跑完、且没入库"（理由：起草者
   * 开工时读的素材已经定了）。所以草案期界面上也不该挂这些按钮——按了被拒比没有按钮更糟。
   * 清单本身**照常显示**（§12.14：右栏是"它现在手上有什么"的正式清单，草案期同样要看得到）。
   */
  const materialEditable = $derived(artifacts !== null && artifacts.status === 'completed')
</script>

<!-- 窄屏的打开入口：宽屏不显示（栏本身就在网格里） -->
<button
  type="button"
  class="artifact-tab"
  aria-label={$t('crystallize.artifactOpen')}
  onclick={() => (drawerManual = true)}
>
  {$t('crystallize.artifactOpen')}
</button>

<aside class="pane detail-pane artifact-pane" data-open={drawerOpen ? 'true' : 'false'}>
  <header class="pane-head detail-head">
    <h2>{$t('crystallize.artifactTitle')}</h2>
    <div class="pane-actions">
      <!-- ★ 分批第 174 批：栏头的"第 N 版"去掉了（同上：它只是个计数，没有行为依赖） -->
      <!--
        ★ 分批第 207 批：这一行**删掉了**（原来它只在"没装沉淀用技能"时说一句）。
        技能现在真的**挂在起草者身上**，于是"装没装"有两个更该看的地方：
          · 「智能体」页起草者那一格（挂着就显示 chip，没装就显示「distilly（未安装）」）；
          · 「沉淀设置」页（一键安装，且说清现在哪一档）。
        右栏再念一遍就是第三处，而且它只在"没装"时出现（"装了就没有"本身也是噪音）。
      -->
      <button type="button" class="ghost artifact-close" onclick={() => (drawerManual = false)}>
        {$t('crystallize.artifactClose')}
      </button>
    </div>
  </header>

  <div class="pane-body artifact-body">
    {#if error !== null}
      <p class="notice bad small">{error}</p>
    {:else if loading}
      <p class="faint small">{$t('crystallize.artifactLoading')}</p>
    {:else}
      <!-- 材料：这一版起草**吃进去**的东西（轨迹 / 判决 / 使用者给的）。
           ★ 分批第 147 批：使用者给的（`appended/`）可以删——§12.14「右栏清单……删掉错的」。
             其余材料是平台从来源 run 切出来的证据，不给删除钮（daemon 那边也拒）。 -->
      <!--
        ★ 分批第 197 批：**材料那一节整块搬到了中间栏的栏脚**（`CrystallizeMaterials`，
        与聊天页「工作目录的文件」同一个控件）。使用者："材料现在在右栏，我想用类似聊天页一样，
        将工作目录放在「发送」的上方"。
        右栏因此只剩"看这一版写成了什么"——产物（编辑器）+ 体检。
      -->


      <!-- ★ 分批第 163 批（§12.14）：材料**在草案期也列**（只读），下面才是产物区（空态 / 有产出）。
           改之前整块材料还被包在"有产物"的分支里 ⇒ 起草中那一屏右栏只有一句"还没有产物"，
           而材料明明已经在磁盘上（`GET /material` 早就有数据）——那是"信息在、但看不见"。 -->
      {#if files.length === 0}
        <p class="faint artifact-empty">{$t('crystallize.artifactEmpty')}</p>
      {:else}

      <!-- ★ 分批第 155 批（§12.12 / §12.53 选项 2）：**编辑器搬进右栏**……
           等等，这里是"文件 + 只读预览"两块，它们的作用被编辑器整个替代了：
             · 文件列表 → 编辑器的文件树（`.file-row`，带变更徽标与 +n −m）；
             · 只读预览 → 编辑器的正文框（还能直接改，改完「保存改动」落盘）。
           于是这里换成编辑器本身。同一份文件不再有"预览一处、编辑一处"两个出处。 -->
      <!-- ★ 分批第 168 批：只在右栏是**真列**时渲染编辑器；窄窗口（抽屉形态）里它回到中间那条
           消息里（见 `lib/crystallize-editor.svelte.ts` 的 `paneWide`）——否则它藏在移出视口的
           抽屉里，使用者看不到草稿内容，也就没法反馈。 -->
      <!--
        ★ 分批第 196 批：**不再按宽度分叉**——中栏那条"产物消息"删了（中间只留对话），
        编辑器就只在右栏这一处。窄窗口里右栏是抽屉，由 `CrystallizeArtifactPane` 自己在
        进入审阅时**自动打开**（见下面 `autoOpenDrawer` 那段），否则草稿又变成"看得见打不开"。
      -->
      <CrystallizeDraftEditor />

      <!--
        ★ 分批第 211 批：**没交 skill 的那一轮不画体检**。

        它没有任何产出可体检，`validation.problems` 里只有一句"这一轮没有交 skill（SKILL.md
        不存在）"——把那句当"体检问题"印出来，看起来就像"它交了坏东西"。所以右栏只留一句
        中性说明，理由在**中间那条消息**里（它自己说的话）。
      -->
      {#if noOutputMode}
        <section class="artifact-checks">
          <h3 class="artifact-sub">{$t('crystallize.artifactChecks')}</h3>
          <p class="faint small">{$t('crystallize.artifactNoOutputNote')}</p>
        </section>
      {:else}
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
      {/if}
      {/if}
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









  /* 「删掉」：两步（先点它、再点「确认删掉」）——材料是使用者给的，误删不好补。
     平时几乎不可见（与列表行的删除钮同一条纪律），hover 才露出来。 */










  /* 收文件那一块（拖进来 / 选文件 / 选目录）：虚线框，拖过时高亮，让人一眼看出"这里能放" */








  /* 从仓库拉：地址框 + 按钮一行；输入框吃掉剩余宽度，按钮不换行 */






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


  .artifact-empty {
    margin: 0;
  }

  /* ══════════════ 不够宽（< 74rem）：第三列改成右侧抽屉，不占网格 ══════════════
     ⚠️ 断点必须与 `app.css` 里 `@media (min-width: 74rem)` 对齐：一个管"占不占列"，
     另一个管"长什么样"，两处不一致就会出现"网格里留了列、里面却是抽屉"的错位。 */
  @media (max-width: 73.99rem) {
    .artifact-pane {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(34rem, 92vw);
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
