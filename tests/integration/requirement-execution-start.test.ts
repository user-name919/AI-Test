import assert from 'node:assert/strict'
import test from 'node:test'
import { startRequirementExecution } from '../../web/src/features/executions/startRequirementExecution'

test('旧需求入口拒绝与已展示口径不一致的资产，不能继续创建任务',async()=>{
  const calls:string[]=[]
  const request=(async(url)=>{
    calls.push(String(url))
    return new Response(JSON.stringify({cases:[{id:'asset',source:{type:'requirement',analysisId:'analysis',caseKey:'0-TC-0'},revision:2,resolved:{contractFingerprint:'new'}}]}))
  }) as typeof fetch
  await assert.rejects(startRequirementExecution({analysisId:'analysis',cases:[{caseKey:'0-TC-0',contractFingerprint:'shown'}],targetUrl:'https://example.test',environmentId:'env',projectId:'project'},request),/用例口径已变化/)
  assert.equal(calls.length,1)
  assert.match(calls[0]!,/sourceId=analysis/)
})
