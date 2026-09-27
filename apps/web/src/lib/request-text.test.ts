import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ISSUE_TITLE_MAX, splitRequest } from './request-text.ts'

/**
 * 「要做什么」那一个多行框怎么切成一条记录。
 *
 * ⚠️ 这里守的是**静默丢字**：切分错了不会报错（任务照样建、照样跑），只是
 *    `Issue.title` / `description` 里的东西不对，而使用者要到翻任务清单时才发现。
 */
test('第一行当标题，其余进说明', () => {
  assert.deepEqual(splitRequest('改一下登录页\n背景太白了\n再加个记住我'), {
    issueTitle: '改一下登录页',
    issueDescription: '背景太白了\n再加个记住我',
  })
})

test('只有一行 ⇒ 说明是空串（不是把标题抄一遍）', () => {
  // 抄一遍的后果是任务详情里「说明」与标题一字不差地重复一次
  assert.deepEqual(splitRequest('审一下这次依赖升级的影响面'), {
    issueTitle: '审一下这次依赖升级的影响面',
    issueDescription: '',
  })
})

test('★ 前面空几行不算：标题取第一个**非空**行', () => {
  // 顺手按回车、或者从别处粘过来的文本常带前导空行。按"第 0 行"取的话
  // 标题会变成空串，而 `Issue.title` 是 `min(1)` ⇒ 整条创建请求 400，
  // 使用者那一段话白写（这正是这条测试存在的理由）。
  assert.deepEqual(splitRequest('\n\n  \n真正的第一行\n后面'), {
    issueTitle: '真正的第一行',
    issueDescription: '后面',
  })
})

test('★ 标题超过 500 字 ⇒ 只截标题，其余一个字都不丢', () => {
  // 协议里 `Issue.title` 是 `max(500)`，超了是**整条请求被拒**。
  const long = 'x'.repeat(600)
  const split = splitRequest(`${long}\n第二行`)
  assert.equal(split.issueTitle.length, ISSUE_TITLE_MAX)
  assert.equal(split.issueDescription, '第二行')
})

test('标题的首尾空白去掉（粘贴常带）', () => {
  assert.deepEqual(splitRequest('   带空格的标题   \n正文'), {
    issueTitle: '带空格的标题',
    issueDescription: '正文',
  })
})

test('多行正文里的空行原样保留（那是使用者排的版）', () => {
  assert.deepEqual(splitRequest('标题\n\n第一段\n\n第二段'), {
    issueTitle: '标题',
    issueDescription: '第一段\n\n第二段',
  })
})

test('全是空白 ⇒ 两个空串（形状正确，不做二次判断）', () => {
  // 提交按钮的 `disabled` 已经挡掉了空提交；这里只保证不抛、不给出半截结果
  assert.deepEqual(splitRequest('   \n\n  '), { issueTitle: '', issueDescription: '' })
})
