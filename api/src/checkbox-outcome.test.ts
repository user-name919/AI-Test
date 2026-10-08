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
import { PageObserver } from './automation/page-observer'
import { SingleActionExecutor } from './automation/single-action-executor'

for (const action of ['check', 'uncheck'] as const) {
  test(`${action} 已触发业务请求但页面撤回状态，两模式不重复派发且停止批次`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'quality-ai-checkbox-outcome-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    let writes = 0
    const server = createServer((request, response) => {
      if (request.url === '/save') {
        writes++
        response.end('ok')
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      // A synchronous request makes receipt deterministic before Playwright checks the final state.
      response.end(`<input type="checkbox" aria-label="自动保存设置" ${action === 'uncheck' ? 'checked' : ''}
        onchange="const request = new XMLHttpRequest(); request.open('POST', '/save', false); request.send(); this.checked = !this.checked">
        <p>只读内容</p>`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const goals: AgentTestGoal[] = [0, 1].map(index => ({
      name: `设置${index}`, targetUrl: url, objective: '切换设置并验证结果',
      requiredAssertions: [{ id: 'state', description: '设置状态符合预期' }],
      executionContract: {
        caseKey: `0-TC-${index}`, contractFingerprint: `checkbox-${index}`,
        contract: {
          objective: '切换设置并验证结果', preconditions: [], steps: ['切换设置'],
          expectedAssertions: ['设置状态符合预期'], dataBindings: [], forbiddenBehaviors: [], uncertainties: [],
          writeOperations: ['修改合成页面的自动保存设置'],
        },
      },
    }))
    const writeAuthorizations = goals.map(goal => ({
      caseId: goal.executionContract!.caseKey, caseKey: goal.executionContract!.caseKey,
      contractFingerprint: goal.executionContract!.contractFingerprint,
      operations: goal.executionContract!.contract.writeOperations!, targetUrl: url, confirmedAt: new Date().toISOString(),
    }))
    let decisions = 0
    const dynamic = await runAgentTest(goals, undefined, {
      artifactRoot: directory, writeAuthorizations,
      projectProvider: {
        async getProjectInfo() { return { id: 'fixture', name: 'fixture', configuredRoot: '.', connected: true, targetOrigins: [url] } },
        async resolveRoute() { return null }, async searchSource() { return [] },
        async inspectFiles() { return { projectId: 'fixture', reason: 'unused', files: [], totalCharacters: 0 } },
      },
      decisionProvider: { async decide({ snapshot }) {
        decisions++
        return { type: 'action', snapshotId: snapshot.snapshotId, reason: '按契约切换设置', action: {
          action, elementRef: snapshot.elements.find(item => item.role === 'checkbox')!.ref,
        } }
      } },
    })
    assert.equal(writes, 1)
    assert.equal(decisions, 1)
    assert.deepEqual(dynamic.caseResults!.map(item => item.status), ['blocked', 'not_run'])
    const attempt = dynamic.caseResults![0]!.trajectory[0]!
    assert.equal(attempt.result!.code, 'action_outcome_unknown')
    assert.equal(attempt.result!.retryable, false)
    assert.equal(attempt.recovery, undefined)
    assert.match(attempt.result!.message, /did not change its state/)

    const fixed = await runAutomationPlan({
      name: '设置验证', targetUrl: url, steps: [],
      casePlans: goals.map(goal => ({
        caseKey: goal.executionContract!.caseKey, title: goal.name,
        contractFingerprint: goal.executionContract!.contractFingerprint, contract: goal.executionContract!.contract,
        steps: [{ action, locator: { by: 'role', value: 'checkbox', name: '自动保存设置' } },
          { action: 'expectText', text: '只读内容', assertionIndex: 0 }],
      })),
    }, undefined, { artifactRoot: directory, writeAuthorizations })
    assert.equal(writes, 2, '每种模式各发送一次，trial 不派发 change，下一用例不继续写入')
    assert.deepEqual(fixed.caseResults!.map(item => item.status), ['blocked', 'not_run'])
    assert.match(fixed.caseResults![0]!.error!, /结果不明.*did not change its state/)
    assert.match(fixed.caseResults![1]!.error!, /结果不明/)
  })
}

test('复选框派发前禁用仍可有限恢复，已满足的目标状态不会再次触发 change', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<input type="checkbox" aria-label="设置" onchange="window.changes=(window.changes||0)+1">')
  const observer = new PageObserver()
  const snapshot = await observer.observe(page)
  const ref = snapshot.elements.find(item => item.role === 'checkbox')!.ref
  const original = observer.registry.resolve.bind(observer.registry)
  observer.registry.resolve = (id, elementRef) => {
    const locator = original(id, elementRef)
    for (const action of ['check', 'uncheck'] as const) {
      const dispatch = locator[action].bind(locator)
      locator[action] = options => dispatch({ ...options, timeout: 100 })
    }
    return locator
  }
  const executor = new SingleActionExecutor(page, observer.registry, 'http://fixture.test', tmpdir())
  for (const action of ['check', 'uncheck'] as const) {
    await page.getByRole('checkbox').evaluate((element, checked) => {
      const input = element as HTMLInputElement
      input.checked = checked
      input.disabled = true
    }, action === 'uncheck')
    const blocked = await executor.execute(snapshot.snapshotId, { action, elementRef: ref })
    assert.equal(blocked.code, 'technical_action_failed')
    assert.equal(blocked.retryable, true)
    assert.equal(await page.evaluate(() => Reflect.get(window, 'changes')), undefined)
    await page.getByRole('checkbox').evaluate(element => { (element as HTMLInputElement).disabled = false })
    assert.equal((await executor.execute(snapshot.snapshotId, { action, elementRef: ref })).ok, true)
    const changes = await page.evaluate(() => Reflect.get(window, 'changes'))
    assert.equal((await executor.execute(snapshot.snapshotId, { action, elementRef: ref })).ok, true)
    assert.equal(await page.evaluate(() => Reflect.get(window, 'changes')), changes)
    await page.evaluate(() => Reflect.deleteProperty(window, 'changes'))
  }
})
