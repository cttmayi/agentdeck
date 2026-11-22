// 人把关：reuseOutput = 第一轮不重跑执行者，直接把他刚审过的那一版摆给人看
const 写作 = agent('写作员')
const 审查 = agent('审查员', (意见) => ({ result: /通过/.test(意见) ? 'pass' : 'fail' }))

await loop(写作, 审查, '{{task}}') // 机器先过一道

const 人审 = await loop(写作, gate('文章已完成，请过目；不满意就写意见'), {
  maxRounds: 3,
  reuseOutput: true,
})
if (人审.result === 'fail') return '人没有通过：' + (人审.guard?.message ?? '')
return 人审.message
