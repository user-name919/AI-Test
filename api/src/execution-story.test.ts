import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createServer as createViteServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { AgentDecision, AgentTestGoal, PageSnapshot, CaseExecutionContract, ExecutionRecord } from '@quality-ai/contracts'
import type { DesignRun } from '@quality-ai/contracts/case-design'
import type { CaseAsset, ExecutionJob, ExecutionArtifact } from '@quality-ai/contracts/cases'

test('故事 B：真实 API 发布契约驱动三类 DOM 搜索，故意失败后继续并刷新找回',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-story-b-'))
  const source=join(directory,'project');mkdirSync(source)
  const configPath=join(directory,'projects.json')
  writeFileSync(configPath,JSON.stringify({projects:[{id:'fixture',name:'临时合成项目',root:source,targetOrigins:[]}]}))
  process.env.PROJECTS_CONFIG_PATH=configPath
  process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
  process.env.QUALITY_AI_DATA_ROOT=directory
  const {createApiServer}=await import('./app')
  const {database}=await import('./storage/database')
  const {createCaseDesign,saveDesignRun}=await import('./modules/case-design/repository')
  const {createEvidenceDocuments}=await import('./modules/case-design/documents')
  let navigations=0
  const turns=new Map<string,number>()
  let release:()=>void=()=>{}
  const gate=new Promise<void>(resolve=>{release=resolve})
  const site=createServer(async(request,response)=>{
    if(request.method!=='POST'){
      if(request.url==='/search')navigations++
      response.writeHead(200,{'content-type':'text/html; charset=utf-8'})
      response.end(`<!doctype html><label>搜索<input aria-label="搜索" oninput="filter()"></label><button onclick="document.querySelector('input').value='';filter()">重置</button><ul><li role="option">Alpha</li><li role="option">Beta</li></ul><script>function filter(){const q=document.querySelector('input').value;for(const e of document.querySelectorAll('[role=option]')){e.style.display=e.textContent.includes(q)?'':'none';e.className=q?'match':''}}</script>`)
      return
    }
    try{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
      const body=JSON.parse(Buffer.concat(chunks).toString())
      const text=body.input[0].content as string
      const input=JSON.parse(text.slice(text.indexOf('\n')+1).split('\n\nReturn only')[0]) as {goal:AgentTestGoal;currentSnapshot:PageSnapshot}
      const {goal,currentSnapshot:snapshot}=input
      const key=goal.executionContract!.caseKey
      const turn=turns.get(key)??0;turns.set(key,turn+1)
      if(turns.size===1&&turn===0)await gate
      const binding=goal.executionContract!.contract.dataBindings[0]!
      const action=(value:Extract<AgentDecision,{type:'action'}>['action']):AgentDecision=>({type:'action',snapshotId:snapshot.snapshotId,action:value,reason:'依据当前真实 DOM 执行合成验收'})
      let decision:AgentDecision
      if(turn===0)decision=action({action:'click',elementRef:snapshot.elements.find(item=>item.name==='重置')!.ref})
      else if(turn===1){
        const option=snapshot.elements.find(item=>item.role==='option'&&item.name==='Alpha')!
        decision={type:'resolve_test_data',snapshotId:snapshot.snapshotId,bindingId:binding.id,sourceElementRef:option.ref,value:binding.strategy==='visible_option_full'?'Alpha':binding.strategy==='visible_option_substring'?'Al':'ZZZ',reason:'仅使用合成页面真实候选及已确认完整范围'}
      }else if(turn===2)decision=action({action:'fill',elementRef:snapshot.elements.find(item=>item.name==='搜索')!.ref,valueRef:binding.id})
      else if(turn===3)decision=action({action:'expectCount',role:'option',exact:false,count:binding.strategy==='visible_option_full'?99:binding.strategy==='visible_option_substring'?1:0,assertionId:goal.requiredAssertions[0]!.id})
      else decision={type:'finish',summary:'当前用例独立断言已完成'}
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({output_text:JSON.stringify(decision)}))
    }catch(error){response.writeHead(500);response.end(String(error))}
  })
  const api=createApiServer()
  let web:Awaited<ReturnType<typeof createViteServer>>|undefined
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  try{
    await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve))
    const origin=`http://127.0.0.1:${(site.address() as AddressInfo).port}`
    process.env.MODEL_API_KEY='local-synthetic-key';process.env.MODEL_BASE_URL=origin
    await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
    const apiOrigin=`http://127.0.0.1:${(api.address() as AddressInfo).port}`
    async function request(path:string,body?:unknown){const response=await fetch(apiOrigin+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result}
    const documents=createEvidenceDocuments([{fileName:'公开搜索夹具.md',role:'prd',content:'本地完整候选为 Alpha 和 Beta，支持完整、部分以及无匹配搜索。'}])
    const design=createCaseDesign('动态执行合成验收',documents)
    const fact={id:'f1',statement:documents[0]!.blocks[0]!.text,kind:'explicit' as const,evidence:[{documentId:documents[0]!.id,blockId:documents[0]!.blocks[0]!.id,quote:documents[0]!.blocks[0]!.text}],relatedQuestionIds:[]}
    const strategies=['visible_option_full','visible_option_substring','non_matching_option_query'] as const
    const cases=strategies.map((strategy,index)=>{
      const contract:CaseExecutionContract={objective:['故意错误数量预期','部分搜索保留匹配项','无匹配搜索为空'][index]!,preconditions:['打开合成页面'],steps:['重置搜索','从真实选项解析关键词','输入并验证结果数量'],expectedAssertions:[`可见选项数量为 ${index===0?99:index===1?1:0}`],forbiddenBehaviors:['不得改写数量预期'],uncertainties:[],dataBindings:[{id:'query',label:'搜索词',mode:'runtime_dom',targetHint:'搜索',businessIntent:'搜索验证',strategy,constraints:{mustComeFromCurrentDom:true,mustBePartialOfSource:index===1},...(index===2?{optionUniverse:{completeness:'complete_local' as const,options:['Alpha','Beta'],evidence:'公开夹具仅有这两项'}}:{})}]}
      return {id:`case-${index}`,scenarioId:`s${index}`,factIds:['f1'],questionIds:[],title:contract.objective,contract,verification:'browser' as const,verificationReason:'DOM可观察',requiresReview:true as const}
    })
    const now=new Date().toISOString()
    const run:DesignRun={id:'checked-fixture',designId:design.id,attempt:1,stage:'checking',status:'completed',inputRevision:1,inputHash:design.inputHash,model:'synthetic',modelConfigHash:'fixture',protocol:'fixture',promptVersion:'fixture',skills:[],createdAt:now,updatedAt:now,statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[fact],questions:[],processedBlockIds:documents[0]!.blocks.map(block=>block.id),unprocessedBlockIds:[],factModel:{consolidatedFacts:[{...fact,sourceFactIds:['f1']}],conflicts:[]},cases,issues:[],modelReviewCompleted:true}}
    saveDesignRun(run)
    await request(`/api/case-designs/${design.id}/reviews`,{runId:run.id,expectedRevision:0,review:{cases:Object.fromEntries(cases.map(item=>[item.id,{title:item.title,contract:item.contract,verification:item.verification,verificationReason:item.verificationReason,status:'confirmed'}])),questionDecisions:{},issueDecisions:{},excludedFacts:{}}})
    const publication=(await request(`/api/case-designs/${design.id}/publish`,{expectedRevision:1})).publication
    const assets:CaseAsset[]=(await request(`/api/cases?sourceType=case_design&sourceId=${design.id}`)).cases
    const {job}:{job:ExecutionJob}=await request('/api/execution-jobs',{mode:'agent',targetUrl:origin+'/search',projectId:'fixture',cases:assets.map(asset=>({caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint}))})
    web=await createViteServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0,proxy:{'/api':apiOrigin}}});await web.listen()
    const address=web.httpServer!.address();assert.ok(address&&typeof address!=='string')
    browser=await chromium.launch({headless:true});const page=await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/#/execution-jobs/${job.id}`)
    await page.getByRole('heading',{name:'Playwright 画面'}).waitFor()
    await page.getByRole('button',{name:'关闭预览',exact:true}).click()
    await page.reload()
    await page.getByRole('heading',{name:'Playwright 画面'}).waitFor()
    release()
    let current:ExecutionJob=job
    for(let i=0;i<800;i++){current=(await request(`/api/execution-jobs/${job.id}`)).job;if(['completed','failed'].includes(current.status))break;await new Promise(resolve=>setTimeout(resolve,25))}
    assert.equal(current.status,'completed',current.error)
    const result:ExecutionRecord=(await request(`/api/executions/${job.id}`)).execution
    assert.equal(result.status,'failed')
    assert.deepEqual(result.caseResults!.map(item=>item.status),['failed','passed','passed'])
    assert.deepEqual(result.caseResults!.map(item=>item.resolvedDataBindings[0]!.value),['Alpha','Al','ZZZ'])
    assert.ok(result.caseResults!.every(item=>item.resolvedDataBindings[0]!.snapshotId&&item.tracePath))
    assert.equal(navigations,1,'共享真实Page，不为每条用例重新导航')
    assert.deepEqual(result.caseSnapshots!.map(item=>item.resolved.contract),publication.snapshot.cases.map((item:{contract:unknown})=>item.contract))
    assert.match(result.caseResults![0]!.error!,/99/)
    const artifacts:ExecutionArtifact[]=(await request(`/api/executions/${job.id}/artifacts`)).artifacts
    assert.equal(artifacts.filter(item=>item.kind==='trace').length,3)
    assert.ok(artifacts.every(item=>item.available&&!('path' in item)))
    for(const artifact of artifacts){
      const download=await fetch(apiOrigin+artifact.url)
      assert.equal(download.status,200)
      const bytes=Buffer.from(await download.arrayBuffer())
      if(artifact.kind==='trace')assert.equal(bytes.subarray(0,2).toString(),'PK')
      else assert.equal(bytes.subarray(1,4).toString(),'PNG')
    }
    assert.equal((await fetch(apiOrigin+`/api/executions/${job.id}/artifacts/${'0'.repeat(64)}`)).status,404)
    const markdownResponse=await fetch(apiOrigin+`/api/executions/${job.id}/report.md`)
    assert.match(markdownResponse.headers.get('content-type')!,/text\/markdown/)
    const markdown=await markdownResponse.text()
    assert.match(markdown,/通过 \/ 选中总数：2 \/ 3/)
    assert.match(markdown,/可见选项数量为 99/)
    assert.match(markdown,/输入「Alpha」/)
    assert.match(markdown,/输入「Al」/)
    assert.match(markdown,/输入「ZZZ」/)
    assert.equal(markdown.includes(directory),false)
    await page.getByText('通过 / 选中总数：2 / 3',{exact:false}).waitFor()
    await page.locator('summary').filter({hasText:'故意错误数量预期 · 验证失败'}).click()
    await page.getByText('可见选项数量为 99',{exact:true}).waitFor()
    await page.getByRole('button',{name:'查看截图',exact:true}).first().click()
    await page.getByAltText('failure.png 页面证据').waitFor()
    const downloadEvent=page.waitForEvent('download')
    await page.getByRole('link',{name:'下载 Trace',exact:true}).first().click()
    assert.equal((await downloadEvent).suggestedFilename(),'trace.zip')
    await page.reload();await page.getByText('通过 / 选中总数：2 / 3',{exact:false}).waitFor()
  }finally{
    release();await browser?.close();await web?.close()
    await new Promise<void>(resolve=>api.close(()=>resolve()));await new Promise<void>(resolve=>site.close(()=>resolve()))
    database.close();rmSync(directory,{recursive:true,force:true})
  }
})
