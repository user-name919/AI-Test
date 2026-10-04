import type { DesignRun } from '@quality-ai/contracts/case-design'
import { encodeFactInput,partitionFactInput } from './fact-input'

export interface ScenarioPlanningBatch {
  id:string
  kind:'whole'|'local'|'cross'
  factIds:string[]
  requiredGroups?:[string[],string[]]
  input:string
}

export function scenarioPlanningBatches(run:DesignRun,instructionLength:number):ScenarioPlanningBatch[]{
  const model=run.output.factModel
  if(!model)throw new Error('缺少已整理的需求事实')
  const encode=(facts:typeof model.consolidatedFacts)=>encodeFactInput({...run,output:{...run.output,factModel:{...model,consolidatedFacts:facts,conflicts:model.conflicts.filter(conflict=>facts.some(fact=>conflict.factIds.includes(fact.id)||fact.relatedQuestionIds.includes(conflict.id)))}}})
  const scope=(kind:ScenarioPlanningBatch['kind'],requiredGroups?:[string[],string[]])=>({kind,requiredGroups})
  // 分区边界也计入scope编码，避免附加字段让原本合规的请求超限。
  const partitions=partitionFactInput(model.consolidatedFacts,facts=>JSON.stringify({...JSON.parse(encode(facts)),planningScope:scope('local')}),instructionLength)
  if(partitions.length===1)return [{id:'whole',kind:'whole',factIds:model.consolidatedFacts.map(fact=>fact.id),input:encode(model.consolidatedFacts)}]
  const batches:ScenarioPlanningBatch[]=[]
  for(const [index,facts] of partitions.entries())batches.push({id:`local-${index+1}`,kind:'local',factIds:facts.map(fact=>fact.id),input:JSON.stringify({...JSON.parse(encode(facts)),planningScope:scope('local')})})
  for(let left=0;left<partitions.length;left++)for(let right=left+1;right<partitions.length;right++){
    const requiredGroups:[string[],string[]]=[partitions[left].map(fact=>fact.id),partitions[right].map(fact=>fact.id)]
    const facts=[...partitions[left],...partitions[right]]
    const input=JSON.stringify({...JSON.parse(encode(facts)),planningScope:scope('cross',requiredGroups)})
    if(input.length+instructionLength>120000)throw new Error('交叉场景上下文超过预算；未截断依据，尚未完成规划')
    batches.push({id:`cross-${left+1}-${right+1}`,kind:'cross',factIds:facts.map(fact=>fact.id),requiredGroups,input})
  }
  return batches
}
