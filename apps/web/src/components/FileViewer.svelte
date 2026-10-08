<script lang="ts">
  /**
   * 文件查看器：一份文件能看两面的浮层。
   *
   * ══════════════════════════════════════════════════════════════════
   * 「渲染」只许加标记，「原文」一个字都不许动
   * ══════════════════════════════════════════════════════════════════
   *
   * 这一栏里的文件是 **agent 写的**，而使用者要靠它判断"到底做成了什么"。
   * 所以这个查看器必须能回答一个很具体的问题：**我现在看到的，是不是磁盘上那个
   * 文件？** 于是「原文」的定义是死板的：服务端 `/file` 发回来的那串字节，按
   * UTF-8 解出来的文本——不格式化、不重排、不加行号、不加颜色。唯一动过的一层是
   * 浏览器必须转义 `< > &`（否则文件里一个 `</textarea>` 就能把页面搞坏）。
   *
   * 判断（分类、默认哪一面、要不要着色、语言映射）全在 `lib/file-view.ts` 里，
   * 由 `file-view.test.ts` 钉住——`apps/web` 没有组件级测试，写在这里的判断只能
   * 靠手点界面验证，而"Markdown 被当纯文本显示"这种错**不报错**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 音视频：**一个字节都不自己下载**，URL 直接交给播放器
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者报的是「展示页面目前不支持视频文件显示」，而根因有两层（服务端
   * 把 `.mp4` 认成 octet-stream；这条路由又把整份文件读进内存）。修法见
   * `workdir-files.ts` 顶上第三段。**这里**那一层的要点是：
   *
   * 查看器**不许**去 `fetch` 一段视频——那会把几百 MB 拉进页面内存（`fetch`
   * 拿的是完整 body，`<video>` 才会按 Range 去取）。所以取字节还是交 URL 给
   * 播放器，由 `lib/file-view.ts` 的 `previewMode` 按后缀分流（那里的注释写了
   * 为什么这条判断只能按后缀）。
   *
   * ⚠️ 「原文」面对音视频**不存在**（`hasFace`）：把几百 MB 拉回来 hex dump
   *    前 512 字节是荒谬的。要看字节请用右侧的「在新标签页打开」。
   *    ⚠️ 而"画不画那对切换按钮"必须**按后缀当场算**（`shownKind`），不能等
   *    `load()` 赋的 `kind`——那会晚一拍，实测症状是"视频能放，标题栏上却还挂着
   *    「渲染 | 原文」"（布局探针抓到的）。
   *
   * ══════════════════════════════════════════════════════════════════
   * HTML 那一面沿用文件响应自己的 CSP，不放宽
   * ══════════════════════════════════════════════════════════════════
   *
   * `iframe sandbox="allow-scripts"`，**没有** `allow-same-origin`：脚本能跑、
   * 页面能画出来（那次任务的产出是一个 p5.js 画布页，禁脚本时点开是一片空白），
   * 但它落在不透明源里，读不到 daemon 的任何接口。这与"在新标签页打开"是**同一
   * 套属性**——就地看只是省一次跳转，安全边界一个字不动。
   */
  import { Modal } from '@agentdeck/ui/components'
  import { t } from '../lib/i18n.ts'
  import { renderMarkdown } from '../lib/markdown.ts'
  import { humanSize } from '../lib/workdir-view.ts'
  import {
    CSV_MAX_COLS,
    HEX_PEEK_BYTES,
    fileKindOf,
    defaultFace,
    fileUrl,
    hasFace,
    mediaFailureReason,
    mediaKindOf,
    previewMode,
    hexDump,
    languageOf,
    parseCsv,
    refineKind,
    rawFaceIsHex,
    shouldHighlight,
    splitPath,
    type FileFace,
    type FileKind,
  } from '../lib/file-view.ts'
  import type { WorkDirFile } from '../lib/api.ts'

  /** 接口前缀：`/api/runs/<id>` 或 `/api/conversations/<id>`。 */
  export let base: string
  /** 要看的那个文件；`null` = 关着。 */
  export let entry: WorkDirFile | null = null
  export let onclose: () => void = () => {}

  let loading = false
  let error = ''
  /** 原始字节——二进制那一面要用它（十六进制）。 */
  let raw = new Uint8Array()
  let bytes = 0
  let text = ''
  let contentType = ''
  let kind: FileKind = 'text'
  /** 后缀当场能看出来的那一类（音视频）；其余是 `null`。见下面 `shownKind` 的注释。 */
  let mediaKind: 'video' | 'audio' | null = null
  /** 渲染时真正该用的类别：媒体看后缀，其余看 `load()` 取回来的结论。 */
  let shownKind: FileKind = 'text'
  let face: FileFace = 'rendered'
  /** 高亮之后的 HTML（空串 = 这一面没有高亮）。 */
  let highlighted = ''
  /** 没高亮时给一句解释（太大 / 认不出语言）——不解释的话使用者只会以为坏了。 */
  let noHighlight: '' | 'tooBig' | 'unknownLanguage' = ''
  let jsonBroken = false
  let copied = ''
  /**
   * 播放器报错了吗。
   *
   * ⚠️ 要有这个：`.mkv` / `.avi` 这类容器 Chrome 放不了，而"黑框里什么都没有"
   *    看起来像**我们**坏了。所以放不出来时如实说一句"这个容器/编码浏览器放不了，
   *    可以到新标签页或磁盘上打开"。
   */
  let mediaFailed = false
  /**
   * 放不出来时**是谁的事**（决定说哪一句话）。
   *
   * ⚠️ 两种失败长得一模一样（一口黑框 + 播放器 error），但处置完全不同：daemon 还是
   *    旧的那份 ⇒ "重启 daemon 之后就能放"；接口是对的而浏览器不认这个容器/编码 ⇒
   *    "不是文件坏了，去新标签页或磁盘上看"。判据在 `mediaFailureReason`（纯函数、有
   *    测试）。⚠️ 探测只在**已经失败之后**才发：正常播放那条路上一次多余的请求都没有。
   */
  let mediaReason: 'unsupportedByDaemon' | 'unsupportedByBrowser' = 'unsupportedByBrowser'

  $: parts = entry === null ? { dir: '', name: '' } : splitPath(entry.path)
  /**
   * 这一份文件**按哪一类渲染**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 音视频按**后缀当场**定，不押在 `kind` 上（探针抓过一次）
   * ══════════════════════════════════════════════════════════════════
   *
   * `kind` 是在 `load()` 里赋的，而 `load()` 对普通文件是**异步的**（要 `await
   * fetch`）。把"要画哪些按钮、画哪个分支"押在它上面，就会出现"这一轮渲染用着
   * 上一份文件的类别"的时间差——实测到的症状是：一段视频**放出来了**（分支对了），
   * 而标题栏上**还挂着「渲染 | 原文」那对按钮**（那是上一份代码文件的类别算出来的）。
   * 使用者看到的是"这段视频居然能切回原文"，点进去只会得到一屏十六进制。
   *
   * 后缀**同步可得**（`mediaKindOf`），所以用它做渲染判据就没有这个时间差；
   * 其余类别的判据必须等字节回来（`.md` 与 `.txt` 在服务端都是 `text/plain`），
   * 那些照旧用 `kind`。
   */
  $: mediaKind = entry === null ? null : mediaKindOf(entry.path)
  $: shownKind = mediaKind ?? kind
  $: canRendered = entry !== null && hasFace(shownKind, 'rendered')
  $: canRaw = entry !== null && hasFace(shownKind, 'raw')
  $: sizeText = bytes === 0 ? '' : humanSize(bytes)
  /** 已经为哪个路径取过——`entry` 变了就重取。 */
  let loadedPath: string | null = null
  $: if (entry !== null && entry.path !== loadedPath) void load(entry)

  /** 关掉浮层时把上一份内容清掉——不然下次打开会先闪一下上一个文件。 */
  $: if (entry === null && loadedPath !== null) {
    loadedPath = null
    text = ''
    raw = new Uint8Array()
    bytes = 0
    highlighted = ''
    error = ''
  }

  async function load(target: WorkDirFile): Promise<void> {
    loadedPath = target.path
    loading = true
    error = ''
    bytes = 0
    text = ''
    highlighted = ''
    noHighlight = ''
    jsonBroken = false
    copied = ''
    mediaFailed = false
    mediaReason = 'unsupportedByBrowser'

    // ── 音视频：不下载，URL 交给播放器（见文件顶上那一段）──
    //
    // 类型由**后缀**定（`mediaKindOf`），因为这正是 `previewMode` 分流的依据，
    // 两者必须一致；真实类型仍在服务端给的 content-type 里，而播放器自己会去读它。
    // 大小直接用目录列表里的那个数——不必为了显示"多大"去下载整份文件。
    const media = mediaKindOf(target.path)
    if (previewMode(target.path) === 'stream' && media !== null) {
      kind = media
      contentType = ''
      text = ''
      raw = new Uint8Array()
      bytes = target.sizeBytes
      face = 'rendered'
      loading = false
      return
    }

    try {
      const res = await fetch(fileUrl(base, target))
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}${(await res.text().catch(() => '')).slice(0, 200)}`)
      }
      const buf = new Uint8Array(await res.arrayBuffer())
      raw = buf
      bytes = buf.length
      contentType = res.headers.get('content-type') ?? ''
      kind = fileKindOf(contentType, target.path)
      text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
      // 扩展名会说谎：解出来带 NUL 就说明它其实是二进制——但**只对文本类问**
      // 这个问题（image / pdf 是服务端的明确表态，PNG 解出来必然带 NUL）。
      // 见 file-view.ts 的 `refineKind`。
      kind = refineKind(kind, text)
      face = defaultFace(kind)
      await prepare(kind, target.path)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  /** 算出「渲染」面要用的东西：高亮、JSON 能不能解析。 */
  async function prepare(k: FileKind, path: string): Promise<void> {
    if (k === 'code') {
      const lang = languageOf(path)
      if (lang === null) {
        noHighlight = 'unknownLanguage'
        return
      }
      if (!shouldHighlight(k, bytes)) {
        noHighlight = 'tooBig'
        return
      }
      const html = await highlight(text, lang)
      if (html === null) noHighlight = 'unknownLanguage'
      else highlighted = html
      return
    }
    if (k === 'json') {
      try {
        JSON.parse(text)
        highlighted = await highlight(JSON.stringify(JSON.parse(text), null, 2), 'json').then(
          (h) => h ?? '',
        )
      } catch {
        // 解析不了就按原文显示，并说出来——不假装它是合法 JSON
        jsonBroken = true
      }
    }
  }

  /**
   * 播放器报错之后，问一次"接口那一层对不对"。
   *
   * `Range: bytes=0-0` 在支持它的 daemon 上只回 1 个字节（206），而老 daemon 会回
   * 200 + **整份文件**——所以拿到响应头就立刻把 body 掐掉，别真的下下来。
   */
  async function diagnoseMedia(target: WorkDirFile): Promise<void> {
    try {
      const res = await fetch(fileUrl(base, target), { headers: { Range: 'bytes=0-0' } })
      const probe = {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
      }
      await res.body?.cancel().catch(() => {})
      mediaReason = mediaFailureReason(probe)
    } catch {
      // 探测本身失败：保持默认那句（"浏览器放不了"）——它不会把人引到错的方向
      mediaReason = 'unsupportedByBrowser'
    }
  }

  /** 播放器 error ⇒ 记下来，并问一次是谁的事。 */
  function onMediaError(target: WorkDirFile): void {
    mediaFailed = true
    void diagnoseMedia(target)
  }

  // ── highlight.js：按需注册 + 动态 import（不进主包）──
  //
  // ⚠️ 只注册用得上的十种语言：全量包几百 KB，而这一栏要看的基本就是这几类。
  // ⚠️ 认不出来的后缀**不着色**（`languageOf` 返回 null）：硬塞给 highlightAuto
  //    会挑一个"最像"的语法，于是界面用一套**错的**配色讲一件看起来很权威的事。
  const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
    python: () => import('highlight.js/lib/languages/python'),
    javascript: () => import('highlight.js/lib/languages/javascript'),
    typescript: () => import('highlight.js/lib/languages/typescript'),
    json: () => import('highlight.js/lib/languages/json'),
    bash: () => import('highlight.js/lib/languages/bash'),
    yaml: () => import('highlight.js/lib/languages/yaml'),
    xml: () => import('highlight.js/lib/languages/xml'),
    css: () => import('highlight.js/lib/languages/css'),
    markdown: () => import('highlight.js/lib/languages/markdown'),
    plaintext: () => import('highlight.js/lib/languages/plaintext'),
  }
  let core: { registerLanguage: (n: string, l: unknown) => void; highlight: (c: string, o: unknown) => { value: string } } | null = null
  const registered = new Set<string>()

  async function highlight(code: string, lang: string): Promise<string | null> {
    try {
      if (core === null) {
        const mod = (await import('highlight.js/lib/core')) as unknown as {
          default: typeof core
        }
        core = mod.default
      }
      if (core === null) return null
      if (!registered.has(lang)) {
        const load = LOADERS[lang]
        if (!load) return null
        const mod = (await load()) as { default: unknown }
        core.registerLanguage(lang, mod.default)
        registered.add(lang)
      }
      return core.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }

  // ── Markdown 里的相对图片 ──
  //
  // 相对路径按**这个文件所在的目录**解析（不是按工作目录）：一份放在 `notes/`
  // 里的 Markdown 写 `![](img/a.png)`，指的是 `notes/img/a.png`。
  function resolveAsset(href: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) {
      return href
    }
    const dir = parts.dir
    const target = dir === '' ? href : `${dir}${href}`
    return `${base}/file?path=${encodeURIComponent(target)}`
  }

  $: jsonView =
    kind === 'json' && !jsonBroken
      ? JSON.stringify(JSON.parse(text) as unknown, null, 2)
      : text
  $: csvView = kind === 'csv' ? parseCsv(text) : { rows: [] as string[][], truncated: false }
  $: renderedMarkdown =
    kind === 'markdown' && face === 'rendered'
      ? renderMarkdown(text, { resolveAsset })
      : ''

  async function copyRaw(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      copied = $t('files.copied')
    } catch {
      copied = $t('files.copyFailed')
    }
    setTimeout(() => (copied = ''), 2500)
  }
</script>

<!--
  ⚠️ 用 `wide`（74rem）：这一面要装 80 列以上的代码、表格、以及一个能被浏览器
     画出来的 HTML 页面——42rem 那一档会把这些都挤成需要横向滚动的东西。
-->
<Modal
  open={entry !== null}
  size="wide"
  ariaLabel={entry?.name ?? ''}
  {onclose}
  title={parts.name}
  closeLabel={$t('common.close')}
>
  {#if entry !== null}
    <div class="fv-bar">
      <span class="fv-path mono faint small" title={entry.path}>
        {#if parts.dir !== ''}<span class="fv-dir">{parts.dir}</span>{/if}{parts.name}
      </span>
      {#if sizeText !== ''}
        <span class="faint small" data-file-bytes>{sizeText}</span>
      {/if}
      <span class="fv-spacer"></span>
      <!--
        两面切换。只有一种面时不画按钮（二进制没有渲染面、PDF 没有可读的原文面）
        ——画一个点了没反应的按钮，比不画更坏。图片两面都有：SVG 的「原文」是
        源码，位图的「原文」是十六进制（见 file-view.ts 的 hasFace / rawFaceIsHex）。
      -->
      {#if canRendered && canRaw}
        <span class="fv-toggle" role="group">
          <button
            type="button"
            class:active={face === 'rendered'}
            aria-pressed={face === 'rendered'}
            onclick={() => (face = 'rendered')}
            data-face-rendered
          >{$t('files.faceRendered')}</button>
          <button
            type="button"
            class:active={face === 'raw'}
            aria-pressed={face === 'raw'}
            onclick={() => (face = 'raw')}
            data-face-raw
          >{$t('files.faceRaw')}</button>
        </span>
      {/if}
      <!--
        ⚠️ 「复制原文」只在**真有原文**时才画（`raw` 非空）。音视频那一档一个字节都
           没下载（见文件顶上那一段）⇒ 画出来点一下只会复制到一个空串，那比不画更坏。
      -->
      {#if raw.length > 0}
        <button type="button" class="ghost" onclick={() => void copyRaw()} data-copy-raw>
          {copied === '' ? $t('files.copyRaw') : copied}
        </button>
      {/if}
      <a class="ghost" href={fileUrl(base, entry)} target="_blank" rel="noreferrer noopener">
        {$t('files.openTab')}
      </a>
    </div>

    {#if error !== ''}
      <div class="notice bad">
        {$t('files.viewError')}
        <p class="faint small" style="margin:var(--sp-2) 0 0">{error}</p>
      </div>
    {:else if loading}
      <div class="skeleton" style="width:80%"></div>
    {:else if face === 'raw' && rawFaceIsHex(kind, entry.path)}
      <!--
        原文面是十六进制：二进制文件，以及位图（.png/.jpg/…）——按字节看没有
        可读文本，hex 就是对得上号的证据。SVG 不进来（它的原文是源码文本）。
      -->
      <div class="fv-note faint small">
        {kind === 'image'
          ? $t('files.imageRawNotice', { type: contentType === '' ? '?' : contentType })
          : $t('files.binaryNotice', { type: contentType === '' ? '?' : contentType })}
      </div>
      <pre class="fv-pre fv-hex" data-hex>{hexDump(raw)}</pre>
      <p class="faint small">{$t('files.hexPeek', { bytes: String(HEX_PEEK_BYTES) })}</p>
    {:else if face === 'raw'}
      <!--
        原文：解出来的文本原样显示。不加行号、不着色、不重排——这一面存在的
        全部意义就是"没有任何平台加工"。
      -->
      <pre class="fv-pre" data-raw-text>{text}</pre>
    {:else if kind === 'markdown'}
      <article class="fv-md markdown">{@html renderedMarkdown}</article>
    {:else if kind === 'html' || kind === 'pdf'}
      <!--
        ★ sandbox="allow-scripts"、**没有** allow-same-origin：与"在新标签页
          打开"完全同一套属性（理由见文件顶上的注释与 workdir-files.ts）。
      -->
      <iframe
        class="fv-frame"
        title={parts.name}
        sandbox="allow-scripts"
        src={fileUrl(base, entry)}
        data-file-frame
      ></iframe>
    {:else if shownKind === 'video'}
      <!--
        音视频：`src` 直接指那条路由，浏览器自己按 Range 取（daemon 支持 206）。
        `preload="metadata"`：先只拿头部拿到时长/尺寸，别一打开就下整段。
        `playsinline`：手机上不要一按就全屏抢走整个页面。
      -->
      <div class="fv-media">
        <!--
          ⚠️ a11y lint 要求 `<video>` 带 `<track kind="captions">`。这里**不能**加：
              那是 agent 产出的一段视频，我们手里没有任何字幕轨——塞一个空 track
              只是把 lint 骗过去，对使用者毫无用处（a11y 规则要的是"别让聋人用户
              以为有字幕"，这里本来就一个都没有，正确的做法是别假装）。
              名字用 `title` 给（它就是这个文件的路径，和标题栏那一行一致）。
        -->
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="fv-video"
          controls
          playsinline
          preload="metadata"
          title={parts.name}
          src={fileUrl(base, entry)}
          data-file-video
          onerror={() => onMediaError(entry)}
        ></video>
        {#if mediaFailed}
          <p class="faint small" data-media-failed>
            {mediaReason === 'unsupportedByDaemon'
              ? $t('files.mediaNeedsDaemonRestart')
              : $t('files.mediaUnsupported')}
          </p>
        {/if}
      </div>
    {:else if shownKind === 'audio'}
      <div class="fv-media">
        <audio
          class="fv-audio"
          controls
          preload="metadata"
          src={fileUrl(base, entry)}
          data-file-audio
          onerror={() => onMediaError(entry)}
        ></audio>
        {#if mediaFailed}
          <p class="faint small" data-media-failed>
            {mediaReason === 'unsupportedByDaemon'
              ? $t('files.mediaNeedsDaemonRestart')
              : $t('files.mediaUnsupported')}
          </p>
        {/if}
      </div>
    {:else if kind === 'image'}
      <div class="fv-image">
        <img src={fileUrl(base, entry)} alt={parts.name} data-file-image />
      </div>
    {:else if kind === 'json'}
      {#if jsonBroken}
        <div class="fv-note faint small">{$t('files.jsonBroken')}</div>
      {/if}
      {#if highlighted !== ''}
        <pre class="fv-pre">{@html highlighted}</pre>
      {:else}
        <pre class="fv-pre" data-json-text>{jsonView}</pre>
      {/if}
    {:else if kind === 'csv'}
      <div class="fv-table-wrap">
        <table class="fv-table" data-csv-table>
          <tbody>
            {#each csvView.rows as row, i (i)}
              <tr>
                {#each row as cell, j (j)}
                  {#if i === 0}
                    <th>{cell}</th>
                  {:else}
                    <td>{cell}</td>
                  {/if}
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if csvView.truncated}
        <p class="faint small">{$t('files.csvTruncated', { cols: String(CSV_MAX_COLS) })}</p>
      {/if}
    {:else}
      <!-- 代码与纯文本 -->
      {#if highlighted !== ''}
        <div class="fv-code">
          <pre class="fv-gutter" aria-hidden="true">{Array.from(
              { length: text.split('\n').length },
              (_, i) => i + 1,
            ).join('\n')}</pre>
          <pre class="fv-pre fv-code-body">{@html highlighted}</pre>
        </div>
      {:else}
        {#if noHighlight !== ''}
          <div class="fv-note faint small">
            {noHighlight === 'tooBig'
              ? $t('files.noHighlightTooBig', { bytes: sizeText })
              : $t('files.noHighlightUnknown')}
          </div>
        {/if}
        <pre class="fv-pre" data-plain-text>{text}</pre>
      {/if}
    {/if}
  {/if}
</Modal>

<style>
  .fv-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-bottom: var(--sp-3);
    padding-bottom: var(--sp-2);
    border-bottom: 1px solid var(--line);
  }

  .fv-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 46%;
  }

  .fv-dir {
    color: var(--text-faint);
  }

  .fv-spacer {
    flex: 1;
  }

  .fv-toggle {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .fv-toggle button {
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: var(--sp-1) var(--sp-3);
    color: var(--text-dim);
    cursor: pointer;
    font: inherit;
  }

  .fv-toggle button.active {
    background: var(--bg);
    color: var(--text);
  }

  .fv-pre {
    margin: 0;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-3);
    overflow: auto;
    max-height: 62vh;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.55;
    white-space: pre;
    tab-size: 2;
  }

  /* 行号栏：单独一列，不去改高亮后的 HTML（按行切 HTML 会把标签切坏） */
  .fv-code {
    display: flex;
    gap: var(--sp-2);
    align-items: flex-start;
  }

  .fv-gutter {
    margin: 0;
    padding: var(--sp-3) 0;
    overflow: hidden;
    max-height: 62vh;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.55;
    text-align: right;
    user-select: none;
  }

  .fv-code-body {
    flex: 1;
    min-width: 0;
  }

  .fv-frame {
    width: 100%;
    height: 62vh;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: #fff;
  }

  .fv-image {
    display: flex;
    justify-content: center;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-3);
  }

  .fv-image img {
    max-width: 100%;
    max-height: 62vh;
    object-fit: contain;
  }

  /**
   * 播放器：黑底、居中、别超出浮层。
   * ⚠️ `width: 100%` + `max-height` 一起给，否则一个竖屏视频（手机拍的）会把
   *    浮层撑到看不清控制条。
   */
  .fv-media {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    background: #000;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2);
  }

  /* 音频没有画面，黑底那一大块就没有意义——它只需要一根控制条 */
  .fv-media:has(.fv-audio) {
    background: var(--bg);
  }

  .fv-video {
    width: 100%;
    max-height: 62vh;
    display: block;
  }

  .fv-audio {
    width: 100%;
  }

  .fv-media .faint {
    margin: 0;
    color: #ddd;
  }

  .fv-note {
    margin-bottom: var(--sp-2);
  }

  .fv-table-wrap {
    overflow: auto;
    max-height: 62vh;
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }

  .fv-table {
    border-collapse: collapse;
    font-size: var(--fs-xs);
    font-family: var(--font-mono);
  }

  .fv-table th,
  .fv-table td {
    border-bottom: 1px solid var(--line);
    border-right: 1px solid var(--line);
    padding: var(--sp-1) var(--sp-2);
    text-align: left;
    white-space: pre;
    max-width: 24rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fv-table th {
    position: sticky;
    top: 0;
    background: var(--panel);
    color: var(--text-dim);
  }

  /*
    highlight.js 的配色：**不引它自带主题**，用这个仓库已有的色板拼一套。
    自带主题是给浅色/深色通用场景写的，直接引进来会与这一页的 token 打架，
    而且多一份几十 KB 的 CSS。语法类别就这么几档，够用。
    ⚠️ 那几档颜色走 `--hl-*` 主题令牌：暗色是霓虹（这里原来的写死值），
    亮色是墨色——写死的霓虹色在亮底上淡得读不出。
  */
  .fv-pre :global(.hljs-comment),
  .fv-pre :global(.hljs-quote) {
    color: var(--text-faint);
    font-style: italic;
  }

  .fv-pre :global(.hljs-keyword),
  .fv-pre :global(.hljs-selector-tag),
  .fv-pre :global(.hljs-literal),
  .fv-pre :global(.hljs-type) {
    color: var(--hl-keyword);
  }

  .fv-pre :global(.hljs-string),
  .fv-pre :global(.hljs-attr),
  .fv-pre :global(.hljs-regexp) {
    color: var(--hl-string);
  }

  .fv-pre :global(.hljs-number),
  .fv-pre :global(.hljs-built_in),
  .fv-pre :global(.hljs-symbol) {
    color: var(--hl-number);
  }

  .fv-pre :global(.hljs-title),
  .fv-pre :global(.hljs-name),
  .fv-pre :global(.hljs-section),
  .fv-pre :global(.hljs-function .hljs-title) {
    color: var(--hl-title);
  }

  .fv-pre :global(.hljs-variable),
  .fv-pre :global(.hljs-template-variable),
  .fv-pre :global(.hljs-params) {
    color: var(--text);
  }
</style>
