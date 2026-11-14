<script lang="ts">
  /**
   * 编排（2026-11，使用者立项）——定义页：
   * 左栏 = 编排定义列表；右栏 = 新建/编辑（模板骨架 → 代码可改）+「运行」发起
   * （任务描述 + 工作目录）+ 该编排的历史（点历史进运行画面）。
   *
   * ⚠️ 运行画面（`$workflowRun` 非空）是**另一个组件**（`WorkflowRunView`），
   *   这里是"定义 + 历史"那一半（使用者拍板：编排页只管定义+历史）。
   *
   * ⚠️ Svelte 5 legacy 模式：本文件不引 runes（`$state` 一用整文件切 runes 模式，
   *   而 legacy 的 `$:` 与 runes 混用会被编译器拒——Tasks.svelte 同款约束）。
   */
  import { onMount } from 'svelte'
  import { listGrip } from '../lib/list-grip.ts'
  import { t, tx } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import {
    api,
    type Workflow,
    type WorkflowRun,
    type WorkflowTemplate,
  } from '../lib/api.ts'
  import {
    workflows,
    workflowRuns,
    loading,
    loadIssues,
    loadWorkflows,
    loadWorkflowRuns,
  } from '../lib/stores.ts'
  import { workflowRun, toast, wfReturn } from '../lib/view.ts'
  import ListRow from '../components/ListRow.svelte'
  import DirPicker from '../components/DirPicker.svelte'
  import WorkflowRunView from '../components/WorkflowRunView.svelte'
  import { relativeTime } from '../lib/time.ts'
  import { workflowRunStatusClass, workflowRunStatusKey } from '../lib/run-status.ts'

  // ── 新建/编辑表单 ──
  let formMode: 'create' | 'edit' = 'create'
  let formName = ''
  let formCode = ''
  let formTemplateKey: string | null = null
  let formError = ''
  let busy = false

  // ── 发起运行表单 ──
  let runOpen = false
  let runPrompt = ''
  let runWorkDir = ''
  let runDirPickerOpen = false
  let runError = ''
  let runBusy = false

  // 模板清单（「从模板」入口的数据源）
  let templates: WorkflowTemplate[] = []
  onMount(async () => {
    try {
      templates = (await api<{ items: WorkflowTemplate[] }>('/api/workflows/templates')).items ?? []
    } catch {
      // 拿不到模板不炸：新建时留空代码手写即可
    }
  })

  let selectedId: string | null = null

  $: selected = $workflows.find((w) => w.id === selectedId) ?? null
  $: history = $workflowRuns
    .filter((r) => r.workflowId === selectedId)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  function openRun(runId: string): void {
    // 从定义页进运行画面：返回按钮回定义页
    wfReturn.set('workflows')
    location.hash = `#/workflows/run/${runId}`
  }

  function onBackdropClose(event: MouseEvent): void {
    if (event.target === event.currentTarget) runOpen = false
  }

  function newForm(): void {
    formMode = 'create'
    selectedId = null
    formName = ''
    formCode = ''
    formTemplateKey = null
    formError = ''
    runOpen = false
  }

  function editForm(w: Workflow): void {
    formMode = 'edit'
    selectedId = w.id
    formName = w.name
    formCode = w.code
    formTemplateKey = w.templateKey
    formError = ''
    runOpen = false
  }

  function pickTemplate(tpl: WorkflowTemplate): void {
    formTemplateKey = tpl.key
    formCode = tpl.code
    formError = ''
  }

  async function save(): Promise<void> {
    if (busy) return
    formError = ''
    const name = formName.trim()
    if (name === '') {
      formError = tx('workflows.nameLabel')
      return
    }
    if (formCode.trim() === '') {
      formError = tx('workflows.codeLabel')
      return
    }
    busy = true
    try {
      if (formMode === 'create') {
        const out = await api<{ workflow: Workflow }>('/api/workflows', {
          method: 'POST',
          body: JSON.stringify({ name, code: formCode, templateKey: formTemplateKey }),
        })
        formMode = 'edit'
        selectedId = out.workflow.id
      } else if (selectedId) {
        await api<{ workflow: Workflow }>(`/api/workflows/${selectedId}`, {
          method: 'PUT',
          body: JSON.stringify({ name, code: formCode }),
        })
      }
      await loadWorkflows()
      toast.set(tx('workflows.saved'))
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function remove(): Promise<void> {
    if (busy || !selectedId) return
    if (!window.confirm(tx('workflows.confirmDelete'))) return
    busy = true
    try {
      await api(`/api/workflows/${selectedId}`, { method: 'DELETE' })
      await loadWorkflows()
      newForm()
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function startRun(): Promise<void> {
    if (runBusy || !selectedId) return
    runError = ''
    runBusy = true
    try {
      const out = await api<{ run: WorkflowRun }>(`/api/workflows/${selectedId}/run`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: runPrompt,
          workDir: runWorkDir.trim() === '' ? null : runWorkDir.trim(),
        }),
      })
      runOpen = false
      runPrompt = ''
      runWorkDir = ''
      // 编排任务会进「任务」列表（徽标 + 步骤进度）——发起后立即重拉，界面跟着数据走。
      await Promise.all([loadWorkflowRuns(), loadIssues()])
      // 跳运行画面（子路由：`#/workflows/run/<runId>`）；返回按钮回定义页
      wfReturn.set('workflows')
      location.hash = `#/workflows/run/${out.run.id}`
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err)
    } finally {
      runBusy = false
    }
  }

  function sourceKey(w: Workflow): WebTextId {
    return w.source === 'template'
      ? 'workflows.sourceTemplate'
      : w.source === 'ai'
        ? 'workflows.sourceAi'
        : 'workflows.sourceManual'
  }

</script>

{#if $workflowRun}
  <WorkflowRunView runId={$workflowRun.runId} />
{:else}
  <div
    class="split-layout with-detail"
    data-list-key="workflows"
    data-list-label={$t('shell.resizeList')}
    use:listGrip
  >
    <!-- ══════════ 左栏：编排定义列表 ══════════ -->
    <section class="pane list-pane">
      <header class="pane-head">
        <div>
          <h2>{$t('workflows.listTitle')}</h2>
          <p class="hint">{$t('workflows.titleHint')}</p>
        </div>
        <button type="button" class="btn btn--primary" onclick={newForm}>
          {$t('workflows.new')}
        </button>
      </header>

      <div class="pane-body">
        {#if $loading.workflows && $workflows.length === 0}
          <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
          <div class="skeleton" style="width:70%"></div>
        {:else if $workflows.length === 0}
          <div class="empty">
            <strong>{$t('workflows.empty')}</strong>
          </div>
        {:else}
          <ul class="list-stack">
            {#each $workflows as w (w.id)}
              <ListRow
                rowClass="wf-row"
                active={w.id === selectedId}
                onclick={() => editForm(w)}
              >
                {#snippet children()}
                  <span class="wf-title">{w.name}</span>
                  <span class="wf-sub">
                    <span class="badge">{$t(sourceKey(w))}</span>
                    <span class="faint">{$t('workflows.updated', { time: relativeTime(w.updatedAt, Date.now()) })}</span>
                  </span>
                {/snippet}
              </ListRow>
            {/each}
          </ul>
        {/if}
      </div>
    </section>

    <!-- ══════════ 右栏：编辑器 + 运行入口 + 历史 ══════════ -->
    <section class="pane-body workflows-main">
      {#if formMode === 'create' && !selected}
        <!-- 空态 / 新建：从模板起步 -->
        <div class="detail-head">
          <div class="detail-sub">
            <h2>{$t('workflows.title')}</h2>
          </div>
        </div>
        <div class="detail-body">
          <p class="hint">{$t('workflows.templatesLabel')}</p>
          <div class="wf-tpl-row">
            {#each templates as tpl (tpl.key)}
              <button
                type="button"
                class="btn btn--ghost {formTemplateKey === tpl.key ? 'btn--primary' : ''}"
                onclick={() => pickTemplate(tpl)}
              >
                {tpl.name}
              </button>
            {/each}
          </div>
          <div class="field">
            <label>{$t('workflows.nameLabel')}</label>
            <input
              type="text"
              bind:value={formName}
              placeholder={$t('workflows.namePlaceholder')}
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label>{$t('workflows.codeLabel')}</label>
            <textarea
              class="mono"
              rows="12"
              bind:value={formCode}
              placeholder={$t('workflows.codePlaceholder')}
            ></textarea>
          </div>
          {#if formError}
            <div class="notice bad">{formError}</div>
          {/if}
          <div class="detail-actions">
            <button type="button" class="btn btn--primary" disabled={busy} onclick={() => void save()}>
              {$t('workflows.save')}
            </button>
          </div>
        </div>
      {:else if selected}
        <!-- 编辑详情 -->
        <div class="detail-head">
          <div class="detail-sub">
            <h2>{selected.name}</h2>
            <p class="hint">
              <span class="badge">{$t(sourceKey(selected))}</span>
              <span class="faint">{$t('workflows.updated', { time: relativeTime(selected.updatedAt, Date.now()) })}</span>
            </p>
          </div>
          <div class="detail-actions">
            <button type="button" class="btn btn--secondary" disabled={busy} onclick={() => void remove()}>
              {$t('workflows.delete')}
            </button>
            <button type="button" class="btn btn--primary" onclick={() => (runOpen = true)}>
              {$t('workflows.run')}
            </button>
          </div>
        </div>
        <div class="detail-body">
          <div class="field">
            <label>{$t('workflows.codeLabel')}</label>
            <textarea
              class="mono"
              rows="14"
              bind:value={formCode}
              placeholder={$t('workflows.codePlaceholder')}
            ></textarea>
          </div>
          {#if formError}
            <div class="notice bad">{formError}</div>
          {/if}
          <div class="detail-actions">
            <button type="button" class="btn btn--primary" disabled={busy} onclick={() => void save()}>
              {$t('workflows.save')}
            </button>
          </div>

          {#if history.length > 0}
            <h3 class="wf-history-head">{$t('workflows.stepsTitle')}</h3>
            <ul class="list-stack">
              {#each history as r (r.id)}
                <ListRow
                  rowClass="wf-run-row"
                  onclick={() => openRun(r.id)}
                >
                  {#snippet children()}
                    <span class="wf-title">
                      <span class="badge {workflowRunStatusClass(r.status)}">{$t(workflowRunStatusKey(r.status))}</span>
                      <span class="mono">{r.id.slice(-6)}</span>
                    </span>
                    <span class="wf-sub">
                      <span class="faint">{relativeTime(r.updatedAt, Date.now())}</span>
                      <span class="faint">{$t('workflows.stepsHint')} {r.steps.filter((s) => s.status !== 'pending').length}/{r.steps.length}</span>
                    </span>
                  {/snippet}
                </ListRow>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  <!-- ══════════ 发起运行表单（居中对话框） ══════════ -->
  {#if runOpen && selected}
    <div class="drawer-backdrop" onclick={onBackdropClose}>
      <div class="modal">
        <div class="modal-head">
          <h2>{$t('workflows.runFormTitle')}</h2>
          <p class="hint">{selected.name}</p>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>{$t('workflows.promptLabel')}</label>
            <textarea rows="4" bind:value={runPrompt} placeholder={$t('workflows.promptPlaceholder')}></textarea>
          </div>
          <div class="field">
            <label>{$t('workflows.workDirLabel')}</label>
            <!-- 与「新建任务」「定时任务」同一个控件（.workdir-row + 浏览… + DirPicker）：
                 输入框始终留着（手打永远可用），选择框是"看见目录里有什么"的入口。 -->
            <div class="workdir-row">
              <input
                type="text"
                bind:value={runWorkDir}
                placeholder={$t('workflows.workDirAuto')}
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="btn btn--ghost" onclick={() => (runDirPickerOpen = true)}>
                {$t('dirs.browse')}
              </button>
            </div>
            <DirPicker bind:open={runDirPickerOpen} bind:value={runWorkDir} />
          </div>
          {#if runError}
            <div class="notice bad">{runError}</div>
          {/if}
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn--secondary" onclick={() => (runOpen = false)}>
            {$t('common.cancel')}
          </button>
          <button type="button" class="btn btn--primary" disabled={runBusy} onclick={() => void startRun()}>
            {$t('workflows.startRun')}
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  /* 列表行两行结构（311/312 批纪律，与 .sched-title/.sched-sub 同款）：
     第一行标题（单行省略五件套）、第二行辅助信息（显式字色/字号 + 单行省略）——
     不写 color/font-size 就会从行里继承，两页的辅助信息颜色不一致。 */
  .wf-title {
    display: block;
    max-width: 100%;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wf-sub {
    display: flex;
    gap: 0.6rem;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    overflow: hidden;
    white-space: nowrap;
  }
  .wf-tpl-row {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-bottom: var(--sp-3);
  }
  .wf-history-head {
    margin-top: var(--sp-4);
  }
</style>
