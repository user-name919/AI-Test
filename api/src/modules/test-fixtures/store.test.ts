import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile, unlink, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleTestFixtureRoutes } from './routes'
import { loadTestFixture } from './store'
import { runAutomationPlan } from '../../playwright-runner'
import type { AutomationPlan, CaseExecutionContract } from '@quality-ai/contracts'
import type { TestFixture } from '@quality-ai/contracts/test-fixtures'

test('登记附件API、固定真实上传及未授权/篡改/软链拒绝', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-ai-fixtures-'))
  const previous = process.env.QUALITY_AI_DATA_ROOT
  process.env.QUALITY_AI_DATA_ROOT = directory
  t.after(async () => { if (previous === undefined) delete process.env.QUALITY_AI_DATA_ROOT; else process.env.QUALITY_AI_DATA_ROOT = previous; await rm(directory, { recursive: true, force: true }) })
  const server = createServer(async (request, response) => {
    if (await handleTestFixtureRoutes(request, response)) return
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<label>附件<input type="file" onchange="document.querySelector(\'#result\').textContent=this.files[0].name+\'|\'+this.files[0].size"></label><div id="result">未上传</div>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const upload = (name: string) => fetch(`${base}/api/test-fixtures`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'text/plain', base64: Buffer.from('test').toString('base64') }) })
  assert.equal((await upload('../escape')).status, 400)
  const response = await upload('sample.txt')
  assert.equal(response.status, 201)
  const { fixture } = await response.json() as { fixture: TestFixture }
  assert.equal((await loadTestFixture(fixture.id)).buffer.toString(), 'test')
  const duplicate = await (await upload('sample.txt')).json() as { fixture: TestFixture }
  assert.notEqual(duplicate.fixture.id, fixture.id)
  const contract: CaseExecutionContract = { objective: '上传确认附件', preconditions: [], steps: ['上传登记的附件'], expectedAssertions: ['文件名及大小正确'], dataBindings: [{ id: 'attachment', label: '测试附件', mode: 'fixture', targetHint: '附件', businessIntent: '上传测试', constraints: { mustComeFromCurrentDom: false }, fixture: { value: fixture.id, evidence: '人工确认的合成测试附件' } }], forbiddenBehaviors: [], uncertainties: [] }
  const steps: AutomationPlan['steps'] = [{ action: 'uploadFile', locator: { by: 'label', value: '附件' }, fixtureId: fixture.id }, { action: 'expectElementText', locator: { by: 'css', value: '#result' }, text: 'sample.txt|4', exact: true, assertionIndex: 0 }]
  const result = await runAutomationPlan({ name: '受控上传', targetUrl: base, steps, casePlans: [
    { caseKey: '0-TC-0', title: '未授权附件', contractFingerprint: 'no', contract: { ...contract, dataBindings: [] }, steps },
    { caseKey: '0-TC-1', title: '已授权附件', contractFingerprint: 'yes', contract, steps },
  ] }, undefined, { artifactRoot: join(directory, 'artifacts') })
  assert.deepEqual(result.caseResults?.map(item => item.status), ['blocked', 'passed'])
  assert.deepEqual(result.caseResults?.[1].usedFixtures, [fixture])
  assert.equal(result.caseResults?.[1].passedAssertions.length, 1)
  const payload = join(directory, 'test-fixtures', fixture.id, 'payload')
  await writeFile(payload, 'fake')
  await assert.rejects(loadTestFixture(fixture.id), /内容已改变/)
  await assert.rejects(loadTestFixture('../escape'), /ID 无效/)
  await unlink(payload)
  const outside = join(directory, 'outside.txt')
  await writeFile(outside, 'test')
  await symlink(outside, payload)
  await assert.rejects(loadTestFixture(fixture.id), /受控目录/)
  const listed = await (await fetch(`${base}/api/test-fixtures`)).json() as { fixtures: TestFixture[]; warnings: string[] }
  assert.deepEqual(listed.fixtures.map(item => item.id), [duplicate.fixture.id])
  assert.equal(listed.warnings.length, 1)
  assert.equal(JSON.stringify(listed).includes(directory), false)
})
