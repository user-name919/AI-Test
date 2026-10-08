import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionJob } from '@quality-ai/contracts/cases'
import { startRequirementExecution } from '../../web/src/features/executions/startRequirementExecution'

test('旧需求入口只把本次选中且指纹匹配的用例授权转成稳定资产 ID',async()=>{
  let started:Record<string,unknown>|undefined
  const request=(async(url,options)=>{
    if(String(url)==='/api/execution-jobs'){
      started=JSON.parse(options!.body as string)
      return new Response(JSON.stringify({job:{id:'job'} as ExecutionJob}))
    }
    return new Response(JSON.stringify({cases:[{id:'asset',source:{type:'requirement',analysisId:'analysis',caseKey:'0-TC-0'},revision:2,resolved:{contractFingerprint:'shown'}}]}))
  }) as typeof fetch
  const input={analysisId:'analysis',cases:[{caseKey:'0-TC-0',contractFingerprint:'shown'}],targetUrl:'https://example.test',environmentId:'env'}
  await startRequirementExecution({...input,authorizedWriteCaseKeys:['0-TC-0']},request)
  assert.deepEqual(started?.authorizedWriteCaseIds,['asset'])
  started=undefined
  await assert.rejects(startRequirementExecution({...input,authorizedWriteCaseKeys:['0-TC-1']},request),/未选中的用例/)
  assert.equal(started,undefined)
})

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
