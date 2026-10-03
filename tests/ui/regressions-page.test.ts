import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { ChangeSet, RegressionAnalysis } from '@quality-ai/contracts/regressions'

test('回归页面显式范围预览、刷新冻结、启动取消和源码证据可读', async () => {
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string')
  const browser=await chromium.launch({headless:true})
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
    const sha='a'.repeat(40);const base='b'.repeat(40)
    const range:ChangeSet={id:'11111111-1111-4111-8111-111111111111',projectId:'fixture',status:'preview',factsHash:'c'.repeat(64),createdAt:'now',facts:{comparison:{mode:'endpoints',targetRef:'feature',baseRef:'main'},targetSha:sha,requestedBaseSha:base,effectiveBaseSha:base,commits:[{sha,parents:[base],subject:'共享组件重构'}],diffs:[{baseSha:base,targetSha:sha,files:[{status:'M',path:'src/shared.ts'}],patch:'公开合成 Diff'}],omittedCommitShas:[],omittedRangeBases:[],dirty:true,capturedAt:'now',warnings:['未提交内容不纳入范围']}}
    const analysis:RegressionAnalysis={id:'22222222-2222-4222-8222-222222222222',projectId:'fixture',changeSetId:range.id,factsHash:range.factsHash,targetSha:sha,status:'running',stage:'generating',createdAt:'now',updatedAt:'now',sourceImpact:{method:'static-import-candidates-v1',trees:[{sha,changedFiles:['src/shared.ts'],scannedFiles:['src/shared.ts'],skippedFiles:[{path:'large.ts',reason:'文件预算'}],edges:[{from:'page-a.ts',to:'src/shared.ts',line:1,specifier:'./src/shared'}],affectedFiles:['page-a.ts','page-b.ts'],unresolved:[{path:'page-b.ts',line:2,expression:'@/dynamic',reason:'别名未解析'}]}],skippedShas:[],warnings:['静态候选，不证明真实行为']},generation:{promptVersion:'fixture-v1',model:'fixture',reviewStatus:'pending',pendingEvidenceIds:['e2'],omittedEvidenceIds:[],limitations:['部分依据尚未处理'],batches:[]}}
    let previewCalls=0;let starts=0;let freezeCalls=0
    await page.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname
      let payload:unknown={}
      if(path==='/api/projects')payload={projects:[{id:'fixture',name:'示例项目',connected:true}]}
      else if(path.endsWith('/git/refs'))payload={branches:[{name:'main',sha:base},{name:'feature',sha}],truncated:false}
      else if(path==='/api/change-sets/preview'){
        previewCalls++;const body=route.request().postDataJSON()
        assert.equal(body.projectId,'fixture');assert.deepEqual(body.comparison,{mode:'endpoints',targetRef:'feature',baseRef:'main'})
        payload={changeSet:range}
      }else if(path.endsWith('/freeze')){freezeCalls++;assert.equal(route.request().postDataJSON().expectedHash,range.factsHash);range.status='frozen';payload={changeSet:range}}
      else if(path===`/api/change-sets/${range.id}`)payload={changeSet:range}
      else if(path==='/api/regressions'&&route.request().method()==='POST'){starts++;assert.equal(range.status,'frozen');payload={regression:analysis}}
      else if(path.endsWith('/cancel')){analysis.status='cancelled';analysis.error='用户取消，部分成果保留';payload={regression:analysis}}
      else if(path===`/api/regressions/${analysis.id}`)payload={regression:analysis}
      else if(path==='/api/regressions')payload={regressions:[{...analysis,completedBatches:0,analyzedTrees:1}]}
      else if(path==='/api/change-sets')payload={changeSets:[{...range,targetSha:sha,fileCount:1}]}
      await route.fulfill({json:payload})
    })
    await page.goto(`http://127.0.0.1:${address.port}/#/regressions`)
    await page.getByRole('link',{name:'创建变更回归',exact:true}).click()
    const previewButton=page.getByRole('button',{name:'预览变更范围',exact:true})
    assert.equal(await previewButton.isDisabled(),true)
    await page.getByLabel('源码项目',{exact:true}).selectOption('fixture')
    await page.getByLabel('目标本地分支或 SHA',{exact:true}).fill('feature')
    await page.getByLabel('基线本地分支或 SHA',{exact:true}).fill('main')
    page.once('dialog',dialog=>dialog.dismiss())
    await page.getByRole('link',{name:'返回回归任务列表'}).click()
    assert.match(page.url(),/regressions\/new/,'未保存配置可取消离开')
    await previewButton.click()
    await page.getByRole('heading',{name:'待确认的范围预览'}).waitFor()
    await page.getByText('未提交内容不纳入范围',{exact:true}).waitFor()
    await page.getByText('提交记录（1）',{exact:true}).click()
    await page.getByText('共享组件重构',{exact:true}).waitFor()
    await page.reload()
    await page.getByRole('heading',{name:'待确认的范围预览'}).waitFor()
    assert.equal(previewCalls,1,'刷新只读取已保存预览')
    await page.getByRole('button',{name:'确认冻结并分析'}).click()
    await page.getByRole('button',{name:'取消分析',exact:true}).waitFor()
    assert.equal(starts,1);assert.equal(freezeCalls,1)
    await page.getByText(/影响候选 2 个/).click()
    await page.getByText('page-a.ts',{exact:true}).waitFor()
    await page.getByText(/别名未解析/).waitFor()
    await page.reload()
    await page.getByRole('button',{name:'取消分析',exact:true}).waitFor()
    page.once('dialog',dialog=>dialog.accept())
    await page.getByRole('button',{name:'取消分析',exact:true}).click()
    await page.getByText('用户取消，部分成果保留',{exact:true}).waitFor()
    await page.getByRole('heading',{name:'源码影响候选'}).waitFor()
    await page.getByRole('button',{name:'使用指引'}).click()
    await page.getByRole('heading',{name:'如何回归一次重构'}).waitFor()
    await page.setViewportSize({width:390,height:844})
    await page.screenshot({path:'/private/tmp/quality-ai-regressions.png',fullPage:true})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    assert.deepEqual(errors,[])
  }finally{await browser.close();await server.close()}
})
