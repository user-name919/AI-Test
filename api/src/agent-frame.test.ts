import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { AgentTestGoal } from '@quality-ai/contracts'
import { PageObserver } from './page-observer'
import { SingleActionExecutor } from './single-action-executor'
import { runAgentTest } from './agent-test-runner'
import { executionMarkdown } from './modules/executions/report'

test('动态框架观察与执行同域，切换失效旧引用，错误断言继续后续用例', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-frame-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(request.url === '/frame'
      ? '<title>业务框架</title><button onclick="this.textContent=\'框架已保存\'">保存</button><span>框架内容</span>'
      : '<title>外层</title><button onclick="this.textContent=\'误点主页面\'">保存</button><button>额外按钮</button><iframe name="业务" src="/frame"></iframe><iframe name="隐藏" style="display:none" src="/frame"></iframe>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const targetUrl = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage(); await page.goto(targetUrl)
    const observer = new PageObserver(), outer = await observer.observe(page)
    assert.equal(outer.frameContext?.frames.length, 2)
    const frame = outer.frameContext!.frames.find(frame => frame.name === '业务')!
    const main = outer.frameContext!.frames.find(frame => frame.main)!
    const executor = new SingleActionExecutor(page, observer.registry, targetUrl, directory)
    assert.equal((await executor.execute(outer.snapshotId, { action: 'switchFrame', frameRef: frame.ref })).ok, true)
    assert.equal((await executor.execute(outer.snapshotId, { action: 'expectText', text: '保存', assertionId: 'old' })).ok, false)
    const inner = await observer.observe(page)
    assert.equal(inner.url, `${targetUrl}/frame`)
    assert.equal(inner.frameContext!.frames.find(frame => frame.active)!.ref, frame.ref)
    const save = inner.elements.find(item => item.name === '保存')!
    assert.equal((await executor.execute(inner.snapshotId, { action: 'click', elementRef: save.ref })).ok, true)
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 1)
    assert.equal(await page.frame({ name: '业务' })!.getByRole('button').innerText(), '框架已保存')
    assert.equal((await executor.execute(inner.snapshotId, { action: 'expectCount', role: 'button', count: 1, exact: false, assertionId: 'count' })).ok, true)
    assert.equal((await executor.execute(inner.snapshotId, { action: 'switchFrame', frameRef: main.ref })).ok, true)
    const back = await observer.observe(page)
    assert.equal(back.frameContext!.frames.find(frame => frame.active)!.main, true)
    assert.throws(() => observer.registry.resolve(inner.snapshotId, save.ref), /失效/)
    await executor.execute(back.snapshotId, { action: 'switchFrame', frameRef: frame.ref })
    const beforeRemoval = await observer.observe(page)
    await page.locator('iframe[name="业务"]').evaluate(element => element.remove())
    await assert.rejects(observer.observe(page), /框架失效/)
    assert.equal((await executor.execute(beforeRemoval.snapshotId, { action: 'expectText', text: '保存', assertionId: 'stale' })).ok, false)
  } finally { await browser.close() }

  const goals: AgentTestGoal[] = [0, 1].map(index => ({ name: `框架用例${index}`, targetUrl, objective: '验证嵌入页面按钮数量', requiredAssertions: [{ id: 'count', description: '按钮数量符合预期' }], executionContract: { caseKey: `0-TC-${index}`, contractFingerprint: `frame-${index}`, contract: { objective: '验证嵌入页面', preconditions: [], steps: ['进入业务框架'], expectedAssertions: [index ? '一枚按钮' : '两枚按钮'], dataBindings: [], forbiddenBehaviors: [], uncertainties: [] } } }))
  const result = await runAgentTest(goals, undefined, { artifactRoot: directory, projectProvider: {
    async getProjectInfo() { return { id: 'fixture', name: 'fixture', configuredRoot: '.', connected: true, targetOrigins: [targetUrl] } },
    async resolveRoute() { return null }, async searchSource() { return [] }, async inspectFiles() { return { projectId: 'fixture', reason: 'unused', files: [], totalCharacters: 0 } },
  }, decisionProvider: { async decide({ goal, snapshot, trajectory }) {
    if (!trajectory.length) return { type: 'action', snapshotId: snapshot.snapshotId, reason: '进入实际业务框架', action: { action: 'switchFrame', frameRef: snapshot.frameContext!.frames.find(frame => frame.name === '业务')!.ref } }
    if (trajectory.length === 1) return { type: 'action', snapshotId: snapshot.snapshotId, reason: '验证原始数量断言', action: { action: 'expectCount', role: 'button', count: goal.name.endsWith('0') ? 2 : 1, exact: false, assertionId: 'count' } }
    return { type: 'finish', summary: '框架按钮数量已验证' }
  } } })
  assert.deepEqual(result.caseResults?.map(item => item.status), ['failed', 'passed'])
  assert.equal(result.caseResults?.[0].trajectory[1].observation?.frameContext?.frames.find(frame => frame.active)?.name, '业务')
  assert.match(executionMarkdown({ ...result, caseKeys: ['0-TC-0', '0-TC-1'] }, []), /观察框架：嵌入页面/)
})
