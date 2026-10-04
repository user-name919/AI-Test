import { createHash } from 'node:crypto'
import type { CaseAsset } from '@quality-ai/contracts/cases'
import type { DesignPublication } from '@quality-ai/contracts/case-design'
import { database } from '../../storage/database'
import { containsUnprovenDataLiteral } from '../../review-execution-context'

function assets(publication:DesignPublication):CaseAsset[]{
  return publication.snapshot.cases.map((item,index)=>{
    const original=publication.snapshot.run.output.cases?.find(candidate=>candidate.id===item.id)
    if(!original)throw new Error('发布产物缺少原始建议，不能构造可追溯用例资产')
    const id=`published:${publication.id}:${item.id}`
    const contract=structuredClone(item.contract)
    const reason=item.verification!=='browser'?`该用例要求${item.verification==='api'?'接口':'人工'}验证，当前浏览器执行器不支持`:contract.uncertainties.length?'用例仍有未确定事项':containsUnprovenDataLiteral(contract)?'用例需要确认测试数据':undefined
    const questionAssociation={mode:'explicit' as const,questionKeys:[...item.questionIds]}
    const resolvedQuestions=item.questionIds.map(questionKey=>({questionKey,questionTitle:[...publication.snapshot.run.output.questions,...publication.snapshot.run.output.factModel?.conflicts??[]].find(question=>question.id===questionKey)?.question??questionKey,finalStatement:publication.snapshot.review.content.questionDecisions[questionKey]??'',triggers:[],behaviors:[],assertions:[],forbiddenBehaviors:[],sourceHints:[],uncertainties:[]}))
    const missingDecision=resolvedQuestions.some(question=>!question.finalStatement)
    const agent=reason||missingDecision?{executable:false,reason:reason??'关联问题未决定'}:{executable:true}
    const plan=agent
    const resolved={caseKey:id,requirementIndex:-1,caseIndex:index,title:item.title,contract,questionAssociation,resolvedQuestions,readiness:{agent,plan},contractFingerprint:createHash('sha256').update(JSON.stringify({publicationHash:publication.contentHash,caseId:item.id,contract,questionAssociation,resolvedQuestions})).digest('hex')}
    return {id,title:item.title,source:{type:'case_design',designId:publication.designId,draftId:item.id,publicationId:publication.id,publicationVersion:publication.version},revision:publication.version,reviewStatus:'confirmed',verification:item.verification,originalSuggestion:structuredClone(original.contract),finalContract:contract,resolved,createdAt:publication.createdAt,updatedAt:publication.createdAt}
  })
}

export function listPublishedCaseAssets(designId?:string):CaseAsset[]{
  const rows=(designId?database.prepare('SELECT publication_json FROM case_design_publications WHERE design_id=? ORDER BY version DESC LIMIT 1').all(designId):database.prepare('SELECT p.publication_json FROM case_design_publications p WHERE p.version=(SELECT MAX(latest.version) FROM case_design_publications latest WHERE latest.design_id=p.design_id)').all()) as Array<{publication_json:string}>
  return rows.flatMap(row=>assets(JSON.parse(row.publication_json)))
}

export function getPublishedCaseAsset(id:string):CaseAsset|null{
  const match=id.match(/^published:([^:]+):([^:]+)$/)
  if(!match)return null
  const row=database.prepare('SELECT publication_json FROM case_design_publications WHERE id=?').get(match[1]) as {publication_json:string}|undefined
  return row?assets(JSON.parse(row.publication_json)).find(item=>item.id===id)??null:null
}
