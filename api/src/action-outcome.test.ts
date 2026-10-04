import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import type { AgentTestGoal } from '@quality-ai/contracts'
import { runAgentTest } from './automation/agent-test-runner'
import { runAutomationPlan } from './automation/playwright-runner'
import { PageObserver } from './automation/page-observer'
import { SingleActionExecutor } from './automation/single-action-executor'
import { ActionOutcomeUnknownError, attemptInputAction } from './automation/action-outcome'

test('真实提交已到服务器但导航超时，两模式记录结果不明并停止后续用例',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'quality-ai-uncertain-'))
  t.after(()=>rm(directory,{recursive:true,force:true}))
  let submissions=0
  const server=createServer((request,response)=>{
    if(request.url==='/submit'){submissions++;return} // Received the submission, intentionally never return its response.
    response.setHeader('content-type','text/html; charset=utf-8')
    response.end('<form action="/submit" method="post"><input aria-label="内容" value="示例"><button>提交</button></form>')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())}))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const url=`http://127.0.0.1:${address.port}`
  const goals:AgentTestGoal[]=[0,1].map(index=>({name:`提交${index}`,targetUrl:url,objective:'提交测试数据',requiredAssertions:[{id:'saved',description:'成功提示'}],executionContract:{caseKey:`0-TC-${index}`,contractFingerprint:`submit-${index}`,contract:{writeOperations:['提交一份合成测试数据'],objective:'提交测试数据',preconditions:[],steps:['点击提交'],expectedAssertions:['成功提示'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}}))
  const writeAuthorizations=goals.map(goal=>({caseId:goal.executionContract!.caseKey,caseKey:goal.executionContract!.caseKey,contractFingerprint:goal.executionContract!.contractFingerprint,operations:goal.executionContract!.contract.writeOperations!,targetUrl:url,confirmedAt:new Date().toISOString()}))
  let calls=0
  const dynamic=await runAgentTest(goals,undefined,{writeAuthorizations,artifactRoot:directory,projectProvider:{
    async getProjectInfo(){return{id:'fixture',name:'fixture',configuredRoot:'.',connected:true,targetOrigins:[url]}},
    async resolveRoute(){return null},async searchSource(){return []},async inspectFiles(){return{projectId:'fixture',reason:'unused',files:[],totalCharacters:0}},
  },decisionProvider:{async decide({snapshot}){calls++;return{type:'action',snapshotId:snapshot.snapshotId,reason:'按用例提交',action:{action:'click',writeOperationIndex:0,elementRef:snapshot.elements.find(item=>item.role==='button'&&item.name==='提交')!.ref}}}}})
  assert.equal(submissions,1)
  assert.equal(calls,1,'不重新请求模型决定再次提交')
  assert.deepEqual(dynamic.caseResults!.map(item=>item.status),['blocked','not_run'])
  assert.equal(dynamic.caseResults![0]!.trajectory[0]!.result!.code,'action_outcome_unknown')
  assert.equal(dynamic.caseResults![0]!.trajectory[0]!.recovery,undefined)
  assert.match(dynamic.caseResults![1]!.error!,/结果不明/)
  const fixed=await runAutomationPlan({name:'固定提交',targetUrl:url,steps:[],casePlans:goals.map(goal=>({caseKey:goal.executionContract!.caseKey,title:goal.name,contractFingerprint:goal.executionContract!.contractFingerprint,contract:goal.executionContract!.contract,steps:[{action:'click',writeOperationIndex:0,locator:{by:'role',value:'button',name:'提交'}},{action:'expectText',text:'成功提示',assertionIndex:0}]}))},undefined,{writeAuthorizations,artifactRoot:directory})
  assert.equal(submissions,2,'每种执行方式最多实际提交一次，后续关联用例不重复')
  assert.deepEqual(fixed.caseResults!.map(item=>item.status),['blocked','not_run'])
  assert.match(fixed.caseResults![0]!.steps[0]!.error!,/原始错误/)
  assert.match(fixed.caseResults![1]!.error!,/结果不明/)
})

test('点击前试运行失败没有业务输入，仍可有限重新观察；按键调用错误标不确定',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
  const page=await browser.newPage()
  await page.setContent('<button onclick="window.clicked=true">提交</button>')
  const observer=new PageObserver(),snapshot=await observer.observe(page)
  await page.getByRole('button').evaluate(element=>{(element as HTMLButtonElement).disabled=true})
  const original=observer.registry.resolve.bind(observer.registry)
  observer.registry.resolve=(id,ref)=>{
    const locator=original(id,ref),click=locator.click.bind(locator)
    locator.click=options=>click({...options,timeout:100})
    return locator
  }
  const result=await new SingleActionExecutor(page,observer.registry,'http://fixture.test',tmpdir()).execute(snapshot.snapshotId,{action:'click',elementRef:snapshot.elements[0]!.ref})
  assert.equal(result.code,'technical_action_failed')
  assert.equal(result.retryable,true)
  assert.equal(await page.evaluate(()=>Reflect.get(window,'clicked')),undefined)
  let attempts=0
  await assert.rejects(attemptInputAction('press',async()=>{attempts++;throw new Error('键盘输入后协议超时')}),error=>error instanceof ActionOutcomeUnknownError&&/press.*结果不明/.test(error.message))
  assert.equal(attempts,1)
})
