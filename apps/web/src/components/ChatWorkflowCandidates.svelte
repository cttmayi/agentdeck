<script lang="ts">
  /**
   * **聊天里的「候选编排」卡片**（2026-11，D255）。
   *
   * 使用者定的流程：
   *   1. 编排生成者把候选**写成存储的形状**（工作目录 `workflow-draft/<名字>/`），
   *      每轮结束 daemon 预检一次；
   *   2. 聊天里出现这张卡片：**能不能收**、几个人、哪一条不对；
   *   3. 点「收进编排库」⇒ **直接保存**（无中间确认面板）⇒ 跳到编排编辑页；
   *      同名 ⇒ 先问「覆盖那条吗」（并写明覆盖会替换什么）。
   *
   * 为什么卡片而不是面板：产物是**工作目录里的真文件**，人要看的是"它写成了什么"；
   * 面板里再摆一份可改的文本，两份就会分叉（D245 把编辑器做成"直接改文件"是同一条理由）。
   * 要改 ⇒ 打开目录改，或让模型接着聊。
   */
  import { askConfirm } from '../lib/confirm.ts'
  import { t } from '../lib/i18n.ts'
  import { ApiError, api, type Workflow, type WorkflowCandidate } from '../lib/api.ts'
  import { showToast } from '../lib/view.ts'
  import { loadWorkflows } from '../lib/stores.ts'

  export let conversationId = ''
  export let candidates: WorkflowCandidate[] = []
  /** 收进库之后（页面负责跳转到编排编辑页并选中它）。 */
  export let onadopted: (workflow: Workflow) => void = () => {}

  /** 每条候选各自的进行态（键 = `dir`）。 */
  let busyDir = ''
  let errorByDir: Record<string, string> = {}

  const errorsOf = (c: WorkflowCandidate) => c.problems.filter((p) => p.level === 'error')
  const warnsOf = (c: WorkflowCandidate) => c.problems.filter((p) => p.level === 'warn')

  async function reveal(absDir: string): Promise<void> {
    try {
      await api('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path: absDir }) })
    } catch (err) {
      // 打不开文件夹不是"生成失败"，只提示一句（与智能体页的「打开目录」同一档）
      showToast($t('chat.wfOpenDirFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  async function adopt(c: WorkflowCandidate, overwrite?: { existingId: string }): Promise<void> {
    if (busyDir !== '') return
    busyDir = c.dir
    errorByDir = { ...errorByDir, [c.dir]: '' }
    try {
      const out = await api<{ workflow: Workflow }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/workflow-adopt`,
        {
          method: 'POST',
          body: JSON.stringify({
            dir: c.dir,
            ...(overwrite === undefined ? {} : { overwrite: true, existingId: overwrite.existingId }),
          }),
        },
      )
      // 写动作成功后界面跟着数据走：先重拉列表，再交给页面跳转
      await loadWorkflows()
      showToast($t('chat.wfAdopted', { name: out.workflow.name }))
      onadopted(out.workflow)
    } catch (err) {
      /*
       * 同名：**先问人**（用户拍板"如果有同名，要提示是否覆盖"）。
       * 服务端只回 `409 + { code, existing }`，不知道怎么问；这里读**结构化的错误体**
       * （`ApiError.body`）而不是去 parse 错误文案——文案是给人看的，会改。
       * 确认框里写明"覆盖会换掉什么"：代码与内建智能体整份替换，旧的会删掉。
       */
      const body =
        err instanceof ApiError && err.status === 409
          ? (err.body as { code?: unknown; existing?: { id?: unknown; name?: unknown } } | null)
          : null
      if (body?.code === 'workflow_name_taken' && typeof body.existing?.id === 'string') {
        const existingId = body.existing.id
        const ok = await askConfirm({
          title: $t('chat.wfOverwriteTitle', { name: c.name }),
          message: $t('chat.wfOverwriteBody', { name: c.name, n: String(c.agents.length) }),
          confirmLabel: $t('chat.wfOverwriteConfirm'),
          danger: true,
        })
        if (ok) {
          busyDir = ''
          await adopt(c, { existingId })
          return
        }
        return
      }
      errorByDir = {
        ...errorByDir,
        [c.dir]: err instanceof Error ? err.message : String(err),
      }
    } finally {
      busyDir = ''
    }
  }
</script>

{#if candidates.length > 0}
  <div class="wf-candidates" data-wf-candidates>
    {#each candidates as c (c.dir)}
      {@const errors = errorsOf(c)}
      {@const warns = warnsOf(c)}
      {@const blocked = errors.length > 0}
      <section class="wf-card" class:blocked data-wf-candidate={c.dir}>
        <header class="wf-card-head">
          <!-- ★ D190：截断走全局 `.ellipsis`（样式里不再写那三条） -->
          <span class="wf-card-title ellipsis" data-wf-candidate-name>
            {blocked
              ? $t('chat.wfBlockedTitle', { name: c.name })
              : $t('chat.wfReadyTitle', { name: c.name })}
          </span>
          <span class="spacer"></span>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            data-wf-open-dir
            onclick={() => void reveal(c.absDir)}
          >{$t('chat.wfOpenDir')}</button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            data-wf-adopt={c.dir}
            disabled={blocked || busyDir !== ''}
            title={blocked ? errors[0]?.message ?? '' : ''}
            onclick={() => void adopt(c)}
          >{busyDir === c.dir ? $t('common.saving') : $t('chat.wfAdopt')}</button>
        </header>
        <p class="wf-card-meta" data-wf-candidate-meta>
          {$t('chat.wfMeta', {
            n: String(c.agents.length),
            names: c.agents.map((a) => a.name).join('、'),
            lines: String(c.codeLines),
          })}
        </p>
        {#if c.summary !== ''}
          <p class="wf-card-summary faint fs-xs">{c.summary}</p>
        {/if}
        {#if errors.length > 0 || warns.length > 0}
          <ul class="wf-problems" data-wf-problems>
            {#each errors as p}
              <li class="wf-problem bad">✗ {p.message}</li>
            {/each}
            {#each warns as p}
              <li class="wf-problem faint">· {p.message}</li>
            {/each}
          </ul>
        {/if}
        {#if (errorByDir[c.dir] ?? '') !== ''}
          <p class="notice bad" data-wf-adopt-error>{errorByDir[c.dir]}</p>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  /* 卡片就挂在消息流末尾：与工具行同一档（不是 agent 气泡），所以左对齐、无气泡底 */
  .wf-candidates {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: var(--sp-3) 0;
  }

  .wf-card {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-width: 0;
  }

  .wf-card.blocked {
    border-color: var(--line-strong);
    background: var(--surface-2);
  }

  .wf-card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }

  .wf-card-head .spacer {
    flex: 1 1 auto;
  }

  .wf-card-title {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
    min-width: 0;
  }

  .wf-card-meta {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .wf-card-summary {
    margin: 0;
  }

  .wf-problems {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-xs);
  }

  .wf-problem.bad {
    color: var(--bad);
  }
</style>
