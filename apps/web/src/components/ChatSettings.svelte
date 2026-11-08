<script lang="ts">
  import { api } from '../lib/api.ts'
  import { identity, loadIdentity } from '../lib/stores.ts'
  import { refreshVoiceCapability, voiceCapability } from '../lib/voice.ts'
  // `$t` 是 i18n store 的自动订阅名——**必须 import 进来**，否则模板里的 `$t` 指不到
  // 任何 store（svelte-check 报 "illegal variable name"，第 242 批第一次写就撞上）。
  import { t } from '../lib/i18n.ts'
  import SettingsPanel from './SettingsPanel.svelte'

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
  /**
   * ★ 295 批：`open` 不再需要——设置是不是开着由**页面**决定（它决定右栏放什么），
   * 组件自己只管画那一块面板。
   */
  export let onclose: () => void = () => {}

  const PLATFORM_DEFAULT = ['记住：', '以后', '下次别']

  /**
   * ══════════════ 语音（分批第 279 批）══════════════
   *
   * ★ 为什么这一节放在**聊天页的设置里**（而不是 App 设置）：麦克风按钮就在下面那条
   *   输入条上，人是从那里发现这个功能的，也就该在那里找到"模型 / 语言 / 灵敏度"。
   *   与触发词那次搬家同一个判断（见文件头那段）。
   *
   * ⚠️ 配置本身是**全局一份**（`~/.agentdeck/asr/settings.json`）：口述是个人习惯，
   *   换个对话就要重配一遍说不通。
   */
  interface VoiceSettings {
    model: string
    language: 'zh' | 'en' | 'auto'
    sensitivity: 'stable' | 'normal' | 'quick'
    denoise: boolean
    /** ★ 286 批：用对话里的标识符辅助识别（默认开）。 */
    useContextTerms?: boolean
    outputMode: 'input' | 'via-skill'
  }
  interface VoiceModelSpec {
    id: string
    label: string
    approxMb: number
  }

  /** 词典（两层：prompt 词 + 替换规则）。 */
  let vocab: { promptTerms: string[]; rules: Array<{ from: string; to: string }> } = {
    promptTerms: [],
    rules: [],
  }
  let vocabProblems: string[] = []
  let termInput = ''
  let ruleFrom = ''
  let ruleTo = ''

  /**
   * ⚠️ 分批第 284 批：能力状态**与输入条那颗按钮共用一份**（`lib/voice.ts`）。
   *   原来这里各存一份，于是"设置里说下载好了、按钮还说没有模型"——两处判断必然漂。
   */
  $: capability = $voiceCapability
  let settings: VoiceSettings | null = null
  let models: VoiceModelSpec[] = []
  let downloading = false
  /** 下载进度（0–100）；null = 没有在下载（分批第 282 批）。 */
  let downloadPercent: number | null = null
  let downloadDoneMb = 0
  let downloadTotalMb = 0
  let progressTimer: ReturnType<typeof setInterval> | null = null
  let downloadNote = ''
  let selftest = ''
  let selfTestNote = ''
  let selfTestOk = true

  /**
   * 打开抽屉时才去读（而不是挂载时）：这一页的抽屉默认关着，平时不该为它发请求。
   * ⚠️ 但能力探测**没有副作用**（不开麦、不弹权限窗），所以读一次是安全的。
   */
  // 面板一挂载就加载（它现在只在"设置开着"时被页面渲染出来）
  $: void refreshVoice()

  let voiceLoaded = false
  async function refreshVoice(): Promise<void> {
    if (voiceLoaded) return
    voiceLoaded = true
    await Promise.all([loadCapability(), loadSettings()])
  }

  async function loadCapability(): Promise<void> {
    // 走共享加载器：它会把结果写进 store，输入条那颗按钮同时看到
    await refreshVoiceCapability()
  }

  /** 读词表（与设置同一次请求拿回来，见下面 `loadSettings` 的注释）。 */
  function applyVocab(res: {
    promptTerms?: string[]
    rules?: Array<{ from: string; to: string }>
    problems?: string[]
  }): void {
    vocab = { promptTerms: res.promptTerms ?? [], rules: res.rules ?? [] }
    vocabProblems = res.problems ?? []
  }

  /**
   * 写词表：**整份替换**（服务端就是这么收的）。
   *
   * ⚠️ 失败时**不吞**：说清原因（人在改配置，静默失败会让他以为加上了）。
   */
  async function saveVocab(patch: {
    promptTerms?: string[]
    rules?: Array<{ from: string; to: string }>
  }): Promise<void> {
    error = ''
    try {
      const res = await api<{
        promptTerms: string[]
        rules: Array<{ from: string; to: string }>
        problems?: string[]
      }>('/api/voice/vocab', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          promptTerms: patch.promptTerms ?? vocab.promptTerms,
          rules: patch.rules ?? vocab.rules,
        }),
      })
      applyVocab(res)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function addTerm(): Promise<void> {
    const value = termInput.trim()
    if (value === '') return
    if (!vocab.promptTerms.includes(value)) {
      await saveVocab({ promptTerms: [...vocab.promptTerms, value] })
    }
    termInput = ''
  }

  async function addRule(): Promise<void> {
    const from = ruleFrom.trim()
    const to = ruleTo.trim()
    if (from === '' || to === '' || from === to) return
    const exists = vocab.rules.some((r) => r.from === from && r.to === to)
    if (!exists) await saveVocab({ rules: [...vocab.rules, { from, to }] })
    ruleFrom = ''
    ruleTo = ''
  }

  async function loadSettings(): Promise<void> {
    try {
      // 词表接口顺带带回 settings（一个请求拿两样东西）
      const res = await api<{
        settings: VoiceSettings
        promptTerms: string[]
        rules: Array<{ from: string; to: string }>
        problems?: string[]
      }>('/api/voice/vocab')
      settings = res.settings
      applyVocab(res)
      const catalog = await api<{ models: VoiceModelSpec[] }>('/api/voice/models').catch(() => null)
      models = catalog?.models ?? []
    } catch {
      settings = null
    }
  }

  /** 从 `<select>` 的 change 事件里取值（这个仓库的习惯写法，见 Chat.svelte 的 `onchange`）。 */
  function pick(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }

  async function saveSettings(patch: Partial<VoiceSettings>): Promise<void> {
    error = ''
    try {
      settings = await api<VoiceSettings>('/api/voice/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...settings, ...patch }),
      })
      await loadCapability()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * 轮询下载进度。
   *
   * ⚠️ 用 `setInterval` 而不是跟着 `ensure` 的响应走：`ensure` 是"下完才 resolve"的，
   *   等它回来时进度条已经没意义了。
   */
  function startProgressPolling(): void {
    stopProgressPolling()
    downloadPercent = 0
    progressTimer = setInterval(() => {
      void (async () => {
        try {
          const res = await api<{
            progress: { done: number; total: number; percent: number } | null
          }>('/api/voice/models/progress')
          if (res.progress === null) return
          downloadPercent = res.progress.percent
          downloadDoneMb = res.progress.done / 1048576
          downloadTotalMb = res.progress.total / 1048576
        } catch {
          // 轮询失败不打断下载（它还在跑），下一次再读
        }
      })()
    }, 500)
  }

  function stopProgressPolling(): void {
    if (progressTimer !== null) {
      clearInterval(progressTimer)
      progressTimer = null
    }
    downloadPercent = null
  }

  async function downloadModel(): Promise<void> {
    downloading = true
    downloadNote = ''
    error = ''
    startProgressPolling()
    try {
      const res = await api<{ downloaded: boolean; bytes: number; source?: string }>(
        '/api/voice/models/ensure',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: settings?.model }),
        },
      )
      /**
       * ★ 分批第 283 批：把**用的是哪条上游**说出来。直连官方不通时 daemon 会自动换
       *   镜像——不说的话，人会以为下的是官方的（下一次别人问"这文件哪来的"就没人答得上）。
       */
      const host = res.source === undefined ? '' : new URL(res.source).hostname
      downloadNote =
        host === ''
          ? $t('chat.voiceSettingsDownloaded', { mb: String(Math.round(res.bytes / 1048576)) })
          : $t('chat.voiceSettingsDownloadedFrom', {
              mb: String(Math.round(res.bytes / 1048576)),
              host,
            })
      await loadCapability()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      stopProgressPolling()
      downloading = false
    }
  }

  /**
   * 「试录 3 秒」：真的开一次麦克风、说三秒、看它认出什么。
   *
   * ★ 为什么值得做：这一条把**三件最容易坏的事**一次验完——麦克风权限、模型、写入口径
   *   （是不是把话变成字了）。分开验的话，人往往是在"点了没反应"之后才去逐个排查。
   * ⚠️ 3 秒是硬编码：自检要快，而"说完自动结束"靠的是 VAD（说话停顿两秒就会提前结束，
   *   那也是正常结果，不算失败）。
   */
  async function selfTest(): Promise<void> {
    selfTestNote = ''
    selfTestOk = true
    error = ''
    selftest = $t('chat.voiceSettingsSelfTestRecording')
    try {
      const started = await api<{ id: string }>('/api/voice/sessions', { method: 'POST' })
      await new Promise((r) => setTimeout(r, 3000))
      await api(`/api/voice/sessions/${encodeURIComponent(started.id)}/stop`, { method: 'POST' })
      for (let i = 0; i < 120; i += 1) {
        const snap = await api<{ state: string; text?: string; error?: string }>(
          `/api/voice/sessions/${encodeURIComponent(started.id)}`,
        )
        if (snap.state === 'done') {
          selfTestNote = $t('chat.voiceSettingsSelfTestHeard', { text: snap.text ?? '' })
          await loadCapability()
          return
        }
        if (snap.state === 'failed' || snap.state === 'cancelled') {
          selfTestOk = false
          selfTestNote = snap.error ?? $t('chat.voiceSettingsSelfTestFailed')
          return
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      selfTestOk = false
      selfTestNote = $t('chat.voiceSettingsSelfTestTimeout')
    } catch (err) {
      selfTestOk = false
      selfTestNote = $t('chat.voiceSettingsSelfTestFailed') + '：' + (err instanceof Error ? err.message : String(err))
    } finally {
      selftest = ''
    }
  }

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

<!--
  ★ 分批第 295 批（使用者："聊天设置，智能体设置，都改成和沉淀设置一样，放在主区"）：
  **不再是右抽屉**，而是主区里的一块面板（与沉淀设置、技能/工具的「安装」同一族）。
  理由：抽屉会**盖住**正在编辑的那段对话，而设置恰恰是"对着它改"的；主区面板把右栏
  整块换掉、左栏还在，与沉淀页的做法完全同款。
  ⚠️ 返回入口必须**一直可见**（`.panel-back`）——列表被面板换掉了，"点列表回去"这条
    路此刻不存在；也**不再用 Esc**（它不是浮层，拦 Esc 会抢掉输入框的 Esc）。
-->
<SettingsPanel
  title={$t('chat.settingsTitle')}
  subtitle={$t('chat.settingsSubtitle')}
  onback={onclose}
>
  {#snippet body()}
  <section class="drawer-section" data-voice-settings>
    <h3>{$t('chat.voiceSettingsHeading')}</h3>
    <p class="hint">{$t('chat.voiceSettingsHint')}</p>

    <!--
      ★ 分批第 279 批：状态行先说清"现在能不能用"。
        不能用时**原因 + 修法**一起给（下载模型 / 换机器 / 去系统设置勾权限）——
        "点了没反应"是这个功能最想避免的那种失败。
    -->
    <p class="voice-status" data-voice-status>
      {#if capability === null}
        <span class="faint fs-xs">{$t('chat.voiceSettingsChecking')}</span>
      {:else if capability.available}
        <span class="ok-dot"></span>{$t('chat.voiceSettingsReady')}
      {:else}
        <span class="bad-dot"></span>{capability.reason}
      {/if}
    </p>

    <div class="voice-row">
      <label class="voice-field">
        <span>{$t('chat.voiceSettingsModel')}</span>
        <select data-voice-model onchange={(e) => void saveSettings({ model: pick(e) })}>
          {#each models as m (m.id)}
            <option value={m.id} selected={settings?.model === m.id}>
              {m.label} · {m.approxMb} MiB
            </option>
          {/each}
        </select>
      </label>
      <label class="voice-field">
        <span>{$t('chat.voiceSettingsLanguage')}</span>
        <select
          data-voice-language
          onchange={(e) => void saveSettings({ language: pick(e) as VoiceSettings['language'] })}
        >
          <option value="zh" selected={settings?.language === 'zh'}>{$t('chat.voiceLanguageZh')}</option>
          <option value="en" selected={settings?.language === 'en'}>{$t('chat.voiceLanguageEn')}</option>
          <option value="auto" selected={settings?.language === 'auto'}
            >{$t('chat.voiceLanguageAuto')}</option
          >
        </select>
      </label>
    </div>

    <div class="voice-row">
      <label class="voice-field">
        <span>{$t('chat.voiceSettingsSensitivity')}</span>
        <select
          data-voice-sensitivity
          onchange={(e) =>
            void saveSettings({ sensitivity: pick(e) as VoiceSettings['sensitivity'] })}
        >
          <option value="stable" selected={settings?.sensitivity === 'stable'}
            >{$t('chat.voiceSensitivityStable')}</option
          >
          <option value="normal" selected={settings?.sensitivity === 'normal'}
            >{$t('chat.voiceSensitivityNormal')}</option
          >
          <option value="quick" selected={settings?.sensitivity === 'quick'}
            >{$t('chat.voiceSensitivityQuick')}</option
          >
        </select>
      </label>
      <!-- ★ 286 批：用对话里的标识符辅助识别（默认开；关掉之后手动词表照旧生效） -->
      <label class="voice-check" title={$t('chat.voiceSettingsContextHint')}>
        <input
          type="checkbox"
          data-voice-context
          checked={settings?.useContextTerms !== false}
          onchange={(e) =>
            void saveSettings({ useContextTerms: (e.currentTarget as HTMLInputElement).checked })}
        />
        <span>{$t('chat.voiceSettingsContext')}</span>
      </label>
      <label class="voice-check" title={$t('chat.voiceSettingsDenoiseHint')}>
        <input
          type="checkbox"
          data-voice-denoise
          checked={settings?.denoise === true}
          onchange={(e) => void saveSettings({ denoise: (e.currentTarget as HTMLInputElement).checked })}
        />
        <span>{$t('chat.voiceSettingsDenoise')}</span>
      </label>
    </div>

    <!-- ★ 分批第 281 批：识别完之后走哪条路（回填输入框 / 先替你发一条消息） -->
    <label class="voice-field voice-output" title={$t('chat.voiceSettingsOutputHint')}>
      <span>{$t('chat.voiceSettingsOutput')}</span>
      <select
        data-voice-output
        onchange={(e) => void saveSettings({ outputMode: pick(e) as VoiceSettings['outputMode'] })}
      >
        <option value="input" selected={settings?.outputMode === 'input'}
          >{$t('chat.voiceOutputInput')}</option
        >
        <option value="via-skill" selected={settings?.outputMode === 'via-skill'}
          >{$t('chat.voiceOutputViaSkill')}</option
        >
      </select>
    </label>

    <!-- 模型没下时给一颗按钮；下的时候说"在下"（进度条是后面的事，现在只有一个状态） -->
    <div class="voice-row">
      {#if capability !== null && !capability.model.present}
        <button
          type="button"
          class="btn btn--secondary"
          data-voice-download
          disabled={downloading}
          onclick={() => void downloadModel()}
        >{downloading
            ? downloadPercent === null
              ? $t('chat.voiceSettingsDownloading')
              : $t('chat.voiceSettingsDownloadPercent', { pct: String(downloadPercent) })
            : $t('chat.voiceSettingsDownload', { mb: String(capability.model.approxMb) })}</button>
        <!-- ★ 282 批：进度条（"在动"与"卡死"必须分得开——一次 57 MiB 在慢网络下能跑几十秒） -->
        {#if downloading && downloadPercent !== null}
          <span class="voice-progress" data-voice-progress>
            <span class="voice-progress-bar" style:width={`${downloadPercent}%`}></span>
          </span>
          <span class="faint fs-xs" data-voice-progress-text
            >{downloadDoneMb.toFixed(1)} / {downloadTotalMb.toFixed(1)} MiB</span
          >
        {/if}
      {:else}
        <button
          type="button"
          class="btn btn--ghost"
          data-voice-selftest
          disabled={selftest !== ''}
          onclick={() => void selfTest()}
        >{selftest === '' ? $t('chat.voiceSettingsSelfTest') : selftest}</button>
      {/if}
      <span class="faint fs-xs mono voice-path" title={capability?.paths?.asrRoot ?? ''}
        >{capability?.paths?.asrRoot ?? ''}</span
      >
    </div>

    {#if downloadNote !== ''}
      <p class="hint" data-voice-download-note>{downloadNote}</p>
    {/if}
    {#if selfTestNote !== ''}
      <p class="hint {selfTestOk ? '' : 'bad'}" data-voice-selftest-note>{selfTestNote}</p>
    {/if}
    {#if error !== ''}
      <p class="hint bad" data-voice-error>{error}</p>
    {/if}

    <!--
      ★ 分批第 295 批（使用者："我就认为专有名词是为语音输入的，不应该是并列放置"）：
      「专有名词」**降为语音输入的子块**。它只作用于识别（initialPrompt + 替换规则），
      与"打字/记忆"无关——并列会让人以为它还有别的用处。
    -->
      <div class="sub-block" data-voice-vocab>
      <h4>{$t('chat.voiceVocabHeading')}</h4>
      <p class="hint">{$t('chat.voiceVocabHint')}</p>

      <!-- 第一层：进 initialPrompt 的词（只放"正确写法"） -->
      <p class="voice-label">{$t('chat.voiceVocabPromptLabel')}</p>
      <div class="prefix-chips" data-voice-term-chips>
        {#each vocab.promptTerms as term, i (term)}
          <span class="prefix-chip">
            <span class="mono">{term}</span>
            <button
              type="button"
              class="prefix-x"
              data-voice-term-remove
              aria-label={$t('chat.settingsMemoryRemove', { word: term })}
              onclick={() => void saveVocab({ promptTerms: vocab.promptTerms.filter((_, k) => k !== i) })}>×</button
            >
          </span>
        {/each}
        {#if vocab.promptTerms.length === 0}
          <span class="faint fs-xs">{$t('chat.voiceVocabEmpty')}</span>
        {/if}
      </div>
      <div class="prefix-add">
        <input
          bind:value={termInput}
          placeholder={$t('chat.voiceVocabTermPlaceholder')}
          data-voice-term-input
          onkeydown={(e) => {
            if (e.key === 'Enter') void addTerm()
          }}
        />
        <button type="button" class="btn btn--secondary" data-voice-term-add onclick={() => void addTerm()}>
          {$t('chat.settingsMemoryAdd')}
        </button>
      </div>

      <!-- 第二层：替换规则（"常被听成的样子" → "正确写法"） -->
      <p class="voice-label">{$t('chat.voiceVocabRuleLabel')}</p>
      <div class="voice-rules" data-voice-rules>
        {#each vocab.rules as rule, i (rule.from + rule.to)}
          <span class="voice-rule">
            <span class="mono">{rule.from}</span>
            <span class="faint">→</span>
            <span class="mono">{rule.to}</span>
            <button
              type="button"
              class="prefix-x"
              data-voice-rule-remove
              aria-label={$t('chat.settingsMemoryRemove', { word: rule.from })}
              onclick={() => void saveVocab({ rules: vocab.rules.filter((_, k) => k !== i) })}>×</button
            >
          </span>
        {/each}
        {#if vocab.rules.length === 0}
          <span class="faint fs-xs">{$t('chat.voiceVocabEmpty')}</span>
        {/if}
      </div>
      <div class="prefix-add">
        <input
          bind:value={ruleFrom}
          placeholder={$t('chat.voiceVocabFromPlaceholder')}
          data-voice-rule-from
        />
        <span class="faint">→</span>
        <input
          bind:value={ruleTo}
          placeholder={$t('chat.voiceVocabToPlaceholder')}
          data-voice-rule-to
          onkeydown={(e) => {
            if (e.key === 'Enter') void addRule()
          }}
        />
        <button type="button" class="btn btn--secondary" data-voice-rule-add onclick={() => void addRule()}>
          {$t('chat.settingsMemoryAdd')}
        </button>
      </div>
      {#if vocabProblems.length > 0}
        <p class="hint bad" data-voice-vocab-problems>{vocabProblems.join('；')}</p>
      {/if}

    </div>
  </section>

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
        <span class="faint fs-xs" data-prefix-empty>{$t('chat.settingsMemoryOff')}</span>
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
      <button type="button" class="btn btn--secondary" data-prefix-add onclick={() => void add()}>
        {$t('chat.settingsMemoryAdd')}
      </button>
      <button type="button" class="btn btn--ghost" data-prefix-reset onclick={() => void reset()}>
        {$t('chat.settingsMemoryReset')}
      </button>
    </div>
    {#if error !== ''}
      <p class="hint bad" data-prefix-error>{error}</p>
    {/if}
  </section>
  {/snippet}
</SettingsPanel>

<style>
  /*
   * 触发词的 chip 列表。样式原本住在 `SettingsDrawer.svelte`（第 240 批），
   * 第 242 批跟着这一节搬到聊天页——留在那边就是一段没人用的 CSS。
   */
  /**
   * ★ 295 批：「专有名词」是**语音输入的子块**（使用者："我就认为专有名词是为语音输入的，
   *   不应该是并列放置"）——用左侧一条竖线 + 缩进表达层级，而不是另起一个同级小节。
   *   它只作用于识别（`initialPrompt` + 替换规则），与打字/记忆无关。
   */
  .sub-block {
    margin-top: var(--sp-3);
    padding-left: var(--sp-3);
    border-left: 2px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  }

  .sub-block h4 {
    font-size: var(--fs-sm);
    margin: 0 0 var(--sp-1);
  }

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
    border-radius: var(--radius-pill);
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
    padding: 0;
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

  /**
   * ══════════ 语音那一节（分批第 279 批）══════════
   *
   * 两条布局规矩：
   *   · 一行里**最多两个控件**（下拉太宽，两个刚好铺满抽屉），第三个会挤成两行字；
   *   · 状态那一行**不折行**（"可用/不可用 + 一句原因"要一眼扫过去），太长就省略并
   *     把全文放进 `title`——这一节的第一件事是"我现在能不能用"。
   */
  .voice-status {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin: var(--sp-2) 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ok-dot,
  .bad-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  .ok-dot {
    background: var(--good);
  }
  .bad-dot {
    background: var(--bad);
  }
  .voice-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
    flex-wrap: wrap;
  }
  .voice-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    flex: 1 1 8rem;
    min-width: 0;
  }
  .voice-field select {
    width: 100%;
  }
  .voice-check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    margin: 0;
    white-space: nowrap;
  }
  .voice-label {
    font-size: var(--fs-xs);
    color: var(--text-faint);
    margin: var(--sp-2) 0 var(--sp-1);
  }
  /* 规则列表：一条一行（`from → to` + 删），不折行 */
  .voice-rules {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: var(--sp-2);
  }
  .voice-rule {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 下载进度条：与按钮同一行，吃掉剩下的宽度 */
  .voice-progress {
    flex: 1 1 8rem;
    min-width: 6rem;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--surface-2);
    overflow: hidden;
  }
  .voice-progress-bar {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s linear;
  }

  /* 输出方式那一行：整行给下拉（它有三档、字也长，挤在并排里会折行） */
  .voice-output {
    flex: 1 1 100%;
  }
  .voice-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
</style>
