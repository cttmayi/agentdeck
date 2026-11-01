/**
 * `material/` 里"哪些能删"的规则（分批第 205 批）。
 *
 * 背景：上传的文件现在落在 `material/` **根上**（使用者定），所以"能不能删"不能再按目录名
 * （`appended/`）判——但 `material/` 里还混着平台从来源 run 切出来的证据与登记文件，删了
 * "依据"就和来源对不上。规则收在 `isRemovableMaterialPath` 一处，路由与界面共用。
 *
 * 这一组钉两件事：
 *   ① 规则本身（谁可删、谁不可删）；
 *   ② **不变量**：`writeMaterial` 往 `material/` 顶层写的**每一个**条目都在
 *      `MATERIAL_PLATFORM_ENTRIES` 里 —— 否则将来新加一个平台文件时会**悄悄变成可删**，
 *      而那种错是静默的。
 *
 * ⚠️ 真文件系统（仓库内 `.cache/test-tmp`），不碰任何 CLI（NFR-T-01）。
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  isRemovableMaterialPath,
  MATERIAL_PLATFORM_ENTRIES,
  writeMaterial,
  type MaterialContext,
} from './crystallize-material.ts'

let dir = ''
before(async () => {
  dir = await makeTempDir('material-removable')
})
after(async () => {
  await cleanup(dir)
})

describe('材料能不能删：一处判据', () => {
  test('★ 上传到根上的文件可删；`appended/` 下的可删；平台生成的不可删', () => {
    assert.equal(isRemovableMaterialPath('我上传的.pdf'), true)
    assert.equal(isRemovableMaterialPath('appended/后来追加的.md'), true)
    for (const rel of [
      '00-README.md',
      'meta.json',
      'skills-index.md',
      'injected-skills.json',
      'task-run.md',
      'verdict.md',
      'feedback.md',
      'user-requirements.md',
      'answers.md',
      'QUESTIONS.md',
      'turns/001.md',
      'existing-skill/SKILL.md',
    ]) {
      assert.equal(isRemovableMaterialPath(rel), false, rel)
    }
  })

  test('★★ 多段路径、`..`、反斜杠、空串一律不可删（API 是公开的，不能靠界面"不会这么传"）', () => {
    for (const rel of ['', '.', '..', 'a/b.md', 'appended/x/y.md', '../escape.md', 'a\\b.md']) {
      assert.equal(isRemovableMaterialPath(rel), false, JSON.stringify(rel))
    }
  })
})

describe('不变量：平台写进 material/ 顶层的条目都必须"不可删"', () => {
  test('★★★ writeMaterial 产出的每个顶层条目都在 MATERIAL_PLATFORM_ENTRIES 里', async () => {
    const materialDir = join(dir, 'material')
    const ctx: MaterialContext = {
      scope: 'task',
      sourceLabel: '探针',
      target: { kind: 'new', purpose: '不变量' },
      existingSkills: [],
    }
    await writeMaterial(
      materialDir,
      {
        pieces: [
          { relPath: 'turns/001.md', text: '# 第一轮\n' },
          { relPath: 'meta.json', text: '{}\n' },
          { relPath: 'appended/使用者给的.md', text: '# 给的\n' },
        ],
        stats: { turns: 1, toolCalls: 0 },
      },
      ctx,
    )
    const entries = await readdir(materialDir)
    assert.ok(entries.length > 0)
    for (const name of entries) {
      assert.equal(
        MATERIAL_PLATFORM_ENTRIES.has(name),
        true,
        `平台写出来的「${name}」不在 MATERIAL_PLATFORM_ENTRIES 里 —— 它会悄悄变成"可删"`,
      )
    }
  })
})
