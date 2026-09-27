import type { TextCatalog } from '../text.ts'

/**
 * 错误文案：**库层**（`lib/api.ts`、`lib/remote.ts`、`lib/remote-store.ts`、
 * `lib/sync.ts`、`main.ts`）自己造出来、又会显示给使用者的那些话。
 *
 * ⚠️ 为什么这些不放组件那一份词表里：它们不产生于任何组件——`api()` 抛的
 *    `ApiError`、reducer 挂在 store 上的 `error` 字段，都可能被好几个界面
 *    拿去显示。文案留在组件里，库层就只能拼中文，切换语言时那些话不动。
 *
 * ⚠️ 与组件里的词条不同，这些是**取词那一刻的快照**（库层没有响应式上下文，
 *    取词时就把话定下来）。于是"报错时是中文，之后切到英文"不会重译已经产生
 *    的那句话——这是刻意的：报错是"当时发生了什么"的记录，跟着语言变会让
 *    人以为错误本身变了（同 `locale.ts` 顶部"历史文本不重译"那条）。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：真实浏览器探针就按这些原文断言
 *    （它们是"出错时屏幕上那句话"，探针按文字找它们）。
 *    ⚠️ "与迁移之前逐字一致"**不再是判据**（2026-09 的文案改写把面向使用者的那批
 *    文字按"这句话是给谁看的"重写了一遍）。这一份**恰好没被那一轮改到**——不是
 *    因为规则要求冻结，而是因为它们本来就是写给使用者的。
 */
export const errorsText = {
  'err.busy': {
    zh: '本机并发已满，请稍后重试。',
    en: 'The local concurrency limit is full. Please try again later.',
  },
  'err.daemonUnreachable': {
    zh: '连不上本机 daemon。请确认它已经启动（pnpm run daemon）。',
    en: 'Cannot reach the local daemon. Please make sure it is running (pnpm run daemon).',
  },
  /** 拼在 `err.daemonUnreachable` 后面。英文侧开头的空格是给上一句留下的。 */
  'err.daemonUnreachableReason': {
    zh: '（原因：{reason}）',
    en: ' (reason: {reason})',
  },
  'err.remoteUnreachable': {
    zh: '连不上远端服务（{base}）。请确认它已经启动：pnpm run remote',
    en: 'Cannot reach the remote service ({base}). Please make sure it is running: pnpm run remote',
  },
  'err.sessionExpired': {
    zh: '登录已失效，请重新登录',
    en: 'Your sign-in has expired. Please sign in again.',
  },
  'err.reportFailed': {
    zh: '上报失败（已本地暂存 {count} 条，下轮补交）：{reason}',
    en: 'Reporting failed ({count} record(s) buffered locally, will retry next round): {reason}',
  },
  'err.fetchPendingFailed': {
    zh: '拉取待处理项失败：{reason}',
    en: 'Failed to fetch pending items: {reason}',
  },
  'err.mountPointMissing': {
    zh: '找不到 #app 挂载点——index.html 被改坏了',
    en: 'Cannot find the #app mount point — index.html has been broken',
  },
  /**
   * 一轮同步里**两条**错误拼成一句时用的分隔符。
   *
   * ⚠️ 它也得进词表：中文用全角分号，英文句子之间用半角分号加空格——把 `；`
   *    写死在 `sync.ts` 里，英文界面上就会冒出一个全角标点。
   */
  'err.messageSeparator': {
    zh: '；',
    en: '; ',
  },
} as const satisfies TextCatalog
