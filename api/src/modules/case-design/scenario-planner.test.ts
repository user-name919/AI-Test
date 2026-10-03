import assert from 'node:assert/strict'
import test from 'node:test'
import type { CaseDesign, DesignRun, FactModel } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from './documents'
import { validateFactModel, planFromFacts } from './scenario-planner'
import { encodeFactInput,decodeFactModel } from './fact-input'
import { createServer } from 'node:http'
import { getModelConfig } from '../../model-config'

function fixture() {
  const documents=createEvidenceDocuments([{fileName:'prd.md',role:'prd',content:'上传限制 10MB'},{fileName:'方案.md',role:'interface',content:'上传限制 20MB'}])
  const facts=documents.map((document,index)=>({id:`f${index+1}`,statement:document.blocks[0].text,kind:'explicit' as const,relatedQuestionIds:[],evidence:[{documentId:document.id,blockId:document.blocks[0].id,quote:document.blocks[0].text}]}))
  const design:CaseDesign={id:'design',name:'冲突',revision:1,inputHash:'hash',documents,createdAt:'now',updatedAt:'now'}
  const run:DesignRun={id:'run',designId:design.id,attempt:1,stage:'modeling',status:'running',inputRevision:1,inputHash:'hash',model:'fixture',modelConfigHash:'hash',protocol:'openai-responses',promptVersion:'test',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts,questions:[],processedBlockIds:[],unprocessedBlockIds:[]}}
  const model:FactModel={consolidatedFacts:facts.map(fact=>({...structuredClone(fact),id:'m'+fact.id,sourceFactIds:[fact.id]})),conflicts:[{id:'q-conflict',factIds:['mf1','mf2'],question:'确认上传限制',evidence:facts.flatMap(fact=>fact.evidence)}]}
  return {design,run,model}
}
function referenceModel(model:FactModel){
  return {
    consolidatedFacts:model.consolidatedFacts.map((fact,index)=>({id:fact.id,sourceFactIds:fact.sourceFactIds,statement:fact.statement,kind:fact.kind,relatedQuestionIds:fact.relatedQuestionIds,evidenceRefs:[`evidence-${index+1}`]})),
    conflicts:model.conflicts.map(conflict=>({id:conflict.id,factIds:conflict.factIds,question:conflict.question,evidenceRefs:['evidence-1','evidence-2']})),
  }
}
test('cross-document conflicts preserve both sides and become explicit question dependencies',()=> {
  const {design,run,model}=fixture()
  validateFactModel(model,design,run)
  assert.deepEqual(model.consolidatedFacts.map(fact=>fact.relatedQuestionIds),[['q-conflict'],['q-conflict']])
  assert.equal(run.output.facts[0].relatedQuestionIds.length,0)
})
test('fact merge rejects missing provenance, inferred upgrades and missing conflict sides',()=> {
  let current=fixture()
  current.model.consolidatedFacts[0].evidence=[]
  assert.throws(()=>validateFactModel(current.model,current.design,current.run),/丢失原始依据/)
  current=fixture()
  current.run.output.facts[0].kind='inferred'
  assert.throws(()=>validateFactModel(current.model,current.design,current.run),/升级为明文/)
  current=fixture()
  current.model.conflicts[0].evidence=[current.model.conflicts[0].evidence[0]]
  assert.throws(()=>validateFactModel(current.model,current.design,current.run),/缺少其中一方依据/)
})

test('证据重复引用无损去重，保留不同块及所有独立事实',()=>{
  const {run}=fixture()
  const evidence={...run.output.facts[0].evidence[0],quote:'原文'.repeat(2000)}
  run.output.facts=Array.from({length:40},(_,index)=>({...run.output.facts[0],id:`f${index}`,statement:`规则${index}`,evidence:[{...evidence}]}))
  run.output.facts.push({...run.output.facts[0],id:'different-block',evidence:[{...evidence,blockId:'different'}]})
  const before=structuredClone(run)
  const encoded=encodeFactInput(run)
  assert.ok(JSON.stringify(run.output.facts).length>120000)
  assert.ok(encoded.length<20000)
  const input=JSON.parse(encoded)
  assert.equal(input.facts.length,41)
  assert.equal(input.evidenceTable.length,2,'相同文字不同来源块不能合并')
  for(let index=0;index<input.facts.length;index++){
    const refs=input.facts[index].evidenceRefs as string[]
    const decoded=refs.map(id=>input.evidenceTable.find((item:{id:string})=>item.id===id).evidence)
    assert.deepEqual(decoded,run.output.facts[index].evidence)
  }
  assert.deepEqual(run,before,'编码不改变持久事实')
})

test('引用输出还原原文并拒绝未知依据，遗漏仍被来源校验拒绝',()=>{
  const {design,run,model}=fixture()
  const input=encodeFactInput(run)
  const referenced=referenceModel(model)
  const restored=decodeFactModel(referenced,input)
  assert.deepEqual(restored,model)
  validateFactModel(restored,design,run)
  const invalid=structuredClone(referenced)
  invalid.consolidatedFacts[0].evidenceRefs=['unknown']
  assert.throws(()=>decodeFactModel(invalid,input),/未知原文依据/)
  invalid.consolidatedFacts[0].evidenceRefs=[]
  assert.throws(()=>validateFactModel(decodeFactModel(invalid,input),design,run),/丢失原始依据/)
  assert.deepEqual(decodeFactModel(model,input),model,'兼容完整原文输出，不改变原证据')
  assert.throws(()=>decodeFactModel({...model,consolidatedFacts:model.consolidatedFacts.map(fact=>({...fact,evidenceRefs:['unknown']}))},input),'拒绝同时提供矛盾的完整依据与引用')
})

test('合并与规划请求使用证据表，输出仍校验完整原文及冲突双方',async()=>{
  const {design,run,model}=fixture()
  let calls=0
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const input=JSON.parse(body.input[0].content.split('\n\nReturn only a valid json object.')[0])
    assert.equal(input.evidenceTable.length,2)
    assert.ok(input.facts.every((fact:{evidenceRefs:string[]})=>fact.evidenceRefs.length))
    assert.match(body.instructions,/无损证据引用/)
    calls++
    response.setHeader('content-type','application/json')
    const referenced=referenceModel(model)
    response.end(JSON.stringify({output_text:JSON.stringify(calls===1?referenced:{scenarios:[{id:'s1',factIds:['mf1','mf2'],questionIds:[],title:'核对上传限制',testIntent:'确认冲突后验证',coverage:'boundary'}]})}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}`,protocol:'openai-responses'})
  try{
    await planFromFacts(design,run,config,new AbortController().signal,()=>{},[])
    assert.deepEqual(run.output.factModel?.consolidatedFacts[0].evidence,run.output.facts[0].evidence)
    run.stage='planning'
    await planFromFacts(design,run,config,new AbortController().signal,()=>{},[])
    assert.equal(run.output.scenarios?.[0].requiresReview,true)
    assert.deepEqual(run.output.scenarios?.[0].questionIds,['q-conflict'])
    assert.deepEqual(run.output.uncoveredFactIds,[])
    assert.equal(run.statistics.calls,2)
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
