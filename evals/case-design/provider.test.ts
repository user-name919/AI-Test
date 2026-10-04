import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import CaseDesignProvider from './provider'
import { modelingPromptVersion,planningPromptVersion } from '../../api/src/modules/case-design/scenario-planner'
import { generatingPromptVersion } from '../../api/src/modules/case-design/case-generator'
import { checkingPromptVersion } from '../../api/src/modules/case-design/quality-checker'
import type { DesignRun } from '@quality-ai/contracts/case-design'

test('真实生成器解析失败仍保存输入配置指纹及当前阶段，不泄露配置密钥',async()=>{
  const original={...process.env}
  const server=createServer((_request,response)=>{
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({output_text:JSON.stringify({facts:'invalid',questions:[]})}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    Object.assign(process.env,{MODEL_API_KEY:'synthetic-secret-not-for-output',MODEL_BASE_URL:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,MODEL_PROTOCOL:'openai-responses',MODEL_NAME:'fixture',QUALITY_AI_EVAL_MODE:'stub'})
    const provider=new CaseDesignProvider()
    const result=await provider.callApi(JSON.stringify({sampleId:'invalid-facts',documents:[{fileName:'公开合成材料',role:'prd',content:'点击查询显示结果'}]}))
    assert.ok(result.error)
    assert.equal(result.metadata.failedStage,'extracting')
    assert.deepEqual(result.metadata.completedStages,[])
    assert.match(result.metadata.provenance?.inputHash??'',/^[a-f0-9]{64}$/)
    assert.match(result.metadata.provenance?.modelConfigHash??'',/^[a-f0-9]{64}$/)
    assert.equal(result.metadata.provenance?.evidenceMode,'stub')
    assert.doesNotMatch(JSON.stringify(result),/synthetic-secret-not-for-output/)
    const invalid=await provider.callApi('not-json')
    assert.equal(invalid.metadata.failedStage,'input')
    assert.equal(invalid.metadata.provenance?.inputHash,undefined)
  }finally{
    process.env=original
    server.closeAllConnections()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

test('评估沿用生产阶段版本，失败保留完整上游与当前格式修复产物',async()=>{
  const original={...process.env}
  let failGeneration=false
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const stage=body.instructions.match(/阶段：(\w+)/)?.[1]??'extracting'
    let text=body.input[0].content.split('\n\nReturn only')[0]
    if(stage==='extracting')text=text.slice(text.indexOf('：')+1)
    const input=JSON.parse(text)
    let result:unknown
    if(stage==='extracting')result={facts:input.blocks.map((block:{id:string;documentId:string;text:string},index:number)=>({id:`f${index}`,statement:block.text,kind:'explicit',relatedQuestionIds:[],evidence:[{documentId:block.documentId,blockId:block.id,quote:block.text}]})),questions:[]}
    else if(stage==='modeling')result={consolidatedFacts:input.facts.map((fact:{id:string})=>({...fact,id:`m-${fact.id}`,sourceFactIds:[fact.id]})),conflicts:[]}
    else if(stage==='planning')result={scenarios:[{id:'s1',factIds:input.facts.map((fact:{id:string})=>fact.id),questionIds:[],title:'查询',testIntent:'核对结果',coverage:'positive'}]}
    else if(stage==='generating')result={cases:failGeneration?[]:[{title:'查询',verification:'browser',verificationReason:'可观察文本',contract:{objective:'核对结果',preconditions:[],steps:['查询'],expectedAssertions:['显示结果'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}]}
    else result={issues:[]}
    response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(result)}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    Object.assign(process.env,{MODEL_API_KEY:'synthetic-secret-not-for-output',MODEL_BASE_URL:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,MODEL_PROTOCOL:'openai-responses',MODEL_NAME:'fixture',QUALITY_AI_EVAL_MODE:'stub'})
    const provider=new CaseDesignProvider({config:{variant:'skills'}})
    const input=JSON.stringify({sampleId:'versions',documents:[{fileName:'公开合成材料',role:'prd',content:'点击查询显示结果'}]})
    const success=await provider.callApi(input)
    assert.equal(success.error,undefined)
    const stages=JSON.parse(success.output!).stages as DesignRun[]
    assert.deepEqual(stages.slice(1).map(stage=>stage.promptVersion),[modelingPromptVersion,planningPromptVersion,generatingPromptVersion,checkingPromptVersion])
    assert.ok(stages[0].skills.some(skill=>skill.id==='requirement-facts'&&/^[a-f0-9]{64}$/.test(skill.hash)))
    failGeneration=true
    const failed=await provider.callApi(input)
    assert.ok(failed.error)
    assert.deepEqual(failed.metadata.completedStages,['extracting','modeling','planning'])
    assert.equal(failed.metadata.stages?.[1].promptVersion,modelingPromptVersion)
    assert.equal(failed.metadata.stages?.[2].output.scenarios?.length,1)
    assert.equal(failed.metadata.failedRun?.stage,'generating')
    assert.equal(failed.metadata.failedRun?.status,'failed')
    assert.equal(failed.metadata.failedRun?.promptVersion,generatingPromptVersion)
    assert.equal(failed.metadata.failedRun?.output.generationAttempts?.length,2)
    assert.equal(failed.metadata.stages?.[2].output.generationAttempts,undefined,'当前失败产物不污染已完成阶段快照')
    assert.doesNotMatch(JSON.stringify(failed),/synthetic-secret-not-for-output/)
  }finally{process.env=original;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
