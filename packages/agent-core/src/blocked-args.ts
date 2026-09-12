import type { BlockedArgMode } from './runtime-table.ts'

/**
 * 禁改参数表过滤器（FR-CLI-10、FR-CLI-12）。
 *
 * 平台靠 stream-json 做双向通信、靠无人值守权限模式跑任务。这些参数一旦
 * 被使用者的自定义参数覆盖，**通信协议就断了**——而且失败方式往往很难查：
 * 可能是 CLI 静默换了一种输出格式，我们的解析器读到一半卡住。
 *
 * 所以这是"表能执行"的具体形态：不是文档里写"请不要覆盖 -p"，而是运行时
 * 把它们丢掉。
 */

export interface DroppedArg {
  arg: string
  mode: BlockedArgMode
  /** withValue 模式被一起丢掉的值（若有）。 */
  value?: string
}

export interface FilterResult {
  kept: string[]
  dropped: DroppedArg[]
}

/**
 * 过滤掉禁改参数。
 *
 * 支持三种写法：
 *   `-p`                     → standalone，丢参数本身
 *   `--output-format value`  → withValue，连值一起丢
 *   `--output-format=value`  → withValue，丢这一个 token
 *
 * ⚠️ 取值规则：`withValue` 时只有当**下一个 token 存在且不以 `-` 开头**
 *    才把它当作值一起丢掉。这样 `--output-format --model x` 这种畸形输入
 *    不会把 `--model` 也吞掉。代价是"值本身以 `-` 开头"的场景需要写成
 *    `--flag=value`——对禁改参数来说这个取舍是划算的：宁可留下一个孤儿值，
 *    也不要把使用者的下一个参数误删。
 */
export function filterBlockedArgs(
  args: readonly string[],
  blocked: Readonly<Record<string, BlockedArgMode>>,
): FilterResult {
  const kept: string[] = []
  const dropped: DroppedArg[] = []

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const mode = blocked[name]

    if (!mode) {
      kept.push(token)
      continue
    }

    if (mode === 'standalone') {
      dropped.push({ arg: name, mode })
      continue
    }

    // withValue
    if (eq !== -1) {
      dropped.push({ arg: name, mode, value: token.slice(eq + 1) })
      continue
    }

    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      dropped.push({ arg: name, mode, value: next })
      i++ // 值也一并吃掉
    } else {
      dropped.push({ arg: name, mode })
    }
  }

  return { kept, dropped }
}

/** 人可读的丢弃说明，用于警告日志（FR-CLI-12：不得静默丢弃）。 */
export function describeDropped(dropped: readonly DroppedArg[]): string {
  return dropped
    .map((d) => (d.value === undefined ? d.arg : `${d.arg} ${d.value}`))
    .join(', ')
}
