import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
const directory=mkdtempSync(join(tmpdir(),'quality-ai-environments-'))
process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
process.env.QUALITY_AI_DATA_ROOT=directory
const {createApiServer}=await import('./app')
const {database}=await import('./storage/database')
const {listEnvironments,getEnvironmentById}=await import('./modules/projects/environment-repository')

test('独立环境页真实保存和导入，域名变化解除登录关联且离开保护草稿',async()=>{
  const api=createApiServer()
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  const address=api.address();assert.ok(address&&typeof address!=='string')
  const apiUrl=`http://127.0.0.1:${address.port}`
  const web=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0,proxy:{'/api':apiUrl}}})
  const browser=await chromium.launch({headless:true})
  try{
    await web.listen();const webAddress=web.httpServer!.address();assert.ok(webAddress&&typeof webAddress!=='string')
    const page=await browser.newPage({viewport:{width:390,height:844}})
    await page.goto(`http://127.0.0.1:${webAddress.port}/#/environments`)
    await page.getByLabel('环境名称',{exact:true}).fill('合成环境')
    await page.getByLabel('测试页面地址',{exact:true}).fill('bad-url')
    assert.equal(await page.getByRole('button',{name:'保存环境',exact:true}).isDisabled(),true)
    await page.getByLabel('测试页面地址',{exact:true}).fill('https://example.test/page')
    await page.getByRole('button',{name:'保存环境',exact:true}).click()
    await page.getByRole('status').filter({hasText:'环境已保存'}).waitFor()
    const id=listEnvironments()[0]!.id
    await page.getByLabel('导入登录态 JSON').setInputFiles({name:'state.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({cookies:[],origins:[]}))})
    await page.getByRole('status').filter({hasText:'登录态已导入'}).waitFor()
    assert.ok(getEnvironmentById(id)?.storageStatePath)
    await page.getByLabel('测试页面地址',{exact:true}).fill('https://example.test/other')
    await page.getByRole('button',{name:'保存环境',exact:true}).click()
    await page.getByRole('status').filter({hasText:'环境已保存'}).waitFor()
    assert.ok(getEnvironmentById(id)?.storageStatePath,'同域名路径变化保留关联')
    await page.getByLabel('测试页面地址',{exact:true}).fill('https://other.test/page')
    page.once('dialog',dialog=>dialog.dismiss())
    await page.getByRole('link',{name:'用例设计',exact:true}).click()
    assert.match(page.url(),/environments/)
    assert.equal(await page.getByLabel('测试页面地址',{exact:true}).inputValue(),'https://other.test/page')
    await page.getByRole('button',{name:'保存环境',exact:true}).click()
    await page.getByRole('status').filter({hasText:'旧登录态关联已解除'}).waitFor()
    assert.equal(getEnvironmentById(id)?.storageStatePath,undefined)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    await page.reload()
    await page.getByRole('button',{name:/合成环境/}).click()
    assert.equal(await page.getByLabel('测试页面地址',{exact:true}).inputValue(),'https://other.test/page')
    const invalid=await fetch(apiUrl+'/api/environments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'invalid',targetUrl:'bad-url'})})
    assert.equal(invalid.status,400)
    assert.equal(listEnvironments().length,1)
  }finally{await browser.close();await web.close();await new Promise<void>(resolve=>api.close(()=>resolve()));database.close();rmSync(directory,{recursive:true,force:true})}
})
