import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ExecutionJob } from '@quality-ai/contracts/cases'
import { executionJobRequestSchema } from '@quality-ai/contracts/cases'
import { caseExecutionContractSchema } from '@quality-ai/contracts'
import { requireWriteAuthorization } from './automation/write-authorization'
import { runAgentTest } from './automation/agent-test-runner'
import { runAutomationPlan } from './automation/playwright-runner'
import { buildAgentGoalFromContract } from './automation/agent-goal'
import { interruptedExecution } from './modules/executions/interruption'
import { executionMarkdown } from './modules/executions/report'
import type { ProjectKnowledgeProvider } from './integrations/project-knowledge/types'

const directory=mkdtempSync(join(tmpdir(),'quality-ai-write-authorization-'))
process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
process.env.QUALITY_AI_DATA_ROOT=directory
const {createApiServer}=await import('./app')
const {database}=await import('./storage/database')
const {saveAnalysis}=await import('./modules/requirements/repository')
const {listCaseAssets}=await import('./modules/cases/repository')
const emptyProject:ProjectKnowledgeProvider={
  async getProjectInfo(){return {id:'fixture',name:'合成',configuredRoot:'.',connected:true,targetOrigins:[]}},
  async resolveRoute(){return null},async searchSource(){return []},
  async inspectFiles(){return {projectId:'fixture',reason:'合成',files:[],totalCharacters:0}},
}

test('已声明业务写操作经人工审核、执行授权后运行，历史和旧入口不能沿用授权',{timeout:45000},async t=>{
  let writes=0,modelCalls=0
  let target=''
  const site=createServer(async(request,response)=>{
    if(request.url==='/write'){
      writes++;response.writeHead(200,{'content-type':'text/plain; charset=utf-8'});response.end('保存成功');return
    }
    if(request.method==='POST'){
      let body='';for await(const chunk of request)body+=chunk
      assert.match(body,/只保存合成测试记录一次/)
      modelCalls++;response.writeHead(200,{'content-type':'application/json'})
      response.end(JSON.stringify({output_text:JSON.stringify({name:'合成保存',targetUrl:target,steps:[{action:'click',writeOperationIndex:0,locator:{by:'role',value:'button',name:'保存'}},{action:'expectText',text:'保存成功',assertionIndex:0}]})}));return
    }
    response.writeHead(200,{'content-type':'text/html; charset=utf-8'})
    response.end('<button onclick="fetch(\'/write\',{method:\'POST\'}).then(r=>r.text()).then(t=>document.querySelector(\'p\').textContent=t)">保存</button><p></p>')
  })
  await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve))
  target=`http://127.0.0.1:${(site.address() as AddressInfo).port}`
  process.env.MODEL_API_KEY='synthetic-test-only';process.env.MODEL_BASE_URL=target
  const api=createApiServer()
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${(api.address() as AddressInfo).port}`
  t.after(async()=>{await new Promise<void>(resolve=>api.close(()=>resolve()));await new Promise<void>(resolve=>site.close(()=>resolve()));database.close();rmSync(directory,{recursive:true,force:true})})
  const send=(path:string,body:unknown,method='POST')=>fetch(base+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  saveAnalysis({id:'synthetic-write',fileName:'合成.md',fileNames:['合成.md'],sourceText:'保存合成记录后显示保存成功',provider:'fixture',model:'fixture',createdAt:new Date().toISOString(),result:{versionName:'合成',productName:'合成',overview:'合成',requirements:[{title:'保存',summary:'保存合成记录',risk:'低风险',riskReason:'合成页面',businessRules:[],pageStates:[],questions:[],testCases:[{title:'保存测试记录',type:'主流程',priority:'P0',preconditions:[],steps:['点击保存'],expectedResult:'显示保存成功',blockedByQuestion:false,questionIds:[]}]}]}})
  const original=listCaseAssets('synthetic-write')[0]!
  const contract={...original.resolved.contract,writeOperations:['只保存合成测试记录一次']}
  assert.equal(caseExecutionContractSchema.safeParse({...contract,writeOperations:[' ']}).success,false)
  const review=await send(`/api/cases/${original.id}/review`,{expectedRevision:original.revision,review:{status:'confirmed',finalContract:contract}},'PATCH')
  assert.equal(review.status,200)
  const asset=(await review.json()).asset
  assert.notEqual(asset.resolved.contractFingerprint,original.resolved.contractFingerprint)
  const input={mode:'plan',targetUrl:target,cases:[{caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint}]}
  const preparation=await send('/api/cases/prepare-execution',input)
  assert.equal(preparation.status,200,'预览不要求先授权')
  assert.deepEqual((await preparation.json()).preparation.snapshots[0].resolved.contract.writeOperations,contract.writeOperations)
  for(const ids of [undefined,[],['unknown'],[asset.id,asset.id]]){
    const response=await send('/api/execution-jobs',{...input,authorizedWriteCaseIds:ids})
    assert.equal(response.status,409);assert.match((await response.json()).error,/授权/)
  }
  assert.equal(executionJobRequestSchema.safeParse({...input,writeAuthorizations:[{operations:['伪造许可']}]}).success,false)
  assert.equal(writes,0);assert.equal(modelCalls,0)
  assert.equal((await(await fetch(base+'/api/execution-jobs')).json()).jobs.length,0)
  const stale=await send('/api/execution-jobs',{...input,cases:[{...input.cases[0],contractFingerprint:original.resolved.contractFingerprint}],authorizedWriteCaseIds:[asset.id]})
  assert.equal(stale.status,409)
  const response=await send('/api/execution-jobs',{...input,authorizedWriteCaseIds:[asset.id]})
  assert.equal(response.status,202)
  let job=(await response.json()).job as ExecutionJob
  for(let index=0;index<300&&!['completed','failed'].includes(job.status);index++){
    await new Promise(resolve=>setTimeout(resolve,50))
    job=(await(await fetch(base+`/api/execution-jobs/${job.id}`)).json()).job
  }
  assert.equal(job.status,'completed',job.error)
  const result=(await(await fetch(base+`/api/executions/${job.id}`)).json()).execution
  assert.equal(result.status,'passed',result.error);assert.equal(writes,1);assert.equal(modelCalls,1)
  assert.deepEqual(result.writeAuthorizations,job.writeAuthorizations)
  const authorization=job.writeAuthorizations![0]!
  assert.deepEqual(authorization.operations,contract.writeOperations)
  assert.equal(authorization.targetUrl,target);assert.equal(authorization.contractFingerprint,asset.resolved.contractFingerprint)
  assert.ok(Date.parse(authorization.confirmedAt))
  assert.match(executionMarkdown(result,[]),/本次业务写操作授权/)
  assert.match(executionMarkdown(result,[]),/只保存合成测试记录一次/)
  assert.deepEqual(interruptedExecution(job).writeAuthorizations,job.writeAuthorizations)
  const rerun=await send(`/api/executions/${job.id}/rerun-job`,{})
  assert.equal(rerun.status,409);assert.match((await rerun.json()).error,/重新逐条授权/)
  const legacyRerun=await send(`/api/executions/${job.id}/rerun`,{})
  assert.equal(legacyRerun.status,409);assert.match((await legacyRerun.json()).error,/缺少本次授权/)
  const legacyDirect=await send('/api/automation/run',{plan:job.executionPlan,writeAuthorizations:job.writeAuthorizations})
  assert.equal(legacyDirect.status,409);assert.match((await legacyDirect.json()).error,/缺少本次授权/)
  await assert.rejects(runAutomationPlan(job.executionPlan),/缺少本次授权/)
  const goal=buildAgentGoalFromContract(asset.resolved,target)
  await assert.rejects(runAgentTest([goal],undefined,{projectProvider:emptyProject}),/缺少本次授权/)
  for(const patch of [{targetUrl:target+'/other'},{contractFingerprint:'other'},{operations:['任意操作']}]){
    assert.throws(()=>requireWriteAuthorization([goal.executionContract!],target,[{...authorization,...patch}]),/缺少本次授权/)
  }
  assert.equal(writes,1,'未授权路径不打开浏览器或触发写请求')
  let turn=0
  const dynamic=await runAgentTest([goal],undefined,{projectProvider:emptyProject,writeAuthorizations:job.writeAuthorizations,
    decisionProvider:{async decide(context){
      turn++
      if(turn===1){const button=context.snapshot.elements.find(item=>item.role==='button'&&item.name==='保存');assert.ok(button);return {type:'action',snapshotId:context.snapshot.snapshotId,reason:'执行已授权保存',action:{action:'click',writeOperationIndex:0,elementRef:button.ref}}}
      if(turn===2)return {type:'action',snapshotId:context.snapshot.snapshotId,reason:'验证保存结果',action:{action:'expectText',text:'保存成功',assertionId:goal.requiredAssertions[0]!.id}}
      return {type:'finish',summary:'已保存并验证'}
    }}})
  assert.equal(dynamic.status,'passed',dynamic.error);assert.equal(writes,2)
  assert.deepEqual(dynamic.writeAuthorizations,job.writeAuthorizations)
})
