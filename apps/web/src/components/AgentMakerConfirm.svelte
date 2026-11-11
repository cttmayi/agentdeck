<script lang="ts">
  /**
   * 「确认生成智能体」面板（2026-11 设计定稿 §3.5–§3.6）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它怎么工作
   * ══════════════════════════════════════════════════════════════════
   *
   *   ① 打开 ⇒ `GET /api/conversations/{id}/agent-draft`：把岗位卡（agent-draft.md）
   *      与配套技能草稿（skill/<slug>/SKILL.md）读出来；
   *   ② 岗位卡拆成 岗位名 + 角色 + 指令（正文）三段，**人可改**——确认前要能改；
   *   ③ 配套技能逐条摆出来（slug / name / description / SKILL.md 正文），可改可删；
   *      黄条提示"未经验证"（提示不是校验）；
   *   ④ 点「确认生成」⇒ `POST /api/conversations/{id}/agent-commit`：配套技能
   *      作为**新智能体的独有技能**（`agents/<id>/SKILL/`，不进共享技能池）——
   *      2026-11 使用者拍板："生成的 SKILL 应该作为智能体的内置技能"。
   *
   * ★ 只有人能确认这条铁律没有变：生成者只**起草**，真正落库是人在这一步按的那一下。
   * ⚠️ 岗位卡的 frontmatter 拆分只在界面做展示用，提交时拼回一整段给服务端重解析
   *    （服务端不信任客户端分开传来的三个字段——见那条路由的注释）。
   */
  import { Modal } from '@agentdeck/ui/components'
  import { api } from '../lib/api.ts'
  import { t } from '../lib/i18n.ts'
  import { showToast } from '../lib/view.ts'
  import { loadAgents } from '../lib/stores.ts'

  export let open = false
  export let conversationId = ''

  interface DraftSkill {
    slug: string
    name: string
    description: string
    body: string
    /** 界面上的 key（列表有增删，用下标当 key 会串）。 */
    key: number
    removed: boolean
  }

  /** 岗位卡拆分出来的人可编辑状态（frontmatter 的 name/role + 正文指令）。 */
  let name = ''
  let role = 'executor'
  let instructions = ''
  let skills: DraftSkill[] = []
  let loading = false
  let error = ''
  let done = false
  let committing = false
  let keySeq = 0

  /** 打开时拉一次生成产物。失败要给人看（读不到 = 按钮不该出现却出现了）。 */
  $: if (open && conversationId !== '') {
    void load()
  }

  async function load(): Promise<void> {
    loading = true
    error = ''
    done = false
    try {
      const body = await api<{
        agentDraft: string | null
        skills: Array<{ slug: string; name: string; description: string; body: string }>
      }>(`/api/conversations/${encodeURIComponent(conversationId)}/agent-draft`)
      const text = body.agentDraft ?? ''
      const parts = splitFrontmatter(text)
      name = parts.name
      role = parts.role
      instructions = parts.body
      skills = (body.skills ?? []).map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        body: s.body,
        key: keySeq++,
        removed: false,
      }))
      if (text.trim() === '') {
        error = $t('chat.agentMakerFail', { error: '岗位卡不存在' })
      }
    } catch (err) {
      error = $t('chat.agentMakerFail', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      loading = false
    }
  }

  /** frontmatter 拆分：`---` 头块里的 name / role + 正文（与服务端 parseAgentDraft 同款规则）。 */
  function splitFrontmatter(text: string): { name: string; role: string; body: string } {
    const trimmed = text.replace(/^\uFEFF/, '').trimStart()
    if (!trimmed.startsWith('---')) return { name: '', role: 'executor', body: trimmed }
    const end = trimmed.indexOf('\n---', 3)
    if (end < 0) return { name: '', role: 'executor', body: trimmed }
    const head = trimmed.slice(3, end)
    let name = ''
    let role = 'executor'
    for (const line of head.split('\n')) {
      const mName = line.match(/^name\s*:\s*(.+)$/)
      if (mName?.[1]) name = stripQuotes(mName[1].trim())
      const mRole = line.match(/^role\s*:\s*(.+)$/)
      if (mRole?.[1]) role = stripQuotes(mRole[1].trim())
    }
    return { name, role, body: trimmed.slice(end + 4).trim() }
  }

  function stripQuotes(v: string): string {
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      return v.slice(1, -1)
    }
    return v
  }

  function confirm(): void {
    void (async () => {
      committing = true
      error = ''
      const agentDraft = `---\nname: ${name}\nrole: ${role}\n---\n${instructions}`
      try {
        const out = await api<{ agent: { name: string }; exclusiveSlugs: string[] }>(
          `/api/conversations/${encodeURIComponent(conversationId)}/agent-commit`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentDraft,
              skills: skills.filter((s) => !s.removed).map((s) => ({ slug: s.slug, body: s.body })),
            }),
          },
        )
        done = true
        // ★ 2026-11（使用者："生成的智能体默认在智能体页面看不到，需要重新刷新"）：
        //   生成是写动作——成功后**立刻重拉智能体列表**，让界面跟着数据走，
        //   不用等使用者刷新。同类问题已多次（§8.6 纪律）。
        await loadAgents()
        showToast(
          $t('chat.agentMakerDone', {
            name: out.agent.name,
            n: String(out.exclusiveSlugs.length),
          }),
        )
      } catch (err) {
        error = $t('chat.agentMakerFail', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        committing = false
      }
    })()
  }
</script>

<Modal
  {open}
  title={$t('chat.agentMakerPanelTitle')}
  size="wide"
  closeLabel={$t('common.close')}
  onclose={() => (open = false)}
>
  {#if loading}
    <p class="hint">{$t('chat.agentMakerLoading')}</p>
  {:else}
    <p class="hint draft-note">{$t('chat.agentMakerDraftNote')}</p>

    <div class="form-block">
      <label class="form-field">
        <span>{$t('chat.agentMakerNameLabel')}</span>
        <input type="text" bind:value={name} maxlength="100" />
      </label>
      <label class="form-field">
        <span>{$t('chat.agentMakerRoleLabel')}</span>
        <select bind:value={role}>
          <option value="executor">{$t('agents.roleExecutor')}</option>
          <option value="reviewer">{$t('agents.roleReviewer')}</option>
        </select>
      </label>
      <label class="form-field">
        <span>{$t('chat.agentMakerInstructionsLabel')}</span>
        <textarea rows="12" bind:value={instructions}></textarea>
        <span class="hint">{$t('chat.agentMakerBoundaryHint')}</span>
      </label>
    </div>

    <fieldset class="form-field">
      <legend>{$t('chat.agentMakerSkillsLabel')}</legend>
      <p class="warn-note">{$t('chat.agentMakerSkillsWarn')}</p>
      {#each skills.filter((s) => !s.removed) as skill (skill.key)}
        <div class="skill-card">
          <div class="skill-head">
            <strong>{skill.slug}</strong>
            <span class="hint">{skill.name}{skill.description ? ` · ${skill.description}` : ''}</span>
            <button class="btn btn--ghost btn--sm" onclick={() => (skill.removed = true)}>
              {$t('chat.agentMakerRemoveSkill')}
            </button>
          </div>
          <textarea
            rows="8"
            bind:value={skill.body}
            placeholder={$t('chat.agentMakerSkillBodyPlaceholder')}
          ></textarea>
        </div>
      {/each}
      {#if skills.every((s) => s.removed)}
        <p class="hint">0 条配套技能——只建智能体。</p>
      {/if}
    </fieldset>

    {#if error}
      <p class="notice warn">{error}</p>
    {/if}
    <div class="confirm-row">
      {#if done}
        <p class="notice good">{$t('chat.agentMakerDone', { name, n: String(skills.filter((s) => !s.removed).length) })}</p>
      {:else}
        <button class="btn btn--primary" disabled={committing} onclick={confirm}>
          {$t('chat.agentMakerConfirm')}
        </button>
        <span class="hint">{$t('chat.agentMakerConfirmHint')}</span>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .draft-note {
    color: var(--good, #4ec9a0);
    margin-bottom: 0.75rem;
  }
  .form-field {
    margin-bottom: 1rem;
    border: 0;
    padding: 0;
    margin-inline: 0;
    min-inline-size: 0;
  }
  .form-field > span:first-child,
  .form-field > legend {
    display: block;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .field input,
  .field select,
  .field textarea {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
  }
  .skill-card {
    border: 1px solid var(--line-strong, #333a49);
    border-radius: var(--radius);
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .skill-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .skill-head .hint {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .warn-note {
    font-size: var(--fs-sm);
    color: var(--warn, #e0b04a);
    border: 1px solid var(--warn, #e0b04a);
    border-radius: var(--radius);
    padding: 0.5rem 0.625rem;
    margin-bottom: 0.75rem;
  }
  .confirm-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }
</style>
