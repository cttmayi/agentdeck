/**
 * 沉淀审阅页的**编辑器状态**（分批第 153 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么把这块状态搬出组件
 * ══════════════════════════════════════════════════════════════════
 * 设计 §12.12 定的是「右栏是唯一结构化的面」：文件 / 体检 / 版本 / 材料都在右栏。而"改草稿"这件事
 * 原来长在**中间那条产物消息**里（树 + 内容/差异 + 编辑器），于是同一份文件在两处出现（右栏只读
 * 预览、中间可改）。这一批把编辑搬进右栏（§12.53 的选项 2）。
 *
 * 搬的时候撞到一个本仓库踩过的坑：**legacy 父组件（`export let`）→ runes 子组件的 prop 更新
 * 不传播**（§12.50 坑 4，当时体现在输入条推参数上）。而 `CrystallizeView` 是 3000 行的 legacy
 * 组件，`CrystallizeArtifactPane` 是 runes 组件——两者要共享"当前选中的文件 / 编辑中的正文 /
 * 有没有未保存改动"。所以状态**不能挂在任何一个组件上**：
 *   · 挂在 view 上 ⇒ 给 pane 传 prop，runes 子收不到更新；
 *   · 挂在 pane 上 ⇒ view 的「确认入库」读不到编辑结果（而它发的正是 `files`）。
 *
 * 于是放进一个 `.svelte.ts` 模块：信号本身是跨模式的（legacy 的 `$:` 与 runes 的模板都读得动），
 * 两个组件直接读同一份状态。**只有一份 `files` 对象**——`applyEdit` 就地改它，
 * 「确认入库」把同一个对象发出去，所以不会出现"人改了字、入库的是旧内容"。
 *
 * ⚠️ 一个页面同时只有一条沉淀被打开（路由是 `#/crystallize/<runId>`），所以这里是**单例**；
 *    `open()` 换 run 时整份重置。要支持并排看两条沉淀，得改成按 runId 分桶——现在不需要。
 */
import { api } from './api.ts'

/** `GET /api/crystallize/artifacts` 的返回（与 daemon 的 `crystallize-artifacts.ts` 对齐）。 */
export interface Artifacts {
  status: string
  mode: 'files' | 'text' | 'refused' | 'agent'
  refusalReason?: string
  files: Record<string, string>
  skillMd: { name: string; description: string; body: string; raw: string }
  validation: { ok: boolean; problems: Array<{ file: string; message: string }> }
  target:
    | { kind: 'new' }
    | { kind: 'update'; skillId: string }
    | { kind: 'agent'; agentId: string }
    | null
  baseline: { slug: string; files: Record<string, string> } | null
  materialDir: string
  /** 「按意见改一版」来的草稿：上一版 run id（有它才给"对比上一版"）。 */
  revisedFrom: string | null
}

/** 变更集（`POST /api/crystallize/diff` 的返回，后端算好、这里只画）。 */
export interface DiffFile {
  rel: string
  change: 'A' | 'M' | 'D' | 'same'
  added: number
  removed: number
  hunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: Array<{
      kind: ' ' | '+' | '-'
      text: string
      oldNo: number | null
      newNo: number | null
    }>
  }>
  coarse: boolean
}

export interface DiffResult {
  against: 'current' | 'previous' | 'original'
  baselineLabel: string
  files: DiffFile[]
  totals: { added: number; removed: number; changed: number }
}

/** 文件树的一行。 */
export interface FileRow {
  rel: string
  change: '' | 'A' | 'M' | 'D'
  bytes: number
}

/**
 * 编辑器的状态与动作。
 *
 * 这里是 **runes 模块**（文件名带 `.svelte.ts`）：`$state` 的信号跨组件、跨 legacy/runes 模式
 * 都读得动，所以两个组件能共享同一份"当前编辑现场"。
 */
class DraftEditor {
  /** 这份编辑现场属于哪条草稿 run（空 = 还没有）。 */
  runId = $state('')
  /**
   * ★ 分批第 155 批：**中间那栏实际挂上的草稿 run**。
   *
   * 为什么需要它：路由里可能是**来源 run**（`#/crystallize/<来源 runId>`，从聊天/任务页点进来），
   * 而真正挂上来的是"该来源最近那条未入库的草稿"。右栏如果照路由 id 去取产物，只会拿到 404
   * （实测：从来源进来那一屏右栏空着、编辑器不出现）。中间那栏把挂上的 id 写在这儿，右栏读它。
   */
  attachedRunId = $state('')
  artifacts = $state<Artifacts | null>(null)
  /** 当前选中的文件（相对 skill/ 目录）。 */
  selectedFile = $state('SKILL.md')
  /** 编辑区内容（与 selectedFile 联动；写入即回写 artifacts.files）。 */
  editText = $state('')
  /**
   * 每次编辑 +1：让"从文件里解析出的摘要 / 树上的行数"能重算。
   * ⚠️ `artifacts.files` 是**就地改**的（普通对象），光改它不会让模板重算。
   */
  filesVersion = $state(0)
  /**
   * 有未保存的改动（分批第 8 批：人改草稿要能落盘）。
   *
   * ⚠️ 没有任何现成的信号——`files` 是就地改的。第一版打算"与磁盘上那版比 diff"来推，
   *    但 diff 是异步的（停 500ms 才算），保存按钮的状态会跟着它一跳一跳的。
   */
  dirty = $state(false)
  /** 正在保存改动（防连点：保存是写盘，连点会让"最后一次"变得不确定）。 */
  savingDraft = $state(false)
  /** 变更集 diff（后端算）。 */
  diff = $state<DiffResult | null>(null)
  diffLoading = $state(false)
  /** 当前停在哪条基线：原 skill / 上一版草稿 / 当前已入库版本（分批第 18 批起三条）。 */
  diffAgainst = $state<'current' | 'previous' | 'original'>('current')
  /** 主区窗格的分段：内容 / 差异（同一位置切换）。 */
  reviewTab = $state<'content' | 'diff'>('content')

  /**
   * 改 SKILL.md 时让 slug 跟着 frontmatter 的 name 走。
   *
   * 为什么用**回调**而不是把 slug 也搬进这里：slug 的归属是"入库"（`confirm-with-slug`），
   * 只在结论条上用，而且"新建才允许改"的规则在 view 那边。这里只负责**报告**"名字变了"。
   */
  onSlugName: (name: string) => void = () => {}

  /** 编辑 → diff 的防抖计时器（每敲一个字发一次请求是不可接受的）。 */
  #diffTimer: ReturnType<typeof setTimeout> | null = null

  /** 文件树的行 = 文件清单 + **变更徽标**（跟着 `diff` 走，不另算一套）。 */
  get fileRows(): FileRow[] {
    void this.filesVersion
    const a = this.artifacts
    if (a === null) return []
    const byteLen = (text: string): number => new TextEncoder().encode(text).length
    if (this.diff !== null) {
      // 文本兜底草稿不认"删除"（服务端入库时会合并保留），与下面的基线分支同一口径
      const rows = this.diff.files.filter((f) => a.mode === 'files' || f.change !== 'D')
      return rows.map((f) => ({
        rel: f.rel,
        change: (f.change === 'same' ? '' : f.change) as '' | 'A' | 'M' | 'D',
        bytes: a.files[f.rel] === undefined ? 0 : byteLen(a.files[f.rel] as string),
      }))
    }
    const base = a.baseline?.files ?? null
    const rows = Object.keys(a.files)
      .sort((x, y) => (x === 'SKILL.md' ? -1 : y === 'SKILL.md' ? 1 : x < y ? -1 : 1))
      .map((rel) => {
        const text = a.files[rel] ?? ''
        const old = base?.[rel]
        const change: '' | 'A' | 'M' = old === undefined ? 'A' : old === text ? '' : 'M'
        return { rel, change, bytes: byteLen(text) }
      })
    // 草稿里没有、当前版本里有的 → 删除（更新 = 整目录替换，必须看得见）。
    // ⚠️ **只有多文件产出（files）才这么算**：文本兜底草稿本来就没抓到支持文件，
    //    入库时服务端会把当前的保留下来（不是"决定了要删"）。这里若也标 D，等于
    //    对着一条没能力写文件的草稿吓唬使用者"要删 3 个文件"。
    if (a.mode !== 'files') return rows
    const deleted = Object.keys(base ?? {})
      .filter((rel) => a.files[rel] === undefined)
      .sort()
      .map((rel) => ({ rel, change: 'D' as const, bytes: 0 }))
    return [...rows, ...deleted]
  }

  get fileCount(): number {
    return this.artifacts === null ? 0 : Object.keys(this.artifacts.files).length
  }

  get totalBytes(): number {
    return this.fileRows.reduce((sum, r) => sum + r.bytes, 0)
  }

  /** 当前选中文件在变更集里的那一项（没有就是"没变/无基线"）。 */
  get selectedDiff(): DiffFile | null {
    if (this.diff === null) return null
    return this.diff.files.find((f) => f.rel === this.selectedFile) ?? null
  }

  /** 文件树上的 +n −m 从 diff 来（与详情面板同一份数字，不会两处对不上）。 */
  get diffByRel(): Map<string, DiffFile> {
    return new Map((this.diff?.files ?? []).map((f) => [f.rel, f]))
  }

  /** 换一条沉淀 / 离开审阅态：整份清空（旧 run 的现场绝不能留到新的上）。 */
  reset(): void {
    this.runId = ''
    this.artifacts = null
    this.selectedFile = 'SKILL.md'
    this.editText = ''
    this.filesVersion += 1
    this.dirty = false
    this.diff = null
    this.diffAgainst = 'current'
    this.reviewTab = 'content'
    if (this.#diffTimer !== null) {
      clearTimeout(this.#diffTimer)
      this.#diffTimer = null
    }
  }

  /**
   * 读这条草稿的产出（`GET /api/crystallize/artifacts`）。
   *
   * 读写不到就**抛**（调用方 catch 之后决定"还在起草中 / 出错"）。**目标与 slug 的处理留在
   * 调用方**：目标来自落库的 `crystallizeTarget`，界面上的 `targetKind` 要跟着它走。
   */
  async open(runId: string): Promise<Artifacts> {
    /**
     * ⚠️ **同一条 run 重新读时不要先 `reset()`**：`reset()` 会把 `artifacts` 置空，而界面在这
     * 一瞬会画出"○ …"（结论条空）与"没有编辑器"——探针在真 Chrome 里量到过：轮询/终态都
     * 会再调一次 `loadDraftOutput`，于是那一下整块编辑器消失（`paneTopY` 读到 null）。
     * 旧代码是"直接赋值、不清空"，这里保持同样的观感：换 run 才整份清，同一条只是重读。
     */
    if (this.runId !== runId) this.reset()
    this.runId = runId
    const res = await api<Artifacts>(
      `/api/crystallize/artifacts?draftRunId=${encodeURIComponent(runId)}`,
    )
    this.artifacts = res
    // 改版草稿默认对比"原 skill"（使用者定稿："skill 差异对比也应该是原 skill 变化"）；
    // 否则对比当前已入库版本。'previous' 只回答"我这轮反馈改了什么"，不是他判断新版本时要问的。
    this.diffAgainst = res.revisedFrom !== null ? 'original' : 'current'
    const first = this.defaultFile(res)
    this.selectedFile = first
    this.editText = res.files[first] ?? ''
    this.filesVersion += 1
    // 刚读到的就是磁盘上的那一份 ⇒ 没有未保存的改动（换版/重读之后必须清，
    // 否则「保存改动」会挂着上一版留下的状态，点下去写的是同一份内容）
    this.dirty = false
    void this.loadDiff(this.diffAgainst)
    return res
  }

  /** 只重读「机械体检」那一份（保存改动之后用：不能重置编辑现场）。 */
  async refreshValidation(): Promise<void> {
    if (this.runId === '') return
    try {
      this.artifacts = await api<Artifacts>(
        `/api/crystallize/artifacts?draftRunId=${encodeURIComponent(this.runId)}`,
      )
    } catch {
      // 读不到就保留上一次的体检结果（下次进入这一屏会重读）；不把失败画成"通过"
    }
  }

  /** 默认选中 SKILL.md；没有就选第一个文件（起草者写歪时也别给空白页）。 */
  defaultFile(res: Artifacts): string {
    if (res.files['SKILL.md'] !== undefined) return 'SKILL.md'
    const first = Object.keys(res.files).sort()[0]
    return first ?? ''
  }

  /** 切换选中文件：把编辑区内容换过去（当前文件的编辑已经回写进 files）。 */
  selectFile(rel: string): void {
    // 点文件 = 想看内容；留在「差异」标签会让人以为点错了
    this.reviewTab = 'content'
    this.selectedFile = rel
    this.editText = this.artifacts?.files[rel] ?? ''
  }

  /** 编辑回写：入库传的就是这份 files（服务端还会再校验一遍）。 */
  applyEdit(text: string): void {
    this.editText = text
    if (this.artifacts === null || this.selectedFile === '') return
    this.artifacts.files[this.selectedFile] = text
    this.filesVersion += 1
    this.dirty = true
    // diff 跟着内容走，但**不要每敲一个字发一次请求**：停下来 500ms 再算
    if (this.#diffTimer !== null) clearTimeout(this.#diffTimer)
    this.#diffTimer = setTimeout(() => {
      this.#diffTimer = null
      void this.loadDiff()
    }, 500)
    // 改的就是 SKILL.md → slug 跟着 frontmatter 的 name 走（"新建才允许改"由调用方判）
    if (this.selectedFile === 'SKILL.md') {
      const name = parseFrontmatterName(text)
      if (name !== '') this.onSlugName(name)
    }
  }

  /**
   * 拉变更集 diff（后端算，`text-diff.ts`）。
   *
   * 传的是**当前编辑后的文件**：使用者在审阅里改了一行，diff 就得反映改完的样子，
   * 而不是磁盘上的原稿。
   */
  async loadDiff(against: 'current' | 'previous' | 'original' = this.diffAgainst): Promise<void> {
    if (this.artifacts === null) return
    this.diffAgainst = against
    this.diffLoading = true
    try {
      this.diff = await api<DiffResult>('/api/crystallize/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftRunId: this.runId,
          files: this.artifacts.files,
          against,
        }),
      })
    } catch {
      // diff 是辅助信息，拉不到不挡入库（校验与文件本身才是硬门槛）
      this.diff = null
    } finally {
      this.diffLoading = false
    }
  }

  /**
   * 保存改动：把**编辑后的整份文件**写回草稿小屋（分批第 8 批）。
   *
   * 为什么要这一步（使用者原话：「缺少一个可以改的地方」）：编辑器一直都在，但改动只活在内存里，
   * 而"入库"读的是磁盘 ⇒ 改完直接入库，入库的是磁盘那一版，没人知道这两件事已经不是一个东西。
   *
   * 返回写盘是否成功（调用方据此给回执）。失败时抛出的错误由调用方处理。
   */
  async saveEdits(): Promise<boolean> {
    if (this.artifacts === null || this.runId === '' || this.savingDraft) return false
    this.savingDraft = true
    try {
      await api('/api/crystallize/save-draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftRunId: this.runId, files: this.artifacts.files }),
      })
      this.dirty = false
      // 保存之后重读一次产出（**只**为了刷新"机械体检"：人改完往往就是修体检问题）
      void this.refreshValidation()
      void this.loadDiff()
      return true
    } finally {
      this.savingDraft = false
    }
  }
}

/** 极简 frontmatter 取 name（只用于"改 SKILL.md 时 slug 跟着变"）。 */
export function parseFrontmatterName(text: string): string {
  const m = text.match(/^name\s*:\s*(.+)$/m)
  return m?.[1] ? m[1].trim().replace(/^["']|["']$/g, '') : ''
}

/**
 * ★ 分批第 168 批（回归修复）：**右栏是不是"真列"**（≥ 74rem）。
 *
 * 为什么要在这里判断：编辑器（§12.53 选项 2）搬进右栏之后，窄于 74rem 的窗口里右栏是
 * **从右侧滑出的抽屉**（`translateX(100%)`，看不见）⇒ 窄窗口下使用者根本够不着编辑器，
 * 表现就是"看不到 skill 的细节、也没法反馈"。所以窄的时候它回到**中间那条消息里**：
 * 状态只有一份（就在这个模块里），换的是"渲染在哪一栏"，不是两份编辑器。
 *
 * ⚠️ 断点必须与 `app.css` 的 `@media (min-width: 74rem)` 和右栏自己的
 * `@media (max-width: 73.99rem)` 对齐——三处不一致就会出现"右栏画成抽屉、编辑器却还在里面"。
 */
export const PANE_COLUMN_MEDIA = '(min-width: 74rem)'
export const paneWide = $state({
  value: typeof window === 'undefined' ? true : window.matchMedia(PANE_COLUMN_MEDIA).matches,
})
if (typeof window !== 'undefined') {
  const mq = window.matchMedia(PANE_COLUMN_MEDIA)
  mq.addEventListener('change', (event) => {
    paneWide.value = event.matches
  })
}

/**
 * 单例。理由见文件头：一个页面只有一条沉淀被打开；`open()` 会整份重置。
 * 想并排看两条，改成 `Map<runId, DraftEditor>` —— 现在没有这个用法。
 */
export const editor = new DraftEditor()
