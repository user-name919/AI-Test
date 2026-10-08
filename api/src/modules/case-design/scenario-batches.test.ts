import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { CaseDesign,DesignRun } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from './documents'
import { scenarioPlanningBatches } from './scenario-batches'
import { planFromFacts } from './scenario-planner'
import { generateCases } from './case-generator'
import { getModelConfig } from '../../model-config'

function fixture(){
  const documents=createEvidenceDocuments(Array.from({length:6},(_,index)=>({fileName:`规则${index}.md`,role:'prd' as const,content:`规则${index}：`+String(index).repeat(23000)})))
  const facts=documents.map((document,index)=>({id:`m${index}`,sourceFactIds:[`f${index}`],statement:`规则${index}`,kind:'explicit' as const,evidence:document.blocks.map(block=>({documentId:document.id,blockId:block.id,quote:block.text})),relatedQuestionIds:index===0||index===4?['q-conflict']:[]}))
  const design:CaseDesign={id:'design',name:'大材料场景',revision:1,inputHash:'fixture',documents,createdAt:'now',updatedAt:'now'}
  const run:DesignRun={id:'run',designId:design.id,stage:'planning',attempt:1,status:'running',inputRevision:1,inputHash:'fixture',model:'fixture',protocol:'openai-responses',modelConfigHash:'fixture',promptVersion:'fixture',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[],processedBlockIds:documents.flatMap(document=>document.blocks.map(block=>block.id)),unprocessedBlockIds:[],factModel:{consolidatedFacts:facts,conflicts:[{id:'q-conflict',factIds:['m0','m4'],question:'需要确认限制',evidence:[facts[0].evidence[0],facts[4].evidence[0]]}]}}}
  return {design,run}
}

test('完整原文分区规划先局部后交叉，不丢失跨批冲突上下文',()=>{
  const {run}=fixture()
  const before=structuredClone(run)
  const batches=scenarioPlanningBatches(run,1500)
  assert.ok(batches.length>1)
  const locals=batches.filter(batch=>batch.kind==='local')
  assert.equal(locals.flatMap(batch=>batch.factIds).length,6)
  assert.equal(new Set(locals.flatMap(batch=>batch.factIds)).size,6)
  for(const batch of batches){
    assert.ok(batch.input.length+1500<=120000)
    const input=JSON.parse(batch.input)
    for(const fact of input.facts){
      const original=run.output.factModel!.consolidatedFacts.find(item=>item.id===fact.id)!
      assert.deepEqual(fact.evidenceRefs.map((id:string)=>input.evidenceTable.find((entry:{id:string})=>entry.id===id).evidence),original.evidence)
      if(fact.id==='m0'||fact.id==='m4')assert.equal(input.conflicts[0].id,'q-conflict')
    }
  }
  for(const left of locals)for(const right of locals){
    if(left===right)continue
    assert.ok(batches.some(batch=>batch.kind==='cross'&&[...left.factIds,...right.factIds].every(id=>batch.factIds.includes(id))))
  }
  assert.deepEqual(run,before)
})

test('大材料规划接通逐场景生成，未覆盖规则和失败/取消范围如实保留',async()=>{
  let mode:'success'|'invalid-cross'|'unknown-fact'='success',calls=0
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const raw=body.input[0].content.split('\n\nReturn only a valid json object.')[0]
    assert.ok(raw.length+body.instructions.length<=120000)
    const input=JSON.parse(raw);calls++
    let result:unknown
    if(body.instructions.includes('阶段：generating')){
      assert.ok(input.facts.every((fact:{id:string})=>input.scenario.factIds.includes(fact.id)))
      result={cases:[{title:input.scenario.title,verification:'browser',verificationReason:'本地协议夹具',contract:{objective:input.scenario.testIntent,preconditions:[],steps:['核对页面'],expectedAssertions:['符合已确认规则'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}]}
    }else{
      const make=(id:string,factIds:string[])=>({id,factIds,questionIds:[],title:factIds.join('与'),testIntent:`核对 ${factIds.join('与')}`,coverage:'positive'})
      if(input.planningScope.kind==='cross'){
        const ids=input.facts.map((fact:{id:string})=>fact.id) as string[]
        result={scenarios:mode==='invalid-cross'?[make('bad',[ids[0]])]:ids.includes('m0')&&ids.includes('m4')?[make('s1',['m0','m4']),make('s2',['m0','m4'])]:[]}
      }else{
        result={scenarios:input.facts.filter((fact:{id:string})=>fact.id!=='m5').map((fact:{id:string},index:number)=>make(`s${index}`,mode==='unknown-fact'?['m5']:[fact.id]))}
      }
    }
    response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(result)}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}`,protocol:'openai-responses'})
  try{
    let {design,run}=fixture()
    const snapshots:DesignRun['output'][]=[]
    await planFromFacts(design,run,config,new AbortController().signal,()=>snapshots.push(structuredClone(run.output)),[])
    assert.ok(run.output.planningBatches?.every(batch=>batch.status==='completed'))
    assert.equal(run.output.scenarios?.length,6,'完全相同的跨批建议只保留一条')
    assert.equal(new Set(run.output.scenarios!.map(scenario=>scenario.id)).size,6,'各批返回同名ID不会覆盖')
    assert.deepEqual(run.output.uncoveredFactIds,['m5'],'没有场景的规则不能被批次完成标志掩盖')
    const cross=run.output.scenarios!.find(scenario=>scenario.factIds.length===2)!
    assert.deepEqual(cross.questionIds,['q-conflict'])
    assert.equal(cross.requiresReview,true)
    assert.ok(snapshots.some(snapshot=>snapshot.planningBatches?.some(batch=>batch.status==='pending')&&snapshot.scenarios?.length))
    run.stage='generating'
    await generateCases(run,config,new AbortController().signal,()=>{},[])
    assert.equal(run.output.cases?.length,6)
    assert.deepEqual(run.output.unprocessedScenarioIds,[])
    assert.ok(run.output.cases!.find(item=>item.scenarioId===cross.id)!.contract.uncertainties.some(value=>value.includes('q-conflict')))
    assert.deepEqual(run.output.uncoveredFactIds,['m5'])

    ;({design,run}=fixture());mode='invalid-cross';calls=0
    await assert.rejects(planFromFacts(design,run,config,new AbortController().signal,()=>{},[]),/同时引用两侧事实/)
    assert.ok(run.output.planningBatches!.filter(batch=>batch.kind==='local').every(batch=>batch.status==='completed'))
    assert.ok(run.output.planningBatches!.filter(batch=>batch.kind==='cross').every(batch=>batch.status==='pending'))
    assert.equal(run.output.scenarios?.length,5)

    ;({design,run}=fixture());mode='unknown-fact';calls=0
    await assert.rejects(planFromFacts(design,run,config,new AbortController().signal,()=>{},[]),/本批未提供/)
    assert.equal(run.output.scenarios?.length,0)

    ;({design,run}=fixture());mode='success';calls=0
    const controller=new AbortController()
    await assert.rejects(planFromFacts(design,run,config,controller.signal,()=>{
      if(run.output.planningBatches?.[0].status==='completed')controller.abort(new Error('取消规划'))
      controller.signal.throwIfAborted()
    },[]),/取消规划/)
    assert.equal(calls,1)
    assert.equal(run.output.planningBatches?.[0].status,'completed')
    assert.ok(run.output.planningBatches?.some(batch=>batch.status==='pending'))
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
