// 机器把关：把关者必须能被判（要么带判定函数，要么是人 gate）
const 写作 = agent('写作员')
const 审查 = agent('审查员', (意见) => ({
  result: /通过|没问题|可用/.test(意见) ? 'pass' : 'fail',
}))

const 结果 = await loop(写作, 审查, '{{task}}', { maxRounds: 2 })
if (结果.result === 'fail') {
  return '两轮都没过，最后意见：' + (结果.guard?.message ?? '（没有意见）')
}
return 结果.message
