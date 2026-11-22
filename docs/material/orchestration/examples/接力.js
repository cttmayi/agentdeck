// 接力：甲做完交给乙，乙的产出就是这一步的结果
const 取数 = agent('数据员')
const 成稿 = agent('写作员')

const 结果 = await flow([取数, 成稿], '{{task}}')
return 结果.message
