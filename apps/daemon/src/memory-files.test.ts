/**
 * 记忆的**磁盘镜像**（分批第 241 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一层要守住的两件事
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **镜像说清自己不是权威**：文件头必须写着"改它不会生效"。一个看起来能改、
 *    改了却没用的文件，比没有这个文件更糟（本仓库的老毛病）。
 * ② **镜像的顺序 = 注入的顺序**：人打开文件看到的第一条，就是预算不够时
 *    最后才会被裁掉的那条。两处顺序一旦分叉，人照着文件猜 agent 会怎么用就猜错。
 *
 * 与 skill-mine 同一套 NFR-T-01 口径：**不依赖跑测机器上真的装着 git**——
 * 注入一把假 `git`（Node 脚本 + `executableWrapper`），真/假两条路都判。
 */

import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { AgentId, MemoryEntry, MemoryEntryId, WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { executableWrapper } from '@agentdeck/agent-core'
import { memoryFilePath, memoryRootFor, renderMemoryMirror, syncMemoryMirror } from './memory-files.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

const WS = 'ws-1' as WorkspaceId
const AGENT = 'agent-1' as AgentId

let dir: string
let fakeGit: string

/**
 * 造一把"好 git"：所有操作成功，第一次 commit 成功、之后 nothing to commit。
 * 与 `run-hooks/skill-mine.test.ts` 里的同形（那边覆盖 git 参数与输出解析的细节，
 * 这里只需要"可用 + 提交成功"这一态）。
 */
async function writeFakeGit(): Promise<string> {
  const script = join(dir, 'fake-git.mjs')
  await writeFile(
    script,
    `import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
const cmd = process.argv[2] ?? ''
const say = (t) => process.stdout.write(t + '\\n')
const fail = (t, code) => { process.stderr.write(t + '\\n'); process.exit(code) }
switch (cmd) {
  case '--version': say('git version 2.99.0-fake'); break
  case 'init': mkdirSync('.git', { recursive: true }); say('Initialized empty'); break
  case 'config': break
  case 'add': break
  case 'commit':
    if (existsSync('.committed')) { say('nothing to commit, working tree clean'); process.exit(1) }
    writeFileSync('.committed', ''); say('f123abc'); break
  default: fail('unknown git subcommand', 1)
}
`,
    'utf8',
  )
  const wrapper = executableWrapper({
    name: 'fake-git',
    nodePath: process.execPath,
    scriptPath: script,
  })
  const git = join(dir, wrapper.name)
  await writeFile(git, wrapper.content, 'utf8')
  if (wrapper.needsChmod) await chmod(git, 0o755)
  return git
}

before(async () => {
  dir = await makeTempDir('memory-files')
  fakeGit = await writeFakeGit()
})

after(async () => {
  await cleanup(dir)
})

function entry(over: { id: string } & Partial<Omit<MemoryEntry, 'id'>>): MemoryEntry {
  const { id, ...rest } = over
  return {
    workspaceId: WS,
    agentId: AGENT,
    kind: 'fact',
    text: 'x',
    evidence: null,
    pinned: false,
    useCount: 0,
    lastUsedAt: null,
    createdAt: 1,
    removedAt: null,
    ...rest,
    id: id as MemoryEntryId,
  } as MemoryEntry
}

/** 只实现记忆这一块的假 store（真 store 的行为由 file-store / sqlite 的测试钉着）。 */
function fakeStore(rows: MemoryEntry[]): Store {
  return {
    async listMemoryEntries(_ws: WorkspaceId, agentId?: AgentId) {
      return agentId === undefined ? [...rows] : rows.filter((r) => r.agentId === agentId)
    },
  } as unknown as Store
}

describe('镜像内容：按类型分组、标出置顶与用量', () => {
  test('★ 文件头说清"这是镜像，改它不会生效"', () => {
    const text = renderMemoryMirror({
      agentName: '小七',
      agentId: AGENT,
      entries: [entry({ id: 'm1', text: '这仓库用 pnpm' })],
    })
    assert.match(text, /^# 记忆：小七/)
    assert.match(text, /改这个文件\*\*不会生效\*\*/)
    assert.match(text, /这仓库用 pnpm/)
  })

  test('★ 按类型分组：每类一个小标题，空类型不出现', () => {
    const text = renderMemoryMirror({
      agentName: 'a',
      agentId: AGENT,
      entries: [
        entry({ id: 'm1', kind: 'commitment', text: '答应周五交' }),
        entry({ id: 'm2', kind: 'lesson', text: '别直接改 dist' }),
      ],
    })
    assert.match(text, /## 约定/)
    assert.match(text, /## 教训/)
    assert.doesNotMatch(text, /## 偏好/, '没有偏好条目 ⇒ 不出空小节')
    assert.equal(text.indexOf('## 约定') < text.indexOf('## 教训'), true, '分组顺序固定')
  })

  test('★★ 置顶打 ★、用量与出处都落下来（人翻文件就能看出它记不记得住）', () => {
    const text = renderMemoryMirror({
      agentName: 'a',
      agentId: AGENT,
      entries: [
        entry({ id: 'm1', text: '别用 --force', pinned: true, useCount: 3, evidence: 'run-9' }),
        entry({ id: 'm2', text: '还没用过的' }),
      ],
    })
    assert.match(text, /- 别用 --force ★/)
    assert.match(text, /用过 3 次/)
    assert.match(text, /出处 run run-9/)
    assert.match(text, /还没用过/, '没用过要明说，不是留空')
  })

  test('★ 空记忆 ⇒ 一句"（还没有记忆）"，而不是空文件', () => {
    const text = renderMemoryMirror({ agentName: 'a', agentId: AGENT, entries: [] })
    assert.match(text, /（还没有记忆）/)
    assert.match(text, /共 0 条/)
  })
})

describe('落盘：路径按 agentId 分目录', () => {
  test('★ 镜像写到 <root>/<agentId>/MEMORY.md，且已删除的条目不进去', async () => {
    const root = join(dir, 'mirror-a')
    const store = fakeStore([
      entry({ id: 'm1', text: '留着的' }),
      entry({ id: 'm2', text: '删掉的', removedAt: 500 }),
    ])
    const result = await syncMemoryMirror({
      store,
      workspaceId: WS,
      agentId: AGENT,
      agentName: '小七',
      root,
      gitPath: fakeGit,
    })
    assert.equal(result.path, memoryFilePath(root, AGENT))
    const text = await readFile(result.path, 'utf8')
    assert.match(text, /留着的/)
    assert.doesNotMatch(text, /删掉的/, '删掉的（打了时间戳）不再进镜像')
    assert.match(text, /共 1 条/)
  })

  test('★ 改名不搬家：路径只跟 agentId 走，名字只出现在标题里', async () => {
    const root = join(dir, 'mirror-rename')
    const store = fakeStore([entry({ id: 'm1', text: 'x' })])
    const first = await syncMemoryMirror({
      store,
      workspaceId: WS,
      agentId: AGENT,
      agentName: '旧名字',
      root,
      gitPath: fakeGit,
    })
    const second = await syncMemoryMirror({
      store,
      workspaceId: WS,
      agentId: AGENT,
      agentName: '新名字',
      root,
      gitPath: fakeGit,
    })
    assert.equal(first.path, second.path, '改名后还是同一个文件')
    const text = await readFile(second.path, 'utf8')
    assert.match(text, /# 记忆：新名字/)
  })

  test('★★ 同一个 agent 连写两次：文件被覆盖成最新快照（不是追加成两份）', async () => {
    const root = join(dir, 'mirror-twice')
    const rows = [entry({ id: 'm1', text: '第一条' })]
    const store = fakeStore(rows)
    await syncMemoryMirror({
      store,
      workspaceId: WS,
      agentId: AGENT,
      agentName: 'a',
      root,
      gitPath: fakeGit,
    })
    rows.push(entry({ id: 'm2', text: '第二条' }))
    const result = await syncMemoryMirror({
      store,
      workspaceId: WS,
      agentId: AGENT,
      agentName: 'a',
      root,
      gitPath: fakeGit,
    })
    const text = await readFile(result.path, 'utf8')
    assert.equal(text.match(/第一条/g)?.length, 1, '旧内容不残留')
    assert.match(text, /第二条/)
    assert.match(text, /共 2 条/)
  })
})

describe('版本管理：可用就用，不可用就如实降级（镜像照写）', () => {
  test('★ 有 git ⇒ 版本管理启用，且真建了仓库并提交过', async () => {
    const root = join(dir, 'mirror-git')
    const result = await syncMemoryMirror({
      store: fakeStore([entry({ id: 'm1', text: 'x' })]),
      workspaceId: WS,
      agentId: AGENT,
      agentName: 'a',
      root,
      gitPath: fakeGit,
    })
    assert.equal(result.versioning.enabled, true, JSON.stringify(result.versioning))
    assert.equal(existsSync(join(root, '.git')), true, '建了仓库')
    assert.equal(existsSync(join(root, '.committed')), true, '提交过一次')
  })

  test('★★ 没有 git ⇒ versioning.enabled=false + 说清原因，但【镜像照样写出来】', async () => {
    const root = join(dir, 'mirror-nogit')
    const result = await syncMemoryMirror({
      store: fakeStore([entry({ id: 'm1', text: '没有 git 也要能看' })]),
      workspaceId: WS,
      agentId: AGENT,
      agentName: 'a',
      root,
      gitPath: join(dir, 'definitely-not-git'),
    })
    assert.equal(result.versioning.enabled, false)
    assert.match(result.versioning.note ?? '', /未启用/)
    const text = await readFile(result.path, 'utf8')
    assert.match(text, /没有 git 也要能看/, '★ 降级不影响人读这一份')
    assert.equal(existsSync(join(root, '.git')), false)
  })
})

describe('memoryRootFor：默认在数据目录下，可覆盖', () => {
  test('★ 缺省 <dataDir>/memory；给了 override 就用它', () => {
    assert.equal(memoryRootFor('/tmp/data'), join('/tmp/data', 'memory'))
    assert.equal(memoryRootFor('/tmp/data', '/tmp/mine'), '/tmp/mine')
  })

  test('★ 目录不存在时自己建（首次写记忆不用人手 mkdir）', async () => {
    const root = join(dir, 'deep', 'nest')
    await mkdir(join(dir, 'deep'), { recursive: true })
    const result = await syncMemoryMirror({
      store: fakeStore([]),
      workspaceId: WS,
      agentId: AGENT,
      agentName: 'a',
      root,
      gitPath: join(dir, 'definitely-not-git'),
    })
    assert.equal(existsSync(result.path), true)
  })
})
