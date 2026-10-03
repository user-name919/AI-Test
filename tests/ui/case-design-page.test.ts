import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { CaseDesign, DesignRun } from '@quality-ai/contracts/case-design'
import { createEvidenceDocuments } from '../../api/src/modules/case-design/documents'

test('独立设计页面导入、阶段条件、原文定位与刷新，无需环境', async () => {
  const documents=createEvidenceDocuments([{fileName:'需求.md',role:'prd',content:'# 搜索规则\n\n支持部分关键词搜索。'}])
  const design:CaseDesign={id:'design-fixture',name:'独立搜索设计',revision:1,inputHash:'fixture',documents,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z'}
  const block=documents[0].blocks[1]
  let runs:DesignRun[]=[]
  let imported=false
  let failedOnce=true
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
      if(path==='/api/case-designs' && route.request().method()==='POST') {
        const body=route.request().postDataJSON()
        assert.equal(body.files[0].content,'支持部分关键词搜索。')
        if(failedOnce){failedOnce=false;await route.fulfill({status:400,json:{error:'合成解析失败，请重试'}});return}
        imported=true; await route.fulfill({status:201,json:{design}}); return
      }
      if(path==='/api/case-designs'){await route.fulfill({json:{designs:imported?[design]:[]}});return}
      if(path===`/api/case-designs/${design.id}`){await route.fulfill({json:{design,runs}});return}
      if(path.endsWith('/runs')) {
        const body=route.request().postDataJSON(); assert.equal(body.stage,'extracting')
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
    assert.ok((await page.locator('main').boundingBox())!.x<200)
    if(process.env.UI_DESIGN_SCREENSHOT_PATH) await page.screenshot({path:process.env.UI_DESIGN_SCREENSHOT_PATH,fullPage:true})
    await page.setViewportSize({width:390,height:844})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
    assert.deepEqual(errors,[])
  } finally {await browser?.close();await server.close()}
})
