import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

test('源码状态页显示实际目录版本、异常和刷新结果，不发送修改请求',async()=>{
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0}})
  const browser=await chromium.launch({headless:true})
  try{
    await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string')
    const page=await browser.newPage({viewport:{width:390,height:844}})
    let branch='feature/local',failed=false,dirty=true
    const requests:string[]=[]
    await page.route('**/api/**',async route=>{
      requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
      await route.fulfill(failed?{status:500,json:{error:'配置暂不可读'}}:{json:{projects:[
        {id:'good',name:'合成项目',connected:true,configuredRoot:'/fixture/source-link',resolvedRoot:'/fixture/actual-source',branch,commit:'a'.repeat(40),targetOrigins:['https://example.test'],worktree:{status:dirty?'dirty':'clean',observedAt:'2026-10-04T00:00:00Z'}},
        {id:'bad',name:'失效软链',connected:false,configuredRoot:'/fixture/missing',error:'目标目录不存在',targetOrigins:[]},
      ]}})
    })
    await page.goto(`http://127.0.0.1:${address.port}/#/projects/good`)
    await page.getByText('/fixture/actual-source',{exact:true}).waitFor()
    await page.getByText(/存在本地未提交或未跟踪改动，SHA 不能代表全部读取内容/).waitFor()
    assert.equal(await page.getByText('a'.repeat(40),{exact:true}).count(),1)
    await page.getByRole('button',{name:'使用指引',exact:true}).click()
    await page.getByText('本页仅检查已有配置',{exact:false}).waitFor()
    branch='feature/updated'
    dirty=false
    await page.getByRole('button',{name:'刷新连接状态',exact:true}).click()
    await page.locator('dd').filter({hasText:'feature/updated'}).waitFor()
    await page.getByText(/未发现 Git 跟踪或未跟踪改动/).waitFor()
    await page.getByRole('link',{name:/失效软链/}).click()
    await page.getByText('连接异常：目标目录不存在',{exact:true}).waitFor()
    await page.getByText(/历史未记录，不推断为干净/).waitFor()
    await page.reload()
    await page.getByText('连接异常：目标目录不存在',{exact:true}).waitFor()
    failed=true
    await page.getByRole('button',{name:'刷新连接状态',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'配置暂不可读'}).waitFor()
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    assert.ok(requests.length>=3)
    assert.ok(requests.every(item=>item==='GET /api/projects'),requests.join('\n'))
  }finally{await browser.close();await server.close()}
})
