import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium, type Browser } from 'playwright'
import type { AgentDecisionProvider } from './automation/test-agent'
import type { ProjectKnowledgeProvider } from './integrations/project-knowledge/types'
import { runAgentTest } from './automation/agent-test-runner'
import type { AgentTestGoal, LiveExecutionEvent } from '@quality-ai/contracts'
import { ResponsesDecisionProvider } from './automation/responses-decision-provider'

function caseGoal(targetUrl: string, index: number): AgentTestGoal {
  return {
    name: `用例 ${index}`, targetUrl, objective: '验证连续搜索',
    requiredAssertions: [{ id: 'verified', description: '搜索值正确' }],
    executionContract: {
      caseKey: `0-TC-${index}`, contractFingerprint: `fingerprint-${index}`,
      contract: { objective: '验证连续搜索', preconditions: [], steps: ['搜索'], expectedAssertions: ['搜索值正确'],
        dataBindings: [{ id: 'keyword', label: '关键词', mode: 'runtime_dom', targetHint: '搜索', businessIntent: '部分搜索',
          strategy: 'visible_option_substring', constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true } }],
        forbiddenBehaviors: [], uncertainties: [] },
    },
  }
}

const emptyProject: ProjectKnowledgeProvider = {
  async getProjectInfo() { return { id: 'test', name: 'Test', configuredRoot: '.', connected: true, targetOrigins: [] } },
  async resolveRoute() { return null },
  async searchSource() { return [] },
  async inspectFiles() { return { projectId: 'test', reason: 'test', files: [], totalCharacters: 0 } },
}

test('取消正在等待的真实模型HTTP请求，不重试且后续用例未执行',{timeout:15000},async t=>{
  const fixture=await sessionFixture(t)
  const controller=new AbortController()
  let calls=0,closed=false,cancelledAt=0
  const model=createServer(async(request,response)=>{
    for await(const chunk of request)void chunk
    calls++
    response.on('close',()=>{closed=true})
    // 不返回模型结果，取消必须终止真正等待中的fetch，而不是等60秒超时。
    cancelledAt=Date.now()
    controller.abort(new Error('用户取消测试'))
  })
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>{model.closeAllConnections();model.close(()=>resolve())}))
  const address=model.address();assert.ok(address&&typeof address!=='string')
  const browser=await chromium.launch({headless:true})
  t.after(()=>browser.close())
  const provider=new ResponsesDecisionProvider({apiKey:'synthetic-only',baseUrl:`http://127.0.0.1:${address.port}`,model:'fixture'})
  const result=await runAgentTest([caseGoal(fixture.targetUrl,0),caseGoal(fixture.targetUrl,1)],undefined,{
    artifactRoot:fixture.artifactRoot,projectProvider:emptyProject,decisionProvider:provider,signal:controller.signal,launchBrowser:async()=>browser,
  })
  assert.equal(result.status,'cancelled')
  assert.equal(result.caseResults?.[0].status,'cancelled')
  assert.equal(result.caseResults?.[1].status,'not_run')
  assert.equal(calls,1,'取消后不应再次请求模型修复')
  assert.ok(Date.now()-cancelledAt<5000,'取消应及时结束，而不是等待模型超时')
  for(let i=0;i<30&&!closed;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(closed,true,'模型连接应关闭')
  assert.equal(browser.isConnected(),false)
})

async function sessionFixture(testContext: test.TestContext) {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-continuous-'))
  testContext.after(() => rm(artifactRoot, { recursive: true, force: true }))
  let requests = 0
  const web = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>连续搜索</title><input aria-label="搜索"><div role="option">数学课程</div><button onclick="history.pushState({},\'\',\'/continued\')">继续</button>')
  })
  await new Promise<void>((resolve, reject) => web.listen(0, '127.0.0.1', resolve).once('error', reject))
  testContext.after(() => new Promise<void>(resolve => web.close(() => resolve())))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败')
  return { artifactRoot, targetUrl: `http://127.0.0.1:${address.port}/start`, requests: () => requests }
}

test('runs a browser Agent with project context, DOM re-observation and required assertions', async testContext => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-agent-runner-'))
  testContext.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const web = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>学生管理</title></head><body>
      <label for="name">学生姓名</label><input id="name">
      <button onclick="document.querySelector('#result').textContent='保存成功'">保存</button>
      <div id="result"></div>
    </body></html>`)
  })
  await new Promise<void>((resolve, reject) => web.listen(0, '127.0.0.1', resolve).once('error', reject))
  testContext.after(() => new Promise<void>(resolve => web.close(() => resolve())))
  const address = web.address()
  if (!address || typeof address === 'string') throw new Error('测试服务启动失败')
  const targetUrl = `http://127.0.0.1:${address.port}/students`

  let sourceSearches = 0
  const projectProvider: ProjectKnowledgeProvider = {
    async getProjectInfo() { return { id: 'test', name: 'Test', configuredRoot: '.', connected: true, targetOrigins: [new URL(targetUrl).origin] } },
    async resolveRoute() { return null },
    async searchSource() { sourceSearches += 1; return [{ path: 'src/pages/students.vue', line: 10, column: 1, preview: '保存成功' }] },
    async inspectFiles() { return { projectId: 'test', reason: 'test', files: [], totalCharacters: 0 } },
  }
  let turn = 0
  let firstSnapshotId = ''
  const events: LiveExecutionEvent[] = []
  const decisionProvider: AgentDecisionProvider = {
    async decide({ snapshot, projectContexts }) {
      turn += 1
      if (turn === 1) {
        firstSnapshotId = snapshot.snapshotId
        return { type: 'need_project_context', request: { operation: 'search_source', query: '保存成功', scopes: ['page'] }, reason: '确认成功提示' }
      }
      if (turn === 2) {
        assert.equal(projectContexts.length, 1)
        assert.notEqual(snapshot.snapshotId, firstSnapshotId)
        return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'fill', elementRef: snapshot.elements.find(item => item.name === '学生姓名')?.ref ?? '', value: '张三' }, reason: '填写姓名' }
      }
      if (turn === 3) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'click', elementRef: snapshot.elements.find(item => item.name === '保存')?.ref ?? '' }, reason: '保存' }
      if (turn === 4) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'expectText', text: '保存成功', assertionId: 'saved' }, reason: '回到 DOM 验证结果' }
      return { type: 'finish', summary: '保存流程验证完成' }
    },
  }

  const result = await runAgentTest([{
    ...caseGoal(targetUrl, 0),
    name: '保存学生', targetUrl, objective: '填写姓名并保存',
    requiredAssertions: [{ id: 'saved', description: '页面显示保存成功' }],
    executionContract: { ...caseGoal(targetUrl, 0).executionContract!, contract: {
      ...caseGoal(targetUrl, 0).executionContract!.contract, dataBindings: [],
    } },
  }], undefined, { projectProvider, decisionProvider, artifactRoot, onEvent: event => events.push(event) })

  assert.equal(result.status, 'passed')
  assert.equal(result.mode, 'agent')
  assert.equal(sourceSearches, 1)
  assert.equal(result.steps.length, 3)
  assert.equal(result.agent?.trajectory.length, 5)
  assert.deepEqual(result.agent?.passedAssertions, ['saved'])
  assert.equal(result.agent?.trajectory[0].observation?.title, '学生管理')
  assert.ok(result.agent?.trajectory[0].observation?.elements.some(element => element.name === '学生姓名'))
  assert.ok(result.tracePath)
  assert.ok(events.some(event => event.type === 'execution_started' && event.name === '保存学生'))
  assert.ok(events.some(event => event.type === 'browser_frame' && event.dataUrl.startsWith('data:image/jpeg;base64,')))
  assert.ok(events.some(event => event.type === 'activity'
    && event.activity.title === '点击“保存”'
    && event.activity.technicalAction?.startsWith('click e')))
  await stat(result.tracePath)
})

for (const firstStatus of ['passed', 'failed', 'blocked', 'budget'] as const) {
  test(`reuses the current context and page after a ${firstStatus} checkpoint with isolated evidence`, async testContext => {
    const fixture = await sessionFixture(testContext)
    const events: LiveExecutionEvent[] = []
    let browser: Browser | undefined
    let originalPage: unknown
    let requestsAtCheckpoint = 0
    const turns = [0, 0]
    let observedSecondCase = false
    const decisionProvider: AgentDecisionProvider = {
      async decide({ goal, snapshot, trajectory }) {
        const index = goal.executionContract?.caseKey === '0-TC-0' ? 0 : 1
        const turn = ++turns[index]!
        const search = snapshot.elements.find(item => item.name === '搜索')!
        if (index === 1 && turn === 1) {
          observedSecondCase = true
          assert.equal(browser!.contexts().length, 1)
          assert.equal(browser!.contexts()[0]!.pages().length, 1)
          assert.equal(browser!.contexts()[0]!.pages()[0], originalPage)
          assert.equal(new URL(snapshot.url).pathname, '/continued')
          assert.equal(search.value, '数学')
          assert.equal(fixture.requests(), requestsAtCheckpoint)
          assert.deepEqual(trajectory, [])
          assert.equal(goal.previousCaseSummaries?.[0]?.caseKey, '0-TC-0')
          assert.equal(goal.previousCaseSummaries?.[0]?.status, firstStatus === 'budget' ? 'failed' : firstStatus)
          assert.ok(goal.previousCaseSummaries?.[0]?.summary)
          // Prior passed assertions and bindings must not satisfy this fresh checkpoint.
          return firstStatus === 'passed'
            ? { type: 'finish', summary: '不可继承前例断言' }
            : { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'expectValue', elementRef: search.ref, valueRef: 'keyword', assertionId: 'verified' }, reason: '不可继承前例绑定' }
        }
        if (turn === 1) {
          originalPage = browser!.contexts()[0]!.pages()[0]
          return { type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: 'keyword', sourceElementRef: snapshot.elements.find(item => item.role === 'option')!.ref, value: '数学', reason: '当前真实课程选项' }
        }
        if (turn === 2) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'fill', elementRef: search.ref, valueRef: 'keyword' }, reason: '留下输入状态' }
        if (turn === 3) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'click', elementRef: snapshot.elements.find(item => item.name === '继续')!.ref }, reason: '继续业务页面' }
        requestsAtCheckpoint = fixture.requests()
        if (firstStatus === 'budget') return { type: 'action', snapshotId: snapshot.snapshotId, action: turn % 2
          ? { action: 'expectVisible', elementRef: search.ref, assertionId: 'verified' }
          : { action: 'expectValue', elementRef: search.ref, valueRef: 'keyword', assertionId: 'verified' }, reason: `第 ${turn} 轮` }
        if (firstStatus === 'blocked') return { type: 'blocked', reason: '当前环境缺少更多候选' }
        if (turn === 4) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'expectValue', elementRef: search.ref, valueRef: firstStatus === 'failed' ? 'missing' : 'keyword', assertionId: 'verified' }, reason: '校验当前数据引用' }
        return { type: 'finish', summary: '第一条验证完成' }
      },
    }
    const result = await runAgentTest([caseGoal(fixture.targetUrl, 0), caseGoal(fixture.targetUrl, 1)], undefined, {
      projectProvider: emptyProject, decisionProvider, artifactRoot: fixture.artifactRoot,
      async launchBrowser() { browser = await chromium.launch({ headless: true }); return browser },
      onEvent: event => events.push(event),
    })
    assert.equal(observedSecondCase, true)
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.caseResults?.map(item => item.status), [firstStatus === 'budget' ? 'failed' : firstStatus, 'failed'])
    const [first, second] = result.caseResults!
    assert.equal(first!.caseKey, '0-TC-0')
    assert.equal(first!.title, '用例 0')
    assert.equal(first!.contractFingerprint, 'fingerprint-0')
    assert.equal(first!.startedFromUrl, fixture.targetUrl)
    assert.equal(first!.resolvedDataBindings[0]?.value, '数学')
    assert.equal(first!.trajectory[0]?.decision.type, 'resolve_test_data')
    if (firstStatus === 'budget') assert.match(first!.error!, /测试步骤超过上限/)
    assert.ok(first!.startedFromSnapshotId)
    assert.equal(first!.startedFromSnapshotId, first!.trajectory[0]?.snapshotId)
    assert.equal(second!.startedFromUrl, new URL('/continued', fixture.targetUrl).href)
    assert.equal(second!.continuation, 'reused_current_page')
    assert.deepEqual(second!.resolvedDataBindings, [])
    assert.deepEqual(second!.passedAssertions, [])
    assert.ok(second!.error?.match(/必要断言尚未完成|未解析的数据引用/))
    assert.ok(second!.screenshots.length)
    assert.notEqual(first!.tracePath, second!.tracePath)
    await stat(first!.tracePath!)
    await stat(second!.tracePath!)
    assert.ok(events.some(event => event.type === 'activity' && event.caseKey === '0-TC-1' && event.caseTitle === '用例 1'))
  })
}

test('stops the batch on browser loss and attributes infrastructure failure to the active case', async testContext => {
  const fixture = await sessionFixture(testContext)
  let browser: Browser
  let decisions = 0
  const result = await runAgentTest([caseGoal(fixture.targetUrl, 0), caseGoal(fixture.targetUrl, 1)], undefined, {
    projectProvider: emptyProject, artifactRoot: fixture.artifactRoot,
    async launchBrowser() { browser = await chromium.launch({ headless: true }); return browser },
    decisionProvider: { async decide() { decisions += 1; await browser.close(); return { type: 'blocked', reason: '浏览器已退出' } } },
  })
  assert.equal(result.status, 'infrastructure_failed')
  assert.equal(decisions, 1)
  assert.deepEqual(result.caseResults?.map(item => [item.caseKey, item.status]), [['0-TC-0', 'infrastructure_failed'],['0-TC-1','not_run']])
})

for (const firstStatus of ['failed', 'blocked'] as const) {
  test(`a ${firstStatus} case does not prevent the next case passing its own assertions`, async testContext => {
    const fixture = await sessionFixture(testContext)
    const result = await runAgentTest([caseGoal(fixture.targetUrl, 0), caseGoal(fixture.targetUrl, 1)], undefined, {
      projectProvider: emptyProject, artifactRoot: fixture.artifactRoot,
      decisionProvider: { async decide({ goal, snapshot, trajectory }) {
        if (goal.executionContract?.caseKey === '0-TC-0') return firstStatus === 'blocked'
          ? { type: 'blocked', reason: '缺少当前用例数据' }
          : { type: 'finish', summary: '尚未执行断言' }
        if (!trajectory.length) return { type: 'action', snapshotId: snapshot.snapshotId, action: {
          action: 'expectVisible', elementRef: snapshot.elements.find(item => item.name === '搜索')!.ref, assertionId: 'verified',
        }, reason: '当前用例独立验证' }
        return { type: 'finish', summary: '第二条已验证' }
      } },
    })
    assert.equal(result.status, firstStatus)
    assert.deepEqual(result.caseResults?.map(item => item.status), [firstStatus, 'passed'])
    assert.deepEqual(result.caseResults?.[1]?.passedAssertions, ['verified'])
  })
}

test('records launch failures as batch infrastructure failures', async () => {
  const result = await runAgentTest([caseGoal('http://localhost/start', 0)], undefined, {
    projectProvider: emptyProject,
    launchBrowser: async () => { throw new Error('browser unavailable') },
  })
  assert.equal(result.status, 'infrastructure_failed')
  assert.match(result.error!, /browser unavailable/)
  assert.equal(result.caseResults?.[0]?.status,'not_run')
  assert.equal(result.caseResults?.[0]?.continuation,'not_started')
  assert.deepEqual(result.caseResults?.[0]?.steps,[])
})

test('取消后拒绝迟到模型决策并停止后续用例', async t => {
  const fixture = await sessionFixture(t)
  const controller = new AbortController()
  let decisions = 0
  const result = await runAgentTest([caseGoal(fixture.targetUrl,0),caseGoal(fixture.targetUrl,1)],undefined,{
    projectProvider:emptyProject,artifactRoot:fixture.artifactRoot,signal:controller.signal,
    decisionProvider:{async decide(){ decisions++; controller.abort(); return {type:'finish',summary:'迟到的通过建议'} }},
  })
  assert.equal(decisions,1)
  assert.equal(result.status,'cancelled')
  assert.deepEqual(result.caseResults?.map(item=>item.status),['cancelled','not_run'])
  assert.deepEqual(result.caseResults?.[0]?.passedAssertions,[])
})
