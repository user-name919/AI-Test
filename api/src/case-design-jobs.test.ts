import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { before, after } from 'node:test'
import type { DesignRun } from '@quality-ai/contracts/case-design'

const directory = mkdtempSync(join(tmpdir(),'quality-ai-design-jobs-'))
process.env.QUALITY_AI_DATABASE_PATH = join(directory,'test.sqlite')
const { createApiServer } = await import('./app')
const { database } = await import('./storage/database')
const { saveDesignRun, recoverInterruptedDesignRuns, listDesignRuns } = await import('./modules/case-design/repository')
const api = createApiServer()
let mode: 'valid' | 'invalid' | 'hold' = 'valid'
let release: (()=>void) | undefined
let received = 0
let failAt = -1
const instructions: string[] = []
let omitModelFact = false
let omitScenarios = false
let generationInvalid = false
let generationCalls = 0
let failGenerationAt = -1
let invalidReviewTarget = false
let invalidReviewEvidence = false
const model = createServer(async (request,response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString())
  instructions.push(body.instructions)
  const message = body.input[0].content as string
  if (body.instructions.includes('阶段：checking')) {
    const input=JSON.parse(message.split('\n\nReturn only')[0])
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({output_text:JSON.stringify({issues:[{targetType:'case',targetId:invalidReviewTarget?'unknown':input.cases[0].id,kind:'unverifiable',severity:'warning',reason:'需要人工确认观察结果能否覆盖完整意图',evidence:invalidReviewEvidence?[{documentId:'fake',blockId:'fake',quote:'伪造原文'}]:[]}]})})); return
  }
  if (body.instructions.includes('阶段：generating')) {
    generationCalls++
    response.writeHead(200, {'content-type':'application/json'})
    response.end(JSON.stringify({output_text:JSON.stringify({cases:[{
      title:'完整名称搜索', verification:'browser', verificationReason:'浏览器可观察输入与筛选结果',
      contract:{objective:'验证完整名称搜索',preconditions:['打开列表'],steps:['读取真实选项完整名称并搜索'],expectedAssertions:generationInvalid || generationCalls===failGenerationAt?[]:['来源选项仍存在'],dataBindings:[{id:'query',label:'搜索词',mode:'runtime_dom',targetHint:'搜索框',businessIntent:'完整搜索',strategy:'visible_option_full',constraints:{mustComeFromCurrentDom:true}}],forbiddenBehaviors:['不得编造账号数据'],uncertainties:[]},
    }]})})); return
  }
  if (body.instructions.includes('阶段：modeling') || body.instructions.includes('阶段：planning')) {
    const input = JSON.parse(message.split('\n\nReturn only')[0])
    const output = body.instructions.includes('阶段：modeling')
      ? {consolidatedFacts:omitModelFact?[]:input.facts.map((fact: {id:string},index:number)=>({...fact,id:`m${index+1}`,sourceFactIds:[fact.id]})),conflicts:[]}
      : {scenarios:omitScenarios?[]:[{id:'s1',factIds:[input.facts[0].id],questionIds:[],title:'搜索场景',testIntent:'验证搜索能力',coverage:'positive'}]}
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({output_text:JSON.stringify(output)})); return
  }
  const input = JSON.parse(message.slice(message.indexOf('：')+1).split('\n\nReturn only')[0])
  const block = input.blocks[0]
  received += 1
  if (mode === 'hold') await new Promise<void>(resolve=> {release=resolve})
  response.writeHead(200,{'content-type':'application/json'})
  response.end(JSON.stringify({output_text:JSON.stringify({facts:[{id:'f1',statement:'支持搜索',kind:'explicit',evidence:[{documentId:block.documentId,blockId:block.id,quote:mode==='invalid'||received===failAt?'凭空生成的原文':block.text}],relatedQuestionIds:[]}],questions:[]})}))
})
let url = ''
before(async()=> {
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve))
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
  process.env.MODEL_API_KEY='synthetic-key'
  process.env.MODEL_BASE_URL=`http://127.0.0.1:${(model.address() as AddressInfo).port}`
  url=`http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
after(async()=> {
  release?.(); model.closeAllConnections(); api.closeAllConnections()
  await Promise.all([new Promise<void>(resolve=>model.close(()=>resolve())),new Promise<void>(resolve=>api.close(()=>resolve()))])
  database.close(); rmSync(directory,{recursive:true,force:true})
})
const post = (path:string,body:unknown={}) => fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
async function create(content='支持搜索。') {
  const response=await post('/api/case-designs',{name:'合成任务',files:[{fileName:'prd.md',content,role:'prd'}]})
  return (await response.json()).design
}
async function waitFor(id:string,status:string):Promise<DesignRun> {
  for(let attempt=0;attempt<200;attempt++) {
    const {runs}=await (await fetch(`${url}/api/case-designs/${id}`)).json()
    if(runs[0]?.status===status) return runs[0]
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  throw new Error(`未达到 ${status}`)
}
test('background generation survives request completion and records model, input and validated output',async()=> {
  const design=await create()
  const response=await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  assert.equal(response.status,202)
  const run=await waitFor(design.id,'completed')
  assert.equal(run.inputHash,design.inputHash)
  assert.equal(run.output.facts[0].id,'b1:f1')
  assert.equal(run.output.unprocessedBlockIds.length,0)
  assert.equal(run.statistics.calls,1)
  assert.ok(run.statistics.outputCharacters>0)
  assert.equal(JSON.stringify(run).includes('synthetic-key'),false)
  assert.deepEqual(run.skills.map(skill=>skill.id),['requirement-facts'])
  assert.match(instructions.at(-1)!,/需求事实提取/)
  assert.match(instructions.at(-1)!,new RegExp(run.skills[0].hash))
  assert.equal(instructions.at(-1)!.includes('平台技能 test-data-design'),false)
})
test('invalid evidence fails without approving output; retries create separate attempts',async()=> {
  const design=await create(); mode='invalid'
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  const failed=await waitFor(design.id,'failed')
  assert.match(failed.error!,/依据校验失败/)
  assert.equal(failed.output.facts.length,0)
  mode='valid'
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  assert.equal((await waitFor(design.id,'completed')).attempt,2)
  assert.equal(listDesignRuns(design.id)[1].status,'failed')
})
test('cancellation cannot be overwritten by a late model result; startup recovers orphaned runs',async()=> {
  const design=await create(); mode='hold'
  const initial=received
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  await waitFor(design.id,'running')
  for(let i=0;i<100 && received===initial;i++) await new Promise(resolve=>setTimeout(resolve,10))
  assert.ok(received>initial)
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})).status,409)
  assert.equal((await (await post(`/api/case-designs/${design.id}/cancel`)).json()).cancelled,true)
  release?.(); mode='valid'
  const cancelled=await waitFor(design.id,'cancelled')
  assert.equal(cancelled.output.facts.length,0)
  saveDesignRun({...cancelled,id:'orphan',status:'running'})
  assert.equal(recoverInterruptedDesignRuns(),1)
  assert.equal(listDesignRuns(design.id).find(run=>run.id==='orphan')?.status,'interrupted')
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:99})).status,409)
})

test('later batch failure keeps completed batch facts and explicit unprocessed block list',async()=> {
  const design=await create('支持搜索。'.repeat(6000))
  failAt=received+2
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  const run=await waitFor(design.id,'failed')
  assert.equal(run.statistics.calls,2)
  assert.equal(run.output.facts.length,1)
  assert.equal(run.output.processedBlockIds.length,2)
  assert.equal(run.output.unprocessedBlockIds.length,1)
  assert.match(run.modelConfigHash,/^[a-f0-9]{64}$/)
  failAt=-1
})

test('skills can be disabled for reproducible evaluation without changing input documents',async()=> {
  const design=await create()
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1,skillsEnabled:false})
  const run=await waitFor(design.id,'completed')
  assert.deepEqual(run.skills,[])
  assert.equal(instructions.at(-1)!.includes('平台技能'),false)
  assert.equal(run.inputHash,design.inputHash)
})

test('generating consumes test-data skill, fixes provenance and retains earlier scenarios on failure',async()=> {
  const design=await create()
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{stage:'generating',expectedRevision:1})).status,409)
  for (const stage of ['extracting','modeling','planning']) {
    assert.equal((await post(`/api/case-designs/${design.id}/runs`,{stage,expectedRevision:1})).status,202)
    await waitFor(design.id,'completed')
  }
  const planned=listDesignRuns(design.id)[0]
  // Inject a synthetic unresolved upstream fact to verify server propagation, not model cooperation.
  planned.output.factModel!.consolidatedFacts[0].kind='inferred'
  planned.output.questions.push({id:'q1',question:'是否支持大小写忽略？',evidence:[]})
  planned.output.scenarios![0].questionIds=['q1']
  saveDesignRun(planned)
  await post(`/api/case-designs/${design.id}/runs`,{stage:'generating',expectedRevision:1,upstreamRunId:planned.id})
  const generated=await waitFor(design.id,'completed')
  assert.equal(generated.upstreamRunId,planned.id)
  assert.deepEqual(generated.skills.map(skill=>skill.id),['test-data-design'])
  assert.match(instructions.at(-1)!,/测试数据设计/)
  assert.equal(instructions.at(-1)!.includes('平台技能 requirement-facts'),false)
  const draft=generated.output.cases![0]
  assert.deepEqual(draft.factIds,['m1'])
  assert.deepEqual(draft.questionIds,['q1'])
  assert.equal(draft.requiresReview,true)
  assert.match(draft.contract.uncertainties.join('\n'),/q1.*大小写/)
  assert.match(draft.contract.uncertainties.join('\n'),/待复核 m1/)
  assert.equal(draft.contract.dataBindings[0].strategy,'visible_option_full')
  assert.deepEqual(generated.output.unprocessedScenarioIds,[])
  assert.equal(listDesignRuns(design.id).find(run=>run.id===planned.id)?.output.cases,undefined)
  await post(`/api/case-designs/${design.id}/runs`,{stage:'checking',expectedRevision:1,upstreamRunId:generated.id})
  const checked=await waitFor(design.id,'completed')
  assert.deepEqual(checked.skills.map(skill=>skill.id),['case-quality-review'])
  assert.match(instructions.at(-1)!,/用例质量审查/)
  assert.equal(instructions.at(-1)!.includes('平台技能 test-data-design'),false)
  assert.equal(checked.output.modelReviewCompleted,true)
  assert.ok(checked.output.issues?.some(issue=>issue.checkedBy==='rule' && issue.severity==='blocking'))
  assert.ok(checked.output.issues?.some(issue=>issue.checkedBy==='model'))
  assert.deepEqual(checked.output.cases,generated.output.cases)
  assert.equal(listDesignRuns(design.id).find(run=>run.id===generated.id)?.output.issues,undefined)
  invalidReviewTarget=true
  await post(`/api/case-designs/${design.id}/runs`,{stage:'checking',expectedRevision:1,upstreamRunId:generated.id,skillsEnabled:false})
  const invalidReview=await waitFor(design.id,'failed')
  invalidReviewTarget=false
  assert.match(invalidReview.error!,/不存在的目标/)
  assert.equal(invalidReview.output.modelReviewCompleted,false)
  assert.ok(invalidReview.output.issues!.length>0)
  assert.ok(invalidReview.output.issues!.every(issue=>issue.checkedBy==='rule'))
  assert.deepEqual(invalidReview.output.cases,generated.output.cases)
  invalidReviewEvidence=true
  await post(`/api/case-designs/${design.id}/runs`,{stage:'checking',expectedRevision:1,upstreamRunId:generated.id})
  const invalidEvidence=await waitFor(design.id,'failed')
  invalidReviewEvidence=false
  assert.match(invalidEvidence.error!,/模型审查依据无效/)
  assert.equal(invalidEvidence.output.modelReviewCompleted,false)
  generationInvalid=true
  await post(`/api/case-designs/${design.id}/runs`,{stage:'generating',expectedRevision:1,skillsEnabled:false})
  const failed=await waitFor(design.id,'failed')
  generationInvalid=false
  assert.deepEqual(failed.output.cases,[])
  assert.deepEqual(failed.output.unprocessedScenarioIds,['s1'])
  assert.equal(instructions.at(-1)!.includes('平台技能'),false)
  assert.equal(listDesignRuns(design.id).find(run=>run.id===generated.id)?.output.cases?.[0].id,draft.id)
  planned.output.scenarios!.push({...planned.output.scenarios![0],id:'s2'})
  saveDesignRun(planned)
  failGenerationAt=generationCalls+2
  await post(`/api/case-designs/${design.id}/runs`,{stage:'generating',expectedRevision:1,upstreamRunId:planned.id})
  const partial=await waitFor(design.id,'failed')
  failGenerationAt=-1
  assert.equal(partial.output.cases?.length,1)
  assert.deepEqual(partial.output.processedScenarioIds,['s1'])
  assert.deepEqual(partial.output.unprocessedScenarioIds,['s2'])
  assert.equal(partial.statistics.calls,2)
  await post(`/api/case-designs/${design.id}/runs`,{stage:'generating',expectedRevision:1,upstreamRunId:planned.id})
  const full=await waitFor(design.id,'completed')
  await post(`/api/case-designs/${design.id}/runs`,{stage:'checking',expectedRevision:1,upstreamRunId:full.id})
  const reviewRun=await waitFor(design.id,'completed')
  const firstCase=full.output.cases!.find(item=>item.scenarioId==='s1')!
  const untouched=full.output.cases!.find(item=>item.scenarioId==='s2')!
  const reviewResponse=await post(`/api/case-designs/${design.id}/reviews`,{expectedRevision:0,runId:reviewRun.id,review:{cases:{[firstCase.id]:{title:'人工保留标题',contract:{...firstCase.contract,objective:'人工口径不能被重生成覆盖'},verification:'browser',verificationReason:'页面观察',status:'draft'}},questionDecisions:{},issueDecisions:{},excludedFacts:{}}})
  assert.equal(reviewResponse.status,201)
  const savedReview=(await reviewResponse.json()).review
  const request={stage:'generating',expectedRevision:1,upstreamRunId:planned.id,regeneration:{baseRunId:full.id,scenarioIds:['s1']}}
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{...request,regeneration:{...request.regeneration,scenarioIds:['missing']}})).status,409)
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{...request,regeneration:{...request.regeneration,scenarioIds:['s1','s1']}})).status,400)
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,request)).status,202)
  const regenerated=await waitFor(design.id,'completed')
  assert.equal(regenerated.statistics.calls,1)
  assert.deepEqual(regenerated.output.cases!.find(item=>item.scenarioId==='s2'),untouched)
  assert.notEqual(regenerated.output.cases!.find(item=>item.scenarioId==='s1')!.id,firstCase.id)
  assert.deepEqual((await (await fetch(`${url}/api/case-designs/${design.id}/reviews`)).json()).reviews,[savedReview])
  const comparison=(await (await fetch(`${url}/api/case-designs/${design.id}/runs/${regenerated.id}/comparison`)).json()).comparison
  assert.equal(comparison.scenarios[0].before[0].id,firstCase.id)
  assert.equal(comparison.scenarios[0].suggestions.length,1)
  assert.equal(comparison.scenarios[0].human[0].review.contract.objective,'人工口径不能被重生成覆盖')
  assert.equal(comparison.reviewRevision,1)
  const changed=structuredClone(planned)
  changed.output.factModel!.consolidatedFacts[0].statement='改写上游规则'
  saveDesignRun(changed)
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,request)).status,409)
})

test('modeling and planning bind compatible upstream runs and reject silent fact omission',async()=> {
  const design=await create()
  assert.equal((await post(`/api/case-designs/${design.id}/runs`,{stage:'planning',expectedRevision:1})).status,409)
  await post(`/api/case-designs/${design.id}/runs`,{stage:'extracting',expectedRevision:1})
  const extracted=await waitFor(design.id,'completed')
  omitModelFact=true
  await post(`/api/case-designs/${design.id}/runs`,{stage:'modeling',expectedRevision:1,upstreamRunId:extracted.id})
  const failed=await waitFor(design.id,'failed')
  assert.match(failed.error!,/遗漏原始事实/)
  assert.equal(failed.output.facts.length,1)
  omitModelFact=false
  await post(`/api/case-designs/${design.id}/runs`,{stage:'modeling',expectedRevision:1,upstreamRunId:extracted.id})
  const modeled=await waitFor(design.id,'completed')
  assert.equal(modeled.upstreamRunId,extracted.id)
  assert.equal(modeled.output.factModel?.consolidatedFacts.length,1)
  await post(`/api/case-designs/${design.id}/runs`,{stage:'planning',expectedRevision:1,upstreamRunId:modeled.id})
  const planned=await waitFor(design.id,'completed')
  assert.equal(planned.upstreamRunId,modeled.id)
  assert.deepEqual(planned.output.scenarios?.[0].factIds,['m1'])
  assert.deepEqual(planned.output.uncoveredFactIds,[])
  assert.equal(listDesignRuns(design.id).find(run=>run.id===extracted.id)?.output.factModel,undefined)
  omitScenarios=true
  await post(`/api/case-designs/${design.id}/runs`,{stage:'planning',expectedRevision:1,upstreamRunId:modeled.id})
  const uncovered=await waitFor(design.id,'completed')
  assert.deepEqual(uncovered.output.uncoveredFactIds,['m1'])
  assert.equal(uncovered.output.scenarios?.length,0)
  omitScenarios=false
})
