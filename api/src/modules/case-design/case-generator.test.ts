import assert from 'node:assert/strict'
import test from 'node:test'
import { testDataBindingSchema } from '@quality-ai/contracts'
import { bindingProtocolExamples, generatingPrompt, generatingPromptVersion } from './case-generator'

test('生成提示词使用通过生产协议校验的三类搜索示例，不携带预设账号搜索词',()=>{
  assert.equal(generatingPromptVersion,'generating-v2')
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
