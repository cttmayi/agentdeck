<script lang="ts">
  import { onDestroy } from 'svelte'
  import ListRow from '../components/ListRow.svelte'
  import { clearPageActions, setPageActions } from '../lib/page-actions.ts'
  import {
    api,
    type ScheduleCreateInput,
    type SchedulePreview,
    type ScheduleRecordView,
    type ScheduleResumeMode,
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
  import { go, goSchedCreate, goSchedEdit, schedForm, selectedIssueId, showToast } from '../lib/view.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { relativeTime } from '../lib/time.ts'
  import { listGrip } from '../lib/list-grip.ts'
  import DirPicker from '../components/DirPicker.svelte'
  import { groupExecutor, resolveNewTaskChain } from '../lib/newtask-chain.ts'
  import {
    defaultScheduleForm,
    isWorkdays,
    scheduleCronToForm,
    scheduleFormToCron,
    type ScheduleForm,
    type ScheduleFreq,
  } from '../lib/schedule-cron.ts'
  // cronstrue：自定义 cron 的人话翻译（2026-11 使用者拍板用业界标准库）。
  // locale 必须显式 import 注册（`cronstrue/i18n` 聚合版带全语言 300KB，这里只带中文 10KB）。
  import cronstrue from 'cronstrue'
  import 'cronstrue/locales/zh_CN.js'

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
  // ★ 2026-11：「在不在表单、编辑谁」在**全局 store**（$schedForm）——
  //   使用者报"没点取消切到其他页面，切回来新建任务消失了"。表单状态放组件里
  //   一卸载就丢；放全局 store 里切走切回（点侧栏回来）都在（地址方案挡不住
  //   侧栏导航覆盖 hash，见 view.ts schedForm 的说明）。字段内容仍是组件状态
  //   （切走丢，与任务页表单同款行为），表单本体不丢。
  let formName = ''
  let form: ScheduleForm = defaultScheduleForm()
  let formTaskText = ''
  let formSource: 'agent' | 'group' = 'agent'
  let formAgentId = ''
  let formGroupId = ''
  let formError = ''
  let busy = false
  // 2026-11：工作目录（可选，与「新建任务」同款控件）+ 触发方式（fresh/resume）
  // 2026-11（"分"不见了那次的配套）：form.time 是 "HH:MM"；这里拆/合两端。
  // 边界收敛（0-23/0-59、非数回退当前值）写在写回处，别让坏值进 cron。
  function timeHour(t: string): number {
    return Number((t ?? '09:00').split(':')[0] ?? '0')
  }
  function timeMinute(t: string): number {
    return Number((t ?? '09:00').split(':')[1] ?? '0')
  }
  function setTimePart(part: 'h' | 'm', raw: string): void {
    const h = timeHour(form.time)
    const m = timeMinute(form.time)
    const n = Number(raw)
    if (part === 'h') {
      const v = Number.isFinite(n) ? Math.min(23, Math.max(0, Math.trunc(n))) : h
      form.time = `${String(v).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    } else {
      const v = Number.isFinite(n) ? Math.min(59, Math.max(0, Math.trunc(n))) : m
      form.time = `${String(h).padStart(2, '0')}:${String(v).padStart(2, '0')}`
    }
  }
  let formWorkDir = ''
  let formResume: ScheduleResumeMode = 'fresh'
  let dirPickerOpen = false
  // 结果区「下次」行：daemon 用 croner 算（debounce），表单任何调度变化都重算
  let previewNext: number | null = null
  let previewError = ''
  let previewTimer: ReturnType<typeof setTimeout> | null = null

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
  // ── 顶栏动作（与智能体/聊天/任务同款：主操作在顶栏 page-actions，
  //    不在列表头自插按钮——Crystallize.svelte 那句「主操作放顶栏」是明规则；
  //    2026-11 使用者点名：「新建定时任务」按钮与其它页完全不一样）
  //    label 复用 createTitle（与 agents 同一个做法：按钮 = 它打开的面板标题，
  //    同一句话只有一个出处）
  $: setPageActions('schedules', [
    {
      id: 'new',
      label: $t('schedules.createTitle'),
      kind: 'primary',
      icon: 'plus',
      // 表单开着时禁点（与智能体页 creating 同款）
      disabled: $schedForm !== null,
      onActivate: openCreate,
    },
  ])
  onDestroy(() => clearPageActions('schedules'))

  // ── 新建 / 编辑 ──
  // 按钮只负责改地址；字段填充统一在 hydrateForm（$schedForm 变化时跑）。
  function openCreate(): void {
    selectedId = null
    goSchedCreate()
  }

  function openEdit(s: ScheduleView): void {
    selectedId = null
    goSchedEdit(s.id)
  }

  function closeForm(): void {
    schedForm.set(null)
  }

  /**
   * ★ 表单字段从 $schedForm 初始化（2026-11，地址驱动之后挂载/返回都要它）。
   *
   * ⚠️ `hydratedFor` 防重复：编辑回填只做一次（列表后续刷新不能把用户正在填的
   *    内容重置掉）。create 一次标死；edit 若 list 里还没数据（切回来 load 未回）
   *    不标记，等 list 到了再填。
   */
  let hydratedFor: string | null = null
  function resetFormFields(): void {
    formName = ''
    form = defaultScheduleForm()
    formTaskText = ''
    formSource = 'agent'
    formGroupId = ''
    formAgentId = $effectiveDefaultAgentId ?? executorAgents[0]?.id ?? ''
    formWorkDir = ''
    formResume = 'fresh'
    formError = ''
  }
  function fillEditFields(s: ScheduleView): void {
    formName = s.name
    form = scheduleCronToForm(s.cron)
    formTaskText = s.taskText
    formSource = s.executorType
    if (s.executorType === 'group') {
      formGroupId = s.executorId
    } else {
      formAgentId = s.executorId
    }
    formWorkDir = s.workDir ?? ''
    formResume = s.resumeMode
  }
  // ⚠️ Svelte 5 的 `$:` 块里**不许 `return`**（编译器把它当语句段，不是函数体），
  //    这里用 if/else 把分支写开（2026-11 踩过一次 js_parse_error）
  $: if ($schedForm) {
    const key = $schedForm.mode === 'create' ? 'create' : `edit:${$schedForm.id}`
    if (key !== hydratedFor) {
      resetFormFields()
      if ($schedForm.mode === 'create') {
        hydratedFor = key
      } else {
        const s = list.find((x) => x.id === $schedForm.id)
        if (s) {
          fillEditFields(s)
          hydratedFor = key
        }
        // 列表还没回填（切回来 load 未回）：不标记，list 到了再填
      }
    }
  }

  function insertVar(v: string): void {
    formTaskText += v
  }

  async function save(saveAndTrigger = false): Promise<void> {
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
    // 2026-11：工作目录留空 = null（daemon 自动分配）；触发方式 fresh/resume
    const workDir = formWorkDir.trim() === '' ? null : formWorkDir.trim()
    const resumeMode: ScheduleResumeMode = formResume
    busy = true
    try {
      if ($schedForm?.mode === 'edit') {
        await api(`/api/schedules/${$schedForm.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: formName.trim(),
            cron: scheduleFormToCron(form),
            taskText: formTaskText.trim(),
            executorType: formSource,
            executorId,
            workDir,
            resumeMode,
          }),
        })
        if (saveAndTrigger) {
          // 编辑后立刻测试：保存完马上触发一次（到点同一条 fire）
          await api(`/api/schedules/${$schedForm.id}/trigger`, {
            method: 'POST',
            body: JSON.stringify({}),
          })
          showToast(tx('schedules.savedAndTriggeredToast'))
        } else {
          showToast(tx('schedules.updatedToast'))
        }
      } else {
        const input: ScheduleCreateInput = {
          name: formName.trim(),
          cron: scheduleFormToCron(form),
          executorType: formSource,
          executorId,
          taskText: formTaskText.trim(),
          workDir,
          resumeMode,
        }
        const created = await api<ScheduleView>('/api/schedules', {
          method: 'POST',
          body: JSON.stringify(input),
        })
        selectedId = created.id
        if (saveAndTrigger) {
          // 新建后立刻测试：保存完马上触发一次（与编辑态同一句）
          await api(`/api/schedules/${created.id}/trigger`, {
            method: 'POST',
            body: JSON.stringify({}),
          })
          showToast(tx('schedules.savedAndTriggeredToast'))
        } else {
          showToast(tx('schedules.createdToast'))
        }
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

  // 预设五档：每天 / 每周 / 每月 / 间隔 / 自定义（2026-11 v8 定型——
  // 「工作日」并入「每周」做一键快捷，不再单独占一档，避免与每周多选重复）
  const FREQS: Array<{ key: ScheduleFreq; label: WebTextId }> = [
    { key: 'daily', label: 'schedules.freqDaily' },
    { key: 'weekly', label: 'schedules.freqWeekly' },
    { key: 'monthly', label: 'schedules.freqMonthly' },
    { key: 'interval', label: 'schedules.freqInterval' },
    { key: 'custom', label: 'schedules.freqCustom' },
  ]
  const WEEKDAY_BTNS: Array<{ day: number; label: WebTextId }> = [
    { day: 1, label: 'schedules.weekdayMon' },
    { day: 2, label: 'schedules.weekdayTue' },
    { day: 3, label: 'schedules.weekdayWed' },
    { day: 4, label: 'schedules.weekdayThu' },
    { day: 5, label: 'schedules.weekdayFri' },
    { day: 6, label: 'schedules.weekdaySat' },
    { day: 7, label: 'schedules.weekdaySun' },
  ]
  // 人话行的星期名（day 1–7 → 周一…周日；与 daemon describeCron 同一套输出）
  const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  function toggleWeekday(day: number): void {
    if (form.weekdays.includes(day)) {
      form.weekdays = form.weekdays.filter((d) => d !== day)
    } else {
      form.weekdays = [...form.weekdays, day].sort()
    }
  }

  // 「工作日」一键快捷：点一下 = 周一至周五，再点 = 回到只选周一。
  // on 状态由 isWorkdays 判定——手动勾/取消任意一天，快捷自动熄灭（同一状态的两侧）。
  function toggleWorkdaysQuick(): void {
    form.weekdays = isWorkdays(form) ? [1] : [1, 2, 3, 4, 5]
  }

  // ── 结果区三行（cron / 人话 / 下次），改任何一处实时同步 ──
  //
  // ⚠️ 2026-11 v8 踩过：模板里直接调 `{cronLine()}` 在 Svelte 5 里**不建立依赖
  //   追踪**——probe 真浏览器实测：点预设键后 `{#if}` 分支更新了，但文本插值
  //   的函数调用停在首帧值（点「工作日」快捷，cron 行还是 `00 09 * * *`）。
  //   必须用 `$:` 派生变量（编译器能追踪 `$:` 表达式里读到的状态）。
  let cronText = ''
  let humanText = ''
  $: cronText = scheduleFormToCron(form)
  $: humanText = humanLine()

  function humanLine(): string {
    if (form.freq === 'custom') {
      const e = form.customCron.trim()
      if (e === '') return '—'
      try {
        return cronstrue.toString(e, { locale: 'zh_CN' })
      } catch {
        return e // cronstrue 也不认识（基本不可能）：原文兜底，不假装看懂
      }
    }
    const t = form.time
    switch (form.freq) {
      case 'daily':
        return `每天 ${t}`
      case 'weekly':
        if (isWorkdays(form)) return `工作日（周一至周五）${t}`
        return `每周 ${[...form.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d % 7]).join('、')} ${t}`
      case 'monthly':
        return form.monthDay === 'L' ? `每月最后一天 ${t}` : `每月 ${form.monthDay} 日 ${t}`
      case 'interval':
        return `每 ${form.minutes} 分钟`
    }
  }

  async function refreshPreview(): Promise<void> {
    if (previewTimer !== null) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      void (async () => {
        try {
          const res = await api<SchedulePreview>(
            '/api/schedules/preview',
            { method: 'POST', body: JSON.stringify({ cron: scheduleFormToCron(form) }) },
          )
          previewNext = res.nextRunAt
          previewError = ''
        } catch (err) {
          // 400 = cron 写错了（daemon 返回中文人话错误）——直接显示，不假装看懂
          previewError = err instanceof Error ? err.message : String(err)
          previewNext = null
        }
      })()
    }, 300)
  }
  // 表单调度变化（含新建/编辑打开）→ 重算「下次」；没打开表单时不发请求。
  // 依赖 cronText（→ form）才能跟着表单重算——直接 `$: refreshPreview()` 只会在
  // 初始化跑一次（Svelte 编译 $: 时看不出函数体里读了什么）。
  $: cronText, $schedForm !== null && void refreshPreview()
</script>

<div
  class="split-layout with-detail"
  data-list-key="schedules"
  data-list-label={$t('shell.resizeList')}
  use:listGrip
>
  <!-- ══════════ 左栏：列表 ══════════ -->
  <section class="pane list-pane">
    <header class="pane-head">
      <div>
        <h2>{$t('schedules.listTitle')}</h2>
        <p class="hint">{$t('schedules.enabledCount', { enabled: enabledCount, total: list.length })}</p>
      </div>
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
                closeForm()
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
    {#if $schedForm}
      <!-- ── 新建 / 编辑表单 ──
           ★ 2026-11 定稿：右栏表单容器与任务页/聊天页同款——栏头用 `detail-head`
            （两列网格：标题左、动作右），动作走 `detail-actions` 工具条（透明胶囊，
            app.css 265 批那条「栏头那一排动作也走同一条工具条」）；不用 `.main-panel`
            卡片（那是设置/安装那种次级面板的容器，使用者说"和其他页面风格完全不同"）。
            `.main-panel-body` 的留白与 detail-head 同套（sp-4/sp-5），正文直接铺。 -->
      <div class="detail-head">
        <div class="detail-sub">
          <h2>{$t($schedForm.mode === 'create' ? 'schedules.createTitle' : 'schedules.updateTitle')}</h2>
        </div>
        <div class="detail-actions">
          <!-- ★ 保存放栏头（使用者要求：主操作在表单上部，不在最底下）——在动作
               工具条里它就是一颗透明胶囊，与任务页/聊天页栏头动作同一长相 -->
          <button
            type="button"
            class="btn btn--primary"
            disabled={busy}
            onclick={() => void save()}
          >
            {$t('schedules.save')}
          </button>
          <!-- 2026-11（使用者要求）：保存后立刻测试——新建/编辑都显示（保存完马上触发一次） -->
          <button
            type="button"
            class="btn btn--secondary"
            disabled={busy}
            onclick={() => void save(true)}
          >
            {$t('schedules.saveAndTrigger')}
          </button>
          <button type="button" class="btn btn--ghost" onclick={closeForm}>
            {$t('schedules.cancel')}
          </button>
        </div>
      </div>
      <div class="schedule-form-body form-grid">
          <!-- 名称全宽；「什么时候跑 | 要做什么」「交给谁 | 启动方式」两列并排，
               高级/错误全宽——2026-11 使用者要求紧凑：尽量不往下拉就能配置完 -->
          <div class="field grid-full">
            <label>{$t('schedules.nameLabel')}</label>
            <input
              type="text"
              bind:value={formName}
              placeholder={$t('schedules.namePlaceholder')}
              autocomplete="off"
            />
          </div>

          <!-- 表单式调度：预设五档 + 时间 + 结果区三行（cron 永远可见，改任何一侧实时同步） -->
          <div class="field">
            <label>{$t('schedules.whenLabel')}</label>
            <!-- 2026-11（使用者："时间显示里'分'不见了"）：原生 type=time 控件
                 显示 09:00 没有单位字，换成「09 时 00 分」两段数字输入 + 单位。
                 form.time 仍是 "HH:MM"（schedule-cron 只认这个格式），拆/合在此处。 -->
            <div class="schedule-time">
              <input
                type="number"
                min={0}
                max={23}
                value={timeHour(form.time)}
                oninput={(e) => setTimePart('h', e.currentTarget.value)}
                aria-label={$t('schedules.hourUnit')}
              />
              <span class="time-unit">{$t('schedules.hourUnit')}</span>
              <input
                type="number"
                min={0}
                max={59}
                value={timeMinute(form.time)}
                oninput={(e) => setTimePart('m', e.currentTarget.value)}
                aria-label={$t('schedules.minuteUnit')}
              />
              <span class="time-unit">{$t('schedules.minuteUnit')}</span>
            </div>
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

            {#if form.freq === 'weekly'}
              <div class="schedule-line">
                <button
                  type="button"
                  class="pill quick-weekdays {isWorkdays(form) ? 'active' : ''}"
                  onclick={toggleWorkdaysQuick}
                >
                  {$t('schedules.workdaysQuick')}
                </button>
                <div class="weekday-picker">
                  {#each WEEKDAY_BTNS as w (w.day)}
                    <button
                      type="button"
                      class="weekday-btn {form.weekdays.includes(w.day) ? 'active' : ''}"
                      onclick={() => toggleWeekday(w.day)}
                    >
                      {$t(w.label)}
                    </button>
                  {/each}
                </div>
              </div>
            {:else if form.freq === 'monthly'}
              <div class="schedule-line">
                <span>{$t('schedules.everyMonthDay')}</span>
                <select bind:value={form.monthDay}>
                  <option value="L">{$t('schedules.lastDay')}</option>
                  {#each Array.from({ length: 31 }, (_, i) => i + 1) as day (day)}
                    <option value={day}>{day} 日</option>
                  {/each}
                </select>
              </div>
            {:else if form.freq === 'interval'}
              <div class="schedule-line">
                <span>{$t('schedules.everyInterval')}</span>
                <select bind:value={form.minutes}>
                  {#each [5, 10, 15, 30, 60, 120, 180, 240] as m (m)}
                    <option value={m}>{m}</option>
                  {/each}
                </select>
                <span>{$t('schedules.minutes')}</span>
              </div>
            {:else if form.freq === 'custom'}
              <div class="custom-cron">
                <input
                  type="text"
                  bind:value={form.customCron}
                  placeholder={$t('schedules.customPlaceholder')}
                />
                <p class="hint">{$t('schedules.customHint')}</p>
              </div>
            {/if}

            <!-- 结果区：cron / 人话 / 下次 常驻三行 -->
            <div class="schedule-result">
              <div class="schedule-result-row">
                <span class="k">{$t('schedules.cronLabel')}</span>
                <code>{cronText}</code>
              </div>
              <div class="schedule-result-row">
                <span class="k">{$t('schedules.humanLabel')}</span>
                <span class="human">{humanText}</span>
              </div>
              <div class="schedule-result-row">
                <span class="k">{$t('schedules.next')}</span>
                {#if previewError}
                  <span class="bad">{previewError}</span>
                {:else if previewNext !== null}
                  <span>{relativeTime(previewNext, Date.now())}</span>
                {:else}
                  <span class="faint">{$t('schedules.nextUnavailable')}</span>
                {/if}
              </div>
            </div>
          </div>

          <!-- 要做什么：与「新建任务」同一个框、同一套模板（第一行当标题） -->
          <div class="field">
            <label>{$t('schedules.taskLabel')}</label>
            <textarea
              bind:value={formTaskText}
              placeholder={$t('schedules.taskPlaceholder')}
              rows={6}
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
            <!-- 智能体/组互斥切换：与任务表单同一套轨道（app.css .source-toggle，
                 2026-11 review 从 NewTaskForm 提取共用——原来定时任务用独立 pill，
                 使用者说整个页面风格与其它页面完全不同） -->
            <div class="source-toggle">
              <button
                type="button"
                class:active={formSource === 'agent'}
                onclick={() => (formSource = 'agent')}
              >
                {$t('schedules.executorAgent')}
              </button>
              <button
                type="button"
                class:active={formSource === 'group'}
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

          <!-- 启动方式（2026-11 使用者要求：设定新启动 Agent 还是 resume 一个原来的
               Agent）：fresh 每次新起一个会话；resume 触发时续上**上一次触发**的会话
               （FR-CLI-06，第一次触发没有上次可续，自动按新起走）。同一套
               source-toggle 轨道，与「交给谁」、任务表单同款。 -->
          <div class="field">
            <label>{$t('schedules.resumeLabel')}</label>
            <div class="source-toggle">
              <button
                type="button"
                class:active={formResume === 'fresh'}
                onclick={() => (formResume = 'fresh')}
              >
                {$t('schedules.resumeFresh')}
              </button>
              <button
                type="button"
                class:active={formResume === 'resume'}
                onclick={() => (formResume = 'resume')}
              >
                {$t('schedules.resumeLast')}
              </button>
            </div>
          </div>

          <!-- 高级：工作目录。与「新建任务」同一个控件（DirPicker）、同一句判据
               （默认不需要填，留空 = daemon 自动分配）。 -->
          <details class="form-advanced grid-full">
            <summary class="hint" style="cursor:pointer">{$t('newtask.advancedSummary')}</summary>
            <label for="sched-workdir" style="margin-top:var(--sp-3)">
              {$t('newtask.workDirLabel')}
            </label>
            <div class="workdir-row">
              <input
                id="sched-workdir"
                bind:value={formWorkDir}
                placeholder={$t('newtask.workDirPlaceholder')}
                autocomplete="off"
                spellcheck="false"
              />
              <button
                type="button"
                class="btn btn--ghost"
                data-sched-workdir-browse
                onclick={() => (dirPickerOpen = true)}
              >{$t('dirs.browse')}</button>
            </div>
            <DirPicker bind:open={dirPickerOpen} bind:value={formWorkDir} />
            <p class="hint">
              {$t('newtask.workDirHintBefore')}<strong>{$t('newtask.workDirHintStrong')}</strong>{$t('newtask.workDirHintAfter1')}
              {$t('newtask.workDirHintAfter2')}
              {$t('newtask.workDirHintAfter3')}
            </p>
          </details>

          {#if formError}
            <div class="notice bad grid-full">{formError}</div>
          {/if}
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

        <div class="drawer-section">
          <h3>{$t('schedules.executorLabel')}</h3>
          <p class="muted">
            {s.executorType === 'group'
              ? $groups.find((g) => g.id === s.executorId)?.name ?? s.executorId
              : $agents.find((a) => a.id === s.executorId)?.name ?? s.executorId}
          </p>
          <!-- 启动方式 + 工作目录（有值才说；与表单同一句话） -->
          <p class="hint">
            {s.resumeMode === 'resume' ? $t('schedules.resumeLast') : $t('schedules.resumeFresh')}
            {#if s.workDir}
              · {$t('newtask.workDirLabel')}：<code class="mono">{s.workDir}</code>
            {/if}
          </p>
          <!-- 任务原文：与任务页详情同款（hint + pre-wrap），不用 mono 小字 -->
          <p class="hint" style="white-space:pre-wrap">{s.taskText}</p>
        </div>

        <div class="drawer-section">
          <h3>
            {$t('schedules.recordsTitle')}
            <span class="faint fs-xs">{$t('schedules.recordsHint', { n: s.records.length })}</span>
          </h3>
          {#if s.records.length === 0}
            <p class="empty" style="text-align:left;padding:.5rem 0">
              {$t('schedules.empty')}
            </p>
          {:else}
            <table>
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
    /* 2026-11 v8：原来是 1.9rem 圆形——「周一」两个字放不下出框（使用者抓到的），
      改 pill 形状（与预设键一致，能容纳完整词） */
    border: 1px solid var(--line-strong);
    background: var(--surface);
    border-radius: var(--radius-pill);
    height: var(--ctl-h);
    padding: 0 0.9rem;
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--text);
  }
  .weekday-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  /* 结果区三行（2026-11 v8 定型：cron / 人话 / 下次 常驻，改哪侧都实时同步） */
  .schedule-time {
    /* 2026-11（"分"不见了那次的配套）：时间行 = 两段数字输入 + 「时」「分」单位。
       字号大字（与任务表单时间同款观感）；border/radius/padding 交给全局 input */
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }
  .schedule-time input[type='number'] {
    font-size: var(--fs-xl);
    font-weight: 600;
    /* 2026-11（使用者："26 的时候 6 被挡住一部分"）：4rem 放不下两位数字 +
       浏览器自带 spinner（上下箭头）。6rem 与原生 type=time 控件同宽，留够
       spinner 的空间，不再裁字。 */
    width: 6rem;
    text-align: center;
  }
  .schedule-time .time-unit {
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
  .quick-weekdays {
    border-style: dashed;
    color: var(--accent);
    font-size: var(--fs-sm);
    height: auto;
    padding: 0.2rem 0.8rem;
  }
  .quick-weekdays.active {
    border-style: solid;
    color: #fff;
  }
  .custom-cron {
    margin-top: 0.4rem;
  }
  .custom-cron input {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--font-mono);
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
  }
  .schedule-result {
    margin-top: 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .schedule-result-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.7rem;
    font-size: var(--fs-sm);
  }
  .schedule-result-row + .schedule-result-row {
    border-top: 1px dashed var(--line);
  }
  .schedule-result-row .k {
    width: 2.6rem;
    flex-shrink: 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
  .schedule-result-row code {
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .schedule-result-row .human {
    color: var(--good);
    font-weight: 600;
  }
  .schedule-result-row .bad {
    color: var(--bad);
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
  .summary-line {
    margin-top: 0.5rem;
    color: var(--text-dim);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  /* 表单正文留白与任务表单（NewTaskForm .form-frame）同款：上下 sp-5、左右 sp-6 */
  /* 2026-11 紧凑表单：两列 grid，**左右一样宽**（使用者定稿：等分即可）。
     （先试过"任务宽列"——使用者否了："就分左右就好了，左右一样宽"。）
     退化用 **container query** 而不是窗口媒体查询：列表把手能把右栏拖窄，
     窗口再宽也可能把任务列挤没（探针 mainPaneWidth 量的是右栏实宽）。
     gap 用 sp-4（与 form-frame 同套间距）；grid-full 全宽。 */
  .schedule-form-body {
    container-type: inline-size;
    padding: var(--sp-5) var(--sp-6);
  }
  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-4);
    align-items: start;
  }
  .form-grid .grid-full {
    grid-column: 1 / -1;
  }
  /* 右栏（容器）窄于 600px 时两列放不下 ⇒ 落回单列（freq-picker/weekday-picker
     本来就是 flex-wrap，单列形态和旧版一样不难看） */
  @container (max-width: 600px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
  .source-toggle {
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
