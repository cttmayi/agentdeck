/**
 * 入口前置壳：**把 `.ts` 交给一个跑得动 `.ts` 的 node。**
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这一层（2026-10 Windows 兼容性审计的 B1）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个仓库是把 `.ts` **直接交给 node** 跑的（`node apps/daemon/src/cli.ts`），
 * 靠的是 Node 的类型擦除。而它默认可用是 **23.6 起**、并回移到 **22.18**。
 * 早于这些版本时，使用者（尤其在 Windows 上，装到哪个 node 不由他挑）跑
 * `pnpm run daemon`，看到的是这样一段：
 *
 *     TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for …/cli.ts
 *
 * ——那句话里没有一个字提到"你的 node 太老"，而它**看起来**像仓库坏了
 * （实测：Node 22.17.0 上就是这个报错）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条路：直接跑 / 补一个 flag 再跑 / 只能升级（2026-10 使用者要求「兼容 22」）
 * ══════════════════════════════════════════════════════════════════
 *
 * 「太老」其实分两种，混为一谈会白白劝人升级：
 *
 *   · **22.6–22.17、23.0–23.5**：类型擦除**已经在这个 node 里**，只是没默认打开，
 *     要 `--experimental-strip-types` 这个开关（22.6 起就有）。⇒ 这一层**自动补上
 *     这个 flag 重跑一遍**，使用者什么都不用做。（`pnpm run <命令>` 自己传不了 flag，
 *     所以补 flag 这件事只能在这一层做——这是这层壳存在的第二个理由。）
 *
 *   · **< 22.6**：连这个开关都没有，任何写法都跑不起来。⇒ 如实劝升级。
 *
 * ⚠️ 补 flag 重跑之前会往 stderr 打一行，说明"这个 node 默认不开、已自动带 flag 重跑"。
 * **不是静默适配**：能跑起来是功能，为什么多了一层进程是使用者该知道的事实
 * （他要排查"daemon 的 pid 为什么是个 shim"时有据可查）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ 为什么守卫**必须**是 `.mjs`，不能写在 `.ts` 入口里
 * ══════════════════════════════════════════════════════════════════
 *
 * 写进 `.ts` 是跑不到的：node 连那个文件都加载不了（上面那句报错就是加载阶段抛的），
 * 里面的守卫一行都不会执行。所以这是一个**普通 JavaScript** 的前置壳。
 *
 * ══════════════════════════════════════════════════════════════════
 * argv 要**改写**，不能让入口看见自己这一层
 * ══════════════════════════════════════════════════════════════════
 *
 * `pnpm run daemon --port 4599` ⇒ `node scripts/node-entry.mjs apps/daemon/src/cli.ts --port 4599`
 * ⇒ 入口里的 `process.argv` 默认是
 * `[node, scripts/node-entry.mjs, apps/daemon/src/cli.ts, --port, 4599]`，
 * 而所有入口都是按 `slice(2)` 读自己的参数 ⇒ 会把入口路径当成第一个位置参数。
 * 所以这里在把控制权交出去**之前**把 argv 掰回"入口直接跑"的样子：
 * `[node, apps/daemon/src/cli.ts, --port, 4599]`。
 * 于是"命令看起来是什么就是什么"这条不受这一层影响（`scripts/node-entry.test.mjs`
 * 有一条真起进程的判据守着它）。**补 flag 重跑那条路也一样**——子进程拿到的 argv
 * 就是"入口直接跑"的样子（入口名按绝对路径给，因为子进程的 cwd 由不得这里假设）。
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 22.6 起有这个开关，22.18 起默认开。'flag' 档补的就是它。 */
export const TYPE_STRIPPING_FLAG = '--experimental-strip-types'

/**
 * 这个 node 跑 `.ts` 属于哪一档：
 *
 *   'native'      —— 默认就能跑，直接把控制权交给入口（什么都不用做）
 *   'flag'        —— 能跑，但要带 `--experimental-strip-types`（补上再重跑）
 *   'unsupported' —— 连这个开关都没有（< 22.6），只能升级
 *
 * ⚠️ 不是简单的"≥ 某个版本"：
 *   · 22 那条线（LTS）：**22.18** 起默认可用；22.6–22.17 是 'flag' 档；
 *   · 23 那条线（非 LTS）：**23.6** 起默认可用——所以 23.0–23.5 也是 'flag' 档。
 * 一句话版本会漏掉 23.0–23.5 那一段，而那一段是真会有人装的。
 */
export function typeStrippingMode(version) {
  const [major = 0, minor = 0] = parseNodeVersion(version)
  if (major >= 24) return 'native'
  if (major === 23) return minor >= 6 ? 'native' : 'flag'
  if (major === 22) return minor >= 18 ? 'native' : minor >= 6 ? 'flag' : 'unsupported'
  return 'unsupported'
}

/** `v22.18.0` / `22.18.0` ⇒ `[22, 18, 0]`。解析不出来就给 `[0, 0, 0]`（当作最老的一档）。 */
export function parseNodeVersion(version) {
  const match = String(version ?? '')
    .trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (match === null) return [0, 0, 0]
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/** 只能升级时给使用者看的那段话。**每一句都要能照做。** */
export function versionGuardMessage(version) {
  return [
    `这个命令要用 Node ≥ 22.6 跑（22.18 起不用开关，推荐 24）。你现在的是 v${version}。`,
    '',
    // ⚠️ 这段话会进终端、也会被人贴进 issue：不留 markdown 记号（`**` 到人眼里就是两个星号）
    '为什么：这个仓库是把 .ts 直接交给 node 跑的（靠 Node 的类型擦除），',
    '而类型擦除是 Node 22.6 才加进来的。低于 22.6 会报',
    '`ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`——那句话看起来像仓库坏了。',
    '',
    '怎么办：装 Node 24（推荐）或 22 的最新版：https://nodejs.org/ ，装完重跑 `pnpm install`。',
    `（22.6–22.17 与 23.0–23.5 本来也能跑——这一层会自动补 ${TYPE_STRIPPING_FLAG}`,
    ' 重跑一层；你现在这个版本连那个开关都没有，所以只能升级。）',
    '',
  ].join('\n')
}

/** 'flag' 档补 flag 重跑前往 stderr 打的那一行。**不是静默适配。** */
export function flagNotice(version) {
  return `（Node v${version} 默认不开启类型擦除，已自动带 ${TYPE_STRIPPING_FLAG} 重跑一层。）\n`
}

/**
 * 让**子进程的整棵子树**也能跑 `.ts`：把开关塞进 `NODE_OPTIONS`（每一层 node 都会继承它）。
 *
 * ⚠️ 只在跑测试时这么做。测试会起大量 `.ts` 夹具——假 CLI、假 codex server、示例工具包
 * 脚本——它们用的是同一个（老的）node；只给顶层 `--test` 带 flag 是**不够的**：夹具
 * 在 22.6–22.17 上加载不了，表现是一大片看不出原因的红（实测 22.17：35 红）。
 * 而 daemon 那条路**不能**这么干：它 spawn 的是使用者自己的 agent CLI（claude / codex），
 * 往那棵树里塞一个 node 开关等于替使用者改他们的运行时。
 *
 * 已有 `NODE_OPTIONS` 就追加，不覆盖。Node 24 上它是无害的 no-op，但 native 档根本不会调到这里。
 */
export function typeStrippingEnv(env = process.env) {
  const existing = String(env.NODE_OPTIONS ?? '').trim()
  return { NODE_OPTIONS: existing ? `${existing} ${TYPE_STRIPPING_FLAG}` : TYPE_STRIPPING_FLAG }
}

/**
 * 起一个子 node 跑 `nodeArgs`（'flag' 档自动在最前面补上类型擦除开关），
 * 把 stdin/stdout/stderr 原样接过来（`stdio: 'inherit'`），并按子进程的结局结束自己。
 *
 * ⚠️ 信号要**转发**：daemon 是常驻进程，被 `kill` / Ctrl-C 时得让子进程一起走，
 * 否则会留下一个孤儿在占着 4517。转发之后父进程按子进程的结局退出：带信号就
 * 重新按同一个信号结束自己（好让"退出码/信号"语义与没有这层壳时一致），
 * 否则用子进程的退出码。
 *
 * `extraEnv` 用来给**测试**那条路补 `NODE_OPTIONS`（跑 `.ts` 夹具的子进程也继承得到）；
 * 不传就是原样继承 `process.env`。daemon 那条路**不许**传它——见 `typeStrippingEnv`。
 *
 * 返回一个**永不 resolve** 的 promise（结局都是 `process.exit` / 信号），
 * 这样 `await runNode(...)` 之后不会继续往下跑——把"这里就是终点"写在类型上。
 */
export async function runNode(nodeArgs, mode, extraEnv) {
  const argv = mode === 'flag' ? [TYPE_STRIPPING_FLAG, ...nodeArgs] : nodeArgs
  const child = spawn(process.execPath, argv, {
    stdio: 'inherit',
    env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
  })

  const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of forwarded) {
    process.on(signal, () => {
      try {
        child.kill(signal)
      } catch {
        // 子进程已经没了：什么都不用做，等它的 exit 事件即可
      }
    })
  }

  child.on('error', (error) => {
    process.stderr.write(`起子进程失败：${error.message}\n`)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal !== null) {
      // 先把上面那几个转发处理器摘掉，再按同一个信号结束自己，免得又被自己转发一次
      for (const sig of forwarded) process.removeAllListeners(sig)
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })

  await new Promise(() => {})
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const mode = typeStrippingMode(process.versions.node)
  if (mode === 'unsupported') {
    process.stderr.write(versionGuardMessage(process.versions.node))
    process.exit(1)
  }

  const [first, ...rest] = process.argv.slice(2)

  // 特例：起 node 自己的**测试运行器**。它不是"一个 .ts 入口"，import 不了，只能 spawn。
  // `pnpm run test` 走的就是这一条——测试文件本身是 .ts，同样要类型擦除。
  if (first === '--test') {
    // 只有这一条路把 flag 塞进 NODE_OPTIONS：测试会起大量 .ts 夹具，得让它们也继承到。
    await runNode(['--test', ...rest], mode, mode === 'flag' ? typeStrippingEnv() : undefined)
  } else {
    const entry = first
    if (entry === undefined || entry === '') {
      process.stderr.write(
        '用法：node scripts/node-entry.mjs <入口 .ts> [给入口的参数…]\n' +
          '      node scripts/node-entry.mjs --test <测试 glob…>\n' +
          '（这一层只把 .ts 交给一个跑得动的 node，然后原样把控制权交出去。）\n',
      )
      process.exit(2)
    }

    if (mode === 'flag') {
      process.stderr.write(flagNotice(process.versions.node))
      await runNode([resolve(entry), ...rest], mode)
    } else {
      // ★ 在 import 之前掰回 argv：入口按 slice(2) 读自己的参数，不能让入口路径混进去
      process.argv = [process.argv[0], entry, ...rest]
      await import(pathToFileURL(resolve(entry)).href)
    }
  }
}
