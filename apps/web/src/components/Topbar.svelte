<script lang="ts">
  import { unreadCount } from '../lib/stores.ts'
  import { LOCALES, LOCALE_LABEL, isLocale, type Locale } from '@alpha-helper/i18n'
  import { locale, setLocale, t } from '../lib/i18n.ts'
  import { openDrawer } from '../lib/view.ts'
  import {
    remoteAccount,
    remoteError,
    remoteLoggedIn,
    remotePlugins,
  } from '../lib/remote-store.ts'

  /**
   * 账号控件。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么登录必须出现在顶栏
   * ══════════════════════════════════════════════════════════════════
   *
   * 它原来只藏在设置抽屉里。而"我登录了没有"是个**随时都要能一眼看到**的
   * 状态——它决定了远端能力（目录、待处理项、上报）能不能用。埋进抽屉之后，
   * 使用者的体验就是"登录不见了"。
   *
   * 顶栏右侧是它天然的位置：与身份（这台机器装着什么 CLI）并列，都属于
   * "全局的、与当前视图无关"的东西。
   */
  /**
   * 顶栏。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这里只放"与当前视图无关"的东西
   * ══════════════════════════════════════════════════════════════════
   *
   * 身份（这是哪台机器、跑着哪些 CLI）、账号、通知、设置。任何属于某个视图的
   * 内容都不该出现在这里——否则切视图时它会显得"没跟着变"，而使用者
   * 会以为是 bug。
   */
  $: failing = $remotePlugins.filter((p) => !p.loaded).length

  /**
   * 语言切换（D39）。
   *
   * 放在顶栏：它是**随时会改**的偏好（跟"我是谁"同一类），而设置抽屉里也有同一份
   * ——两处指向同一个 store，不会各存一份。
   *
   * ⚠️ 只翻界面文字：交给模型的 prompt 不变（会多一条"请用 X 回答"的指令）。
   */
  function switchLocale(next: string): void {
    if (isLocale(next)) void setLocale(next as Locale)
  }

</script>

<header class="topbar">
  <div class="brand">alpha-helper</div>

  <!--
    这里原来还有一段"设备 / CLI 版本 / 证据等级"的诊断行。它挪到了侧栏底部
    （见 Sidebar.svelte 的说明）：那条带子是界面上最显眼的位置，而诊断信息是
    排查时才看的。顶栏只留"去哪儿"（品牌）与"我是谁"（账号、通知）。
  -->
  <div class="topbar-actions">
    <!-- 语言切换：两个语言各自用自己的写法（中文 / English），
         一个只看得懂英文的人在中文界面里也要能找到它 -->
    <label class="lang">
      <span class="visually-hidden">{$t('shell.language')}</span>
      <select
        value={$locale}
        aria-label={$t('shell.language')}
        onchange={(e) => switchLocale((e.currentTarget as HTMLSelectElement).value)}
      >
        {#each LOCALES as l (l)}
          <option value={l}>{LOCALE_LABEL[l]}</option>
        {/each}
      </select>
    </label>

    <button type="button" class="ghost" onclick={() => openDrawer.set('inbox')}>
      {$t('shell.inbox')}
      {#if $unreadCount > 0}
        <span class="badge in_progress">{$unreadCount}</span>
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
    <button type="button" class="ghost" onclick={() => openDrawer.set('settings')}>
      {$t('shell.settings')}
    </button>
  </div>
</header>

<style>
  /* 语言选择器：一个紧凑的下拉（顶栏不该出现一个占半屏的控件） */
  .lang select {
    padding: 2px var(--sp-2);
    font-size: var(--fs-sm);
    background: transparent;
    border-color: var(--line);
  }

  /* 无障碍：标签只给读屏器看 */
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* 账号控件：头像 + 名字。用头像是因为纯文字的名字在顶栏里很容易
     和"设置"这类按钮混成一片，而一个圆形色块能立刻把它区分开 */
  .account {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    padding-left: var(--sp-1);
  }

  .avatar {
    width: 1.5rem;
    height: 1.5rem;
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
