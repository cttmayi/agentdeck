<script lang="ts">
  import ListRow from '../components/ListRow.svelte'
  import {
    api,
    type ScheduleCreateInput,
    type ScheduleRecordView,
    type ScheduleView,
  } from '../lib/api.ts'
  import { t, tx } from '../lib/i18n.ts'
import type { WebTextId } from '@agentdeck/i18n'
  import {
    agents,
    effectiveDefaultAgentId,
    groups,
    identity,
    tools,
  } from '../lib/stores.ts'
  import { go, selectedIssueId, showToast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { relativeTime } from '../lib/time.ts'
  import { groupExecutor, resolveNewTaskChain } from '../lib/newtask-chain.ts'
  import {
    defaultScheduleForm,
    scheduleCronToForm,
    scheduleFormToCron,
    type ScheduleForm,
    type ScheduleFreq,
  } from '../lib/schedule-cron.ts'

  /**
   * 定时任务（2026-11，使用者立项）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 到点的任务生成器
   * ══════════════════════════════════════════════════════════════════
   *
   * · 左栏：列表（启用开关 / 人话调度 / 下次触发 / 最近一次状态）；
   * · 右栏：新建/编辑表单（**表单式调度**——频率 + 时间点，cron 是内部表示，
   *   高级折叠直接写 cron）或详情（摘要 + 触发记录表）。
   *
   * 触发的任务是**普通任务**（执行 → 审核 → 动作 全走既有链路），在「任务」页
   * 查看；这里的「触发记录」只是索引，每条「查看」跳任务页那次 run。
   *
   * 模板变量（{{date}} 等）在触发时由 daemon 算好填入，缺值替换成空——
   * 判据与 D33 同款（变量只给内容、不给标题）。
   */

  // ── 列表 ──
  let list: ScheduleView[] = []
  let loading = true
  let loadError = ''
  let selectedId: string | null = null

  // ── 表单 ──
  type FormMode = 'create' | 'edit' | null
  let formMode: FormMode = null
  let editingId: string | null = null
  let formName = ''
  let form: ScheduleForm = defaultScheduleForm()
  let formTaskText = ''
  let formSource: 'agent' | 'group' = 'agent'
  let formAgentId = ''
  let formGroupId = ''
  let formError = ''
  let busy = false

  async function load(): Promise<void> {
    loading = true
    loadError = ''
    try {
      const res = await api<{ items: ScheduleView[] }>('/api/schedules')
      list = res.items
      // 选中的那条没了（被删）→ 回列表
      if (selectedId && !list.some((s) => s.id === selectedId)) {
        selectedId = null
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }
  void load()

  // ── 执行者候选（与 NewTaskForm 同一套推导）──
  $: groupSupported = ($identity?.capabilities ?? []).includes('agent-groups')
  $: enabledGroups = groupSupported ? $groups.filter((g) => g.enabled) : []
  $: executorAgents = $agents.filter((a) => a.role === 'executor')
  $: chosenGroup = formGroupId ? ($groups.find((g) => g.id === formGroupId) ?? null) : null
  $: groupExec = chosenGroup ? groupExecutor(chosenGroup.memberAgents) : null
  $: groupReviewerId = chosenGroup
    ? (chosenGroup.memberAgents.find((m) => m.id !== groupExec?.id)?.id ?? '')
    : ''
  $: groupChainDefaults = chosenGroup
    ? {
        members: chosenGroup.memberAgents,
        reviewerId: groupReviewerId || null,
        allowedActions: chosenGroup.allowedActions,
        actionParams: chosenGroup.actionParams,
        maxReworks: chosenGroup.maxReworks,
      }
    : null
  $: chosen = executorAgents.find((a) => a.id === formAgentId) ?? null
  $: executor = formSource === 'group' ? groupExec : chosen
  $: executorName = executor?.name ?? null
  $: chain = resolveNewTaskChain({
    executor,
    choice: { mode: 'default' },
    agents: $agents,
    tools: $tools,
    group: formSource === 'group' ? groupChainDefaults : null,
  })
  $: actionNames = [...chain.actions, ...chain.unavailableActions]

  $: enabledCount = list.filter((s) => s.enabled).length

  // ── 新建 / 编辑 ──
  function openCreate(): void {
    formMode = 'create'
    editingId = null
    formName = ''
    form = defaultScheduleForm()
    formTaskText = ''
    formSource = 'agent'
    formGroupId = ''
    formAgentId = $effectiveDefaultAgentId ?? executorAgents[0]?.id ?? ''
    formError = ''
    selectedId = null
  }

  function openEdit(s: ScheduleView): void {
    formMode = 'edit'
    editingId = s.id
    formName = s.name
    form = scheduleCronToForm(s.cron)
    formTaskText = s.taskText
    formSource = s.executorType
    if (s.executorType === 'group') {
      formGroupId = s.executorId
    } else {
      formAgentId = s.executorId
    }
    formError = ''
  }

  function closeForm(): void {
    formMode = null
    editingId = null
  }

  function insertVar(v: string): void {
    formTaskText += v
  }

  async function save(): Promise<void> {
    if (busy) return
    formError = ''
    if (formName.trim() === '') {
      formError = tx('schedules.nameLabel') + '…' + tx('schedules.required')
      return
    }
    if (formTaskText.trim() === '') {
      formError = tx('schedules.taskLabel') + '…' + tx('schedules.required')
      return
    }
    if (formSource === 'group' && !formGroupId) {
      formError = tx('newtask.groupPickRequired')
      return
    }
    if (formSource === 'agent' && !formAgentId) {
      formError = tx('schedules.executorLabel') + '…' + tx('schedules.required')
      return
    }
    const executorId = formSource === 'group' ? formGroupId : formAgentId
    busy = true
    try {
      if (formMode === 'edit' && editingId) {
        await api(`/api/schedules/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: formName.trim(),
            cron: scheduleFormToCron(form),
            taskText: formTaskText.trim(),
            executorType: formSource,
            executorId,
          }),
        })
        showToast(tx('schedules.updatedToast'))
      } else {
        const input: ScheduleCreateInput = {
          name: formName.trim(),
          cron: scheduleFormToCron(form),
          executorType: formSource,
          executorId,
          taskText: formTaskText.trim(),
        }
        const created = await api<ScheduleView>('/api/schedules', {
          method: 'POST',
          body: JSON.stringify(input),
        })
        selectedId = created.id
        showToast(tx('schedules.createdToast'))
      }
      await load()
      closeForm()
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function toggleEnabled(s: ScheduleView): Promise<void> {
    try {
      await api(`/api/schedules/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      })
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  async function deleteSchedule(s: ScheduleView): Promise<void> {
    if (
      !(await askConfirm({
        title: tx('schedules.delete'),
        message: tx('schedules.confirmDelete') + '：' + s.name,
        confirmLabel: tx('schedules.delete'),
        danger: true,
      }))
    )
      return
    try {
      await api(`/api/schedules/${s.id}`, { method: 'DELETE' })
      showToast(tx('schedules.deletedToast'))
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  async function triggerNow(s: ScheduleView): Promise<void> {
    try {
      await api(`/api/schedules/${s.id}/trigger`, { method: 'POST' })
      showToast(tx('schedules.triggeredToast'))
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    }
  }

  // 触发记录 → 任务页那次 run
  function viewRun(record: ScheduleRecordView): void {
    if (!record.issueId) return
    selectedIssueId.set(record.issueId)
    go('tasks')
  }

  function recordStatusKey(
    status: ScheduleRecordView['status'],
  ): 'schedules.statusTriggered' | 'schedules.statusSkipped' | 'schedules.statusFailed' {
    return status === 'triggered'
      ? 'schedules.statusTriggered'
      : status === 'skipped'
        ? 'schedules.statusSkipped'
        : 'schedules.statusFailed'
  }

  function recordResult(record: ScheduleRecordView): string {
    if (record.status === 'triggered') return tx('schedules.recordTriggered')
    if (record.status === 'skipped') return tx('schedules.recordSkipped')
    return tx('schedules.recordFailed', { note: record.note ?? '?' })
  }

  const FREQS: Array<{ key: ScheduleFreq; label: WebTextId }> = [
    { key: 'daily', label: 'schedules.freqDaily' },
    { key: 'weekly', label: 'schedules.freqWeekly' },
    { key: 'monthly', label: 'schedules.freqMonthly' },
    { key: 'interval', label: 'schedules.freqInterval' },
  ]
  const WEEKDAY_BTNS = [1, 2, 3, 4, 5, 6, 7] as const

  function toggleWeekday(day: number): void {
    if (form.weekdays.includes(day)) {
      form.weekdays = form.weekdays.filter((d) => d !== day)
    } else {
      form.weekdays = [...form.weekdays, day].sort()
    }
  }

  function nextRunLine(): string {
    const cron = scheduleFormToCron(form)
    // 展示用：高级模式原文太长就不在提示行里塞 cron——提示行只说"已保存为
    // 高级模式"，具体下次触发由 daemon 算（列表会显示）。
    return cron
  }
</script>

<div class="split-layout with-detail" data-list-key="schedules">
  <!-- ══════════ 左栏：列表 ══════════ -->
  <section class="pane list-pane">
    <header class="pane-head">
      <div>
        <h2>{$t('schedules.listTitle')}</h2>
        <p class="hint">{$t('schedules.enabledCount', { enabled: enabledCount, total: list.length })}</p>
      </div>
      <button type="button" class="btn btn--primary btn--sm" onclick={openCreate}>
        {$t('schedules.new')}
      </button>
    </header>

    <div class="pane-body">
      {#if loading && list.length === 0}
        <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
        <div class="skeleton" style="width:70%"></div>
      {:else if loadError}
        <div class="notice bad">{loadError}</div>
      {:else if list.length === 0}
        <div class="empty">
          <strong>{$t('schedules.empty')}</strong>
        </div>
      {:else}
        <ul class="list-stack">
          {#each list as s (s.id)}
            <ListRow
              rowClass="sched-row"
              active={s.id === selectedId}
              onclick={() => {
                selectedId = s.id
                formMode = null
              }}
            >
              {#snippet children()}
                <span class="sched-title">{s.name}</span>
                <span class="sched-sub">
                  <span class="sched-cron">{s.humanCron}</span>
                  {#if s.enabled && s.nextRunAt !== null}
                    <span class="sched-next">{$t('schedules.next')} {relativeTime(s.nextRunAt, Date.now())}</span>
                  {:else if !s.enabled}
                    <span class="faint">{$t('schedules.disabled')}</span>
                  {/if}
                  {#if s.lastTriggerAt !== null && s.records.length > 0}
                    <span class="sched-last">
                      {$t('schedules.last')} {relativeTime(s.lastTriggerAt, Date.now())}
                      <span class="badge {recordBadgeClass(s.records[0]!.status)}">
                        {$t(recordStatusKey(s.records[0]!.status))}
                      </span>
                    </span>
                  {/if}
                </span>
              {/snippet}
              {#snippet action()}
                <button
                  type="button"
                  class="switch {s.enabled ? 'on' : ''}"
                  title={$t('schedules.enabledTitle')}
                  onclick={() => void toggleEnabled(s)}
                  aria-label={$t('schedules.enabledTitle')}
                ></button>
              {/snippet}
            </ListRow>
          {/each}
        </ul>
      {/if}
    </div>
  </section>

  <!-- ══════════ 右栏 ══════════ -->
  <section class="pane-body schedules-main">
    {#if formMode === 'create' || formMode === 'edit'}
      <!-- ── 新建 / 编辑表单 ── -->
      <div class="main-panel">
        <div class="main-panel-head">
          <h2>{$t(formMode === 'create' ? 'schedules.createTitle' : 'schedules.updateTitle')}</h2>
          <button type="button" class="btn btn--ghost btn--sm" onclick={closeForm}>
            {$t('schedules.cancel')}
          </button>
        </div>
        <div class="main-panel-body">
          <div class="field">
            <label>{$t('schedules.nameLabel')}</label>
            <input
              type="text"
              bind:value={formName}
              placeholder={$t('schedules.namePlaceholder')}
              autocomplete="off"
            />
          </div>

          <!-- 表单式调度：频率 + 时间点（cron 是内部表示） -->
          <div class="field">
            <label>{$t('schedules.whenLabel')}</label>
            <div class="freq-picker">
              {#each FREQS as f (f.key)}
                <button
                  type="button"
                  class="pill {form.freq === f.key ? 'active' : ''}"
                  onclick={() => (form.freq = f.key)}
                >
                  {$t(f.label)}
                </button>
              {/each}
            </div>

            {#if form.freq === 'daily'}
              <div class="schedule-line">
                <span>{$t('schedules.freqDaily')}</span>
                <input type="time" bind:value={form.time} />
              </div>
            {:else if form.freq === 'weekly'}
              <div class="schedule-line">
                <span>{$t('schedules.everyWeekday')}</span>
                <div class="weekday-picker">
                  {#each WEEKDAY_BTNS as day (day)}
                    <button
                      type="button"
                      class="weekday-btn {form.weekdays.includes(day) ? 'active' : ''}"
                      onclick={() => toggleWeekday(day)}
                    >
                      {['一', '二', '三', '四', '五', '六', '日'][day - 1]}
                    </button>
                  {/each}
                </div>
                <input type="time" bind:value={form.time} />
              </div>
            {:else if form.freq === 'monthly'}
              <div class="schedule-line">
                <span>{$t('schedules.everyMonthDay')}</span>
                <select bind:value={form.monthDay}>
                  {#each Array.from({ length: 31 }, (_, i) => i + 1) as day (day)}
                    <option value={day}>{day} 日</option>
                  {/each}
                </select>
                <input type="time" bind:value={form.time} />
              </div>
            {:else}
              <div class="schedule-line">
                <span>{$t('schedules.everyInterval')}</span>
                <select bind:value={form.minutes}>
                  {#each [5, 10, 15, 30, 60, 120, 180, 240] as m (m)}
                    <option value={m}>{m}</option>
                  {/each}
                </select>
                <span>{$t('schedules.minutes')}</span>
              </div>
            {/if}

            <p class="hint next-line">{$t('schedules.nextLine')} {nextRunLine()}</p>

            <details class="form-advanced">
              <summary class="hint" style="cursor:pointer">{$t('schedules.advanced')}</summary>
              <input
                type="text"
                bind:value={form.advancedCron}
                placeholder={$t('schedules.advancedPlaceholder')}
                style="font-family:var(--font-mono)"
              />
            </details>
          </div>

          <!-- 要做什么：与「新建任务」同一个框、同一套模板（第一行当标题） -->
          <div class="field">
            <label>{$t('schedules.taskLabel')}</label>
            <textarea
              bind:value={formTaskText}
              placeholder={$t('schedules.taskPlaceholder')}
              rows={7}
            ></textarea>
            <div class="var-chips">
              {#each VAR_CHIPS as v (v.label)}
                <button type="button" class="var-chip" title={v.title} onclick={() => insertVar(v.label)}>
                  {v.label}
                </button>
              {/each}
            </div>
            <p class="hint">{$t('schedules.varsHint')}</p>
          </div>

          <!-- 交给谁：智能体 / 组（与任务表单同一套推导） -->
          <div class="field">
            <label>{$t('schedules.executorLabel')}</label>
            <div class="exec-switch">
              <button
                type="button"
                class="pill {formSource === 'agent' ? 'active' : ''}"
                onclick={() => (formSource = 'agent')}
              >
                {$t('schedules.executorAgent')}
              </button>
              <button
                type="button"
                class="pill {formSource === 'group' ? 'active' : ''}"
                onclick={() => (formSource = 'group')}
              >
                {$t('schedules.executorGroup')}
              </button>
            </div>
            {#if formSource === 'agent'}
              <select bind:value={formAgentId}>
                {#each executorAgents as a (a.id)}
                  <option value={a.id}>{a.name}</option>
                {/each}
              </select>
            {:else}
              <select bind:value={formGroupId}>
                <option value="" disabled>{$t('newtask.groupPickPlaceholder')}</option>
                {#each enabledGroups as g (g.id)}
                  <option value={g.id}>{g.name}</option>
                {/each}
              </select>
            {/if}
            {#if executorName}
              <p class="hint summary-line">
                {$t('schedules.summary', {
                  executor: executorName,
                  reviewer: chain.reviewer?.name ?? tx('newtask.footReviewerNone'),
                  actions: actionNames.length > 0 ? actionNames.join('、') : tx('schedules.none'),
                  reworks:
                    formSource === 'group'
                      ? chosenGroup?.maxReworks === null
                        ? tx('newtask.summaryReworkUnlimited')
                        : tx('newtask.summaryReworkTimes', { n: chosenGroup?.maxReworks ?? 0 })
                      : tx('newtask.summaryReworkZero'),
                })}
              </p>
            {/if}
          </div>

          {#if formError}
            <div class="notice bad">{formError}</div>
          {/if}
        </div>
        <div class="main-panel-foot">
          <button type="button" class="btn btn--primary" disabled={busy} onclick={() => void save()}>
            {$t('schedules.save')}
          </button>
          <button type="button" class="btn" onclick={closeForm}>
            {$t('schedules.cancel')}
          </button>
        </div>
      </div>
    {:else if selectedId}
      {@const s = list.find((x) => x.id === selectedId)}
      {#if s}
        <!-- ── 详情 ── -->
        <div class="detail-head">
          <div class="detail-sub">
            <h2>{s.name}</h2>
            <p>
              <span class="pill">{s.humanCron}</span>
              {#if s.enabled && s.nextRunAt !== null}
                <span class="muted">{$t('schedules.next')} {relativeTime(s.nextRunAt, Date.now())}</span>
              {:else if !s.enabled}
                <span class="faint">{$t('schedules.disabled')}</span>
              {/if}
              {#if s.triggerCount > 0}
                <span class="muted">已触发 {s.triggerCount} 次</span>
              {/if}
            </p>
          </div>
          <div class="detail-actions">
            <button type="button" class="btn btn--secondary btn--sm" onclick={() => void triggerNow(s)}>
              {$t('schedules.triggerNow')}
            </button>
            <button type="button" class="btn btn--ghost btn--sm" onclick={() => openEdit(s)}>
              {$t('schedules.edit')}
            </button>
            <button type="button" class="btn btn--danger btn--sm" onclick={() => void deleteSchedule(s)}>
              {$t('schedules.delete')}
            </button>
          </div>
        </div>

        <div class="detail-section">
          <h3>{$t('schedules.executorLabel')}</h3>
          <p class="muted">
            {s.executorType === 'group'
              ? $groups.find((g) => g.id === s.executorId)?.name ?? s.executorId
              : $agents.find((a) => a.id === s.executorId)?.name ?? s.executorId}
          </p>
          <pre class="task-text">{s.taskText}</pre>
        </div>

        <div class="detail-section">
          <h3>
            {$t('schedules.recordsTitle')}
            <span class="faint fs-xs">{$t('schedules.recordsHint', { n: s.records.length })}</span>
          </h3>
          {#if s.records.length === 0}
            <p class="empty" style="text-align:left;padding:.5rem 0">
              {$t('schedules.empty')}
            </p>
          {:else}
            <table class="record-table">
              <thead>
                <tr>
                  <th>{$t('schedules.colTriggeredAt')}</th>
                  <th>{$t('schedules.colRun')}</th>
                  <th>{$t('schedules.colStatus')}</th>
                  <th>{$t('schedules.colResult')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each s.records as record (record.triggeredAt)}
                  <tr>
                    <td class="mono">{absoluteStamp(record.triggeredAt)}</td>
                    <td class="mono faint">{record.runId ? shortId(record.runId) : '—'}</td>
                    <td>
                      <span class="badge {recordBadgeClass(record.status)}">
                        {$t(recordStatusKey(record.status))}
                      </span>
                    </td>
                    <td class="muted">{recordResult(record)}</td>
                    <td>
                      {#if record.issueId}
                        <button type="button" class="btn btn--link btn--sm" onclick={() => viewRun(record)}>
                          {$t('schedules.view')}
                        </button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="empty">
        <strong>{$t('schedules.empty')}</strong>
        <p>{$t('schedules.titleHint')}</p>
      </div>
    {/if}
  </section>
</div>

<style>
  .sched-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sched-sub {
    display: flex;
    gap: 0.6rem;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    overflow: hidden;
    white-space: nowrap;
  }
  .sched-cron {
    color: var(--text-dim);
  }
  .sched-next {
    color: var(--text-dim);
  }
  .sched-last {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  /* 启用开关（与设置抽屉同一形态） */
  :global(.switch) {
    width: 2.2rem;
    height: 1.25rem;
    border-radius: var(--radius-pill);
    background: var(--line-strong);
    position: relative;
    border: 0;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  :global(.switch)::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: #fff;
    box-shadow: var(--shadow-1);
    transition: left 0.15s;
  }
  :global(.switch.on) {
    background: var(--good);
  }
  :global(.switch.on)::after {
    left: calc(100% - 1.05rem);
  }
  .schedules-main {
    overflow-y: auto;
  }
  /* 表单式调度 */
  .freq-picker {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
  }
  .pill {
    border: 1px solid var(--line-strong);
    background: var(--surface);
    border-radius: var(--radius-pill);
    height: var(--ctl-h);
    padding: 0 0.9rem;
    font-size: var(--fs-base);
    cursor: pointer;
    color: var(--text);
  }
  .pill.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .schedule-line {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  .weekday-picker {
    display: flex;
    gap: 0.25rem;
  }
  .weekday-btn {
    width: 1.9rem;
    height: 1.9rem;
    border-radius: 50%;
    border: 1px solid var(--line-strong);
    background: var(--surface);
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--text);
  }
  .weekday-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .next-line {
    margin-top: 0.5rem;
    color: var(--good);
  }
  .var-chips {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
    margin-top: 0.35rem;
  }
  .var-chip {
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text-dim);
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    padding: 0.15rem 0.55rem;
    cursor: pointer;
  }
  .var-chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .exec-switch {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }
  .summary-line {
    margin-top: 0.5rem;
    color: var(--text-dim);
  }
  .task-text {
    margin-top: 0.5rem;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    white-space: pre-wrap;
    color: var(--text-dim);
  }
  .record-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  .record-table th {
    text-align: left;
    font-weight: 600;
    color: var(--text-dim);
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-xs);
  }
  .record-table td {
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .detail-section {
    margin-top: 1.25rem;
  }
  .detail-section h3 {
    font-size: var(--fs-md);
    margin-bottom: 0.5rem;
  }
</style>

<script lang="ts" module>
  function recordBadgeClass(status: string): string {
    return status === 'triggered' ? 'done' : status === 'skipped' ? 'blocked' : 'bad'
  }
  function absoluteStamp(ms: number): string {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  function shortId(id: string): string {
    return id.length > 10 ? `${id.slice(0, 10)}…` : id
  }
  // ⚠️ `{{xxx}}` 字面不能写进 Svelte 模板（`{{` 是表达式开头），这里拼好再渲染。
  function varLabel(name: string): string {
    return '{' + '{' + name + '}' + '}'
  }
  const VAR_CHIPS = [
    { label: varLabel('date'), title: '2026-11-16' },
    { label: varLabel('time'), title: '09:00' },
    { label: varLabel('weekday'), title: '周一' },
    { label: varLabel('count'), title: '第 N 次触发（从 1 累计）' },
    { label: varLabel('runId'), title: '本次 run 的 id' },
    { label: varLabel('lastRunId'), title: '上次触发的 runId（首次为空）' },
  ]
</script>
