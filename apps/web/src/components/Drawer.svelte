<script lang="ts">
  import { t } from '../lib/i18n.ts'

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
   * ⚠️ 但 736px 对"写一份 800 字的指令"仍然不够宽（正文只剩 ~688px，一行
   *    ~52 个中文字 ⇒ 要滚 16 行），所以又有了 `wider` = 58rem = 928px。
   *    宽度按内容选，见 `size` 那个 prop。
   *
   * ⚠️ Esc 放在**这个组件里**（而不是让每个调用方各写一遍）：两个抽屉都该
   *   有它，而"漏了一个"是最容易发生的事。遮罩点击、关闭按钮同理。
   */
  export let open = false
  export let title = ''
  /** 头部的第二行说明——用来一句话讲清"这个抽屉里的东西作用范围多大"。 */
  export let subtitle = ''
  /**
   * 宽度，按**内容**选（`app.css` 里有这三个宽度的出处）：
   *
   *   - `default` 34rem：读一段设置（表单、开关）；
   *   - `wide` 46rem：看表格（「安装 skill」里那张远端目录表）；
   *   - `wider` 58rem：写长文本（新建智能体那份指令，800 字要能一眼看完）。
   *
   * ⚠️ 原来这里是两个独立的布尔（`wide` / `wider`），而它们是**互斥的宽度**——
   *    两个都传时哪一个赢取决于 CSS 里的书写顺序，那是一种没人会去读的隐式规则。
   *    换成一个枚举之后，"只能选一个"是类型系统保证的。
   */
  export let size: 'default' | 'wide' | 'wider' = 'default'
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
    class:wide={size === 'wide'}
    class:wider={size === 'wider'}
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel || title}
  >
    <div class="drawer-head">
      <div>
        <h2>{title}</h2>
        {#if subtitle}<p class="hint">{subtitle}</p>{/if}
      </div>
      <!-- ★ 用通用的 `common.close`：抽屉的关闭按钮与别处的"关闭"是同一句话，
           没有第二个出处（原来这里单留了 `drawer.close`，同形同义 ⇒ 改一处漏一处）。 -->
      <button type="button" class="ghost" onclick={onclose}>{$t('common.close')}</button>
    </div>

    <div class="drawer-body">
      <slot />
    </div>

    <div class="drawer-foot">
      <slot name="foot" />
    </div>
  </div>
{/if}
