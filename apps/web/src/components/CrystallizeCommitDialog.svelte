<script lang="ts">
  /**
   * 「确认入库」的确认框（分批第 196 批）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么 slug 从页面上搬到了这里
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者：「中栏的「slug」也不应该显示，如果要，可以放在「确认入库」后弹出的对话框中」。
   * 他说得对：slug 是**入库那一刻**才要确认的字段（新建时可能撞名、也可能想换个名字），
   * 平时挂在审阅屏上，等于让一个"偶尔才要改"的输入框常驻，还挤着对话。
   *
   * 所以这一屏只做一件事：**把要存进去的东西摊开给你看一眼**——
   *   · slug（可改；更新场景服务端只接受原 slug，改坏了会被 400 拒，这里干脆不让改）；
   *   · name / description（只读：它们来自 SKILL.md 的 frontmatter，改它们要改文件）；
   *   · 几个文件、多大（入库是整目录替换）。
   *
   * ⚠️ 对话框**不自己发请求**：确认后由父组件走原来那条 `save()`（它带着 409 撞名 / 校验
   *    不通过等错误分支）。这里只把 slug 交回去——一份状态，一条入库路径。
   */
  import { Modal } from '@agentdeck/ui/components'
  import { t } from '../lib/i18n.ts'

  let {
    /** 开关（`bind:open`：父组件的「确认入库」把它置真，关框由这里回调） */
    open = $bindable(false),
    /** 新建 / 更新（更新时 slug 不可改、也不会撞名）。 */
    kind = 'new',
    /** 可编辑的 slug（新建时是人要确认的那个字段）。 */
    slug = $bindable(''),
    name = '',
    description = '',
    fileCount = 0,
    totalBytes = 0,
    /** 正在入库（按钮防连点）。 */
    busy = false,
    /** 撞名 / 校验失败等错误（由父组件的入库流程填进来）。 */
    error = '',
    onconfirm,
    oncancel,
  }: {
    open?: boolean
    kind?: 'new' | 'update'
    slug?: string
    name?: string
    description?: string
    fileCount?: number
    totalBytes?: number
    busy?: boolean
    error?: string
    onconfirm: () => void
    oncancel: () => void
  } = $props()
</script>

<Modal
  {open}
  title={$t('crystallize.commitTitle')}
  closeLabel={$t('common.close')}
  onclose={() => {
    if (!busy) oncancel()
  }}
>
  <div class="commit-body">
    {#if error !== ''}
      <p class="notice bad">{error}</p>
    {/if}
    <label class="field">
      <span class="label">{$t('crystallize.slugLabel')}</span>
      {#if kind === 'update'}
        <!-- 更新 = 覆盖同一条技能，slug 由那条技能决定（服务端也只接受原 slug） -->
        <code class="mono slug-fixed">{slug}</code>
      {:else}
        <input class="mono" bind:value={slug} autocomplete="off" spellcheck="false" />
      {/if}
      <span class="hint">{$t('crystallize.commitSlugHint')}</span>
    </label>

    {#if name !== '' || description !== ''}
      <div class="field">
        <span class="label">{$t('crystallize.commitFromFrontmatter')}</span>
        <p class="frontmatter">
          {#if name !== ''}<code class="mono">{name}</code>{/if}
          {#if description !== ''}<span class="desc">{description}</span>{/if}
        </p>
        <span class="hint">{$t('crystallize.commitFrontmatterHint')}</span>
      </div>
    {/if}

    <p class="faint fs-xs summary">
      {$t('crystallize.commitSummary', {
        n: String(fileCount),
        kb: String(Math.max(1, Math.round(totalBytes / 1024))),
      })}
    </p>
  </div>

  <div class="commit-actions">
    <button type="button" class="btn btn--ghost" onclick={() => (busy ? undefined : oncancel())} disabled={busy}>
      {$t('common.cancel')}
    </button>
    <button
      type="button"
      class="btn btn--primary"
      data-commit-confirm
      disabled={busy || slug.trim() === ''}
      onclick={onconfirm}
    >{busy ? $t('common.saving') : $t('crystallize.confirm')}</button>
  </div>
</Modal>

<style>
  .commit-body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .label {
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
  .hint {
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
  .frontmatter {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    margin: 0;
    flex-wrap: wrap;
  }
  .frontmatter .desc {
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }
  .slug-fixed {
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    align-self: flex-start;
  }
  .summary {
    margin: 0;
  }
  .commit-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
  }
</style>
