import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { AutomationPlan, ExecutionRecord, AgentTestGoal } from '@quality-ai/contracts'
import { runAgentTest } from './automation/agent-test-runner'
import { runAutomationPlan } from './automation/playwright-runner'
import { captureDownload, assertDownload } from './automation/download-capture'
import { executionArtifacts } from './modules/executions/artifacts'
import { executionMarkdown } from './modules/executions/report'

test('真实下载保留失败文件，内容反例不通过且后续继续，下载不跨用例复用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'quality-ai-download-')), previous = process.env.QUALITY_AI_DATA_ROOT
  process.env.QUALITY_AI_DATA_ROOT = root
  t.after(async () => { if (previous === undefined) delete process.env.QUALITY_AI_DATA_ROOT; else process.env.QUALITY_AI_DATA_ROOT = previous; await rm(root, { recursive: true, force: true }) })
  const server = createServer((request, response) => {
    if (request.url === '/export') { response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' }); response.end('name,status\nAlpha,passed\n'); return }
    response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<a href="/export">导出</a><button>不导出</button>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const targetUrl = `http://127.0.0.1:${address.port}`
  const steps = (textIncludes: string): AutomationPlan['steps'] => [
    { action: 'download', downloadId: 'report', locator: { by: 'role', value: 'link', name: '导出' } },
    { action: 'expectDownload', downloadId: 'report', name: 'report.csv', minBytes: 1, textIncludes, assertionIndex: 0 },
  ]
  const result = await runAutomationPlan({ name: '下载测试', targetUrl, steps: steps('wrong'), casePlans: [
    { caseKey: '0-TC-0', title: '错误内容', contractFingerprint: 'a', steps: steps('wrong') },
    { caseKey: '0-TC-1', title: '不能借用前一条下载', contractFingerprint: 'b', steps: [steps('Alpha')[1]] },
    { caseKey: '0-TC-2', title: '真实内容', contractFingerprint: 'c', steps: steps('Alpha,passed') },
  ] }, undefined, { artifactRoot: join(root, 'artifacts') })
  assert.deepEqual(result.caseResults?.map(item => item.status), ['failed', 'failed', 'passed'])
  assert.match(result.caseResults?.[0].error ?? '', /未包含/)
  assert.match(result.caseResults?.[1].error ?? '', /尚未完成下载/)
  const evidence = result.caseResults?.[0].downloads?.[0]; assert.ok(evidence)
  assert.equal(await readFile(evidence.path, 'utf8'), 'name,status\nAlpha,passed\n')
  const artifacts = executionArtifacts({ ...result, mode: 'plan', caseKeys: ['0-TC-0', '0-TC-1', '0-TC-2'] } as ExecutionRecord).filter(item => item.kind === 'download')
  assert.equal(artifacts.length, 2)
  assert.ok(artifacts.every(item => item.available && item.name === 'report.csv'))
  const markdown = executionMarkdown({ ...result, mode: 'plan', caseKeys: [] } as ExecutionRecord, artifacts)
  assert.match(markdown, /实际下载 report/)
  assert.ok(markdown.includes(evidence.sha256))
  const goals: AgentTestGoal[] = [0, 1, 2, 3].map(index => ({ name: `下载${index}`, targetUrl, objective: '验证导出', requiredAssertions: [{ id: 'content', description: index === 0 ? '包含wrong' : '包含Alpha' }], executionContract: { caseKey: `0-TC-${index}`, contractFingerprint: `dynamic-${index}`, contract: { objective: '验证导出', preconditions: [], steps: ['导出并验证文件'], expectedAssertions: [index === 0 ? '包含wrong' : '包含Alpha'], dataBindings: [], forbiddenBehaviors: [], uncertainties: [] } } }))
  const calls = new Map<string, number>()
  const dynamic = await runAgentTest(goals, undefined, { artifactRoot: join(root, 'artifacts'), projectProvider: {
    async getProjectInfo() { return { id: 'fixture', name: 'fixture', connected: true, configuredRoot: '.', targetOrigins: [targetUrl] } },
    async resolveRoute() { return null }, async searchSource() { return [] }, async inspectFiles() { return { projectId: 'fixture', reason: 'unused', files: [], totalCharacters: 0 } },
  }, decisionProvider: { async decide({ goal, snapshot, trajectory }) {
    calls.set(goal.name, (calls.get(goal.name) ?? 0) + 1)
    if (!trajectory.length && goal.name !== '下载1') return { type: 'action', snapshotId: snapshot.snapshotId, reason: '按契约导出', action: { action: 'download', downloadId: 'report', elementRef: snapshot.elements.find(item => item.name === (goal.name === '下载3' ? '不导出' : '导出'))!.ref } }
    if (trajectory.length <= 1) return { type: 'action', snapshotId: snapshot.snapshotId, reason: '验证文件真实内容', action: { action: 'expectDownload', downloadId: 'report', name: 'report.csv', minBytes: 1, textIncludes: goal.name === '下载0' ? 'wrong' : 'Alpha', assertionId: 'content' } }
    return { type: 'finish', summary: '文件验证完成' }
  } } })
  assert.deepEqual(dynamic.caseResults?.map(item => item.status), ['failed', 'failed', 'passed', 'failed'])
  assert.match(dynamic.caseResults?.[1].error ?? '', /尚未完成下载/)
  assert.equal(dynamic.caseResults?.[0].downloads?.length, 1)
  assert.equal(dynamic.caseResults?.[2].downloads?.[0].name, 'report.csv')
  assert.equal(dynamic.caseResults?.[3].trajectory[0].result?.retryable, false)
  assert.equal(calls.get('下载3'), 1)
  assert.equal(dynamic.caseResults?.[3].trajectory[0].recovery, undefined)
  await writeFile(evidence.path, 'changed')
  await assert.rejects(assertDownload(evidence, { action: 'expectDownload', downloadId: 'report', minBytes: 1 }), /已改变/)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage(); await page.goto(targetUrl)
    const controller = new AbortController()
    const pending = captureDownload(page, async () => { controller.abort(new Error('主动取消下载')) }, root, 'cancel', controller.signal)
    await assert.rejects(pending, /主动取消/)
    const resumed = await captureDownload(page, () => page.getByRole('link', { name: '导出' }).click(), root, 'after-cancel')
    assert.equal(resumed.downloadId, 'after-cancel')
    assert.equal(resumed.name, 'report.csv')
  } finally { await browser.close() }
})
