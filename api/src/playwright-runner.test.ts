import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { LiveExecutionEvent } from '@quality-ai/contracts'
import { runAutomationPlan } from './automation/playwright-runner'

test('固定执行器运行时取真实option，失败绑定不污染后续同会话用例',async t=>{
  const artifactRoot=await mkdtemp(join(tmpdir(),'quality-ai-fixed-data-'))
  t.after(()=>rm(artifactRoot,{recursive:true,force:true}))
  const web=createServer((_request,response)=>{response.setHeader('content-type','text/html; charset=utf-8');response.end('<input aria-label="搜索"><ul role="listbox"><li role="option">AlphaBook</li></ul>')})
  await new Promise<void>(resolve=>web.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>web.close(()=>resolve())))
  const address=web.address();assert.ok(address&&typeof address!=='string')
  const binding={id:'query',label:'查询词',mode:'runtime_dom',strategy:'visible_option_substring',targetHint:'搜索',businessIntent:'部分搜索',constraints:{mustComeFromCurrentDom:true,mustBePartialOfSource:true}}
  const contract={objective:'搜索',preconditions:[],steps:['输入真实关键词'],expectedAssertions:['可见关键词'],dataBindings:[binding],forbiddenBehaviors:[],uncertainties:[]}
  const steps=[{action:'resolveTestData',bindingId:'query'},{action:'fill',locator:{by:'label',value:'搜索'},valueRef:'query'},{action:'expectText',assertionIndex:0,valueRef:'query'}]
  let calls=0
  const result=await runAutomationPlan({name:'运行时数据',targetUrl:`http://127.0.0.1:${address.port}`,steps,casePlans:[0,1].map(index=>({caseKey:`0-TC-${index}`,title:`用例${index}`,contractFingerprint:'frozen',contract,steps}))},undefined,{artifactRoot,resolveTestData:async(binding,snapshot)=>{
    calls++
    return {type:'resolve_test_data',bindingId:binding.id,snapshotId:snapshot.snapshotId,sourceElementRef:snapshot.elements.find(item=>item.role==='option')!.ref,value:calls===1?'不存在的词':'Alpha',reason:'基于当前可见选项'}
  }})
  assert.deepEqual(result.caseResults?.map(item=>item.status),['blocked','passed'],JSON.stringify(result.caseResults?.map(item=>item.error)))
  assert.equal(result.caseResults?.[0].resolvedDataBindings.length,0)
  assert.equal(result.caseResults?.[1].resolvedDataBindings[0].sourceText,'AlphaBook')
  assert.equal(result.caseResults?.[1].resolvedDataBindings[0].value,'Alpha')
})

test('启动前取消仍返回全部选中用例的未执行记录且不启动浏览器',async t=>{
  const artifactRoot=await mkdtemp(join(tmpdir(),'quality-ai-plan-not-run-'))
  t.after(()=>rm(artifactRoot,{recursive:true,force:true}))
  const controller=new AbortController()
  controller.abort()
  const steps=[{action:'goto' as const,path:'/'}]
  const result=await runAutomationPlan({name:'未开始',targetUrl:'http://localhost',steps,casePlans:[
    {caseKey:'0-TC-0',title:'第一条',contractFingerprint:'first',steps},
    {caseKey:'0-TC-1',title:'第二条',contractFingerprint:'second',steps},
  ]},undefined,{artifactRoot,signal:controller.signal,launchBrowser:async()=>{throw new Error('不应启动')}})
  assert.equal(result.status,'cancelled')
  assert.deepEqual(result.caseResults?.map(item=>item.status),['not_run','not_run'])
  assert.ok(result.caseResults?.every(item=>item.continuation==='not_started'&&!item.startedFromSnapshotId&&item.screenshots.length===0))
})

test('固定计划取消保留已完成步骤但禁止后续操作',async t=>{
  const artifactRoot=await mkdtemp(join(tmpdir(),'quality-ai-plan-cancel-'))
  t.after(()=>rm(artifactRoot,{recursive:true,force:true}))
  const web=createServer((_request,response)=>response.end('<button>不得点击</button>'))
  await new Promise<void>(resolve=>web.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>web.close(()=>resolve())))
  const address=web.address()
  if(!address||typeof address==='string')throw new Error('fixture unavailable')
  const controller=new AbortController()
  const result=await runAutomationPlan({name:'取消测试',targetUrl:`http://127.0.0.1:${address.port}`,steps:[
    {action:'goto',path:'/'},{action:'click',locator:{by:'text',value:'不得点击'}},{action:'screenshot',name:'不应运行'},
  ]},undefined,{artifactRoot,signal:controller.signal,onEvent(event){
    if(event.type==='activity'&&event.activity.status==='running'&&event.activity.technicalAction?.startsWith('click'))controller.abort()
  }})
  assert.equal(result.status,'cancelled')
  assert.equal(result.steps[0]?.status,'passed')
  assert.equal(result.steps.length,2)
  assert.equal(result.steps[1]?.status,'failed')
})

test('streams the same Playwright page and readable fixed-plan activities', async testContext => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-plan-runner-'))
  testContext.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const web = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>考试列表</title><button>选择考试</button>')
  })
  await new Promise<void>((resolve, reject) => web.listen(0, '127.0.0.1', resolve).once('error', reject))
  testContext.after(() => new Promise<void>(resolve => web.close(() => resolve())))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败')
  const targetUrl = `http://127.0.0.1:${address.port}/mock-exam`
  const events: LiveExecutionEvent[] = []

  const result = await runAutomationPlan({
    name: '选择考试', targetUrl,
    steps: [
      { action: 'goto', path: '/mock-exam' },
      { action: 'click', locator: { by: 'text', value: '选择考试' } },
    ],
  }, undefined, { artifactRoot, onEvent: event => events.push(event) })

  assert.equal(result.status, 'blocked')
  assert.match(result.error ?? '', /没有执行任何业务断言/)
  assert.ok(result.steps.every(step => step.status === 'passed'))
  assert.ok(events.some(event => event.type === 'activity' && event.activity.title === '缺少断言证据'))
  assert.ok(events.some(event => event.type === 'execution_started' && event.mode === 'plan'))
  const frames = events.filter((event): event is Extract<LiveExecutionEvent, { type: 'browser_frame' }> => event.type === 'browser_frame')
  assert.ok(frames.length >= 2, 'a fast plan must still publish a page frame after its initial blank frame')
  assert.notEqual(frames.at(-1)?.dataUrl, frames[0]?.dataUrl)
  assert.ok(events.some(event => event.type === 'activity'
    && event.activity.title === '点击“选择考试”'
    && event.activity.technicalAction === 'click text=选择考试'))
})

test('fixed plans execute real case checkpoints on one continuous page after a failed case', async testContext => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-plan-batch-'))
  testContext.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const web = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><button onclick="this.textContent=\'已继续\';history.pushState({},\'\',\'/continued\')">继续</button>')
  })
  await new Promise<void>((resolve, reject) => web.listen(0, '127.0.0.1', resolve).once('error', reject))
  testContext.after(() => new Promise<void>(resolve => web.close(() => resolve())))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败')
  const targetUrl = `http://127.0.0.1:${address.port}/start`
  const result = await runAutomationPlan({
    name: '连续计划', targetUrl, steps: [{ action: 'goto', path: '/start' }],
    casePlans: [
      { caseKey: '0-TC-0', title: '第一条', contractFingerprint: 'first', steps: [
        { action: 'click', locator: { by: 'text', value: '继续' } },
        { action: 'goto', path: 'https://outside.invalid/' },
      ] },
      { caseKey: '0-TC-1', title: '第二条', contractFingerprint: 'second', steps: [
        { action:'expectText',assertionIndex:0, text: '已继续' }, { action: 'screenshot', name: '第二条证据' },
      ] },
      { caseKey: '0-TC-2', title: '只有操作无断言', contractFingerprint: 'third', steps: [
        { action: 'screenshot', name: '不能作为通过依据' },
      ] },
      { caseKey: '0-TC-3', title: '受阻后继续', contractFingerprint: 'fourth', steps: [
        { action:'expectText',assertionIndex:0, text: '已继续' },
      ] },
    ],
  }, undefined, { artifactRoot })
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.caseResults?.map(item => item.status), ['failed', 'passed', 'blocked', 'passed'])
  assert.deepEqual(result.caseResults?.[2]?.passedAssertions, [])
  assert.match(result.caseResults?.[2]?.error ?? '', /没有执行任何业务断言/)
  assert.equal(result.caseResults?.[1]?.startedFromUrl, new URL('/continued', targetUrl).href)
  assert.equal(result.caseResults?.[1]?.continuation, 'reused_current_page')
  assert.equal(result.caseResults?.[1]?.contractFingerprint, 'second')
  assert.ok(result.caseResults?.[1]?.startedFromSnapshotId)
  assert.equal(result.caseResults?.[1]?.steps.length, 2)
  assert.equal(result.caseResults?.[1]?.screenshots.length, 1)
  await stat(result.caseResults![1]!.tracePath!)
})
