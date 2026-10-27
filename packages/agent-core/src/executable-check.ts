/**
 * 「这个路径能不能当程序跑」——**一处实现**（分批第 66 批抽出）。
 *
 * ⚠️ 原来这份在两个地方各有一份：`agent-generic` 与 `agent-codex` 里各写了一遍
 *    `isRunnableFile` + `describeMissingCommand`（注释还写着"改的时候要一起改"）。
 *    那正是最会漂的一种安排——而它们决定的是**"起不来时那句话对不对"**，
 *    漂了的表现是"使用者照着错误信息去修错的东西"。
 */
import { constants, existsSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'

/**
 * 这个路径能不能当程序跑：必须是**普通文件**，且带执行权限。
 *
 * 两件事都要查，缺一不可——目录有执行位、脚本文件未必有执行位。
 * 把这两条合成一个函数，是为了让"起进程前的检查"与
 * `describeMissingCommand` 的诊断口径保持一致（同一组失败原因、同一套话术）。
 */
export async function isRunnableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (process.platform === 'win32') return true // Windows 不靠权限位
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 探测结果要说清楚"有没有装"和"装了但跑不了"的区别。
 *
 * 只用于**诊断消息**：这一步的一次性 IO 换来一句能直接指出问题的错误，
 * 而不是让使用者去猜"是没装、是名字不对、还是权限不对"——这三者在
 * 一份裸的 `spawn EACCES` 里长得一模一样。
 *
 * `stat` 而不是 `existsSync`：**目录也有执行位**，`existsSync(dir)` 为真，
 * 然后 spawn 会以 EACCES 失败。判断"是不是一个可执行的普通文件"必须看类型。
 *
 * @param evidenceNote 额外的"证据等级"说明（generic 用：描述符是 provisional）。
 */
export async function describeMissingCommand(path: string, evidenceNote = ''): Promise<string> {
  let isFile = false
  try {
    isFile = (await stat(path)).isFile()
  } catch {
    isFile = false
  }

  if (isFile) {
    return `${path} 不是可执行文件：缺执行权限（试试 chmod +x）`
  }
  if (existsSync(path)) {
    return `${path} 存在，但它不是一个普通文件（目录不能当可执行文件用）`
  }
  return (
    `${path} 未安装，或不在本进程的 PATH 里（从 GUI 启动的进程常常拿不到用户 shell 的 PATH）。` +
    evidenceNote
  )
}
