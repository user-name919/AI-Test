import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import type { AgentTestGoal } from '@quality-ai/contracts'
import { saveTestFixture } from './modules/test-fixtures/store'
import { runAgentTest } from './automation/agent-test-runner'
import { PageObserver } from './automation/page-observer'
import { SingleActionExecutor } from './automation/single-action-executor'

test('动态上传拒绝未授权数据，操作失败不恢复，后续用例保留附件指纹并验证业务', async t => {
  const root = await mkdtemp(join(tmpdir(), 'quality-ai-agent-upload-')), previous = process.env.QUALITY_AI_DATA_ROOT
  process.env.QUALITY_AI_DATA_ROOT = root
  t.after(async () => { if (previous === undefined) delete process.env.QUALITY_AI_DATA_ROOT; else process.env.QUALITY_AI_DATA_ROOT = previous; await rm(root, { recursive: true, force: true }) })
  const fixture = await saveTestFixture({ name: 'example.txt', mimeType: 'text/plain', base64: Buffer.from('test').toString('base64') })
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<label>附件<input type="file" onchange="document.querySelector(\'#result\').textContent=this.files[0].name"></label><button>普通按钮</button><div id="result">未上传</div>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const targetUrl = `http://127.0.0.1:${address.port}`
  const goals: AgentTestGoal[] = [0, 1, 2].map(index => ({ name: `上传${index}`, targetUrl, objective: '上传登记文件', requiredAssertions: [{ id: 'file', description: '显示文件名' }], executionContract: { caseKey: `0-TC-${index}`, contractFingerprint: `f${index}`, contract: { objective: '上传登记文件', preconditions: [], steps: ['选择文件'], expectedAssertions: ['显示文件名'], forbiddenBehaviors: [], uncertainties: [], dataBindings: index === 0 ? [] : [{ id: 'upload', label: '附件', mode: 'fixture', targetHint: '附件', businessIntent: '验证文件选择', constraints: { mustComeFromCurrentDom: false }, fixture: { value: fixture.id, evidence: '合成测试人工确认' } }] } } }))
  const calls = new Map<string, number>()
  const result = await runAgentTest(goals, undefined, { artifactRoot: join(root, 'artifacts'), projectProvider: {
    async getProjectInfo() { return { id: 'fixture', name: 'fixture', configuredRoot: '.', connected: true, targetOrigins: [targetUrl] } },
    async resolveRoute() { return null }, async searchSource() { return [] }, async inspectFiles() { return { projectId: 'fixture', reason: 'unused', files: [], totalCharacters: 0 } },
  }, decisionProvider: { async decide({ goal, snapshot, trajectory }) {
    calls.set(goal.name, (calls.get(goal.name) ?? 0) + 1)
    if (!trajectory.length) return { type: 'action', snapshotId: snapshot.snapshotId, reason: '上传确认附件', action: { action: 'uploadFile', fixtureId: fixture.id, elementRef: snapshot.elements.find(item => item.name === (goal.name === '上传1' ? '普通按钮' : '附件'))!.ref } }
    if (trajectory.length === 1) return { type: 'action', snapshotId: snapshot.snapshotId, reason: '验证原预期', action: { action: 'expectText', text: 'example.txt', assertionId: 'file' } }
    return { type: 'finish', summary: '文件名验证通过' }
  } } })
  assert.deepEqual(result.caseResults?.map(item => item.status), ['blocked', 'failed', 'passed'])
  assert.equal(calls.get('上传1'), 1)
  assert.equal(result.caseResults?.[1].trajectory[0].recovery, undefined)
  assert.deepEqual(result.caseResults?.[2].usedFixtures, [fixture])
  assert.deepEqual(result.caseResults?.[2].passedAssertions, ['file'])
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage(); await page.goto(targetUrl)
    const observer = new PageObserver(), snapshot = await observer.observe(page)
    const ref = snapshot.elements.find(item => item.name === '附件')!.ref
    await page.locator('input').evaluate(element => element.remove())
    const executor = new SingleActionExecutor(page, observer.registry, targetUrl, root, goals[2].executionContract!.contract)
    const timeout = await executor.execute(snapshot.snapshotId, { action: 'uploadFile', elementRef: ref, fixtureId: fixture.id })
    assert.equal(timeout.ok, false); assert.equal(timeout.retryable, false)
    assert.match(timeout.message, /Timeout/)
    assert.deepEqual(timeout.usedFixture, fixture)
  } finally { await browser.close() }
})
