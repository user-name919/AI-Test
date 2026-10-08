import assert from 'node:assert/strict'
import test from 'node:test'
import { completeCaseResults } from './automation/complete-case-results'
import { aggregateExecutionStatus } from './automation/agent-test-runner'
import type { CaseExecutionResult } from '@quality-ai/contracts'

test('补齐未执行结果保留顺序和原结论，不伪造DOM或通过证据',()=>{
  const first={caseKey:'0-TC-0',title:'第一条',contractFingerprint:'original'}
  const second={caseKey:'0-TC-1',title:'第二条',contractFingerprint:'second'}
  const result:CaseExecutionResult={...first,status:'failed',startedFromUrl:'https://example.test',continuation:'reused_current_page',resolvedDataBindings:[],passedAssertions:['a1'],trajectory:[],steps:[],screenshots:[],error:'真实断言失败'}
  const output=completeCaseResults([first,second],[result],'浏览器中断')
  assert.equal(output[0],result)
  assert.equal(output[0]?.error,'真实断言失败')
  assert.deepEqual(output[0]?.passedAssertions,['a1'])
  assert.deepEqual(output[1],{...second,status:'not_run',error:'浏览器中断',startedFromUrl:'',continuation:'not_started',resolvedDataBindings:[],passedAssertions:[],trajectory:[],steps:[],screenshots:[]})
  assert.equal(aggregateExecutionStatus(output),'failed')
  assert.equal(aggregateExecutionStatus([output[1]!]),'infrastructure_failed')
  assert.equal(aggregateExecutionStatus([]),'infrastructure_failed')
})
