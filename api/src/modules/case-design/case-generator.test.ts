import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DesignRun } from '@quality-ai/contracts/case-design'
import { getModelConfig } from '../../model-config'
import { testDataBindingSchema } from '@quality-ai/contracts'
import { bindingProtocolExamples, generatingPrompt, generatingPromptVersion, generateCases } from './case-generator'

test('生产生成器最多修复一次，保留错误响应；再次失败和取消不无限调用',async()=>{
  let requests:Record<string,unknown>[]=[]
  let alwaysInvalid=false
  const valid={cases:[{title:'验证状态',verification:'browser',verificationReason:'可观察',contract:{objective:'状态',preconditions:[],steps:['点击查询'],expectedAssertions:['显示结果'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}]}
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({output_text:JSON.stringify(alwaysInvalid||requests.length===1?{cases:[]}:valid)}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,protocol:'openai-responses'})
  const fixture=():DesignRun=>({id:'r',designId:'d',attempt:1,stage:'generating',status:'running',inputRevision:1,inputHash:'h',model:'fixture',modelConfigHash:'m',protocol:'openai-responses',promptVersion:generatingPromptVersion,skills:[],createdAt:'now',updatedAt:'now',statistics:{calls:0,inputCharacters:0,outputCharacters:0},output:{facts:[],questions:[],processedBlockIds:[],unprocessedBlockIds:[],factModel:{consolidatedFacts:[],conflicts:[]},scenarios:[{id:'s',title:'查询',testIntent:'验证状态',factIds:['f'],questionIds:[],coverage:'positive',requiresReview:true}]}})
  try{
    const run=fixture()
    await generateCases(run,config,new AbortController().signal,()=>{},[])
    assert.equal(requests.length,2)
    assert.deepEqual(run.output.generationAttempts?.map(item=>item.status),['invalid','validated'])
    assert.equal(run.output.generationAttempts?.[0].response,'{"cases":[]}')
    assert.deepEqual(run.output.cases?.[0].contract.expectedAssertions,['显示结果'])
    assert.match(JSON.stringify(requests[1]),/originalInput/)
    assert.match(JSON.stringify(requests[1]),/不改变业务预期/)
    requests=[];alwaysInvalid=true
    const failed=fixture()
    await assert.rejects(generateCases(failed,config,new AbortController().signal,()=>{},[]))
    assert.equal(requests.length,2)
    assert.equal(failed.output.generationAttempts?.length,2)
    assert.deepEqual(failed.output.unprocessedScenarioIds,['s'])
    requests=[]
    const cancelled=fixture(),controller=new AbortController()
    await assert.rejects(generateCases(cancelled,config,controller.signal,()=>{if(cancelled.output.generationAttempts?.length)controller.abort()},[]))
    assert.equal(requests.length,1)
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('生成提示词使用通过生产协议校验的三类搜索示例，不携带预设账号搜索词',()=>{
  assert.equal(generatingPromptVersion,'generating-v3')
  assert.equal(bindingProtocolExamples.length,4)
  for(const binding of bindingProtocolExamples){
    assert.equal(testDataBindingSchema.safeParse(binding).success,true)
    assert.ok(generatingPrompt.includes(JSON.stringify(binding)))
    if(binding.mode==='runtime_dom'){
      assert.equal(binding.manual,undefined)
      assert.equal(binding.fixture,undefined)
    }
  }
  assert.deepEqual(bindingProtocolExamples.slice(0,3).map(item=>item.strategy),['visible_option_full','visible_option_substring','non_matching_option_query'])
  assert.equal(bindingProtocolExamples[3].manual?.value,'')
  assert.match(generatingPrompt,/没有参数无需创建 dataBindings/)
  assert.match(generatingPrompt,/不删除该场景/)
})

test('协议仍拒绝真实评估发现的缺策略及对象取值，不为模型输出自动补值',()=>{
  const runtime=structuredClone(bindingProtocolExamples[0])
  delete runtime.strategy
  assert.equal(testDataBindingSchema.safeParse(runtime).success,false)
  const manual=bindingProtocolExamples[3]
  for(const value of [null,{},[]])assert.equal(testDataBindingSchema.safeParse({...manual,manual:{value,rationale:'测试'}}).success,false)
})
