import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { automationStepSchema, type AutomationPlan } from '@quality-ai/contracts'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
import { runAutomationPlan } from './automation/playwright-runner'
import { assertFixedCount } from './automation/fixed-locator-assertion'

test('固定计数支持空态、异步变化与框架/Shadow范围；缺失容器不能假通过且继续下条', async t => {
  const artifactRoot=await mkdtemp(join(tmpdir(),'quality-ai-fixed-count-'))
  t.after(()=>rm(artifactRoot,{recursive:true,force:true}))
  const server=createServer((request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8')
    if(request.url==='/frame'){response.end('<section aria-label="框架列表" role="listbox"><div role="option">框架选项</div></section>');return}
    response.end(`<div role="option">背景选项</div><section role="listbox" aria-label="搜索结果" style="min-height:30px"></section>
      <button onclick="setTimeout(()=>document.querySelector('section').innerHTML='<div role=option>数学</div><div role=option>语文</div>',200)">加载</button>
      <div id="shadow"></div><iframe title="结果框架" src="/frame"></iframe>
      <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<section role="listbox" aria-label="组件列表"><div role="option">组件选项</div></section>'</script>`)
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
  const count=(name:string,value:number):AutomationPlan['steps'][number]=>({action:'expectCount',count:value,assertionIndex:0,locator:{by:'role',value:'option',scope:[{by:'role',value:'listbox',name,exact:true}]}})
  const cases:Array<{title:string;steps:AutomationPlan['steps']}>= [
    {title:'缺失容器不能解释为无选项',steps:[count('不存在',0)]},
    {title:'当前真实列表确实为空',steps:[count('搜索结果',0)]},
    {title:'等待异步列表两项',steps:[{action:'click',locator:{by:'role',value:'button',name:'加载',exact:true}},count('搜索结果',2)]},
    {title:'组件内部列表数量',steps:[count('组件列表',1)]},
    {title:'框架内部而不是背景数量',steps:[{action:'expectCount',count:1,assertionIndex:0,locator:{by:'role',value:'option',scope:[{by:'role',value:'listbox',name:'框架列表',exact:true}],framePath:[{by:'css',value:'iframe[title="结果框架"]'}]}}]},
  ]
  const result=await runAutomationPlan({name:'计数',targetUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,steps:[],casePlans:cases.map((item,index)=>({...item,caseKey:`0-TC-${index}`,contractFingerprint:`fp-${index}`,contract:{objective:item.title,preconditions:[],steps:['验证实际列表'],expectedAssertions:[item.title],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}))},undefined,{artifactRoot})
  assert.deepEqual(result.caseResults?.map(item=>item.status),['failed','passed','passed','passed','passed'],JSON.stringify(result.caseResults?.map(item=>item.error)))
  assert.deepEqual(result.caseResults?.[0].passedAssertions,[])
  assert.deepEqual(result.caseResults?.[4].passedAssertions,['assertion-0'])
  assert.match(describeAutomationStep(count('搜索结果',0),0).title,/搜索结果.*范围内.*数量为 0/)
  assert.equal(automationStepSchema.safeParse({...count('搜索结果',0),count:-1}).success,false)
  assert.equal(automationStepSchema.safeParse({...count('搜索结果',0),count:1.5}).success,false)
})

test('固定计数等待可取消，不重复读取或误计成功',async()=>{
  const controller=new AbortController()
  let calls=0
  await assert.rejects(assertFixedCount(async()=>{calls++;controller.abort();return 1},0,controller.signal),/abort/i)
  assert.equal(calls,1)
})
