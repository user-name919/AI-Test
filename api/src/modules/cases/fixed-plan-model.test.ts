import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ResolvedCaseExecutionContract } from '@quality-ai/contracts'
import { getModelConfig } from '../../model-config'
import { generateFixedPlan } from './fixed-plan-model'

test('固定规划使用最终契约，拒绝异地地址和未解析引用，取消传入模型客户端',async()=>{
  let output:unknown={name:'计划',targetUrl:'http://example.test',steps:[{action:'expectText',assertionIndex:0,text:'人工最终预期'}]}
  let calls=0
  const server=createServer(async(request,response)=>{
    calls++
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    assert.match(JSON.stringify(body),/人工最终预期/)
    assert.match(JSON.stringify(body),/expectChecked/)
    assert.match(JSON.stringify(body),/操作不是断言/)
    response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(output)}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,protocol:'openai-responses'})
  const item={caseKey:'0-TC-0',title:'审核结果',contractFingerprint:'frozen',contract:{objective:'人工目标',preconditions:[],steps:['点击查询'],expectedAssertions:['人工最终预期'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]},resolvedQuestions:[],readiness:{agent:{executable:true},plan:{executable:true}},requirementIndex:0,caseIndex:0,questionAssociation:{mode:'explicit',questionKeys:[]}} satisfies ResolvedCaseExecutionContract
  try{
    const result=await generateFixedPlan('http://example.test',item,undefined,config)
    assert.equal(result.steps[0].action,'expectText')
    output={name:'计划',targetUrl:'http://other.test',steps:[{action:'expectText',assertionIndex:0,text:'不应执行'}]}
    await assert.rejects(generateFixedPlan('http://example.test',item,undefined,config),/地址/)
    output={name:'计划',targetUrl:'http://example.test',steps:[{action:'fill',locator:{by:'label',value:'查询'},valueRef:'missing'}]}
    await assert.rejects(generateFixedPlan('http://example.test',item,undefined,config),/尚未解析/)
    const controller=new AbortController();controller.abort()
    const before=calls
    await assert.rejects(generateFixedPlan('http://example.test',item,controller.signal,config))
    assert.equal(calls,before)
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
