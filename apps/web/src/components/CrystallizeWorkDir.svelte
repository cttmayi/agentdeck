<script lang="ts">
  /**
   * 沉淀页栏脚的「工作目录的文件」——**起草这一轮的工作目录**（`material/` + `skill/`）。
   *
   * ★ 分批第 199 批（使用者定）：「就是叫「工作目录的文件」，就是整个挂上去，包括 material
   *   和 skill」。所以这一栏与聊天页那一栏是**同一件事、同一个组件、同一个标题**：
   *   根目录 = 这条沉淀的任务目录（`skill/` 是产出、`material/` 是依据、`.agentdeck/` 是平台状态）。
   *   右栏的编辑器仍然负责"打开来改/对比"——两处不冲突：一个答"目录里有什么"，
   *   一个答"这一版写成什么"。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么从右栏搬到中间栏的栏脚
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者：「材料现在在右栏，我想用类似聊天页一样，将工作目录放在「发送」的上方。可展开显示。
   * 关于「发送」一起，用相同的控件，不然不一致」。
   *
   * 这个诉求是对的，而且和聊天页的心智**完全一致**：聊天页的栏脚上方就是「工作目录的文件」
   * （这一轮它手上有什么），沉淀页的「材料」是同一件事。两处现在共用 `@agentdeck/ui` 的
   * `FootFiles`（折叠头）与 `ChatComposer`（输入条），所以长得一样、行为也一样（Enter 发送）。
   *
   * 右栏因此只剩「产物 + 体检」——那才是"看这一版写成了什么"的地方；
   * 材料属于"我给了它什么"，是对话的一部分。
   *
   * ⚠️ 逻辑是**原地搬过来的**（`addFiles` / `pullRepo` / `removeMaterial` / 两步删除 /
   * 拖拽收文件 / 从仓库拉），一个字没改语义：`POST/DELETE /api/crystallize/material` 与
   * `/material/repo` 的边界、单份 100 KiB、一次最多 20 份、只收文本，全部照旧。
   * 只改了两件事：**宿主**（右栏 → 栏脚）与**形状**（抽屉式分节 → 折叠清单，与聊天页同款）。
   */
  import { FootFiles } from '@agentdeck/ui/components'
  // ★ 分批第 198 批：材料改为**与聊天页同一棵树**（`WorkDirTree`：按层展开、点开看文件）。
  //   使用者："中栏 发送框上面不是呈现的类似聊天页工作目录，而是素材罗列"。
  import WorkDirTree from './WorkDirTree.svelte'
  import { t } from '../lib/i18n.ts'
  import { api } from '../lib/api.ts'

  let {
    draftRunId,
    /** 起草跑完了才能改材料（daemon 会拒"没跑完就改"——界面上也就不给按了会被拒的按钮）。 */
    editable = false,
    /** 材料变了（追加/删除）：让另一处（起草态的依据、右栏）也重读。 */
    onchanged = () => {},
    /**
     * ★ 分批第 197 批：**别处改了材料**的信号（栏脚那条输入条的「追加材料：…」、右栏的删除）。
     *
     * 不接它的话，"追加成功"与"清单里没有它"会同时成立——探针当场量到：
     * `appendMaterial` 报 `serverCount: 1`，而清单里还是那 3 份自动带的。
     * （上一版这条通道是给右栏材料清单用的 `rev`，材料搬过来之后它也跟着搬。）
     */
    rev = 0,
  }: {
    draftRunId: string
    editable?: boolean
    statsPart?: string
    onchanged?: () => void
    rev?: number
  } = $props()

  /**
   * 折叠开关。⚠️ 必须是一个**状态变量**：`bind:open` 不写目标时会绑到**全局同名属性**上
   * （`window.open`——svelte-check 当场报 "Can only bind to state or props"）。
   */
  let open = $state(true)
  /** 树的顶层条数（`bind:count`）——折叠头上那个「N 项」以它为准（与树同源）。 */
  let topCount = $state(0)
  /** 增删之后让树重取（`reloadKey` 变了就重列）。 */
  let reloadTick = $state(0)
  /** 正在追加时不为空（防止一边拖一批、一边按两次按钮）。 */
  let adding = $state(false)
  /** 拖拽文件悬停（给一点反馈：这一块收文件）。 */
  let dragOver = $state(false)
  /** 追加文件（拖进来 / 选进来）的回执。 */
  let addNote = $state('')
  /** 「从仓库拉」的地址输入与进行中标记（§12.54）。 */
  let repoUrl = $state('')
  let repoPulling = $state(false)
  /** 已经点了「删掉」、等第二次确认的那份（两步删除：材料是使用者给的，误删不好补）。 */
  let pendingDelete = $state('')
  let deleting = $state('')
  let deleteNote = $state('')
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
      reloadTick += 1
      onchanged()
    }
  }

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
      reloadTick += 1
      onchanged()
    } catch (err) {
      addNote = String(err instanceof Error ? err.message : err)
    } finally {
      repoPulling = false
    }
  }

  function onPicked(event: Event): void {
    const input = event.currentTarget as HTMLInputElement | null
    void addFiles(input?.files ?? null).finally(() => {
      if (input) input.value = ''
    })
  }

  async function removeMaterial(treePath: string): Promise<void> {
    if (deleting !== '') return
    deleting = treePath
    /**
     * ★ 分批第 199 批：树挂的是**整个任务目录**（`material/appended/x.md`），而删除接口
     * 要的是相对 `material/` 的路径（`appended/x.md`）⇒ 在这里剥掉那一段前缀。
     */
    const relPath = treePath.replace(/^material\//, '')
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
      reloadTick += 1
      onchanged()
    } catch (err) {
      deleteNote = String(err instanceof Error ? err.message : err)
    } finally {
      deleting = ''
    }
  }
</script>

<FootFiles
  title={$t('files.heading')}
  count={topCount === 0 ? '' : $t('crystallize.materialCountOnly', { n: String(topCount) })}
  bind:open={open}
>
  {#snippet actions()}
    {#if editable}
      <button type="button" class="ghost small" disabled={adding} onclick={() => fileInput?.click()}>
        {$t('crystallize.materialAddFiles')}
      </button>
      <button type="button" class="ghost small" disabled={adding} onclick={() => dirInput?.click()}>
        {$t('crystallize.materialAddDir')}
      </button>
    {/if}
  {/snippet}

  <!--
    ★ 分批第 198 批：清单换成**与聊天页同一个树**（`WorkDirTree`）。
    它自带"一次列一层 / 点文件就地打开查看器 / 取不到时说明原因"，所以这里不再自己画行。
      唯一多出来的是**删除钮**（只给 `material/appended/` 那几份）——通过 `rowAction` 长在那一行上。
  -->
  <WorkDirTree
    base={`/api/crystallize/drafts/${encodeURIComponent(draftRunId)}`}
    reloadKey={`${draftRunId}:${rev}:${reloadTick}`}
    bind:count={topCount}
  >
    {#snippet rowAction({ entry })}
      {#if entry.path.startsWith('material/appended/')}
        {#if pendingDelete === entry.path}
          <button
            type="button"
            class="ghost small mat-del confirm"
            disabled={deleting !== ''}
            onclick={() => void removeMaterial(entry.path)}
          >{$t('crystallize.materialDeleteConfirm')}</button>
        {:else}
          <button
            type="button"
            class="ghost small mat-del"
            disabled={deleting !== ''}
            onclick={() => (pendingDelete = entry.path)}
          >{$t('crystallize.materialDelete')}</button>
        {/if}
      {/if}
    {/snippet}
  </WorkDirTree>
  {#if deleteNote !== ''}
    <p class="faint small" data-mat-note>{deleteNote}</p>
  {/if}

  {#if editable}
    <!-- 追加形态（§12.4 材料卡）：**拖文件 / 选目录 / 从仓库拉**。三者都走
         `POST /api/crystallize/material`（文本落盘 + 登记索引），不新开上传接口。 -->
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
        <button type="submit" class="ghost small" disabled={repoPulling || repoUrl.trim() === ''}
          >{$t('crystallize.materialRepoPull')}</button
        >
      </form>
      <!-- 两个隐藏的 file input：选文件 / 选目录（`webkitdirectory` 在浏览器侧展开目录，
           daemon 不需要接受任意本地路径——那等于把"读你机器上任意文件"做成一个入参）。 -->
      <input class="mat-file-input" type="file" multiple hidden bind:this={fileInput} onchange={onPicked} />
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
        <p class="faint small mat-note" data-mat-add-note>{addNote}</p>
      {/if}
    </div>
  {:else}
    <!-- 草案期：清单能看、不能改（daemon 会拒"没跑完就改材料"）；说清为什么，别给死按钮 -->
    <p class="faint small">{$t('crystallize.materialLockedUntilDone')}</p>
  {/if}
</FootFiles>

<style>



  .mat-del {
    opacity: 0.6;
  }
  .mat-del:hover {
    opacity: 1;
  }
  .mat-del.confirm {
    opacity: 1;
    color: var(--danger, #b42318);
  }
  .mat-add {
    margin-top: var(--sp-2);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .mat-add.drag {
    border-color: var(--accent);
    background: var(--surface-2);
  }
  .mat-repo {
    display: flex;
    gap: var(--sp-1);
  }
  .mat-repo input {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-sm);
  }
  .mat-note {
    margin: 0;
  }
</style>
