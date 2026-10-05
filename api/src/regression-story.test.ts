import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createServer as createViteServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { ChangeSet, RegressionAnalysis } from '@quality-ai/contracts/regressions'
import type { ExecutionRecord } from '@quality-ai/contracts'

test('故事 C：三个重构提交经实际界面审核部署执行，失败报告关联固定变更证据',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quality-ai-story-c-'))
  const source=mkdtempSync(join(directory,'project-'))
  process.env.QUALITY_AI_DATA_ROOT=directory;process.env.QUALITY_AI_DATABASE_PATH=join(directory,'db.sqlite')
  process.env.PROJECTS_CONFIG_PATH=join(directory,'projects.json')
  writeFileSync(process.env.PROJECTS_CONFIG_PATH,JSON.stringify({projects:[{id:'fixture',name:'合成重构项目',root:source}]}))
  const git=(...args:string[])=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim()
  const commit=(message:string)=>{git('add','.');git('commit','-m',message);return git('rev-parse','HEAD')}
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid')
  writeFileSync(join(source,'shared.js'),'export function nextLabel(){return "完成"}')
  writeFileSync(join(source,'page-a.js'),'import { nextLabel } from "./shared.js"; document.querySelector("button").onclick=event=>{event.target.textContent=nextLabel()}')
  writeFileSync(join(source,'page-b.js'),'import { nextLabel } from "./shared.js"; export const render=()=>nextLabel()')
  writeFileSync(join(source,'index.html'),'<!doctype html><meta charset="utf-8"><button>继续</button><script type="module" src="/page-a.js"></script>')
  const base=commit('合成基线')
  writeFileSync(join(source,'shared.js'),'export const nextLabel=()=>"已继续"')
  const first=commit('重构共享组件')
  writeFileSync(join(source,'page-a.js'),'import { nextLabel } from "./shared.js"; document.querySelector("button").addEventListener("click",event=>{event.target.textContent=nextLabel()})')
  const second=commit('调整页面 A 调用方式')
  writeFileSync(join(source,'page-b.js'),'import { nextLabel } from "./shared.js"; export const render=()=>nextLabel(); export const lazy=()=>import("@/unresolved")')
  const targetSha=commit('调整页面 B 并保留动态依赖')
  const deployedFiles=new Map(['index.html','shared.js','page-a.js'].map(path=>[path,git('show',`${targetSha}:${path}`)]))
  const {createApiServer}=await import('./app');const {database}=await import('./storage/database')
  const {saveEnvironment}=await import('./modules/projects/environment-repository')
  let generated=0;let planned=0;let decisions=0
  const site=createServer(async(request,response)=>{
    try{
      if(request.method!=='POST'){
        const path=request.url==='/'?'index.html':request.url?.slice(1)??''
        if(!deployedFiles.has(path)){response.writeHead(404);response.end();return}
        response.setHeader('content-type',path.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');response.end(deployedFiles.get(path));return
      }
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk))
      const body=JSON.parse(Buffer.concat(chunks).toString())
      const content=body.input[0].content as string
      let output:unknown
      if(body.instructions?.includes('前端重构回归分析助手')){
        generated++
        const input=JSON.parse(content.split('\n\nReturn only')[0]!)
        assert.equal(input.targetSha,targetSha)
        assert.ok(input.evidence.some((item:{paths:string[]})=>item.paths.includes('shared.js')))
        const contract={objective:'按钮交互回归',preconditions:[],steps:['点击继续按钮'],expectedAssertions:['显示已继续'],dataBindings:[],forbiddenBehaviors:['不得改写已确认预期'],uncertainties:[]}
        output={risks:[{id:'r1',title:'共享按钮交互',reason:'共享函数影响页面 A 与页面 B',severity:'high',confidence:'medium',evidenceIds:[input.evidence[0].id]},{id:'r2',title:'页面 B 动态模块',reason:'别名依赖无法静态解析',severity:'medium',confidence:'low',evidenceIds:[input.evidence[0].id]}],cases:[{title:'页面 A 按钮回归',riskIds:['r1'],verification:'browser',verificationReason:'按钮文字可观察',contract}],limitations:['仅验证页面 A，动态模块需人工判断']}
      }else if(body.instructions?.includes('单步决策器')){
        decisions++
        const marker='当前输入：\n'
        const input=JSON.parse(content.slice(content.indexOf(marker)+marker.length).split('\n\nReturn only a valid json object.')[0]!)
        assert.deepEqual(input.goal.executionContract.contract.expectedAssertions,['人工预期：必须显示人工错误标记'])
        const snapshot=input.currentSnapshot
        output=input.recentTrajectory.length===0
          ?{type:'action',snapshotId:snapshot.snapshotId,reason:'依据当前DOM操作人工确认用例',action:{action:'click',elementRef:snapshot.elements.find((item:{name:string})=>item.name==='继续').ref}}
          :{type:'action',snapshotId:snapshot.snapshotId,reason:'保留故意错误的人工预期，不自愈修改',action:{action:'expectText',text:'人工错误标记',assertionId:input.goal.requiredAssertions[0].id}}
      }else{
        planned++
        assert.match(content,/人工预期：必须显示人工错误标记/)
        assert.doesNotMatch(content,/"expectedAssertions":\["显示已继续"\]/)
        output={name:'人工最终回归',targetUrl:targetUrl,steps:[{action:'click',locator:{by:'text',value:'继续'}},{action:'expectText',assertionIndex:0,text:'人工错误标记'},{action:'screenshot',name:'结果'}]}
      }
      response.setHeader('content-type','application/json');response.end(JSON.stringify({output_text:JSON.stringify(output)}))
    }catch(error){response.writeHead(500);response.end(JSON.stringify({error:{message:String(error)}}))}
  })
  let targetUrl=''
  const api=createApiServer();let web:Awaited<ReturnType<typeof createViteServer>>|undefined;let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  try{
    await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));targetUrl=`http://127.0.0.1:${(site.address() as AddressInfo).port}/`
    process.env.MODEL_API_KEY='synthetic-local-only';process.env.MODEL_BASE_URL=targetUrl.replace(/\/$/,'')
    const environment=saveEnvironment({name:'固定目标合成部署',baseUrl:new URL(targetUrl).origin,targetUrl})
    await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));const apiOrigin=`http://127.0.0.1:${(api.address() as AddressInfo).port}`
    const get=async(path:string)=>{const response=await fetch(apiOrigin+path);const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result}
    web=await createViteServer({root:new URL('../../web',import.meta.url).pathname,configFile:false,plugins:[vue()],server:{host:'127.0.0.1',port:0,proxy:{'/api':apiOrigin}}});await web.listen()
    const address=web.httpServer!.address();assert.ok(address&&typeof address!=='string')
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}})
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/#/regressions/new`)
    await page.getByLabel('源码项目',{exact:true}).selectOption('fixture')
    await page.getByLabel('比较方式',{exact:true}).selectOption('selected_commits')
    await page.getByLabel('目标本地分支或 SHA',{exact:true}).fill('main')
    await page.getByLabel('指定提交 SHA',{exact:true}).fill([first,second,targetSha].join('\n'))
    await page.getByRole('button',{name:'预览变更范围',exact:true}).click()
    await page.getByText('提交记录（3）',{exact:true}).click()
    await page.getByText('重构共享组件',{exact:true}).waitFor()
    await page.getByRole('button',{name:'确认冻结并分析'}).click()
    await page.getByRole('heading',{name:'人工范围与最终用例',exact:true}).waitFor()
    const regressionId=page.url().split('/regressions/')[1]!.split('?')[0]!
    const analysis:RegressionAnalysis=(await get(`/api/regressions/${regressionId}`)).regression
    assert.equal(analysis.status,'completed');assert.equal(generated,1)
    assert.ok(analysis.sourceImpact!.trees.some(tree=>tree.affectedFiles.includes('page-a.js')&&tree.affectedFiles.includes('page-b.js')))
    assert.ok(analysis.sourceImpact!.trees.some(tree=>tree.unresolved.some(item=>item.expression.includes('@/unresolved'))))
    const range:ChangeSet=(await get(`/api/change-sets/${analysis.changeSetId}`)).changeSet
    assert.equal(range.facts.comparison.mode,'selected_commits');assert.deepEqual(range.facts.commits.map(item=>item.sha),[first,second,targetSha]);assert.equal(range.facts.diffs[0]!.baseSha,base)
    const review=page.getByRole('region',{name:'人工回归审核'})
    await review.getByLabel('风险 共享按钮交互 范围决定',{exact:true}).selectOption('include')
    await review.getByLabel('风险 页面 B 动态模块 范围决定',{exact:true}).selectOption('exclude')
    await review.getByLabel('风险 页面 B 动态模块 理由',{exact:true}).fill('页面 B 由人工另行验证，不声称本次已覆盖')
    await review.getByLabel('用例范围决定',{exact:true}).selectOption('include')
    await review.getByLabel('预期断言（每行一项）',{exact:true}).fill('人工预期：必须显示人工错误标记')
    await review.getByLabel('人工回归范围及已知限制',{exact:true}).fill('仅验证页面 A，故意错误预期用于证明失败保留；页面 B 另行验证')
    await review.getByRole('button',{name:'确认回归范围与用例',exact:true}).click()
    await review.getByText(/已保存确认版本 v1/).waitFor()
    const execution=page.getByRole('region',{name:'回归部署与执行'})
    await execution.getByLabel('回归测试环境',{exact:true}).selectOption(environment.id)
    await execution.getByLabel('环境已部署 SHA（未核实可留空）',{exact:true}).fill(targetSha)
    await execution.getByLabel('部署确认人',{exact:true}).fill('本地验收人员')
    await execution.getByLabel('部署核对依据',{exact:true}).fill('测试 HTTP 服务读取冻结目标 SHA 的公开合成文件，不是公司真实部署')
    await execution.getByRole('button',{name:'保存部署确认',exact:true}).click()
    await execution.getByText('人工登记版本匹配（非自动探测证明）',{exact:true}).waitFor()
    await execution.getByRole('checkbox').check()
    await execution.getByLabel('回归执行模式',{exact:true}).selectOption('plan')
    await execution.getByRole('button',{name:'预览回归执行口径',exact:true}).click()
    await execution.getByRole('button',{name:'确认并启动回归执行'}).waitFor()
    writeFileSync(join(source,'shared.js'),'export const nextLabel=()=>"新的分支内容"');commit('冻结后分支移动')
    writeFileSync(join(source,'user-draft.txt'),'保留用户草稿')
    await execution.getByRole('button',{name:'确认并启动回归执行'}).click()
    await page.waitForURL('**/#/execution-jobs/*')
    const jobId=page.url().split('/execution-jobs/')[1]!
    await page.getByText('通过 / 选中总数：0 / 1',{exact:false}).waitFor({timeout:30000})
    const result:ExecutionRecord=(await get(`/api/executions/${jobId}`)).execution
    assert.equal(planned,1);assert.equal(result.status,'failed');assert.equal(result.caseResults![0]!.status,'failed')
    assert.equal(result.sourceProject!.commit,targetSha);assert.equal(result.deploymentConfirmation!.targetSha,targetSha)
    assert.deepEqual(result.caseSnapshots![0]!.resolved.contract.expectedAssertions,['人工预期：必须显示人工错误标记'])
    assert.match(result.error!,/人工错误标记/)
    const artifacts=(await get(`/api/executions/${jobId}/artifacts`)).artifacts
    assert.ok(artifacts.some((item:{kind:string;available:boolean})=>item.kind==='trace'&&item.available))
    assert.ok(artifacts.some((item:{kind:string;available:boolean})=>item.kind==='screenshot'&&item.available))
    await page.getByRole('link',{name:'返回回归范围、审核与变更依据'}).click()
    await page.getByRole('heading',{name:'已冻结范围'}).waitFor()
    await page.getByText('提交记录（3）',{exact:true}).click();await page.getByText('重构共享组件',{exact:true}).waitFor()
    assert.deepEqual((await get(`/api/change-sets/${analysis.changeSetId}`)).changeSet,range)
    assert.deepEqual((await get(`/api/executions/${jobId}`)).execution,result)
    const baselines=await get('/api/regression-baselines?projectId=fixture')
    assert.equal(baselines.baselines[0].confirmation.deployedSha,targetSha)
    assert.equal(baselines.baselines[0].confirmation.regressionId,regressionId)
    // Execute the same reviewed regression through the production dynamic provider, after the branch already moved.
    await execution.getByLabel('回归测试环境',{exact:true}).selectOption(environment.id)
    await execution.getByLabel('环境已部署 SHA（未核实可留空）',{exact:true}).fill(targetSha)
    await execution.getByLabel('部署确认人',{exact:true}).fill('本地验收人员')
    await execution.getByLabel('部署核对依据',{exact:true}).fill('动态模式沿用同一冻结目标的合成部署，非公司真实部署')
    await execution.getByRole('button',{name:'保存部署确认',exact:true}).click()
    await execution.getByText('人工登记版本匹配（非自动探测证明）',{exact:true}).waitFor()
    await execution.getByRole('checkbox').check()
    await execution.getByLabel('回归执行模式',{exact:true}).selectOption('agent')
    await execution.getByRole('button',{name:'预览回归执行口径',exact:true}).click()
    await execution.getByRole('button',{name:'确认并启动回归执行'}).click()
    await page.waitForURL('**/#/execution-jobs/*')
    const dynamicJobId=page.url().split('/execution-jobs/')[1]!
    assert.notEqual(dynamicJobId,jobId)
    await page.getByText('通过 / 选中总数：0 / 1',{exact:false}).waitFor({timeout:30000})
    const dynamic:ExecutionRecord=(await get(`/api/executions/${dynamicJobId}`)).execution
    assert.equal(decisions,2)
    assert.equal(dynamic.mode,'agent');assert.equal(dynamic.caseResults![0]!.status,'failed')
    assert.equal(dynamic.sourceProject!.commit,targetSha)
    assert.equal(dynamic.deploymentConfirmation!.targetSha,targetSha)
    assert.deepEqual(dynamic.caseSnapshots![0]!.resolved,result.caseSnapshots![0]!.resolved)
    assert.match(dynamic.error!,/人工错误标记/)
    assert.equal(dynamic.caseResults![0]!.trajectory[0]!.result!.ok,true)
    const dynamicArtifacts=(await get(`/api/executions/${dynamicJobId}/artifacts`)).artifacts
    assert.ok(dynamicArtifacts.some((item:{kind:string;available:boolean})=>item.kind==='trace'&&item.available))
    assert.ok(dynamicArtifacts.some((item:{kind:string;available:boolean})=>item.kind==='screenshot'&&item.available))
    const dynamicReport=await (await fetch(`${apiOrigin}/api/executions/${dynamicJobId}/report.md`)).text()
    assert.match(dynamicReport,new RegExp(targetSha));assert.match(dynamicReport,/人工错误标记/)
    await page.reload()
    await page.getByRole('link',{name:'返回回归范围、审核与变更依据'}).click()
    await page.getByRole('heading',{name:'已冻结范围'}).waitFor()
    assert.deepEqual((await get(`/api/change-sets/${analysis.changeSetId}`)).changeSet,range)
    assert.deepEqual((await get(`/api/executions/${jobId}`)).execution,result,'新部署登记和动态执行不改写旧报告')
    assert.equal(readFileSync(join(source,'user-draft.txt'),'utf8'),'保留用户草稿')
    assert.equal(database.prepare('SELECT count(*) AS count FROM regression_worktree_leases').get()!.count,0)
    const report=await (await fetch(`${apiOrigin}/api/executions/${jobId}/report.md`)).text()
    assert.match(report,new RegExp(targetSha));assert.match(report,/人工审核 v1/);assert.match(report,/人工错误标记/)
    assert.deepEqual(errors,[])
    await page.screenshot({path:'/private/tmp/quality-ai-story-c.png',fullPage:true})
  }finally{await browser?.close();await web?.close();await new Promise<void>(resolve=>api.close(()=>resolve()));await new Promise<void>(resolve=>site.close(()=>resolve()));database.close();rmSync(directory,{recursive:true,force:true})}
})
