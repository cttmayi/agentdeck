import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executableWrapper } from '@agentdeck/agent-core'
import type { RuntimeDescriptor } from '@agentdeck/agent-core'
import { genericDescriptor } from '../generic-descriptor.ts'

/**
 * 假可执行文件的脚手架。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须把假 CLI **拷进临时目录**，不能直接指仓库里的源文件
 * ══════════════════════════════════════════════════════════════════
 *
 * 两个理由，都不是洁癖：
 *
 * 1. **可执行位**。仓库里的 `.ts` 文件不带 +x，`spawn` 直接 exec 会
 *    EACCES。测试要在临时目录里 chmod 0o755，而改仓库文件的权限位
 *    会污染 git 工作区。
 * 2. **并发**。`node --test` 并行跑多个测试文件，若大家都往同一个
 *    仓库路径写 chmod，就会出现"其中一个测试文件还没跑完，权限被另一个
 *    测试改掉"的偶发失败。每个测试自己的临时目录没有这个问题。
 *
 * 命令名刻意写成一个**几乎不可能存在的名字**（`agent-cli`）：这样即使
 * 测试忘了传 executablePath，`probeCommand` 也找不到真货，失败方式是
 * "明确报错"，而不是悄悄跑到使用者机器上装的同名程序。
 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 假 CLI 的名字。故意取得不可能与真实程序重名。 */
export const FAKE_COMMAND = 'agent-cli'

export interface FakeCli {
  /** 包装脚本的绝对路径——作为 `executablePath` 传给后端。 */
  executablePath: string
  /** 假 CLI 的数据目录（放 argv 回显等证据）。 */
  dataDir: string
  /** 一次性环境变量：剧本、argv 回显文件等。 */
  env(scenario: string, extra?: Record<string, string>): Record<string, string>
}

/**
 * 在 `dir` 里落一份假 CLI。
 *
 * 内容每次测试现写，而不是从 fixtures 目录拷——`fake-cli.ts` 就是唯一事实，
 * 多一份副本就会多一处漂移。但**不用** `import` 它：它是个可执行脚本，
 * 被 import 会立刻按剧本跑起来并污染测试进程的 stdout。
 */
export async function makeFakeCli(dir: string): Promise<FakeCli> {
  // ⚠️ 扩展名必须是 `.ts`，**不能**叫 `.mjs`。
  //
  // 踩过一次：`fake-cli.ts` 里有 `const problems: string[] = []`，拷成 `.mjs`
  // 之后 Node 不再对它做类型擦除，直接抛 `SyntaxError: Missing initializer
  // in const declaration`。而那个语法错误发生在子进程里，表现是"stdout 一个字
  // 都没有、退出码 1"——后端的解析器把它读成"输出不可解析"。
  // 于是测试失败信息指向解析器，真正的问题却在测试脚手架的扩展名上。
  const scriptPath = join(dir, 'fake-cli.ts')
  const dataDir = join(dir, 'data')

  const source = join(HERE, 'fake-cli.ts')
  // Node 24 原生执行 TS（类型擦除），所以直接拷 .ts 源文件即可运行。
  await copyFile(source, scriptPath)
  // 证据文件（argv 回显等）落在 dataDir；必须先建好，否则假 CLI 的
  // writeFileSync 会以 ENOENT 崩掉——而那个崩溃会被解析成"输出不可解析"，
  // 让测试看起来像是解析器坏了。
  await mkdir(dataDir, { recursive: true })

  // ⚠️ 包装的形状**按平台定**：Unix 是 `#!/bin/sh` + exec；Windows 上没有 sh、
  //    chmod 也是空操作，改用一段形状与 npm 垫片一致的 `.cmd`——它会被
  //    `resolveSpawnTarget` 解开成 `<node> <script> <真实参数>`，于是
  //    "被测的 argv 仍是真实 argv"这条（假 CLI 存在的全部意义）两个平台都成立。
  //    见 docs/reference/windows-compat.md 的 A3。
  const wrapper = executableWrapper({
    name: FAKE_COMMAND,
    nodePath: process.execPath,
    scriptPath,
  })
  const wrapperPath = join(dir, wrapper.name)
  await writeFile(wrapperPath, wrapper.content, 'utf8')
  if (wrapper.needsChmod) await chmod(wrapperPath, 0o755)

  return {
    executablePath: wrapperPath,
    dataDir,
    env(scenario, extra) {
      return { FAKE_SCENARIO: scenario, ...(extra ?? {}) }
    },
  }
}

/**
 * 描述符的测试变体：把命令名换成假 CLI 的名字，并**显式声明 prompt 走 argv**。
 *
 * 为什么不直接用 `GENERIC_DESCRIPTOR`：它的 `promptDelivery` 是未验证的，
 * 测试要覆盖两种投递模式，就必须能改这一个字段——这正好说明"投递方式"
 * 作为一条数据是对的（改数据即可，不改后端代码）。
 */
export function descriptorFor(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
  return { ...genericDescriptor(), command: FAKE_COMMAND, ...overrides }
}

/** 读回后端实际收到的 argv（假 CLI 落的盘）。 */
export async function readArgvEcho(path: string): Promise<string[]> {
  return JSON.parse(await readFile(path, 'utf8')) as string[]
}
