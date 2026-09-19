import {
  actionIdempotencyKey,
  mergeActionParams,
  resolveActionDefinition,
  validateActionRefWith,
  type ActionFacts,
  type Store,
  type ToolActionDefinition,
} from '@alpha-helper/domain'
import {
  ulid,
  type Action,
  type ActionRef,
  type InboxItem,
  type Issue,
  type RunId,
  type Tool,
  type VerdictId,
  type WorkspaceId,
} from '@alpha-helper/protocol'
import type { ScriptExecutionRequest, ScriptExecutionResult } from './script-executor.ts'

/**
 * 本地动作执行（FR-ACTION-01~08、INV-9~12）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ 平台**不再自己改任何数据**（D41：内置动作全部移除）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个文件原来有一个 `#dispatch()`，里面是六个 `case`——平台的"内置动作"：
 *
 *   · `comment.create`        写一条评论到 issue 上
 *   · `issue.update_status`   改 issue 状态
 *   · `issue.add_label`       给 issue 打标签
 *   · `issue.create`          建一条 issue
 *   · `issue.assign_agent`    指派 agent **并派生一条新 run**
 *   · `notify.emit`           发一条"动作型"通知
 *
 * 连它们各自的辅助函数（`#requesterAgentId` 的 reviewer≠executor 判定、
 * `#checkDerivationBoundary` / `#notifyBoundary` 的回路边界、`deriveRun` 回调、
 * `DeriveRunRequest`）一起删掉了。动作从此**只能**来自装进来的工具包
 * （`<包 slug>.<动作名>`），而工具脚本**没有平台 API**——它只能改工作目录里的
 * 东西。于是：
 *
 *   平台不会写评论、不会改 issue、不会指派、不会建 issue、不会发"动作型"通知；
 *   它也不会由一条动作派生出新的 run（那条能力原本只服务于 `issue.assign_agent`）。
 *
 * **这是刻意承担的后果**，不是遗漏。想让这类能力回来，只有两条路：
 *
 *   ① 给工具脚本一条**受控的本地接口**（例如"只允许对这个 subject 写评论"的
 *      一条窄通道）——先设计那条接口的权限边界，再谈动作；
 *   ② 把这类动作做成**随平台发布的标准工具包**：同一套清单 + 脚本机制，
 *      而不是硬编码回这个 daemon 里。
 *
 * 两条路都不该是"把 `switch` 加回来"——那正是这次删掉的东西。
 *
 * ══════════════════════════════════════════════════════════════════
 * `ActionRunner` 现在**只**做这件事（顺序就是下面 `execute()` 的顺序）
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① 解析定义 —— 已安装工具包的路（`resolveActionDefinition`）；
 *   ② 校验 —— 动作名在不在已安装的包里、开放参数合不合规；
 *   ③ 幂等 —— 键含 verdictId；
 *   ④ 绑定/合并参数 —— 平台按**事实**注入 bound，模型只给 open；
 *   ⑤ 脚本执行器 —— 真去跑那个脚本（dry-run 原样透传）；
 *   ⑥ 记状态与通知 —— `executed` / `failed`，失败必须可见。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条不能退让的规则
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 默认自动执行**（INV-4）。这里没有"先等人批准"的分支——`awaiting_approval`
 *    是例外，且只能由工具包显式声明。若默认要人点一下，人又变回了默认关卡。
 *
 * **② 幂等键必须含 verdictId**。同一判决重放要被去重（落 `skipped`），但
 *    **不同判决产生的相同动作不能被去重**——否则多视角审核里第二个 agent
 *    同样的真实发现会被静默吞掉。
 *
 * **③ 失败必须可见**（FR-ACTION-08）。动作失败不得静默：进 `failed` 状态
 *    并发通知。静默失败会让"判决执行了"这个前提变成假的。
 */

export interface ActionRunnerDeps {
  store: Store
  /**
   * 工具动作的执行器（D40）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么是注入的，而不是在这里 `new ScriptExecutor(...)`
   * ══════════════════════════════════════════════════════════════════
   *
   * 执行器需要三样装配层的知识：临时目录的父目录（daemon 数据目录下的一个
   * 子目录）、`spawn` 的实现（测试要换成替身，**绝不**在单测里真起进程）、
   * 以及环境的白名单来源。这三样都不属于"动作执行"这件事，硬编码在这里
   * 会让这个文件同时知道数据目录布局与进程创建——两件它会跟着变的事。
   *
   * ⚠️ D41 之后动作**只有**工具动作这一种，所以"没注入执行器"不再是"这一版
   *    还没接上第三方动作"那种临时状态，而是**装配错了**：动作**明确失败**，
   *    而不是静默跳过——判决已经产出了这条动作，静默等于"判决执行了"是假的。
   */
  executeToolScript?: (req: ScriptExecutionRequest) => Promise<ScriptExecutionResult>
  /**
   * 记一条给开发者看的警告（可选）。
   *
   * 目前只用在一处：读 workspace 设置失败时，准入判定按"更严的那一边"处理，
   * 但**必须留痕**——静默降级会让"动作莫名被拒"变成查不出来的谜。
   */
  onWarn?: (message: string) => void
  now?: () => number
}

export interface ExecuteActionInput {
  ref: ActionRef
  workspaceId: WorkspaceId
  verdictId: VerdictId
  /** 关联的 run（审计与通知用）。 */
  runId: RunId | null
  /** 演练：只校验与记录，不产生副作用。 */
  dryRun?: boolean
  /**
   * 使用者在界面上设好的固定参数（D43）：`参数名 → 值`（这一个动作的）。
   *
   * 语义与绑定值同一档：模型不许写（写了在判决校验那层就被拒了），执行时
   * 由这里注入最终参数。
   */
  fixed?: Readonly<Record<string, unknown>>
}

export interface ExecuteActionResult {
  action: Action
  /** 是否因为幂等键命中而跳过。 */
  skipped: boolean
}

export class ActionRunner {
  readonly #store: Store
  readonly #onWarn: ((message: string) => void) | undefined
  readonly #executeToolScript:
    | ((req: ScriptExecutionRequest) => Promise<ScriptExecutionResult>)
    | undefined
  readonly #now: () => number

  constructor(deps: ActionRunnerDeps) {
    this.#store = deps.store
    this.#onWarn = deps.onWarn
    this.#executeToolScript = deps.executeToolScript
    this.#now = deps.now ?? (() => Date.now())
  }

  async execute(input: ExecuteActionInput): Promise<ExecuteActionResult> {
    const now = this.#now()

    // ── ① 未声明即拒绝（判据是"装没装"，D41）──
    //
    // 动作类型**只能**是 `<包 slug>.<动作名>`：它的类型要在这个工作区**装了**
    // 的包里找得到，它的参数要按 bound/open 二分来判（模型只被要求给 open 那部分）。
    //
    // ⚠️ 未安装的动作 ⇒ 这里就抛"动作不合规"，走既有的失败路径。
    //    绝不放过去让脚本自己去发现——判决引用了不可用的动作，那是
    //    **判决/标准**的问题，必须当场说清。
    const loaded = await this.#loadTools(input.workspaceId)
    const facts = await this.#factsFor(input)

    // ★ 第一步只判**与事实无关**的那两层：类型存不存在、模型给的开放参数
    //   合不合规。绑定（要事实）留到幂等判定之后——因为"同一条判决重放"
    //   应当干净地落 `skipped`，而不该因为环境变了（工作目录被删了）就变成
    //   一条"不合规"，那样幂等这条规矩会以最难看的方式失效。
    const validation = validateActionRefWith(input.ref, {
      tools: loaded.tools,
      // D43：固定参数模型不许写——模型把固定参数名当 open 填进来 ⇒ 这里就拒。
      ...(input.fixed ? { fixed: input.fixed } : {}),
    })
    if (!validation.ok) {
      throw new Error(
        `动作不合规：${[
          ...validation.issues,
          // 工具列表读不到时**说出来**：那会让"这个动作没装"与"我读不到装了
          // 什么"混成同一句话，而两者要修的地方完全不同。
          ...(loaded.error !== null ? [`（读取已安装的工具包失败：${loaded.error}）`] : []),
        ].join('；')}`,
      )
    }

    const definition = resolveActionDefinition(input.ref.type, loaded.tools)
    if (!definition) {
      // 校验刚过 ⇒ 定义必然在。真走到这里说明两个判据漂移了，那就明确炸。
      throw new Error(`动作定义解析失败：${input.ref.type}（校验与解析的判据不一致）`)
    }

    // ── ② 幂等：键含 verdictId ──
    //
    // 键只用 `input.ref.params`（判决里那份）：键的语义是"同一条判决重放要
    // 跳过"，而绑定值是从**当前**事实算出来的——把它并进键里，同一条判决在
    // run 状态变了之后会被算成"另一条动作"，幂等就失效了。
    const idempotencyKey = actionIdempotencyKey({
      verdictId: input.verdictId,
      type: input.ref.type,
      params: input.ref.params,
    })

    const existing = await this.#store.findActionByIdempotencyKey(idempotencyKey)
    if (existing) {
      // 已执行过 ⇒ 明确记 skipped，而不是"看起来又成功了一次"
      await this.#store.transitionAction(existing.id, 'proposed', 'skipped')
      return { action: { ...existing, status: 'skipped' }, skipped: true }
    }

    // ── ③ 最终参数 = 模型给的 open + 平台绑的 bound + 使用者的固定参数 ──
    const merged = mergeActionParams(definition, facts, input.ref.params, input.fixed)
    if (!merged.ok) {
      // 这里刻意沿用"不合规"这个前缀：它说的是**平台现在没条件执行这条
      // 动作**（工作目录还没分配、subject 不是 issue），与模型写错参数
      // 走同一条失败路径——都要可见、都不能静默。
      throw new Error(`动作不合规：${merged.issues.join('；')}`)
    }
    const finalParams = merged.params

    const action: Action = {
      id: ulid(now) as Action['id'],
      workspaceId: input.workspaceId,
      verdictId: input.verdictId,
      type: input.ref.type,
      plane: definition.plane,
      // 记**最终参数**（含平台绑定的那部分）：审计要回答的是"到底拿什么去执行的"。
      params: finalParams,
      status: 'proposed',
      idempotencyKey,
      dryRun: input.dryRun === true,
      result: null,
      error: null,
      rollbackRef: null,
      createdAt: now,
      finishedAt: null,
    }
    await this.#store.insertAction(action)

    // ── ④ 默认自动批准 ──
    await this.#store.transitionAction(action.id, 'proposed', 'auto_approved')

    // ⚠️ dry-run **也走这条路**：约定是脚本自己保证"dry-run 时不改"，所以
    //    `dryRun: true` 原样透传给脚本，由它描述"我打算改什么"。
    //    （内置动作时代这里有一条"dry-run 不执行、只记下 wouldDo"的分支——
    //    那是平台自己实现动作才做得到的事，随内置动作一起没了。）
    await this.#store.transitionAction(action.id, 'auto_approved', 'executing')

    try {
      // ★ 准入：声明「不支持 dry-run」的动作**默认不自动执行**（D40）。
      //
      //   工具包里的脚本是第三方代码，它会在使用者机器上真的改东西；能先演练
      //   一遍（dry-run）是唯一便宜到人人都会用的"先看一眼"的手段。作者在清单里
      //   写 `unsupported` 就是在说"我保证不了"。所以默认**不放行**，要放行得有人
      //   在 workspace 上显式打开（`allowUnpreviewedActions`，界面有警告）。
      //
      //   ⚠️ 这条必须在这里真的拦下，不能只写在界面上：界面上写着"不能自动执行"
      //      而平台照跑，那是在骗使用者——比没有这条规矩更糟。
      //   ⚠️ dry-run 本身（`input.dryRun === true`）不走这条：那次调用不会改东西，
      //      执行器会在演练模式下拒绝 `unsupported` 的动作并说明原因。
      if (definition.dryRun === 'unsupported' && input.dryRun !== true) {
        const allow = await this.#allowsUnpreviewed(input.workspaceId)
        if (!allow) {
          throw new Error(
            `动作 ${input.ref.type} 声明不支持 dry-run（工具包 ${definition.provider.slug} 的清单里写的是 "unsupported"），` +
              `所以平台默认不自动执行它。两条出路：让这个工具包实现 dry-run；` +
              `或者在「工具」页显式打开「允许自动执行不支持预演的动作」（会同时降低这一类动作的安全保证）。`,
          )
        }
      }

      const result = await this.#runToolAction(input, definition, finalParams, facts, loaded.tools)
      await this.#store.transitionAction(action.id, 'executing', 'executed', {
        result,
        finishedAt: this.#now(),
      })
      return { action: { ...action, status: 'executed', result }, skipped: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.#store.transitionAction(action.id, 'executing', 'failed', {
        error: message,
        finishedAt: this.#now(),
      })

      // ★ 失败不得静默 —— 进通知中心
      await this.#notify({
        workspaceId: input.workspaceId,
        type: 'action.failed',
        severity: 'action_required',
        title: `动作失败：${definition.describe(finalParams)}`,
        body: message,
        issueId:
          typeof input.ref.params['issueId'] === 'string'
            ? (input.ref.params['issueId'] as Issue['id'])
            : null,
        runId: input.runId,
      })

      return { action: { ...action, status: 'failed', error: message }, skipped: false }
    }
  }

  /**
   * 这个工作区**允许**自动执行"不支持 dry-run"的工具动作吗（D40）。
   *
   * 读不到 workspace（极罕见：store 出错）时按 **false** 处理——更严的那一边。
   * 反过来（默认放行）会让"读不到"变成一次静默的安全降级。
   */
  async #allowsUnpreviewed(workspaceId: WorkspaceId): Promise<boolean> {
    try {
      const workspace = await this.#store.getWorkspace(workspaceId)
      return workspace?.allowUnpreviewedActions ?? false
    } catch (err) {
      this.#onWarn?.(`读取 workspace 设置失败，按"不允许自动执行不支持预演的动作"处理：${String(err)}`)
      return false
    }
  }

  /**
   * 这个工作区装了哪些工具包。
   *
   * 读不到时**返回错误而不是空表**：两者对调用方的意思完全不同——
   * "一个都没装"是正常的，"读不到"是存储出了问题，而它们的症状都是
   * "这个动作不可用"。把错误带出去，通知里才能说清该去查哪儿。
   */
  async #loadTools(
    workspaceId: WorkspaceId,
  ): Promise<{ tools: Tool[]; error: string | null }> {
    try {
      const listTools: unknown = this.#store.listTools
      if (typeof listTools !== 'function') {
        return { tools: [], error: '这个存储适配器还没有实现 listTools' }
      }
      return { tools: await this.#store.listTools(workspaceId), error: null }
    } catch (err) {
      return { tools: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 绑定参数要用的事实。
   *
   * ★ 从 **run 自己**读，不从判决的参数里读。
   *
   * `ref.params['issueId']` 是**模型写的**——那是一句话，不是事实。
   * 绑定参数存在的全部意义就是让"误操作到别的 issue"从结构上不可能，
   * 所以 `subject.issueId` 只能来自 run 的 subject。
   */
  async #factsFor(input: ExecuteActionInput): Promise<ActionFacts> {
    const run = input.runId === null ? null : await this.#store.getRun(input.runId)
    return {
      issueId: run !== null && run.subject.type === 'issue' ? run.subject.id : null,
      runId: input.runId,
      workspaceId: input.workspaceId,
      workdir: run?.workDir ?? null,
    }
  }

  async #notify(
    item: Omit<InboxItem, 'id' | 'read' | 'createdAt'>,
  ): Promise<void> {
    const now = this.#now()
    await this.#store.appendInboxItem({
      ...item,
      id: ulid(now),
      read: false,
      createdAt: now,
    })
  }

  /**
   * 跑一个工具动作。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这一步只执行；成败的语义留给 `ScriptExecutor`
   * ══════════════════════════════════════════════════════════════════
   *
   * 执行器回答的是"脚本做了什么"（退出码、stdout 里那句话、超时没有）；
   * 这里把它翻成动作的成败：`ok: false` ⇒ 抛错 ⇒ `execute()` 记 `failed`
   * 并发通知（FR-ACTION-08）。**失败不静默**这条不能靠脚本自觉。
   *
   * `rollbackRef` 一律不给：脚本改了什么，平台并不完全知道，
   * 编一个看起来能回滚的引用比没有更糟——回滚时会失败，而人以为它成功过。
   */
  async #runToolAction(
    input: ExecuteActionInput,
    definition: ToolActionDefinition,
    params: Record<string, unknown>,
    facts: ActionFacts | null,
    tools: readonly Tool[],
  ): Promise<Record<string, unknown>> {
    if (!this.#executeToolScript) {
      throw new Error(
        `动作 ${definition.type} 属于工具包 ${definition.provider.slug}，但 daemon 没有注入脚本执行器——` +
          `这一版只会执行工具动作（D41：内置动作已经全部移除），所以这是装配错误：` +
          `装配处见 apps/daemon/src/script-executor.ts。`,
      )
    }

    const tool = tools.find((t) => String(t.id) === definition.provider.toolId)
    if (!tool) {
      throw new Error(
        `动作 ${definition.type} 的工具包 ${definition.provider.slug} 已经不在这个工作区里了` +
          `（动作定义与已安装列表对不上）——请重新安装它，或把引用它的审核标准改掉。`,
      )
    }

    const result = await this.#executeToolScript({
      action: {
        type: definition.type,
        slug: definition.provider.slug,
        runtime: definition.runtime,
        entry: definition.entry,
        timeoutMs: definition.timeoutMs,
        dryRun: definition.dryRun,
      },
      params,
      dryRun: input.dryRun === true,
      context: {
        // 上下文里的 workdir 来自 run 事实（不是模型给的），与绑定参数同源
        workdir: facts?.workdir ?? null,
        runId: input.runId,
        workspaceId: input.workspaceId,
      },
      files: tool.files,
    })

    if (!result.ok) throw new Error(result.detail)

    return {
      ok: true,
      detail: result.detail,
      exitCode: result.exitCode ?? null,
      durationMs: result.durationMs,
      dryRun: input.dryRun === true,
    }
  }
}

// ⚠️ `isToolActionDefinition` 仍然从 `@alpha-helper/domain` 导出（它守的是
//    "这份定义带不带 provider"），但这里已经不需要它：D41 之后
//    `resolveActionDefinition` 的返回类型**就是** `ToolActionDefinition | null`，
//    再判一次只是把一个编译期已知的事实在运行时重说一遍。
