import assert from 'node:assert/strict'
import test from 'node:test'
import { recheckSavedResults } from './recheck'
import { assertionsVersion } from './assertions'

test('离线复核保留原失败和原通过，不补造调用错误的产物',()=>{
  const vars={payload:JSON.stringify({sampleId:'no-match'})}
  const rows=[{provider:{id:'quality-ai-skills'},vars,success:true,response:{output:'not-json'}},{provider:{id:'quality-ai-pipeline'},vars,success:false,error:'目标引用非法',response:{error:'目标引用非法'}},{provider:{id:'quality-ai-legacy'},vars,success:false,error:'无响应'}]
  const raw=JSON.stringify({results:{results:rows}})
  const result=recheckSavedResults(raw)
  assert.deepEqual(result.summary,{total:3,originalPassed:1,recheckedPassed:0,recheckedFailed:1,notRechecked:2})
  assert.equal(result.results[0]!.originalPassed,true)
  assert.equal(result.results[1]!.originalReason,'目标引用非法')
  assert.equal(result.humanReview,'pending');assert.equal(result.evidenceMode,'offline-recheck');assert.equal(result.assertionsVersion,assertionsVersion)
  assert.equal(raw,JSON.stringify({results:{results:rows}}))
  assert.equal(result.sourceSha256.length,64)
  assert.throws(()=>recheckSavedResults('{"results":{"results":[]}}'),/非空/)
})
