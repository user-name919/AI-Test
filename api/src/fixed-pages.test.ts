import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { automationPlanSchema, type AutomationPlan, type LiveExecutionEvent } from '@quality-ai/contracts'
import { runAutomationPlan } from './automation/playwright-runner'
import { capturePopup } from './automation/capture-popup'
import { executionMarkdown } from './modules/executions/report'

async function fixture(t:test.TestContext){
  const directory=await mkdtemp(join(tmpdir(),'quality-ai-fixed-pages-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  let details=0
  const server=createServer((request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8')
    if(request.url==='/detail'){response.end(`<title>详情</title><button>详情${++details}</button>`);return}
    if(request.url==='/slow'){setTimeout(()=>response.end('<button>延迟详情</button>'),300);return}
    response.end('<title>入口</title><a target="_blank" href="/detail">打开详情</a><button onclick="window.open(\'/slow\');window.open(\'/detail\')">多页</button><button onclick="window.open(\'/slow\')">等待</button>')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())}))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  return{directory,url:`http://127.0.0.1:${address.port}`,detailCount:()=>details}
}

test('固定计划按捕获身份区分同URL新页、失败继续、返回初始页并保留画面证据',async t=>{
  const{directory,url,detailCount}=await fixture(t)
  const events:LiveExecutionEvent[]=[]
  const contract={objective:'验证新页按钮',preconditions:[],steps:['打开详情'],expectedAssertions:['指定按钮状态正确'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}
  const casePlan=(index:number,steps:unknown[])=>({caseKey:`0-TC-${index}`,title:`新页${index}`,contractFingerprint:`pages-${index}`,contract,steps})
  const result=await runAutomationPlan({name:'新页连续验证',targetUrl:url,steps:[],casePlans:[
    casePlan(0,[{action:'openPage',locator:{by:'role',value:'link',name:'打开详情'},pageAlias:'first'},{action:'openPage',locator:{by:'role',value:'link',name:'打开详情'},pageAlias:'second'},{action:'switchPage',pageAlias:'second'},{action:'expectText',text:'详情2',assertionIndex:0},{action:'switchPage',pageAlias:'first'},{action:'expectText',text:'详情1',assertionIndex:0},{action:'expectDisabled',locator:{by:'role',value:'button',name:'详情1'},assertionIndex:0}]),
    casePlan(1,[{action:'expectText',text:'详情1',assertionIndex:0},{action:'switchPage',pageAlias:'initial'},{action:'expectVisible',locator:{by:'role',value:'link',name:'打开详情'},assertionIndex:0}]),
    casePlan(2,[{action:'switchPage',pageAlias:'first'},{action:'expectText',text:'详情1',assertionIndex:0}]),
    casePlan(3,[{action:'switchPage',pageAlias:'caseStart'},{action:'expectVisible',locator:{by:'role',value:'link',name:'打开详情'},assertionIndex:0}]),
  ]},undefined,{artifactRoot:directory,onEvent:event=>events.push(event)})
  assert.deepEqual(result.caseResults?.map(item=>item.status),['failed','passed','blocked','passed'])
  assert.equal(detailCount(),2,'切换和后续用例不重复打开详情')
  const first=result.caseResults![0]!
  assert.notEqual(first.steps[0]!.openedPage!.ref,first.steps[1]!.openedPage!.ref)
  assert.equal(first.steps[0]!.openedPage!.url,first.steps[1]!.openedPage!.url)
  assert.equal(first.steps[0]!.pageAfter!.url,`${url}/`,'打开不等于切换')
  assert.equal(first.steps[2]!.pageAfter!.ref,first.steps[1]!.openedPage!.ref)
  assert.equal(first.steps[4]!.pageAfter!.ref,first.steps[0]!.openedPage!.ref)
  assert.equal(result.caseResults![1]!.startedFromUrl,`${url}/detail`)
  assert.ok(events.some(event=>event.type==='browser_frame'&&event.pageUrl===`${url}/detail`))
  assert.match(result.caseResults![2]!.error!,/尚未绑定/)
  const markdown=executionMarkdown({...result,caseKeys:['0-TC-0','0-TC-1','0-TC-2','0-TC-3']},[])
  assert.match(markdown,/实际打开页面/)
  assert.ok(markdown.includes(first.steps[1]!.openedPage!.ref))
  assert.ok(first.tracePath&&first.screenshots.length)
})

test('新页捕获仅监听本次来源，歧义或取消后清理监听且不重复触发',async t=>{
  const{url}=await fixture(t)
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
  const context=await browser.newContext(),page=await context.newPage();await page.goto(url)
  const emitter=page as unknown as EventEmitter
  const before=emitter.listenerCount('popup')
  let clicks=0
  await assert.rejects(capturePopup(page,async()=>{clicks++;await page.getByRole('button',{name:'多页'}).click();await page.waitForTimeout(500)}),/多个标签页/)
  assert.equal(clicks,1)
  assert.equal(emitter.listenerCount('popup'),before)
  const controller=new AbortController()
  await assert.rejects(capturePopup(page,async()=>{clicks++;controller.abort(new Error('主动取消'))},controller.signal),/主动取消/)
  assert.equal(clicks,2)
  assert.equal(emitter.listenerCount('popup'),before)
  const background=await context.newPage();await background.goto(`${url}/detail`)
  const captured=await capturePopup(page,()=>page.getByRole('link').click())
  assert.notEqual(captured,background)
  assert.equal(captured.url(),background.url())
})

test('保留别名拒绝，重复别名不再次点击，外部新页不绑定或切换',async t=>{
  const{directory,url,detailCount}=await fixture(t)
  assert.equal(automationPlanSchema.safeParse({name:'非法',targetUrl:url,steps:[{action:'openPage',locator:{by:'role',value:'link'},pageAlias:'initial'}]}).success,false)
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
  const step={action:'openPage',locator:{by:'role',value:'link',name:'打开详情'},pageAlias:'detail'}
  const result=await runAutomationPlan({name:'重复别名',targetUrl:url,steps:[{action:'goto',path:'/'},step,step]},undefined,{artifactRoot:directory,launchBrowser:async()=>browser})
  assert.equal(result.status,'blocked')
  assert.match(result.error!,/别名已使用/)
  assert.equal(detailCount(),1)
  // Separate port is an external Origin even on the same machine; no external website involved.
  const other=await fixture(t)
  const secondBrowser=await chromium.launch({headless:true});t.after(()=>secondBrowser.close())
  const external:AutomationPlan={name:'外部页',targetUrl:url,steps:[{action:'goto',path:'/'},{action:'openPage',locator:{by:'role',value:'link',name:'打开详情'},pageAlias:'external'}]}
  const externalResult=await runAutomationPlan(external,undefined,{artifactRoot:directory,launchBrowser:async()=>{
    const original=secondBrowser.newContext.bind(secondBrowser)
    secondBrowser.newContext=async options=>{
      const context=await original(options)
      await context.route(`${url}/`,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<a target="_blank" href="${other.url}/detail">打开详情</a>`}))
      return context
    }
    return secondBrowser
  }})
  assert.equal(externalResult.status,'blocked',externalResult.error)
  assert.match(externalResult.error!,/不属于测试环境/)
  assert.equal(externalResult.steps[1]!.pageAfter!.url,`${url}/`)
  assert.equal(externalResult.steps[1]!.openedPage!.url,`${other.url}/detail`)
})

test('固定模式已关闭目标不回退，活动新页关闭后剩余用例未执行',async t=>{
  const{directory,url}=await fixture(t)
  for(const closeAfter of ['openPage','switchPage']){
    const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
    let closing:Promise<void>|undefined
    const result=await runAutomationPlan({name:'关闭页',targetUrl:url,steps:[],casePlans:[
      {caseKey:'0-TC-0',title:'打开再关闭',contractFingerprint:'close',steps:[{action:'openPage',locator:{by:'role',value:'link',name:'打开详情'},pageAlias:'detail'},{action:'switchPage',pageAlias:'detail'},{action:'expectVisible',locator:{by:'role',value:'button'}}]},
      {caseKey:'0-TC-1',title:'后续',contractFingerprint:'next',steps:[{action:'expectVisible',locator:{by:'role',value:'link',name:'打开详情'}}]},
    ]},undefined,{artifactRoot:directory,launchBrowser:async()=>browser,onEvent:event=>{
      if(!closing&&event.type==='activity'&&event.activity.status==='passed'&&event.activity.technicalAction?.includes(`"action":"${closeAfter}"`)){
        closing=browser.contexts()[0]!.pages().find(page=>page.url().endsWith('/detail'))!.close()
      }
    }})
    await closing
    assert.ok(closing)
    assert.deepEqual(result.caseResults!.map(item=>item.status),closeAfter==='openPage'?['blocked','passed']:['infrastructure_failed','not_run'])
    assert.match(result.caseResults![0]!.error!,/关闭/)
  }
})
