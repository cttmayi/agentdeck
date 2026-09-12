import type { LoadedPlugin } from './plugins.ts'
import type { PluginStore } from './plugin-store.ts'

/**
 * 待处理项的拉取（FR-REG-06 / FR-REG-07 / FR-REG-11）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是"远端按需查"而不是"远端存队列"
 * ══════════════════════════════════════════════════════════════════
 *
 * 需求 FR-BRIDGE-02 的原话是"页面从远端取走属于本机的排队 run"——那是
 * **D19 之前**的架构，当时 Web UI 在远端，run 队列也就在远端。
 *
 * D19 把 Web UI 改成由 daemon 在本机托管之后，**本机 run 的编排已经全在本地**：
 * 页面直接调 `POST /api/runs`，没有任何理由绕远端一圈。照字面再建一个远端
 * run 队列，等于把同一件事在两处各做一遍——两份真相，迟早不一致。
 *
 * 但这条需求**指向的东西依然存在**：有"从外部来、要交给本机处理"的东西，
 * 那就是第三方报告。所以这里保住了它的架构意图（**页面是唯一的通道，
 * 把外部的东西搬回本机**），换掉了那个已经过时的载体。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬约束
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 绝不暂存**（FR-REG-07）。每次询问都**真的去打第三方**，答完即弃。
 *    这与命令式缓存无关——"顺手存一下"在这里是破坏需求的。
 *
 * **② 一个第三方坏了不能拖垮整次轮询**（FR-REG-11）。
 *    失败的跳过并给出警告，其余照常返回。轮询是**周期性**动作，
 *    一次失败不该让下一轮也不跑。
 *
 * **③ 必须有超时。** 第三方是外部的，可能永远不回话。没有超时的话，
 *    页面的轮询会挂在一个不返回的请求上——**后续轮询全部阻塞**，
 *    而那正是 FR-REG-11 明确要防的。
 */

/** 第三方插件应当返回的一条报告。形状与 `POST /api/reports` 的 items 对齐。 */
export interface PendingItem {
  externalId: string
  kind: string
  title: string
  body: string
  meta?: Record<string, unknown>
}

export interface PendingResult {
  items: PendingItem[]
  /** 出问题的第三方插件及原因——**必须返回给调用方**，不能只写日志。 */
  warnings: Array<{ plugin: string; reason: string }>
  /** 本次询问真的打到了哪些插件（用于印证"不暂存"）。 */
  queried: string[]
}

export interface CollectPendingOptions {
  plugins: readonly LoadedPlugin[]
  store: PluginStore
  /** 账号身份——**账号即凭证**（D12），不另设第三方凭据。 */
  account: { id: string; email: string; displayName: string }
  /** 单个第三方的超时（毫秒）。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/** 插件实现体的形状。 */
interface ThirdPartyImpl {
  query?: (params: {
    account: { id: string; email: string; displayName: string }
    config: Record<string, unknown>
    /** 进程内取密钥。**绝不经过 HTTP 响应**（FR-PLUGIN-11）。 */
    secret: (key: string) => string | null
  }) => Promise<{ items?: unknown } | unknown[]>
}

/**
 * 逐个询问第三方，汇总成待处理项。
 *
 * **不做任何缓存**：每调用一次就真的打一次第三方。
 */
export async function collectPending(
  options: CollectPendingOptions,
): Promise<PendingResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const warnings: PendingResult['warnings'] = []
  const items: PendingItem[] = []
  const queried: string[] = []

  for (const plugin of options.plugins) {
    const name = plugin.manifest.name
    const impl = plugin.impl as ThirdPartyImpl | null

    if (!impl || typeof impl.query !== 'function') {
      // 加载成功但没实现 query —— 这是插件作者的问题，要说清楚
      warnings.push({ plugin: name, reason: '插件没有实现 query' })
      continue
    }

    const config = await options.store.configOf(name)
    queried.push(name)

    try {
      const raw = await withTimeout(
        impl.query({
          account: options.account,
          config,
          secret: (key) => options.store.secretOf(name, key),
        }),
        timeoutMs,
        `第三方 ${name} 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`,
      )

      // 兼容两种返回形态：`{items: [...]}` 与裸数组。
      //
      // ⚠️ 这里**不能**写成 `raw.items ?? []`：那样一个返回 `{nope: true}`
      //    的插件会被当成"没有待处理项"，**静默通过**。插件作者会以为
      //    自己接好了，实际什么也没发生——正是这个模块到处在防的那类失败。
      //    "没给 items"与"给了个空的 items"必须分开。
      let list: unknown
      if (Array.isArray(raw)) {
        list = raw
      } else if (raw !== null && typeof raw === 'object' && 'items' in raw) {
        list = (raw as { items: unknown }).items
      } else {
        warnings.push({
          plugin: name,
          reason:
            `query 的返回值既不是数组，也没有 items 字段（实际是 ${describeShape(raw)}）`,
        })
        continue
      }
      if (!Array.isArray(list)) {
        warnings.push({
          plugin: name,
          reason: `query 返回的 items 不是数组（实际是 ${describeShape(list)}）`,
        })
        continue
      }
      for (const entry of list) {
        const normalized = normalizeItem(entry, name)
        if (normalized.ok) items.push(normalized.item)
        else warnings.push({ plugin: name, reason: normalized.reason })
      }
    } catch (err) {
      // ★ FR-REG-11：跳过本次并发出警告，绝不静默丢弃，也绝不阻塞后续
      warnings.push({
        plugin: name,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { items, warnings, queried }
}

/** 描述一个值的形状，用于把"返回错了"说得具体一点。 */
function describeShape(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  const names: Record<string, string> = {
    string: '字符串',
    number: '数字',
    boolean: '布尔值',
    object: '对象',
    undefined: 'undefined',
  }
  return names[typeof value] ?? typeof value
}

type NormalizeResult =
  | { ok: true; item: PendingItem }
  | { ok: false; reason: string }

/**
 * 把第三方返回的一条记录规整成报告条目。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么缺 `title` 时**拒绝**而不是编一个
 * ══════════════════════════════════════════════════════════════════
 *
 * `body` 缺省给空串是合理的（只给标题的报告有意义）；但 `title` 是审核者
 * 判断"这是什么东西"的第一依据，`externalId` 是去重键的一部分。
 *
 * 给它们编一个占位值（比如 `"未命名报告"`）看起来更"宽容"，实际是在制造
 * **看起来正常、实际无意义**的数据：审核者会对着一堆同名报告做判决，
 * 而去重键也会因为占位 externalId 撞在一起。宁可拒绝并报出是哪个插件
 * 哪一条不合法。
 */
function normalizeItem(entry: unknown, pluginName: string): NormalizeResult {
  if (entry === null || typeof entry !== 'object') {
    return { ok: false, reason: `返回的条目不是对象（来自 ${pluginName}）` }
  }
  const e = entry as Record<string, unknown>

  const externalId = typeof e['externalId'] === 'string' ? e['externalId'] : ''
  const kind = typeof e['kind'] === 'string' ? e['kind'] : ''
  const title = typeof e['title'] === 'string' ? e['title'] : ''

  const missing = [
    externalId === '' ? 'externalId' : null,
    kind === '' ? 'kind' : null,
    title === '' ? 'title' : null,
  ].filter((x): x is string => x !== null)
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `${pluginName} 返回的条目缺少必填字段 ${missing.join('、')}。` +
        `这些字段不能由远端代填：title 是审核者判断的依据，externalId 是去重键的一部分，` +
        `编一个占位值会制造"看起来正常、实际无意义"的数据。`,
    }
  }

  return {
    ok: true,
    item: {
      externalId,
      kind,
      title,
      body: typeof e['body'] === 'string' ? e['body'] : '',
      ...(e['meta'] && typeof e['meta'] === 'object'
        ? { meta: e['meta'] as Record<string, unknown> }
        : {}),
    },
  }
}

/**
 * 带超时的执行。
 *
 * 超时**不等于**取消底层操作——这里做不到（插件是个普通函数）。
 * 但至少让轮询能继续往下走，而不是挂在一个永远不返回的 Promise 上。
 * 这一点要如实说明：泄漏的那个 Promise 仍然在跑，只是不再被等待。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
