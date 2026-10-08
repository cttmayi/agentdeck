import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executableWrapper } from '@agentdeck/agent-core'
import type { RuntimeDescriptor } from '@agentdeck/agent-core'
import { codexDescriptor } from '../codex-descriptor.ts'

/**
 * 假 app-server 的脚手架（与 generic 的 fake-cli-helpers 同一套约定）。
 *
 * 必须把假脚本**拷进临时目录**再 chmod 0o755：仓库里的 `.ts` 不带 +x，
 * `spawn` 直接 exec 会 EACCES；且 `node --test` 并行跑测试，大家都去改
 * 仓库文件的权限位会互相踩。命令名刻意取一个**几乎不可能存在的名字**
 * （`codex-app-server-fake`）：测试忘了传 executablePath 时，`probeCommand`
 * 找不到真货，失败方式是"明确报错"，而不是悄悄跑使用者机器上的真 codex。
 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 假 app-server 的名字。故意取得不可能与真实程序重名。 */
export const FAKE_COMMAND = 'codex-app-server-fake'

export interface FakeAppServer {
  /** 包装脚本的绝对路径——作为 `executablePath` 传给后端。 */
  executablePath: string
  /** 假 app-server 的数据目录（放 RPC 回显等证据）。 */
  dataDir: string
  /** 一次性环境变量：剧本、RPC 回显文件等。 */
  env(scenario: string, extra?: Record<string, string>): Record<string, string>
}

/**
 * 在 `dir` 里落一份假 app-server。
 *
 * 内容每次测试现写（`fake-app-server.ts` 是唯一事实，多一份副本就多一处漂移），
 * 但**不用** `import` 它：它是个可执行脚本，被 import 会立刻按剧本跑起来。
 */
export async function makeFakeAppServer(dir: string): Promise<FakeAppServer> {
  // 与 generic 同款教训：扩展名必须是 `.ts`，Node 24 原生执行 TS（类型擦除）；
  // 拷成 `.mjs` 会在子进程里抛 SyntaxError，表现是"stdout 一个字都没有"。
  const scriptPath = join(dir, 'fake-app-server.ts')
  const dataDir = join(dir, 'data')

  const source = join(HERE, 'fake-app-server.ts')
  await copyFile(source, scriptPath)
  await mkdir(dataDir, { recursive: true })

  // ⚠️ 包装的形状**按平台定**：Unix 是 `#!/bin/sh` + exec；Windows 上没有 sh、
  //    chmod 也是空操作，改用一段形状与 npm 垫片一致的 `.cmd`——它会被
  //    `resolveSpawnTarget` 解开成 `<node> <script> <真实参数>`，于是
  //    "被测的 argv 仍是真实 argv"这条性质两个平台都成立。
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

/** 描述符的测试变体：把命令名换成假 app-server 的名字。 */
export function descriptorFor(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
  return { ...codexDescriptor(), command: FAKE_COMMAND, ...overrides }
}

/** 读回假 app-server 收到的请求（后端实际发出的 RPC）。 */
export async function readRpcEcho(path: string): Promise<{
  requests: Array<{ id: number; method: string; params: Record<string, unknown> }>
  approvalDecision: unknown
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    requests: Array<{ id: number; method: string; params: Record<string, unknown> }>
    approvalDecision: unknown
  }
}
