<script lang="ts">
  /**
   * CardNode —— 卡片树的**递归渲染器**：拿到一个节点，画成对应的那张卡。
   *
   * ══════════════════════════════════════════════════════════════════
   * 只有一个职责：按 node.kind 分派
   * ══════════════════════════════════════════════════════════════════
   *
   * 四种卡（各自管自己的展开状态，见各组件顶部那几段）：
   *   · `step` / `round` → `ContainerCard`（容器；正文是子卡，递归回来）
   *   · `run`            → `RunCard`（一条 run + 它自己的日志开关）
   *   · `gate`           → `GateCard`（人确认）
   *
   * ⚠️ 递归用**自引用**（Svelte 5 里 `svelte:self` 已废弃，直接 import 自己）。
   * ⚠️ 这个文件里**没有**任何展开状态：状态在卡片自己里，这里只负责"按数据结构画树"。
   *    上一版把展开状态放在 `WorkflowRunView` 的字典里，于是"点上面的卡、下面的卡跟着变"
   *    ——那张"多出来的卡片"就是这么来的。
   */
  import type { CardNode as Node } from '../../lib/workflow-cards.ts'
  import Self from './CardNode.svelte'
  import ContainerCard from './ContainerCard.svelte'
  import RunCard from './RunCard.svelte'
  import GateCard from './GateCard.svelte'

  export let node: Node
  /** gate 卡的动作（只有树里有 gate 卡时才有意义）。 */
  export let gateBusy = false
  export let onconfirmGate: () => void = () => {}
  export let onrejectGate: (feedback: string) => void = () => {}
</script>

{#if node.kind === 'step' || node.kind === 'round'}
  <ContainerCard
    cardKey={node.key}
    variant={node.kind === 'round' ? 'round' : 'step'}
    status={node.status}
    title={node.title}
    stepKind={node.kind === 'step' ? node.stepKind : null}
    runId={node.kind === 'step' ? node.runId : null}
    preview={node.kind === 'step' ? node.preview : ''}
  >
    {#snippet children()}
      {#each node.children as child (child.key)}
        <Self node={child} {gateBusy} {onconfirmGate} {onrejectGate} />
      {/each}
    {/snippet}
  </ContainerCard>
{:else if node.kind === 'run'}
  <RunCard {node} />
{:else}
  <GateCard
    text={node.text}
    busy={gateBusy}
    onconfirm={onconfirmGate}
    onreject={onrejectGate}
  />
{/if}
