import { currentLocale } from './locale.ts'
import { remoteText } from '@agentdeck/i18n'
import { renderText } from '@agentdeck/i18n'

/**
 * 远端服务的接口客户端。
 *
 * ★ 与 daemon 界面里那个 `remote.ts` 的关键差别：**同源**。
 *   这一页由远端服务自己托管（4518），所以 `fetch('/api/...')` 就是它自己——
 *   不需要远端地址配置、不需要 token（目录是公开接口）、也不会撞 CORS。
 *   daemon 那边要维护一个"远端地址 + 登录态"，是因为它在**另一个源**上。
 */
export interface CatalogSkill {
  slug: string
  name: string
  version: string | null
  summary: string
  category: string
  origin: 'official' | 'community'
  fills: string | null
  needs: string | null
  content: string
  files: Record<string, string>
  sourceRef: string
  fetchedAt: string
  /** 清单里声明排除、没有装进来的（相对路径；目录以 `/` 结尾）。 */
  excluded: string[]
  /**
   * 这条从哪儿来（D52）：`synced` = 推荐清单同步下来的（页面上**不能**删，
   * 要去改清单再同步）；`local` = 在这个页面上手动装的（可以卸载）。
   */
  source?: 'synced' | 'local'
}

export interface CatalogTool {
  slug: string
  name: string
  version: string | null
  summary: string
  manifest: { schema: string; actions: Array<{ name: string; summary?: string }> }
  files: Record<string, string>
  docs: string
}

/**
 * 推荐清单的**摘要**（D54）：页面要说清"按哪一份清单、几条、核对于哪天"。
 * `exists: false` 是一个**合法状态**（还没转存）；`error` 非空时如实显示读不了。
 */
export interface ManifestSummary {
  path: string
  exists: boolean
  verifiedAt: string | null
  count: number
  error: string | null
}

export interface Catalog {
  skills: CatalogSkill[]
  tools: CatalogTool[]
  loginMethods: Array<{ name: string; summary: string }>
  /** `null` = 这个部署没配清单（`--manifest null`）。 */
  manifest: ManifestSummary | null
}

export type SyncState =
  | 'idle'
  | 'running'
  | 'ok'
  | 'failed'
  /** 这个部署没有同步工具（按钮要说明为什么不能点）。 */
  | 'unavailable'

export interface SyncStatus {
  state: SyncState
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  /** 同步进程输出的末尾若干行（界面直接显示，不加工）。 */
  tail: string[]
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } })
  } catch (err) {
    // 网络层失败：说清"取不到"，不要把 TypeError 原文丢给使用者
    throw new ApiError(renderText(remoteText, 'remote.error', currentLocale(), {
      error: err instanceof Error ? err.message : String(err),
    }))
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ApiError(
      renderText(remoteText, 'remote.error', currentLocale(), {
        error: `HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
      }),
    )
  }
  return (await res.json()) as T
}

export const api = {
  catalog: (): Promise<Catalog> => get<Catalog>('/api/catalog'),
  syncStatus: (): Promise<SyncStatus> => get<SyncStatus>('/api/catalog/skills/sync'),
  /** 手动装一条技能进远端目录的**本地层**（与同步来的并列，互不干涉）。 */
  async installSkill(input: {
    url: string
    name?: string
    summary?: string
    needs?: string
  }): Promise<{ slug: string; files: string[] }> {
    const res = await fetch('/api/catalog/skills/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = (await res.json().catch(() => ({}))) as {
      installed?: { slug: string; files: string[] }
      error?: string
    }
    if (res.status === 201 && body.installed) return body.installed
    // ★ 失败时把服务端那句原话（含取包规则的 detail）**原样**给出去：
    //   "为什么装不上"是使用者唯一能行动的信息
    throw new ApiError(body.error ?? `HTTP ${res.status}`)
  },

  /** 从远端目录卸掉一条**本地装的**。同步来的会被服务端 409 拒绝（那是清单的事）。 */
  async uninstallSkill(slug: string): Promise<void> {
    const res = await fetch(`/api/catalog/skills/local/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    })
    if (res.status === 200) return
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(body.error ?? `HTTP ${res.status}`)
  },

  /** 触发一次同步。409 = 已经有一次在跑（那时把当下状态拿回来，不报错）。 */
  async startSync(): Promise<SyncStatus> {
    const res = await fetch('/api/catalog/skills/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (res.status === 409 || res.status === 202) return (await res.json()) as SyncStatus
    const detail = await res.text().catch(() => '')
    throw new ApiError(
      renderText(remoteText, 'remote.error', currentLocale(), {
        error: `HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
      }),
    )
  },
}
