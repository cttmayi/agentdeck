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
    mode: 'files' | 'text' | 'refused' | 'agent'
    refusalReason?: string
    files: Record<string, string>
    validation: { ok: boolean; problems: Array<{ file: string; message: string }> }
    target: { kind: string } | null
  }

  let {
    draftRunId,
    version = 1,
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
    version?: number
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
  let drawerOpen = $state(false)
  /** 已经点了「删掉」、等第二次确认的那份材料（两步删除：材料是使用者给的，误删不好补）。 */
  let pendingDelete = $state('')
  /** 正在删的那份（防止连点两次发两个请求）。 */
  let deleting = $state('')
  /** 删完之后的回执（说清删了什么、还剩几份；右栏本来就是"它现在手上有什么"）。 */
  let deleteNote = $state('')
  /**
   * ★ 分批第 173 批（使用者定："技能走注入，但**不要默认放项目中**，让用户自己装、建议一键安装"）：
   * 这一栏负责"这条沉淀用什么技能"——没装就给一键安装，装了就把 id 交给起草请求。
   */
  let skillInstalling = $state(false)

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

  /**
   * 一键安装：走既有的 `POST /api/skills/install`（来源是上游仓库，**平台不 vendored**）。
   * 装完立刻回读一次——按钮要变成"已装好"，否则人不知道到底成没成。
   */
  async function installDraftSkill(): Promise<void> {
    if (skillInstalling) return
    skillInstalling = true
    draftSkill.error = ''
    try {
      await api('/api/skills/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: DISTILLY_SOURCE }),
      })
      await loadDraftSkill()
    } catch (err) {
      draftSkill.error = String(err instanceof Error ? err.message : err)
    } finally {
      skillInstalling = false
    }
  }

  $effect(() => {
    void loadDraftSkill()
  })

  /** 正在追加文件时不为空（防止一边拖一批、一边按两次按钮）。 */
  let adding = $state(false)
  /** 拖拽文件悬停在本区上（给一点反馈：这一块收文件）。 */
  let dragOver = $state(false)
  /** 追加文件（拖进来 / 选进来）的回执。 */
  let addNote = $state('')
  /** 「从仓库拉」的地址输入与进行中标记（§12.54）。 */
  let repoUrl = $state('')
  let repoPulling = $state(false)
  /** 两个 `<input type=file>`：一个选文件、一个选整个目录（`webkitdirectory`）。 */
  let fileInput = $state<HTMLInputElement | null>(null)
  let dirInput = $state<HTMLInputElement | null>(null)

  /**
   * 能被当成"素材"的扩展名。判据是"这文件能不能读成文本"——素材最终是要给起草者**读**的，
   * 二进制（图片/压缩包/PDF）塞进去它读到的只会是乱码，比"不接收"更坏。
   */
  const TEXT_EXT =
    /\.(md|markdown|txt|text|rst|json|ya?ml|csv|tsv|log|ts|tsx|js|mjs|cjs|py|sh|rb|go|rs|java|kt|c|h|cpp|html?|css|scss|toml|ini|cfg|conf|env|sql)$/i

  /** 与 daemon 的 `MATERIAL_MAX_BYTES` 一致：单份上限 100 KiB（更大的塞进去也读不出来）。 */
  const MATERIAL_MAX_BYTES = 100 * 1024
  /** 一次最多收几份：拖一个目录进来可能是几百个文件，逐个 POST 会把 daemon 刷爆。 */
  const MATERIAL_MAX_FILES = 20

  /**
   * ★ 分批第 148 批（§12.4 材料卡：追加的形态有"拖文件 / 粘贴 / 选目录 / 仓库"）：
   * **拖文件 / 选目录**——浏览器读成文本，走已有的 `POST /api/crystallize/material`。
   *
   * 为什么不新开一个上传接口：
   *   · daemon 那边已经有一份**落盘 + 登记索引**的通道（§12.47），再开一个等于同一件事两处写，
   *     迟早两边不一致（本仓库最防的就是这个）；
   *   · 更重要：素材是**文本**（起草者用工具读）。二进制走 multipart 上传，daemon 还得决定
   *     存哪、怎么读——而读不出来，等于给素材里塞垃圾。
   *   · 「选目录」用 `<input webkitdirectory>` 在浏览器侧展开文件列表 ⇒ daemon 不需要接受
   *     任意本地路径（那是把"读你机器上任意文件"变成一个 HTTP 入参）。
   *
   * ⚠️ 逐份 POST 而不是一次打包：daemon 的校验是**单份**的（空/超大/重名），打包发送会把
   *    "第 3 份太大"变成"整批失败"，而前面两份本来是可以进去的。
   */
  async function addFiles(files: FileList | File[] | null): Promise<void> {
    if (adding) return
    const list = files === null ? [] : [...files].filter((f) => f.size > 0)
    if (list.length === 0) return
    adding = true
    addNote = ''
    deleteNote = ''
    let added = 0
    const skipped: string[] = []
    for (const file of list.slice(0, MATERIAL_MAX_FILES)) {
      const looksText = file.type.startsWith('text/') || TEXT_EXT.test(file.name)
      if (!looksText) {
        skipped.push(`${file.name}（不是文本）`)
        continue
      }
      if (file.size > MATERIAL_MAX_BYTES) {
        skipped.push(`${file.name}（${Math.round(file.size / 1024)} KB 超过上限 100 KB）`)
        continue
      }
      let body = ''
      try {
        body = await file.text()
      } catch {
        skipped.push(`${file.name}（读不出来）`)
        continue
      }
      if (body.trim() === '') {
        skipped.push(`${file.name}（空的）`)
        continue
      }
      try {
        await api('/api/crystallize/material', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // 名字原样交过去：daemon 会剥掉路径、折掉不安全字符、重名自动加 -2
          body: JSON.stringify({ draftRunId, name: file.name, text: body }),
        })
        added += 1
      } catch (err) {
        skipped.push(`${file.name}（${String(err instanceof Error ? err.message : err)}）`)
      }
    }
    if (list.length > MATERIAL_MAX_FILES) {
      skipped.push(`还有 ${list.length - MATERIAL_MAX_FILES} 份没处理（一次最多 ${MATERIAL_MAX_FILES} 份）`)
    }
    adding = false
    addNote =
      (added > 0 ? $t('crystallize.materialAddDone', { n: String(added) }) : '') +
      (skipped.length > 0
        ? `${added > 0 ? '；' : ''}${$t('crystallize.materialAddSkipped', { items: skipped.join('、') })}`
        : '')
    if (added > 0) {
      await reloadMaterial(draftRunId)
      // 另一处（中间那栏的「依据」）也重读：材料的两个显示处必须同源（§12.14）
      onchanged()
    }
  }

  /**
   * ★ 分批第 157 批（§12.54）：**从 GitHub 仓库拉一批文本当素材**。
   *
   * 为什么只有这一个入口形态（一个地址框）：仓库地址没有别的给法——而"选本地仓库目录"
   * 等于让 daemon 接受任意本地路径（§12.51 已经否决过那条）。daemon 那边的边界写在
   * `apps/daemon/src/crystallize-repo.ts` 的文件头：主机白名单 / 体量封顶 / 只收文本。
   */
  async function pullRepo(): Promise<void> {
    const url = repoUrl.trim()
    if (url === '' || repoPulling) return
    repoPulling = true
    addNote = ''
    deleteNote = ''
    try {
      const res = await api<{
        relDir: string
        files: number
        bytes: number
        skipped: string[]
        hasSkillMd: boolean
      }>('/api/crystallize/material/repo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId, url }),
      })
      repoUrl = ''
      addNote =
        $t('crystallize.materialRepoDone', {
          files: String(res.files),
          kb: String(Math.max(1, Math.round(res.bytes / 1024))),
          dir: res.relDir,
        }) +
        (res.skipped.length > 0
          ? `；${$t('crystallize.materialAddSkipped', { items: res.skipped.slice(0, 3).join('、') })}`
          : '') +
        // 仓库里带 SKILL.md：**必须**说一句——"更新那个技能"与"只当素材"是两条完全不同的路
        (res.hasSkillMd ? ` ⚠️ ${$t('crystallize.materialRepoHasSkill')}` : '')
      await reloadMaterial(draftRunId)
      onchanged()
    } catch (err) {
      addNote = String(err instanceof Error ? err.message : err)
    } finally {
      repoPulling = false
    }
  }

  /** `<input type=file>` 的 change：读完就把 value 清空，否则再选同一个文件不触发 change。 */
  function onPicked(event: Event): void {
    const input = event.currentTarget as HTMLInputElement | null
    void addFiles(input?.files ?? null).finally(() => {
      if (input) input.value = ''
    })
  }

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
    // 读 `rev` 是**故意的**：材料在中间那栏被追加 / 在这一栏被删掉时，两边都要重读
    //（§12.14：两处必须由同一份数据现算）。
    void rev
    // ★ 分批第 155 批：用**中间那栏实际挂上的草稿**（路由可能是来源 run，见 store 里
    //   `attachedRunId` 的注释）；中间那栏还没挂上时退回路由 id。
    void editor.attachedRunId
    const id = editor.attachedRunId !== '' ? editor.attachedRunId : draftRunId
    if (id !== seenId) {
      // 换了一条沉淀：产物与材料一起重拉
      seenId = id
      void load(id)
      return
    }
    // 同一条沉淀、只是材料变了：**只重读材料**。走 `load` 会把 `loading` 置真 ⇒ 整栏闪成
      // 「载入产物…」、材料清单与刚出的回执一起消失（删一份材料闪一下，很难看也很像出错）。
    void reloadMaterial(id)
  })

  /** 同一条沉淀的材料重读（不动 `loading` / 产物：材料变了不等于产物变了）。 */
  async function reloadMaterial(id: string): Promise<void> {
    if (id === '') return
    try {
      material = await api<Material>(`/api/crystallize/material?draftRunId=${encodeURIComponent(id)}`)
    } catch {
      material = null
    }
  }

  /**
   * ★ 分批第 147 批（§12.14「删掉错的」）：删掉一份**使用者给的**材料。
   *
   * 为什么只有 `appended/` 有按钮：其余材料是平台从来源 run 切出来的证据（轨迹 / 判决 /
   * 索引页 / `meta.json`），删了"依据"就和来源对不上，而且下次起草会重新切回来。界面不给
   * "按了会被拒"的按钮（§12.41 不放假接口），daemon 那边也照样拦（两道各自成立）。
   *
   * 删完必须重读：右栏清单是"它现在手上有什么"的唯一显示，不刷新等于"删了但还看得见"。
   */
  async function removeMaterial(relPath: string): Promise<void> {
    if (deleting !== '') return
    deleting = relPath
    try {
      const res = await api<{ relPath: string; remaining: number }>(
        `/api/crystallize/material?draftRunId=${encodeURIComponent(draftRunId)}` +
          `&relPath=${encodeURIComponent(relPath)}`,
        { method: 'DELETE' },
      )
      pendingDelete = ''
      deleteNote = $t('crystallize.materialDeleteDone', {
        path: res.relPath,
        n: String(res.remaining),
      })
      await reloadMaterial(draftRunId)
      onchanged()
    } catch (err) {
      deleteNote = String(err instanceof Error ? err.message : err)
    } finally {
      deleting = ''
    }
  }

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
  onclick={() => (drawerOpen = true)}
>
  {$t('crystallize.artifactOpen')}
</button>

<aside class="pane detail-pane artifact-pane" data-open={drawerOpen ? 'true' : 'false'}>
  <header class="pane-head detail-head">
    <h2>{$t('crystallize.artifactTitle')}</h2>
    <div class="pane-actions">
      {#if version > 1}<span class="faint small">{$t('crystallize.artifactVersion', { n: String(version) })}</span>{/if}
      <!-- ★ 分批第 173 批：沉淀用技能（可选）挂在栏头——它不该占正文的竖向空间
           （右栏的高度是编辑器的：多 40px 就把编辑器推出首屏，探针会红）。 -->
      <span class="artifact-skill" data-draft-skill title={$t('crystallize.draftSkillHint')}>
        {#if draftSkill.id !== ''}
          <span class="faint small">{$t('crystallize.draftSkillInstalled', { name: draftSkill.name || draftSkill.slug })}</span>
        {:else}
          <button
            type="button"
            class="ghost small"
            disabled={skillInstalling}
            onclick={() => void installDraftSkill()}
          >{skillInstalling ? '…' : $t('crystallize.draftSkillInstall')}</button>
        {/if}
      </span>
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
    {:else}
      <!-- 材料：这一版起草**吃进去**的东西（轨迹 / 判决 / 使用者给的）。
           ★ 分批第 147 批：使用者给的（`appended/`）可以删——§12.14「右栏清单……删掉错的」。
             其余材料是平台从来源 run 切出来的证据，不给删除钮（daemon 那边也拒）。 -->
      <section class="artifact-mats">
        <h3 class="artifact-sub" title={$t('crystallize.materialDeleteOnly')}>
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
                {#if item.relPath.startsWith('appended/')}
                  {#if pendingDelete === item.relPath}
                    <button
                      type="button"
                      class="mat-del confirm"
                      disabled={deleting !== ''}
                      onclick={() => void removeMaterial(item.relPath)}
                    >{$t('crystallize.materialDeleteConfirm')}</button>
                  {:else}
                    <button
                      type="button"
                      class="mat-del"
                      disabled={deleting !== ''}
                      onclick={() => (pendingDelete = item.relPath)}
                    >{$t('crystallize.materialDelete')}</button>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
          {#if deleteNote !== ''}
            <p class="faint small artifact-mat-note">{deleteNote}</p>
          {/if}
        {/if}
        <!-- ★ 分批第 148 批（§12.4 材料卡：追加形态"拖文件 / 选目录"）：收文件的就是这一块。
             只收**文本**（素材最终要给起草者读，二进制进去只会是乱码），单份 ≤ 100 KiB。 -->
        {#if materialEditable}
          <div
            class="mat-add"
            class:drag={dragOver}
          data-mat-dropzone="true"
          role="group"
          ondragover={(e) => {
            e.preventDefault()
            dragOver = true
          }}
          ondragleave={() => (dragOver = false)}
          ondrop={(e) => {
            e.preventDefault()
            dragOver = false
            void addFiles(e.dataTransfer?.files ?? null)
          }}
        >
          <p class="faint small">{$t('crystallize.materialDropHint')}</p>
          <div class="mat-add-actions">
            <button
              type="button"
              class="ghost small"
              disabled={adding}
              onclick={() => fileInput?.click()}>{$t('crystallize.materialAddFiles')}</button
            >
            <button
              type="button"
              class="ghost small"
              disabled={adding}
              onclick={() => dirInput?.click()}>{$t('crystallize.materialAddDir')}</button
            >
          </div>
          <!-- ★ 分批第 157 批（§12.54）：从仓库拉。地址交给 daemon，它按白名单 + 体量上限去拉，
               拉下来的文本落进 `material/appended/<owner>-<repo>/` 并登记进索引。 -->
          <form
            class="mat-repo"
            onsubmit={(e) => {
              e.preventDefault()
              void pullRepo()
            }}
          >
            <input
              type="text"
              bind:value={repoUrl}
              placeholder={$t('crystallize.materialRepoPlaceholder')}
              aria-label={$t('crystallize.materialRepoPlaceholder')}
            />
            <button
              type="submit"
              class="ghost small"
              disabled={repoPulling || repoUrl.trim() === ''}
            >{$t('crystallize.materialRepoPull')}</button>
          </form>
          <!-- 两个隐藏的 file input：选文件 / 选目录（`webkitdirectory` 在浏览器侧展开目录，
               daemon 不需要接受任意本地路径——那等于把"读你机器上任意文件"做成一个入参）。 -->
          <input
            class="mat-file-input"
            type="file"
            multiple
            hidden
            bind:this={fileInput}
            onchange={onPicked}
          />
          <input
            class="mat-dir-input"
            type="file"
            multiple
            webkitdirectory
            hidden
            bind:this={dirInput}
            onchange={onPicked}
          />
          {#if addNote !== ''}
            <p class="faint small artifact-mat-note" data-mat-add-note>{addNote}</p>
          {/if}
          </div>
        {:else}
          <!-- 草案期：清单能看、不能改（daemon 会拒"没跑完就改材料"）；说清为什么，别给死按钮 -->
          <p class="faint small">{$t('crystallize.materialLockedUntilDone')}</p>
        {/if}
      </section>

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
      {#if paneWide.value}
        <CrystallizeDraftEditor />
      {/if}

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

  /* 「删掉」：两步（先点它、再点「确认删掉」）——材料是使用者给的，误删不好补。
     平时几乎不可见（与列表行的删除钮同一条纪律），hover 才露出来。 */
  .mat-del {
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-faint);
    font-size: var(--fs-xs);
    padding: 0 0.25rem;
    border-radius: var(--radius);
    opacity: 0.55;
  }

  .artifact-mat-list li:hover .mat-del {
    opacity: 1;
  }

  .mat-del:hover {
    color: var(--bad);
    border-color: var(--line-strong);
  }

  .mat-del.confirm {
    opacity: 1;
    color: var(--bad);
    border-color: var(--bad);
  }

  .artifact-mat-note {
    margin: var(--sp-1) 0 0;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }

  /* 收文件那一块（拖进来 / 选文件 / 选目录）：虚线框，拖过时高亮，让人一眼看出"这里能放" */
  .mat-add {
    margin-top: var(--sp-2);
    border: 1px dashed var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .mat-add.drag {
    border-color: var(--accent);
    background: var(--surface-2);
  }

  .mat-add p {
    margin: 0;
  }

  .mat-add-actions {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-1);
  }

  /* 从仓库拉：地址框 + 按钮一行；输入框吃掉剩余宽度，按钮不换行 */
  .mat-repo {
    display: flex;
    gap: var(--sp-1);
    margin-top: var(--sp-2);
  }

  .mat-repo input {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-sm);
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
