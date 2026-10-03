import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import type { ExecutionJob } from '@quality-ai/contracts/cases'

const directory=mkdtempSync(join(tmpdir(),'quality-ai-execution-jobs-'))
process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
process.env.QUALITY_AI_DATA_ROOT=directory
const {createApiServer}=await import('./app')
const {database}=await import('./storage/database')
const {saveAnalysis}=await import('./modules/requirements/repository')
const {listCaseAssets}=await import('./modules/cases/repository')

test('持久任务先返回ID，断开创建请求后实际浏览器执行，游标可补取且重启不重放',async t=>{
  const modelRequests:string[]=[]
  let releaseModel:()=>void=()=>{}
  let gate=new Promise<void>(resolve=>{releaseModel=resolve})
  const site=createServer(async(request,response)=>{
    if(request.method==='POST'){
      const chunks:Buffer[]=[]
      for await(const chunk of request)chunks.push(Buffer.from(chunk))
      modelRequests.push(Buffer.concat(chunks).toString())
      await gate
      response.writeHead(200,{'content-type':'application/json'})
      response.end(JSON.stringify({output_text:JSON.stringify({name:'合成固定计划',targetUrl:target,steps:[{action:'click',locator:{by:'text',value:'继续'}},{action:'expectText',text:'已继续'}]})}))
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
  assert.equal((await cancelRunning.json()).job.status,'cancelling')
  assert.equal((await(await post(`/api/execution-jobs/${running.id}/cancel`,{})).json()).job.status,'cancelling')
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
  const orphan={...job,id:'orphan',status:'running'}
  database.prepare('INSERT INTO execution_jobs VALUES (?,?,?)').run('orphan','running',JSON.stringify(orphan))
  const restart=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"const m=await import('./src/modules/executions/jobs.ts');m.initializeExecutionJobs();console.log(JSON.stringify(m.getExecutionJob('orphan')));"],{cwd:import.meta.dirname+'/..',env:process.env,encoding:'utf8'})
  assert.equal(JSON.parse(restart.trim()).status,'interrupted')
  assert.equal((await(await fetch(url+`/api/execution-jobs/${job.id}`)).json()).job.status,'completed')
})
