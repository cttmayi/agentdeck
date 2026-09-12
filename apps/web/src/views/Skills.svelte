<script lang="ts">
  import { loadSkills, loading, loadError, skills } from '../lib/stores.ts'

  /**
   * Skills。
   *
   * 每一项要显示**它允许触发哪些动作**——那是 skill 里最要紧的一条约束，
   * 也是"这个 skill 到底能改什么"的唯一答案。只列名字等于没说。
   */
  let expanded: string | null = null
</script>

<div class="view-head">
  <div>
    <h2>Skills</h2>
    <p>
      skill 携带三要素：<strong>审核标准</strong> + <strong>判决结构引用</strong> +
      <strong>允许执行的动作子集</strong>。动作子集是白名单——不在里面的动作会让整条判决
      判为不合规，而不是"忽略这个动作继续"。
    </p>
  </div>
  <button type="button" class="secondary" onclick={loadSkills}>刷新</button>
</div>

{#if $loading['skills'] && $skills.length === 0}
  <div class="skeleton" style="margin-bottom:var(--sp-2)"></div>
  <div class="skeleton" style="width:55%"></div>
{:else if $loadError['skills']}
  <div class="notice bad">{$loadError['skills']}</div>
{:else if $skills.length === 0}
  <div class="empty"><strong>还没有 skill</strong>daemon 首次启动会播种一个内置审核模板。</div>
{:else}
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>slug</th><th>名称</th><th>来源</th><th>允许的动作</th><th>更新于</th><th></th></tr>
      </thead>
      <tbody>
        {#each $skills as s (s.id)}
          <tr>
            <td><code>{s.slug}</code></td>
            <td>{s.name}</td>
            <td>
              <span class="badge {s.source === 'local' ? 'todo' : 'in_review'}">
                {s.source === 'local' ? '本机自建' : '远端下载'}
              </span>
            </td>
            <td>
              {#each s.allowedActions as a}<code style="margin-right:4px">{a}</code>{/each}
            </td>
            <td class="faint small">{new Date(s.updatedAt).toLocaleString()}</td>
            <td>
              <button
                type="button"
                class="ghost small"
                onclick={() => (expanded = expanded === s.id ? null : s.id)}
              >
                {expanded === s.id ? '收起标准' : '看标准'}
              </button>
            </td>
          </tr>
          {#if expanded === s.id}
            <tr>
              <td colspan="6">
                <pre class="skill-body">{s.body}</pre>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .skill-body {
    margin: 0;
    padding: var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    white-space: pre-wrap;
    font-size: var(--fs-xs);
    line-height: 1.6;
    max-height: 24rem;
    overflow-y: auto;
  }
</style>
