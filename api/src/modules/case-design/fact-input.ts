import { evidenceRefSchema, factModelSchema, type DesignRun, type FactModel } from '@quality-ai/contracts/case-design'
import { z } from 'zod'

/** 只去重完全相同的证据，不压缩原文或合并语义事实。 */
export function encodeFactInput(run:DesignRun):string{
  const registry=new Map<string,string>()
  const evidenceTable:Array<{id:string;evidence:unknown}>=[]
  function references(evidence:unknown[]){
    return evidence.map(item=>{
      const key=JSON.stringify(item)
      let id=registry.get(key)
      if(!id){id=`evidence-${registry.size+1}`;registry.set(key,id);evidenceTable.push({id,evidence:item})}
      return id
    })
  }
  const facts=(run.stage==='modeling'?run.output.facts:run.output.factModel?.consolidatedFacts)?.map(({evidence,...fact})=>({...fact,evidenceRefs:references(evidence)}))
  const questions=run.output.questions.map(({evidence,...question})=>({...question,evidenceRefs:references(evidence)}))
  const conflicts=run.output.factModel?.conflicts.map(({evidence,...conflict})=>({...conflict,evidenceRefs:references(evidence)}))
  return JSON.stringify({facts,questions,conflicts,evidenceTable,unprocessedBlockIds:run.output.unprocessedBlockIds})
}

const referencedModelSchema=z.object({
  consolidatedFacts:z.array(factModelSchema.shape.consolidatedFacts.element.omit({evidence:true}).extend({evidenceRefs:z.array(z.string())}).strict()),
  conflicts:z.array(factModelSchema.shape.conflicts.element.omit({evidence:true}).extend({evidenceRefs:z.array(z.string()).min(2)}).strict()),
}).strict()
const completeModelSchema=z.object({
  consolidatedFacts:z.array(factModelSchema.shape.consolidatedFacts.element.strict()),
  conflicts:z.array(factModelSchema.shape.conflicts.element.strict()),
}).strict()

export function decodeFactModel(output:unknown,encodedInput:string):FactModel{
  // 兼容已有模型返回的完整依据；后续仍走同样的来源、归组、原文与冲突校验。
  const legacy=completeModelSchema.safeParse(output)
  if(legacy.success)return legacy.data
  const model=referencedModelSchema.parse(output)
  const table=z.object({evidenceTable:z.array(z.object({id:z.string(),evidence:evidenceRefSchema}))}).parse(JSON.parse(encodedInput)).evidenceTable
  const evidenceById=new Map(table.map(item=>[item.id,item.evidence]))
  function restore(ids:string[]){return ids.map(id=>{
    const evidence=evidenceById.get(id)
    if(!evidence)throw new Error(`模型引用未知原文依据：${id}`)
    return structuredClone(evidence)
  })}
  return factModelSchema.parse({
    consolidatedFacts:model.consolidatedFacts.map(({evidenceRefs,...fact})=>({...fact,evidence:restore(evidenceRefs)})),
    conflicts:model.conflicts.map(({evidenceRefs,...conflict})=>({...conflict,evidence:restore(evidenceRefs)})),
  })
}
