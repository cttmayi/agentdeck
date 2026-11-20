<script lang="ts">
  import { onDestroy } from 'svelte'
  import ListPane from '../components/ListPane.svelte'
import MainArea from '../components/MainArea.svelte'
import ListRow from '../components/ListRow.svelte'
  import PromptField from '../components/PromptField.svelte'
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
  import { agents, effectiveDefaultAgentId, loadIssues, loadRuns } from '../lib/stores.ts'
  import { go, goSchedCreate, goSchedEdit, schedForm, selectedIssueId, showToast } from '../lib/view.ts'
  import { executorCandidates } from '../lib/newtask-chain.ts'
  import { askConfirm } from '../lib/confirm.ts'
  import { relativeTime } from '../lib/time.ts'
  import { paneResize } from '../lib/pane-resize.ts'
  import DirPicker from '../components/DirPicker.svelte'
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
  let formAgentId = ''
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

  /*
   * 执行者候选（与 NewTaskForm 同一套判据：`role === 'executor'`）。
   *
   * ⚠️ 2026-11（S3）：这里原来还支持"挂一个智能体组"（`formSource === 'group'` +
   *   `formGroupId` + `groupExecutor`）。组退场 ⇒ 定时任务只能选一个具体 agent。
   */
  $: executorAgents = executorCandidates($agents)
  $: executor = executorAgents.find((a) => a.id === formAgentId) ?? null
  $: executorName = executor?.name ?? null
  $: enabledCount = list.filter((s) => s.enabled).length

  /*
   * 右栏（D138 起走标准控件 `MainArea`）：这几个派生值就是"右栏现在该画什么"的全部判断。
   *
   * ⚠️ `detailOpen` 同时决定 `.split-layout` 的 `with-detail`——窄屏（≤72rem）时有这个类
   *    才显示右栏、藏掉列表；反过来（没选中、也没开表单）时必须**没有**它，否则一进这
   *    一页列表就是空的、还没有回去的路（D133 在编排页修过的同款缺陷）。
   */
  $: selected = list.find((x) => x.id === selectedId) ?? null
  $: detailOpen = $schedForm !== null || selected !== null
  // 只有「选中了某条、且不在表单里」时栏头才有副题；否则不传 sub，栏头不多一行空白。
  $: showSub = selected !== null && $schedForm === null
  $: detailTitle = $schedForm
    ? $t($schedForm.mode === 'create' ? 'schedules.createTitle' : 'schedules.updateTitle')
    : (selected?.name ?? '')

  /** 回列表：清掉选中与表单（窄屏「← 返回」与「取消」都走它）。 */
  function closeDetail(): void {
    selectedId = null
    closeForm()
  }
  /*
   * 搜索（D136）：栏头带的搜索框按**名字**过滤。
   * ⚠️ 只按名字、不按 cron 人话：那一栏是"什么时候跑"，人搜它的时候多半在找
   *    "那个每天跑的"，而他记得住的是名字。`emptyFiltered` 与 `empty` 分开说
   *    （有东西但没搜到 vs 真的一条都没有）由 ListPane 负责。
   */
  let filter = ''
  $: visible = list.filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()))

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
    formAgentId = $effectiveDefaultAgentId ?? executorAgents[0]?.id ?? ''
    formWorkDir = ''
    formResume = 'fresh'
    formError = ''
  }
  function fillEditFields(s: ScheduleView): void {
    formName = s.name
    form = scheduleCronToForm(s.cron)
    formTaskText = s.taskText
    formAgentId = s.executorId
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
    if (!formAgentId) {
      formError = tx('schedules.executorLabel') + '…' + tx('schedules.required')
      return
    }
    const executorId = formAgentId
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
            executorType: 'agent',
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
          // ★ 2026-11（用户实测："触发自动任务后没看到进入分组"）：触发即建了
          //   任务（带 source 进分组），任务列表的数据必须立刻跟上——否则切到
          //   任务页还是旧数据，新任务/新分组都看不见。
          await Promise.all([loadIssues(), loadRuns()])
        } else {
          showToast(tx('schedules.updatedToast'))
        }
      } else {
        const input: ScheduleCreateInput = {
          name: formName.trim(),
          cron: scheduleFormToCron(form),
          executorType: 'agent',
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
          await Promise.all([loadIssues(), loadRuns()])
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
      // ★ 2026-11（用户实测）：触发建的任务立即进任务列表（分组）——数据跟上
      await Promise.all([loadIssues(), loadRuns()])
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
  class="split-layout"
  class:with-detail={detailOpen}
  data-list-key="schedules"
  data-list-label={$t('shell.resizeList')}
  use:paneResize
>
  <!-- ══════════ 左栏：列表（标准控件 ListPane：计数 + 搜索 + 五态）══════════ -->
  <!--
    ⚠️ 2026-11（D136）：这里原来是**手搭的栏头**——`<h2>所有定时任务</h2>` + 一行
    「N 个启用 · 共 M 个」，既**没有搜索框**，栏头又比别的页高（84px vs 51px，
    因为它走的是全局 `.pane-head` 的 padding 而不是 `.list-toolbar`）。
    同一条规范（D61~D66：栏头带只有计数 + 搜索、不带标题、主操作在顶栏）在
    编排页是照着重排的，这一页当时漏了——探针的跨页对比只量三页，量不到它
    （理由写在 `tools/layout-probe/run.mjs` 的 `LIST_PAGES` 上）。
  -->
  <ListPane
    countLabel={$t('schedules.enabledCount', { enabled: enabledCount, total: list.length })}
    searchPlaceholder={$t('schedules.search')}
    {filter}
    onFilter={(v) => (filter = v)}
    loading={loading && list.length === 0}
    loadError={loadError}
    empty={list.length === 0}
    emptyTitle={$t('schedules.empty')}
    emptyHint={$t('schedules.emptyHint')}
    emptyFiltered={list.length > 0 && visible.length === 0}
    emptyFilteredTitle={$t('schedules.emptyFiltered')}
    emptyFilteredHint={$t('schedules.emptyFilteredHint')}
  >
    {#snippet rows()}
      <ul class="list-stack">
        {#each visible as s (s.id)}
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
              <span class="list-row-sub sched-sub">
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
    {/snippet}
  </ListPane>

  <!-- ══════════ 右栏（标准控件 MainArea：栏头 + 正文 + 窄屏返回 + 空态）══════════ -->
  <!--
    ★ 2026-11（D138）：这里原来是**手搭的** `<section class="pane-body schedules-main">`
    + 自写的 `.detail-head`；而且 `.split-layout` 上 `with-detail` **恒写**、全页没有
    `.back-to-list` —— 窄屏（≤72rem）时列表被 CSS 藏掉，右栏又给不出"回去"的路：
    一进这一页就无路可走（D133 在编排页修过的同一个缺陷，这一页当时漏了）。
    现在换成标准控件 `MainArea`：窄屏返回、空态、滚动容器都由它给；没选中任何一条时
    右栏说的是「选一条看详情」，不再是"还没有定时任务"（那是假话——左栏明明列着）。
  -->
  {#snippet schedSub()}
    {@const s = selected}
    {#if s !== null}
      <span class="pill">{s.humanCron}</span>
      {#if s.enabled && s.nextRunAt !== null}
        <span class="muted">{$t('schedules.next')} {relativeTime(s.nextRunAt, Date.now())}</span>
      {:else if !s.enabled}
        <span class="faint">{$t('schedules.disabled')}</span>
      {/if}
      {#if s.triggerCount > 0}
        <span class="muted">{$t('schedules.triggeredCount', { n: s.triggerCount })}</span>
      {/if}
    {/if}
    {/snippet}

  <MainArea
    empty={!detailOpen}
    emptyTitle={$t('schedules.pickHint')}
    emptyHint={$t('schedules.titleHint')}
    backLabel={detailOpen ? $t('schedules.backToList') : undefined}
    onBack={closeDetail}
    title={detailTitle}
    bodyClass="detail-scroll"
    sub={showSub ? schedSub : undefined}
  >
    <!--
      2026-11（D139）：`sub` **只在真有内容时传**（看 `showSub`）——给一个「表单态什么
      都不渲染」的 snippet，栏头会多出一行空白（标题看着偏高、按钮离标题更远）。
    -->

    {#snippet actions()}
      {@const s = selected}
      {#if $schedForm}
        <!-- ★ 保存放栏头（使用者要求：主操作在表单上部，不在最底下） -->
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
      {:else if s !== null}
        <button type="button" class="btn btn--secondary" onclick={() => void triggerNow(s)}>
          {$t('schedules.triggerNow')}
        </button>
        <button type="button" class="btn btn--ghost" onclick={() => openEdit(s)}>
          {$t('schedules.edit')}
        </button>
        <button type="button" class="btn btn--danger" onclick={() => void deleteSchedule(s)}>
          {$t('schedules.delete')}
        </button>
      {/if}
    {/snippet}
    {#snippet body()}

    {#if $schedForm}
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
              <div class="schedule-line keep-together">
                <span>{$t('schedules.everyMonthDay')}</span>
                <select bind:value={form.monthDay}>
                  <option value="L">{$t('schedules.lastDay')}</option>
                  {#each Array.from({ length: 31 }, (_, i) => i + 1) as day (day)}
                    <option value={day}>{day} 日</option>
                  {/each}
                </select>
              </div>
            {:else if form.freq === 'interval'}
              <div class="schedule-line keep-together">
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

          <!-- 要做什么：与「新建任务」同一个框、同一套模板。2026-11（使用者：
               模板可能写很长）：PromptField 控件（小框 + 右下角「⛶」展开大编辑器，
               6 个变量 chips 在弹层底部、插到光标处）；varsHint 仍说明 6 个变量。 -->
          <div class="field">
            <label>{$t('schedules.taskLabel')}</label>
            <PromptField
              bind:value={formTaskText}
              label={$t('schedules.taskLabel')}
              vars={VAR_CHIPS}
              placeholder={$t('schedules.taskPlaceholder')}
              rows={6}
            />
            <p class="hint">{$t('schedules.varsHint')}</p>
          </div>

          <!-- 交给谁：一个执行者（⚠️ 2026-11/S3：这里原来还有「智能体 / 组」互斥切换，
               组退场 ⇒ 只剩选人） -->
          <div class="field">
            <label>{$t('schedules.executorLabel')}</label>
            <select bind:value={formAgentId}>
              {#each executorAgents as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
            {#if executorName}
              <!-- ⚠️ 2026-11（D125）：这里原来还报"谁审"（`schedules.summary` 的
                   `reviewer` 插值）。审核 run 退场 ⇒ 定时任务也只说执行者。 -->
              <p class="hint summary-line">{$t('schedules.summaryExecutor', { executor: executorName })}</p>
            {/if}
          </div>

          <!-- 启动方式（2026-11 使用者三档定稿，顺序即此）：
               ① 新启动        = 新会话 + 新目录（每次触发从零开始，自动分配目录）
               ② 新启动·原目录 = 新会话 + 保持上次目录（从零聊但同一间屋子）
               ③ 接续·原目录   = 续上次会话 + 保持上次目录（FR-CLI-06；
                   第一次触发没有上次可续，自动按新起走）
               同一套 source-toggle 轨道，与「交给谁」、任务表单同款。 -->
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
                class:active={formResume === 'fresh-same-dir'}
                onclick={() => (formResume = 'fresh-same-dir')}
              >
                {$t('schedules.resumeFreshSameDir')}
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
            <div class="field-row">
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
    {:else if selected !== null}
      {@const s = selected}

        <div class="drawer-section">
          <h3>{$t('schedules.executorLabel')}</h3>
          <p class="muted">
            <!-- ⚠️ 2026-11（S3）：这里原来还分"组 / 单个智能体"两档取名字。组退场 ⇒
                 只剩 agent（老记录里 `executorType === 'group'` 的会显示那个组 id 原文，
                 并在触发时记一条 failed 说明要改选）。 -->
            {$agents.find((a) => a.id === s.executorId)?.name ?? s.executorId}
          </p>
          <!-- 启动方式 + 工作目录（有值才说；与表单同一句话） -->
          <p class="hint">
            {s.resumeMode === 'resume'
              ? $t('schedules.resumeLast')
              : s.resumeMode === 'fresh-same-dir'
                ? $t('schedules.resumeFreshSameDir')
                : $t('schedules.resumeFresh')}
            {#if s.workDir}
              · {$t('newtask.workDirLabel')}：<code class="mono">{s.workDir}</code>
            {/if}
          </p>
        </div>

        <div class="drawer-section">
          <h3>
            {$t('schedules.recordsTitle')}
            <span class="faint fs-xs">{$t('schedules.recordsHint', { n: s.records.length })}</span>
          </h3>
          {#if s.records.length === 0}
            <p class="empty empty--flush">
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
    {/snippet}
  </MainArea>

</div>

<style>
  /* ⚠️ 2026-11：这里原来有一份 `ul.list-stack` 的页面内重置（"左边空出一大截"那次
     修的）。Svelte 的 scoped 样式**不跨文件**，所以它只对定时任务页生效——编排页
     用了同一个类名却照样吃浏览器默认的 40px 缩进。现在那份在 `app.css`（全局，
     一处定义、六页照抄），页面里不许再写。 */
  .sched-title {
    /* ★ 310 批同款规矩（使用者报过"标题被拉成两行还带省略号"）：行内元素上
       overflow/text-overflow 不生效——必须 block + max-width:100%，省略号才有
       盒子可裁；2026-11（使用者："列表 item 宽度不对"）sched-title 漏了这两行。 */
    display: block;
    max-width: 100%;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* ⚠️ 2026-11（D142）：`.sched-sub` 的声明删了——这一页原来用 `align-items: center`，
     而这一行里混着徽标（「最近 15 小时前」后面那枚状态徽标），center 对齐的是盒子、
     不是文字 ⇒ 那段文字比前面几段**低 3px**（使用者报的"高度没对齐"）。
     现在统一走 app.css 的 `.list-row-sub`（基线对齐）。 */
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
  /* ⚠️ 2026-11（D138）：`.schedules-main { overflow-y: auto }` 删了——右栏改走标准控件
     `MainArea`，滚动容器是它里面的 `.pane-body.detail-scroll`。 */
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
  /* 2026-11（使用者："每月/间隔那行要放一行"）：全局 `select { width:100% }`
     + flex-wrap 在窄列里把「每月 [第…日]」「每 [30] 分钟」拆成两行。
     keep-together = nowrap + select 按内容宽；weekly 行**不动**（工作日快捷 +
     7 颗星期 pill 必须能换行）。 */
  .schedule-line.keep-together {
    flex-wrap: nowrap;
    white-space: nowrap;
  }
  .schedule-line.keep-together select {
    flex: 0 1 auto;
    min-width: 0;
    width: auto;
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
