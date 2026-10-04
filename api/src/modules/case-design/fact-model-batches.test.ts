import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaseDesign, DesignRun, FactModel } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from './documents'
import { factModelBatches,combineFactModels } from './fact-model-batches'
import { planFromFacts,validateFactModel } from './scenario-planner'
import { getModelConfig } from '../../model-config'

function fixture(){
  const documents=createEvidenceDocuments(Array.from({length:6},(_,index)=>({fileName:`章节${index}.md`,role:'prd' as const,content:`章节${index}：`+String(index).repeat(23000)})))
  const facts=documents.map((document,index)=>({id:`f${index}`,statement:index===2?'规则0':`规则${index}`,kind:'explicit' as const,relatedQuestionIds:[],evidence:document.blocks.map(block=>({documentId:document.id,blockId:block.id,quote:block.text}))}))
  const design:CaseDesign={id:'design',name:'跨章节',revision:1,inputHash:'fixture',documents,createdAt:'now',updatedAt:'now'}
  const run:DesignRun={id:'run',designId:design.id,stage:'modeling',attempt:1,status:'running',inputRevision:1,inputHash:'fixture',model:'fixture',protocol:'openai-responses',modelConfigHash:'fixture',promptVersion:'fixture',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts,questions:[],processedBlockIds:documents.flatMap(document=>document.blocks.map(block=>block.id)),unprocessedBlockIds:[]}}
  return {design,run}
}
type ReferencedFact={id:string;statement:string;kind:string;relatedQuestionIds:string[];evidenceRefs:string[]}
function responseModel(facts:ReferencedFact[]){
  const groups=new Map<string,ReferencedFact[]>()
  for(const fact of facts){const key=fact.id==='f2'?'f0':fact.id;groups.set(key,[...groups.get(key)??[],fact])}
  const consolidatedFacts=[...groups.values()].map((items,index)=>({id:`m${index}`,statement:items[0].statement,kind:items[0].kind,sourceFactIds:items.map(item=>item.id),relatedQuestionIds:[],evidenceRefs:items.flatMap(item=>item.evidenceRefs)}))
  const left=consolidatedFacts.find(item=>item.sourceFactIds.some(id=>id==='f0'||id==='f2'))
  const right=consolidatedFacts.find(item=>item.sourceFactIds.includes('f4'))
  const conflicts=left&&right?[{id:'conflict',factIds:[left.id,right.id],question:'章节间规则有冲突，请确认',evidenceRefs:[...left.evidenceRefs,...right.evidenceRefs]}]:[]
  return {consolidatedFacts,conflicts}
}

test('大事实按完整依据分区，任意两条事实共现且每次请求含提示不超预算',()=>{
  const {run}=fixture()
  const before=structuredClone(run)
  const batches=factModelBatches(run,2000)
  assert.equal(batches.length,3)
  for(const batch of batches)assert.ok(batch.input.length+2000<=120000)
  for(const left of run.output.facts)for(const right of run.output.facts)assert.ok(batches.some(batch=>batch.factIds.includes(left.id)&&batch.factIds.includes(right.id)))
  for(const batch of batches){
    const data=JSON.parse(batch.input)
    for(const fact of data.facts as ReferencedFact[]){
      assert.deepEqual(fact.evidenceRefs.map(id=>data.evidenceTable.find((entry:{id:string})=>entry.id===id).evidence),run.output.facts.find(item=>item.id===fact.id)!.evidence)
    }
  }
  assert.deepEqual(run,before)
  run.output.facts[0].evidence[0].quote='超大原文'.repeat(20000)
  assert.throws(()=>factModelBatches(run,2000),/未截断依据/)
})

test('跨批模型请求合并等价事实、保存交叉冲突，失败和取消不发布局部模型',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-fact-batches-'))
  process.env.QUALITY_AI_DATABASE_PATH=join(directory,'state.sqlite')
  const {database}=await import('../../storage/database')
  const {createCaseDesign,saveDesignRun,listDesignRuns,recoverInterruptedDesignRuns}=await import('./repository')
  let mode:'success'|'invalid'='success',calls=0
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const raw=body.input[0].content.split('\n\nReturn only a valid json object.')[0]
    assert.ok(raw.length+body.instructions.length<=120000)
    calls++
    const model=responseModel(JSON.parse(raw).facts)
    if(mode==='invalid'&&calls===2)model.consolidatedFacts.pop()
    response.setHeader('content-type','application/json')
    response.end(JSON.stringify({output_text:JSON.stringify(model)}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}`,protocol:'openai-responses'})
  try{
    let {design,run}=fixture()
    const checkpoints:DesignRun['output'][]=[]
    await planFromFacts(design,run,config,new AbortController().signal,()=>checkpoints.push(structuredClone(run.output)),[])
    assert.equal(calls,3)
    assert.equal(run.output.modelingBatches?.filter(batch=>batch.status==='completed').length,3)
    const model=run.output.factModel!
    assert.equal(model.consolidatedFacts.length,5)
    assert.deepEqual(model.consolidatedFacts[0].sourceFactIds,['f0','f2'])
    assert.equal(model.consolidatedFacts[0].evidence.length,4)
    assert.equal(model.conflicts.length,1)
    assert.equal(model.conflicts[0].evidence.length,6,'相同跨批冲突仍保留不同原始依据')
    assert.ok(model.consolidatedFacts[0].relatedQuestionIds.includes(model.conflicts[0].id))
    validateFactModel(model,design,run)
    assert.ok(checkpoints.some(output=>output.modelingBatches?.filter(batch=>batch.status==='completed').length===1&&!output.factModel))
    assert.equal(checkpoints.at(-1)?.factModel?.consolidatedFacts.length,5)

    ;({design,run}=fixture());calls=0;mode='invalid'
    await assert.rejects(planFromFacts(design,run,config,new AbortController().signal,()=>{},[]),/遗漏原始事实/)
    assert.equal(run.output.factModel,undefined)
    assert.deepEqual(run.output.modelingBatches?.map(batch=>batch.status),['completed','pending','pending'])
    assert.ok(run.output.modelingBatches?.[0].model)

    ;({design,run}=fixture());calls=0;mode='success'
    const saved=createCaseDesign(design.name,design.documents)
    run.designId=saved.id
    const controller=new AbortController()
    await assert.rejects(planFromFacts(design,run,config,controller.signal,()=>{
      saveDesignRun(run)
      if(run.output.modelingBatches?.[0].status==='completed')controller.abort(new Error('用户取消'))
      controller.signal.throwIfAborted()
    },[]),/用户取消/)
    assert.equal(calls,1)
    assert.equal(run.output.factModel,undefined)
    assert.equal(run.output.modelingBatches?.[0].status,'completed')
    assert.equal(recoverInterruptedDesignRuns(),1)
    const recovered=listDesignRuns(saved.id)[0]
    assert.equal(recovered.status,'interrupted')
    assert.equal(recovered.output.factModel,undefined)
    assert.deepEqual(recovered.output.modelingBatches,run.output.modelingBatches)
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));database.close();rmSync(directory,{recursive:true,force:true})}
})

test('跨批等价传递不能吞掉任一冲突方，包括三方冲突',()=>{
  const {run}=fixture()
  const individual:FactModel={consolidatedFacts:run.output.facts.map(fact=>({...fact,sourceFactIds:[fact.id]})),conflicts:[{id:'conflict',factIds:['f0','f1','f2'],question:'三方冲突',evidence:run.output.facts.slice(0,3).flatMap(fact=>fact.evidence)}]}
  const equivalent:FactModel={consolidatedFacts:[{...run.output.facts[0],sourceFactIds:['f0','f1'],evidence:run.output.facts.slice(0,2).flatMap(fact=>fact.evidence)}],conflicts:[]}
  assert.throws(()=>combineFactModels(run.output.facts,[individual,equivalent],[]),/等价合并与冲突判断不一致/)
})
