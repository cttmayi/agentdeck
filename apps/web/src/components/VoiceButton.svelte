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
  import { refreshVoiceCapability, voiceCapability } from '../lib/voice.ts'

  let {
    /** 识别出的文本（**替换过专有名词的**那份）。 */
    ontext,
    /** 录音过程中给调用方的状态（界面可据此禁用输入框之类；现在聊天页用不到）。 */
    onstate,
  }: {
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
    error?: string
  }

  let phase = $state<VoiceState>('idle')
  let detail = $state<Snapshot | null>(null)
  let reason = $state('')
  let sessionId = $state('')
  let elapsedMs = $state(0)
  let level = $state(0)
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
        } else if (snap.state === 'failed') {
          reason = snap.error ?? $t('chat.voiceFailedNoReason')
          // 失败原因留在按钮的 title 上，同时行内显示一次（人不必去悬停才发现）
          setTimeout(() => {
            if (phase === 'idle' && detail?.state === 'failed') reason = ''
          }, 8000)
        }
      } catch {
        stopPolling()
        sessionId = ''
        phase = 'idle'
        reason = $t('chat.voiceLost')
      }
    })(), 200)
  }

  async function start(): Promise<void> {
    reason = ''
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
      reason = fresh.reason
      return
    }
    try {
      const res = await fetch('/api/voice/sessions', { method: 'POST' })
      const body = (await res.json()) as Snapshot & { error?: string }
      if (!res.ok) {
        reason = body.error ?? $t('chat.voiceStartFailed')
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
      reason = $t('chat.voiceStartFailedDetail', { error: String(err) })
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
  <button
    type="button"
    class="ghost small voice"
    class:recording={phase === 'recording'}
    class:busy={phase === 'transcribing'}
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
  {#if reason !== ''}
    <span class="voice-reason" data-voice-reason>{reason}</span>
  {/if}
{/if}

<style>
  /**
   * 按钮本身只有一颗图标（与回形针同款尺寸），录音中才长出文字与电平。
   *
   * ⚠️ 「宽高」不在这里定：它由 `ChatComposer` 的 `.composer-actions > button { height: 100% }`
   *   接管——那一组是 `align-items: stretch`，所以语音按钮与「发送」永远**同高**。
   *   在这里写死一个高度，换字号就会差两像素（深色界面里非常显眼）。
   */
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

  /* 原因那一句：紧贴在按钮旁边（不占输入框的位置，也不弹窗） */
  .voice-reason {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
