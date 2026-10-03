import type { DesignRun } from '@quality-ai/contracts/case-design'

/** 只去重完全相同的证据，不压缩原文或合并语义事实。输出中的evidence仍须还原为完整依据。 */
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
