import assert from 'node:assert/strict'
import test from 'node:test'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'
import { checkDesignRules, checkCaseQuality } from './quality-checker'
import { qualityReviewBatches } from './quality-review-batches'
import { createServer } from 'node:http'
import { getModelConfig } from '../../model-config'

test('大原文分批审查保留全量用例，失败保留已审查范围且不标完成',async()=>{
  const design:CaseDesign={id:'d',name:'合成',revision:1,inputHash:'h',createdAt:'now',updatedAt:'now',documents:[{id:'doc',fileName:'public.md',role:'prd',contentHash:'h',version:1,warnings:[],blocks:Array.from({length:16},(_,i)=>({id:`b${i}`,documentId:'doc',kind:'paragraph' as const,text:'公开合成材料'.repeat(1500),warnings:[]}))}]}
  const fixture=():DesignRun=>({id:'r',designId:'d',attempt:1,stage:'checking',status:'running',inputRevision:1,inputHash:'h',model:'fixture',modelConfigHash:'h',protocol:'openai-responses',promptVersion:'checking-v2',skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[],processedBlockIds:[],unprocessedBlockIds:[],factModel:{consolidatedFacts:[],conflicts:[]},scenarios:[],cases:[{id:'c',scenarioId:'s',title:'查询',factIds:[],questionIds:[],verification:'browser',verificationReason:'合成',requiresReview:true,contract:{objective:'查询',preconditions:[],steps:['查询'],expectedAssertions:['结果可见'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}]}})
  let failSecond=false,count=0
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const input=JSON.parse(body.input[0].content.split('\n\nReturn only')[0])
    assert.equal(input.cases.length,1)
    assert.ok(body.instructions.length+JSON.stringify(input).length<=120000)
    count++
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({output_text:failSecond&&count===2?'invalid-json':JSON.stringify({issues:[]})}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}`,protocol:'openai-responses'})
  try{
    const run=fixture();await checkCaseQuality(design,run,config,new AbortController().signal,()=>{},[])
    assert.ok(count>1);assert.equal(run.output.modelReviewCompleted,true)
    assert.deepEqual(run.output.reviewedBlockIds,design.documents[0]!.blocks.map(block=>block.id))
    assert.deepEqual(run.output.unreviewedBlockIds,[])
    count=0;failSecond=true
    const failed=fixture();await assert.rejects(checkCaseQuality(design,failed,config,new AbortController().signal,()=>{},[]))
    assert.equal(failed.output.modelReviewCompleted,false)
    assert.ok(failed.output.reviewedBlockIds!.length>0)
    assert.ok(failed.output.unreviewedBlockIds!.length>0)
    const oversized=fixture();oversized.output.cases![0]!.contract.objective='x'.repeat(120001)
    assert.throws(()=>qualityReviewBatches(design,oversized,100),/审查单元.*超过交叉审查预算/)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('规则检查分别记录缺失依据、未覆盖、负例前置与重复，不改变草稿', () => {
  const design: CaseDesign = { id:'design', name:'合成设计', revision:1, inputHash:'hash', documents:[], createdAt:'now', updatedAt:'now' }
  const run: DesignRun = {
    id:'run', designId:'design', attempt:1, stage:'checking', status:'running', inputRevision:1, inputHash:'hash', model:'fixture', modelConfigHash:'hash', protocol:'openai-responses', promptVersion:'test', skills:[], createdAt:'now', updatedAt:'now', statistics:{calls:0,inputCharacters:0,outputCharacters:0},
    output: {
      facts:[], questions:[], processedBlockIds:[], unprocessedBlockIds:['unread'],
      factModel:{consolidatedFacts:[{id:'f1',sourceFactIds:['raw'],statement:'支持搜索',kind:'explicit',evidence:[],relatedQuestionIds:[]},{id:'f2',sourceFactIds:['raw2'],statement:'支持导出',kind:'inferred',evidence:[],relatedQuestionIds:[]}],conflicts:[]},
      scenarios:[{id:'s1',factIds:['f1'],questionIds:[],title:'搜索',testIntent:'验证搜索',coverage:'negative',requiresReview:true},{id:'s2',factIds:['f2'],questionIds:[],title:'导出',testIntent:'验证导出',coverage:'positive',requiresReview:true}],
      cases:[{id:'c1',scenarioId:'s1',factIds:['f1'],questionIds:[],title:'负例',verification:'browser',verificationReason:'浏览器观察',requiresReview:true,contract:{objective:'验证空结果',preconditions:[],steps:['输入负例'],expectedAssertions:['出现空态'],dataBindings:[{id:'data',label:'负例词',targetHint:'搜索框',businessIntent:'无匹配',mode:'runtime_dom',strategy:'non_matching_option_query',constraints:{mustComeFromCurrentDom:true}}],forbiddenBehaviors:[],uncertainties:[]}}],
    },
  }
  run.output.cases!.push({...structuredClone(run.output.cases![0]),id:'c2'})
  const original=JSON.stringify(run.output)
  const issues=checkDesignRules(design,run)
  assert.ok(issues.some(issue=>issue.targetId==='f1' && issue.kind==='missing_evidence'))
  assert.ok(issues.some(issue=>issue.targetId==='f2' && issue.kind==='missing_coverage'))
  assert.ok(issues.some(issue=>issue.targetId==='s2' && issue.kind==='missing_coverage'))
  assert.ok(issues.some(issue=>issue.targetId==='c1' && issue.kind==='unverifiable' && issue.severity==='blocking'))
  assert.ok(issues.some(issue=>issue.targetId==='c2' && issue.kind==='duplicate' && issue.severity==='warning'))
  assert.ok(issues.every(issue=>issue.checkedBy==='rule'))
  assert.equal(JSON.stringify(run.output),original)
})
