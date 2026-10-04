import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { CaseAsset } from '@quality-ai/contracts/cases'
import type { RegressionAnalysis, RegressionReview } from '@quality-ai/contracts/regressions'

const directory=mkdtempSync(join(tmpdir(),'quality-ai-case-reuse-'))
process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
const {database}=await import('./storage/database')
const {createApiServer}=await import('./app')
const {saveAnalysis}=await import('./modules/requirements/repository')
const {listCaseAssets,saveCaseAssetReview,getCaseAsset}=await import('./modules/cases/repository')
const {saveRegressionReview,getRegressionReviews}=await import('./modules/regressions/review')
const {listRegressionCaseAssets,getRegressionCaseAsset}=await import('./modules/cases/regression-assets')
const {getPublishedCaseAsset}=await import('./modules/cases/published-assets')
const {saveEnvironment}=await import('./modules/projects/environment-repository')
const {saveDeploymentConfirmation}=await import('./modules/regressions/deployments')
const {prepareAssetExecution}=await import('./modules/cases/execution-preparation')
const {saveExecution}=await import('./modules/executions/repository')
const {executionMarkdown}=await import('./modules/executions/report')
const contract={objective:'搜索验证',preconditions:[],steps:['打开列表'],expectedAssertions:['显示候选'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}

function analysis(projectId='fixture'):RegressionAnalysis{
  const value:RegressionAnalysis={id:randomUUID(),projectId,changeSetId:randomUUID(),factsHash:'a'.repeat(64),targetSha:'b'.repeat(40),status:'completed',stage:'finished',createdAt:'now',updatedAt:'now',generation:{promptVersion:'test',model:'test',reviewStatus:'pending',pendingEvidenceIds:[],omittedEvidenceIds:[],limitations:[],batches:[{id:'batch',inputHash:'h',evidence:[],suggestions:{risks:[{id:'risk',title:'搜索风险',reason:'搜索行为改变',severity:'medium',confidence:'low',evidenceIds:['e1']}],cases:[{title:'搜索用例',riskIds:['risk'],verification:'browser',verificationReason:'可观察页面',contract}],limitations:[]}}]}}
  database.prepare('INSERT INTO regression_analyses (id,request_id,record_json) VALUES (?,?,?)').run(value.id,randomUUID(),JSON.stringify(value))
  return value
}
const content:RegressionReview['content']={status:'confirmed',scopeNote:'人工确认搜索范围',risks:[{key:'batch:risk',decision:'include',reason:''}],cases:[{key:'batch:case-0',decision:'include',title:'搜索用例',verification:'browser',verificationReason:'可观察页面',finalContract:contract}]}
function reuseContent(asset:CaseAsset):RegressionReview['content']{
  return {...structuredClone(content),cases:[{key:'batch:case-0',decision:'include',title:'本次人工标题',verification:'browser',verificationReason:'人工核对可观察',finalContract:{...contract,steps:['本次人工最终操作']},reuse:{caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint,reason:'验证当前搜索风险'}}]}
}

test('候选有项目依据，人工复用冻结版本且统一执行不追读新资产',async()=>{
  const server=createApiServer()
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try{
    saveAnalysis({id:'requirement',fileName:'fixture.md',fileNames:['fixture.md'],sourceText:'合成',provider:'test',model:'test',createdAt:'now',result:{versionName:'合成',productName:'测试',overview:'测试',requirements:[{title:'搜索',summary:'搜索',risk:'高风险',riskReason:'数据',businessRules:[],pageStates:[],questions:[],testCases:[{title:'搜索候选',type:'主流程',priority:'P0',preconditions:[],steps:['打开列表'],expectedResult:'显示候选',blockedByQuestion:false}]}]}})
    const initial=listCaseAssets('requirement')[0]!
    const current=analysis()
    let response=await fetch(`${url}/api/regressions/${current.id}/reuse-candidates?caseKey=batch:case-0`)
    assert.equal(response.status,200)
    assert.equal((await response.json()).candidates.length,0,'未确认资产不进入候选')
    saveCaseAssetReview(initial.id,initial.revision,{status:'confirmed',finalContract:contract})
    const source=getCaseAsset(initial.id)!
    const same=analysis();saveRegressionReview(same.id,{expectedRevision:0,content})
    const other=analysis('other');saveRegressionReview(other.id,{expectedRevision:0,content})
    const candidatesUrl=`${url}/api/regressions/${current.id}/reuse-candidates?caseKey=batch:case-0`
    const before=await (await fetch(candidatesUrl)).json()
    assert.equal(before.candidates.find((item:{asset:CaseAsset})=>item.asset.id===source.id).projectMatch,'unknown')
    assert.equal(before.candidates[0].projectMatch,'same')
    assert.equal(before.candidates.at(-1).projectMatch,'other')
    saveExecution({id:randomUUID(),name:'合成历史',status:'failed',targetUrl:'http://example.test/',startedAt:'now',finishedAt:'now',durationMs:0,steps:[],screenshots:[],caseSnapshots:[{caseId:source.id,revision:source.revision,source:source.source,capturedAt:'now',resolved:source.resolved}]},{projectId:'fixture'})
    const found=await (await fetch(candidatesUrl)).json()
    assert.equal(found.candidates.find((item:{asset:CaseAsset})=>item.asset.id===source.id).projectMatch,'same')
    assert.equal((await (await fetch(`${candidatesUrl}&query=不存在的词`)).json()).total,0)
    assert.equal((await fetch(`${url}/api/regressions/${current.id}/reuse-candidates?caseKey=unknown`)).status,409)
    const request=reuseContent(source)
    const patch=(body:unknown)=>fetch(`${url}/api/regressions/${current.id}/review`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    response=await patch({expectedRevision:0,content:request,reusedSources:[{contract:{steps:['伪造']}}]})
    assert.equal(response.status,409,'不接受客户端来源快照')
    response=await patch({expectedRevision:0,content:request})
    assert.equal(response.status,200)
    const first=(await response.json()).review as RegressionReview
    assert.deepEqual(first.reusedSources?.[0]?.contract.steps,['打开列表'])
    const asset=listRegressionCaseAssets(current.id)[0]!
    assert.deepEqual(asset.originalSuggestion.steps,['打开列表'])
    assert.deepEqual(asset.finalContract.steps,['本次人工最终操作'])
    assert.equal(asset.source.type==='change_regression'&&asset.source.reusedFrom?.caseId,source.id)
    saveCaseAssetReview(source.id,source.revision,{status:'confirmed',finalContract:{...contract,steps:['来源后续改动']}})
    const another=analysis()
    assert.throws(()=>saveRegressionReview(another.id,{expectedRevision:0,content:request}),/来源版本已变化/)
    assert.equal(getRegressionReviews(another.id).length,0)
    assert.deepEqual(getRegressionCaseAsset(asset.id),asset)
    const second=saveRegressionReview(current.id,{expectedRevision:1,content:{...request,scopeNote:'继续使用已冻结来源'}})
    assert.deepEqual(second.reusedSources,first.reusedSources,'后续保存不追读变化的来源')
    assert.deepEqual(getRegressionReviews(current.id)[1],first)
    const self=reuseContent(asset)
    assert.throws(()=>saveRegressionReview(current.id,{expectedRevision:2,content:self}),/不能复用本次回归自己/)
    const environment=saveEnvironment({name:'合成环境',baseUrl:'http://example.test',targetUrl:'http://example.test/'})
    const deployment=saveDeploymentConfirmation(current.id,{reviewRevision:1,environmentId:environment.id,targetUrl:environment.targetUrl,deployedSha:current.targetSha,confirmedBy:'合成审核人',note:'本地夹具版本登记'})
    const preparations=(['agent','plan'] as const).map(mode=>prepareAssetExecution({mode,targetUrl:environment.targetUrl,environmentId:environment.id,deploymentConfirmationId:deployment.id,cases:[{caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint}]}))
    assert.deepEqual(preparations[0]!.snapshots[0]!.resolved,preparations[1]!.snapshots[0]!.resolved)
    assert.deepEqual(preparations[0]!.snapshots[0]!.resolved.contract.steps,['本次人工最终操作'])
    const report=executionMarkdown({id:'report',name:'复用回归',status:'blocked',startedAt:'now',finishedAt:'now',durationMs:0,targetUrl:environment.targetUrl,steps:[],screenshots:[],caseKeys:[asset.id],caseSnapshots:preparations[0]!.snapshots,caseResults:[{caseKey:asset.id,title:asset.title,status:'blocked',contractFingerprint:asset.resolved.contractFingerprint,startedFromUrl:'',continuation:'not_started',resolvedDataBindings:[],passedAssertions:[],trajectory:[],steps:[],screenshots:[]}]},[])
    assert.match(report,/复用来源：/);assert.ok(report.includes(source.id));assert.match(report,/本次人工最终操作/);assert.doesNotMatch(report,/来源后续改动/)
    // 已发布设计也是独立来源；保留其人工问题口径，不降级为纯文本副本。
    const publicationId=randomUUID()
    database.prepare('INSERT INTO case_design_publications (id,design_id,version,review_id,publication_json) VALUES (?,?,?,?,?)').run(publicationId,'design',1,'review',JSON.stringify({id:publicationId,designId:'design',version:1,contentHash:'hash',createdAt:'now',snapshot:{cases:[{id:'c1',title:'已发布搜索',contract,questionIds:['q1'],verification:'manual'}],run:{output:{cases:[{id:'c1',contract}],questions:[{id:'q1',question:'范围是什么'}]}},review:{content:{questionDecisions:{q1:'人工限定列表'}}}}}))
    const published=getPublishedCaseAsset(`published:${publicationId}:c1`)!
    assert.equal(published.verification,'manual')
    const publishedReview=saveRegressionReview(another.id,{expectedRevision:0,content:reuseContent(published)})
    assert.equal(publishedReview.reusedSources?.[0]?.resolvedQuestions[0]?.finalStatement,'人工限定列表')
    assert.equal(listRegressionCaseAssets(another.id)[0]!.resolved.resolvedQuestions[0]?.finalStatement,'人工限定列表')
    const oldRegression=listRegressionCaseAssets(same.id)[0]!
    const regressionReuse=saveRegressionReview(another.id,{expectedRevision:1,content:reuseContent(oldRegression)})
    assert.equal(regressionReuse.reusedSources?.[0]?.provenance.sourceType,'change_regression')
    const stored=database.prepare('SELECT publication_json FROM case_design_publications WHERE id=?').get(publicationId) as {publication_json:string}
    const unresolved=JSON.parse(stored.publication_json)
    unresolved.id=randomUUID();unresolved.designId='unresolved';unresolved.snapshot.review.content.questionDecisions={}
    database.prepare('INSERT INTO case_design_publications (id,design_id,version,review_id,publication_json) VALUES (?,?,?,?,?)').run(unresolved.id,unresolved.designId,1,'unresolved-review',JSON.stringify(unresolved))
    assert.throws(()=>saveRegressionReview(another.id,{expectedRevision:2,content:reuseContent(getPublishedCaseAsset(`published:${unresolved.id}:c1`)!)}),/关联问题/)
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    database.close();rmSync(directory,{recursive:true,force:true})
  }
})
