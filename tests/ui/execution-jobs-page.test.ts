import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

test('后台任务刷新找回、关闭重开预览、历史合并及完整用例结果可读',async()=>{
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string')
  const browser=await chromium.launch({headless:true})
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
    const contract={objective:'从真实选项进行部分搜索',preconditions:['打开列表'],steps:['选择关键词'],expectedAssertions:['匹配项保留'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}
    const snapshots=[0,1].map(index=>({caseId:`c${index}`,revision:1,capturedAt:'now',resolved:{caseKey:`0-TC-${index}`,title:index?'后续验证':'部分搜索',contract,contractFingerprint:'frozen'}}))
    let status='running'
    let executionId:string|undefined
    const history=[{sequence:1,event:{type:'activity',executionId:'job',caseKey:'0-TC-0',caseTitle:'部分搜索',activity:{id:'same',title:'点击搜索框',purpose:'准备筛选',status:'running',technicalAction:'click e10'}}},{sequence:2,event:{type:'activity',executionId:'job',caseKey:'0-TC-0',caseTitle:'部分搜索',activity:{id:'same',title:'点击搜索框',purpose:'准备筛选',status:'passed',message:'点击完成',technicalAction:'click e10'}}}]
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url())
      if(url.pathname.endsWith('/cancel')){status='cancelled';executionId='job';await route.fulfill({json:{job:{id:'job',status,mode:'agent',snapshots,targetUrl:'https://example.test',executionId}}});return}
      if(url.pathname.endsWith('/events')){const events=Number(url.searchParams.get('after'))?[]:history;await route.fulfill({json:{events,nextCursor:2,frame:{type:'browser_frame',capturedAt:'2026-10-04T00:00:00Z',dataUrl:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='}}});return}
      if(url.pathname==='/api/executions/job'){await route.fulfill({json:{execution:{id:'job',status:'cancelled',caseResults:snapshots.map((item,index)=>({caseKey:item.resolved.caseKey,status:index?'not_run':'passed',passedAssertions:index?[]:['verified'],error:index?'批次取消，尚未开始':undefined,startedFromUrl:index?'':'https://example.test',resolvedDataBindings:[],steps:[],trajectory:[]}))}}});return}
      const job={id:'job',status,mode:'agent',snapshots,targetUrl:'https://example.test',executionId,updatedAt:'now'}
      await route.fulfill({json:url.pathname==='/api/execution-jobs'?{jobs:[job]}:{job}})
    })
    await page.goto(`http://127.0.0.1:${address.port}/#/execution-jobs/job`)
    await page.getByText('完整操作历史（1 步）').waitFor()
    await page.getByText('点击完成',{exact:false}).waitFor()
    await page.getByRole('button',{name:'关闭预览'}).click()
    assert.equal(await page.getByAltText('Playwright 最近页面画面').count(),0)
    await page.getByRole('button',{name:'重新打开预览'}).click()
    assert.equal(await page.getByAltText('Playwright 最近页面画面').count(),1)
    await page.reload()
    await page.getByText('完整操作历史（1 步）').waitFor()
    page.once('dialog',dialog=>dialog.accept())
    await page.getByRole('button',{name:'取消执行',exact:true}).click()
    await page.getByText('通过 / 选中总数：1 / 2',{exact:false}).waitFor()
    await page.locator('summary').filter({hasText:'后续验证 · 未执行'}).click()
    await page.getByText('批次取消，尚未开始').waitFor()
    await page.getByRole('button',{name:'使用指引'}).click()
    await page.getByRole('heading',{name:'如何查看执行'}).waitFor()
    await page.setViewportSize({width:390,height:844})
    await page.screenshot({path:'/private/tmp/quality-ai-execution-jobs.png',fullPage:true})
    const overflowing=await page.evaluate(()=>[...document.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>window.innerWidth).slice(0,12).map(el=>({tag:el.tagName,cls:el.className,width:el.getBoundingClientRect().width})))
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),JSON.stringify(overflowing))
    assert.deepEqual(errors,[])
  }finally{await browser.close();await server.close()}
})
