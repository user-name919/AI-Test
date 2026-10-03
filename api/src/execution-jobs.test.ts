import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import type { ExecutionJob } from '@quality-ai/contracts/cases'
import { automationPlanSchema } from '@quality-ai/contracts'

test('受阻计划只保存原因，不接受混入动作或无原因的空计划',()=>{
  const plan={name:'合成',targetUrl:'http://localhost',steps:[]}
  const casePlan={caseKey:'0-TC-0',title:'合成',contractFingerprint:'fixture',steps:[]}
  assert.equal(automationPlanSchema.safeParse(plan).success,false)
  assert.equal(automationPlanSchema.safeParse({...plan,casePlans:[casePlan]}).success,false)
  assert.equal(automationPlanSchema.safeParse({...plan,casePlans:[{...casePlan,preparationError:'无法表达断言'}]}).success,true)
  assert.equal(automationPlanSchema.safeParse({...plan,casePlans:[{...casePlan,preparationError:'无法表达断言',steps:[{action:'click',locator:{by:'text',value:'提交'}}]}]}).success,false)
})

const directory=mkdtempSync(join(tmpdir(),'quality-ai-execution-jobs-'))
process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
process.env.QUALITY_AI_DATA_ROOT=directory
const {createApiServer}=await import('./app')
const {database}=await import('./storage/database')
const {saveAnalysis,saveReview}=await import('./modules/requirements/repository')
const {saveExecution}=await import('./modules/executions/repository')
const {listCaseAssets}=await import('./modules/cases/repository')
const {saveAutomationPlan}=await import('./modules/cases/plan-repository')

test('持久任务先返回ID，断开创建请求后实际浏览器执行，游标可补取且重启不重放',async t=>{
  const modelRequests:string[]=[]
  const blockedResponses:string[]=[]
  let releaseModel:()=>void=()=>{}
  let gate=new Promise<void>(resolve=>{releaseModel=resolve})
  const site=createServer(async(request,response)=>{
    if(request.method==='POST'){
      const chunks:Buffer[]=[]
      for await(const chunk of request)chunks.push(Buffer.from(chunk))
      modelRequests.push(Buffer.concat(chunks).toString())
      await gate
      response.writeHead(200,{'content-type':'application/json'})
      const blocked=blockedResponses.shift()
      response.end(JSON.stringify({output_text:JSON.stringify(blocked ? {blocked} : {name:'合成固定计划',targetUrl:target,steps:[{action:'click',locator:{by:'text',value:'继续'}},{action:'expectText',assertionIndex:0,text:'已继续'}]})}))
    }else{
      response.writeHead(200,{'content-type':'text/html; charset=utf-8'})
      response.end('<button onclick="this.textContent=\'已继续\'">继续</button>')
    }
  })
  await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve))
  const target=`http://127.0.0.1:${(site.address() as AddressInfo).port}`
  process.env.MODEL_API_KEY='synthetic-test-only'
  process.env.MODEL_BASE_URL=target
  const api=createApiServer()
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${(api.address() as AddressInfo).port}`
  t.after(async()=>{
    releaseModel()
    await new Promise<void>(resolve=>api.close(()=>resolve()))
    await new Promise<void>(resolve=>site.close(()=>resolve()))
    database.close()
    rmSync(directory,{recursive:true,force:true})
  })
  saveAnalysis({id:'synthetic',fileName:'公开合成.md',fileNames:['公开合成.md'],sourceText:'继续按钮显示已继续',provider:'fixture',model:'fixture',createdAt:new Date().toISOString(),result:{versionName:'合成',productName:'合成',overview:'合成',requirements:[{
    title:'继续',summary:'继续操作',risk:'低风险',riskReason:'合成页面',businessRules:[],pageStates:[],questions:[],testCases:[{title:'继续按钮',type:'主流程',priority:'P0',preconditions:[],steps:['点击继续'],expectedResult:'显示已继续',blockedByQuestion:false,questionIds:[]}],
  }]}})
  const asset=listCaseAssets('synthetic')[0]!
  const input={mode:'plan',targetUrl:target,cases:[{caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint}]}
  const post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const first=await post('/api/execution-jobs',input)
  assert.equal(first.status,202)
  const job=(await first.json()).job as ExecutionJob
  assert.equal(job.status,'queued')
  // 模型请求仍被门闩阻塞；创建连接已结束，后端任务不依赖该连接。
  assert.equal((await(await fetch(url+`/api/execution-jobs/${job.id}`)).json()).job.status,'running')
  const queued=(await(await post('/api/execution-jobs',input)).json()).job as ExecutionJob
  const cancelled=await post(`/api/execution-jobs/${queued.id}/cancel`,{})
  assert.equal((await cancelled.json()).job.status,'cancelled')
  assert.equal((await post('/api/execution-jobs',{...input,cases:[{...input.cases[0],revision:99}]})).status,409)
  releaseModel()
  let current:ExecutionJob=job
  for(let i=0;i<200;i++){
    current=(await(await fetch(url+`/api/execution-jobs/${job.id}`)).json()).job
    if(['completed','failed'].includes(current.status))break
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.equal(current.status,'completed',current.error)
  assert.equal(current.executionId,job.id)
  const result=(await(await fetch(url+`/api/executions/${job.id}`)).json()).execution
  assert.equal(result.status,'passed')
  assert.deepEqual(result.caseSnapshots,current.snapshots)
  assert.equal(result.caseResults.length,1)
  assert.equal(result.caseResults[0].passedAssertions.length,1)
  assert.equal(modelRequests.length,1,'已取消排队任务不能调用模型或浏览器')
  const automationPlanId='11111111-1111-4111-8111-111111111111'
  saveAutomationPlan({id:automationPlanId,analysisId:'synthetic',caseKeys:['0-TC-0'],plan:result.plan,createdAt:new Date().toISOString()})
  assert.equal((await post('/api/execution-jobs',{...input,automationPlanId,targetUrl:target+'/different'})).status,409)
  const invalidPlanId='22222222-2222-4222-8222-222222222222'
  saveAutomationPlan({id:invalidPlanId,analysisId:'synthetic',caseKeys:['0-TC-0'],plan:{...result.plan,casePlans:result.plan.casePlans.map((item:object)=>({...item,contractFingerprint:'outdated'}))},createdAt:new Date().toISOString()})
  assert.equal((await post('/api/execution-jobs',{...input,automationPlanId:invalidPlanId})).status,409)
  let confirmedJob=(await(await post('/api/execution-jobs',{...input,automationPlanId})).json()).job as ExecutionJob
  for(let i=0;i<200;i++){
    confirmedJob=(await(await fetch(url+`/api/execution-jobs/${confirmedJob.id}`)).json()).job
    if(['completed','failed'].includes(confirmedJob.status))break
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.equal(confirmedJob.status,'completed',confirmedJob.error)
  assert.equal(confirmedJob.automationPlanId,automationPlanId)
  const confirmedResult=(await(await fetch(url+`/api/executions/${confirmedJob.id}`)).json()).execution
  assert.equal(confirmedResult.status,'passed')
  assert.deepEqual(confirmedResult.plan,result.plan,'执行必须保留人员确认的计划，不能重新生成替换')
  assert.equal(confirmedResult.automationPlanId,automationPlanId)
  assert.equal(modelRequests.length,1,'已确认计划不再调用计划生成模型')
  const originalBefore=(await(await fetch(url+`/api/executions/${confirmedJob.id}`)).json()).execution
  const rerunResponse=await post(`/api/executions/${confirmedJob.id}/rerun-job`,{})
  assert.equal(rerunResponse.status,202)
  let rerun=(await rerunResponse.json()).job as ExecutionJob
  for(let i=0;i<200;i++){
    rerun=(await(await fetch(url+`/api/execution-jobs/${rerun.id}`)).json()).job
    if(['completed','failed'].includes(rerun.status))break
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  assert.equal(rerun.status,'completed',rerun.error)
  assert.equal(rerun.rerunOf,confirmedJob.id)
  const rerunResult=(await(await fetch(url+`/api/executions/${rerun.id}`)).json()).execution
  assert.equal(rerunResult.status,'passed')
  assert.equal(rerunResult.rerunOf,confirmedJob.id)
  assert.deepEqual(rerunResult.plan,originalBefore.plan)
  assert.deepEqual((await(await fetch(url+`/api/executions/${confirmedJob.id}`)).json()).execution,originalBefore)
  assert.equal(modelRequests.length,1,'固定计划重跑也不能重新调用模型生成计划')
  const history=(await(await fetch(url+`/api/execution-jobs/${job.id}/events?after=0`)).json())
  assert.ok(history.events.some((item:{event:{type:string}})=>item.event.type==='execution_started'))
  assert.ok(history.events.some((item:{event:{type:string}})=>item.event.type==='activity'))
  assert.ok(history.frame.dataUrl.startsWith('data:image/'))
  const later=await(await fetch(url+`/api/execution-jobs/${job.id}/events?after=${history.nextCursor}`)).json()
  assert.deepEqual(later.events,[])
  assert.equal((await fetch(url+`/api/execution-jobs/${job.id}/events?after=-1`)).status,400)
  gate=new Promise<void>(resolve=>{releaseModel=resolve})
  const running=(await(await post('/api/execution-jobs',input)).json()).job as ExecutionJob
  for(let i=0;i<100 && modelRequests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(modelRequests.length,2)
  const cancelRunning=await post(`/api/execution-jobs/${running.id}/cancel`,{})
  assert.ok(['cancelling','cancelled'].includes((await cancelRunning.json()).job.status))
  assert.ok(['cancelling','cancelled'].includes((await(await post(`/api/execution-jobs/${running.id}/cancel`,{})).json()).job.status))
  releaseModel()
  let stopped:ExecutionJob=running
  for(let i=0;i<100;i++){
    stopped=(await(await fetch(url+`/api/execution-jobs/${running.id}`)).json()).job
    if(stopped.status==='cancelled')break
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.equal(stopped.status,'cancelled')
  assert.equal(stopped.executionId,undefined,'计划生成期间取消不得启动浏览器或创建假执行报告')
  assert.deepEqual((await(await fetch(url+`/api/execution-jobs/${running.id}/events`)).json()).events,[])
  saveAnalysis({id:'batch',fileName:'公开合成批次.md',fileNames:['公开合成批次.md'],sourceText:'继续按钮显示已继续',provider:'fixture',model:'fixture',createdAt:new Date().toISOString(),result:{versionName:'合成',productName:'合成',overview:'合成',requirements:[{
    title:'继续',summary:'继续操作',risk:'低风险',riskReason:'合成页面',businessRules:[],pageStates:[],questions:[],testCases:['首条受阻','后续执行'].map(title=>({title,type:'主流程',priority:'P0',preconditions:[],steps:['点击继续'],expectedResult:'显示已继续',blockedByQuestion:false,questionIds:[]})),
  }]}})
  const batchInput={...input,cases:listCaseAssets('batch').map(item=>({caseId:item.id,revision:item.revision,contractFingerprint:item.resolved.contractFingerprint}))}
  async function executeBatch(){
    let batch=(await(await post('/api/execution-jobs',batchInput)).json()).job as ExecutionJob
    for(let i=0;i<200;i++){
      batch=(await(await fetch(url+`/api/execution-jobs/${batch.id}`)).json()).job
      if(['completed','failed'].includes(batch.status))break
      await new Promise(resolve=>setTimeout(resolve,50))
    }
    assert.equal(batch.status,'completed',batch.error)
    return (await(await fetch(url+`/api/executions/${batch.id}`)).json()).execution
  }
  blockedResponses.push('缺少明确高亮属性依据')
  const partial=await executeBatch()
  assert.deepEqual(partial.caseResults.map((item:{status:string})=>item.status),['blocked','passed'])
  assert.match(partial.caseResults[0].error,/缺少明确高亮属性依据/)
  assert.equal(partial.caseResults[0].steps.length,0)
  assert.equal(partial.caseResults[1].passedAssertions.length,1)
  assert.equal(partial.caseSnapshots.length,2)
  assert.equal(partial.plan.casePlans[0].preparationError,partial.caseResults[0].error)
  blockedResponses.push('首条无法表达','次条无法表达')
  const allBlocked=await executeBatch()
  assert.deepEqual(allBlocked.caseResults.map((item:{status:string})=>item.status),['blocked','blocked'])
  assert.equal(allBlocked.steps.length,0,'全受阻批次不得伪造浏览器动作')
  saveReview('synthetic',{confirmedQuestions:[],selectedCases:[],caseReviews:{'0-TC-0':{status:'confirmed',updatedAt:null,finalContract:{...asset.resolved.contract,expectedAssertions:['已修改的最终预期']}}}})
  const changed=await post(`/api/executions/${confirmedJob.id}/rerun-job`,{})
  assert.equal(changed.status,409)
  assert.match((await changed.json()).error,/版本或口径已变化/)
  const regressionReportId='33333333-3333-4333-8333-333333333333'
  saveExecution({...originalBefore,id:regressionReportId},{caseKeys:['regression:historical']})
  assert.match((await(await post(`/api/executions/${regressionReportId}/rerun-job`,{})).json()).error,/重新确认部署/)
  const legacyReportId='44444444-4444-4444-8444-444444444444'
  saveExecution({...originalBefore,id:legacyReportId,caseSnapshots:undefined})
  assert.match((await(await post(`/api/executions/${legacyReportId}/rerun-job`,{})).json()).error,/缺少用例版本快照/)
  const orphan={...job,id:'orphan',status:'running'}
  database.prepare('INSERT INTO execution_jobs VALUES (?,?,?)').run('orphan','running',JSON.stringify(orphan))
  const restart=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"const m=await import('./src/modules/executions/jobs.ts');m.initializeExecutionJobs();console.log(JSON.stringify(m.getExecutionJob('orphan')));"],{cwd:import.meta.dirname+'/..',env:process.env,encoding:'utf8'})
  assert.equal(JSON.parse(restart.trim()).status,'interrupted')
  assert.equal((await(await fetch(url+`/api/execution-jobs/${job.id}`)).json()).job.status,'completed')
})
