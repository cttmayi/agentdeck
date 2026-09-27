/**
 * 「工作目录的文件」那一栏（`components/WorkDirTree.svelte`）。
 *
 * ⚠️ 单独一份、不并进 `tasks.ts`：那个组件现在**两个地方在用**——任务详情右边
 *    那一栏（跑完之后的产出）与聊天的右栏底部。词表按**代码结构**分文件，
 *    而它的调用点已经不止一个区域了；并进 tasks 里的话，改聊天那边的文案时
 *    得去 `tasks.ts` 里找，正是这份结构想避免的事。
 */
export const filesText = {
  'files.heading': { zh: '工作目录的文件', en: 'Files in the work directory' },
  'files.error': { zh: '取不到工作目录的文件', en: 'Could not read the work directory' },
  'files.errorHint': {
    zh: '（如果本机的 daemon 刚更新过，重启它再试——新功能要重启才生效）',
    en: '(If the local daemon was just updated, restart it — new features need a restart)',
  },
  'files.empty': { zh: '这个目录还是空的。', en: 'This directory is still empty.' },
  /**
   * ★ 与 `files.empty` **不是同一件事**：目录**还不存在**（对话刚建、第一轮还没
   *   跑起来），而不是"存在但里面什么都没有"。
   *
   *   两者长得一样（都是空列表），把一个说成另一个就是在替使用者编一个他没看到
   *   的事实——而这两句话给出的下一步完全不同（"再等等"和"它确实没产出"）。
   */
  'files.notCreated': {
    zh: '这个目录还不存在——它第一轮才会进去干活。',
    en: 'This directory does not exist yet — it is created when the first turn runs.',
  },
  'files.reading': { zh: '正在读…', en: 'Reading…' },
  'files.truncated': {
    zh: '（列到上限了，还有更多——请直接在磁盘上看）',
    en: '(Hit the listing limit — there is more; look on disk)',
  },
  /**
   * ── 查看器（`components/FileViewer.svelte`）──
   *
   * 「渲染」与「原文」这对词是**承诺**，不是样式名：原文 = 服务端发回来的那串
   * 字节按 UTF-8 解出来的文本，平台一个字都不加工（见 `lib/file-view.ts`）。
   */
  'files.faceRendered': { zh: '渲染', en: 'Rendered' },
  'files.faceRaw': { zh: '原文', en: 'Raw' },
  'files.copyRaw': { zh: '复制原文', en: 'Copy raw' },
  'files.copied': { zh: '已复制', en: 'Copied' },
  'files.copyFailed': { zh: '复制不了（浏览器不给）', en: 'Could not copy' },
  'files.openTab': { zh: '新标签页打开', en: 'Open in new tab' },
  'files.viewError': { zh: '取不到这个文件', en: 'Could not read this file' },
  'files.binaryNotice': {
    zh: '这不是文本（{type}），所以没有「渲染」这一面。',
    en: 'This is not text ({type}), so there is no Rendered face.',
  },
  'files.imageRawNotice': {
    zh: '这是位图（{type}），「原文」按字节显示成十六进制；渲染面（图）在另一边。',
    en: 'This is a bitmap ({type}); the Raw face shows the bytes as hex — the image is on the Rendered face.',
  },
  'files.hexPeek': {
    zh: '下面是前 {bytes} 字节的十六进制。',
    en: 'Below is the hex of the first {bytes} bytes.',
  },
  'files.jsonBroken': {
    zh: '这份 JSON 解析不了，按原文显示——不替它猜一个结构出来。',
    en: 'This JSON does not parse, so it is shown raw rather than guessing a structure.',
  },
  'files.csvTruncated': {
    zh: '超出行列上限，只显示前 {cols} 列。',
    en: 'Over the row/column limit — showing the first {cols} columns.',
  },
  'files.noHighlightTooBig': {
    zh: '文件太大（{bytes}），不做语法着色——原文照旧完整显示。',
    en: 'Too large to highlight ({bytes}) — the raw text is still complete.',
  },
  'files.noHighlightUnknown': {
    zh: '认不出这是什么语言，不做语法着色（宁可不着色，也不给它配一套错的）。',
    en: 'Unrecognised language, so no highlighting — better none than a wrong one.',
  },
}
