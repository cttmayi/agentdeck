<script lang="ts">
  /**
   * 居中对话框：**从一大堆东西里挑**用的浮层（2026-11 抽进 `@agentdeck/ui`，
   * daemon 界面与远端管理页共用）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么又有一个浮层组件，而不是复用右侧的抽屉
   * ══════════════════════════════════════════════════════════════════
   *
   * 抽屉服务的是"读/写一段配置"：新建智能体那份指令、安装 skill、工作区设置。
   * 三档宽度也都是按那个用途定的（34rem 读设置 / 46rem 看表格 / 58rem 写长文）。
   *
   * 这次要装的是**两栏挑选器**（左栏挑、右栏配），它要的是**宽而居中**：
   *   · 宽：两栏并排，左栏是清单、右栏是参数表单，各要 ~480px；
   *   · 居中：它是"停下来挑一个东西"，挑完回到原处——右侧抽屉会把页面右半边
   *     整个盖住。
   *
   * 所以两者的区别不是"位置不同"，是**用途不同**：
   *   抽屉 = 读写一段配置（可以很长，从右边推进来，不动主从布局）；
   *   对话框 = 从一堆东西里挑（要宽、要居中、挑完就关）。
   *
   * ⚠️ 遮罩、Esc、关闭按钮这三件事**在这个组件里做一次**：漏掉哪一个都是最
   *    容易发生的事。遮罩类名沿用 `.drawer-backdrop`——它是**同一件事**（半透明
   *    遮罩 + 点它关掉），换一个名字只会让两处各演化一次。
   *
   * ⚠️ 关闭按钮的文案是各端自己的（webText / remoteText 有意分开），所以
   *    `closeLabel` 由挂载端传入——组件本身不依赖任何文案表。
   */
  export let open = false
  export let title = ''
  /** 头部的第二行说明——一句话讲清"这里挑的东西作用范围多大"。 */
  export let subtitle = ''
  /**
   * 宽度，按内容选（`app.css` 里有这两档的出处）：
   *   · `default` 42rem：装一栏内容（表格、清单）；
   *   · `wide` 74rem：装**两栏**（左挑右配，比如行动权限）。
   */
  export let size: 'default' | 'wide' = 'default'
  export let ariaLabel = ''
  export let closeLabel = ''
  export let onclose: () => void = () => {}

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) onclose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="drawer-backdrop" onclick={onclose} role="presentation"></div>

  <div
    class="modal"
    class:wide={size === 'wide'}
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel || title}
  >
    <div class="modal-head">
      <div>
        <h2>{title}</h2>
        {#if subtitle}<p class="hint">{subtitle}</p>{/if}
      </div>
      <button type="button" class="ghost" onclick={onclose}>{closeLabel}</button>
    </div>

    <!-- ★ 正文**自己滚**（头与脚固定）：两栏挑选器可以很高，头部的标题和底部的
         「完成」按钮跟着滚走的话，使用者滚到一半就不知道自己在哪、也不知道怎么
         收尾了。`min-height: 0` 在 CSS 里——flex 子项默认不肯缩到内容以下。 -->
    <div class="modal-body">
      <slot />
    </div>

    <div class="modal-foot">
      <slot name="foot" />
    </div>
  </div>
{/if}
