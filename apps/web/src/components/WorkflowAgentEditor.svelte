<script lang="ts">
  /**
   * **编排内建智能体的编辑页**（2026-11，D237/D238）——**薄壳**。
   *
   * 使用者："页面要和编排的新建智能体要和智能体的新建智能体页面一致，**最好复用**。
   * 另外，编排智能体也一样"。
   *
   * 所以这一页自己不画控件，只做两件事：
   *   ① 把 `WorkflowInlineAgent` 适配成 `Agent` 形状（表单组件的入参）；
   *   ② 挂上 `AgentForm`（D249：新建与编辑是**同一个组件**，`mode` 决定），并负责
   *      "保存/删除之后回编排"。
   *
   * 复用带来的**一致性**是白拿的：栏头、名字（卡片第一格）、指令（`PromptField`）、
   * 技能勾选、独有技能、记忆格、目录一节、脏态置灰、重名错误原话——全部与智能体页
   * 同一份代码。差异只有使用者点名的那几处（入口锁死「编排」、独有技能只读、返回按钮常驻）。
   *
   * ⚠️ Svelte 5 legacy 模式（与 Workflows.svelte 同款约束）：不引 runes。
   */
  import { onMount } from 'svelte'
  import { api, type Agent, type Workflow, type WorkflowInlineAgent } from '../lib/api.ts'
  import { workflows } from '../lib/stores.ts'
  import { t, tx } from '../lib/i18n.ts'
  import AgentForm from './AgentForm.svelte'
  import { blankAgent } from '../lib/agent-blank.ts'
  import MainArea from './MainArea.svelte'

  export let workflowId: string
  /** `'new'` = 新建；否则是内建智能体的 id。 */
  export let agentId: string
  /** 保存/删除之后怎么回去（由页面决定：切地址 + 记住"回到哪条编排"）。 */
  export let ondone: () => void = () => {}

  let wf: Workflow | null = null
  let inline: WorkflowInlineAgent | null = null
  let loadError = ''
  let loading = true
  $: isNew = agentId === 'new'
  /** ★ D249：新建态交给 `AgentForm` 的空白智能体（常量，避免每次渲染换对象）。 */
  const blank = blankAgent()
  $: wf = $workflows.find((w) => w.id === workflowId) ?? null

  onMount(async () => {
    try {
      if ($workflows.length === 0) {
        // 直接打开编辑页（新标签 / 刷新）时列表还没拉过
        const out = await api<{ items: Workflow[] }>('/api/workflows')
        workflows.set(out.items ?? [])
      }
      const found = $workflows.find((w) => w.id === workflowId) ?? null
      if (!found) {
        loadError = tx('workflows.agentsWorkflowMissing')
        return
      }
      if (!isNew) {
        const hit = (found.inlineAgents ?? []).find((a) => a.id === agentId) ?? null
        if (!hit) {
          loadError = tx('workflows.agentsMissing')
          return
        }
        inline = hit
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  })

  /**
   * `WorkflowInlineAgent` → `Agent`（编辑页组件的入参）。
   *
   * 只填**它真有的**：名字 / 指令 / 技能 / 入口（固定 `workflow`）。其余字段给中性值
   * （`runtimeKey: 'default'`、`memoryEnabled: false`、`memory: []`）——那两格在编排
   * scope 下不渲染，保存也只发三个字段，所以这些值不会被看到、也不会被写回。
   */
  $: asAgent =
    inline === null
      ? null
      : ({
          id: inline.id,
          workspaceId: '',
          name: inline.name,
          instructions: inline.instructions ?? '',
          // ★ D241：内建智能体自己的 CLI（落在 agent.json；老数据没有 ⇒ 'default'）
          runtimeKey: inline.runtimeKey ?? 'default',
          workDir: null,
          skillIds: [...(inline.skillIds ?? [])],
          env: {},
          entries: ['workflow'],
          memory: [],
          memoryEnabled: false,
          reviewStandard: null,
          createdAt: inline.createdAt ?? 0,
          updatedAt: inline.updatedAt ?? 0,
        } as unknown as Agent)
</script>

<MainArea bodyClass="detail-scroll">
  {#snippet body()}
    {#if loadError}
      <p class="notice bad">{loadError}</p>
    {:else if loading}
      <div class="skeleton skeleton--block"></div>
    {:else if isNew || asAgent}
      <!--
        ★ D249：**新建与编辑是同一个组件**（`AgentForm` + `mode`）。新建态交一份空白
        智能体（只当"还没有库里那一份"的基准，不承载任何请求）。
        ★ 「目录」一节由 `AgentForm` 自己画（`AgentDirSection`：编辑页可用、新建页置灰），
        这一页不再单独兜一层——否则两页结构又会分叉。
      -->
      <!-- ★ D249：新建 ↔ 编辑（地址切换）时重挂——同一个组件复用实例会把上一态
           的草稿带过去（见 `Agents.svelte` 里同一段注释）。 -->
      {#key isNew ? 'create' : agentId}
      <AgentForm
        mode={isNew ? 'create' : 'edit'}
        agent={isNew ? blank : asAgent ?? blank}
        scope={{ kind: 'workflow', workflowId, workflowName: wf?.name ?? '' }}
        onclose={ondone}
        oncreated={ondone}
        onchanged={() => {}}
      />
      {/key}
    {/if}
  {/snippet}
</MainArea>


