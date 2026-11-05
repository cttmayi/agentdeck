<script lang="ts">
  import Drawer from './Drawer.svelte'
  import { api } from '../lib/api.ts'
  import { identity, loadIdentity } from '../lib/stores.ts'
  // `$t` 是 i18n store 的自动订阅名——**必须 import 进来**，否则模板里的 `$t` 指不到
  // 任何 store（svelte-check 报 "illegal variable name"，第 242 批第一次写就撞上）。
  import { t } from '../lib/i18n.ts'

  /**
   * 聊天页的「设置」抽屉。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么这一页要自己开一个设置入口
   * ══════════════════════════════════════════════════════════════════
   *
   * 里面那唯一一样东西是**记忆触发词**——它管的是"你在聊天里怎么说话会被记住"。
   * 第一版把它放在**全局 App 设置**抽屉里（和主题、远端地址、诊断信息挤在一起）：
   * 使用者的原话是「聊天有个设置，里面有触发词的设置」——他找的地方是聊天页，
   * 而不是"整个平台的应用设置"。位置错不是小事：一个配置项找不着，就等于没有。
   *
   * 所以入口搬到聊天页，**配置本身仍然是全局一份**（`Workspace.memoryPrefixes`）：
   * 触发词是**人的措辞习惯**，你对着执行者、对着审核员说的是同一句"记住：以后
   * 报告都用中文"。做成每个对话一份的结果是"换个它就要换一种说法"，没人解释得清。
   * 抽屉的副标题把这件事写在脸上。
   *
   * ⚠️ 别处的同名配置一律删掉（这里搬过来之后 App 设置里那份就没有了）：
   *    同一份数据两个编辑入口 ⇒ "我改的是哪一个"迟早要问一次。
   */
  export let open = false
  export let onclose: () => void = () => {}

  const PLATFORM_DEFAULT = ['记住：', '以后', '下次别']

  let draft: string[] = []
  let last: string[] = []
  let input = ''
  let error = ''

  /**
   * 铺初值：只在"还没铺过"或"服务端那份变了"时覆盖草稿。
   * 无条件覆盖会把正在编辑的那份冲掉（加一半的词忽然消失）。
   */
  $: if ($identity !== null) {
    const fromServer = $identity.memoryPrefixes ?? []
    if (draft.length === 0 || JSON.stringify(draft) !== JSON.stringify(last)) {
      draft = [...fromServer]
      last = [...fromServer]
    }
  }

  /**
   * 写回服务端（全量替换），成功后重新读身份。
   *
   * ★ 没有"保存"按钮：这是"几个词"的开关式配置，不是一张表单——点掉一个词就该
   *   立刻生效。失败时保留旧值并**说清原因**（不拿本地状态假装成功）。
   */
  async function save(next: string[]): Promise<void> {
    error = ''
    try {
      const res = await api<{ prefixes: string[] }>('/api/workspace/memory-prefixes', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: next }),
      })
      draft = [...res.prefixes]
      last = [...res.prefixes]
      await loadIdentity()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function add(): Promise<void> {
    const value = input.trim()
    if (value === '') return
    if (draft.includes(value)) {
      input = ''
      return
    }
    await save([...draft, value])
    input = ''
  }

  async function remove(index: number): Promise<void> {
    await save(draft.filter((_, i) => i !== index))
  }

  /** 「恢复默认」= 把平台那三个写回去。**清空**是另一件事（= 关掉这个功能）。 */
  async function reset(): Promise<void> {
    await save([...PLATFORM_DEFAULT])
  }
</script>

<Drawer
  {open}
  title={$t('chat.settingsTitle')}
  subtitle={$t('chat.settingsSubtitle')}
  {onclose}
>
  <section class="drawer-section" data-memory-prefixes>
    <h3>{$t('chat.settingsMemoryHeading')}</h3>
    <p class="hint">{$t('chat.settingsMemoryHint')}</p>
    <div class="prefix-chips" data-prefix-chips>
      {#each draft as p, i (p)}
        <span class="prefix-chip">
          <span class="mono">{p}</span>
          <button
            type="button"
            class="prefix-x"
            data-prefix-remove
            aria-label={$t('chat.settingsMemoryRemove', { word: p })}
            onclick={() => void remove(i)}>×</button
          >
        </span>
      {/each}
      {#if draft.length === 0}
        <span class="faint small" data-prefix-empty>{$t('chat.settingsMemoryOff')}</span>
      {/if}
    </div>
    <div class="prefix-add">
      <input
        bind:value={input}
        placeholder={$t('chat.settingsMemoryAddPlaceholder')}
        aria-label={$t('chat.settingsMemoryAddPlaceholder')}
        data-prefix-input
        onkeydown={(e) => {
          if (e.key === 'Enter') void add()
        }}
      />
      <button type="button" class="secondary" data-prefix-add onclick={() => void add()}>
        {$t('chat.settingsMemoryAdd')}
      </button>
      <button type="button" class="ghost" data-prefix-reset onclick={() => void reset()}>
        {$t('chat.settingsMemoryReset')}
      </button>
    </div>
    {#if error !== ''}
      <p class="hint bad" data-prefix-error>{error}</p>
    {/if}
  </section>
</Drawer>

<style>
  /*
   * 触发词的 chip 列表。样式原本住在 `SettingsDrawer.svelte`（第 240 批），
   * 第 242 批跟着这一节搬到聊天页——留在那边就是一段没人用的 CSS。
   */
  .prefix-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
    margin: var(--sp-2) 0;
  }
  .prefix-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 var(--sp-1) 0 var(--sp-2);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    font-size: var(--fs-xs);
    color: var(--text);
    /* ★ 不许折行（中文的 min-content 是一个字）：第 230 批那颗「浏览…」被挤成
       两行的教训，见 probe 里 `chat.pickerButtonLabels` 那条判据。 */
    white-space: nowrap;
  }
  .prefix-x {
    border: 0;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    font: inherit;
    padding: 0 2px;
  }
  .prefix-x:hover {
    color: var(--text);
  }
  .prefix-add {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }
  .prefix-add input {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* 「加」「恢复默认」也不许折行 */
  .prefix-add button {
    white-space: nowrap;
    flex: none;
  }
</style>
