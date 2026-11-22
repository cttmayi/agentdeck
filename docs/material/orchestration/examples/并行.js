// 并行：返回值是 Reply 数组（按顺序对应各自的人）
const 甲 = agent('调研员甲')
const 乙 = agent('调研员乙')

const [a, b] = await parallel([甲, 乙], '{{task}}')
return [a.message, b.message].flat().join('\n\n')
