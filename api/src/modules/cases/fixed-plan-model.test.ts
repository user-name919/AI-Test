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
    assert.match(JSON.stringify(body),/expectCount/)
    assert.match(JSON.stringify(body),/目标容器缺失或歧义时不会按0通过/)
    assert.match(JSON.stringify(body),/操作不是断言/)
    assert.match(JSON.stringify(body),/openPage/)
    assert.match(JSON.stringify(body),/不得先click再openPage重复触发/)
    if(calls===1){assert.match(JSON.stringify(body),/先观察可见选项/);assert.match(JSON.stringify(body),/与最终契约冲突时忽略/)}
    response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(output)}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,protocol:'openai-responses'})
  const item={caseKey:'0-TC-0',title:'审核结果',contractFingerprint:'frozen',contract:{objective:'人工目标',preconditions:[],steps:['点击查询'],expectedAssertions:['人工最终预期'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]},resolvedQuestions:[],readiness:{agent:{executable:true},plan:{executable:true}},requirementIndex:0,caseIndex:0,questionAssociation:{mode:'explicit',questionKeys:[]}} satisfies ResolvedCaseExecutionContract
  try{
    const result=await generateFixedPlan('http://example.test',item,undefined,config,[{id:'11111111-1111-4111-8111-111111111111',revision:2,lesson:'先观察可见选项',executionId:'source',projectId:'project',targetUrl:'http://example.test',sourceCommit:'a'.repeat(40)}])
    assert.equal(result.steps[0].action,'expectText')
    output={name:'新页',targetUrl:'http://example.test',steps:[{action:'openPage',locator:{by:'role',value:'link',name:'详情'},pageAlias:'detail'},{action:'switchPage',pageAlias:'detail'},{action:'expectText',assertionIndex:0,text:'人工最终预期'}]}
    assert.equal((await generateFixedPlan('http://example.test',item,undefined,config)).steps[1].action,'switchPage')
    output={name:'未绑定',targetUrl:'http://example.test',steps:[{action:'switchPage',pageAlias:'guessed'},{action:'expectText',assertionIndex:0,text:'人工最终预期'}]}
    await assert.rejects(generateFixedPlan('http://example.test',item,undefined,config),/尚未绑定/)
    output={name:'空态',targetUrl:'http://example.test',steps:[{action:'expectCount',locator:{by:'role',value:'option',scope:[{by:'role',value:'listbox',name:'考试'}]},count:0,assertionIndex:0}]}
    const countPlan=await generateFixedPlan('http://example.test',{...item,contract:{...item.contract,expectedAssertions:['人工最终预期：考试列表无选项']}},undefined,config)
    assert.equal(countPlan.steps[0].action,'expectCount')
    output={name:'计划',targetUrl:'http://example.test',steps:[{action:'selectOption',locator:{by:'label',value:'状态'},value:'guessed',optionBy:'value'},{action:'expectText',assertionIndex:0,text:'人工最终预期'}]}
    await assert.rejects(generateFixedPlan('http://example.test',item,undefined,config),/不得猜测/)
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
