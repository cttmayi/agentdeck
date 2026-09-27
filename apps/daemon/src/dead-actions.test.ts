import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Agent, Tool, WorkspaceId } from '@agentdeck/protocol'
import { join } from 'node:path'
import { FileStore } from '@agentdeck/store-file'
import { planDeadActionCleanup } from './dead-actions.ts'
import { startDaemon } from './server.ts'
import { makeTempDir } from './testing/tmp.ts'
import { makeAgent, makeTool } from '@agentdeck/domain/testing'

/**
 * 清掉"永远不可能被满足"的动作名（D41 收尾）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条清理对应的真实卡点
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者在审核者的「行动权限」里改个名字点保存，被 400 拦住：
 *
 *   allowedActions 里有不认识的动作：issue.add_label。动作只能来自**已安装的
 *   工具包**…
 *
 * 那句报错本身是对的，但它把**平台自己造成的残留**（D41 删掉内置动作之后，
 * 老工作区里那串 `comment.create` / `issue.add_label` 成了死名字）变成了使用者
 * 的待办。留着它们不能让任何东西变可用，删掉也不会让谁失去能力——它们从来、
 * 也不可能被解析成动作。所以启动时清一次。
 *
 * ⚠️ 边界（不然这就是"平台偷偷改配置"）：只删**永远不可能成立**的；改了谁要
 *    说清（日志 + 通知）；"现在装着的包的正常动作"一个都不许动。
 */

const WS = 'ws-1' as WorkspaceId

const agent = (over: Omit<Partial<Agent>, 'id'> & { id: string }): Agent => makeAgent(over)

/**
 * 一个已安装的工具包夹具。
 *
 * ⚠️ `makeTool` 造出来的清单里，动作名默认是 `run`（`<slug>.run`）。这里显式
 *    把名字换掉，免得测试里写的名字与夹具生成的名字对不上——那种失败的报错
 *    会是"这条动作解析不出来"（一个看起来像被测代码坏了、其实是夹具坏了的坑）。
 */
const tool = (slug: string, actionName: string): Tool => {
  const base = makeTool({ id: slug, slug })
  return {
    ...base,
    manifest: {
      ...base.manifest,
      actions: base.manifest.actions.map((a) => ({ ...a, name: actionName })),
    },
  }
}

describe('D41 收尾：清掉已失效的动作名', () => {
  test('★ 死名字（老的内置动作名）会被清掉，正常动作一个不动', () => {
    const plan = planDeadActionCleanup(
      [
        agent({
          id: 'a1',
          name: '审核员',
          // 使用者的真实数据：动作写在老字段里（reviewStandard.allowedActions）
          reviewStandard: {
            body: '# 通用审核',
            allowedActions: ['comment.create', 'issue.add_label'],
          } as never,
        }),
      ],
      [tool('demo-tool', 'say')],
    )
    assert.equal(plan.changed.length, 1)
    assert.deepEqual(plan.changed[0]!.dropped.sort(), ['comment.create', 'issue.add_label'])
    assert.deepEqual(plan.changed[0]!.kept, [])

    // 而"装着的包的正常动作"必须原样留着——那才是这条清理的边界
    const keep = planDeadActionCleanup(
      [
        agent({
          id: 'a2',
          name: '有正常权限的审核者',
          allowedActions: ['demo-tool.say', 'comment.create'],
        }),
      ],
      [tool('demo-tool', 'say')],
    )
    assert.equal(keep.changed.length, 1)
    assert.deepEqual(keep.changed[0]!.dropped, ['comment.create'], '只删那一个死名字')
    assert.deepEqual(keep.changed[0]!.kept, ['demo-tool.say'], '正常的那个留下来')
  })

  test('没有问题可清时**什么都不做**（不是"扫一遍顺手重写所有 agent"）', () => {
    const plan = planDeadActionCleanup(
      [
        agent({ id: 'a1', name: '没配过动作的', reviewStandard: null }),
        agent({ id: 'a2', name: '配了正常动作的', allowedActions: ['demo-tool.say'] }),
      ],
      [tool('demo-tool', 'say')],
    )
    assert.deepEqual(plan.changed, [])
    assert.equal(plan.scanned, 2, '扫过两个，但一个都不改')
  })

  test('包被卸载之后，它那些动作也算"解析不出来" ⇒ 一并清掉', () => {
    // ⚠️ 这一条很要紧：它意味着"卸载一个包"之后重启一次，那些权限就没了。
    //    这是刻意的——那些动作**永远不可能再被满足**（除非把包装回来），
    //    留着它们同样只会让保存被 400 拦住。日志与通知会说清是哪一个包。
    const plan = planDeadActionCleanup(
      [agent({ id: 'a1', name: '审的', allowedActions: ['gone-tool.act'] })],
      [],
    )
    assert.deepEqual(plan.changed[0]!.dropped, ['gone-tool.act'])
  })

  test('执行者身上残留的动作名也一并清（写入口会拒它，老数据里可能有）', () => {
    const plan = planDeadActionCleanup(
      [
        agent({
          id: 'a1',
          name: '执行者',
          role: 'executor',
          allowedActions: ['comment.create'],
        }),
      ],
      [],
    )
    assert.deepEqual(plan.changed[0]!.dropped, ['comment.create'])
  })
})

/**
 * ★ 端到端：**启动时真的会清**（老数据 → 重启 → 干净 + 一条通知）。
 *
 * 这条测试复现的就是使用者的处境：他的库里有一条 D41 之前建的审核者，
 * 动作名单里存着 `comment.create` / `issue.add_label`，于是他打开界面一保存
 * 就被 400 拦住。清理发生在**启动时**，所以这里必须真的重启一次 daemon。
 *
 * ⚠️ 那条老数据只能**绕过 API** 造出来：写入口本来就该拒这些名字（D41 的判据），
 *    这正是"平台自己写进去的残留"的定义。
 */
describe('D41 收尾：重启之后老数据真的被清干净', () => {
  test('★ 老审核者的死名字被清掉、写了通知、并在日志里说清删了哪几个', async () => {
    const dir = await makeTempDir('dead-actions-e2e')

    // ① 先正常起一次，让首启把工作区与播种 agent 建出来
    const first = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      workRoot: join(dir, 'work'),
      onWarn: () => {},
      onInfo: () => {},
    })
    const bootstrapAgents = ((await (
      await fetch(`${first.url}/api/agents`)
    ).json()) as { agents: Array<{ id: string; name: string; role: string }> }).agents
    const reviewer = bootstrapAgents.find((a) => a.role === 'reviewer')
    assert.ok(reviewer, '首启应当播种一个审核者')
    await first.close()

    // ② 绕过 API 把它改回"老数据的形态"：动作写在 `reviewStandard` 里，
    //    而且写的是**当年那六个内置动作名**——D41 之后它们永远解析不出来
    const store = await FileStore.open({ dataDir: dir, fsync: false })
    const agent = await store.getAgent(reviewer.id as never)
    assert.ok(agent)
    await store.insertAgent({
      ...agent,
      allowedActions: [],
      reviewStandard: {
        // ⚠️ 这里故意**照当年那样**带上 `name`：这个夹具造的是老记录，
        //    而老记录里那个键还在（字段删掉之后读取方一律忽略）。
        body: agent.reviewStandard?.body ?? '# 通用审核',
        allowedActions: ['comment.create', 'issue.add_label'],
      } as never,
    })
    const ws = (await store.listWorkspaceIds())[0]!
    const before = await store.listAgents(ws)
    assert.deepEqual(
      before.find((a) => a.id === reviewer.id)?.reviewStandard?.allowedActions,
      ['comment.create', 'issue.add_label'],
      '夹具就位：库里确实存着两个死名字',
    )

    // ⚠️ 必须把直接打开的那个 store 关掉再起 daemon：文件适配器在数据目录上
    //    持有**进程锁**，不关的话第二个 daemon 会以 `LockHeldError` 拒绝启动
    //    （第一次跑就是卡在这条上，而报错看起来像"数据目录被占用"）。
    await store.close()

    // ③ 再起一次（＝使用者重启 daemon）
    const logs: string[] = []
    const second = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      workRoot: join(dir, 'work'),
      onWarn: () => {},
      onInfo: (m) => logs.push(m),
    })
    try {
      const after = ((await (await fetch(`${second.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; allowedActions?: string[]; reviewStandard: unknown }>
      }).agents.find((a) => a.id === reviewer.id)!
      assert.deepEqual(after.allowedActions, [], '死名字清掉了')
      const std = after.reviewStandard as { allowedActions?: string[] } | null
      assert.equal(
        std?.allowedActions,
        undefined,
        '★ 老字段里的死名字也清掉了——只清新字段的话，保存时它照样会挡路',
      )

      assert.ok(
        logs.some((m) => m.includes('已失效的动作名') && m.includes('comment.create')),
        '要**说清删了哪几个**（不是静默改配置）',
      )

      const inbox = ((await (await fetch(`${second.url}/api/inbox`)).json()) as {
        items: Array<{ type: string; body: string }>
      }).items
      const notice = inbox.find((i) => i.type === 'action.invalid_cleaned')
      assert.ok(notice, '还要落一条通知：使用者下次打开界面时知道"为什么权限变干净了"')
      assert.match(notice.body, /comment\.create/)
      assert.match(notice.body, /工具/, '并指出下一步：要让它能做什么，去装对应的包')
    } finally {
      await second.close()
    }
  })
})
