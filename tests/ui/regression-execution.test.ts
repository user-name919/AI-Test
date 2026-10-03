import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

test('回归部署确认、旧审核版本选择、预览失效和后台执行跳转',async()=>{
  const server=await createServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0}})
  await server.listen();const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string')
  const browser=await chromium.launch({headless:true})
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}})
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
    const id='11111111-1111-4111-8111-111111111111';const sha='a'.repeat(40)
    const contract={objective:'确认按钮文字',preconditions:[],steps:['人工最终点击步骤'],expectedAssertions:['显示成功'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}
    const items={risks:[],cases:[]}
    const reviews=[2,1].map(revision=>({regressionId:id,revision,createdAt:'now',analysisHash:'hash',content:{status:'confirmed',scopeNote:'已确认范围',risks:[],cases:[]}}))
    let previewCount=0;let started:{mode:string;projectId:string;cases:Array<{revision:number}>;deploymentConfirmationId:string}|undefined
    const makeAsset=(revision:number)=>({id:`regression:${id}:${revision}:0`,revision,title:`已确认 v${revision} 用例`,resolved:{caseKey:`regression:${id}:${revision}:0`,title:`已确认 v${revision} 用例`,contract,contractFingerprint:`fingerprint-${revision}`,readiness:{agent:{executable:false,reason:'需要部署确认'},plan:{executable:false,reason:'需要部署确认'}},resolvedQuestions:[]}})
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());const path=url.pathname
      let payload:unknown={}
      if(path===`/api/regressions/${id}`)payload={regression:{id,projectId:'fixture',changeSetId:'change',targetSha:sha,status:'completed',stage:'finished',generation:{batches:[],pendingEvidenceIds:[],omittedEvidenceIds:[],limitations:[]}}}
      else if(path==='/api/change-sets/change')payload={changeSet:{id:'change',status:'frozen',facts:{comparison:{mode:'endpoints'},targetSha:sha,commits:[],diffs:[],warnings:[],omittedCommitShas:[]}}}
      else if(path.endsWith('/review'))payload={items,reviews}
      else if(path==='/api/environments')payload={environments:[{id:'environment',name:'本地测试环境',baseUrl:'https://example.test',targetUrl:'https://example.test/page',hasStorageState:true}]}
      else if(path==='/api/cases')payload={cases:[makeAsset(Number(url.searchParams.get('reviewRevision')))]}
      else if(path.endsWith('/deployments')){
        if(route.request().method()==='POST'){const body=route.request().postDataJSON();payload={confirmation:{...body,id:'confirmation',status:body.deployedSha?'mismatched':'unverified',targetSha:sha}}}
        else payload={confirmations:[]}
      }else if(path==='/api/cases/prepare-execution'){
        previewCount++;const body=route.request().postDataJSON();assert.equal(body.deploymentConfirmationId,'confirmation');assert.equal(body.environmentId,'environment');assert.equal(body.cases[0].revision,1)
        const asset=makeAsset(1);payload={preparation:{snapshots:[{caseId:asset.id,revision:1,resolved:asset.resolved}]}}
      }else if(path==='/api/execution-jobs'&&route.request().method()==='POST'){started=route.request().postDataJSON();payload={job:{id:'job'}}}
      else if(path==='/api/execution-jobs/job')payload={job:{id:'job',status:'queued',snapshots:[],mode:'agent',targetUrl:'https://example.test/page'}}
      else if(path.endsWith('/events'))payload={events:[],nextCursor:0}
      await route.fulfill({json:payload})
    })
    await page.goto(`http://127.0.0.1:${address.port}/#/regressions/${id}`)
    const panel=page.getByRole('region',{name:'回归部署与执行'})
    await panel.getByLabel('执行审核版本',{exact:true}).selectOption('1')
    await panel.getByLabel('回归测试环境',{exact:true}).selectOption('environment')
    await panel.getByLabel('部署确认人',{exact:true}).fill('审核人员')
    await panel.getByLabel('部署核对依据',{exact:true}).fill('仅用于探索回归，部署 SHA 未核实')
    await panel.getByLabel('环境已部署 SHA（未核实可留空）',{exact:true}).fill('b'.repeat(40))
    await panel.getByRole('button',{name:'保存部署确认',exact:true}).click()
    await panel.getByText('登记版本不匹配，禁止执行',{exact:true}).waitFor()
    assert.equal(await panel.getByRole('button',{name:'预览回归执行口径'}).isDisabled(),true)
    await panel.getByLabel('环境已部署 SHA（未核实可留空）',{exact:true}).fill('')
    await panel.getByRole('button',{name:'保存部署确认',exact:true}).click()
    await panel.getByText('部署版本未核实：本次结果不能证明目标版本已经部署',{exact:true}).waitFor()
    await panel.getByRole('checkbox').check()
    await panel.getByRole('button',{name:'预览回归执行口径'}).click()
    await panel.getByRole('button',{name:'确认并启动回归执行'}).waitFor()
    await panel.getByLabel('回归执行模式',{exact:true}).selectOption('plan')
    assert.equal(await panel.getByRole('button',{name:'确认并启动回归执行'}).count(),0)
    await panel.getByRole('button',{name:'预览回归执行口径'}).click()
    await panel.getByRole('button',{name:'确认并启动回归执行'}).waitFor()
    await page.setViewportSize({width:390,height:844})
    await page.screenshot({path:'/private/tmp/quality-ai-regression-execution.png',fullPage:true})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1))
    await panel.getByRole('button',{name:'确认并启动回归执行'}).click()
    await page.waitForURL('**/#/execution-jobs/job')
    assert.ok(started);assert.equal(previewCount,2);assert.equal(started.mode,'plan');assert.equal(started.projectId,'fixture');assert.equal(started.cases[0]!.revision,1);assert.equal(started.deploymentConfirmationId,'confirmation')
    assert.deepEqual(errors,[])
  }finally{await browser.close();await server.close()}
})
