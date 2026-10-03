import assert from 'node:assert/strict'
import test from 'node:test'
import { automationPlanSchema, type CaseExecutionContract } from '@quality-ai/contracts'
import { validateFixedAssertionCoverage } from './fixed-assertion-coverage'
const contract:CaseExecutionContract={objective:'验证结果',preconditions:[],steps:['搜索'],expectedAssertions:['来源保留','关键词高亮'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}
const steps=(value:unknown)=>automationPlanSchema.parse({name:'测试',targetUrl:'http://localhost',steps:value}).steps
test('固定预期映射拒绝遗漏、未知、旧无映射以及文本偷换高亮',()=>{
  assert.throws(()=>validateFixedAssertionCoverage(steps([{action:'expectText',text:'结果',assertionIndex:0}]),contract),/遗漏.*关键词高亮/)
  assert.throws(()=>validateFixedAssertionCoverage(steps([{action:'expectText',text:'结果'}]),contract),/缺少契约预期映射/)
  assert.throws(()=>validateFixedAssertionCoverage(steps([{action:'expectText',text:'结果',assertionIndex:8}]),contract),/不存在/)
  assert.throws(()=>validateFixedAssertionCoverage(steps([{action:'expectText',text:'结果',assertionIndex:1}]),contract),/高亮/)
  assert.doesNotThrow(()=>validateFixedAssertionCoverage(steps([{action:'expectText',text:'结果',assertionIndex:0},{action:'expectAttribute',locator:{by:'css',value:'.match'},name:'class',value:'highlighted',match:'token',assertionIndex:1}]),contract))
})
