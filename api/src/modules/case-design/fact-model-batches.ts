import type { DesignRun, FactModel, RequirementFact } from '@quality-ai/contracts/case-design'
import { encodeFactInput } from './fact-input'

export interface FactModelBatch { id:string; factIds:string[]; input:string }
const inputBudget=120000
const factsPerPartition=40

/** 每两个分区共同分析，保证任意两条事实至少出现在同一次请求中，不按关键词猜测关联。 */
export function factModelBatches(run:DesignRun,instructionLength:number):FactModelBatch[]{
  const encode=(facts:RequirementFact[])=>encodeFactInput({...run,output:{...run.output,facts,factModel:undefined}})
  const facts=run.output.facts
  const complete=encode(facts)
  if(complete.length+instructionLength<=inputBudget&&facts.length<=factsPerPartition){
    return [{id:'whole',factIds:facts.map(fact=>fact.id),input:complete}]
  }
  const partitions:RequirementFact[][]=[]
  let current:RequirementFact[]=[]
  for(const fact of facts){
    const proposed=[...current,fact]
    if(proposed.length>factsPerPartition||encode(proposed).length+instructionLength>inputBudget/2){
      if(current.length)partitions.push(current)
      current=[fact]
      if(encode(current).length+instructionLength>inputBudget/2)throw new Error(`事实 ${fact.id} 与问题上下文超过交叉合并的单分区预算；未截断依据，无法完成跨批检查`)
    }else current=proposed
  }
  if(current.length)partitions.push(current)
  if(partitions.length<2)throw new Error('问题上下文超过事实合并预算；未截断材料')
  const batches:FactModelBatch[]=[]
  for(let left=0;left<partitions.length;left++)for(let right=left+1;right<partitions.length;right++){
    const items=[...partitions[left],...partitions[right]]
    const input=encode(items)
    if(input.length+instructionLength>inputBudget)throw new Error('交叉合并请求超过预算；未截断材料')
    batches.push({id:`pair-${left+1}-${right+1}`,factIds:items.map(fact=>fact.id),input})
  }
  return batches
}

/** 只汇总经来源验证的等价分组；任何冲突与等价关系自相矛盾时拒绝产出最终模型。 */
export function combineFactModels(facts:RequirementFact[],models:FactModel[],questionIds:string[]):FactModel{
  const parent=new Map(facts.map(fact=>[fact.id,fact.id]))
  function root(id:string):string{
    const next=parent.get(id)
    if(!next)throw new Error('跨批汇总包含未知原始事实')
    if(next===id)return id
    const result=root(next);parent.set(id,result);return result
  }
  for(const model of models)for(const fact of model.consolidatedFacts){
    const first=root(fact.sourceFactIds[0])
    for(const id of fact.sourceFactIds.slice(1))parent.set(root(id),first)
  }
  const groups=new Map<string,RequirementFact[]>()
  for(const fact of facts){const id=root(fact.id);groups.set(id,[...groups.get(id)??[],fact])}
  const model:FactModel={consolidatedFacts:[],conflicts:[]}
  const finalIdBySource=new Map<string,string>()
  const upstreamQuestions=new Set(questionIds)
  for(const sources of groups.values()){
    const id=`merged-${model.consolidatedFacts.length+1}`
    for(const source of sources)finalIdBySource.set(source.id,id)
    const proposals=models.flatMap(item=>item.consolidatedFacts).filter(item=>item.sourceFactIds.some(source=>sources.some(fact=>fact.id===source)))
    model.consolidatedFacts.push({
      id,sourceFactIds:sources.map(source=>source.id),
      // 等价事实保留首条原始表述；其余原始表述仍保存在原始事实产物中，来源不丢失。
      statement:sources[0].statement,
      kind:[...sources,...proposals].some(source=>source.kind==='unresolved')?'unresolved':[...sources,...proposals].some(source=>source.kind==='inferred')?'inferred':'explicit',
      evidence:[...new Map(sources.flatMap(source=>source.evidence).map(evidence=>[JSON.stringify(evidence),evidence])).values()],
      relatedQuestionIds:[...new Set([...sources,...proposals].flatMap(source=>source.relatedQuestionIds).filter(question=>upstreamQuestions.has(question)))],
    })
  }
  const reserved=new Set(questionIds),seen=new Map<string,FactModel['conflicts'][number]>()
  for(const partial of models)for(const conflict of partial.conflicts){
    const originalIds=conflict.factIds.flatMap(id=>{
      const fact=partial.consolidatedFacts.find(item=>item.id===id)
      if(!fact)throw new Error('跨批冲突关联未知合并事实')
      return fact.sourceFactIds
    })
    const factIds=[...new Set(originalIds.map(id=>finalIdBySource.get(id)!))]
    if(factIds.length!==new Set(conflict.factIds).size)throw new Error('不同批次的等价合并与冲突判断不一致；保留批次产物，需复核后重试，未生成全局模型')
    const signature=JSON.stringify([factIds.slice().sort(),conflict.question])
    const existing=seen.get(signature)
    if(existing){
      existing.evidence=[...new Map([...existing.evidence,...conflict.evidence].map(evidence=>[JSON.stringify(evidence),evidence])).values()]
      continue
    }
    let id=`cross-conflict-${model.conflicts.length+1}`
    while(reserved.has(id))id+='-next'
    reserved.add(id)
    const combined={...conflict,id,factIds}
    seen.set(signature,combined)
    model.conflicts.push(combined)
    for(const fact of model.consolidatedFacts)if(factIds.includes(fact.id))fact.relatedQuestionIds.push(id)
  }
  return model
}
