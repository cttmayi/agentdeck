<script lang="ts">
  import { t } from '../lib/i18n.ts'

  /**
   * 居中对话框：**从一大堆东西里挑**用的浮层。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么又有一个浮层组件，而不是复用右边的抽屉
   * ══════════════════════════════════════════════════════════════════
   *
   * 这一页已经有 `Drawer.svelte`（右侧抽屉），它服务的是"读/写一段配置"：
   * 新建智能体那份指令、安装 skill、工作区设置。三档宽度也都是按那个用途定的
   * （34rem 读设置 / 46rem 看表格 / 58rem 写长文），而且它自己的注释里写着
   * 「再往上加之前先问一句"这一档是给哪种内容用的"——抽屉再宽就该是整页了」。
   *
   * 这次要装的是**两栏挑选器**（左栏挑、右栏配），它要的是**宽而居中**：
   *   · 宽：两栏并排，左栏是清单、右栏是参数表单，各要 ~480px；
   *   · 居中：它是"停下来挑一个东西"，挑完回到原处——右侧抽屉会把页面右半边
   *     整个盖住，而这一页（新建任务）的表单还在后面等着填。
   *
   * 所以两者的区别不是"位置不同"，是**用途不同**：
   *   抽屉 = 读写一段配置（可以很长，从右边推进来，不动主从布局）；
   *   对话框 = 从一堆东西里挑（要宽、要居中、挑完就关）。
   *
   * ⚠️ 遮罩、Esc、关闭按钮这三件事**在这个组件里做一次**（与 `Drawer.svelte`
   *    同一个理由）：漏掉哪一个都是最容易发生的事，而"点背景关不掉"这种毛病
   *    在浮层里是最难受的。遮罩类名沿用 `.drawer-backdrop`——它是**同一件事**
   *    （半透明遮罩 + 点它关掉），换一个名字只会让两处各演化一次。
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
      <button type="button" class="ghost" onclick={onclose}>{$t('common.close')}</button>
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
