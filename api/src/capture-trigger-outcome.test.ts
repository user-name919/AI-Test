import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import type { AgentTestGoal } from '@quality-ai/contracts'
import { runAgentTest } from './automation/agent-test-runner'
import { runAutomationPlan } from './automation/playwright-runner'

test('下载和开页点击已到页面后注入故障，不重复执行也不继续关联用例', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-capture-trigger-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let writes = 0
  const server = createServer((request, response) => {
    if (request.url === '/save') { writes++; response.end('ok'); return }
    if (request.url === '/export') {
      response.writeHead(200, { 'content-disposition': 'attachment; filename="sample.txt"', 'content-type': 'text/plain' })
      response.end('synthetic'); return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<a id="download" href="/export" onclick="save()">导出</a><a id="popup" href="/detail" target="_blank" onclick="save()">查看详情</a>
      <p>结果</p><script>function save(){const r=new XMLHttpRequest();r.open('POST','/save',false);r.send()}</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const targetUrl = `http://127.0.0.1:${address.port}`
  const launchBrowser = async () => {
    const browser = await chromium.launch({ headless: true })
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async options => {
      const context = await newContext(options)
      context.on('page', page => {
        const frame = page.mainFrame(), locate = frame.locator.bind(frame)
        frame.locator = (selector, options) => {
          const locator = locate(selector, options), click = locator.click.bind(locator)
          locator.click = async options => {
            await click(options)
            if (!options?.trial) throw new Error('注入：点击已派发但响应丢失')
          }
          return locator
        }
      })
      return context
    }
    return browser
  }
  const goals: AgentTestGoal[] = [0, 1].map(index => ({
    name: `捕获${index}`, targetUrl, objective: '验证捕获', requiredAssertions: [{ id: 'result', description: '结果可见' }],
    executionContract: { caseKey: `0-TC-${index}`, contractFingerprint: `capture-${index}`, contract: {
      objective: '验证捕获', preconditions: [], steps: ['触发捕获'], expectedAssertions: ['结果可见'], dataBindings: [], forbiddenBehaviors: [], uncertainties: [], writeOperations: ['记录合成页面的一次操作'],
    } },
  }))
  const writeAuthorizations = goals.map(goal => ({ caseId: goal.executionContract!.caseKey, caseKey: goal.executionContract!.caseKey, contractFingerprint: goal.executionContract!.contractFingerprint, operations: goal.executionContract!.contract.writeOperations!, targetUrl, confirmedAt: new Date().toISOString() }))
  for (const action of ['download', 'openPage'] as const) {
    const before = writes
    const step = action === 'download' ? { action, downloadId: 'sample', locator: { by: 'css', value: '#download' } }
      : { action, pageAlias: 'detail', locator: { by: 'css', value: '#popup' } }
    const result = await runAutomationPlan({ name: '捕获', targetUrl, steps: [], casePlans: goals.map(goal => ({
      caseKey: goal.executionContract!.caseKey, title: goal.name, contractFingerprint: goal.executionContract!.contractFingerprint, contract: goal.executionContract!.contract,
      steps: [step, { action: 'expectText', text: '结果', assertionIndex: 0 }],
    })) }, undefined, { artifactRoot: directory, launchBrowser, writeAuthorizations })
    assert.equal(writes - before, 1, action)
    assert.deepEqual(result.caseResults!.map(item => item.status), ['blocked', 'not_run'], action)
    assert.match(result.caseResults![0]!.error!, /结果不明.*注入/)
  }
  const before = writes
  let decisions = 0
  const dynamic = await runAgentTest(goals, undefined, { artifactRoot: directory, launchBrowser, writeAuthorizations, projectProvider: {
    async getProjectInfo() { return { id: 'fixture', name: 'fixture', connected: true, configuredRoot: '.', targetOrigins: [targetUrl] } },
    async resolveRoute() { return null }, async searchSource() { return [] }, async inspectFiles() { return { projectId: 'fixture', reason: 'unused', files: [], totalCharacters: 0 } },
  }, decisionProvider: { async decide({ snapshot }) {
    decisions++
    return { type: 'action', snapshotId: snapshot.snapshotId, reason: '导出', action: { action: 'download', downloadId: 'sample', elementRef: snapshot.elements.find(item => item.name === '导出')!.ref } }
  } } })
  assert.equal(writes - before, 1)
  assert.equal(decisions, 1)
  assert.deepEqual(dynamic.caseResults!.map(item => item.status), ['blocked', 'not_run'])
  assert.equal(dynamic.caseResults![0]!.trajectory[0]!.result!.code, 'action_outcome_unknown')
  assert.equal(dynamic.caseResults![0]!.trajectory[0]!.recovery, undefined)
})
