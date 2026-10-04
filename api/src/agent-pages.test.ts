import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import type { AgentTestGoal, LiveExecutionEvent } from '@quality-ai/contracts'
import { BrowserPageSession } from './automation/browser-page-session'
import { PageObserver } from './automation/page-observer'
import { SingleActionExecutor } from './automation/single-action-executor'
import { runAgentTest } from './automation/agent-test-runner'
import { executionMarkdown } from './modules/executions/report'

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-pages-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(request.url === '/detail'
      ? '<title>详情页</title><button>详情操作</button><p>详情已加载</p>'
      : request.url === '/frame' ? '<button>框架操作</button>'
        : '<title>入口页</title><a target="_blank" href="/detail">打开详情</a><iframe name="业务" src="/frame"></iframe>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return { directory, url: `http://127.0.0.1:${address.port}` }
}

test('标签页真实身份、显式切换、框架重置及过期/外部/关闭引用拒绝', async t => {
  const { directory, url } = await fixture(t)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext(), page = await context.newPage()
  await page.goto(url)
  const switches: string[] = []
  const pages = new BrowserPageSession(page, url, async next => { switches.push(next.url()) })
  const observer = new PageObserver({}, pages)
  const executor = new SingleActionExecutor(page, observer.registry, url, directory, undefined, undefined, pages)
  const first = await observer.observe(page)
  const originalRef = first.pageContext!.pages[0]!.ref
  const opened = context.waitForEvent('page')
  await page.getByRole('link').click()
  const popup = await opened; await popup.waitForLoadState('domcontentloaded')
  assert.equal(pages.current, page, '弹页不能隐式切换')
  const snapshot = await observer.observe(page)
  const popupRef = snapshot.pageContext!.pages.find(item => item.url.endsWith('/detail'))!.ref
  await executor.execute(snapshot.snapshotId, { action:'switchFrame', frameRef:snapshot.frameContext!.frames.find(frame=>frame.name==='业务')!.ref })
  const inner = await observer.observe(page)
  assert.equal((await executor.execute(inner.snapshotId, { action:'switchPage', pageRef:popupRef })).ok, true)
  assert.equal((await executor.execute(inner.snapshotId, { action:'click', elementRef:inner.elements[0]!.ref })).ok, false)
  const detail = await observer.observe(page)
  assert.equal(detail.url, `${url}/detail`)
  assert.equal(detail.frameContext!.frames.find(frame=>frame.active)!.main, true)
  assert.equal(detail.pageContext!.pages.find(item=>item.active)!.ref, popupRef)
  assert.equal(detail.elements.some(element=>element.name==='详情操作'), true)
  assert.equal((await executor.execute(detail.snapshotId, { action:'switchPage', pageRef:randomUUID() })).ok, false)
  const foreign = await context.newPage(); await foreign.goto('data:text/html,<button>外部</button>')
  const withForeign = await observer.observe(page)
  const foreignRef = withForeign.pageContext!.pages.find(item=>!item.allowed)!.ref
  assert.equal((await executor.execute(withForeign.snapshotId, { action:'switchPage', pageRef:foreignRef })).ok, false)
  assert.equal(pages.current, popup)
  await page.close()
  assert.equal((await executor.execute(withForeign.snapshotId, { action:'switchPage', pageRef:originalRef })).ok, false)
  await popup.goto('data:text/html,<button>导航后外部</button>')
  await assert.rejects(observer.observe(page), /不属于测试环境/)
  assert.equal((await executor.execute(withForeign.snapshotId, { action:'click', elementRef:detail.elements[0]!.ref })).ok, false)
  assert.deepEqual(switches, [`${url}/detail`])
})

test('真实动态循环切新页后画面与报告跟随、失败继续并可返回原页', async t => {
  const { directory, url } = await fixture(t)
  const goals: AgentTestGoal[] = [0, 1].map(index => ({
    name: `标签页用例${index}`, targetUrl:url, objective:'验证详情', requiredAssertions:[{id:'visible',description:'指定按钮存在'}],
    executionContract:{caseKey:`0-TC-${index}`,contractFingerprint:`pages-${index}`,contract:{objective:'验证详情',preconditions:[],steps:['打开详情并验证'],expectedAssertions:['指定按钮存在'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}},
  }))
  const events: LiveExecutionEvent[] = []
  const result = await runAgentTest(goals, undefined, { artifactRoot:directory, onEvent:event=>events.push(event), projectProvider:{
    async getProjectInfo(){return{id:'fixture',name:'fixture',configuredRoot:'.',connected:true,targetOrigins:[url]}},
    async resolveRoute(){return null}, async searchSource(){return []}, async inspectFiles(){return{projectId:'fixture',reason:'unused',files:[],totalCharacters:0}},
  }, decisionProvider:{async decide({goal,snapshot,trajectory}){
    const action = (value: Parameters<SingleActionExecutor['execute']>[1]) => ({type:'action' as const,snapshotId:snapshot.snapshotId,reason:'根据实际页面验证',action:value})
    if(goal.name.endsWith('0')){
      if(!trajectory.length)return action({action:'click',elementRef:snapshot.elements.find(item=>item.name==='打开详情')!.ref})
      const detail = snapshot.pageContext!.pages.find(item=>item.url.endsWith('/detail'))
      if(!detail)return action({action:'waitFor',durationMs:100})
      if(!detail.active)return action({action:'switchPage',pageRef:detail.ref})
      // Disabled assertion fails immediately; retain the original failure and continue next case.
      return action({action:'expectDisabled',elementRef:snapshot.elements.find(item=>item.name==='详情操作')!.ref,assertionId:'visible'})
    }
    if(!trajectory.length){
      assert.equal(snapshot.url,`${url}/detail`, '下一用例继承实际当前页')
      return action({action:'switchPage',pageRef:snapshot.pageContext!.pages.find(item=>item.url===`${url}/`)!.ref})
    }
    if(trajectory.length===1)return action({action:'expectVisible',elementRef:snapshot.elements.find(item=>item.name==='打开详情')!.ref,assertionId:'visible'})
    return {type:'finish',summary:'原页按钮已验证'}
  }}})
  assert.deepEqual(result.caseResults?.map(item=>item.status),['failed','passed'])
  const failed = result.caseResults![0]!, continued = result.caseResults![1]!
  assert.equal(continued.startedFromUrl,`${url}/detail`)
  assert.ok(failed.screenshots.length)
  assert.ok((await stat(failed.screenshots[0]!)).size>0)
  assert.ok(events.some(event=>event.type==='browser_frame'&&event.pageUrl===`${url}/detail`))
  assert.ok(events.some(event=>event.type==='browser_frame'&&event.caseKey==='0-TC-1'&&event.pageUrl===`${url}/`))
  const markdown = executionMarkdown({...result,caseKeys:['0-TC-0','0-TC-1']},[])
  assert.match(markdown,/当前标签页/)
  assert.match(markdown,/switchPage/)
  assert.equal(failed.trajectory.at(-1)!.observation!.pageContext!.pages.find(page=>page.active)!.url,`${url}/detail`)
})

test('切换后的活动标签页关闭时停止整批，不静默回退旧页', async t => {
  const { directory, url } = await fixture(t)
  const browser = await chromium.launch({headless:true})
  t.after(()=>browser.close())
  const goals:AgentTestGoal[] = [0,1].map(index=>({name:`关闭页${index}`,targetUrl:url,objective:'验证标签页生命周期',requiredAssertions:[{id:'visible',description:'详情操作可见'}],executionContract:{caseKey:`0-TC-${index}`,contractFingerprint:`closed-${index}`,contract:{objective:'验证标签页',preconditions:[],steps:['进入详情'],expectedAssertions:['详情操作可见'],dataBindings:[],forbiddenBehaviors:[],uncertainties:[]}}}))
  const result=await runAgentTest(goals,undefined,{artifactRoot:directory,launchBrowser:async()=>browser,projectProvider:{
    async getProjectInfo(){return{id:'fixture',name:'fixture',configuredRoot:'.',connected:true,targetOrigins:[url]}},
    async resolveRoute(){return null},async searchSource(){return []},async inspectFiles(){return{projectId:'fixture',reason:'unused',files:[],totalCharacters:0}},
  },decisionProvider:{async decide({snapshot,trajectory}){
    if(!trajectory.length){
      const popup=await browser.contexts()[0]!.newPage();await popup.goto(`${url}/detail`)
      return{type:'action',snapshotId:snapshot.snapshotId,reason:'等待新增页进入观察',action:{action:'waitFor',durationMs:100}}
    }
    const detail=snapshot.pageContext!.pages.find(page=>page.url.endsWith('/detail'))!
    if(!detail.active)return{type:'action',snapshotId:snapshot.snapshotId,reason:'切换真实详情页',action:{action:'switchPage',pageRef:detail.ref}}
    await browser.contexts()[0]!.pages().find(page=>page.url().endsWith('/detail'))!.close()
    return{type:'blocked',reason:'活动页已关闭'}
  }}})
  assert.deepEqual(result.caseResults?.map(item=>item.status),['infrastructure_failed','not_run'])
  assert.match(result.caseResults![0]!.error!,/关闭/)
  assert.equal(result.caseResults![0]!.trajectory.filter(item=>item.decision.type==='action'&&item.decision.action.action==='switchPage').length,1)
})
