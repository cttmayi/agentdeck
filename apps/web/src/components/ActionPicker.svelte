<script lang="ts">
  import { loading, loadError, tools } from '../lib/stores.ts'
  import { splitAllowedActions } from '../lib/agent-actions.ts'
  import { actionsOf, openParams, boundParams, installedActionCount } from '../lib/tool-view.ts'
  import { go } from '../lib/view.ts'
  import { t } from '../lib/i18n.ts'
  import type { WebTextId } from '@agentdeck/i18n'
  import ActionParamEditor from './ActionParamEditor.svelte'

  /**
   * 「行动权限」的编辑栏：**允许触发哪些动作 + 每个动作的固定参数**（D43 收口，
   * D44 重排）。
   *
   * ══════════════════════════════════════════════════════════════════
   * D44：从"平铺勾选清单"改成"**左选右配**"
   * ══════════════════════════════════════════════════════════════════
   *
   * 行动一多，每个动作一行「勾选框 + 契约值 + 摘要 + 挂一段参数编辑器」就滚成
   * 一条很长的清单：挑动作和配动作混在一起，改哪一个都要先找它在哪。新布局把
   * 两件事拆开——
   *
   *   · **左栏 = 挑动作**：搜索框 + 筛选标签（全部/已允许/有固定参数/不可用）+
   *     按工具包分组折叠 + 「全部展开/折叠」。每行只有：勾选框、契约值、摘要、
   *     一个小徽标（这个动作钉了几个固定值）。
   *   · **右栏 = 配动作**：聚焦"当前选中"那一个——允许开关（与左栏勾选框
   *     实时联动）+ 开放参数的固定编辑器 + 只读的绑定参数。
   *
   * 行为约定（使用者拍过板的）：
   *   · 点**勾选框**只改允许、不换选中；点**行**只换选中、不改允许。
   *   · 改动是**草稿**：父组件的「保存」按钮才是提交点（这个组件只画、不存）。
   *   · **未允许**的动作在右栏只给开关 + 一句说明，参数区锁定——固定参数只对
   *     允许的动作有意义（父组件保存时按允许名单裁剪，见各调用处）。
   *   · 默认选中第一个"允许且有开放参数"的动作（右栏一进来就不是空的）；
   *     没有则选第一个允许的动作；再没有则选第一个动作（显示锁定态）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它是**受控**的（父组件持有值）：这个组件只画，不存。
   * ══════════════════════════════════════════════════════════════════
   *
   * 与旧 `ActionPermissions.svelte` 同一套接口，因此智能体页（长期配置）与
   * 新建任务页 ③（这一次任务的覆盖）**共用**这一个组件，只差文案
   * （`variant: 'agent' | 'task'`）。
   */
  export let value: readonly string[] = [] // 允许的动作（契约值）
  export let onchange: (next: string[]) => void = () => {}
  /** 动作 → 参数名 → 固定值。同一套受控规矩。 */
  export let params: Record<string, Record<string, unknown>> = {}
  export let onparams: (next: Record<string, Record<string, unknown>>) => void = () => {}
  /**
   * 标了「调试」的动作（`debugActions`，2026-09）——是 `value` 的**子集**。
   *
   * ⚠️ 只在**审核者长期配置**（`variant: 'agent'`）里出现：调试是审核者自己的
   *    设定，没有"这一次任务覆盖"（任务级只有白名单与固定参数那两档）。
   */
  export let debug: readonly string[] = []
  export let ondebug: (next: string[]) => void = () => {}
  /** 文案变体：`agent` = 审核者长期配置；`task` = 这一次任务的覆盖。 */
  export let variant: 'agent' | 'task' = 'agent'

  type Filter = 'all' | 'allowed' | 'params' | 'dead'
  let selected: string | null = null
  let filter: Filter = 'all'
  let query = ''
  let collapsed = new Set<string>()

  /** 某个动作的 open 参数规格（enum/boolean/integer/string 的控件就靠它）。 */
  function specOf(type: string): ReturnType<typeof openParams> {
    for (const tool of $tools) {
      for (const item of actionsOf(tool)) {
        if (item.type === type) return openParams(item.action)
      }
    }
    return []
  }

  /** 某个动作的绑定参数（右栏只读区）。 */
  function boundOf(type: string): ReturnType<typeof boundParams> {
    for (const tool of $tools) {
      for (const item of actionsOf(tool)) {
        if (item.type === type) return boundParams(item.action)
      }
    }
    return []
  }

  /**
   * ★★ D44 修过的一个 Svelte 4 坑：**模板里函数调用内读 `value`/`params` 不会触发
   *    重渲**（状态条能更新、列表却不刷新）。所以凡是要跟着这两个 prop 变的
   *    显示，一律先在 `$:` 语句里算成反应式变量（`$:` 会跟踪 prop 读），模板只
   *    读变量。下面的 `groups`/`deadRows` 就是为这件事存在的。
   */
  $: allActions = $tools.flatMap((tool) =>
    actionsOf(tool).map((item) => ({ tool, item })),
  )

  /**
   * ★ 存着但**现在解析不出来**的动作（D41 收尾）：只显示 + 给移除入口，
   *   不静默剔除（详见旧 `ActionPermissions.svelte` 里那一段的说明，判断
   *   同样要在 `$tools` 到手之后才成立）。
   */
  $: toolsKnown = !$loading['tools'] && !$loadError['tools']
  $: unresolved = toolsKnown ? splitAllowedActions(value, $tools).unavailable : []

  // 默认选中：第一个"允许且有开放参数"的动作；没有则第一个允许的动作；
  // 再没有则第一个动作（右栏显示锁定态，说明这一栏还活着）。
  $: if (toolsKnown && selected === null) {
    const withParams = allActions.find(
      ({ item }) => value.includes(item.type) && specOf(item.type).length > 0,
    )
    const firstAllowed = allActions.find(({ item }) => value.includes(item.type))
    selected = withParams?.item.type ?? firstAllowed?.item.type ?? allActions[0]?.item.type ?? null
  }

  $: selItem = selected ? allActions.find(({ item }) => item.type === selected) ?? null : null
  $: selAllowed = !!selected && value.includes(selected)

  /** 左栏当前可见的分组（搜索/筛选/计数在这里算好，模板只读这个变量）。 */
  $: groups = (() => {
    const needle = query.trim().toLowerCase()
    const out: Array<{
      tool: (typeof $tools)[number]
      items: ReturnType<typeof actionsOf>
      allowed: number
    }> = []
    for (const tool of $tools) {
      const items = actionsOf(tool).filter((item) => {
        if (filter === 'allowed' && !value.includes(item.type)) return false
        if (
          filter === 'params' &&
          !(params[item.type] ? Object.keys(params[item.type] ?? {}).length > 0 : false)
        )
          return false
        if (filter === 'dead') return false
        if (
          needle &&
          !(
            item.type.toLowerCase().includes(needle) ||
            item.action.summary.toLowerCase().includes(needle) ||
            tool.slug.toLowerCase().includes(needle)
          )
        )
          return false
        return true
      })
      if (items.length > 0) {
        out.push({
          tool,
          items,
          allowed: actionsOf(tool).filter((item) => value.includes(item.type)).length,
        })
      }
    }
    return out
  })()

  /** 「配过、但现在解析不出来」那一组：全部/不可用两种筛选下可见，搜索也认。 */
  $: deadRows = (() => {
    if (filter === 'dead') return unresolved
    if (filter !== 'all') return []
    const needle = query.trim().toLowerCase()
    if (!needle) return unresolved
    return unresolved.filter((type) => type.toLowerCase().includes(needle))
  })()

  function toggle(action: string, on: boolean): void {
    onchange(on ? [...value, action] : value.filter((a) => a !== action))
    // ★ 调试是允许的**子集**：取消允许时调试必须一起摘，否则会留下一个"没允许
    //    却标着调试"的动作（服务端写入口也会拒，但界面不该给那个错的机会）。
    if (!on && debug.includes(action)) ondebug(debug.filter((a) => a !== action))
  }
  function toggleDebug(action: string, on: boolean): void {
    ondebug(on ? [...debug, action] : debug.filter((a) => a !== action))
  }
  function drop(type: string): void {
    onchange(value.filter((a) => a !== type))
  }
  function toggleSelectedAllow(): void {
    if (!selected) return
    toggle(selected, !selAllowed)
  }

  function toggleGroup(slug: string): void {
    collapsed = new Set(collapsed)
    if (collapsed.has(slug)) collapsed.delete(slug)
    else collapsed.add(slug)
  }
  function toggleAll(): void {
    collapsed =
      collapsed.size === 0 ? new Set($tools.map((tool) => tool.slug)) : new Set()
  }

  const filters: Array<{ kind: Filter; label: WebTextId }> = [
    { kind: 'all', label: 'tools.pickerFilterAll' },
    { kind: 'allowed', label: 'tools.pickerFilterAllowed' },
    { kind: 'params', label: 'tools.pickerFilterFixed' },
    { kind: 'dead', label: 'tools.pickerFilterDead' },
  ]

  $: allowedCount = value.length
  $: fixedCount = allActions.filter(({ item }) =>
    params[item.type] ? Object.keys(params[item.type] ?? {}).length > 0 : false,
  ).length
</script>

<div class="action-perms">
  {#if !toolsKnown}
    <!--
      ⚠️ 清单还没到（或没取到）：这里**一句关于工具的话都不说**。
         "还没有装任何工具包"此刻可能是假的，而"哪些动作解析不出来"更是无从谈起
         ——这半秒里正确的做法是留白。（取失败那一档由「工具」页负责。）
    -->
  {:else if $tools.length === 0 && unresolved.length === 0}
    <!--
      ★ 空态（D41）：一个工具包都没装 ⇒ 这一栏**一项可勾的都没有**。
         说清两件事：为什么没有、下一步去哪（动作只能来自装进来的包）。
    -->
    <div class="empty-state">
      <p class="empty-value">
        <strong>{$t('agents.actionsNoToolsStrong')}</strong>{$t('agents.actionsNoToolsHint')}
      </p>
      <button type="button" class="secondary small" onclick={() => go('tools')}>
        {$t('agents.actionsGoTools')}
      </button>
    </div>
  {:else}
    <!-- ══ 顶部状态条：计数 + 筛选 + 全部展开/折叠 + 搜索 ══ -->
    <div class="picker-head">
      <span class="ap-status">
        {$t('tools.pickerCount', { allowed: allowedCount, total: installedActionCount($tools), fixed: fixedCount })}
      </span>
      <div class="ap-chips">
        {#each filters as f (f.kind)}
          <button type="button" class="ap-chip" class:on={filter === f.kind} onclick={() => (filter = f.kind)}>
            {$t(f.label)}
          </button>
        {/each}
      </div>
      <button type="button" class="ap-expand" onclick={toggleAll}>
        {collapsed.size === 0 ? $t('tools.pickerCollapseAll') : $t('tools.pickerExpandAll')}
      </button>
      <input
        class="ap-search"
        type="search"
        placeholder={$t('tools.pickerSearch')}
        value={query}
        oninput={(e) => (query = (e.currentTarget as HTMLInputElement).value)}
      />
    </div>

    <div class="picker-body">
      <!-- ══ 左栏：按包分组的动作清单 ══ -->
      <div class="ap-list">
        {#each groups as { tool, items, allowed } (tool.id)}
          <div class="ap-group" data-slug={tool.slug}>
            <button
              type="button"
              class="ap-group-head"
              onclick={() => toggleGroup(tool.slug)}
              aria-expanded={!collapsed.has(tool.slug)}
            >
              <span class="ap-caret">{collapsed.has(tool.slug) ? '▸' : '▾'}</span>
              <code class="ap-slug">{tool.slug}</code>
              <span class="ap-tname">{tool.name}</span>
              <span class="ap-group-count">
                {$t('tools.pickerGroupCount', { allowed, total: items.length })}
              </span>
            </button>
            {#if !collapsed.has(tool.slug)}
              {#each items as item (item.type)}
                <!-- 点勾选框只改允许、不换选中；点行只换选中、不改允许（D44） -->
                <div
                  class="ap-row"
                  class:sel={item.type === selected}
                  data-type={item.type}
                  role="button"
                  tabindex="0"
                  onclick={() => (selected = item.type)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      selected = item.type
                    }
                  }}
                >
                  <input
                    type="checkbox"
                    class="ap-ck"
                    value={item.type}
                    checked={value.includes(item.type)}
                    onclick={(e) => e.stopPropagation()}
                    onchange={(e) =>
                      toggle(item.type, (e.currentTarget as HTMLInputElement).checked)}
                  />
                  <!-- 契约值（判决里写的就这一串）与它的说明**一起**显示 -->
                  <code class="ap-ct">{item.type}</code>
                  <span class="action-summary">{item.action.summary}</span>
                  {#if (params[item.type] ? Object.keys(params[item.type] ?? {}).length : 0) > 0}
                    <span class="ap-badge fixed">
                      {$t('tools.pickerBadgeFixed', {
                        n: Object.keys(params[item.type] ?? {}).length,
                      })}
                    </span>
                  {/if}
                  {#if variant === 'agent' && value.includes(item.type)}
                    <!-- ★ 调试（2026-09）：只对**已允许**的动作出现（是允许的子集），
                         也只出现在审核者长期配置（`variant: 'agent'`）里——任务级
                         没有调试这一档。勾上 = 这个动作执行时不跑脚本、只记录动作
                         与解析后的参数（时间线显示「调试 · 未执行」）。 -->
                    <span class="ap-debug" title={$t('agents.actionsDebugHint')}>
                      <input
                        type="checkbox"
                        class="ap-dbg-ck"
                        checked={debug.includes(item.type)}
                        onclick={(e) => e.stopPropagation()}
                        onchange={(e) =>
                          toggleDebug(item.type, (e.currentTarget as HTMLInputElement).checked)}
                      />
                      <span class="ap-dbg-txt">{$t('agents.actionsDebug')}</span>
                    </span>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        {/each}

        {#if deadRows.length > 0}
          <!--
            ★ "配过、现在解析不出来"那一组：排在上面的可选清单之外、并且不放进
               同一个容器——它不是"可选项"，而是一条要先处理的欠债。每条给一个
               「移除」——使用者显式点一下才改权限。
          -->
          <div class="ap-group dead">
            <div class="ap-group-head">
              <span class="ap-caret">▾</span>
              <span class="ap-dead-title">{$t('agents.actionsUnresolvedHeading')}</span>
              <span class="ap-group-count">{deadRows.length}</span>
            </div>
            {#each deadRows as type (type)}
              <div class="ap-row dead" data-type={type}>
                <!-- 契约值原样显示（它就是这个字符串），不翻译 -->
                <code class="ap-ct dead">{type}</code>
                <!-- 与只读态那条 chip 用**同一个标记词条**（同一个状态同一个名字） -->
                <span class="action-summary bad">{$t('agents.actionsUnresolvedChip')}</span>
                <button type="button" class="ghost small" onclick={() => drop(type)}>
                  {$t('agents.actionsUnresolvedDrop')}
                </button>
              </div>
            {/each}
            <p class="ap-hint dead-hint">
              {$t('agents.actionsUnresolvedHint')}{$t('agents.actionsUnresolvedFixInEdit')}
            </p>
          </div>
        {/if}

        {#if groups.length === 0 && deadRows.length === 0}
          <p class="ap-no-match">{$t('tools.pickerNoMatch')}</p>
        {/if}
      </div>

      <!-- ══ 右栏：选中动作的配置 ══ -->
      <div class="ap-detail">
        {#if !selected || !selItem}
          <p class="ap-placeholder">{$t('tools.pickerSelectHint')}</p>
        {:else}
          {@const sel = selected as string}
          <div class="ap-act-title">
            <code>{selItem.item.type}</code>
            <span class="ap-pk">{selItem.tool.slug}</span>
          </div>
          <p class="ap-act-sum">{selItem.item.action.summary}</p>

          <div class="ap-switch-row">
            <button
              type="button"
              class="ap-switch"
              class:on={selAllowed}
              aria-pressed={selAllowed}
              aria-label={variant === 'task'
                ? $t('tools.pickerAllowTask')
                : $t('tools.pickerAllowAgent')}
              onclick={toggleSelectedAllow}
            ></button>
            <span class="ap-switch-label">
              {variant === 'task' ? $t('tools.pickerAllowTask') : $t('tools.pickerAllowAgent')}
            </span>
            <span class="ap-switch-state">{selAllowed ? $t('tools.pickerOn') : $t('tools.pickerOff')}</span>
          </div>

          {#if selAllowed}
            <!--
              ★ 固定参数（D43/D44）：只对**允许的**动作出现，也只给"现在解析得出
                 定义"的动作（unresolved 连规格都没有，无从钉值）。
            -->
            <div class="ap-section">
              <div class="ap-section-title">{$t('tools.pickerOpenHeading')}</div>
              {#if specOf(sel).length > 0}
                <ActionParamEditor
                  items={specOf(sel)}
                  params={params[sel] ?? {}}
                  onparams={(next) => onparams({ ...params, [sel]: next })}
                />
              {:else}
                <p class="ap-hint">{$t('tools.paramFixedNone')}</p>
              {/if}
            </div>
          {:else}
            <p class="ap-locked">{$t('tools.pickerLocked')}</p>
          {/if}

          <div class="ap-section">
            <div class="ap-section-title">{$t('tools.pickerBoundHeading')}</div>
            {#if boundOf(sel).length === 0}
              <p class="ap-hint">{$t('tools.pickerNoBound')}</p>
            {:else}
              {#each boundOf(sel) as b (b.name)}
                <div class="ap-bound-row">
                  <code>{b.name}</code>
                  <span>{$t(b.label.id, b.label.params ?? {})}</span>
                </div>
              {/each}
            {/if}
          </div>

          <p class="ap-foot">
            {variant === 'task'
              ? $t('tools.pickerFootTask')
              : $t('tools.pickerFootAgent')}
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .action-perms {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    /* 跟着容器走：不写 `min-width: 0` 时，内部两栏的固有宽度会把它顶出父栏
       （智能体详情那一栏实测被顶到 950px > 725px）。 */
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    /* 两栏还是叠起来，按**容器**宽度决定（见下面 @container） */
    container-type: inline-size;
    container-name: picker;
  }

  /* ── 空态 ── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
  }
  .empty-value {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--fs-sm);
    max-width: 46ch;
  }

  /* ── 顶部状态条 ── */
  .picker-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .ap-status {
    color: var(--text-dim);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .ap-chips {
    display: flex;
    gap: var(--sp-1);
    flex-wrap: wrap;
  }
  .ap-chip {
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--text-dim);
    border-radius: 999px;
    padding: 1px 9px;
    font-size: var(--fs-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .ap-chip.on {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: #fff;
  }
  .ap-expand {
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--text-dim);
    border-radius: var(--radius-sm);
    padding: 1px 8px;
    font-size: var(--fs-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .ap-expand:hover {
    color: var(--accent);
    border-color: var(--accent-dim);
  }
  .ap-search {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 2px 8px;
    font-size: var(--fs-xs);
    width: 13rem;
    outline: none;
  }
  .ap-search:focus {
    border-color: var(--accent);
  }

  /* ── 两栏主体 ── */
  .picker-body {
    display: flex;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    overflow: hidden;
    min-width: 0;
  }

  /**
   * ⚠️ 容器窄的时候（智能体详情那一栏就只有 ~560px，抽屉里更窄）两栏并排会把
   *    右栏挤到 200px 上下——"配参数"那一栏比清单还重要，挤没了就白搭。
   *    所以按**容器**宽度而不是视口宽度决定：窄了就上下叠（清单在上、配置在下），
   *    各自满宽。用 container query 而不是 media query，因为这个组件同时活在
   *    整宽的新建任务页和窄栏的智能体详情里，同一个视口宽度下两者差别很大。
   *    （`container-type` 声明在上面 `.action-perms` 那条规则里。）
   */
  @container picker (max-width: 40rem) {
    .picker-body { flex-direction: column; }
    .ap-list {
      width: 100%;
      max-width: none;
      max-height: 18rem;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .ap-detail { max-height: 22rem; }
  }

  .ap-list {
    /* 清单那一栏给一个**上下限**：太窄看不出契约值，太宽则每一行拉得很散。
       用 flex-basis + 上下限，宽容器下多出来的宽度留给右栏（配参数更需要它）。 */
    flex: 0 1 auto;
    width: 48%;
    min-width: 13rem;
    max-width: 30rem;
    border-right: 1px solid var(--line);
    max-height: 26rem;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .ap-detail {
    flex: 1;
    min-width: 0;
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    max-height: 26rem;
    overflow: auto;
  }

  /* ── 分组 ── */
  .ap-group {
    border-bottom: 1px solid var(--line);
  }
  .ap-group-head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-2);
    border: none;
    border-radius: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .ap-group-head:hover {
    background: var(--surface-hover);
  }
  .ap-caret {
    color: var(--text-faint);
    font-size: var(--fs-xs);
    width: 0.7rem;
  }
  .ap-slug {
    font-size: var(--fs-sm);
  }
  .ap-tname {
    color: var(--text-faint);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ap-group-count {
    margin-left: auto;
    color: var(--text-faint);
    font-size: var(--fs-xs);
    white-space: nowrap;
  }

  /* ── 动作行 ── */
  .ap-row {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-3);
    cursor: pointer;
    border-left: 2px solid transparent;
  }
  .ap-row:hover {
    background: var(--surface-hover);
  }
  .ap-row.sel {
    background: var(--surface-2);
    border-left-color: var(--accent);
  }
  .ap-ck {
    width: auto;
    flex: none;
    align-self: center;
  }
  .ap-ct {
    font-size: var(--fs-sm);
    white-space: nowrap;
    flex: none;
  }
  .ap-row .action-summary {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ap-badge.fixed {
    font-size: 10px;
    border-radius: 999px;
    padding: 0 7px;
    flex: none;
    color: var(--good);
    border: 1px solid rgba(78, 201, 160, 0.4);
    background: rgba(78, 201, 160, 0.08);
    white-space: nowrap;
  }

  /* ★ 调试勾选（2026-09）：小、弱、贴着行尾——它是"偶尔看一眼"的调试位，
     不是日常开关，不能抢「允许」那个勾选的存在感 */
  .ap-debug {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: auto;
    flex: none;
    color: var(--text-dim);
    font-size: var(--fs-xs);
    cursor: pointer;
    white-space: nowrap;
    padding-left: var(--sp-2);
    border-left: 1px solid var(--line);
  }
  .ap-dbg-ck {
    margin: 0;
    accent-color: var(--text-dim);
  }
  .ap-dbg-txt {
    line-height: 1;
  }

  /* 「配过、解析不出来」那一组 */
  .ap-group.dead {
    border-top: 2px solid var(--bad);
  }
  .ap-dead-title {
    color: var(--bad);
    font-size: var(--fs-sm);
  }
  .ap-row.dead {
    cursor: default;
  }
  .ap-row.dead .ap-ct.dead {
    color: var(--text-faint);
    text-decoration: line-through;
  }
  .ap-row.dead .action-summary.bad {
    color: var(--bad);
  }

  .ap-no-match {
    color: var(--text-faint);
    font-size: var(--fs-sm);
    padding: var(--sp-3);
    text-align: center;
  }

  /* ── 右栏 ── */
  .ap-placeholder {
    color: var(--text-faint);
    text-align: center;
    /* 2026-10（紧凑性）：原来上下各 48px（sp-8）写死——`margin: auto` 在
       flex column 里垂直居中、随栏高自适应，去掉了那 96px 的固定空白。 */
    margin: auto var(--sp-3);
    font-size: var(--fs-sm);
  }
  .ap-act-title {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .ap-act-title code {
    font-size: var(--fs-md);
  }
  .ap-pk {
    color: var(--accent);
    font-size: var(--fs-xs);
  }
  .ap-act-sum {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }

  .ap-switch-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .ap-switch {
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--line-strong);
    position: relative;
    cursor: pointer;
    flex: none;
    padding: 0;
    transition: background 0.12s;
  }
  .ap-switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-dim);
    transition: left 0.12s;
  }
  .ap-switch.on {
    background: var(--accent-dim);
    border-color: var(--accent);
  }
  .ap-switch.on::after {
    left: 18px;
    background: #fff;
  }
  .ap-switch-label {
    font-weight: 600;
    font-size: var(--fs-sm);
  }
  .ap-switch-state {
    color: var(--text-faint);
    font-size: var(--fs-xs);
  }

  .ap-section {
    border-top: 1px solid var(--line);
    padding-top: var(--sp-2);
  }
  .ap-section-title {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin-bottom: var(--sp-1);
  }
  .ap-hint {
    color: var(--text-faint);
    font-size: var(--fs-xs);
    margin: 0;
  }
  .ap-locked {
    color: var(--warn);
    font-size: var(--fs-sm);
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-sm);
    padding: var(--sp-2);
    margin: 0;
  }
  .ap-bound-row {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-dim);
    padding: 1px 0;
  }
  .ap-bound-row code {
    color: var(--text-faint);
  }
  .ap-foot {
    color: var(--text-faint);
    font-size: var(--fs-xs);
    margin: 0;
  }
</style>
