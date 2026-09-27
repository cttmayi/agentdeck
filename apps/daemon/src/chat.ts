import type { Store } from '@agentdeck/domain'
import type {
  Agent,
  ChatTurn,
  Conversation,
  RunId,
  Skill,
  SkillPayload,
  SubmitRunRequest,
} from '@agentdeck/protocol'
import { ulid } from '@agentdeck/protocol'
import type { RunExecutor } from './executor.ts'
import { resolveWorkDir } from './workdir.ts'

/**
 * 聊天那一轮的服务端逻辑。
 *
 * 单独成文件而不是塞在 `server.ts` 的路由里，理由只有一个：**这段逻辑要有测试**。
 * `server.ts` 里的东西只能靠起一个真 daemon 来验，而这里真正容易错的部分
 * （标题怎么取、目录怎么算、失败之后那条记录长什么样）全是纯逻辑，值得单独钉住。
 */

// ══════════════════════════════════════════════════════════════════
// 标题
// ══════════════════════════════════════════════════════════════════

/** 标题最长这么多个字（协议里 `Conversation.title` 的上限是 200）。 */
export const TITLE_MAX = 60

/**
 * 从第一句话里取一个标题。
 *
 * 三条规则，各自都在挡一种具体的难看结果：
 *
 *   1. **只取第一个非空行**——使用者常常第一行是"帮我看看"，第二行才是正题；
 *      整段塞进列表会把侧栏撑成一面墙。
 *   2. **压掉行内的连续空白**——第一行里有换行残留或一堆空格时，标题会出现
 *      莫名其妙的空档，看起来像渲染坏了。
 *   3. **超长截断并留一个省略号**——截断不留痕时，"标题"与"我说的话"看起来
 *      是同一个东西，而它们不是（一个是索引，一个是原文）。
 *
 * 纯函数（有测试钉着）：标题是**数据**，它一旦写进去就不该随渲染环境变。
 */
export function titleFromText(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  const flat = line.replace(/\s+/g, ' ').trim()
  if (flat === '') return '对话'
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat
}

// ══════════════════════════════════════════════════════════════════
// 说一轮
// ══════════════════════════════════════════════════════════════════

export interface ChatTurnOutcome {
  conversation: Conversation
  turn: ChatTurn
  runId: RunId | null
  /**
   * 没跑起来时的种类；跑起来了是 `null`。
   *
   * 路由据它决定 HTTP 状态码：`no_capacity` ⇒ 429 + `retry-after`
   * （与 `POST /api/runs` 同一口径），`error` ⇒ 500。
   */
  failure: 'no_capacity' | 'error' | null
  retryAfterMs?: number
}

/**
 * 一条 skill 载荷。
 *
 * ⚠️ 这份映射与 `POST /api/runs` 里那段是**同一件事**（那边是内联的）。
 *    不共用是因为那边那段夹在 300 行的校验里、抽出来要动它；而**漏掉它**的
 *    后果是这里已经踩过一次的坑：`skills` 省略 ⇒ 执行器按 `[]` 处理 ⇒
 *    一个 skill 也没注入，agent 用它自己的默认行为跑，正常完成、结果不对。
 *    所以这里宁可重复一遍，也不省略这个字段。
 */
function skillPayload(skills: readonly Skill[]): SkillPayload[] {
  return skills.map((s) => ({
    ref: { id: s.id, slug: s.slug, source: s.source },
    slug: s.slug,
    name: s.name,
    body: s.body,
    ...(s.description ? { description: s.description } : {}),
    files: s.files ?? {},
  }))
}

/**
 * 这一轮要注入的 skill：**执行者自己挂的 ∪ 对话自己带的**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是并集，不是"对话带的说了算"
 * ══════════════════════════════════════════════════════════════════
 *
 * 执行者身上那些 skill 是**它的一部分**（"这个执行者是干什么的"），不是这次
 * 对话给它加的选项。让对话那份盖掉它，等于使用者只是挑了一条 skill，就把这个
 * 执行者原来的能力悄悄削掉了——而界面上没有任何地方会显示"少了两条"。
 *
 * 反过来，对话带的那条（`Conversation.skillIds`）是"所有已安装的 skill 都要
 * 能选"逼出来的：挂在某人身上的 skill 走"选它 = 选那个人"，没人挂的只能由对话
 * 自己带着。两者语义不同，所以相加。
 *
 * ⚠️ 按 id 去重：同一条 skill 既挂在执行者身上、又被对话带上时只注入一次
 *    （注入两次的后果是那份 SKILL.md 在上下文里出现两遍）。
 * ⚠️ 查不到的 id（skill 后来被卸了、记录里留着旧 id）**跳过**，不是报错：
 *    那条对话该照常能说话，而不是因为一条早已不在的 skill 卡死。
 */
async function loadTurnSkills(
  store: Store,
  agent: Agent,
  conversationSkillIds: readonly string[],
): Promise<Skill[]> {
  const all = await store.listSkills(agent.workspaceId)
  const byId = new Map(all.map((s) => [s.id as string, s]))
  const ids = [...agent.skillIds, ...conversationSkillIds]
  const out: Skill[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const key = id as string
    if (seen.has(key)) continue
    seen.add(key)
    const skill = byId.get(key)
    if (skill) out.push(skill)
  }
  return out
}

/**
 * 追加一轮对话，并把它换成一条 run。
 *
 * ══════════════════════════════════════════════════════════════════
 * 顺序是刻意的：**先记下"我说了这句话"，再去建 run**
 * ══════════════════════════════════════════════════════════════════
 *
 * 反过来（先建 run 再记轮次）有两个坏结果，都发生在中间那一步失败时：
 *
 *   - run 建起来了但轮次没记下 ⇒ 一条**没人认领的 run**：它会在成本与审计里
 *     出现，却不在任何对话里，而且它的 `resumeFromRunId` 链条从此断掉；
 *   - 界面刷新之后使用者那句话**消失了**——这是最不能接受的一种：他明明说了。
 *
 * 按这个顺序，失败时留下的是"一条没有 run 的轮次"，而它**看得见**
 * （界面上会明说这一轮没跑起来、原因是什么），也**不挡后续**（下一轮会往回
 * 找到最近一条带 run 的轮次去接上文）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个对话在哪个目录里跑
 * ══════════════════════════════════════════════════════════════════
 *
 * 由这里**算定**再显式传给执行器，而不是留给执行器的优先级链去决定：
 * 那段文字里要写出工作目录（模型据此知道"它能不能动你的东西"），而
 * "写出来的目录"与"真的用的目录"必须是同一个。两处各算一次，迟早会分叉。
 *
 * `conversation.workDir` 为 null ⇒ 走 `resolveWorkDir` 的自动分配，得到
 * `<workRoot>/chat-<对话 id>`（`SUBJECT_PREFIX.conversation = 'chat'`）。
 * ⚠️ 注意这里**不**传 `agentDefault`：聊天的目录是对话的属性，不是 agent 的。
 *    想让某个对话落在某个仓库里，就改这个对话的目录（界面上的那个输入框）。
 */
export async function submitChatTurn(
  store: Store,
  executor: RunExecutor,
  conversation: Conversation,
  agent: Agent,
  text: string,
  now: number,
  workRoot: string,
): Promise<ChatTurnOutcome> {
  // ★ 上文的延续：拿**最近一条带 run 的**轮次去 resume。最后那一轮可能因为
  //   没抢到并发位而没有 run（见上面的顺序），此时要往回找一条——否则一次
  //   失败会把整个对话的上文切断。
  const previous = await store.lastChatTurnWithRun(conversation.id)
  const previousRun = previous?.runId ? await store.getRun(previous.runId) : null

  const dir = resolveWorkDir({
    requested: conversation.workDir,
    subject: { type: 'conversation', id: conversation.id },
    fallbackId: conversation.id,
    workRoot,
  }).path

  const seq = maxSeq(await store.listChatTurns(conversation.id)) + 1
  const turn: ChatTurn = {
    id: ulid() as ChatTurn['id'],
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    seq,
    userText: text,
    runId: null,
    createdAt: now,
    error: null,
  }
  await store.insertChatTurn(turn)

  const runId = ulid() as RunId
  const request: SubmitRunRequest = {
    runId,
    kind: 'execute',
    agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
    skills: skillPayload(
      await loadTurnSkills(store, agent, conversation.skillIds ?? []),
    ),
    // ★ 这一轮属于一个**对话**，不属于任务。报告摄取只认 issue/report/run，
    //   所以这条 run 结构上到不了判决——聊天不进闭环不是靠约定，是靠这条路不存在。
    subject: { type: 'conversation', id: conversation.id },
    // ★★ 原样投递使用者那句话——**不套第一句话模版**（执行与审核那两份都不套）。
    //
    //   任务是"被交代一件事"，所以要模版：身份、材料、技能清单、护栏、判决契约，
    //   那是一份工作说明书。聊天不是，聊天就是说话。
    //   拿掉它的直接理由有两条，都来自实测：
    //     · 模版收尾那句「完成后给出一份报告」在投递里排在正文**后面**，所以它
    //       才是模型真正照做的那句——聊天第一轮的回答开头是「**我做了什么**」；
    //       而"报告"在聊天里没有收件人，也没有那条路（subject 是 conversation）。
    //     · run/subject 元信息、「请用简体中文回答」这类话每轮都投一遍、每轮都
    //       付钱，而对一个聊天窗口来说全是噪音。
    //
    //   ⚠️ 代价要说清：`Agent.instructions` 也不再有投递通道（任务那条路上它由
    //      模版的 `{{instructions}}` 送出去）。这是**有意的**——那段文字是按任务
    //      场景写的（"先理解任务，再动手""报告要写清楚结论"），套进聊天正好把
    //      要去掉的那套语气带回来。选智能体在聊天里仍然决定 runtime 与技能。
    prompt: text.trim(),
    workDir: dir,
    limits: { maxTurns: null, timeoutMs: null },
    // ★ 三个字说明白整件事：`null` = **这一次明确不自动审**（协议里的三态）。
    //   省略它则是"按 agent 配置走"，那会让聊天跑完弹出一条审核 run——
    //   而聊天本来就不产出判决，审它是审什么？
    reviewerAgentId: null,
    ...(previousRun ? { resumeFromRunId: previousRun.id } : {}),
  }

  let failure: ChatTurnOutcome['failure'] = null
  let errorText: string | null = null
  let retryAfterMs: number | undefined

  try {
    const outcome = await executor.submit(request)
    if (outcome.kind === 'rejected') {
      failure = 'no_capacity'
      retryAfterMs = outcome.retryAfterMs
      errorText =
        '没有空闲的执行位（同时能跑的 run 有上限），这一轮没有跑起来。稍后再发一次。'
    }
  } catch (err) {
    failure = 'error'
    errorText = err instanceof Error ? err.message : String(err)
  }

  // ⚠️ `insertChatTurn` 是 upsert（日志按 id 覆盖），所以这里是**改**刚写的那条，
  //   不会多出一条记录。这样写而不是"先算好再写一次"，是因为那条记录必须在
  //   建 run **之前**就落盘（见上面那段顺序说明）。
  const finalTurn: ChatTurn =
    failure === null ? { ...turn, runId } : { ...turn, error: errorText ?? '这一轮没有跑起来' }
  await store.insertChatTurn(finalTurn)
  const updatedConversation =
    (await store.updateConversation(conversation.id, {
      lastTurnAt: now,
      updatedAt: now,
      turnCount: seq,
    })) ?? conversation

  return {
    conversation: updatedConversation,
    turn: finalTurn,
    runId: failure === null ? runId : null,
    failure,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

/**
 * 下一个序号。
 *
 * ⚠️ 用**最大值 + 1** 而不是 `length + 1`：轮次是允许有洞的（一条轮次的 run
 *    可能被手工清理掉），而 `length + 1` 在有洞时会撞上已经用过的 seq——
 *    撞了的后果是回看时两轮**排在一起**，看起来像同一次发言。
 *
 * ⚠️ 它不是并发安全的（两个人同时发同一条对话会拿到同一个 seq）。这里不修：
 *    界面上输入框在跑的时候是禁用的、服务器上同一目录的 run 本来就会串行排队，
 *    真的并发到了也只是序号重复、不是数据丢失。要修的话该修在存储层
 *    （一个原子的 "max+1"），而不是在这里加锁假装解决了。
 */
function maxSeq(turns: readonly ChatTurn[]): number {
  let max = 0
  for (const t of turns) if (t.seq > max) max = t.seq
  return max
}
