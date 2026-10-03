import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test, { before, after } from 'node:test'
import type { DesignRun, DesignReviewContent } from '@quality-ai/contracts/case-design'

const directory=mkdtempSync(join(tmpdir(),'quality-ai-design-review-'))
process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
const { createApiServer }=await import('./app')
const { database }=await import('./storage/database')
const { createCaseDesign, saveDesignRun, listDesignRuns }=await import('./modules/case-design/repository')
const { publicationBlockers }=await import('./modules/case-design/publisher')
const server=createApiServer()
let url=''
before(async()=> { await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); url=`http://127.0.0.1:${(server.address() as AddressInfo).port}` })
after(async()=> { await new Promise<void>(resolve=>server.close(()=>resolve())); database.close(); rmSync(directory,{recursive:true,force:true}) })
const post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})

test('人工审核历史与AI产物隔离，过期编辑拒绝并返回最新版本',async()=> {
  const design=createCaseDesign('合成审核',[])
  const contract={objective:'AI原始目标',preconditions:[],steps:['搜索'],expectedAssertions:['显示匹配项'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}
  const run:DesignRun={id:'check-1',designId:design.id,attempt:1,stage:'checking',status:'completed',inputRevision:design.revision,inputHash:design.inputHash,model:'fixture',modelConfigHash:'hash',protocol:'fixture',promptVersion:'fixture',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[{id:'q1',question:'大小写规则？',evidence:[]}],processedBlockIds:[],unprocessedBlockIds:[],factModel:{consolidatedFacts:[{id:'f1',statement:'搜索',kind:'inferred',evidence:[],relatedQuestionIds:['q1'],sourceFactIds:['raw']}],conflicts:[]},cases:[{id:'c1',title:'搜索',scenarioId:'s1',factIds:['f1'],questionIds:['q1'],contract,verification:'browser',verificationReason:'观察页面',requiresReview:true}],issues:[{id:'i1',targetType:'case',targetId:'c1',kind:'unverifiable',severity:'blocking',reason:'需确认',evidence:[],checkedBy:'rule'}],modelReviewCompleted:true}}
  saveDesignRun(run)
  const content:DesignReviewContent={cases:{c1:{title:'人工标题',contract:{...contract,objective:'人工最终目标'},verification:'browser',verificationReason:'输入与列表可观察',status:'confirmed'}},questionDecisions:{q1:'按原文大小写匹配'},issueDecisions:{i1:{status:'addressed',reason:'已将规则写入最终口径'}},excludedFacts:{}}
  const path=`/api/case-designs/${design.id}/reviews`
  const publishPath=`/api/case-designs/${design.id}/publish`
  assert.equal((await post(publishPath,{expectedRevision:1})).status,409)
  const first=await post(path,{runId:run.id,expectedRevision:0,review:content})
  assert.equal(first.status,201)
  assert.equal((await first.json()).review.revision,1)
  const released=await post(publishPath,{expectedRevision:1})
  assert.equal(released.status,201)
  const publication=(await released.json()).publication
  assert.equal(publication.snapshot.cases[0].contract.objective,'人工最终目标')
  assert.equal(publication.snapshot.run.output.cases[0].contract.objective,'AI原始目标')
  assert.match(publication.contentHash,/^[a-f0-9]{64}$/)
  const snapshot=publication.snapshot
  for (const mutate of [
    (copy: typeof snapshot) => { copy.review.content.questionDecisions={} },
    (copy: typeof snapshot) => { copy.review.content.issueDecisions={} },
    (copy: typeof snapshot) => { copy.review.content.cases.c1.status='draft' },
    (copy: typeof snapshot) => { copy.review.content.cases.c1.contract.uncertainties=['尚待确认'] },
    (copy: typeof snapshot) => { copy.run.output.unprocessedBlockIds=['missing'] },
    (copy: typeof snapshot) => { copy.review.content.excludedFacts={f1:'不覆盖'} },
    (copy: typeof snapshot) => { copy.run.output.factModel.consolidatedFacts[0].kind='explicit' },
  ]) {
    const copy=structuredClone(snapshot); mutate(copy)
    assert.ok(publicationBlockers(copy.design,copy.run,copy.review).length>0)
  }
  assert.equal((await (await post(publishPath,{expectedRevision:1})).json()).publication.id,publication.id)
  const publicationPath=`/api/case-designs/${design.id}/publications/${publication.id}`
  const markdown=await (await fetch(url+publicationPath+'/markdown')).text()
  assert.match(markdown,/人工最终目标/)
  assert.equal(markdown.includes('AI原始目标'),false)
  assert.match(markdown,/按原文大小写匹配/)
  const conflict=await post(path,{runId:run.id,expectedRevision:0,review:content})
  assert.equal(conflict.status,409)
  assert.equal((await conflict.json()).review.content.cases.c1.contract.objective,'人工最终目标')
  content.cases.c1.contract.objective='第二版人工目标'
  assert.equal((await post(path,{runId:run.id,expectedRevision:1,review:content})).status,201)
  assert.equal((await post(publishPath,{expectedRevision:1})).status,409)
  assert.deepEqual((await (await fetch(url+publicationPath)).json()).publication,publication)
  assert.equal(await (await fetch(url+publicationPath+'/markdown')).text(),markdown)
  const nextPublication=(await (await post(publishPath,{expectedRevision:2})).json()).publication
  assert.equal(nextPublication.version,2)
  assert.equal(nextPublication.snapshot.cases[0].contract.objective,'第二版人工目标')
  const history=(await (await fetch(url+path)).json()).reviews
  assert.deepEqual(history.map((item:{revision:number})=>item.revision),[2,1])
  assert.equal(history[1].content.cases.c1.contract.objective,'人工最终目标')
  assert.equal(listDesignRuns(design.id)[0].output.cases![0].contract.objective,'AI原始目标')
  saveDesignRun({...run,id:'check-2',attempt:2})
  assert.deepEqual((await (await fetch(url+path)).json()).reviews,history)
  content.cases.c1.status='excluded'
  assert.equal((await post(path,{runId:run.id,expectedRevision:2,review:content})).status,400)
  content.cases.c1.exclusionReason='本轮不覆盖，后续人工测试'
  assert.equal((await post(path,{runId:run.id,expectedRevision:2,review:content})).status,201)
  assert.equal((await post(publishPath,{expectedRevision:3})).status,409)
  content.questionDecisions.foreign='别的任务的问题'
  assert.equal((await post(path,{runId:run.id,expectedRevision:3,review:content})).status,400)
  delete content.questionDecisions.foreign
  saveDesignRun({...run,id:'unfinished',status:'failed',output:{...run.output,modelReviewCompleted:false}})
  assert.equal((await post(path,{runId:'unfinished',expectedRevision:3,review:content})).status,400)
  saveDesignRun({...run,id:'stale',inputHash:'old-input'})
  assert.equal((await post(path,{runId:'stale',expectedRevision:3,review:content})).status,400)
})
