import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import type { CaseExecutionContract, PrdAnalysis } from '../shared/contracts'

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'quality-ai-contract-api-test-'))
process.env.QUALITY_AI_DATABASE_PATH = join(temporaryDirectory, 'quality-ai.sqlite')

const databaseModule = await import('./database')
const { createApiServer } = await import('./index')
const server = createApiServer()
let baseUrl = ''

const result: PrdAnalysis = {
  versionName: '考试管理 1.0',
  productName: '教师工作台',
  overview: '验证考试筛选。',
  requirements: [{
    title: '考试筛选',
    summary: '根据当前账号的考试数据进行筛选。',
    risk: '高风险',
    riskReason: '测试数据来源错误会造成误报。',
    businessRules: [{ description: '只使用当前账号可见考试', evidence: '产品需求' }],
    pageStates: [{ trigger: '打开选择器', initialState: '展示考试', interaction: '输入关键词', expectedResult: '过滤考试' }],
    questions: [],
    testCases: [{
      title: '按考试名称筛选', type: '主流程', priority: 'P0', preconditions: ['教师已登录'],
      steps: ['打开考试选择器', '输入考试名称'], expectedResult: '仅显示匹配考试', blockedByQuestion: false,
    }],
  }],
}

const reviewedContract: CaseExecutionContract = {
  objective: '验证基于当前 DOM 候选项的考试筛选',
  preconditions: ['教师已登录'],
  steps: ['打开考试选择器', '输入来源于可见考试的关键词'],
  expectedAssertions: ['来源考试仍在筛选结果中'],
  dataBindings: [{
    id: 'exam-query', label: '考试搜索词', mode: 'runtime_dom', targetHint: '考试搜索框',
    businessIntent: '验证部分关键词筛选', strategy: 'visible_option_substring',
    constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true },
  }],
  forbiddenBehaviors: ['不得凭空生成考试名称'],
  uncertainties: [],
}

before(async () => {
  databaseModule.saveAnalysis({
    id: '11111111-1111-4111-8111-111111111111',
    fileName: '考试筛选.md',
    fileNames: ['考试筛选.md'],
    sourceText: '考试筛选需求正文',
    provider: 'test',
    model: 'test-model',
    result,
    createdAt: '2026-09-03T08:00:00.000Z',
  })
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  delete process.env.QUALITY_AI_DATABASE_PATH
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

test('returns the server-resolved contract and fingerprint', async () => {
  const response = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/cases/0-TC-0/contract`)
  const body = await response.json() as {
    caseContract: { caseKey: string; contractFingerprint: string; contract: CaseExecutionContract }
  }

  assert.equal(response.status, 200)
  assert.equal(body.caseContract.caseKey, '0-TC-0')
  assert.match(body.caseContract.contractFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(body.caseContract.contract.objective, '按考试名称筛选')
})

test('returns 404 for an unknown analysis and 400 for an unknown case', async () => {
  const missingAnalysis = await fetch(`${baseUrl}/api/analyses/22222222-2222-4222-8222-222222222222/cases/0-TC-0/contract`)
  const missingCase = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/cases/0-TC-9/contract`)

  assert.equal(missingAnalysis.status, 404)
  assert.equal(missingCase.status, 400)
})

test('PATCH accepts case reviews, preserves them for legacy clients, and ignores client-derived fields', async () => {
  const firstPatch = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      confirmedQuestions: [],
      selectedCases: ['0-TC-0'],
      questionReviews: {},
      caseReviews: {
        '0-TC-0': {
          status: 'confirmed',
          finalContract: reviewedContract,
          updatedAt: '2026-09-03T09:00:00.000Z',
          contractFingerprint: 'client-forged-fingerprint',
        },
      },
      resolvedContract: { objective: '客户端伪造口径' },
      contractFingerprint: 'client-forged-fingerprint',
    }),
  })
  assert.equal(firstPatch.status, 200)

  const legacyPatch = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmedQuestions: [], selectedCases: ['0-TC-0'], questionReviews: {} }),
  })
  assert.equal(legacyPatch.status, 200)

  const preview = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/cases/0-TC-0/contract`)
  const body = await preview.json() as {
    caseContract: { contractFingerprint: string; contract: CaseExecutionContract }
  }

  assert.equal(preview.status, 200)
  assert.equal(body.caseContract.contract.objective, reviewedContract.objective)
  assert.notEqual(body.caseContract.contractFingerprint, 'client-forged-fingerprint')
  assert.equal('contractFingerprint' in (databaseModule.getAnalysisById('11111111-1111-4111-8111-111111111111')?.review.caseReviews?.['0-TC-0'] ?? {}), false)
})

test('rejects malformed case reviews without replacing the persisted review', async () => {
  const response = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      confirmedQuestions: [],
      selectedCases: ['0-TC-0'],
      caseReviews: {
        '0-TC-0': { status: 'confirmed', finalContract: { ...reviewedContract, steps: [] }, updatedAt: null },
      },
    }),
  })

  assert.equal(response.status, 400)
  assert.equal(databaseModule.getAnalysisById('11111111-1111-4111-8111-111111111111')?.review.caseReviews?.['0-TC-0']?.finalContract.objective, reviewedContract.objective)
})
