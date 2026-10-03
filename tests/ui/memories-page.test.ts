import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer as httpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

test('质量记忆真实接口登记、审核、刷新和草稿保护',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-memory-ui-'))
  process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
  const {database}=await import('../../api/src/storage/database')
  const {saveExecution,listExecutions}=await import('../../api/src/modules/executions/repository')
  const {initializeMemories}=await import('../../api/src/modules/memories/repository')
  const {handleMemoryRoutes}=await import('../../api/src/modules/memories/routes')
  initializeMemories()
  saveExecution({id:'source',name:'合成搜索报告',status:'failed',targetUrl:'https://example.test/search',startedAt:'now',finishedAt:'now',durationMs:1,steps:[],screenshots:[],error:'没有匹配结果',sourceProject:{id:'project-a',commit:'a'.repeat(40)}})
  let failSave=true
  const api=httpServer(async(req,res)=>{
    if(req.url==='/api/executions'){res.setHeader('content-type','application/json');res.end(JSON.stringify({executions:listExecutions()}));return}
    if(req.url==='/api/memories'&&req.method==='POST'&&failSave){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'暂时无法保存'}));return}
    if(!await handleMemoryRoutes(req,res)){res.writeHead(404);res.end()}
  })
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  const apiAddress=api.address();assert.ok(apiAddress&&typeof apiAddress!=='string')
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0,proxy:{'/api':`http://127.0.0.1:${apiAddress.port}`}}})
  const browser=await chromium.launch({headless:true})
  try{
    await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string')
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    await page.goto(`http://127.0.0.1:${address.port}/#/memory`)
    await page.getByLabel('来源报告').selectOption('source')
    await page.getByLabel('人工经验').fill('先核对当前账号真实可见选项')
    await page.getByRole('button',{name:'保存为待审核',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'暂时无法保存'}).waitFor()
    assert.equal(await page.getByLabel('人工经验').inputValue(),'先核对当前账号真实可见选项')
    page.once('dialog',dialog=>dialog.dismiss())
    await page.getByRole('link',{name:'返回版本中心'}).click()
    assert.match(page.url(),/#\/memory$/)
    failSave=false
    await page.getByRole('button',{name:'保存为待审核',exact:true}).click()
    await page.getByRole('heading',{name:'合成搜索报告 · 待审核'}).waitFor()
    assert.equal(await page.getByRole('button',{name:'采纳经验',exact:true}).isDisabled(),true)
    await page.getByLabel('审核理由').fill('已核对来源，仅建议取值方式')
    await page.getByRole('button',{name:'采纳经验',exact:true}).click()
    await page.getByRole('heading',{name:'合成搜索报告 · 已采纳'}).waitFor()
    await page.getByText('原执行结论：验证失败（采纳经验不修改此结论）',{exact:true}).waitFor()
    await page.reload()
    await page.getByRole('heading',{name:'合成搜索报告 · 已采纳'}).waitFor()
    await page.getByLabel('审核理由').fill('页面已变更，需要重新核对')
    await page.getByRole('button',{name:'标记失效',exact:true}).click()
    await page.getByRole('heading',{name:'合成搜索报告 · 已失效'}).waitFor()
    await page.getByText('审核历史（2）',{exact:true}).click()
    await page.getByText(/v2 · 已采纳/).waitFor()
    await page.getByText(/v3 · 已失效/).waitFor()
    await page.getByRole('button',{name:'使用指引'}).click()
    await page.getByRole('heading',{name:'如何沉淀经验'}).waitFor()
    await page.setViewportSize({width:390,height:844})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    await page.screenshot({path:'/private/tmp/quality-ai-memories.png',fullPage:true})
  }finally{
    await browser.close();await server.close();await new Promise<void>(resolve=>api.close(()=>resolve()))
    database.close();rmSync(directory,{recursive:true,force:true})
  }
})
