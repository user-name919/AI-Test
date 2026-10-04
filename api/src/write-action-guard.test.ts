import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import type { AgentTestGoal, CaseExecutionContract, ExecutionWriteAuthorization } from '@quality-ai/contracts'
import { guardWriteAction, WriteActionBlockedError } from './automation/write-action-guard'
import { SingleActionExecutor } from './automation/single-action-executor'
import { PageObserver } from './automation/page-observer'
import { runAgentTest } from './automation/agent-test-runner'
import { runAutomationPlan } from './automation/playwright-runner'
import { executionMarkdown } from './modules/executions/report'

const contract:CaseExecutionContract={objective:'仅操作合成记录',preconditions:[],steps:['操作按钮'],expectedAssertions:['显示结果'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}

test('真实DOM识别命名按钮、键盘隐式提交、外置form与开放Shadow，查询和普通输入不误当提交',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.setContent(`<button id="delete"><span>删除记录</span></button><span id="publish-label">发布</span><button id="publish" aria-labelledby="publish-label"></button>
    <input id="save" type="button" value="保存"><div id="menu" role="menuitem">删除</div>
    <form id="post" method="post"></form><input id="external" form="post"><form method="get" role="search"><input id="query"></form>
    <form method="get"><button id="override" formmethod="post">继续</button></form>
    <input id="combo" role="combobox"><textarea id="notes"></textarea><div id="row" tabindex="0">记录</div><button id="view">查看详情</button><div id="shadow"></div><button id="long"></button>`)
  await page.locator('#shadow').evaluate(element=>{const root=element.attachShadow({mode:'open'});root.innerHTML='<span id="label">删除</span><button aria-labelledby="label"></button>'})
  await page.evaluate(()=>{const dialog=document.createElement('section');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>删除记录</h2><button id="confirm-delete">确定</button><button id="cancel">取消</button>';document.body.append(dialog)})
  await page.locator('#long').evaluate(element=>{element.textContent='查询说明'.repeat(300)+'删除'})
  const target='http://fixture.test'
  assert.equal(await guardWriteAction(page.locator('#cancel'),{action:'click'},contract,undefined,target),undefined,'不因同弹窗风险标题阻止普通取消按钮')
  for(const selector of ['#delete span','#publish','#save','#menu','#override','#shadow button','#long','#confirm-delete']){
    await assert.rejects(guardWriteAction(page.locator(selector),{action:'click'},contract,undefined,target),error=>error instanceof WriteActionBlockedError&&!error.evidence.allowed)
  }
  await assert.rejects(guardWriteAction(page.locator('#external'),{action:'press',key:'Enter'},contract,undefined,target),/POST/)
  await assert.rejects(guardWriteAction(page.locator('#row'),{action:'press',key:'Delete'},contract,undefined,target),/Delete/)
  for(const [selector,action]of [['#query',{action:'press',key:'Enter'}],['#notes',{action:'press',key:'Enter'}],['#combo',{action:'press',key:'Enter'}],['#combo',{action:'press',key:'Delete'}],['#view',{action:'click'}]] as const){
    assert.equal(await guardWriteAction(page.locator(selector),action,contract,undefined,target),undefined)
  }
  const approved={...contract,writeOperations:['删除专用合成记录']}
  const authorization:ExecutionWriteAuthorization={caseId:'fixture',caseKey:'0-TC-0',contractFingerprint:'fixture',operations:approved.writeOperations,targetUrl:target,confirmedAt:new Date().toISOString()}
  assert.equal((await guardWriteAction(page.locator('#delete'),{action:'click',writeOperationIndex:0},approved,authorization,target))?.allowed,true)
  await assert.rejects(guardWriteAction(page.locator('#delete'),{action:'click'},approved,authorization,target),/缺少有效/)
  await assert.rejects(guardWriteAction(page.locator('#delete'),{action:'click',writeOperationIndex:1},approved,authorization,target),/缺少有效/)
  await assert.rejects(guardWriteAction(page.locator('#delete'),{action:'click',writeOperationIndex:0},approved,authorization,target+'/other'),/缺少有效/)
})

test('两模式风险点击在派发前受阻且后续只读用例继续，授权后可执行并保存门禁证据',{timeout:30000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'quality-ai-write-guard-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  let deletes=0,submits=0
  const server=createServer((request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8')
    if(request.url==='/delete'){deletes++;response.end('已删除');return}
    if(request.url==='/submit'){submits++;response.end('已提交');return}
    response.end(`<button onclick="fetch('/delete',{method:'POST'}).then(r=>r.text()).then(t=>document.querySelector('p').textContent=t)">删除</button><button onclick="document.querySelector('p').textContent='已查看'">查看</button><p></p><form action="/submit" method="post"><input aria-label="备注"><button>继续</button></form>`)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}`
  const goals:AgentTestGoal[]=[0,1].map(index=>({name:index?'只读查看':'删除测试记录',targetUrl:url,objective:contract.objective,requiredAssertions:[{id:'result',description:'显示结果'}],executionContract:{caseKey:`0-TC-${index}`,contractFingerprint:`fixture-${index}`,contract}}))
  const projectProvider={async getProjectInfo(){return{id:'fixture',name:'fixture',configuredRoot:'.',connected:true,targetOrigins:[]}},async resolveRoute(){return null},async searchSource(){return[]},async inspectFiles(){return{projectId:'fixture',reason:'fixture',files:[],totalCharacters:0}}}
  const dynamic=await runAgentTest(goals,undefined,{artifactRoot:directory,projectProvider,decisionProvider:{async decide({goal,snapshot,trajectory}){
    if(!trajectory.length)return{type:'action',snapshotId:snapshot.snapshotId,reason:'执行用例操作',action:{action:'click',elementRef:snapshot.elements.find(item=>item.role==='button'&&item.name===(goal.name==='只读查看'?'查看':'删除'))!.ref}}
    if(trajectory.length===1)return{type:'action',snapshotId:snapshot.snapshotId,reason:'核对结果',action:{action:'expectText',text:'已查看',assertionId:'result'}}
    return{type:'finish',summary:'只读验证完成'}
  }}})
  assert.deepEqual(dynamic.caseResults!.map(item=>item.status),['blocked','passed'])
  assert.equal(dynamic.caseResults![0]!.trajectory[0]!.result?.code,'write_authorization_required')
  assert.equal(dynamic.caseResults![0]!.trajectory[0]!.recovery,undefined)
  const makePlan=(authorized=false)=>({name:'风险与只读',targetUrl:url,steps:[],casePlans:goals.map((goal,index)=>({...goal.executionContract!,title:goal.name,
    contract:authorized&&index===0?{...contract,writeOperations:['仅删除专用测试记录']}:contract,
    steps:[{action:'click',...(authorized&&index===0?{writeOperationIndex:0}:{}),locator:{by:'role',value:'button',name:index?'查看':'删除'}},{action:'expectText',text:index?'已查看':'已删除',assertionIndex:0}]}))})
  const denied=await runAutomationPlan(makePlan(),undefined,{artifactRoot:directory})
  assert.deepEqual(denied.caseResults!.map(item=>item.status),['blocked','passed'])
  assert.equal(denied.caseResults![0]!.steps[0]!.writeGuard?.allowed,false)
  assert.equal(deletes,0)
  const authorizations=[{caseId:'fixture',caseKey:'0-TC-0',contractFingerprint:'fixture-0',operations:['仅删除专用测试记录'],targetUrl:url,confirmedAt:new Date().toISOString()}]
  const allowed=await runAutomationPlan(makePlan(true),undefined,{artifactRoot:directory,writeAuthorizations:authorizations})
  assert.equal(allowed.status,'passed',allowed.error);assert.equal(deletes,1)
  assert.equal(allowed.caseResults![0]!.steps[0]!.writeGuard?.operation,'仅删除专用测试记录')
  assert.match(executionMarkdown({...allowed,caseKeys:['0-TC-0','0-TC-1']},[]),/许可通过（不是业务成功）/)
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(url)
  const observer=new PageObserver();const snapshot=await observer.observe(page)
  const input=snapshot.elements.find(item=>item.name==='备注')!
  const executor=new SingleActionExecutor(page,observer.registry,url,directory,contract)
  const implicit=await executor.execute(snapshot.snapshotId,{action:'press',key:'Enter',elementRef:input.ref})
  assert.equal(implicit.code,'write_authorization_required');assert.equal(submits,0)
  const download=await executor.execute(snapshot.snapshotId,{action:'download',downloadId:'not-a-download',elementRef:snapshot.elements.find(item=>item.name==='删除')!.ref})
  assert.equal(download.code,'write_authorization_required');assert.equal(deletes,1)
  const submittedContract={...contract,writeOperations:['提交专用备注']}
  const submittedAuthorization={...authorizations[0]!,operations:submittedContract.writeOperations}
  const authorizedExecutor=new SingleActionExecutor(page,observer.registry,url,directory,submittedContract,undefined,undefined,submittedAuthorization)
  const submitted=await authorizedExecutor.execute(snapshot.snapshotId,{action:'press',key:'Enter',elementRef:input.ref,writeOperationIndex:0})
  assert.equal(submitted.ok,true,submitted.message);assert.equal(submitted.writeGuard?.allowed,true);assert.equal(submits,1)
  const popup=await runAutomationPlan({name:'不可绕过',targetUrl:url,steps:[{action:'goto',path:'/'},{action:'openPage',pageAlias:'delete',locator:{by:'role',value:'button',name:'删除'}}]},undefined,{artifactRoot:directory})
  assert.equal(popup.status,'blocked');assert.equal(deletes,1)
})
