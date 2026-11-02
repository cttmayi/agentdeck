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
  // ★ 分批第 155 批：编辑器（树 + 内容/差异 + 保存改动）搬进这一栏
  import CrystallizeDraftEditor from './CrystallizeDraftEditor.svelte'
  import { editor, paneWide } from '../lib/crystallize-editor.svelte.ts'

  /** `GET /api/crystallize/artifacts` 的返回（与流程页 `CrystallizeView` 同一份）。 */
  interface Artifacts {
    status: string
    /** `files` = 交了东西；`none` = 这一轮只是说了话（没交 skill，分批第 211 批）。 */
    mode: 'files' | 'none'
    files: Record<string, string>
    validation: { ok: boolean; problems: Array<{ file: string; message: string }> }
    target: { kind: string } | null
  }

  /**
   * ★ 分批第 215 批：**只留一个 prop**。
   *
   * 从前还有 `rev` 与 `onchanged`（材料被别处改过时互相通知）。分批第 197 批把材料整块搬到
   * 中间栏栏脚之后，这一栏不再显示材料 ⇒ `onchanged` 从来没被调用过（死接口），`rev` 也
   * 只剩一句 `void rev` 在 effect 里装样子。两个一起删。
   */
  let { draftRunId }: { draftRunId: string } = $props()

  /**
   * ⚠️ 这几个必须 `$state`：本组件是 **runes 模式**（用了 `$props`），普通 `let` 不是
   *    响应式的——变是变了，界面不重渲染。第一版就是漏了它，真 Chrome 里的表现是
   *    "产物请求已经 200 拿到 4 个文件，右栏永远停在『载入产物…』"，而 console 打点
   *    显示 `loaded 4`。**这类 bug 看代码完全看不出来，只有量 DOM 才发现。**
   */
  /**
   * ★ 分批第 215 批：**这一栏不再自己取产物**——它读的是共享的 `editor`（`lib/crystallize-editor.svelte.ts`）。
   *
   * 为什么必须改（使用者报的真缺陷）：「沉淀执行完毕后，产物不会立刻出来，需要重新手动刷新一次」。
   * 原来这里有一份**自己的** `artifacts`，只在 `id !== seenId`（换了一条草稿）时才重读 ⇒
   * 同一条 run 从"跑着"变成"跑完"时它**永远不会再读**：`files` 还是空的 ⇒ 整块产物区画成
   * 「还没有产物」，连编辑器都不挂（它被包在 `files.length === 0` 的 else 里）。刷新之所以能好，
   * 是因为刷新会走深链那条路重新 `open()` 一次。
   *
   * 现在数据只有一份（`editor.artifacts`）：中间那栏在**跑完**时 `loadDraftOutput()` →
   * `editor.open()` → 这里立刻跟着变。顺带把这一段里的死代码一起删掉：材料请求（材料已经搬到
   * 栏脚）、`selected`/`current`（预览被编辑器取代）、`materialEditable`、以及每次挂载都去拉一遍
   * 却没人读的 `draftSkill`。
   */
  const artifacts = $derived(editor.artifacts)

  /**
   * 谁负责 `open()`：这一栏自己兜底开一次（起草中那一屏中间那栏还没进审阅态），
   * `CrystallizeView` 在跑完/接上时也会开一次——`open()` 对同一条 run 是"重读不清现场"，重复没事。
   */
  $effect(() => {
    const id = editor.attachedRunId !== '' ? editor.attachedRunId : draftRunId
    if (id === '') return
    if (editor.runId === id) return
    void editor.open(id).catch(() => {
      // 读不到产物（还没跑完 / 接口抖）不是这一栏的错误：空态自己会说"还没有产物"
    })
  })

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
   * 派生值走**显式签名的小函数**：`$derived(artifacts === null ? [] : Object.keys(artifacts.files))`
   * 会被 tsc 窄成 `never`（runes 里那个变量被包进闭包，控制流分析拿不到别处的赋值）——
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

  const files = $derived(fileList(artifacts))
  const problems = $derived(problemList(artifacts))
  /** ★ 分批第 211 批：没交 skill ⇒ 没有"体检"可言（它没有可体检的东西）。 */
  const noOutputMode = $derived(artifacts !== null && artifacts.mode === 'none')
  const checkTotal = $derived(problems.length)
  const checksOk = $derived(isOk(artifacts))
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
    <!-- ★ 分批第 215 批：这里原来有「读取出错 / 载入中」两条分支，随这一栏自己那份
         `load()` 一起删了——数据现在来自共享的 `editor`，读不到就是"还没有产物"（空态自会说话）。 -->
    {#if true}
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
