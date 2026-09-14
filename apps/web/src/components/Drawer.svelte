<script lang="ts">
  /**
   * 右侧抽屉（这一页里"新建"与"设置"共用）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么这两件事都得是抽屉，而不是正文里展开的一块
   * ══════════════════════════════════════════════════════════════════
   *
   * 智能体页是**主从布局**：左栏 26rem（416px）放清单、右栏放详情。
   * 「新建」与「设置」两个面板都被塞进过左栏：
   *
   *   - 新建表单按自己的 `max-width: 46rem` 画成 **736px**，横着盖住右栏，
   *     栏头从 167px 涨到 1070px，清单被顶出视口；
   *   - 改成"放进左栏正文"之后不再溢出，但**太窄**：一个模版编辑器（加上变量
   *     清单与预览）挤在 358px 里，模版这种要读要改的长文本没法用。
   *
   * 抽屉解决的是同一件事的两面：**浮在上面**（不动主从布局）而且**够宽**
   * （46rem = 736px，与「安装 skill」同一个宽度）。关掉就回到原地，清单
   * 一直在。
   *
   * ⚠️ Esc 放在**这个组件里**（而不是让每个调用方各写一遍）：两个抽屉都该
   *   有它，而"漏了一个"是最容易发生的事。遮罩点击、关闭按钮同理。
   */
  export let open = false
  export let title = ''
  /** 头部的第二行说明——用来一句话讲清"这个抽屉里的东西作用范围多大"。 */
  export let subtitle = ''
  /** 内容宽的（设置里那张变量清单、模版预览）用 `wide`；纯表单用默认宽度。 */
  export let wide = false
  /** 无障碍标签：与 title 不同时（比如头部的标题是动态的）可以单独给。 */
  export let ariaLabel = ''
  export let onclose: () => void = () => {}

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) onclose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- 点背景关掉：抽屉遮住内容时，"我怎么回去"必须有答案 -->
  <div class="drawer-backdrop" onclick={onclose} role="presentation"></div>

  <div
    class="drawer"
    class:wide
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel || title}
  >
    <div class="drawer-head">
      <div>
        <h2>{title}</h2>
        {#if subtitle}<p class="hint">{subtitle}</p>{/if}
      </div>
      <button type="button" class="ghost" onclick={onclose}>关闭</button>
    </div>

    <div class="drawer-body">
      <slot />
    </div>

    <div class="drawer-foot">
      <slot name="foot" />
    </div>
  </div>
{/if}
