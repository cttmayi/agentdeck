/**
 * 一次性的"量真实界面几何"的小工具（不属于探针套件，只在开发时手动跑）。
 * 用法：node tools/layout-probe/measure-pages.mjs [宽度...]
 * 它把测量页写进 apps/web/dist（同源，才能读 iframe 里的 DOM），
 * 用 headless Chrome 打开、dump、再删掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dist = path.join(root, 'apps/web/dist')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const base = process.env.BASE || 'http://127.0.0.1:4517'
const widths = process.argv.slice(2).map(Number).filter(Boolean)
if (widths.length === 0) widths.push(1440)

const newTaskPage = (w) => `<!doctype html><meta charset="utf-8"><title>m</title>
<style>html,body{margin:0}iframe{border:0;display:block}</style>
<iframe id="f" src="/#/new"></iframe><pre id="out">pending</pre>
<script>
// ⚠️ 不用 iframe 的 load 事件：这个页面里它会早于监听器触发（实测卡在 pending）。
//    用轮询"应用真的画出来了"，就绪后**直接**写结果（不再套一层 setTimeout）。
const f=document.getElementById('f'),out=document.getElementById('out')
f.style.width=${w}px;f.style.height=1500px
let n=0
const t=setInterval(()=>{
  n++
  let d=null; try{d=f.contentDocument}catch(e){clearInterval(t);out.textContent='XORIGIN';return}
  if(!d||!d.querySelector('.chain-step')||!d.querySelector('.action-perms')){
    if(n>150){clearInterval(t);out.textContent='TIMEOUT n='+n}
    return
  }
  clearInterval(t)
  try{
   const r=(el)=>el?{x:Math.round(el.getBoundingClientRect().x),w:Math.round(el.getBoundingClientRect().width)}:null
   const p=d.querySelector('.action-perms'),body=p&&p.querySelector('.picker-body')
   out.textContent=JSON.stringify({W:${w},form:r(d.querySelector('form')),leadInput:r(d.querySelector('.form-lead input')),s1:r(d.querySelector('.step-exec')),s2:r(d.querySelector('.step-review')),s3:r(d.querySelector('.step-actions')),perms:r(p),list:p?r(p.querySelector('.ap-list')):null,detail:p?r(p.querySelector('.ap-detail')):null,stacked:body?getComputedStyle(body).flexDirection:null,overflowX:d.documentElement.scrollWidth>f.contentWindow.innerWidth},null,0)
  }catch(e){out.textContent='ERR '+e.message}
},60)
</script>`

const agentPage = `<!doctype html><meta charset="utf-8"><title>m</title>
<style>html,body{margin:0}iframe{border:0;display:block;width:1440px;height:1400px}</style>
<iframe id="f" src="/#/agents"></iframe><pre id="out">pending</pre>
<script>
const f=document.getElementById('f'),out=document.getElementById('out')
const click=(el)=>el&&el.dispatchEvent(new f.contentWindow.MouseEvent('click',{bubbles:true,cancelable:true,view:f.contentWindow}))
const wait=(ms)=>new Promise(r=>setTimeout(r,ms))
f.addEventListener('load',async()=>{try{
 const d=f.contentDocument
 await wait(1800); click(d.querySelector('.agent-row .agent-item')); await wait(1200)
 click([...d.querySelectorAll('.detail button')].find(b=>(b.textContent||'').trim()==='编辑')); await wait(1400)
 const r=(el)=>el?{x:Math.round(el.getBoundingClientRect().x),w:Math.round(el.getBoundingClientRect().width)}:null
 const p=d.querySelector('.action-perms'),fr=p?p.closest('.field-row'):null,body=p&&p.querySelector('.picker-body')
 out.textContent=JSON.stringify({view:'agentDetail',fieldRow:r(fr),perms:r(p),list:p?r(p.querySelector('.ap-list')):null,detail:p?r(p.querySelector('.ap-detail')):null,stacked:body?getComputedStyle(body).flexDirection:null,permsInsideRow:!!(fr&&p&&p.getBoundingClientRect().right<=fr.getBoundingClientRect().right+1),docOverflowX:d.documentElement.scrollWidth>f.contentWindow.innerWidth},null,0)
}catch(e){out.textContent='ERR '+e.message}})
</script>`

const dump = (page, w, tag) => new Promise((resolve) => {
  const file = path.join(dist, `_measure-${tag}.html`)
  fs.writeFileSync(file, page)
  const profile = path.join(root, '.cache/shot', `p-${tag}`)
  fs.rmSync(profile, { recursive: true, force: true })
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, '--virtual-time-budget=40000', '--window-size=1700,1600', '--dump-dom',
    `${base}/_measure-${tag}.html`], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  child.stdout.on('data', (c) => (buf += c))
  setTimeout(() => { child.kill('SIGKILL'); fs.rmSync(file, { force: true })
    const m = buf.match(/<pre id="out">([\s\S]*?)<\/pre>/)
    resolve(m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : `NO OUT (${tag})`)
  }, 30000)
})

for (const w of widths) console.log(await dump(newTaskPage(w), w, `new-${w}`))
console.log(await dump(agentPage, 1440, 'agent'))
