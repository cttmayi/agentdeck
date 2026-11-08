<script lang="ts">
  /**
   * 语音口述的按钮（分批第 278 批）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它只做三件事：开录音、显示状态、把文本交回去
   * ══════════════════════════════════════════════════════════════════
   *
   * ⚠️ **它不认识"聊天"**：`ontext` 把识别结果交给调用方，回填到输入框还是发给谁，
   *   是调用方的事。这样做是为了使用者那句"先做聊天，做好兼容，后面做任务"——
   *   任务输入框接上它时，这一页一行都不用改。
   *
   * ⚠️ **它也不发送**：识别完只是把字交出去（约束：保存/发送由上层决定）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么不自己开麦克风
   * ══════════════════════════════════════════════════════════════════
   *
   * 采集在 **daemon** 侧（decibri + Silero VAD）。浏览器拿不到"说完自动停"这种判定：
   * 浏览器版 decibri 只有能量阈值，安静房间永远判"没说话"、有风扇的房间永远判"一直在说"。
   * 而且 daemon 侧才能用上 highpass/denoise 那条前处理链（Whisper 对低频噪声很敏感）。
   *
   * 代价是权限归 daemon 进程（macOS 的 TCC 跟着"谁拉起 daemon"）——所以失败时的
   * 话必须能照着做，见 `capability.reason` 与 `chat.voicePermissionHint`。
   */
  import { onDestroy, onMount } from 'svelte'
  import { t } from '../lib/i18n.ts'
  import { identity } from '../lib/stores.ts'
  import { showToast } from '../lib/view.ts'
  import { refreshVoiceCapability, voiceCapability } from '../lib/voice.ts'

  let {
    /**
     * ★ 分批第 286 批：这次口述发生在**哪个对话**里。
     *
     * 给了它，daemon 会从这个对话里抽"标识符"补进 whisper 的 initialPrompt
     * （实测：`Agent Deck` 能被听成 `AgentDeck`）；不给就是"没有上下文"，录音照常。
     * ⚠️ 这里交给它的是**一个 id**，不是对话内容——读哪个对话、读多少，是 daemon 的事。
     */
    conversationId = '',
    /** 识别出的文本（**替换过专有名词的**那份）。 */
    ontext,
    /** 录音过程中给调用方的状态（界面可据此禁用输入框之类；现在聊天页用不到）。 */
    onstate,
  }: {
    conversationId?: string
    ontext: (text: string, meta: { raw: string; corrections: number }) => void
    onstate?: (state: VoiceState) => void
  } = $props()

  type VoiceState = 'idle' | 'recording' | 'transcribing'

  interface Snapshot {
    id: string
    state: 'recording' | 'transcribing' | 'done' | 'failed' | 'cancelled'
    elapsedMs: number
    level: number
    phase: 'waiting-speech' | 'speaking' | null
    text?: string
    raw?: string
    corrections?: Array<{ from: string; to: string; count: number }>
    /** 这次真的用上的"对话词"（286 批；没有就是 undefined）。 */
    contextTerms?: string[]
    error?: string
  }

  let phase = $state<VoiceState>('idle')
  let detail = $state<Snapshot | null>(null)
  let sessionId = $state('')
  let elapsedMs = $state(0)
  let level = $state(0)
  /**
   * ★ 分批第 289 批（使用者："预览改一个位置，可以放在录制按钮的下面，名字可能要改一下，
   *   不应该还叫预览。它就可以预览当前对话的取词"）：
   *
   * 把"这个对话会贡献哪些词"从设置抽屉搬到**按钮下面**——它就长在口头相邻的位置，
   * 而不再是一个要进设置里找的动作。名字也从「预览」改成「取词」：
   * 这不是"预览某件要发生的事"，而是"这一句识别会带上的词"。
   */
  let terms = $state<{ terms: string[]; userTurns: number; agentReplies: number; auto: boolean } | null>(
    null,
  )
  let termsOpen = $state(false)
  let termsBusy = $state(false)
  /**
   * 取词失败的原因。
   * ⚠️ 必须有它：否则失败时浮层一直显示"正在取…"——那和"点了没反应"一样糟
   *   （使用者实测报过"点了取词没反应"）。
   */
  let termsError = $state('')

  /** 拉一次"本对话取词"（与真正录音同一条路：同一个抽词器 + 同一份手动词表）。 */
  async function loadTerms(): Promise<void> {
    if (termsBusy) return
    termsBusy = true
    termsError = ''
    try {
      const res = await fetch('/api/voice/context-terms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      })
      if (res.ok) {
        terms = (await res.json()) as {
          terms: string[]
          userTurns: number
          agentReplies: number
          auto: boolean
        }
      } else {
        termsError = $t('chat.voiceTermsFailed', { code: String(res.status) })
      }
    } catch (err) {
      // 取词拿不到不影响录音（它只是"这次带上哪些词"的说明），但要说出来
      termsError = $t('chat.voiceTermsFailedDetail', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      termsBusy = false
    }
  }

  function toggleTerms(): void {
    termsOpen = !termsOpen
    if (termsOpen) void loadTerms()
  }

  /** 轮询的句柄（`setTimeout` 的 id，用来在卸载/取消时停掉）。 */
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  /** daemon 支不支持这条接口（旧 daemon 上没有 `/api/voice/*`）。 */
  const supported = $derived(($identity?.capabilities ?? []).includes('voice-dictation'))

  /**
   * 能力探测放在挂载时做一次：它**没有副作用**（不开麦克风、不申请权限），
   * 所以可以提前知道"这台机器能不能用"，从而在按钮上直接把原因说清楚，
   * 而不是等人点了才报错。
   */
  onMount(() => {
    if (!supported) return
    // 探测失败不挡按钮：真点的时候还会再查一次，而且那时的话更具体
    void refreshVoiceCapability()
  })

  onDestroy(() => {
    stopPolling()
    // 页面走了就别把麦克风留在 daemon 手里（一次录音最长两分钟，但人走开更常见）
    if (sessionId !== '') {
      void fetch(`/api/voice/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: 'POST',
      }).catch(() => {})
    }
  })

  // 换了一个对话 ⇒ 取词也得重来（它是按对话算的）
  $effect(() => {
    void conversationId
    terms = null
    termsOpen = false
  })

  // 状态外泄给调用方（页面可据此做点别的；现在聊天页用不到，但接口先开着）
  $effect(() => {
    onstate?.(phase)
  })

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  /** 轮询会话状态：录音时拿电平与时长，结束后拿结果。 */
  function poll(id: string): void {
    stopPolling()
    pollTimer = setTimeout(() => void (async () => {
      try {
        const snap = (await fetch(
          `/api/voice/sessions/${encodeURIComponent(id)}`,
        ).then((r) => r.json())) as Snapshot
        detail = snap
        elapsedMs = snap.elapsedMs
        level = snap.level
        if (snap.state === 'recording') {
          poll(id)
          return
        }
        if (snap.state === 'transcribing') {
          phase = 'transcribing'
          poll(id)
          return
        }
        // 终态
        stopPolling()
        sessionId = ''
        phase = 'idle'
        level = 0
        if (snap.state === 'done' && snap.text !== undefined) {
          ontext(snap.text, { raw: snap.raw ?? snap.text, corrections: snap.corrections?.length ?? 0 })
          /**
           * ★ 286 批：说了什么用上过，就回显什么——"它凭什么这么认得"要能回答。
           *   toast 一闪而过、不占栏脚高度（285 批定的口径）。
           */
          const ctx = snap.contextTerms?.length ?? 0
          const fixed = snap.corrections?.length ?? 0
          if (ctx > 0 || fixed > 0) {
            showToast($t('chat.voiceDoneSummary', { ctx: String(ctx), fixed: String(fixed) }))
          }
        } else if (snap.state === 'failed') {
          // ★ 285 批：一次性的失败也用 toast——它只该闪一下，不该在栏脚常驻一行
          showToast(snap.error ?? $t('chat.voiceFailedNoReason'))
        }
      } catch {
        stopPolling()
        sessionId = ''
        phase = 'idle'
        showToast($t('chat.voiceLost'))
      }
    })(), 200)
  }

  async function start(): Promise<void> {
    detail = null
    /**
     * ★ 分批第 284 批（使用者报的："small 已经下载好了，录制时还提示『还没有语音模型
     *   small』，重新刷新后正常"）：这里是**现查**，不是用挂载时那一份。
     *
     *   根因是两处各自缓存——设置里下载完只刷新了它自己那一份，按钮这边还是旧的。
     *   能力是会变的（刚下完模型、刚删了文件），而"点一下"正是最该拿最新事实的时刻。
     *   ⚠️ 查完之后**不再拿它当放行的唯一依据**：直接发请求，服务端会给真结论
     *   （201 或 400 + 人话）。
     */
    const fresh = await refreshVoiceCapability()
    if (fresh !== null && !fresh.available) {
      // ★ 285 批：原因走 **toast**（不占栏脚高度），按钮自己不显示文字
      showToast(fresh.reason)
      return
    }
    try {
      const res = await fetch('/api/voice/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ★ 286 批：只告诉 daemon "这是哪个对话"，让它自己去抽词（不传对话内容）
        body: JSON.stringify(conversationId === '' ? {} : { context: { conversationId } }),
      })
      const body = (await res.json()) as Snapshot & { error?: string }
      if (!res.ok) {
        showToast(body.error ?? $t('chat.voiceStartFailed'))
        // 这次失败可能正是"模型刚被删掉/刚下好"——把共享的那份也拉新
        void refreshVoiceCapability()
        return
      }
      sessionId = body.id
      phase = 'recording'
      elapsedMs = 0
      level = 0
      poll(body.id)
    } catch (err) {
      showToast($t('chat.voiceStartFailedDetail', { error: String(err) }))
    }
  }

  async function stop(): Promise<void> {
    if (sessionId === '') return
    phase = 'transcribing'
    try {
      await fetch(`/api/voice/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' })
    } catch {
      // 停不下来也别卡住界面：轮询会把它带向终态（或超时后由下面的兜底收掉）
    }
    poll(sessionId)
  }

  async function cancel(): Promise<void> {
    if (sessionId === '') return
    stopPolling()
    const id = sessionId
    sessionId = ''
    phase = 'idle'
    level = 0
    await fetch(`/api/voice/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(
      () => {},
    )
  }

  function onclick(): void {
    if (phase === 'recording') {
      void stop()
      return
    }
    if (phase === 'idle') void start()
  }

  function onkeydown(event: KeyboardEvent): void {
    // Esc 取消这一次（与"再点一下按钮结束"是两条路：Esc 是反悔，点了是结束）
    if (event.key !== 'Escape') return
    if (phase === 'recording') {
      event.preventDefault()
      void cancel()
    }
  }

  const title = $derived(
    !supported
      ? $t('chat.voiceUnsupported')
      : phase === 'recording'
        ? $t('chat.voiceStopTitle')
        : phase === 'transcribing'
          ? $t('chat.voiceTranscribingTitle')
          : $voiceCapability !== null && !$voiceCapability.available
            ? $voiceCapability.reason
            : $t('chat.voiceStartTitle'),
  )
</script>

<svelte:window onkeydown={onkeydown} />

{#if supported}
  <!--
    ★ 289 批：一个**竖着的小格子**——上面是麦克风按钮，下面是「取词 N」。
    为什么要竖着：`ChatComposer` 的动作组是 `align-items: stretch`，竖着放能让这一格
    与输入框**同高**（探针量的就是这一格的高度），不会凭空多出一行。
  -->
  <span class="voice-cell" data-voice-cell>
    <button
      type="button"
      class="ghost small voice"
      class:recording={phase === 'recording'}
      class:busy={phase === 'transcribing'}
      class:unavailable={$voiceCapability !== null && !$voiceCapability.available}
      data-voice-button
      data-voice-state={phase}
      {title}
      aria-label={$t('chat.voiceLabel')}
      aria-pressed={phase === 'recording'}
      disabled={phase === 'transcribing'}
      {onclick}
    >
      <!-- 录音中换成一块"电平"，让人看到它真的在收声音（不是只有一行字） -->
      {#if phase === 'recording'}
        <span class="dot" style:--level={level} data-voice-level={String(Math.round(level * 100))}
          >{$t('chat.voiceRecordingShort', { s: String(Math.round(elapsedMs / 1000)) })}</span
        >
      {:else if phase === 'transcribing'}
        <span class="dot" data-voice-transcribing>{$t('chat.voiceTranscribingShort')}</span>
      {:else}
        <span aria-hidden="true">🎙</span>
      {/if}
    </button>
    <!--
      ★ 289 批（使用者："预览改一个位置，可以放在录制按钮的下面，名字可能要改一下…
        它就可以预览当前对话的取词"）：名字叫**取词**，不是"预览"——
        它不是"预览某件将要发生的事"，而是"这一句识别会带上哪些词"。
    -->
    <button
      type="button"
      class="terms-label"
      data-voice-terms
      title={$t('chat.voiceTermsTitle')}
      aria-expanded={termsOpen}
      onclick={toggleTerms}
    >
      {terms === null
        ? $t('chat.voiceTermsLabel')
        : $t('chat.voiceTermsLabelN', { n: String(terms.terms.length) })}
    </button>
    {#if termsOpen}
      <span class="terms-pop" data-voice-terms-pop>
        {#if termsError !== ''}
          <span class="faint small">{termsError}</span>
        {:else if terms === null}
          <span class="faint small">{$t('chat.voiceTermsBusy')}</span>
        {:else if !terms.auto}
          <span class="faint small">{$t('chat.voiceTermsOff')}</span>
        {:else if terms.terms.length === 0}
          <span class="faint small">{$t('chat.voiceTermsNone')}</span>
        {:else}
          <span class="terms-list">
            {#each terms.terms as term (term)}
              <span class="terms-chip mono">{term}</span>
            {/each}
          </span>
          <span class="faint small"
            >{$t('chat.voiceTermsSource', {
              u: String(terms.userTurns),
              a: String(terms.agentReplies),
            })}</span
          >
        {/if}
        {#if conversationId === ''}
          <span class="faint small">{$t('chat.voiceTermsNoConv')}</span>
        {/if}
      </span>
    {/if}
  </span>
{/if}

<style>
  /**
   * 按钮本身只有一颗图标（与回形针同款尺寸），录音中才长出文字与电平。
   *
   * ⚠️ 「宽高」不在这里定：它由 `ChatComposer` 的 `.composer-actions > button { height: 100% }`
   *   接管——那一组是 `align-items: stretch`，所以语音按钮与「发送」永远**同高**。
   *   在这里写死一个高度，换字号就会差两像素（深色界面里非常显眼）。
   */
  /* 竖着的一格：按钮 + 下面那行「取词 N」（同高由输入框的行高决定，见上面注释） */
  .voice-cell {
    display: inline-flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    flex: 0 0 auto;
    /* 浮层要贴着这一格的上方弹出（没有它，`position: absolute` 会去找更远的祖先） */
    position: relative;
  }

  .voice-cell > .voice {
    flex: 1 1 auto;
  }

  /* 「取词 N」：比按钮矮得多的一行小字，点击展开词表 */
  .terms-label {
    border: 0;
    background: transparent;
    color: var(--text-faint);
    font: inherit;
    font-size: 0.625rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }

  .terms-label:hover {
    color: var(--accent);
  }

  /* 词表浮层：贴在按钮上方（不占栏脚高度） */
  .terms-pop {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 30;
    /**
     * ⚠️⚠️ **必须有 `width: max-content`**（290 批的教训）。
     *
     * 绝对定位元素的宽度是"收缩适应"：可用宽度 = **包含块宽度 − 偏移**，而这里的
     * 包含块是那个 `.voice-cell`（约 44px，只装得下一颗图标 + 「取词」两个字）。
     * 只写 `max-width: 24rem` 时，它照样按 44px 去折行 ⇒ **一个词都换行**，
     * 使用者一眼看到的就是"太窄、太丑"。
     * `max-content` 让宽度按内容算，再用 `max-width` 封顶，才不会被包含块压扁。
     */
    width: max-content;
    min-width: 14rem;
    max-width: min(24rem, 62vw);
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    text-align: left;
  }

  .terms-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .terms-chip {
    /* 一个词就是一行：词内部绝不换行（浮层窄是浮层的事，不该由词来承担） */
    white-space: nowrap;
    font-size: var(--fs-xs);
    padding: 0 var(--sp-2);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    color: var(--text-dim);
  }

  .voice {
    padding: 0 var(--sp-2);
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .voice.recording {
    color: var(--bad);
  }

  .voice.busy {
    color: var(--text-faint);
  }

  /* 录音中：一个小圆点按电平大小脉动——「它真的在收声音」这件事要看得见 */
  .dot {
    font-size: var(--fs-xs);
    color: var(--bad);
    position: relative;
  }

  .voice.recording .dot::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: calc(0.35 + var(--level, 0) * 0.65);
    vertical-align: -1px;
  }

  .voice.busy .dot {
    color: var(--text-faint);
  }

  /**
   * ★ 分批第 285 批（使用者："我也不想占高度，或许 Toast 的提示就可以了"）：
   *   **失败/不可用的原因改走 toast**（`.toast` 是 `position: fixed` 的浮层，一点
   *   栏脚高度都不占），按钮自己不显示任何文字。
   *
   *   删掉的是原来那条"原因塞在按钮右边"的做法，它的三个毛病：动作条被挤窄、
   *   24ch 截断后变成半句话、和按钮同高看着像个控件。
   *   ⚠️ 但"可用不可用"仍然要**一眼看得出**（不用点、不用悬停）——那是按钮自己的
   *   形状（虚线 + 灰），不是文字，所以不占高度。
   */
  .voice.unavailable {
    color: var(--text-faint);
    border-style: dashed;
  }
</style>
