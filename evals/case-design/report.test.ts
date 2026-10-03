import assert from 'node:assert/strict'
import test from 'node:test'
import { summarize } from './report'

test('报告明确区别机器通过与人工评审，不将缺失运行视为可比',()=>{
  const row={provider:{id:'quality-ai-legacy'},success:true,response:{output:JSON.stringify({evidenceMode:'stub',inputHash:'i',modelConfigHash:'m'})},vars:{payload:JSON.stringify({sampleId:'full-search'})}}
  const report=summarize([row])
  assert.match(report,/证据类型：stub/)
  assert.match(report,/1\/1（期望3）/)
  assert.match(report,/缺失或不一致/)
  assert.match(report,/待人工评审/)
  assert.match(report,/不能据此得出不存在业务语义错误/)
  assert.match(summarize(Array.from({length:9},()=>row)),/缺失或不一致/)
})
test('报告完整比较需要三种配置各三次，失败不能隐藏',()=>{
  const rows=['legacy','pipeline','skills'].flatMap(variant=>Array.from({length:3},()=>({provider:{id:`quality-ai-${variant}`},success:true,response:{output:JSON.stringify({evidenceMode:'stub',inputHash:'i',modelConfigHash:'m'})},vars:{payload:JSON.stringify({sampleId:'full-search'})}})))
  assert.match(summarize(rows),/3\/3（期望3） \| 3\/3（期望3） \| 3\/3（期望3） \| 一致/)
  rows[0].success=false
  rows[0].response.output='invalid'
  const report=summarize(rows)
  assert.match(report,/2\/3（期望3）/)
  assert.match(report,/full-search \/ quality-ai-legacy：失败原因缺失/)
})
