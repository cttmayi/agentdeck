/**
 * **平台动作注册表**（2026-11，D148）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这张表回答什么
 * ══════════════════════════════════════════════════════════════════
 *
 * 平台有五个"自己发起的动作"（不是使用者点「新建任务」那种业务 run）：
 *
 *   | id（= run 的 subject.type 或采纳路由名） | 谁干（平台成员） | 人按哪一下 |
 *   |---|---|---|
 *   | `skill-draft`     | 沉淀起草者   | 沉淀页「开始起草」           |
 *   | `memory-tidy`     | 记忆整理者   | 聊天页「整理记忆」           |
 *   | `agent-commit`    | 智能体生成者 | 聊天页「确认生成智能体」     |
 *   | `workflow-commit` | 编排生成者   | 聊天页「确认采纳编排」       |
 *
 * 写下来之前，这些事实**散在四个 handler 里**：谁读哪个目录、把产出写在哪、
 * 采纳那一步走哪条路由——每条都要靠人读代码才知道。加一个动作要改四处，
 * 而且"改漏一处"不报错（`MEMBER_ACTION_IDS` 与 `PLATFORM_MEMBER_ENTRIES`
 * 就是两处各写一份、必须手工同步的例子）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界：这张表**只**回答"谁能叫它、素材与产出在哪、采纳走哪条路"
 * ══════════════════════════════════════════════════════════════════
 *
 * 不回答"叫了之后怎么干"——那仍然在各自动作的 handler 里（产出是四种完全不同的
 * 业务对象：skill 文件 / 记忆候选 JSON / 岗位卡 / 编排代码）。属性与注册表负责
 * "**入口与接口**"，实现留在实现处；把实现塞进来的那一刻，这张表就会变成一个
 * 谁也不敢改的上帝对象。
 *
 * ══════════════════════════════════════════════════════════════════
 * 幂等来源：路径常量从这里出去，路由字符串被**判据**钉住
 * ══════════════════════════════════════════════════════════════════
 *
 * · 素材 / 产出的**路径**：这里是**定义处**，`server.ts` 等调用方从这里 import
 *   （少一处字面量，就少一处能漂的地方）。
 * · **采纳路由**：不少是参数的（`/api/agents/:id` 那一条是写记忆），没法直接当常量
 *   用，所以 `server.ts` 里保留字面量，由 `platform-actions.test.ts` **逐行比对**
 *   "这一行写的路由真的在代码里出现"——改名不同步就红（这是本仓库对付"清单与代码
 *   两张皮"的老办法）。
 */

import type { BuiltinKind } from './builtin-drafter.ts'
import { AGENT_DRAFT_DIR, AGENT_DRAFT_FILE } from './agent-maker.ts'
import { WORKFLOW_DRAFT_DIR, WORKFLOW_DRAFT_FILE } from './workflow-maker.ts'

/* ══════════════════════════════════════════════════════════════════
 * 素材文件名（**定义处**，调用方从这里 import）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 「整理记忆」那一步平台替它准备的素材（写进这条对话的专用分析目录）。
 *
 * ⚠️ 这两个名字会出现在**指令正文**里（"你只读 `transcript.md`"）——改这里必须
 *    同时改身份文本，否则模型会去找一个不存在的文件（`memory-tidy.test.ts` 钉着
 *    指令里提到这两个名字这件事）。
 */
export const MEMORY_TRANSCRIPT_FILE = 'transcript.md'
export const MEMORY_EXISTING_MEMORY_FILE = 'existing-memory.md'

/** 起草那一步的素材目录（沉淀页收集的材料都落在这儿）。 */
export const DRAFT_MATERIAL_DIR = 'material'
/** 起草那一步的产出目录（`skill/` 下可以有多份文件 + 一份 SKILL.md）。 */
export const DRAFT_ARTIFACT_DIR = 'skill'

/* ══════════════════════════════════════════════════════════════════
 * 表
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一个平台动作。
 *
 * ⚠️ **一个动作只有一个执行者**。同一件事认两个成员，就会出现"到底是谁写的"
 *    说不清、以及两边的技能/指令慢慢分叉。（曾经 `agent-draft` 与 `agent-commit`
 *    分开两行，认为"产卡"与"落库"是两个动作——但前者**从未产出过任何 run**，见下面
 *    `agent-commit` 上面那段注释。）
 */
export type PlatformAction = {
  /** = run 的 `subject.type`（有 run 的动作）或采纳路由名（纯采纳的动作）。 */
  id: PlatformActionId
  /** 谁执行它（= 哪个平台成员，`builtinKind`）。 */
  member: BuiltinKind
  /**
   * 人按的是哪一下（页面标识 + 那一下在哪）。
   *
   * ⚠️ 不写界面文案：文案在 `packages/i18n`，这里再抄一份就是两个出处。
   *    这里只记录"入口在哪个页面"，够用了。
   */
  startFrom: { page: 'crystallize' | 'chat'; where: string }
  /**
   * 平台替它准备的素材（相对工作目录；空数组 = 素材在对话里，没有文件）。
   */
  material: readonly string[]
  /**
   * 产出写在哪（相对工作目录）。`file` 缺省 = 整个 `dir` 都是产出。
   *
   * `null` = **这份产出不是文件**（「整理记忆」的候选是回复正文里的 JSON）。
   * ⚠️ 这里只放**机器能用**的路径：给人读的说明放 `note`，不要混进来——
   *    混进来之后判据就没法逐行比对"这个路径代码里真的有"（第一版就是这样栽的）。
   */
  produce: { dir: string; file?: string } | null
  /** 给人读的一句话补充（不参与任何判据）。 */
  note?: string
  /**
   * 采纳那一步：走哪条路由、以及"采纳之前必须过哪几关"。
   *
   * `route === null` 表示这个动作**没有单独的采纳接口**（产出直接落库或直接读）。
   */
  adopt: { route: string | null; steps: readonly string[] }
}

export type PlatformActionId =
  | 'skill-draft'
  | 'memory-tidy'
  | 'agent-commit'
  | 'workflow-commit'

/**
 * 五个动作的**唯一清单**。
 *
 * 加一个平台动作 = 这里加一行 + 写它的 handler + 给执行者一条 `action:<id>` 入口
 * （后者由下面 `actionEntriesFor()` 自动派生，不用手工加）。
 */
export const PLATFORM_ACTIONS: readonly PlatformAction[] = [
  {
    id: 'skill-draft',
    member: 'drafter',
    startFrom: { page: 'crystallize', where: '「开始起草」' },
    material: [DRAFT_MATERIAL_DIR],
    note: '素材 = 使用者在沉淀页收集/追加的反馈，都落在 material/ 下。',
    produce: { dir: DRAFT_ARTIFACT_DIR },
    adopt: {
      route: '/api/crystallize/commit',
      steps: [
        '只认产出文件本身（files 由服务端现解析 frontmatter）',
        'findSkillMd 再认一次 SKILL.md 在哪（不信任客户端）',
        'validateArtifactFiles + resolvePayloadEntry（与安装同一关）',
        '落库 + git 版本管理（没有 git 就只落库）',
      ],
    },
  },
  {
    id: 'memory-tidy',
    member: 'memory-tidy',
    startFrom: { page: 'chat', where: '「整理记忆」' },
    material: [MEMORY_TRANSCRIPT_FILE, MEMORY_EXISTING_MEMORY_FILE],
    // 产出**不落文件**：候选是回复正文里的 JSON 数组（平台解析后逐条给人勾）。
    produce: null,
    note: '产出是回复正文里的 JSON 数组；平台解析后逐条给人勾选。',
    adopt: {
      // 没有单独的采纳接口：写记忆是 `PATCH /api/agents/:id` 的记忆差量。
      route: null,
      steps: [
        '逐条勾选（勾上的才写）',
        '出处核对（quote 必须在 transcript 里找得到）',
        '写记忆（PATCH /api/agents/:id 的 memory 差量）',
      ],
    },
  },
  /*
   * ⚠️ 2026-11（D155）：这里原来有一行 `agent-draft`（"智能体生成者写岗位卡的那条 run"）。
   *   **它是死接口**：`SubjectRef` 枚举里有它、`workdir.ts` 给它留了目录名映射，
   *   但**没有任何代码产出这种 run**——生成者的"写岗位卡"发生在一条**普通聊天 run** 里
   *   （`subject.type = 'conversation'`），产物靠读磁盘上的 `agent-draft/agent-draft.md`。
   *   留着它的唯一后果是：注册表给「智能体生成者」多派了一条 `action:agent-draft` 入口，
   *   于是它身上显示**两个**平台动作徽标（「写岗位卡」+「确认生成智能体」），
   *   而「编排生成者」只有一个——使用者一句"为什么有 2 个平台动作？"就把这处不一致问了出来。
   *   删掉之后两个生成者都是**一个**动作（各自的"采纳"那一半），语义也对了：
   *   **起草发生在聊天里，不是一条独立的平台动作。**
   */
  {
    id: 'agent-commit',
    member: 'agent-maker',
    startFrom: { page: 'chat', where: '「确认生成智能体」' },
    material: [],
    produce: { dir: AGENT_DRAFT_DIR, file: AGENT_DRAFT_FILE },
    adopt: {
      route: '/api/conversations/:id/agent-commit',
      steps: [
        '只有生成者的对话能采纳（别的 agent 摆一份草稿不算"生成"）',
        '解析岗位卡 frontmatter',
        '技能校验（与安装同一关）',
        '建智能体（`owner: user`，入口三项全开）',
      ],
    },
  },
  {
    id: 'workflow-commit',
    member: 'workflow-maker',
    startFrom: { page: 'chat', where: '「确认采纳编排」' },
    material: [],
    produce: { dir: WORKFLOW_DRAFT_DIR, file: WORKFLOW_DRAFT_FILE },
    adopt: {
      route: '/api/conversations/:id/workflow-commit',
      steps: [
        '以请求里的最终版为准（人可能改过代码）',
        '语法走 `validateWorkflowCode`（只构造不调用）',
        "`agent('名字')` 必须是现存且可被编排引用的智能体",
        '名字非空且 ≤100 字符',
      ],
    },
  },
]

/* ══════════════════════════════════════════════════════════════════
 * 派生（其余一切从这里读，不要再各写一份）
 * ══════════════════════════════════════════════════════════════════ */

/** 全部动作 id（顺序 = 表中顺序）。`MEMBER_ACTION_IDS` 就是它——**派生，不手写**。 */
export const PLATFORM_ACTION_IDS: readonly PlatformActionId[] = PLATFORM_ACTIONS.map((a) => a.id)

/**
 * 某个平台成员该有哪几条 `action:<id>` 入口（**派生**，不手写）。
 *
 * ⚠️ 这就是这张表存在的第一个理由：原来 `PLATFORM_MEMBER_ENTRIES` 里那五条
 *    `action:` 与 `MEMBER_ACTION_IDS` 是**两处各写一份**、必须手工同步；漏一处
 *    的后果不是报错，而是"这个成员明明有这条动作，却谁也不许调它"。
 */
export function actionEntriesFor(
  kind: BuiltinKind,
): Array<`action:${PlatformActionId}`> {
  return PLATFORM_ACTIONS.filter((a) => a.member === kind).map(
    (a) => `action:${a.id}` as `action:${PlatformActionId}`,
  )
}

/** 某个动作的执行者（找不到就 null——加动作时漏填 `member` 会在这里露出来）。 */
export function memberOfAction(id: PlatformActionId): BuiltinKind | null {
  return PLATFORM_ACTIONS.find((a) => a.id === id)?.member ?? null
}
