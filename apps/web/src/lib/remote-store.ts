import { writable } from 'svelte/store'
import { renderText, webText } from '@agentdeck/i18n'
import {
  getRemoteUrl,
  isLoggedIn,
  remote,
  type Catalog,
  type PluginInfo,
  type RemoteAccount,
} from './remote.ts'
import { currentLocale } from './locale.ts'

/**
 * 远端账号状态的**单一来源**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须提出来，而不能留在抽屉组件里
 * ══════════════════════════════════════════════════════════════════
 *
 * 登录态现在有**两个**地方要看它：顶栏（显示"登录"还是账号名）与设置抽屉
 * （账号详情、插件、目录）。状态留在某个组件内部，另一个就只能靠事件往上
 * 传或者各查一遍——两种做法迟早会不同步，而**登录按钮显示"已登录"、
 * 抽屉里却是登录表单**这种自相矛盾的界面，排查起来毫无头绪。
 *
 * 所以状态放这里，谁要看谁订阅。
 */

export const remoteAccount = writable<RemoteAccount | null>(null)
export const remotePlugins = writable<PluginInfo[]>([])
export const remoteCatalog = writable<Catalog | null>(null)
export const remoteLoggedIn = writable<boolean>(isLoggedIn())
export const remoteError = writable<string>('')
export const remoteUrlValue = writable<string>(getRemoteUrl())

/**
 * 拉一次远端状态。
 *
 * ══════════════════════════════════════════════════════════════════
 * 目录与账号**分开 try**，不能共用一个错误
 * ══════════════════════════════════════════════════════════════════
 *
 * 目录是公开接口，登录接口不是。合并处理的话，一个失效的凭证会把
 * "能力目录也拉不到"这个假象报出来——而目录其实好好的。
 */
export async function refreshRemote(): Promise<void> {
  remoteError.set('')
  remoteUrlValue.set(getRemoteUrl())

  try {
    remoteCatalog.set(await remote.catalog())
  } catch (err) {
    remoteError.set(err instanceof Error ? err.message : String(err))
    return
  }

  if (!isLoggedIn()) {
    remoteLoggedIn.set(false)
    remoteAccount.set(null)
    remotePlugins.set([])
    return
  }

  try {
    const me = await remote.me()
    remoteAccount.set(me.account)
    remotePlugins.set(me.plugins)
    remoteLoggedIn.set(true)
  } catch (err) {
    // ★ 401 是"凭证过期了"，不是"远端坏了"——要区别对待，否则使用者会去
    //   重启远端服务，而真正该做的是重新登录。
    if (err instanceof Error && (err as { status?: number }).status === 401) {
      remote.logout()
      remoteLoggedIn.set(false)
      remoteAccount.set(null)
      remotePlugins.set([])
      // 挂在 `remoteError` 上、界面上直接显示的一句话，所以要取词；远端自己
      // 给的原话（`err.message`）不翻译，只把它当作展示内容（下面的 else 分支）。
      remoteError.set(renderText(webText, 'err.sessionExpired', currentLocale()))
    } else {
      remoteError.set(err instanceof Error ? err.message : String(err))
    }
  }
}

export async function doLogin(email: string, password: string): Promise<void> {
  await remote.login(email, password)
  await refreshRemote()
}

export async function doRegister(email: string, password: string): Promise<void> {
  await remote.register(email, password)
  await refreshRemote()
}

export function doLogout(): void {
  remote.logout()
  remoteLoggedIn.set(false)
  remoteAccount.set(null)
  remotePlugins.set([])
}
