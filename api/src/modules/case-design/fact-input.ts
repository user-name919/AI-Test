import { evidenceRefSchema, factModelSchema, type DesignRun, type FactModel } from '@quality-ai/contracts/case-design'
import { z } from 'zod'

/** 用完整编码后的大小分区，预留另一分区共同出现的空间；不截短事实或依据。 */
export function partitionFactInput<T extends {id:string}>(facts:T[],encode:(facts:T[])=>string,instructionLength:number):T[][]{
  if(encode(facts).length+instructionLength<=120000&&facts.length<=40)return [facts]
  const partitions:T[][]=[]
  let current:T[]=[]
  for(const fact of facts){
    const proposed=[...current,fact]
    if(proposed.length>40||encode(proposed).length+instructionLength>60000){
      if(current.length)partitions.push(current)
      current=[fact]
      if(encode(current).length+instructionLength>60000)throw new Error(`事实 ${fact.id} 与共享问题上下文超过交叉分析的单分区预算；未截断依据`)
    }else current=proposed
  }
  if(current.length)partitions.push(current)
  if(partitions.length<2)throw new Error('共享问题上下文超过事实分析预算；未截断材料')
  return partitions
}

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
