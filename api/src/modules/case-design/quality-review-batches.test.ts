import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaseDesign,DesignRun,DesignIssue,DesignReview } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from './documents'
import { qualityReviewBatches } from './quality-review-batches'
import { checkCaseQuality } from './quality-checker'
import { getModelConfig } from '../../model-config'
import { planFromFacts } from './scenario-planner'
import { generateCases } from './case-generator'

function fixture(){
  const documents=createEvidenceDocuments(Array.from({length:9},(_,index)=>({fileName:`规则${index}.md`,role:'prd' as const,content:`规则${index}允许查询。`+String(index).repeat(10000)+'仅原文中存在的末尾内容'})))
  const facts=documents.map((document,index)=>({id:`f${index}`,sourceFactIds:[`raw${index}`],statement:`规则${index}允许查询`,kind:'explicit' as const,evidence:[{documentId:document.id,blockId:document.blocks[0].id,quote:`规则${index}允许查询。`}],relatedQuestionIds:[]}))
  const scenarios=facts.map((fact,index)=>({id:`s${index}`,factIds:[fact.id],questionIds:[],title:`查询${index}`,testIntent:`验证${index}`,coverage:'positive' as const,requiresReview:false}))
  const cases=scenarios.slice(0,8).map((scenario,index)=>({id:`c${index}`,scenarioId:scenario.id,title:scenario.title,factIds:scenario.factIds,questionIds:[],verification:'browser' as const,verificationReason:'公开合成夹具',requiresReview:true as const,contract:{objective:`验证${index}`+'长目标'.repeat(5600),preconditions:[],steps:[`执行查询${index}`],expectedAssertions:[`结果${index}可见`],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}))
  const design:CaseDesign={id:'design',name:'大范围审查',revision:1,inputHash:'fixture',documents,createdAt:'now',updatedAt:'now'}
  const run:DesignRun={id:'run',designId:design.id,stage:'checking',attempt:1,status:'running',inputRevision:1,inputHash:'fixture',model:'fixture',protocol:'openai-responses',modelConfigHash:'fixture',promptVersion:'fixture',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[{id:'orphan-question',question:'尚未关联的待确认问题',evidence:[]}],processedBlockIds:documents.flatMap(document=>document.blocks.map(block=>block.id)),unprocessedBlockIds:[],factModel:{consolidatedFacts:facts,conflicts:[]},scenarios,cases}}
  return {design,run}
}

test('审查完整用例与直接依据分区，保留未关联规则并覆盖所有目标和原文组合',()=>{
  const {design,run}=fixture(),before=structuredClone(run)
  const batches=qualityReviewBatches(design,run,1500)
  assert.ok(batches.length>1&&batches.every(batch=>batch.kind==='cross'))
  for(const batch of batches){
    assert.ok(batch.input.length+1500<=120000)
    const input=JSON.parse(batch.input)
    for(const item of input.cases){
      const original=run.output.cases!.find(original=>original.id===item.id)
      assert.ok(original)
      assert.deepEqual(item,original,'不截短用例目标或断言')
      assert.ok(input.scenarios.some((scenario:{id:string})=>scenario.id===item.scenarioId))
      assert.ok(item.factIds.every((id:string)=>input.facts.consolidatedFacts.some((fact:{id:string})=>fact.id===id)))
    }
    for(const fact of input.facts.consolidatedFacts)assert.deepEqual(fact,run.output.factModel!.consolidatedFacts.find(original=>original.id===fact.id))
    for(const document of input.documents)for(const block of document.blocks)assert.equal(JSON.stringify(block),JSON.stringify(design.documents.find(original=>original.id===document.id)!.blocks.find(original=>original.id===block.id)))
  }
  for(const left of run.output.cases!)for(const right of run.output.cases!)assert.ok(batches.some(batch=>batch.caseIds.includes(left.id)&&batch.caseIds.includes(right.id)))
  for(const item of run.output.cases!)for(const block of design.documents.flatMap(document=>document.blocks))assert.ok(batches.some(batch=>batch.caseIds.includes(item.id)&&batch.blockIds.includes(block.id)))
  for(const item of run.output.cases!)for(const fact of run.output.factModel!.consolidatedFacts)assert.ok(batches.some(batch=>batch.caseIds.includes(item.id)&&batch.factIds.includes(fact.id)))
  assert.ok(batches.some(batch=>batch.factIds.includes('f8')&&batch.scenarioIds.includes('s8')))
  assert.ok(batches.some(batch=>batch.questionIds.includes('orphan-question')))
  assert.deepEqual(run,before)
})

test('大原文从事实合并经规划生成到交叉审查，原断言与全部来源保留',async()=>{
  const {design,run}=fixture()
  design.documents=createEvidenceDocuments(Array.from({length:12},(_,index)=>({fileName:`长材料${index}.md`,role:'prd' as const,content:`规则${index}：`+String(index%10).repeat(11500)})))
  run.output={facts:design.documents.map((document,index)=>({id:`f${index}`,statement:`规则${index}`,kind:'explicit',evidence:document.blocks.map(block=>({documentId:document.id,blockId:block.id,quote:block.text})),relatedQuestionIds:[]})),questions:[],processedBlockIds:design.documents.flatMap(document=>document.blocks.map(block=>block.id)),unprocessedBlockIds:[]}
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const raw=body.input[0].content.split('\n\nReturn only a valid json object.')[0]
    assert.ok(raw.length+body.instructions.length<=120000)
    const input=JSON.parse(raw)
    let result:unknown
    if(body.instructions.includes('阶段：modeling'))result={consolidatedFacts:input.facts.map((fact:{id:string;statement:string;evidenceRefs:string[]})=>({id:`m-${fact.id}`,sourceFactIds:[fact.id],statement:fact.statement,kind:'explicit',relatedQuestionIds:[],evidenceRefs:fact.evidenceRefs})),conflicts:[]}
    else if(body.instructions.includes('阶段：planning'))result={scenarios:input.planningScope?.kind==='cross'?[]:input.facts.map((fact:{id:string;statement:string},index:number)=>({id:`s${index}`,factIds:[fact.id],questionIds:[],title:fact.statement,testIntent:`验证${fact.statement}`,coverage:'positive'}))}
    else if(body.instructions.includes('阶段：generating'))result={cases:[{title:input.scenario.title,verification:'browser',verificationReason:'合成协议',contract:{objective:input.scenario.testIntent+'目标说明'.repeat(500),preconditions:[],steps:['打开页面'],expectedAssertions:[`${input.scenario.title}结果正确`],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}]}
    else{
      const first=input.cases.find((item:{title:string})=>item.title==='规则0')
      const last=input.cases.find((item:{title:string})=>item.title==='规则11')
      result={issues:first&&last?[{targetType:'case',targetId:last.id,kind:'contradiction',severity:'blocking',reason:'合成首尾规则跨用例检查待确认',evidence:input.facts.consolidatedFacts.find((fact:{id:string})=>first.factIds.includes(fact.id)).evidence}]:[]}
    }
    response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(result)}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}`,protocol:'openai-responses'})
  const signal=new AbortController().signal
  try{
    run.stage='modeling';await planFromFacts(design,run,config,signal,()=>{},[])
    assert.ok(run.output.modelingBatches!.length>1)
    assert.equal(run.output.factModel!.consolidatedFacts.length,12)
    run.stage='planning';await planFromFacts(design,run,config,signal,()=>{},[])
    assert.ok(run.output.planningBatches!.length>1)
    assert.deepEqual(run.output.uncoveredFactIds,[])
    run.stage='generating';await generateCases(run,config,signal,()=>{},[])
    assert.equal(run.output.cases!.length,12)
    const assertionsBefore=structuredClone(run.output.cases!.map(item=>item.contract.expectedAssertions))
    run.stage='checking';await checkCaseQuality(design,run,config,signal,()=>{},[])
    assert.equal(run.output.modelReviewCompleted,true)
    assert.ok(run.output.qualityBatches!.length>1&&run.output.qualityBatches!.every(batch=>batch.kind==='cross'&&batch.status==='completed'))
    assert.deepEqual(run.output.unreviewedBlockIds,[])
    assert.deepEqual(run.output.cases!.map(item=>item.contract.expectedAssertions),assertionsBefore)
    for(const fact of run.output.factModel!.consolidatedFacts)assert.deepEqual(fact.evidence,run.output.facts.find(item=>fact.sourceFactIds.includes(item.id))!.evidence)
    assert.ok(run.output.issues!.some(issue=>issue.reason==='合成首尾规则跨用例检查待确认'&&issue.severity==='blocking'))
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('大审查持久保存跨用例问题，越界目标和未提供原文拒绝，未完成批次阻止发布',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-review-batches-'))
  process.env.QUALITY_AI_DATABASE_PATH=join(directory,'state.sqlite')
  const {database}=await import('../../storage/database')
  const {createCaseDesign,saveDesignRun,listDesignRuns,recoverInterruptedDesignRuns}=await import('./repository')
  const {publicationBlockers}=await import('./publisher')
  let mode:'success'|'invalid'|'target'|'evidence'='success',calls=0
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const raw=body.input[0].content.split('\n\nReturn only a valid json object.')[0]
    assert.ok(raw.length+body.instructions.length<=120000)
    const input=JSON.parse(raw);calls++
    const issues:Array<Omit<DesignIssue,'id'|'checkedBy'>>=[]
    if(input.cases.some((item:{id:string})=>item.id==='c0')){
      const evidence=input.facts.consolidatedFacts.find((fact:{id:string})=>fact.id==='f0').evidence[0]
      issues.push({targetType:'case',targetId:mode==='target'?'c7':'c0',kind:'unverifiable',severity:'warning',reason:'合成单例提醒',evidence:[mode==='evidence'?{...evidence,quote:'仅原文中存在的末尾内容'}:evidence]})
      if(input.cases.some((item:{id:string})=>item.id==='c7'))issues.push({targetType:'case',targetId:'c7',kind:'contradiction',severity:'blocking',reason:'合成跨用例矛盾：c0与c7需人工核对',evidence:[evidence]})
    }
    response.setHeader('content-type','application/json')
    response.end(JSON.stringify({output_text:mode==='invalid'&&calls===2?'invalid-json':JSON.stringify({issues})}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}`,protocol:'openai-responses'})
  try{
    let {design,run}=fixture()
    const saved=createCaseDesign(design.name,design.documents);run.designId=saved.id
    const originalCases=structuredClone(run.output.cases)
    await checkCaseQuality(design,run,config,new AbortController().signal,()=>saveDesignRun(run),[])
    assert.equal(run.output.modelReviewCompleted,true)
    assert.ok(run.output.qualityBatches!.every(batch=>batch.status==='completed'))
    assert.equal(new Set(run.output.reviewedBlockIds).size,9)
    assert.equal(run.output.reviewedBlockIds!.length,9)
    assert.deepEqual(run.output.unreviewedBlockIds,[])
    assert.equal(run.output.issues!.filter(issue=>issue.reason==='合成单例提醒').length,1)
    assert.ok(run.output.issues!.some(issue=>issue.kind==='contradiction'&&issue.targetId==='c7'&&issue.checkedBy==='model'))
    assert.ok(run.output.issues!.some(issue=>issue.kind==='missing_coverage'&&issue.targetId==='f8'&&issue.checkedBy==='rule'))
    assert.deepEqual(run.output.cases,originalCases)
    assert.deepEqual(listDesignRuns(saved.id)[0].output.qualityBatches,run.output.qualityBatches)
    const review:DesignReview={id:'review',designId:design.id,runId:run.id,revision:1,inputRevision:1,inputHash:'fixture',createdAt:'now',content:{cases:{},questionDecisions:{},issueDecisions:{},excludedFacts:{}}}
    run.status='completed'
    assert.ok(!publicationBlockers(design,run,review).includes('质量审查批次或目标范围尚未完成'))
    run.output.qualityBatches![0].status='pending'
    assert.ok(publicationBlockers(design,run,review).includes('质量审查批次或目标范围尚未完成'),'完成标志为true也不能掩盖pending')
    run.output.qualityBatches![0].status='completed'
    for(const batch of run.output.qualityBatches!)batch.caseIds=batch.caseIds.filter(id=>id!=='c7')
    assert.ok(publicationBlockers(design,run,review).includes('质量审查批次或目标范围尚未完成'),'不能漏审某条用例后发布')

    for(const [failure,pattern] of [['invalid',/Unexpected|JSON|Invalid|character/i],['target',/本批未提供的目标/],['evidence',/本批未提供的原文内容/]] as const){
      ;({design,run}=fixture());mode=failure;calls=0
      await assert.rejects(checkCaseQuality(design,run,config,new AbortController().signal,()=>{},[]),pattern)
      assert.equal(run.output.modelReviewCompleted,false)
      assert.ok(run.output.qualityBatches!.some(batch=>batch.status==='pending'))
      if(failure==='invalid')assert.equal(run.output.qualityBatches![0].status,'completed')
    }
    ;({design,run}=fixture());run.designId=saved.id;mode='success';calls=0
    const controller=new AbortController()
    await assert.rejects(checkCaseQuality(design,run,config,controller.signal,()=>{
      saveDesignRun(run)
      if(run.output.qualityBatches?.[0]?.status==='completed')controller.abort(new Error('取消审查'))
      controller.signal.throwIfAborted()
    },[]),/取消审查/)
    assert.equal(calls,1)
    assert.equal(recoverInterruptedDesignRuns(),1)
    const recovered=listDesignRuns(saved.id)[0]
    assert.equal(recovered.status,'interrupted')
    assert.equal(recovered.output.modelReviewCompleted,false)
    assert.equal(recovered.output.qualityBatches![0].status,'completed')
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));database.close();rmSync(directory,{recursive:true,force:true})}
})
