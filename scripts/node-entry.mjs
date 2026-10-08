/**
 * 入口前置壳：**在把 `.ts` 交给 node 之前，先确认这个 node 跑得动 `.ts`。**
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这一层（2026-10 Windows 兼容性审计的 B1）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个仓库是把 `.ts` **直接交给 node** 跑的（`node apps/daemon/src/cli.ts`），
 * 靠的是 Node 的类型擦除。而它默认可用是 **23.6 起**、并回移到 **22.18**。
 * 早于这些版本时，使用者在 Windows（或任何地方）装到的 Node 上跑 `pnpm run daemon`，
 * 看到的是这样一段：
 *
 *     TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for …/cli.ts
 *
 * ——那句话里没有一个字提到"你的 node 太老"，而它**看起来**像仓库坏了
 * （实测：Node 22.17.0 上就是这个报错）。所以这一层只做一件事：
 * 把那段堆栈换成一句能照做的话。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ 为什么守卫**必须**是 `.mjs`，不能写在 `.ts` 入口里
 * ══════════════════════════════════════════════════════════════════
 *
 * 写进 `.ts` 是跑不到的：node 连那个文件都加载不了（上面那句报错就是加载阶段抛的），
 * 里面的守卫一行都不会执行。所以这是一个**普通 JavaScript** 的前置壳，
 * 它做完版本检查再 `import()` 真正的入口。
 *
 * ══════════════════════════════════════════════════════════════════
 * argv 要**改写**，不能让入口看见自己这一层
 * ══════════════════════════════════════════════════════════════════
 *
 * `pnpm run daemon --port 4599` ⇒ `node scripts/node-entry.mjs apps/daemon/src/cli.ts --port 4599`
 * ⇒ 入口里的 `process.argv` 默认是
 * `[node, scripts/node-entry.mjs, apps/daemon/src/cli.ts, --port, 4599]`，
 * 而所有入口都是按 `slice(2)` 读自己的参数的 ⇒ 会把入口路径当成第一个位置参数。
 * 所以这里在 `import()` **之前**把 argv 掰回"入口直接跑"的样子：
 * `[node, apps/daemon/src/cli.ts, --port, 4599]`。
 * 于是"命令看起来是什么就是什么"这条不受这一层影响（`scripts/node-entry.test.mjs`
 * 有一条真起进程的判据守着它）。
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 这个 Node 能不能直接跑 `.ts`。
 *
 * ⚠️ 不是简单的"≥ 某个版本"：
 *   · 22 那条线（LTS）：**22.18** 起默认可用；
 *   · 23 那条线（非 LTS）：**23.6** 起默认可用——所以 23.0–23.5 **不行**；
 *   · 24 及以后：都是默认可用。
 * 一句话版本会漏掉 23.0–23.5 那一段，而那一段是真会有人装的。
 */
export function nodeSupportsTypeStripping(version) {
  const [major = 0, minor = 0] = parseNodeVersion(version)
  if (major >= 24) return true
  if (major === 23) return minor >= 6
  if (major === 22) return minor >= 18
  return false
}

/** `v22.18.0` / `22.18.0` ⇒ `[22, 18, 0]`。解析不出来就给 `[0, 0, 0]`（当作不合格）。 */
export function parseNodeVersion(version) {
  const match = String(version ?? '')
    .trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (match === null) return [0, 0, 0]
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/** 不合格时给使用者看的那段话。**每一句都要能照做。** */
export function versionGuardMessage(version) {
  return [
    `这个命令要用 Node ≥ 22.18 跑（23.x 上要 ≥ 23.6）。你现在的是 v${version}。`,
    '',
    // ⚠️ 这段话会进终端、也会被人贴进 issue：不留 markdown 记号（`**` 到人眼里就是两个星号）
    '为什么：这个仓库是把 .ts 直接交给 node 跑的（靠 Node 的类型擦除），',
    '而类型擦除默认可用是 23.6 起、并回移到 22.18。低于这些版本会报',
    '`ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`——那句话看起来像仓库坏了。',
    '',
    '怎么办（二选一）：',
    '  · 装 Node 24（推荐）：https://nodejs.org/ ，装完重跑 `pnpm install`',
    '  · 或者临时用带 flag 的方式直接跑（22.6–22.17 有这个 flag）：',
    '      node --experimental-strip-types apps/daemon/src/cli.ts',
    '    ⚠️ `pnpm run <命令>` 传不了 flag，所以这条要绕开 pnpm。',
    '',
  ].join('\n')
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  if (!nodeSupportsTypeStripping(process.versions.node)) {
    process.stderr.write(versionGuardMessage(process.versions.node))
    process.exit(1)
  }

  const entry = process.argv[2]
  if (entry === undefined || entry === '') {
    process.stderr.write(
      '用法：node scripts/node-entry.mjs <入口 .ts> [给入口的参数…]\n' +
        '（这一层只做 Node 版本检查，然后原样把控制权交给入口。）\n',
    )
    process.exit(2)
  }

  // ★ 在 import 之前掰回 argv：入口按 slice(2) 读自己的参数，不能让入口路径混进去
  process.argv = [process.argv[0], entry, ...process.argv.slice(3)]

  await import(pathToFileURL(resolve(entry)).href)
}