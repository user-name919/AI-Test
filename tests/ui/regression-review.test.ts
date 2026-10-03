import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { RegressionReview, RegressionReviewItems } from '@quality-ai/contracts/regressions'

test('人工回归编辑保留 AI 原文，刷新草稿、版本冲突比较与独立确认历史', async () => {
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string')
  const browser=await chromium.launch({headless:true})
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept())
    const id='11111111-1111-4111-8111-111111111111'
    const contract={objective:'验证选择器',preconditions:[],steps:['AI 原始步骤'],expectedAssertions:['匹配项可见'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}
    const items:RegressionReviewItems={risks:['搜索','下载'].map((title,index)=>({key:`b:r${index}`,batchId:'b',original:{id:`r${index}`,title,reason:'合成影响建议',severity:'medium',confidence:'low',evidenceIds:['e1']}})),cases:[{key:'b:case-0',batchId:'b',riskKeys:['b:r0'],original:{title:'搜索验证',riskIds:['r0'],verification:'browser',verificationReason:'可观察页面',contract}}]}
    const history:RegressionReview[]=[]
    let conflictOnce=true
    await page.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname
      if(path.endsWith('/review')){
        if(route.request().method()==='PATCH'){
          const body=route.request().postDataJSON()
          if(conflictOnce){
            conflictOnce=false
            history.unshift({regressionId:id,revision:1,createdAt:'now',analysisHash:'hash',content:{status:'draft',scopeNote:'其他人员保存的范围',risks:[],cases:[]}})
            await route.fulfill({status:409,json:{error:'审核版本冲突，请保留当前草稿并加载最新版本比较'}});return
          }
          assert.equal(body.expectedRevision,history[0]!.revision)
          const review={regressionId:id,revision:body.expectedRevision+1,createdAt:'now',analysisHash:'hash',content:body.content}
          history.unshift(review);await route.fulfill({json:{review}});return
        }
        await route.fulfill({json:{items,reviews:history}});return
      }
      if(path===`/api/regressions/${id}`){await route.fulfill({json:{regression:{id,projectId:'fixture',changeSetId:'change',targetSha:'a'.repeat(40),status:'completed',stage:'finished',updatedAt:'now',generation:{batches:[],pendingEvidenceIds:[],omittedEvidenceIds:[],limitations:[],model:'fixture',promptVersion:'fixture'}}}});return}
      if(path==='/api/change-sets/change'){await route.fulfill({json:{changeSet:{id:'change',projectId:'fixture',status:'frozen',factsHash:'h',facts:{comparison:{mode:'endpoints'},targetSha:'a'.repeat(40),commits:[],diffs:[],omittedCommitShas:[],warnings:[]}}}});return}
      if(path==='/api/environments'){await route.fulfill({json:{environments:[]}});return}
      if(path==='/api/cases'){await route.fulfill({json:{cases:[]}});return}
      if(path.endsWith('/deployments')){await route.fulfill({json:{confirmations:[]}});return}
      await route.fulfill({json:{}})
    })
    await page.goto(`http://127.0.0.1:${address.port}/#/regressions/${id}`)
    const panel=page.getByRole('region',{name:'人工回归审核'})
    await panel.getByLabel('风险 搜索 范围决定',{exact:true}).selectOption('include')
    await panel.getByLabel('风险 下载 范围决定',{exact:true}).selectOption('exclude')
    await panel.getByLabel('风险 下载 理由',{exact:true}).fill('下载未在本次改造范围，另行人工验证')
    await panel.getByLabel('用例范围决定',{exact:true}).selectOption('include')
    await panel.getByLabel('执行步骤（每行一项）',{exact:true}).fill('人工最终步骤：打开列表并选择现有选项')
    await panel.getByLabel('人工回归范围及已知限制',{exact:true}).fill('只覆盖搜索，动态依赖需补充人工验证')
    await panel.getByText('AI 原始用例（只读）',{exact:true}).click()
    await panel.getByText('AI 原始步骤',{exact:true}).waitFor()
    await page.reload()
    await panel.getByText(/已恢复此标签页编辑内容/).waitFor()
    assert.equal(await panel.getByLabel('执行步骤（每行一项）',{exact:true}).inputValue(),'人工最终步骤：打开列表并选择现有选项')
    await panel.getByRole('button',{name:'保存审核草稿',exact:true}).click()
    await panel.getByRole('heading',{name:'发现服务端新版本 v1'}).waitFor()
    assert.equal(await panel.getByLabel('执行步骤（每行一项）',{exact:true}).inputValue(),'人工最终步骤：打开列表并选择现有选项')
    await panel.getByText('最新人工口径（只读）',{exact:true}).click()
    await panel.locator('pre').filter({hasText:'其他人员保存的范围'}).waitFor()
    await panel.getByRole('button',{name:'已比较，保留我的草稿并更新基线'}).click()
    await panel.getByRole('button',{name:'保存审核草稿',exact:true}).click()
    await panel.getByText(/已保存草稿版本 v2/).waitFor()
    await panel.getByRole('button',{name:'确认回归范围与用例',exact:true}).click()
    await panel.getByText(/已保存确认版本 v3/).waitFor()
    assert.equal(history[0]!.content.status,'confirmed')
    assert.equal(history[1]!.content.status,'draft')
    const finalCase=history[0]!.content.cases[0]!
    assert.equal(finalCase.decision,'include')
    if(finalCase.decision==='include')assert.deepEqual(finalCase.finalContract.steps,['人工最终步骤：打开列表并选择现有选项'])
    assert.deepEqual(items.cases[0]!.original.contract.steps,['AI 原始步骤'])
    await panel.getByText('人工审核历史（3）',{exact:true}).click()
    await panel.getByRole('heading',{name:/v3 · 已确认/}).waitFor()
    await page.setViewportSize({width:390,height:844})
    await page.screenshot({path:'/private/tmp/quality-ai-regression-review.png',fullPage:true})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    assert.deepEqual(errors,[])
  }finally{await browser.close();await server.close()}
})
