import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { CaseDesign, DesignRun, DesignReview, DesignPublication } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from '../../api/src/modules/case-design/documents'
import { buildReviewDraft, findBaselineReview } from '../../api/src/modules/case-design/review-draft'

test('独立设计页面导入、阶段条件、原文定位与刷新，无需环境', async () => {
  const documents=createEvidenceDocuments([{fileName:'需求.md',role:'prd',content:'# 搜索规则\n\n支持部分关键词搜索。'}])
  const design:CaseDesign={id:'design-fixture',name:'独立搜索设计',revision:1,inputHash:'fixture',documents,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z'}
  const block=documents[0].blocks[1]
  let runs:DesignRun[]=[]
  let imported=false
  let failedOnce=true
  let reviews:DesignReview[]=[]
  let reviewConflict=true
  const publications:DesignPublication[]=[]
  let publishBlocked=true
  let invalidDownload=true
  let executionInput:Record<string,unknown>|undefined
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0}})
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  try {
    await server.listen()
    const address=server.httpServer!.address(); assert.ok(address && typeof address!=='string')
    browser=await chromium.launch({headless:true})
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/api/**',async route=> {
      const path=new URL(route.request().url()).pathname
      if(path.startsWith('/api/cases/published')&&path.endsWith('/contract')){
        const published=publications[0];const item=published.snapshot.cases[0]
        assert.equal(decodeURIComponent(path),`/api/cases/published:${published.id}:${item.id}/contract`)
        await route.fulfill({json:{asset:{id:`published:${published.id}:${item.id}`,title:item.title,revision:published.version,source:{type:'case_design',publicationId:published.id},resolved:{caseKey:'published:published:case-1',title:item.title,contract:item.contract,contractFingerprint:'published-fingerprint',readiness:{agent:{executable:true},plan:{executable:false,reason:'固定计划需要运行时数据预检'}}}}}});return
      }
      if(path==='/api/environments'){await route.fulfill({json:{environments:[{id:'env-a',name:'环境甲',baseUrl:'https://example.test',targetUrl:'https://example.test/search',hasStorageState:true},{id:'env-b',name:'环境乙',baseUrl:'https://example.test',targetUrl:'https://example.test/second',hasStorageState:false}]}});return}
      if(path==='/api/projects'){await route.fulfill({json:{projects:[{id:'source',name:'合成源码',connected:true,targetOrigins:['https://example.test'],branch:'local',commit:'abc'}]}});return}
      if(path==='/api/cases/prepare-execution'){
        const body=route.request().postDataJSON();assert.equal(body.cases[0].contractFingerprint,'published-fingerprint')
        assert.equal(body.cases[0].caseId,'published:published:case-1')
        await route.fulfill({json:{preparation:{snapshots:[{caseId:body.cases[0].caseId,revision:1,resolved:{title:publications[0].snapshot.cases[0].title,contract:publications[0].snapshot.cases[0].contract,contractFingerprint:'published-fingerprint',resolvedQuestions:[]}}]}}});return
      }
      if(path==='/api/execution-jobs'&&route.request().method()==='POST'){
        executionInput=route.request().postDataJSON();await route.fulfill({status:202,json:{job:{id:'job-fixture'}}});return
      }
      if(path==='/api/execution-jobs/job-fixture'){await route.fulfill({json:{job:{id:'job-fixture',status:'queued',mode:'agent',snapshots:[],targetUrl:'https://example.test'}}});return}
      if(path==='/api/execution-jobs/job-fixture/events'){await route.fulfill({json:{events:[],nextCursor:0,frame:null}});return}
      if(path.endsWith('/review-draft')){const run=runs.find(item=>path.includes(`/runs/${item.id}/`))!;await route.fulfill({json:{draft:buildReviewDraft(run,runs,reviews)}});return}
      if(path.endsWith('/comparison')){
        const run=runs.find(item=>path.includes(`/runs/${item.id}/`))!
        const base=runs.find(item=>item.id===run.regeneration!.baseRunId)!
        const human=findBaselineReview(run,runs,reviews)
        await route.fulfill({json:{comparison:{runId:run.id,status:run.status,baseRunId:base.id,reviewId:human?.id??null,reviewRevision:human?.revision??0,scenarios:run.regeneration!.scenarioIds.map(id=>{const before=base.output.cases!.filter(item=>item.scenarioId===id);return {scenarioId:id,before,suggestions:run.output.cases!.filter(item=>item.scenarioId===id),human:before.map(item=>({caseId:item.id,review:human?.content.cases[item.id]??null}))}})}}});return
      }
      if(path.endsWith('/publications')){await route.fulfill({json:{publications}});return}
      if(path.endsWith('/publish')) {
        assert.equal(route.request().postDataJSON().expectedRevision,2)
        if(publishBlocked){publishBlocked=false;await route.fulfill({status:409,json:{error:'发布条件尚未满足',reasons:['合成阻塞：请先确认范围']}});return}
        const item=reviews[0].content.cases['case-1']
        const publication:DesignPublication={id:'published',designId:design.id,version:1,createdAt:design.createdAt,contentHash:'fixture-hash',snapshot:{design:structuredClone(design),run:structuredClone(runs[0]),review:structuredClone(reviews[0]),cases:[{id:'case-1',scenarioId:'s1',factIds:['f1'],questionIds:[],title:item.title,contract:structuredClone(item.contract),verification:item.verification,verificationReason:item.verificationReason}]}}
        publications.push(publication);await route.fulfill({status:201,json:{publication}});return
      }
      if(path.endsWith('/markdown')) {
        if(invalidDownload){invalidDownload=false;await route.fulfill({contentType:'text/html',body:'<h1>服务暂不可用</h1>'});return}
        await route.fulfill({contentType:'text/markdown',headers:{'content-disposition':'attachment; filename="case-design-v1.md"'},body:'# 合成人工版本\n人工修改后的目标'});return
      }
      if(path.endsWith('/reviews')) {
        if(route.request().method()==='GET'){await route.fulfill({json:{reviews}});return}
        const body=route.request().postDataJSON()
        if(reviewConflict){reviewConflict=false;reviews=[{id:'other-review',designId:design.id,runId:'checked',revision:1,inputHash:design.inputHash,inputRevision:1,createdAt:design.createdAt,content:body.review}];await route.fulfill({status:409,json:{error:'版本冲突',review:reviews[0]}});return}
        assert.equal(body.expectedRevision,1)
        const review={...reviews[0],id:'saved-review',revision:2,content:body.review};reviews=[review,...reviews]
        await route.fulfill({status:201,json:{review}});return
      }
      if(path==='/api/case-designs' && route.request().method()==='POST') {
        const body=route.request().postDataJSON()
        assert.equal(body.files[0].content,'支持部分关键词搜索。')
        if(failedOnce){failedOnce=false;await route.fulfill({status:400,json:{error:'合成解析失败，请重试'}});return}
        imported=true; await route.fulfill({status:201,json:{design}}); return
      }
      if(path==='/api/case-designs'){await route.fulfill({json:{designs:imported?[design]:[]}});return}
      if(path===`/api/case-designs/${design.id}`){await route.fulfill({json:{design,runs}});return}
      if(path.endsWith('/runs')) {
        const body=route.request().postDataJSON()
        if(body.stage==='generating'){
          assert.deepEqual(body.regeneration,{baseRunId:'regenerated',scenarioIds:['s2']})
          assert.equal(body.upstreamRunId,'planning-fixture')
          const run={...structuredClone(runs[0]),id:'partial-generated',stage:'generating' as const,regeneration:body.regeneration,upstreamRunId:body.upstreamRunId}
          runs.unshift(run);await route.fulfill({status:202,json:{run}});return
        }
        if(body.stage==='checking'){
          assert.equal(body.upstreamRunId,'partial-generated')
          const run={...structuredClone(runs[0]),id:'partial-checked',stage:'checking' as const,upstreamRunId:body.upstreamRunId}
          runs.unshift(run);await route.fulfill({status:202,json:{run}});return
        }
        assert.equal(body.stage,'extracting')
        runs=[{id:'run-fixture',designId:design.id,attempt:1,stage:'extracting',status:'completed',inputRevision:1,inputHash:'fixture',model:'synthetic',modelConfigHash:'hash',protocol:'fixture',promptVersion:'test',skills:[{id:'requirement-facts',version:'1.0.0',hash:'fixture'}],createdAt:design.createdAt,updatedAt:design.createdAt,statistics:{calls:1,inputCharacters:50,outputCharacters:50},output:{facts:[{id:'f1',statement:'支持部分关键词搜索',kind:'explicit',relatedQuestionIds:[],evidence:[{documentId:documents[0].id,blockId:block.id,quote:block.text}]}],questions:[],processedBlockIds:[block.id],unprocessedBlockIds:[]}}]
        await route.fulfill({status:202,json:{run:runs[0]}});return
      }
      await route.fulfill({status:404,json:{error:'不应请求环境或旧分析接口'}})
    })
    await page.goto(`http://127.0.0.1:${address.port}/#/case-designs`)
    await page.getByLabel('任务名称',{exact:true}).fill(design.name)
    await page.locator('input[type=file]').setInputFiles({name:'需求.md',mimeType:'text/markdown',buffer:Buffer.from('支持部分关键词搜索。')})
    await page.getByRole('button',{name:'创建并保存材料'}).click()
    await page.getByRole('alert').filter({hasText:'合成解析失败'}).waitFor()
    assert.equal(await page.getByLabel('任务名称',{exact:true}).inputValue(),design.name)
    await page.getByRole('button',{name:'创建并保存材料'}).click()
    await page.getByRole('heading',{name:design.name,exact:true}).waitFor()
    assert.equal(await page.getByRole('button',{name:'生成用例草稿',exact:true}).isDisabled(),true)
    await page.getByRole('button',{name:'提取需求事实',exact:true}).click()
    await page.getByRole('button',{name:'查看依据：支持部分关键词搜索。',exact:true}).click()
    assert.equal(await page.locator('[data-selected=true]').count(),1)
    assert.equal(await page.getByRole('button',{name:'整理事实与冲突',exact:true}).isEnabled(),true)
    await page.getByLabel('查看阶段产物',{exact:true}).selectOption('run-fixture')
    await page.reload()
    await page.getByRole('button',{name:'查看依据：支持部分关键词搜索。',exact:true}).waitFor()
    assert.match(page.url(),/runId=run-fixture/)
    await page.getByRole('button',{name:'使用指引',exact:true}).click()
    await page.getByRole('heading',{name:'如何使用',exact:true}).waitFor()
    runs.unshift({...structuredClone(runs[0]),id:'checked',stage:'checking',attempt:2,output:{...structuredClone(runs[0].output),modelReviewCompleted:true,cases:[{id:'case-1',title:'部分关键词搜索',scenarioId:'s1',factIds:['f1'],questionIds:[],verification:'browser',verificationReason:'页面可观察',requiresReview:true,contract:{objective:'AI建议目标',preconditions:['打开搜索框'],steps:['从实际选项选择部分词'],expectedAssertions:['选项保留'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}]}})
    runs[0].output.generationAttempts=[{scenarioId:'s1',attempt:1,status:'invalid',response:'{"cases":[]}',responseTruncated:false,error:'至少需要一条用例'},{scenarioId:'s1',attempt:2,status:'validated',response:'合成修复响应',responseTruncated:true}]
    await page.reload()
    await page.getByLabel('查看阶段产物',{exact:true}).selectOption('checked')
    await page.getByText('场景 s1 · 第 1 次 · 结构校验失败',{exact:true}).click()
    await page.getByText('至少需要一条用例',{exact:true}).waitFor()
    await page.getByText('场景 s1 · 第 2 次 · 结构校验通过，待语义审核',{exact:true}).click()
    await page.getByText('响应过长，仅保留前 64000 字符；不能视为完整原文。',{exact:true}).waitFor()
    await page.getByLabel('测试目标',{exact:true}).fill('人工修改后的目标')
    await page.getByLabel('预期断言（每行一项）',{exact:true}).fill('匹配部分高亮\n来源选项仍存在')
    await page.getByLabel('审核状态',{exact:true}).selectOption('confirmed')
    assert.equal(await page.getByRole('button',{name:/发布已保存审核/}).isDisabled(),true)
    await page.reload()
    await page.getByText('已恢复当前标签页未保存草稿；保存时仍会校验服务端版本。',{exact:true}).waitFor()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'人工修改后的目标')
    await page.getByRole('button',{name:'保存人工审核',exact:true}).click()
    await page.getByText('审核版本已更新。草稿未覆盖，请对比最新记录后再保存。',{exact:false}).waitFor()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'人工修改后的目标')
    await page.getByRole('button',{name:'已对比，保留我的草稿并更新版本号',exact:true}).click()
    await page.getByRole('button',{name:'保存人工审核',exact:true}).click()
    await page.getByText('已保存审核 v2，尚未发布，也不代表测试通过。',{exact:true}).waitFor()
    assert.equal(await page.locator('.design-review-editor').evaluate(element=>getComputedStyle(element).position),'static')
    assert.ok((await page.getByRole('button',{name:'保存人工审核',exact:true}).boundingBox())!.width>100)
    assert.deepEqual(reviews[0].content.cases['case-1'].contract.expectedAssertions,['匹配部分高亮','来源选项仍存在'])
    assert.equal(runs[0].output.cases![0].contract.objective,'AI建议目标')
    await page.getByRole('button',{name:'发布已保存审核 v2',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'合成阻塞：请先确认范围'}).waitFor()
    await page.getByRole('button',{name:'发布已保存审核 v2',exact:true}).click()
    await page.getByRole('heading',{name:'发布 v1 · 只读快照',exact:true}).waitFor()
    assert.equal(await page.locator('.publication-preview').getByText('人工修改后的目标',{exact:true}).count(),1)
    await page.getByLabel('测试目标',{exact:true}).fill('尚未保存的新目标')
    assert.equal(await page.getByRole('button',{name:/发布已保存审核/}).isDisabled(),true)
    assert.equal(await page.locator('.publication-preview').getByText('人工修改后的目标',{exact:true}).count(),1)
    let downloads=0
    page.on('download',()=>downloads++)
    await page.getByRole('link',{name:'下载此版本 Markdown',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'服务器未返回 Markdown 文件'}).waitFor()
    assert.equal(downloads,0)
    const downloadPromise=page.waitForEvent('download')
    await page.getByRole('link',{name:'下载此版本 Markdown',exact:true}).click()
    const downloaded=await downloadPromise
    assert.equal(downloaded.suggestedFilename(),'case-design-v1.md')
    const stream=await downloaded.createReadStream()
    assert.ok(stream)
    const chunks:Buffer[]=[]
    for await(const chunk of stream)chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(),'# 合成人工版本\n人工修改后的目标')
    await page.reload()
    await page.getByRole('heading',{name:'发布 v1 · 只读快照',exact:true}).waitFor()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'尚未保存的新目标')
    assert.match(page.url(),/publicationId=published/)
    assert.ok((await page.locator('main').boundingBox())!.x<200)
    if(process.env.UI_DESIGN_SCREENSHOT_PATH) await page.screenshot({path:process.env.UI_DESIGN_SCREENSHOT_PATH,fullPage:true})
    if(process.env.UI_PUBLICATION_SCREENSHOT_PATH) await page.locator('.design-publications').screenshot({path:process.env.UI_PUBLICATION_SCREENSHOT_PATH})
    await page.setViewportSize({width:390,height:844})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
    runs[0].output.cases!.push({...structuredClone(runs[0].output.cases![0]),id:'old-second',scenarioId:'s2',title:'另一个场景'})
    reviews[0].content.cases['old-second']={...structuredClone(reviews[0].content.cases['case-1']),title:'人工第二场景'}
    reviews[0].content.cases['old-second'].contract.objective='以前人工确认的第二场景目标'
    const regenerated=structuredClone(runs[0])
    regenerated.id='regenerated';regenerated.attempt=3
    regenerated.regeneration={baseRunId:'checked',scenarioIds:['s2']}
    regenerated.output.cases![1].id='new-second'
    regenerated.output.cases![1].contract.objective='新场景建议，尚未人工确认'
    runs.unshift(regenerated)
    await page.reload()
    await page.getByLabel('查看阶段产物',{exact:true}).waitFor()
    page.once('dialog',dialog=>dialog.accept())
    await page.getByLabel('查看阶段产物',{exact:true}).selectOption('regenerated')
    await page.getByRole('status').filter({hasText:'保留 1 条未变化用例的人工口径'}).waitFor()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'人工修改后的目标')
    assert.equal(await page.getByLabel('审核状态',{exact:true}).inputValue(),'confirmed')
    await page.getByRole('navigation',{name:'审核用例列表'}).getByRole('button',{name:/另一个场景/}).click()
    assert.equal(await page.getByLabel('审核状态',{exact:true}).inputValue(),'draft')
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'新场景建议，尚未人工确认')
    assert.equal(reviews[0].content.cases['new-second'],undefined)
    await page.getByLabel('为“另一个场景”选择旧人工口径',{exact:true}).selectOption('old-second')
    page.once('dialog',dialog=>dialog.dismiss())
    await page.getByRole('button',{name:'保留所选人工口径到此草稿',exact:true}).click()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'新场景建议，尚未人工确认')
    page.once('dialog',dialog=>dialog.accept())
    await page.getByRole('button',{name:'保留所选人工口径到此草稿',exact:true}).click()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'以前人工确认的第二场景目标')
    assert.equal(await page.getByLabel('审核状态',{exact:true}).inputValue(),'draft')
    page.once('dialog',dialog=>dialog.accept())
    await page.getByRole('button',{name:'采用此新建议到草稿',exact:true}).click()
    assert.equal(await page.getByLabel('测试目标',{exact:true}).inputValue(),'新场景建议，尚未人工确认')
    assert.equal(reviews[0].content.cases['old-second'].contract.objective,'以前人工确认的第二场景目标')
    if(process.env.UI_COMPARISON_SCREENSHOT_PATH) await page.locator('.regeneration-comparison').screenshot({path:process.env.UI_COMPARISON_SCREENSHOT_PATH})
    runs[0].output.scenarios=[{id:'s1',title:'保留场景',testIntent:'保留人工决定',factIds:[],questionIds:[],coverage:'positive',requiresReview:true},{id:'s2',title:'更新场景',testIntent:'只更新第二个场景',factIds:[],questionIds:[],coverage:'positive',requiresReview:true}]
    const planning={...structuredClone(runs[0]),id:'planning-fixture',stage:'planning' as const}
    runs.push(planning)
    await page.reload()
    await page.getByRole('button',{name:'仅重新生成所选场景',exact:true}).waitFor()
    assert.equal(await page.getByRole('button',{name:'仅重新生成所选场景',exact:true}).isDisabled(),true)
    await page.getByRole('checkbox',{name:/更新场景/}).check()
    page.once('dialog',dialog=>dialog.accept())
    await page.getByRole('button',{name:'仅重新生成所选场景',exact:true}).click()
    await page.getByRole('button',{name:'审查这次局部生成',exact:true}).waitFor()
    assert.match(page.url(),/runId=partial-generated/)
    await page.getByRole('button',{name:'审查这次局部生成',exact:true}).click()
    await page.getByRole('heading',{name:'人工审核用例',exact:true}).waitFor()
    assert.match(page.url(),/runId=partial-checked/)
    await page.getByRole('button',{name:'配置并执行此发布版本',exact:true}).click()
    const launcher=page.locator('.publication-execution')
    await launcher.locator('input[type=checkbox]').first().check()
    assert.equal(await launcher.getByLabel('测试环境',{exact:true}).inputValue(),'','不默认选择最近环境')
    await launcher.getByLabel('测试环境',{exact:true}).selectOption('env-a')
    assert.equal(await launcher.getByLabel('测试页面地址',{exact:true}).inputValue(),'https://example.test/search')
    await launcher.getByLabel('执行模式',{exact:true}).selectOption('plan')
    assert.equal(await launcher.getByRole('button',{name:'预览最终执行口径',exact:true}).isDisabled(),true)
    await launcher.getByLabel('执行模式',{exact:true}).selectOption('agent')
    await launcher.getByLabel('源码项目',{exact:true}).selectOption('source')
    await launcher.getByRole('button',{name:'预览最终执行口径',exact:true}).click()
    await launcher.getByRole('button',{name:'确认口径并启动后台执行',exact:true}).waitFor()
    await launcher.getByLabel('测试环境',{exact:true}).selectOption('env-b')
    assert.equal(await launcher.getByRole('button',{name:'确认口径并启动后台执行',exact:true}).count(),0,'切换环境清空旧预览')
    assert.equal(await launcher.getByLabel('测试页面地址',{exact:true}).inputValue(),'https://example.test/second')
    await launcher.getByRole('button',{name:'预览最终执行口径',exact:true}).click()
    await launcher.getByRole('button',{name:'确认口径并启动后台执行',exact:true}).waitFor()
    await launcher.getByLabel('测试页面地址',{exact:true}).fill('https://example.test/changed')
    assert.equal(await launcher.getByRole('button',{name:'确认口径并启动后台执行',exact:true}).count(),0,'配置变更使旧预览失效')
    await launcher.getByRole('button',{name:'预览最终执行口径',exact:true}).click()
    page.once('dialog',dialog=>dialog.accept())
    await launcher.getByRole('button',{name:'确认口径并启动后台执行',exact:true}).click()
    await page.waitForURL('**/#/execution-jobs/job-fixture')
    assert.equal(executionInput?.targetUrl,'https://example.test/changed')
    assert.equal(executionInput?.projectId,'source')
    assert.equal(executionInput?.environmentId,'env-b')
    assert.equal(executionInput?.contract,undefined)
    assert.deepEqual(errors,[])
  } finally {await browser?.close();await server.close()}
})
