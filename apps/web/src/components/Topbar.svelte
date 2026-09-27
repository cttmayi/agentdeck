<script lang="ts">
  import { unreadCount } from '../lib/stores.ts'
  import { t } from '../lib/i18n.ts'
  import { VIEW_TITLE_KEYS, openDrawer, view } from '../lib/view.ts'
  import { actionsFor, pageActions } from '../lib/page-actions.ts'
  import {
    remoteAccount,
    remoteError,
    remoteLoggedIn,
    remotePlugins,
  } from '../lib/remote-store.ts'

  /**
   * 顶栏。
   *
   * ══════════════════════════════════════════════════════════════════
   * 三段：这是哪一页 | 这一页能做什么 | 与页面无关的那些
   * ══════════════════════════════════════════════════════════════════
   *
   * ```
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │ AgentDeck │ 智能体  [新建] [设置] [刷新]                 通知① 登录 设置 │
   * └──────────────────────────────────────────────────────────────────────┘
   *   品牌 + 页名 ┘└ 这一页的动作（各视图登记）        全局项（永远在这）┘
   * ```
   *
   * ★ 2026-09 改版（这条**推翻了**原来那句"任何属于某个视图的内容都不该出现在
   *   这里"）。原来的理由是"否则切视图时它会显得没跟着变"——那个担心是对的，
   *   但结论错了：它说的是"不能放**不跟着变**的视图内容"，而不是"不能放视图内容"。
   *   真正的毛病是**同一个页面两处各有各的动作行**：
   *
   *   · 任务/智能体的动作在**左栏**的 `pane-head` 里，Skills/工具的在页面
   *     `view-head` 里，聊天又在左栏——四个页面三种形状，"刷新"在不同页面
   *     出现在不同位置。使用者的代价是每次都要重新找。
   *   · 顶栏里"页名右边"那块本来是空的。它是界面上最稳定的一条带子，而"这一页能做什么"
   *     恰恰是最该稳定的东西。
   *
   * ⚠️ 同一次改版里还改过一版"动作推到最右、用一条竖线隔开"，**又改回来了**：
   *    推到最右之后它离页名一千多像素，"我在哪一页"与"我能做什么"变成屏幕上
   *    两件不相干的事，而它们本来是一句话。现在动作**紧跟着页名**，右边只留
   *    与页面无关的那几个——两组靠距离分开，连分隔线都不需要。
   *
   * ⚠️ 页名与侧栏**共用同一个词条**（`VIEW_TITLE_KEYS` → `shell.nav*` /
   *    `tools.navTitle`）：两处各写一份，迟早变成侧栏说"任务清单"、顶栏说"任务"。
   *
   * ⚠️ 动作由各视图登记，这里**不认识任何一个具体按钮**（理由见
   *    `lib/page-actions.ts`）。按视图名过滤这一步也在那边（`actionsFor`），
   *    因为"换页时旧组件的清理不该清掉新页"这条只有它知道。
   */
  $: failing = $remotePlugins.filter((p) => !p.loaded).length

  /** 当前这一页的动作（登记的不是这一页就是空的）。 */
  $: pageActionsOfView = actionsFor($pageActions, $view)

  /** 窄屏把动作收进 `⋯`：这里是那个小菜单的开关。 */
  let moreOpen = false

  /** 换页时把菜单收起来——否则新页的动作会顶着一个展开的菜单出现。 */
  $: if ($view) moreOpen = false

  function onKeydown(event: KeyboardEvent): void {
    // Esc 关菜单：与两个抽屉同一个习惯（`App.svelte` 管抽屉，这里管自己这一层）
    if (event.key === 'Escape' && moreOpen) moreOpen = false
  }
</script>

<svelte:window onkeydown={onKeydown} />

<header class="topbar">
  <!--
    ═══ 左格：与侧栏同一列宽（`--sidebar-w`）═══
    品牌 + 页名。把它放在**侧栏那条带子的正上方**：下方就是侧栏（导航），
    左右两边对齐之后，"这一格是站点的、这一列是导航的"一眼就看出来。
  -->
  <div class="topbar-left">
    <div class="brand">AgentDeck</div>

    <!--
      页名。它是**这一页的主标题**，所以用 `<h1>`：主区里的 `h2`（"任务清单"、
      "智能体"…）从此都挂在它下面，而不是各自当一篇文档的开头。
    -->
    <span class="page-sep" aria-hidden="true"></span>
    <h1 class="page-name">{$t(VIEW_TITLE_KEYS[$view])}</h1>
  </div>

  <!--
    ═══ 右格：从侧栏右缘开始（与主区同一列起点）═══
    这一页的动作 + 与页面无关的那几个。

    ★ 2026-09 第二稿：动作的**左缘与侧栏右缘对齐**（也就是与下面主区内容的左缘
       对齐）。之前它紧跟着页名，页名一短（比如「聊天」只有两个字）动作就悬在
       侧栏上方的半空里，跟下面的清单栏对不齐。现在它在结构上就和主区共一条
       竖线——不是"差不多对齐"，是同一个 `grid-template-columns` 算出来的。
  -->
  <div class="topbar-right">
  <!--
    ★ 这一页的动作：**紧跟页名**（靠左），不推到右边去。
       推到右边时它离页名一千多像素，屏幕上一排按钮与"我是哪一页"是两件互不相干的
       事——而它们本来是一句话："**在智能体这一页**，你能新建/设置/刷新"。
       靠左之后，"这一页 + 这一页能做什么"读起来是连着的，右侧留给与页面无关的
       那几个（通知 / 登录 / 设置）——两组之间靠距离分开，不需要分隔线。

    ⚠️ 宽屏平铺、窄屏收进 `⋯`：两处渲染的是**同一份数据**（见 `lib/page-actions.ts`），
       不是两套按钮。
  -->
  <div class="page-actions" aria-label={$t('shell.pageActions')} role="group">
    {#each pageActionsOfView as action (action.id)}
      <button
        type="button"
        class={action.kind ?? 'secondary'}
        class:active={action.active}
        disabled={action.disabled}
        title={action.title}
        onclick={action.onActivate}
      >{action.label}</button>
    {/each}
  </div>

  {#if pageActionsOfView.length > 0}
    <div class="page-more">
      <button
        type="button"
        class="ghost more-btn"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-label={$t('shell.pageActionsMore')}
        title={$t('shell.pageActionsMore')}
        onclick={() => (moreOpen = !moreOpen)}>⋯</button
      >
      {#if moreOpen}
        <!-- 点空白处关闭：与抽屉用同一招（全屏透明遮罩），不发愁"点哪儿算外面" -->
        <div class="menu-backdrop" role="presentation" onclick={() => (moreOpen = false)}></div>
        <div class="page-menu" role="menu" aria-label={$t('shell.pageActions')}>
          {#each pageActionsOfView as action (action.id)}
            <button
              type="button"
              role="menuitem"
              class:active={action.active}
              disabled={action.disabled}
              title={action.title}
              onclick={() => {
                moreOpen = false
                action.onActivate()
                }}>{action.label}</button
              >
            {/each}
          </div>
        {/if}
      </div>
  {/if}

  <!--
    ⚠️ 这一层 `.global-actions` 不是装饰：它是"与页面无关的那几个"的**边界**。
       页面动作里也有叫「设置」的（智能体页那个），英文下同样叫 Settings——
       没有这一层的话，"顶栏那个设置按钮翻译了吗"就只能按文字在全条顶栏里找，
       找到的是哪一个全看顺序（探针里那条就这么量错过一次）。
       `margin-left: auto` 把它推到最右：它与左边的"这一页的动作"之间那段空白
       就是分组本身，不需要画一条分隔线。
  -->
  <div class="global-actions">
    <!-- ★ 2026-09：全局项从"三个文字按钮"改成"图标按钮"——这一组是与页面
         无关的**常驻控件**（通知/账号/设置），不是动作，文字按钮让它看起来
         和左边那一排页面动作一样重。图标 + tooltip 是顶栏控件该有的样子：
         一眼是控件，hover 才说明是哪个。icon 只做装饰（`aria-hidden`），
         名字由 `aria-label` 给读屏器。 -->
    <button
      type="button"
      class="ghost icon-btn"
      onclick={() => openDrawer.set('inbox')}
      aria-label={$t('shell.inbox')}
      title={$t('shell.inbox')}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      {#if $unreadCount > 0}
        <span class="badge in_progress unread">{$unreadCount}</span>
      {/if}
    </button>
    {#if $remoteLoggedIn}
      <button
        type="button"
        class="ghost account"
        onclick={() => openDrawer.set('settings')}
        title={$remoteAccount?.email ?? ''}
      >
        <span class="avatar">{$remoteAccount?.displayName?.slice(0, 1)?.toUpperCase() ?? '?'}</span>
        <span class="account-name"
          >{$remoteAccount?.displayName ?? $t('shell.signedIn')}</span
        >
        {#if failing > 0}
          <!-- 有插件加载失败时给个提示：插件清单是排查入口，不该等人主动去翻 -->
          <span class="warn" title={$t('shell.pluginsFailing', { count: failing })}>⚠</span>
        {/if}
      </button>
    {:else}
      <button
        type="button"
        class="ghost login"
        onclick={() => openDrawer.set('remote')}
        title={$remoteError || $t('shell.signInHint')}
      >
        {$remoteError ? $t('shell.signInRemoteDown') : $t('shell.signIn')}
      </button>
    {/if}
    <button
      type="button"
      class="ghost icon-btn"
      onclick={() => openDrawer.set('settings')}
      aria-label={$t('shell.settings')}
      title={$t('shell.settings')}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
        />
      </svg>
    </button>
  </div>
  </div>
</header>

<style>
  /* ⚠️ 这里只放**顶栏组件自己的**外观（头像、账号名）。
     这一条带子怎么排（`.page-name` / `.page-actions` / `.global-actions` / 窄屏的
     `⋯` 与菜单、以及顶栏里按钮统一成什么尺寸）写在 `styles/app.css` 的
     「布局骨架」一段里——`.topbar` 本来就在那儿，拆成两处会更难看出它怎么排。 */

  /* 图标按钮（通知/设置）：SVG 只做装饰，大小跟着按钮走 */
  .icon-btn svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }

  /* 未读徽标紧贴铃铛图标：数字小、不占位，只在有未读时出现。
     圆点藏掉——铃铛自己就是图标，旁边再放一个状态点会变成"两个圆" */
  .icon-btn .unread {
    padding: 0 0.3rem;
    min-width: 1.1rem;
    justify-content: center;
  }
  .icon-btn .unread::before {
    display: none;
  }

  /* 账号控件：头像 + 名字。用头像是因为纯文字的名字在顶栏里很容易
     和"设置"这类按钮混成一片，而一个圆形色块能立刻把它区分开。
     ⚠️ 左边留给头像的内距小一点（字与头像之间由 `app.css` 那条统一规则的
        `gap` 管），头像本身也**不超过按钮高度**——顶栏那一排按钮钉成同一个
        高度（1.9rem），头像 24px 会把账号按钮顶高一头。 */
  .account {
    padding-left: var(--sp-1);
  }

  .avatar {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: var(--accent-dim);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--fs-xs);
    font-weight: 600;
    flex: none;
  }

  .account-name {
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 未登录时给它一点强调色：这是一个**待完成**的动作，不是普通导航 */
  .login {
    color: var(--accent);
  }
</style>
