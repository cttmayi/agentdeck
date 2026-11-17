<script lang="ts">
  /**
   * 「确认采纳编排」面板（2026-11，D135）——编排生成者在聊天里写完草稿之后，人在这里过一眼。
   *
   * 与 `AgentMakerConfirm`（岗位卡）**同构**，只是产物换成"编排代码"：
   *   ① 打开 ⇒ `GET /api/conversations/{id}/workflow-draft`：读草稿（frontmatter + 代码）；
   *   ② 名字可改、**代码可改**（带语法高亮）——这是人最后一次把关的机会；
   *   ③ 点「采纳」⇒ `POST /api/conversations/{id}/workflow-commit`：服务端重新解析 +
   *      **三道校验**（语法 / 节点名 / 名字），过了才落成一条编排（`source: 'ai'`）。
   *
   * ★ 只有人能采纳这条铁律没有变：生成者只**起草**，真正落库是人在这一步按的那一下。
   * ⚠️ 校验在服务端（不信任客户端）：界面这里的"提示"只是省一次往返，不是判据。
   */
  import { Modal } from '@agentdeck/ui/components'
  import { api, type Workflow } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { showToast } from '../lib/view.ts'
  import { loadWorkflows } from '../lib/stores.ts'
  import CodeEditor from './CodeEditor.svelte'

  export let open = false
  export let conversationId = ''

  /** 草稿的 frontmatter 拆成两半（界面可改；提交时拼回整份给服务端重解析）。 */
  let name = ''
  let summary = ''
  let code = ''
  let loading = false
  let error = ''
  let done = false
  let committing = false

  $: if (open && conversationId !== '') {
    void load()
  }

  async function load(): Promise<void> {
    loading = true
    error = ''
    done = false
    try {
      const body = await api<{
        workflowDraft: string
        name: string
        summary: string
        code: string
        parseError: string | null
      }>(`/api/conversations/${encodeURIComponent(conversationId)}/workflow-draft`)
      name = body.name
      summary = body.summary
      code = body.code
      if (body.parseError !== null) {
        // 草稿在、但解析不了：**如实说**（人还能在界面里手改；服务端采纳时同样会重解析）
        error = $t('chat.workflowMakerParseError', { error: body.parseError })
      }
    } catch (err) {
      error = $t('chat.workflowMakerLoadFail', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      loading = false
    }
  }

  /** 拼回整份草稿（frontmatter + 代码）——服务端只认整份，不信任分开的字段。 */
  function draftText(): string {
    const head = ['---', `name: ${name.trim()}`]
    if (summary.trim() !== '') head.push(`summary: ${summary.trim()}`)
    head.push('---', '', code)
    return head.join('\n')
  }

  async function commit(): Promise<void> {
    if (committing) return
    committing = true
    error = ''
    try {
      const out = await api<{ workflow: Workflow; unverifiable: number }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/workflow-commit`,
        { method: 'POST', body: JSON.stringify({ workflowDraft: draftText() }) },
      )
      done = true
      // ★ 写动作成功后界面跟着数据走：立即重拉编排列表（否则切过去看到的是旧列表）
      await loadWorkflows()
      showToast(
        out.unverifiable > 0
          ? $t('chat.workflowMakerDoneUnverifiable', {
              name: out.workflow.name,
              n: String(out.unverifiable),
            })
          : $t('chat.workflowMakerDone', { name: out.workflow.name }),
      )
      open = false
    } catch (err) {
      error = $t('chat.workflowMakerFail', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      committing = false
    }
  }
</script>

<Modal
  {open}
  title={$t('chat.workflowMakerPanelTitle')}
  subtitle={$t('chat.workflowMakerPanelHint')}
  closeLabel={$t('common.close')}
  size="wide"
  onclose={() => (open = false)}
>
  {#if loading}
    <p class="hint">{$t('chat.workflowMakerLoading')}</p>
  {:else if done}
    <p class="hint">{$t('chat.workflowMakerClosed')}</p>
  {:else}
    <p class="hint draft-note">{$t('chat.workflowMakerDraftNote')}</p>
    {#if error}
      <p class="notice bad">{error}</p>
    {/if}
    <label class="field">
      <span>{$t('chat.workflowMakerNameLabel')}</span>
      <input type="text" bind:value={name} autocomplete="off" />
    </label>
    <label class="field">
      <span>{$t('chat.workflowMakerSummaryLabel')}</span>
      <input type="text" bind:value={summary} autocomplete="off" />
    </label>
    <div class="field">
      <span>{$t('chat.workflowMakerCodeLabel')}</span>
      <CodeEditor bind:value={code} rows={16} ariaLabel={$t('chat.workflowMakerCodeLabel')} />
      <span class="hint">{$t('chat.workflowMakerCodeHint')}</span>
    </div>
  {/if}

  <svelte:fragment slot="foot">
    <button type="button" class="btn btn--secondary" onclick={() => (open = false)}>
      {$t('common.cancel')}
    </button>
    <button
      type="button"
      class="btn btn--primary"
      disabled={committing || loading || name.trim() === '' || code.trim() === ''}
      onclick={() => void commit()}
    >
      {committing ? $t('common.saving') : $t('chat.workflowMakerAction')}
    </button>
  </svelte:fragment>
</Modal>

<style>
  .draft-note {
    margin: 0 0 var(--sp-2);
  }
  .field {
    display: block;
    margin-bottom: var(--sp-2);
  }
</style>
