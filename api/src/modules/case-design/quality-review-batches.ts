import type { CaseDesign,DesignRun,EvidenceRef } from '@quality-ai/contracts/case-design'

export interface QualityReviewScope {
  caseIds:string[]; factIds:string[]; scenarioIds:string[]; questionIds:string[]; conflictIds:string[]; blockIds:string[]
}
export interface QualityReviewBatch extends QualityReviewScope {
  id:string; kind:'documents'|'cross'; input:string; evidence:EvidenceRef[]
}
const scopeKeys=['caseIds','factIds','scenarioIds','questionIds','conflictIds','blockIds'] as const
const emptyScope=():QualityReviewScope=>({caseIds:[],factIds:[],scenarioIds:[],questionIds:[],conflictIds:[],blockIds:[]})
function union(scopes:QualityReviewScope[]):QualityReviewScope{
  const result=emptyScope()
  for(const key of scopeKeys)result[key]=[...new Set(scopes.flatMap(scope=>scope[key]))]
  return result
}

export function qualityReviewBatches(design:CaseDesign,run:DesignRun,instructionLength:number):QualityReviewBatch[]{
  const facts=run.output.factModel?.consolidatedFacts??[],conflicts=run.output.factModel?.conflicts??[]
  const cases=run.output.cases??[],scenarios=run.output.scenarios??[],questions=run.output.questions
  const blocks=design.documents.flatMap(document=>document.blocks)
  const full:QualityReviewScope={caseIds:cases.map(item=>item.id),factIds:facts.map(item=>item.id),scenarioIds:scenarios.map(item=>item.id),questionIds:questions.map(item=>item.id),conflictIds:conflicts.map(item=>item.id),blockIds:blocks.map(item=>item.id)}
  function context(scope:QualityReviewScope){
    const targets={case:scope.caseIds,fact:scope.factIds,scenario:scope.scenarioIds,design:[design.id]}
    return {designId:design.id,
      documents:design.documents.map(document=>({...document,blocks:document.blocks.filter(block=>scope.blockIds.includes(block.id))})),
      facts:{consolidatedFacts:facts.filter(item=>scope.factIds.includes(item.id)),conflicts:conflicts.filter(item=>scope.conflictIds.includes(item.id))},
      scenarios:scenarios.filter(item=>scope.scenarioIds.includes(item.id)),cases:cases.filter(item=>scope.caseIds.includes(item.id)),
      questions:questions.filter(item=>scope.questionIds.includes(item.id)),
      ruleIssues:run.output.issues?.filter(issue=>targets[issue.targetType].includes(issue.targetId)),
    }
  }
  const size=(scope:QualityReviewScope)=>JSON.stringify(context(scope)).length+instructionLength
  function batch(scope:QualityReviewScope,id:string,kind:QualityReviewBatch['kind']):QualityReviewBatch{
    const data=context(scope),input=JSON.stringify(data)
    if(input.length+instructionLength>120000)throw new Error(`审查批次 ${id} 超过预算，未截断内容`)
    const evidence=[...data.facts.consolidatedFacts,...data.facts.conflicts,...data.questions,...data.ruleIssues??[]].flatMap(item=>item.evidence)
    return {...scope,id,kind,input,evidence}
  }
  // 全量目标仍能与任一原文块共同提供时，沿用按原文分批，避免不必要的组合调用。
  const base={...full,blockIds:[]}
  if(size(base)<=120000&&blocks.every(block=>size({...base,blockIds:[block.id]})<=120000)){
    const batches:QualityReviewBatch[]=[]
    let blockIds:string[]=[]
    for(const block of blocks){
      if(blockIds.length&&size({...base,blockIds:[...blockIds,block.id]})>120000){
        batches.push(batch({...base,blockIds},`documents-${batches.length+1}`,'documents'));blockIds=[]
      }
      blockIds.push(block.id)
    }
    if(blockIds.length||!batches.length)batches.push(batch({...base,blockIds},`documents-${batches.length+1}`,'documents'))
    return batches
  }

  function related(seed:Partial<QualityReviewScope>):QualityReviewScope{
    const selectedCases=cases.filter(item=>seed.caseIds?.includes(item.id))
    const selectedScenarios=scenarios.filter(item=>seed.scenarioIds?.includes(item.id)||selectedCases.some(testCase=>testCase.scenarioId===item.id))
    const selectedFacts=facts.filter(item=>seed.factIds?.includes(item.id)||[...selectedCases,...selectedScenarios].some(target=>target.factIds.includes(item.id)))
    const questionIds=new Set([...seed.questionIds??[],...selectedCases.flatMap(item=>item.questionIds),...selectedScenarios.flatMap(item=>item.questionIds),...selectedFacts.flatMap(item=>item.relatedQuestionIds)])
    const selectedConflicts=conflicts.filter(item=>seed.conflictIds?.includes(item.id)||questionIds.has(item.id)||selectedFacts.some(fact=>item.factIds.includes(fact.id)))
    return {caseIds:selectedCases.map(item=>item.id),scenarioIds:selectedScenarios.map(item=>item.id),factIds:selectedFacts.map(item=>item.id),questionIds:questions.filter(item=>questionIds.has(item.id)).map(item=>item.id),conflictIds:selectedConflicts.map(item=>item.id),blockIds:seed.blockIds??[]}
  }
  // 用例和直接语义依据不可拆散。原文块独立加入，确保未被抽取的原文也进入审查。
  const units:QualityReviewScope[]=[]
  let covered=emptyScope()
  for(const key of scopeKeys)for(const id of full[key]){
    if(covered[key].includes(id))continue
    const unit=related({[key]:[id]})
    if(size(unit)>60000)throw new Error(`审查单元 ${key}:${id} 及其直接依据超过交叉审查预算，未截断；请复核超大单项，尚未完成审查`)
    units.push(unit);covered=union([covered,unit])
  }
  const partitions:QualityReviewScope[]=[]
  let current=emptyScope()
  for(const unit of units){
    const next=union([current,unit])
    if(size(next)>60000){partitions.push(current);current=unit}else current=next
  }
  if(scopeKeys.some(key=>current[key].length))partitions.push(current)
  const batches:QualityReviewBatch[]=[]
  if(partitions.length===1)return [batch(partitions[0],'cross-1','cross')]
  for(let left=0;left<partitions.length;left++)for(let right=left+1;right<partitions.length;right++){
    batches.push(batch(union([partitions[left],partitions[right]]),`cross-${left+1}-${right+1}`,'cross'))
  }
  if(!batches.length)throw new Error('审查公共上下文超过预算，未截断内容')
  return batches
}
