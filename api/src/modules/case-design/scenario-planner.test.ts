import assert from 'node:assert/strict'
import test from 'node:test'
import type { CaseDesign, DesignRun, FactModel } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from './documents'
import { validateFactModel } from './scenario-planner'

function fixture() {
  const documents=createEvidenceDocuments([{fileName:'prd.md',role:'prd',content:'上传限制 10MB'},{fileName:'方案.md',role:'interface',content:'上传限制 20MB'}])
  const facts=documents.map((document,index)=>({id:`f${index+1}`,statement:document.blocks[0].text,kind:'explicit' as const,relatedQuestionIds:[],evidence:[{documentId:document.id,blockId:document.blocks[0].id,quote:document.blocks[0].text}]}))
  const design:CaseDesign={id:'design',name:'冲突',revision:1,inputHash:'hash',documents,createdAt:'now',updatedAt:'now'}
  const run:DesignRun={id:'run',designId:design.id,attempt:1,stage:'modeling',status:'running',inputRevision:1,inputHash:'hash',model:'fixture',modelConfigHash:'hash',protocol:'openai-responses',promptVersion:'test',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts,questions:[],processedBlockIds:[],unprocessedBlockIds:[]}}
  const model:FactModel={consolidatedFacts:facts.map(fact=>({...structuredClone(fact),id:'m'+fact.id,sourceFactIds:[fact.id]})),conflicts:[{id:'q-conflict',factIds:['mf1','mf2'],question:'确认上传限制',evidence:facts.flatMap(fact=>fact.evidence)}]}
  return {design,run,model}
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
