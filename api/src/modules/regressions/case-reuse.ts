import type { CaseAsset } from '@quality-ai/contracts/cases'
import type { ExecutionResult } from '@quality-ai/contracts'
import type { RegressionAnalysis, RegressionReuse, RegressionReuseCandidate, RegressionReuseSnapshot, RegressionReview } from '@quality-ai/contracts/regressions'
import { database } from '../../storage/database'
import { getCaseAsset, listCaseAssets } from '../cases/repository'
import { getPublishedCaseAsset, listPublishedCaseAssets } from '../cases/published-assets'
import { getRegressionCaseAsset, listRegressionCaseAssets } from '../cases/regression-assets'
import { getRegression } from './jobs'

function sourceId(asset:CaseAsset):string {
  return asset.source.type==='requirement'?asset.source.analysisId:asset.source.type==='case_design'?asset.source.designId:asset.source.regressionId
}

// 词面重合只是找候选的线索，不代表业务等价或自动纳入范围。
function terms(value:string):Set<string> {
  const tokens=value.toLowerCase().match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu)??[]
  return new Set(tokens.flatMap(token=>/\p{Script=Han}/u.test(token)?Array.from({length:token.length-1},(_,index)=>token.slice(index,index+2)):[token]))
}

export function recommendRegressionCases(analysis:RegressionAnalysis, caseKey:string, query='') {
  const suggestion=analysis.generation?.batches.flatMap(batch=>batch.suggestions.cases.map((item,index)=>({key:`${batch.id}:case-${index}`,item}))).find(item=>item.key===caseKey)
  if(!suggestion)throw new Error('请选择本次分析中的回归用例')
  const expected=terms(`${suggestion.item.title} ${suggestion.item.contract.objective} ${suggestion.item.contract.steps.join(' ')} ${suggestion.item.contract.expectedAssertions.join(' ')}`)
  const rows=database.prepare('SELECT id,project_id,result_json FROM executions ORDER BY created_at DESC LIMIT 501').all() as Array<{id:string;project_id:string|null;result_json:string}>
  const projectEvidence=new Map<string,Array<{projectId:string;executionId:string}>>()
  for(const row of rows.slice(0,500)){
    const execution=JSON.parse(row.result_json) as ExecutionResult
    const projectId=row.project_id??execution.sourceProject?.id
    if(!projectId)continue
    for(const snapshot of execution.caseSnapshots??[]){
      const evidence=projectEvidence.get(snapshot.caseId)??[]
      if(!evidence.some(item=>item.projectId===projectId))evidence.push({projectId,executionId:row.id})
      projectEvidence.set(snapshot.caseId,evidence)
    }
  }
  const candidates:RegressionReuseCandidate[]=[]
  for(const asset of [...listCaseAssets(),...listPublishedCaseAssets(),...listRegressionCaseAssets()]){
    if(asset.reviewStatus!=='confirmed'||(asset.source.type==='change_regression'&&asset.source.regressionId===analysis.id))continue
    const searchable=`${asset.title} ${asset.finalContract.objective} ${asset.finalContract.steps.join(' ')} ${asset.finalContract.expectedAssertions.join(' ')}`
    if(query&&!searchable.toLowerCase().includes(query.toLowerCase()))continue
    const evidence=projectEvidence.get(asset.id)??[]
    const direct=asset.source.type==='change_regression'?getRegression(asset.source.regressionId)?.projectId:undefined
    const same=evidence.find(item=>item.projectId===analysis.projectId)
    const projectMatch=direct===analysis.projectId||same?'same':direct||evidence.length?'other':'unknown'
    const matchedTerms=[...terms(searchable)].filter(term=>expected.has(term)).slice(0,20)
    candidates.push({asset,projectMatch,matchedTerms,reasons:[`来源 ${asset.source.type} / ${sourceId(asset)}，已确认版本 v${asset.revision}`,
      direct?`来源回归项目：${direct}`:same?`同项目执行记录：${same.executionId}`:evidence.length?'仅找到其他项目执行记录，需人工核对适用性':'未找到项目关联依据，不推断为同项目',
      matchedTerms.length?`行为文字重合：${matchedTerms.join('、')}；不代表语义等价`:'未发现行为文字重合，仍可人工比较']})
  }
  const rank={same:0,unknown:1,other:2}
  candidates.sort((a,b)=>rank[a.projectMatch]-rank[b.projectMatch]||b.matchedTerms.length-a.matchedTerms.length||a.asset.id.localeCompare(b.asset.id))
  return {candidates:candidates.slice(0,50),total:candidates.length,truncated:candidates.length>50,executionHistoryTruncated:rows.length>500}
}

export function freezeRegressionReuse(analysis:RegressionAnalysis,key:string,reuse:RegressionReuse,history:RegressionReview[]):RegressionReuseSnapshot {
  if(reuse.caseId.startsWith(`regression:${analysis.id}:`))throw new Error('不能复用本次回归自己的历史资产，请保留原审核版本')
  const previous=history.flatMap(review=>review.reusedSources??[]).find(item=>item.key===key&&item.provenance.caseId===reuse.caseId&&item.provenance.revision===reuse.revision&&item.provenance.contractFingerprint===reuse.contractFingerprint)
  // 已经保存过的来源必须继续使用原快照，不能因原资产更新而偷偷升级。
  if(previous)return {...structuredClone(previous),provenance:{...previous.provenance,reason:reuse.reason}}
  const asset=reuse.caseId.startsWith('published:')?getPublishedCaseAsset(reuse.caseId):reuse.caseId.startsWith('regression:')?getRegressionCaseAsset(reuse.caseId):getCaseAsset(reuse.caseId)
  if(!asset||asset.reviewStatus!=='confirmed')throw new Error('复用来源不存在或尚未人工确认')
  if(asset.revision!==reuse.revision||asset.resolved.contractFingerprint!==reuse.contractFingerprint)throw new Error('复用来源版本已变化，请重新比较后选择；未替换当前草稿')
  if(asset.resolved.questionAssociation.questionKeys.some(key=>!asset.resolved.resolvedQuestions.some(question=>question.questionKey===key&&question.finalStatement.trim()&&!question.uncertainties.length)))throw new Error('复用来源仍有未明确的关联问题，请先在来源任务确认，不能通过复用绕过')
  return {key,provenance:{...reuse,title:asset.title,sourceType:asset.source.type,sourceId:sourceId(asset)},contract:structuredClone(asset.finalContract),
    resolvedQuestions:structuredClone(asset.resolved.resolvedQuestions),questionAssociation:structuredClone(asset.resolved.questionAssociation)}
}
