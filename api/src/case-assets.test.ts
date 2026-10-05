import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import test, { after, before } from 'node:test'
import type { PrdAnalysis } from '@quality-ai/contracts'

const directory = mkdtempSync(join(tmpdir(), 'quality-ai-assets-'))
process.env.QUALITY_AI_DATABASE_PATH = join(directory, 'test.sqlite')
const { saveAnalysis, getAnalysisById } = await import('./modules/requirements/repository')
const { listCaseAssets, getCaseAsset, saveCaseAssetReview, listCaseAssetRevisions, saveAnalysisReviewWithHistory, captureExecutionCases } = await import('./modules/cases/repository')
const { saveExecution, getExecutionById } = await import('./modules/executions/repository')
const { resolveCaseExecutionContract } = await import('./review-execution-context')
const { database } = await import('./storage/database')
const { createApiServer } = await import('./app')
const server = createApiServer()
let url = ''
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

const result: PrdAnalysis = {
  versionName: '合成版本', productName: '测试', overview: '测试',
  requirements: [{ title: '筛选', summary: '筛选', risk: '高风险', riskReason: '数据', businessRules: [], pageStates: [], questions: [],
    testCases: [{ title: '筛选用例', type: '主流程', priority: 'P0', preconditions: ['已登录'], steps: ['展开选项'], expectedResult: '显示选项', blockedByQuestion: false }],
  }],
}
function seed(id: string) {
  saveAnalysis({ id, fileName: '合成.md', fileNames: ['合成.md'], sourceText: '合成需求', provider: 'test', model: 'test', result, createdAt: new Date().toISOString() })
  return listCaseAssets(id)[0]
}

test('稳定身份、初始建议和不可变历史；修改后旧执行解析器立即看到最终口径', () => {
  const initial = seed('stable')
  assert.equal(initial.reviewStatus, 'legacy_unreviewed')
  assert.equal(listCaseAssets('stable')[0].id, initial.id)
  const contract = { ...initial.finalContract, objective: '人工修改后的筛选', steps: ['打开实际候选列表'] }
  const saved = saveCaseAssetReview(initial.id, 1, { status: 'confirmed', finalContract: contract })
  assert.equal(saved.kind, 'saved')
  if (saved.kind !== 'saved') throw new Error('保存失败')
  assert.equal(saved.asset.revision, 2)
  assert.equal(saved.asset.originalSuggestion.objective, '筛选用例')
  assert.equal(resolveCaseExecutionContract(getAnalysisById('stable')!, '0-TC-0').contract.objective, contract.objective)
  const stale = saveCaseAssetReview(initial.id, 1, { status: 'draft', finalContract: initial.finalContract })
  assert.equal(stale.kind, 'conflict')
  assert.equal(getCaseAsset(initial.id)?.finalContract.objective, contract.objective)
  const history = listCaseAssetRevisions(initial.id)!
  assert.deepEqual(history.map(item => item.revision), [2, 1])
  assert.equal(history[1].resolved.contract.objective, '筛选用例')
  saveCaseAssetReview(initial.id, 2, { status: 'confirmed', finalContract: contract })
  assert.equal(listCaseAssetRevisions(initial.id)?.length, 2)
})

test('兼容 Review 入口不能绕过已建立资产的并发保护，勾选仍兼容', () => {
  const asset = seed('legacy')
  const analysis = getAnalysisById('legacy')!
  const denied = saveAnalysisReviewWithHistory(analysis, { ...analysis.review, caseReviews: {
    '0-TC-0': { status: 'confirmed', finalContract: asset.finalContract, updatedAt: new Date().toISOString() },
  } })
  assert.equal(denied.kind, 'conflict')
  assert.equal(getCaseAsset(asset.id)?.revision, 1)
  const accepted = saveAnalysisReviewWithHistory(analysis, { ...analysis.review, selectedCases: ['0-TC-0'] })
  assert.equal(accepted.kind, 'saved')
  assert.deepEqual(getAnalysisById('legacy')?.review.selectedCases, ['0-TC-0'])
})

test('不存在的来源或资产不会被创建为假记录', () => {
  assert.deepEqual(listCaseAssets('missing'), [])
  assert.equal(getCaseAsset('missing'), null)
  assert.equal(listCaseAssetRevisions('missing'), null)
})

test('执行前固定审核版本，后续编辑不污染已保存报告，过期计划拒绝执行', () => {
  const asset = seed('snapshot')
  const expected = [{ caseKey: '0-TC-0', contractFingerprint: asset.resolved.contractFingerprint }]
  const snapshots = captureExecutionCases('snapshot', expected, 'agent')
  assert.equal(snapshots[0].caseId, asset.id)
  saveExecution({ id: 'snapshot-result', name: '合成执行', targetUrl: 'https://example.test', status: 'passed', startedAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:00:01Z', durationMs: 1000, steps: [], screenshots: [], caseSnapshots: snapshots })
  saveCaseAssetReview(asset.id, 1, { status: 'confirmed', finalContract: { ...asset.finalContract, objective: '后续修改' } })
  assert.equal(getExecutionById('snapshot-result')?.caseSnapshots?.[0].revision, 1)
  assert.equal(getExecutionById('snapshot-result')?.caseSnapshots?.[0].resolved.contract.objective, '筛选用例')
  assert.throws(() => captureExecutionCases('snapshot', expected, 'plan'), /用例口径已变化/)
  assert.throws(() => captureExecutionCases('snapshot', [expected[0], expected[0]], 'agent'), /不能为空或重复/)
})

test('HTTP 审核入口校验版本，返回可供对比的最新资产，历史接口保留原始口径', async () => {
  const asset = seed('http')
  const body = { expectedRevision: 1, review: { status: 'confirmed', finalContract: { ...asset.finalContract, objective: '人工 HTTP 口径' } } }
  const patch = (value: unknown) => fetch(`${url}/api/cases/${asset.id}/review`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  assert.equal((await patch({ review: body.review })).status, 400)
  assert.equal((await patch(body)).status, 200)
  const conflict = await patch(body)
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).asset.revision, 2)
  const history = await (await fetch(`${url}/api/cases/${asset.id}/history`)).json()
  assert.equal(history.revisions.length, 2)
  assert.equal(history.revisions[1].resolved.contract.objective, asset.originalSuggestion.objective)
  assert.equal((await fetch(`${url}/api/cases/missing/contract`)).status, 404)
  const regressions = await fetch(`${url}/api/cases?sourceType=change_regression`)
  assert.equal(regressions.status, 200)
  assert.deepEqual((await regressions.json()).cases, [], '需求资产不能混入回归来源')
  assert.equal((await fetch(`${url}/api/cases?sourceType=unsupported`)).status, 400)
})
