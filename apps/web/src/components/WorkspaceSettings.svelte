<script lang="ts">
  import { loadTemplateKit, saveFirstSentenceTemplates, templateKit } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import { t, tx } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import Drawer from './Drawer.svelte'
  import FirstSentenceTemplate from './FirstSentenceTemplate.svelte'
  import type { BlockTemplates, FirstSentenceKind, TemplateBlock } from '../lib/api.ts'

  /**
   * 设置（右侧抽屉）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它是一个**装设置的容器**，不只有第一句话
   * ══════════════════════════════════════════════════════════════════
   *
   * 结构按"以后还要往里加"来搭：抽屉里是一串 `.drawer-section`，
   * 每一段是一件独立的事，各写各的说明；底部常驻一个共用的「保存」。
   * 现在只有一段——**第一句话模版**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 第一句话模版是**全局配置**（2026-10 起按「链路 × 块」两排页签）
   * ══════════════════════════════════════════════════════════════════
   *
   * 第一句话是平台交给模型的三块：① 框架（每轮都一样）、② 身份（这个智能体是谁）、
   * ③ 任务（这次要干的事）。执行 / 审核 / 聊天**三条链路各有一套**（材料与判决契约
   * 只有审核那份有，混在一起会让两条链路互相牵制）。
   *
   * 三块的内容仍由平台组装（材料标记、标准合成这些安全件不交给模版），模版只决定
   * **位置、标题与包装**——所以「留空 = 平台默认」永远成立，而"换个 agent 只是换
   * 身份那一块"这件事在 ② 身份框里用 `{{identity}}` 摆放。
   *
   * 它挂在 workspace 上：设一次，**所有 agent 都按它来**（包括已经建好的）。
   * 最初的版本做成了每个 agent 一份，被使用者当场纠正；界面上显示的这份与
   * 执行器投递的那份也因此收在同一个接口上（`current`）。
   */
  export let open = false
  export let onclose: () => void = () => {}

  let tab: FirstSentenceKind = 'execute'
  let block: TemplateBlock = 'frame'

  /** 三块各一份的草稿（空串 = 那一块用平台默认）。 */
  let drafts: Record<FirstSentenceKind, BlockTemplates> = {
    execute: { frame: '', identity: '', task: '' },
    review: { frame: '', identity: '', task: '' },
    chat: { frame: '', identity: '', task: '' },
  }
  /**
   * 初始值**每次打开取一次**（不是"一辈子取一次"）。
   *
   * ⚠️ 取一次是为了"正在编辑时 store 刷新把内容冲掉"（保存之后 store 会刷新，
   *    那一冲会让使用者以为自己写的东西没了）。但"只取一次"曾经写成了一辈子：
   *    `seeded` 设成 true 之后**从来不重置**，于是**第一次打开之后它永远是 true**
   *    —— 取消/关闭之后再打开，框里留着的是上一次**没保存**的草稿，而不是已保存
   *    的值。使用者报的正是这个：「我修改了内容，没有保存直接点关闭，重新打开，
   *    内容没有恢复」。
   *
   * 现在：关掉抽屉就把这件事清掉（连同草稿），下一次打开重新取一遍。
   */
  let seeded = false
  let busy = false
  let error = ''

  const emptyKit = (): BlockTemplates => ({ frame: '', identity: '', task: '' })
  /**
   * ★ 必须**值拷贝**，不能把 `$templateKit.current[kind]` 的引用直接塞进草稿：
   *   草稿是"正在编辑、没保存"的东西，打字会**原地改对象**——引用同一个对象时，
   *   那一改会把 store 里"已保存的那份"也改掉，于是重开设置时读到的是上一次
   *   没保存的草稿（使用者报过"内容没有恢复"）。
   */
  const copyKit = (t?: BlockTemplates): BlockTemplates => ({
    frame: t?.frame ?? '',
    identity: t?.identity ?? '',
    task: t?.task ?? '',
  })

  $: if (open && $templateKit === null) void loadTemplateKit()
  $: if (open && !seeded && $templateKit !== null) {
    drafts = {
      execute: copyKit($templateKit.current.execute),
      review: copyKit($templateKit.current.review),
      chat: copyKit($templateKit.current.chat),
    }
    seeded = true
    error = ''
  }

  /**
   * ★ 关上就丢弃草稿，下一次打开重新取已保存的值。
   *
   * 清空这些行是给"打开时那份配置还没取回来"的窗口用的：那一刻宁可显示占位符，
   * 也不要先闪一段上一次的残稿——"取消之后还留着"正是这个 bug 的样子。
   */
  $: if (!open && seeded) {
    seeded = false
    drafts = {
      execute: emptyKit(),
      review: emptyKit(),
      chat: emptyKit(),
    }
    error = ''
  }

  $: current = drafts[tab][block]
  /**
   * ★ 当前这一页签（链路 × 块）的模版，平台替你调整过什么。
   *
   * 库里的老模版（框架框）里可能还写着退役变量；执行器与这个接口都会先迁移（内容
   * 由平台组装）。所以这里必须**说出来**——否则使用者看到的是一份"写了却不起作用"
   * 的文本，而真正投递的是另一份。
   */
  $: adjustment = $templateKit?.adjustments?.[tab]?.[block] ?? null
  $: adjustedList = (adjustment?.removed ?? []).map((n) => `{{${n}}}`).join('、')
  function setCurrent(next: string): void {
    drafts[tab][block] = next
  }
  function kindDirty(kind: FirstSentenceKind): boolean {
    return (
      drafts[kind].frame.trim() !== '' ||
      drafts[kind].identity.trim() !== '' ||
      drafts[kind].task.trim() !== ''
    )
  }
  const BLOCKS: TemplateBlock[] = ['frame', 'identity', 'task']
  /**
   * 块页签的标签键。⚠️ 不能拼字符串再传给 `$t`：它的参数是**字面量联合**
   *   （`WebTextId`），拼出来的 `string` 过不了类型——字典加键时这里必须同步。
   */
  const BLOCK_TAB_KEY: Record<TemplateBlock, WebTextId> = {
    frame: 'tpl.settings.tabFrame',
    identity: 'tpl.settings.tabIdentity',
    task: 'tpl.settings.tabTask',
  }

  async function save(): Promise<void> {
    busy = true
    error = ''
    try {
      // ★ 九块全发（PATCH 语义：某一块空串 = 回到平台默认）。
      //    `drafts` 是从 `current` 取来的，所以这里发出去的就是界面显示的那份。
      await saveFirstSentenceTemplates({
        execute: drafts.execute,
        review: drafts.review,
        chat: drafts.chat,
      })
      showToast(tx('tpl.settings.savedToast'))
      onclose()
    } catch (err) {
      // 服务端的原文带回来：校验在那边（它是权威），这里不改写它
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

{#if open}
  <Drawer
    {open}
    size="wide"
    title={$t('tpl.settings.title')}
    subtitle={$t('tpl.settings.subtitle')}
    ariaLabel={$t('tpl.settings.title')}
    {onclose}
  >
    <form
      id="settings-form"
      class="settings-form"
      onsubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <!-- ══════════════ 第一句话模版 ══════════════ -->
      <section class="drawer-section">
        <h3>{$t('tpl.settings.sectionTitle')}</h3>
        <p class="hint">
          {$t('tpl.settings.hint.threeBlocks.before')}<strong>{$t('tpl.settings.hint.threeBlocks.strong')}</strong>{$t('tpl.settings.hint.threeBlocks.after')}
          {$t('tpl.settings.hint.blocksPlatform.before')}<strong>{$t('tpl.settings.hint.blocksPlatform.strong')}</strong>{$t('tpl.settings.hint.blocksPlatform.after')}
          <strong>{$t('tpl.settings.hint.emptyMeans')}</strong>{$t('tpl.settings.hint.platformDefault')}
          <br />
          {$t('tpl.settings.hint.isGlobal')}<strong>{$t('tpl.settings.hint.global.strong')}</strong>{$t('tpl.settings.hint.global.colon')}<strong>{$t('tpl.settings.hint.everyAgent.strong')}</strong>{$t('tpl.settings.hint.everyAgent.short')}
        </p>

        <!-- 第一排：链路页签 -->
        <div class="tabs">
          <button
            type="button"
            class="tab"
            class:active={tab === 'execute'}
            onclick={() => (tab = 'execute')}
          >
            {$t('tpl.settings.tabExecute')}
            {#if kindDirty('execute')}<span class="dot">●</span>{/if}
          </button>
          <button
            type="button"
            class="tab"
            class:active={tab === 'review'}
            onclick={() => (tab = 'review')}
          >
            {$t('tpl.settings.tabReview')}
            {#if kindDirty('review')}<span class="dot">●</span>{/if}
          </button>
          <button
            type="button"
            class="tab"
            class:active={tab === 'chat'}
            onclick={() => (tab = 'chat')}
          >
            {$t('tpl.settings.tabChat')}
            {#if kindDirty('chat')}<span class="dot">●</span>{/if}
          </button>
        </div>

        <!-- 第二排：块页签（① 框架 / ② 身份 / ③ 任务） -->
        <div class="tabs block-tabs">
          {#each BLOCKS as b (b)}
            <button
              type="button"
              class="tab"
              class:active={block === b}
              onclick={() => (block = b)}
            >
              {$t(BLOCK_TAB_KEY[b])}
              {#if (drafts[tab]?.[b] ?? '').trim() !== ''}<span class="dot">●</span>{/if}
            </button>
          {/each}
        </div>

        {#if adjustment !== null && adjustment.removed.length > 0}
          <p class="notice warn" data-tpl-adjusted>
            {$t('tpl.adjusted.before')}<code>{adjustedList}</code>{$t('tpl.adjusted.after')}
            {#if adjustment.orphanLines.length > 0}
              <br />
              {$t('tpl.adjusted.orphan', { lines: adjustment.orphanLines.join('、') })}
            {/if}
          </p>
        {/if}
        {#if $templateKit === null}
          <p class="empty-value">{$t('tpl.settings.kitUnavailable')}</p>
        {:else}
          <!--
            只显示当前页签那一个编辑器。`{#key}` 是有用的：切页签时把组件
            整个重建，于是它内部的"预览打开了""变量清单展开了"跟着复位——
            预览属于**这一份**模版，不该跟着串到另一份上。
          -->
          {#key `${tab}:${block}`}
            <FirstSentenceTemplate
              kind={tab}
              block={block}
              value={current}
              onchange={setCurrent}
              showLabel={false}
            />
          {/key}
        {/if}
      </section>

      <!-- 以后的设置往这里加：一段一件独立的事，底部那个「保存」是共用的 -->
    </form>

    <svelte:fragment slot="foot">
      <button
        type="submit"
        form="settings-form"
        disabled={busy || $templateKit === null}
        title={busy ? $t('common.busyHint') : $templateKit === null ? $t('settings.kitNotLoaded') : undefined}
      >
        {busy ? $t('common.saving') : $t('common.save')}
      </button>
      <button
        type="button"
        class="secondary"
        onclick={onclose}
        disabled={busy}
        title={busy ? $t('common.busyHint') : undefined}
        >{$t('common.cancel')}</button
      >
      {#if error}
        <div class="notice bad settings-error">{error}</div>
      {:else}
        <span class="faint small">{$t('tpl.settings.savedHint.before')}<strong>{$t('tpl.settings.savedHint.strong')}</strong>{$t('tpl.settings.savedHint.after')}</span>
      {/if}
    </svelte:fragment>
  </Drawer>
{/if}

<style>
  .settings-form { width: 100%; min-width: 0; }

  .settings-form .tabs {
    display: flex;
    gap: var(--sp-1);
    border-bottom: 1px solid var(--line);
    margin: var(--sp-3) 0;
  }

  .settings-form .block-tabs {
    /* 第二排是"块"：紧贴第一排、更矮一点，视觉上是一组里的次级页签 */
    margin: calc(-1 * var(--sp-2)) 0 var(--sp-3);
  }

  .settings-form .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    color: var(--text-faint);
    padding: var(--sp-2) var(--sp-4);
    cursor: pointer;
  }

  .settings-form .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .settings-form .tab .dot { font-size: var(--fs-xs); margin-left: 4px; }

  /* 校验错误可能是好几条，一句一行读得清 */
  .settings-error { white-space: pre-line; }
</style>
