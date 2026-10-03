import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runAutomationPlan } from './playwright-runner'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
import { automationStepSchema } from '@quality-ai/contracts'

test('固定元素断言识别状态与完整class标记，错误高亮失败后继续验证',async t=>{
  const artifactRoot=await mkdtemp(join(tmpdir(),'quality-ai-fixed-assertions-'))
  t.after(()=>rm(artifactRoot,{recursive:true,force:true}))
  const web=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<input aria-label="query" value="Alpha"><button disabled>Save</button><button>Search</button><div id="hidden" hidden>hidden</div><span id="wrong" class="not-highlighted">Alpha</span><span id="match" class="option highlighted">Alpha</span>')})
  await new Promise<void>(resolve=>web.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>web.close(()=>resolve())))
  const locator=(value:string)=>({by:'css',value})
  const wrong=[{action:'expectAttribute',locator:locator('#wrong'),name:'class',value:'highlighted',match:'token'}]
  const right=[
    {action:'expectVisible',locator:locator('#match')},
    {action:'expectHidden',locator:locator('#hidden')},
    {action:'expectEnabled',locator:{by:'role',value:'button',name:'Search'}},
    {action:'expectDisabled',locator:{by:'role',value:'button',name:'Save'}},
    {action:'expectValue',locator:{by:'label',value:'query'},value:'Alpha'},
    {action:'expectAttribute',locator:locator('#match'),name:'class',value:'highlighted',match:'token'},
    {action:'expectAttribute',locator:locator('#match'),name:'class',value:'option highlighted',match:'exact'},
  ]
  const result=await runAutomationPlan({name:'固定断言',targetUrl:`http://127.0.0.1:${(web.address() as AddressInfo).port}`,steps:wrong,casePlans:[{caseKey:'0-TC-0',title:'错误高亮',contractFingerprint:'wrong',steps:wrong},{caseKey:'0-TC-1',title:'正确状态',contractFingerprint:'right',steps:right}]},undefined,{artifactRoot})
  assert.deepEqual(result.caseResults?.map(item=>item.status),['failed','passed'])
  assert.match(result.caseResults?.[0].error??'',/not-highlighted/)
  assert.equal(result.caseResults?.[0].passedAssertions.length,0)
  assert.equal(result.caseResults?.[1].passedAssertions.length,7)
  const activity=describeAutomationStep(automationStepSchema.parse(right[3]),3)
  assert.match(activity.title,/不可操作/)
  assert.equal(automationStepSchema.safeParse({action:'expectValue',locator:locator('input'),value:'A',valueRef:'q'}).success,false)
})
