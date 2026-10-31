<script lang="ts">
  /**
   * 一条对话消息：`说的人 + 气泡`（聊天页与沉淀页**同一份**）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么抽出来（分批第 194 批，使用者连着两次提同一件事）
   * ══════════════════════════════════════════════════════════════════
   *
   * 「目前沉淀还是显示「起草 run run 01M6… 已完成 完整日志」 更像任务，不像是对话方式」，
   * 改掉 run 抬头之后又说「还是觉得应该像聊天那页的对话方式」——**要的不是文案，是形状**：
   * 聊天页一条消息长这样（`views/Chat.svelte`）：
   *
   *   <article class="turn">
   *     <div class="who faint small">你 / 某个 agent · 用了 3 次工具 · 2 秒</div>
   *     <div class="bubble user">…</div>          ← 人说的话，靠右、底色深一档
   *     <article class="bubble agent markdown">…</article>  ← agent 说的，满宽、Markdown
   *   </article>
   *
   * 而沉淀页有**第二份**自己的形状（`.qa-msg` / `.crystal-msg` / 抽屉分节），第三份在
   * 提问向导里。同一件事三份标记，永远只会有两份是新的——所以这里收成一份。
   *
   * ⚠️ **样式不是抄的、是搬的**：`.bubble` 的圆角用令牌（不用 100px 胶囊——多行文本上会
   *    变成两条夸张的弧线，这个仓库已经因为同一个原因改过一次 chips）、user 靠右 85% 上限、
   *    agent 满宽。两页共用这一份定义，改一次两处都对。
   *
   * 内容三种来源，按传进来的那个画：
   *   · `html`（已渲染的 Markdown，调用方负责先转义再拼标签，见 `lib/markdown.ts`）；
   *   · `text`（纯文本，原样保留换行）；
   *   · `children`（自定义内容，比如实时日志或一串动作）。
   */
  import type { Snippet } from 'svelte'

  let {
    /** 气泡归属：`user` = 人说的（靠右、深一档）；`agent` = 对方说的（满宽）。 */
    role = 'agent',
    /** 气泡上方那行小字（说的人 + 这一轮的统计）。空串 = 不画。 */
    who = '',
    /** 已渲染的 Markdown（**调用方**负责安全：先转义再拼自己的标签）。 */
    html = '',
    /** 纯文本（保留换行；与 `html` 二选一）。 */
    text = '',
    /** 半透明（"正在发出去"那一态）。 */
    pending = false,
    /** 气泡里的自定义内容（有它就不画 `html`/`text`）。 */
    children,
    /** `who` 那一行右侧的动作（比如聊天/沉淀的「停止」——它属于"这一轮"，不属于气泡内容）。 */
    whoExtra,
  }: {
    role?: 'user' | 'agent'
    who?: string
    html?: string
    text?: string
    pending?: boolean
    children?: Snippet
    whoExtra?: Snippet
  } = $props()
</script>

<article class="turn" data-chat-turn data-turn-role={role}>
  {#if who !== '' || whoExtra}
    <div class="who faint small">
      {#if who !== ''}<span>{who}</span>{/if}
      {#if whoExtra}{@render whoExtra()}{/if}
    </div>
  {/if}
  {#if children}
    <div class="bubble {role}" class:pending>{@render children()}</div>
  {:else if html !== ''}
    <article class="bubble {role} markdown" class:pending>{@html html}</article>
  {:else}
    <div class="bubble {role}" class:pending>{text}</div>
  {/if}
</article>

<style>
  .turn {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }

  .who {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  /**
   * ⚠️ 圆角用令牌（8px），不用那种 100px 的"胶囊"：
   *    气泡动辄好几行，大圆角在多行文本上会变成两条夸张的弧线，
   *    看起来像渲染坏了（项目里已经因为同一个原因改过一次 chips）。
   */
  .bubble {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-sm);
    line-height: var(--lh-base);
    white-space: pre-wrap;
    word-break: break-word;
    min-width: 0;
  }

  .bubble.user {
    background: var(--surface-2);
    align-self: flex-end;
    max-width: 85%;
  }

  .bubble.agent {
    background: var(--surface);
  }

  .bubble.pending {
    opacity: 0.6;
  }

  /* Markdown 气泡里不要 pre-wrap——块级元素自己管换行，留着会多出一堆空行 */
  .bubble.markdown {
    white-space: normal;
  }

  .bubble.markdown :global(p) {
    margin: 0 0 var(--sp-2);
  }

  .bubble.markdown :global(p:last-child) {
    margin-bottom: 0;
  }

  .bubble.markdown :global(pre) {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    overflow-x: auto;
  }
</style>
