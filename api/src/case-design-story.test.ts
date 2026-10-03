import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer as createViteServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { CaseDesign, DesignRun, DesignReviewDraft, DesignPublication, RequirementFact } from '@quality-ai/contracts/case-design'
import CaseDesignProvider from '../../evals/case-design/provider'
import evaluationTests from '../../evals/case-design/samples'
import checkEvaluation from '../../evals/case-design/assertions'

test('故事 A 后端：冲突材料到三类搜索、人工口径、局部重生成、不可变发布导出',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-story-a-'))
  process.env.QUALITY_AI_DATABASE_PATH=join(directory,'story.sqlite')
  process.env.QUALITY_AI_DATA_ROOT=directory
  const {createApiServer}=await import('./app')
  const {database}=await import('./storage/database')
  const api=createApiServer()
  let web:Awaited<ReturnType<typeof createViteServer>>|undefined
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  const calls:string[]=[]
  const strategies=['visible_option_full','visible_option_substring','non_matching_option_query']
  const model=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const prompt=body.instructions as string
    const stage=prompt.match(/阶段：(\w+)/)?.[1]??'extracting';calls.push(stage)
    let text=body.input[0].content.split('\n\nReturn only')[0]
    if(stage==='extracting')text=text.slice(text.indexOf('：')+1)
    const input=JSON.parse(text)
    let output:unknown
    if(stage==='extracting')output={facts:input.blocks.map((block:{documentId:string;id:string;text:string},index:number)=>({id:`f${index}`,statement:block.text,kind:'explicit',evidence:[{documentId:block.documentId,blockId:block.id,quote:block.text}],relatedQuestionIds:[]})),questions:[]}
    else if(stage==='modeling'){
      const facts=(input.facts as RequirementFact[]).map((fact,index)=>({...fact,id:`m${index}`,sourceFactIds:[fact.id]}))
      output={consolidatedFacts:facts,conflicts:[{id:'conflict',factIds:facts.map(item=>item.id),question:'匹配是否区分大小写？',evidence:facts.flatMap(item=>item.evidence)}]}
    }else if(stage==='planning')output={scenarios:strategies.map((strategy,index)=>({id:`s${index}`,factIds:input.facts.map((item:{id:string})=>item.id),questionIds:['conflict'],title:strategy,testIntent:`验证 ${strategy}`,coverage:index===2?'negative':'positive'}))}
    else if(stage==='generating'){
      const strategy=strategies[Number(input.scenario.id.slice(1))]
      output={cases:[{title:strategy,verification:'browser',verificationReason:'输入、候选及高亮可观察',contract:{objective:`验证 ${strategy}`,preconditions:['打开完整候选列表'],steps:[`按 ${strategy} 选择运行时数据并输入`],expectedAssertions:[strategy==='non_matching_option_query'?'显示无匹配结果':'来源选项存在且匹配文字高亮'],dataBindings:[{id:'query',label:'搜索词',mode:'runtime_dom',strategy,targetHint:'搜索框',businessIntent:strategy,constraints:{mustComeFromCurrentDom:true,mustBePartialOfSource:strategy==='visible_option_substring'},...(strategy==='non_matching_option_query'?{optionUniverse:{completeness:'complete_local',options:['Alpha','Beta'],evidence:'合成 PRD 明确完整本地候选为 Alpha、Beta；执行仍需 DOM 核实'}}:{})}],forbiddenBehaviors:['不使用猜测的账号数据'],uncertainties:[]}}]}
    }else output={issues:[]}
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({output_text:JSON.stringify(output)}))
  })
  try{
    await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve))
    process.env.MODEL_API_KEY='synthetic-story-key'
    process.env.MODEL_BASE_URL=`http://127.0.0.1:${(model.address() as AddressInfo).port}`
    await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve))
    const origin=`http://127.0.0.1:${(api.address() as AddressInfo).port}`
    async function request(path:string,body?:unknown){const response=await fetch(origin+path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result}
    const design:CaseDesign=(await request('/api/case-designs',{name:'故事 A 合成材料',files:[{fileName:'prd.md',role:'prd',content:'完整搜索、部分词高亮及无匹配搜索。区分大小写。完整本地候选只有 Alpha、Beta。'},{fileName:'方案.md',role:'interface',content:'搜索不区分大小写。'}]})).design
    const root=`/api/case-designs/${design.id}`
    async function stage(name:DesignRun['stage'],options:Record<string,unknown>={}){
      const {run}=await request(root+'/runs',{stage:name,expectedRevision:1,...options})
      for(let i=0;i<300;i++){
        const current:DesignRun=(await request(root)).runs.find((item:DesignRun)=>item.id===run.id)
        if(current.status==='completed')return current
        assert.ok(!['failed','cancelled','interrupted'].includes(current.status),current.error)
        await new Promise(resolve=>setTimeout(resolve,10))
      }throw new Error('本地夹具阶段未在期限完成')
    }
    const extracted=await stage('extracting')
    assert.equal(extracted.output.facts.length,2)
    const modeled=await stage('modeling')
    assert.equal(modeled.output.factModel!.conflicts.length,1)
    const planned=await stage('planning')
    const generated=await stage('generating')
    assert.deepEqual(generated.output.cases!.map(item=>item.contract.dataBindings[0].strategy),strategies)
    const checked=await stage('checking')
    const draft:DesignReviewDraft=(await request(root+`/runs/${checked.id}/review-draft`)).draft
    for(const item of Object.values(draft.content.cases)){item.status='confirmed';item.contract.uncertainties=[];item.contract.expectedAssertions.push('按人工确认的大小写敏感规则验证')}
    draft.content.questionDecisions.conflict='以主 PRD 为准，区分大小写；补充方案此条不采纳'
    for(const issue of checked.output.issues??[])draft.content.issueDecisions[issue.id]={status:'addressed',reason:'合成审核决定已写入所有最终断言'}
    const unchanged=generated.output.cases![0]
    draft.content.cases[unchanged.id].contract.objective='人工修改的完整搜索目标'
    await request(root+'/reviews',{runId:checked.id,expectedRevision:0,review:draft.content})
    const first:DesignPublication=(await request(root+'/publish',{expectedRevision:1})).publication
    const assets=(await request(`/api/cases?sourceType=case_design&sourceId=${design.id}`)).cases
    assert.equal(assets.length,3)
    assert.ok(assets.every((asset:{resolved:{readiness:{agent:{executable:boolean};plan:{executable:boolean}}}})=>asset.resolved.readiness.agent.executable&&asset.resolved.readiness.plan.executable),'完整运行时策略在两种模式中都应可进入执行准备，实际动作能力仍须执行时验证')
    assert.deepEqual(assets.map((asset:{finalContract:unknown})=>asset.finalContract),first.snapshot.cases.map(item=>item.contract))
    for(const mode of ['agent','plan']){
      const prepared=await request('/api/cases/prepare-execution',{mode,targetUrl:'https://example.test/search',cases:assets.map((asset:{id:string;revision:number;resolved:{contractFingerprint:string}})=>({caseId:asset.id,revision:asset.revision,contractFingerprint:asset.resolved.contractFingerprint}))})
      assert.deepEqual(prepared.preparation.snapshots.map((snapshot:{resolved:{contract:unknown}})=>snapshot.resolved.contract),first.snapshot.cases.map(item=>item.contract),`${mode} 执行预览必须与发布版本一致`)
    }
    const markdown=await (await fetch(origin+root+`/publications/${first.id}/markdown`)).text()
    assert.match(markdown,/人工修改的完整搜索目标/)
    assert.match(markdown,/区分大小写/)
    const partial=await stage('generating',{upstreamRunId:planned.id,regeneration:{baseRunId:checked.id,scenarioIds:['s1']}})
    assert.equal(partial.statistics.calls,1)
    assert.deepEqual(partial.output.cases!.find(item=>item.id===unchanged.id),unchanged)
    const rechecked=await stage('checking',{upstreamRunId:partial.id})
    const next:DesignReviewDraft=(await request(root+`/runs/${rechecked.id}/review-draft`)).draft
    assert.equal(next.inheritedCaseIds.length,2)
    assert.equal(next.content.cases[unchanged.id].contract.objective,'人工修改的完整搜索目标')
    const replacement=rechecked.output.cases!.find(item=>item.scenarioId==='s1')!
    assert.equal(next.content.cases[replacement.id].status,'draft')
    next.content.cases[replacement.id].status='confirmed';next.content.cases[replacement.id].contract.uncertainties=[]
    next.content.cases[replacement.id].contract.expectedAssertions.push('按人工确认的大小写敏感规则验证')
    for(const issue of rechecked.output.issues??[])next.content.issueDecisions[issue.id]={status:'addressed',reason:'重新核实冲突决定和断言'}
    await request(root+'/reviews',{runId:rechecked.id,expectedRevision:next.expectedRevision,review:next.content})
    const second:DesignPublication=(await request(root+'/publish',{expectedRevision:2})).publication
    assert.equal(second.version,2)
    assert.deepEqual((await request(root+`/publications/${first.id}`)).publication,first)
    assert.equal(await(await fetch(origin+root+`/publications/${first.id}/markdown`)).text(),markdown)
    assert.equal(second.snapshot.cases.find(item=>item.id===unchanged.id)!.contract.objective,'人工修改的完整搜索目标')
    assert.deepEqual(new Set([extracted,modeled,planned,generated,checked].flatMap(run=>run.skills.map(skill=>skill.id))),new Set(['requirement-facts','test-data-design','case-quality-review']))
    assert.equal(calls.filter(stage=>stage==='generating').length,4)
    assert.equal(JSON.stringify(second).includes('synthetic-story-key'),false)
    assert.equal(evaluationTests().length,12)
    assert.throws(()=>new CaseDesignProvider({config:{variant:'legacy',legacySourceHash:'changed'}}),/基线发生变化/)
    process.env.QUALITY_AI_EVAL_MODE='stub'
    const evalInput=JSON.stringify({sampleId:'story-smoke',documents:design.documents.map(document=>({fileName:document.fileName,role:document.role,content:document.blocks.map(block=>block.text).join('\n')}))})
    const providerOutputs=[]
    for(const variant of ['pipeline','skills'] as const){
      const result=await new CaseDesignProvider({config:{variant}}).callApi(evalInput)
      assert.equal(result.error,undefined)
      const output=JSON.parse(result.output!)
      assert.equal(output.evidenceMode,'stub')
      assert.equal(output.humanReview,'pending')
      assert.equal(output.stages.length,5)
      assert.equal(output.output.cases.length,3)
      assert.equal(output.stages.flatMap((run:DesignRun)=>run.skills).length>0,variant==='skills')
      assert.equal(result.output!.includes('synthetic-story-key'),false)
      assert.equal(checkEvaluation(result.output!).pass,true)
      const invalid=structuredClone(output);invalid.stages[0].inputHash='wrong-version'
      assert.equal(checkEvaluation(JSON.stringify(invalid)).pass,false)
      providerOutputs.push(output)
    }
    assert.equal(providerOutputs[0].inputHash,providerOutputs[1].inputHash)
    assert.equal(providerOutputs[0].modelConfigHash,providerOutputs[1].modelConfigHash)
    // No page.route mocks: browser -> Vite proxy -> real HTTP API -> temporary SQLite.
    web=await createViteServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0,proxy:{'/api':origin}}})
    await web.listen()
    browser=await chromium.launch({headless:true})
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
    await page.goto(`http://127.0.0.1:${(web.httpServer!.address() as AddressInfo).port}/#/case-designs/${design.id}?runId=${rechecked.id}&caseId=${unchanged.id}&publicationId=${second.id}`)
    await page.getByRole('heading',{name:'发布 v2 · 只读快照',exact:true}).waitFor()
    await page.getByRole('heading',{name:'原文审查范围',exact:true}).waitFor()
    await page.getByText('已审查 2 块 · 未完成 0 块。',{exact:false}).waitFor()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'人工修改的完整搜索目标')
    await page.getByLabel('测试目标',{exact:true}).fill('浏览器保存的最终完整搜索目标')
    await page.getByRole('button',{name:'保存人工审核',exact:true}).click()
    await page.getByText('已保存审核 v3，尚未发布，也不代表测试通过。',{exact:true}).waitFor()
    await page.getByRole('button',{name:'发布已保存审核 v3',exact:true}).click()
    await page.getByRole('heading',{name:'发布 v3 · 只读快照',exact:true}).waitFor()
    const third:DesignPublication=(await request(root+'/publications')).publications[0]
    assert.equal(third.snapshot.cases.find(item=>item.id===unchanged.id)!.contract.objective,'浏览器保存的最终完整搜索目标')
    assert.equal(await page.locator('.publication-preview').getByText('浏览器保存的最终完整搜索目标',{exact:true}).count(),1)
    const downloading=page.waitForEvent('download')
    await page.getByRole('link',{name:'下载此版本 Markdown',exact:true}).click()
    const stream=await(await downloading).createReadStream();assert.ok(stream)
    const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk))
    const download=Buffer.concat(chunks).toString()
    assert.match(download,/浏览器保存的最终完整搜索目标/)
    assert.equal(download,await(await fetch(origin+root+`/publications/${third.id}/markdown`)).text())
    await page.reload()
    await page.getByRole('heading',{name:'发布 v3 · 只读快照',exact:true}).waitFor()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'浏览器保存的最终完整搜索目标')
    assert.deepEqual(errors,[])
  }finally{
    await browser?.close();await web?.close()
    api.closeAllConnections();model.closeAllConnections()
    await Promise.all([new Promise<void>(resolve=>api.close(()=>resolve())),new Promise<void>(resolve=>model.close(()=>resolve()))])
    database.close();rmSync(directory,{recursive:true,force:true})
  }
})
