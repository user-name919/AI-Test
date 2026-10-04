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
    const completedCases=[{caseKey:'0-TC-0',title:'部分搜索',contractFingerprint:'frozen',status:'passed',passedAssertions:['匹配项保留'],startedFromUrl:'https://example.test',resolvedDataBindings:[],steps:[{index:0,action:'switchPage',status:'passed',durationMs:5,writeGuard:{allowed:true,label:'合成操作',observedAt:'2026-10-04',pageUrl:'https://example.test',reason:'合成授权线索，不证明业务成功',operation:'只修改合成测试记录',operationIndex:0},pageBefore:{ref:'fixed-initial-page',url:'https://example.test'},pageAfter:{ref:'fixed-detail-page',url:'https://example.test/detail'}}],trajectory:[],screenshots:[]}]
    const deploymentConfirmation={status:'unverified',reviewRevision:2,targetSha:'a'.repeat(40),confirmedBy:'合成审核人',createdAt:'2026-10-04',note:'尚未核实环境版本',regressionId:'regression-fixture',changeSetId:'change-fixture'}
    const writeAuthorizations=[{caseId:'c0',caseKey:'0-TC-0',contractFingerprint:'frozen',operations:['只修改合成测试记录'],targetUrl:'https://example.test',confirmedAt:'2026-10-04T00:00:00Z'}]
    const history=[{sequence:1,event:{type:'activity',executionId:'job',caseKey:'0-TC-0',caseTitle:'部分搜索',activity:{id:'same',title:'点击搜索框',purpose:'准备筛选',status:'running',technicalAction:'click e10'}}},{sequence:2,event:{type:'activity',executionId:'job',caseKey:'0-TC-0',caseTitle:'部分搜索',activity:{id:'same',title:'点击搜索框',purpose:'准备筛选',status:'passed',message:'点击完成',technicalAction:'click e10'}}}]
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url())
      if(url.pathname.endsWith('/cancel')){status='cancelled';executionId='job';await route.fulfill({json:{job:{id:'job',status,mode:'agent',snapshots,targetUrl:'https://example.test',executionId}}});return}
      if(url.pathname.endsWith('/events')){const events=Number(url.searchParams.get('after'))?[]:history;await route.fulfill({json:{events,nextCursor:2,frame:{type:'browser_frame',pageUrl:'https://example.test/detail',capturedAt:'2026-10-04T00:00:00Z',dataUrl:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='}}});return}
      if(url.pathname==='/api/executions/job'){await route.fulfill({json:{execution:{id:'job',status:'cancelled',caseResults:snapshots.map((item,index)=>({caseKey:item.resolved.caseKey,status:index?'not_run':'passed',passedAssertions:index?[]:['verified'],error:index?'批次取消，尚未开始':undefined,startedFromUrl:index?'':'https://example.test',resolvedDataBindings:[],steps:[],trajectory:index?[]:[{iteration:1,snapshotId:'snapshot-before',observation:{url:'https://example.test/detail',title:'详情',elementCount:1,elements:[],dialogs:[],messages:[],pageContext:{pages:[{ref:'stable-page-ref',url:'https://example.test/detail',active:true,allowed:true}],truncated:false}},decision:{type:'action',reason:'展开可搜索选项',action:{action:'click',elementRef:'e10'}},result:{ok:false,message:'控件重新渲染',durationMs:10},recovery:{attempt:1,limit:2,status:'reobserved',reason:'控件重新渲染'}}]}))}}});return}
      const job={writeAuthorizations,id:'job',status,mode:'agent',snapshots,targetUrl:'https://example.test',executionId,updatedAt:'now',deploymentConfirmation,rerunOf:'original-report',completedCases}
      await route.fulfill({json:url.pathname==='/api/execution-jobs'?{jobs:[job]}:{job}})
    })
    await page.goto(`http://127.0.0.1:${address.port}/#/execution-jobs/job`)
    await page.getByText('完整操作历史（1 步）').waitFor()
    await page.getByText('画面所在页面：https://example.test/detail',{exact:true}).waitFor()
    await page.getByText('整批报告尚未完成；已保存 1 条用例最终结果，其余不推断为通过。',{exact:true}).waitFor()
    await page.locator('summary').filter({hasText:'部分搜索 · 通过'}).waitFor()
    await page.locator('summary').filter({hasText:'后续验证 · 尚无最终结果'}).waitFor()
    assert.equal(await page.getByRole('link',{name:'查看原执行报告'}).getAttribute('href'),'#/executions/original-report')
    await page.getByText('点击完成',{exact:false}).waitFor()
    await page.getByRole('heading',{name:'本次业务写操作授权记录'}).waitFor()
    await page.getByText('0-TC-0 · 只修改合成测试记录',{exact:true}).click()
    await page.getByText('确认时间：2026-10-04T00:00:00Z',{exact:false}).waitFor()
    await page.getByText('部署版本未核实：本次结果不能证明目标版本已经部署',{exact:true}).waitFor()
    await page.getByRole('button',{name:'关闭预览'}).click()
    assert.equal(await page.getByAltText('Playwright 最近页面画面').count(),0)
    await page.getByRole('button',{name:'重新打开预览'}).click()
    assert.equal(await page.getByAltText('Playwright 最近页面画面').count(),1)
    await page.reload()
    await page.getByText('完整操作历史（1 步）').waitFor()
    await page.getByText('整批报告尚未完成；已保存 1 条用例最终结果，其余不推断为通过。',{exact:true}).waitFor()
    await page.locator('summary').filter({hasText:'部分搜索 · 通过'}).click()
    await page.getByText('通过断言：匹配项保留',{exact:true}).waitFor()
    await page.getByText(/写操作门禁：许可通过（不是业务成功）/).waitFor()
    await page.getByText('操作后当前页面：https://example.test/detail · fixed-detail-page',{exact:true}).waitFor()
    await page.locator('.evidence').first().screenshot({path:'/private/tmp/quality-ai-write-guard-evidence.png'})
    await page.locator('summary').filter({hasText:'部分搜索 · 通过'}).click()
    await page.getByText('部署版本未核实：本次结果不能证明目标版本已经部署',{exact:true}).waitFor()
    page.once('dialog',dialog=>dialog.accept())
    await page.getByRole('button',{name:'取消执行',exact:true}).click()
    await page.getByText('通过 / 选中总数：1 / 2',{exact:false}).waitFor()
    await page.locator('summary').filter({hasText:'部分搜索 · 通过'}).click()
    await page.getByRole('heading',{name:'第 1 步 · 展开可搜索选项'}).waitFor()
    await page.getByText('本步失败：控件重新渲染 · 10 ms',{exact:true}).waitFor()
    await page.getByText(/当前标签页：.*stable-page-ref/).waitFor()
    await page.locator('.evidence').first().screenshot({path:'/private/tmp/quality-ai-page-identity.png'})
    await page.getByText(/技术恢复 1\/2：已重新观察页面/).waitFor()
    await page.getByText('查看本步技术动作与观察',{exact:true}).click()
    await page.locator('.case-result').filter({has:page.getByRole('heading',{name:'第 1 步 · 展开可搜索选项'})}).getByText('查看原始执行数据（排障）',{exact:true}).waitFor()
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
