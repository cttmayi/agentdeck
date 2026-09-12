import { checkVersionSupport, knownRuntimeKeys, loadRuntimeDescriptor } from '@alpha-helper/agent-core'
import { knownRuntimeAdapters } from './runtime-registry.ts'

/**
 * `--verify-runtime <key>`：把 FR-CLI-07 的"以实际版本验证"变成一个**可执行的动作**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它为什么必须存在
 * ══════════════════════════════════════════════════════════════════
 *
 * `FR-CLI-07` 要求"声明并测试受支持的 CLI 版本范围，**以实际版本验证，
 * 不得凭文档推断**"。而本仓库的测试**禁止调用真实 CLI**（NFR-T-01：
 * 会消耗使用者的真实额度、还可能让 agent 改动文件）。
 *
 * 两条约束叠在一起，结论是：**自动化测试里永远无法完成这件事**。
 * 那么它就必须有一个明确的人工入口，否则那个"未声明"状态会永远挂着，
 * 而"永远挂着的待办"实际上等于"没人会做"。
 *
 * 所以这条命令把验证拆成**两步，且只自动做第一步**：
 *
 *   1. **探测**（自动、免费、无副作用）：找到 CLI、读出真实版本号，
 *      并报出它与声明的差距。这一步这里做了。
 *   2. **端到端跑通**（需人工决定）：真的跑一个任务。**这里不做**——
 *      它会花掉使用者的额度。命令会把该怎么做说清楚，由人来决定。
 *
 * ⚠️ 诚实地说明这一步的局限：**探测通过 ≠ 验证通过**。
 *    "版本号读出来了"只证明二进制在那儿，不证明字段名对得上。
 *    所以本命令的成功输出**不会**自动把 `verifiedWith` 填上——
 *    填那个数组必须是人跑完真实任务之后手动做的动作。
 *    让命令去替人填，就等于把"没验证"伪装成"验证过了"。
 */

export interface VerifyRuntimeReport {
  key: string
  found: boolean
  command: string
  cliVersion: string | null
  evidence: string
  sessionState: string
  versionStatus: string
  /** 已经实测过的版本（来自描述表）。 */
  verifiedWith: readonly string[]
  /** 声明的范围。 */
  range: string | null
  /** 给人看的结论。 */
  summary: string
  /** 下一步该做什么。**这一步没做完，就不算验证过。** */
  nextSteps: string[]
}

export async function verifyRuntime(
  key: string,
  executablePath?: string,
): Promise<VerifyRuntimeReport> {
  const descriptor = loadRuntimeDescriptor(key)
  const adapters = knownRuntimeAdapters()
  const adapter = adapters[key]
  if (!adapter) {
    throw new Error(
      `没有装配名为 ${key} 的适配器。已装配：${Object.keys(adapters).join(', ')}`,
    )
  }

  const probe = await adapter
    .create({ ...(executablePath ? { executablePath } : {}), onWarn: () => {} })
    .probe()
  const support = checkVersionSupport(descriptor, probe.cliVersion)

  const nextSteps: string[] = []
  if (!probe.available) {
    nextSteps.push(
      `先让它能被找到：确认 \`${descriptor.command}\` 在 PATH 里，` +
        `或用 --executable 指定完整路径。`,
    )
  } else if (support.status === 'verified') {
    nextSteps.push('这个版本已经实测过，不需要额外动作。')
  } else {
    nextSteps.push(
      `把 ${probe.cliVersion ?? '(未知版本)'} 跑一次**真实**端到端任务` +
        `（在页面上建一个 issue 并指派给挂了这个 runtime 的 agent）。`,
    )
    nextSteps.push(
      `跑通之后，手工把 "${probe.cliVersion ?? 'x.y.z'}" 加进 ` +
        `runtime-table.ts 里 ${key} 的 versions.verifiedWith，` +
        `并把 versions.range 收窄到你确实验过的区间。`,
    )
    nextSteps.push(
      `⚠️ 本命令**不会**替你填那个数组：探测到版本号只证明二进制在那儿，` +
        `不证明字段名对得上。让人工命令去填，等于把"没验证"伪装成"验证过了"。`,
    )
  }

  return {
    key,
    found: probe.available,
    command: descriptor.command,
    cliVersion: probe.cliVersion,
    evidence: descriptor.evidence,
    sessionState: descriptor.sessionState,
    versionStatus: support.status,
    verifiedWith: support.verifiedWith,
    range: descriptor.versions?.range ?? null,
    summary: support.message,
    nextSteps,
  }
}

/** 把所有已知 runtime 的验证状态列成一张表——一眼看出还欠哪些。 */
export async function verifyAllRuntimes(
  executablePath?: string,
): Promise<VerifyRuntimeReport[]> {
  const out: VerifyRuntimeReport[] = []
  for (const key of knownRuntimeKeys()) {
    try {
      out.push(await verifyRuntime(key, executablePath))
    } catch (err) {
      // 单个 runtime 探测失败不该让整张表出不来
      out.push({
        key,
        found: false,
        command: '?',
        cliVersion: null,
        evidence: '?',
        sessionState: '?',
        versionStatus: 'unknown',
        verifiedWith: [],
        range: null,
        summary: err instanceof Error ? err.message : String(err),
        nextSteps: [],
      })
    }
  }
  return out
}

/** 渲染成人可读的文本。 */
export function renderVerifyReport(reports: readonly VerifyRuntimeReport[]): string {
  const lines: string[] = ['', '── CLI 版本验证状态（FR-CLI-07）──', '']
  for (const r of reports) {
    lines.push(`${r.key}`)
    lines.push(`  命令        ${r.command}${r.found ? '' : '（未找到）'}`)
    lines.push(`  探测版本    ${r.cliVersion ?? '(读不到)'}`)
    lines.push(`  证据等级    ${r.evidence}`)
    lines.push(`  会话状态    ${r.sessionState}`)
    lines.push(`  版本判定    ${r.versionStatus}`)
    lines.push(`  声明范围    ${r.range ?? '(未声明)'}`)
    lines.push(`  实测过      ${r.verifiedWith.length > 0 ? r.verifiedWith.join(', ') : '(无 —— 等于未声明)'}`)
    lines.push(`  结论        ${r.summary}`)
    if (r.nextSteps.length > 0) {
      lines.push('  下一步：')
      for (const step of r.nextSteps) lines.push(`    · ${step}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
