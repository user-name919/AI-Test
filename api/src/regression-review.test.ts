import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import type { RegressionAnalysis } from '@quality-ai/contracts/regressions'

const directory = mkdtempSync(join(tmpdir(), 'quality-ai-regression-review-'))
process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'db.sqlite')
const { database } = await import('./storage/database')
const { initializeRegressionJobs, getRegression } = await import('./modules/regressions/jobs')
const { initializeRegressionReviews, regressionReviewItems, getRegressionReviews, saveRegressionReview } = await import('./modules/regressions/review')
const { getRegressionCaseAsset, listRegressionCaseAssets } = await import('./modules/cases/regression-assets')
const { prepareAssetExecution } = await import('./modules/cases/execution-preparation')
const { createApiServer } = await import('./app')
const { saveEnvironment } = await import('./modules/projects/environment-repository')
const { validateDeploymentForExecution, getDeploymentConfirmation } = await import('./modules/regressions/deployments')

test('人工范围排除有理由、修改用例独立版本且不覆盖 AI 原文', async t => {
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  initializeRegressionJobs(); initializeRegressionReviews()
  const contract = { objective: '原目标', preconditions: [], steps: ['原操作'], expectedAssertions: ['原预期'], dataBindings: [], forbiddenBehaviors: [], uncertainties: [] }
  const id = randomUUID()
  const analysis: RegressionAnalysis = { id, projectId: 'fixture', changeSetId: randomUUID(), factsHash: 'a'.repeat(64), targetSha: 'b'.repeat(40), status: 'completed', stage: 'finished', createdAt: 'now', updatedAt: 'now', generation: {
    promptVersion: 'fixture', model: 'fixture', reviewStatus: 'pending', pendingEvidenceIds: [], omittedEvidenceIds: [], limitations: ['静态线索不完整'], batches: [{ id: 'batch-1', inputHash: 'hash', evidence: [], suggestions: {
      risks: ['r1', 'r2'].map(key => ({ id: key, title: key, reason: '建议风险', severity: 'medium', confidence: 'low', evidenceIds: ['e1'] })),
      cases: [{ title: '原用例', riskIds: ['r1'], verification: 'browser', verificationReason: '可观察 UI', contract }], limitations: [],
    } }],
  } }
  database.prepare('INSERT INTO regression_analyses (id,request_id,record_json) VALUES (?,?,?)').run(id, randomUUID(), JSON.stringify(analysis))
  assert.equal(regressionReviewItems(analysis).cases[0]!.key, 'batch-1:case-0')
  const content = { status: 'confirmed', scopeNote: '只回归选择器；静态未解析部分由人工补验', risks: [{ key: 'batch-1:r1', decision: 'include' }, { key: 'batch-1:r2', decision: 'exclude', reason: '非本次功能范围，单独跟进' }], cases: [{ key: 'batch-1:case-0', decision: 'include', title: '人工改标题', verification: 'browser', verificationReason: '页面可观察', finalContract: { ...contract, steps: ['人工最终操作'], expectedAssertions: ['人工最终预期'] } }] }
  assert.throws(() => saveRegressionReview(id, { expectedRevision: 0, content: { ...content, risks: [{ key: 'batch-1:r1', decision: 'include' }] } }), /逐项决定/)
  assert.throws(() => saveRegressionReview(id, { expectedRevision: 0, content: { ...content, risks: [{ key: 'batch-1:r1', decision: 'include' }, { key: 'batch-1:r2', decision: 'exclude', reason: ' ' }] } }))
  assert.throws(() => saveRegressionReview(id, { expectedRevision: 0, content: { ...content, cases: [{ ...content.cases[0], key: 'unrelated' }] } }), /不属于/)
  const first = saveRegressionReview(id, { expectedRevision: 0, content })
  assert.equal(first.revision, 1)
  const asset = listRegressionCaseAssets(id)[0]!
  assert.equal(asset.source.type, 'change_regression')
  assert.deepEqual(asset.finalContract?.steps, ['人工最终操作'])
  assert.deepEqual(asset.originalSuggestion.steps, ['原操作'])
  assert.deepEqual(asset.resolved.contract, asset.finalContract)
  assert.equal(asset.resolved.readiness.agent.executable, false)
  assert.throws(() => prepareAssetExecution({ mode: 'agent', targetUrl: 'http://localhost', cases: [{ caseId: asset.id, revision: asset.revision, contractFingerprint: asset.resolved.contractFingerprint }] }), /部署版本确认/)
  assert.throws(() => saveRegressionReview(id, { expectedRevision: 0, content }), /版本冲突/)
  const second = saveRegressionReview(id, { expectedRevision: 1, content: { ...content, scopeNote: '新版范围备注' } })
  assert.equal(second.revision, 2)
  assert.equal(listRegressionCaseAssets(id)[0]!.revision, 2)
  assert.deepEqual(getRegressionCaseAsset(asset.id), asset, '新审核版本不覆盖旧资产的契约和指纹')
  assert.notEqual(listRegressionCaseAssets(id)[0]!.resolved.contractFingerprint, asset.resolved.contractFingerprint)
  assert.deepEqual(getRegressionReviews(id)[1], first)
  assert.deepEqual(getRegression(id), analysis, '原始模型产物保持不变')
  assert.throws(() => saveRegressionReview(id, { expectedRevision: 2, content: { ...content, risks: content.risks.map(risk => ({ ...risk, decision: 'exclude', reason: '全部排除' })) } }), /至少关联一个纳入/)
  const api = createApiServer()
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    const list = await (await fetch(`${url}/api/cases?sourceType=change_regression&sourceId=${id}`)).json()
    assert.equal(list.cases[0].revision, 2)
    const detail = await (await fetch(`${url}/api/cases/${encodeURIComponent(asset.id)}/contract`)).json()
    assert.deepEqual(detail.asset, asset)
    const immutable = await fetch(`${url}/api/cases/${encodeURIComponent(asset.id)}/review`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(immutable.status, 409)
    const environment = saveEnvironment({ name: '合成测试环境', baseUrl: 'http://example.test', targetUrl: 'http://example.test/page' })
    const expected = { regressionId: id, reviewRevision: 2, environmentId: environment.id, targetUrl: environment.targetUrl }
    const confirmationInput = { reviewRevision: 2, environmentId: environment.id, targetUrl: environment.targetUrl, confirmedBy: '测试人员', note: '根据本地夹具发布记录人工核对', deployedSha: analysis.targetSha }
    const postConfirmation = (body: unknown) => fetch(`${url}/api/regressions/${id}/deployments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const matchedResponse = await postConfirmation(confirmationInput)
    assert.equal(matchedResponse.status, 201)
    const matched = (await matchedResponse.json()).confirmation
    assert.equal(matched.status, 'matched')
    assert.equal(validateDeploymentForExecution(matched.id, expected).id, matched.id)
    assert.throws(() => validateDeploymentForExecution(matched.id, { ...expected, reviewRevision: 1 }), /不一致/)
    const mismatched = (await (await postConfirmation({ ...confirmationInput, deployedSha: 'c'.repeat(40) })).json()).confirmation
    assert.equal(mismatched.status, 'mismatched')
    assert.throws(() => validateDeploymentForExecution(mismatched.id, expected), /不匹配/)
    assert.throws(() => validateDeploymentForExecution(matched.id, expected), /更新的部署确认/)
    assert.deepEqual(getDeploymentConfirmation(matched.id), matched, '新确认不重写旧历史')
    const unknown = (await (await postConfirmation({ ...confirmationInput, deployedSha: undefined, note: '未核实版本，仅进行探索性回归，保留此限制' })).json()).confirmation
    assert.equal(validateDeploymentForExecution(unknown.id, expected).status, 'unverified')
    assert.equal((await postConfirmation({ ...confirmationInput, note: ' ' })).status, 409)
    assert.equal((await postConfirmation({ ...confirmationInput, targetUrl: 'http://other.test' })).status, 409)
    saveEnvironment({ id: environment.id, name: environment.name, baseUrl: environment.baseUrl, targetUrl: 'http://example.test/changed' })
    assert.throws(() => validateDeploymentForExecution(unknown.id, expected), /配置已变化/)
    assert.equal((await (await fetch(`${url}/api/regressions/${id}/deployments`)).json()).confirmations.length, 3)
  } finally { await new Promise<void>(resolve => api.close(() => resolve())) }
})
