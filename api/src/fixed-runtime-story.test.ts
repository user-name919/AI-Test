import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ResolvedCaseExecutionContract, TestDataBinding, PageSnapshot } from '@quality-ai/contracts'
import { generateFixedPlan, proposeFixedPlanData } from './modules/cases/fixed-plan-model'
import { getModelConfig } from './model-config'
import { runAutomationPlan } from './automation/playwright-runner'

test('固定规划与运行时模型提议串联三策略，首条错误预期失败后同页面继续',async t=>{
  const artifactRoot=await mkdtemp(join(tmpdir(),'quality-ai-fixed-runtime-story-'))
  t.after(()=>rm(artifactRoot,{recursive:true,force:true}))
  let navigations=0,proposals=0,dropSource=false
  const web=createServer((_request,response)=>{
    navigations++;response.setHeader('content-type','text/html; charset=utf-8')
    response.end(`<input aria-label="搜索"><button onclick="document.querySelector('input').value='';render()">重置</button><ul role="listbox"></ul><p id="empty"></p><script>const names=['AlphaBook','BetaBook'];function render(){const q=document.querySelector('input').value;const found=${dropSource}&&q?[]:names.filter(n=>n.includes(q));document.querySelector('ul').innerHTML=found.map(n=>'<li role="option">'+n+'</li>').join('');document.querySelector('#empty').textContent=found.length?'':'暂无数据'}document.querySelector('input').oninput=render;render()</script>`)
  })
  await new Promise<void>(resolve=>web.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>web.close(()=>resolve())))
  const targetUrl=`http://127.0.0.1:${(web.address() as AddressInfo).port}`
  const model=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const prompt=(body.input[0].content as string).split('\n\nReturn only')[0]
    let output:unknown
    if(prompt.includes('你只为固定测试计划')){
      proposals++
      const binding=JSON.parse(prompt.split('数据契约：')[1].split('\n当前页面：')[0]) as TestDataBinding
      const snapshot=JSON.parse(prompt.split('当前页面：')[1]) as PageSnapshot
      const option=snapshot.elements.find(item=>item.role==='option')!
      output={type:'resolve_test_data',snapshotId:snapshot.snapshotId,bindingId:binding.id,sourceElementRef:option.ref,value:binding.strategy==='visible_option_full'?'AlphaBook':binding.strategy==='visible_option_substring'?'Alpha':'ZZZ',reason:'使用当前真实选项及契约范围'}
    }else{
      const contract=JSON.parse(prompt.split('最终执行契约（唯一执行依据）：')[1].split('\n用例标识：')[0])
      output={name:'合成固定规划',targetUrl,steps:[{action:'click',locator:{by:'role',value:'button',name:'重置'}},{action:'resolveTestData',bindingId:'query'},{action:'fill',locator:{by:'label',value:'搜索'},valueRef:'query'},contract.dataBindings[0].strategy==='visible_option_substring'?{action:'expectText',assertionIndex:0,valueRef:'query'}:{action:'expectText',assertionIndex:0,text:contract.expectedAssertions[0]}]}
    }
    response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(output)}))
  })
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve))
  t.after(()=>{model.closeAllConnections();return new Promise<void>(resolve=>model.close(()=>resolve()))})
  const config=getModelConfig({apiKey:'synthetic',baseUrl:`http://127.0.0.1:${(model.address() as AddressInfo).port}`,protocol:'openai-responses'})
  const casePlans=[]
  for(const [index,strategy] of (['visible_option_full','visible_option_substring','non_matching_option_query'] as const).entries()){
    const binding:TestDataBinding={id:'query',label:'查询',mode:'runtime_dom',strategy,targetHint:'搜索',businessIntent:'验证筛选',constraints:{mustComeFromCurrentDom:true,mustBePartialOfSource:strategy==='visible_option_substring',mustRemainAfterFiltering:strategy!=='non_matching_option_query'},...(strategy==='non_matching_option_query'?{optionUniverse:{completeness:'complete_local' as const,options:['AlphaBook','BetaBook'],evidence:'本地受控样例固定两项'}}:{})}
    const resolved:ResolvedCaseExecutionContract={caseKey:`0-TC-${index}`,title:strategy,requirementIndex:0,caseIndex:index,contractFingerprint:`frozen-${index}`,questionAssociation:{mode:'explicit',questionKeys:[]},resolvedQuestions:[],readiness:{agent:{executable:true},plan:{executable:true}},contract:{objective:'按审核口径筛选',preconditions:[],steps:['重置列表后取实际值筛选'],expectedAssertions:[index===0?'人工故意错误预期':index===1?'匹配来源仍存在':'暂无数据'],dataBindings:[binding],forbiddenBehaviors:['禁止改预期'],uncertainties:[]}}
    const generated=await generateFixedPlan(targetUrl,resolved,undefined,config)
    casePlans.push({caseKey:resolved.caseKey,title:resolved.title,contractFingerprint:resolved.contractFingerprint,contract:resolved.contract,steps:generated.steps})
  }
  const result=await runAutomationPlan({name:'三策略',targetUrl,steps:casePlans[0].steps,casePlans},undefined,{artifactRoot,resolveTestData:(binding,snapshot)=>proposeFixedPlanData(binding,snapshot,undefined,config)})
  assert.deepEqual(result.caseResults?.map(item=>item.status),['failed','passed','passed'],JSON.stringify(result.caseResults?.map(item=>item.error)))
  assert.deepEqual(result.caseResults?.map(item=>item.resolvedDataBindings[0]?.value),['AlphaBook','Alpha','ZZZ'])
  assert.equal(proposals,3)
  assert.ok(navigations<=2,'同页面继续，不按用例重新导航（可包含favicon）')
  assert.ok(result.caseResults?.every(item=>item.resolvedDataBindings[0]?.snapshotId))
  assert.match(result.caseResults?.[0].error??'',/人工故意错误预期/)
  dropSource=true
  const missing=await runAutomationPlan({name:'筛选回归',targetUrl,steps:casePlans[1].steps,casePlans:[casePlans[1]]},undefined,{artifactRoot,resolveTestData:(binding,snapshot)=>proposeFixedPlanData(binding,snapshot,undefined,config)})
  assert.equal(missing.caseResults?.[0].status,'failed')
  assert.match(missing.caseResults?.[0].error??'',/来源 option.*未保留/)
})
