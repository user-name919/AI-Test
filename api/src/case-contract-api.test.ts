import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { caseExecutionContractSchema, type CaseExecutionContract, type PrdAnalysis } from '@quality-ai/contracts'

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'quality-ai-contract-api-test-'))
const projectRoot = join(temporaryDirectory, 'source-project')
const projectsConfigPath = join(temporaryDirectory, 'projects.json')
mkdirSync(projectRoot)
writeFileSync(projectsConfigPath, JSON.stringify({
  projects: [{ id: 'test-project', name: '测试源码', root: projectRoot, targetOrigins: [] }],
}))
process.env.QUALITY_AI_DATABASE_PATH = join(temporaryDirectory, 'quality-ai.sqlite')
process.env.QUALITY_AI_DATA_ROOT = temporaryDirectory
process.env.PROJECTS_CONFIG_PATH = projectsConfigPath

const databaseModule = await import('./database')
const { resetProjectProviderRegistry } = await import('./project-knowledge/registry')
const { createApiServer } = await import('./index')
const server = createApiServer()
const modelPrompts: string[] = []
const modelServer = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/exams') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<h1>合成考试页面</h1>')
    return
  }
  if (request.method !== 'POST' || request.url !== '/responses') {
    response.writeHead(404).end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: Array<{ content: string }> }
  modelPrompts.push(body.input.map(message => message.content).join('\n'))
  const contractLine=modelPrompts[modelPrompts.length-1].split('\n').find(line=>line.startsWith('最终执行契约（唯一执行依据）：'))
  const generatedContract:CaseExecutionContract|undefined=contractLine?JSON.parse(contractLine.split('：').slice(1).join('：')):undefined
  const runtime=generatedContract?.dataBindings.find(item=>item.mode==='runtime_dom')
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    status: 'completed',
    output_text: JSON.stringify({
      name: '单用例固定计划', targetUrl: 'https://example.test/exams',
      steps: runtime?[{action:'resolveTestData',bindingId:runtime.id},{action:'fill',locator:{by:'label',value:'搜索'},valueRef:runtime.id},{action:'expectText',assertionIndex:0,valueRef:runtime.id}]:[{ action: 'goto', path: '/exams' },...(generatedContract?.expectedAssertions??[]).map((text,assertionIndex)=>({action:'expectText',text,assertionIndex})), { action: 'screenshot', name: '证据' }],
    }),
  }))
})
let baseUrl = ''
let modelBaseUrl = ''

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
    }, {
      title: '按考试状态筛选', type: '分支', priority: 'P1', preconditions: ['教师已登录'],
      steps: ['打开考试选择器', '选择考试状态'], expectedResult: '仅显示对应状态的考试', blockedByQuestion: false,
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
  resetProjectProviderRegistry()
  await new Promise<void>((resolve, reject) => modelServer.listen(0, '127.0.0.1', resolve).once('error', reject))
  modelBaseUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`
  process.env.MODEL_API_KEY = 'test-key'
  process.env.MODEL_BASE_URL = modelBaseUrl
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
  await new Promise<void>((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve()))
  delete process.env.QUALITY_AI_DATABASE_PATH
  delete process.env.QUALITY_AI_DATA_ROOT
  delete process.env.PROJECTS_CONFIG_PATH
  delete process.env.MODEL_API_KEY
  delete process.env.MODEL_BASE_URL
  resetProjectProviderRegistry()
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

test('batch contract preview uses exactly the same resolver as individual execution previews', async () => {
  const response = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/case-contracts`)
  const body = await response.json() as { caseContracts: Array<{ caseKey: string }> }
  assert.equal(response.status, 200)
  assert.equal(body.caseContracts.length, 2)
  for (const item of body.caseContracts) {
    const single = await fetch(`${baseUrl}/api/analyses/11111111-1111-4111-8111-111111111111/cases/${item.caseKey}/contract`)
    assert.deepEqual(item, (await single.json()).caseContract)
  }
  const missing = await fetch(`${baseUrl}/api/analyses/22222222-2222-4222-8222-222222222222/case-contracts`)
  assert.equal(missing.status, 404)
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

test('rejects an agent run from the server-resolved case even when the client sends a forged contract', async () => {
  databaseModule.saveReview('11111111-1111-4111-8111-111111111111', {
    confirmedQuestions: [], selectedCases: ['0-TC-0'], questionReviews: {},
    caseReviews: { '0-TC-0': { status: 'needs_data_review', finalContract: reviewedContract, updatedAt: null } },
  })

  const response = await fetch(`${baseUrl}/api/automation/agent/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      analysisId: '11111111-1111-4111-8111-111111111111', caseKeys: ['0-TC-0'],
      targetUrl: 'https://example.test/exams', projectId: 'test-project',
      executionContract: { caseKey: '0-TC-0', contract: { objective: '客户端伪造目标' }, contractFingerprint: 'forged' },
    }),
  })
  const body = await response.json() as { error: string }

  assert.equal(response.status, 409)
  assert.match(body.error, /用例需要确认测试数据：0-TC-0/)
})

test('allows fixed-plan generation with runtime DOM contract preserved for execution-time binding', async () => {
  databaseModule.saveReview('11111111-1111-4111-8111-111111111111', {
    confirmedQuestions: [], selectedCases: ['0-TC-0'], questionReviews: {},
    caseReviews: { '0-TC-0': { status: 'confirmed', finalContract: reviewedContract, updatedAt: null } },
  })

  const response = await fetch(`${baseUrl}/api/automation/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      analysisId: '11111111-1111-4111-8111-111111111111', caseKeys: ['0-TC-0'], targetUrl: 'https://example.test/exams',
    }),
  })
  const body = await response.json() as { automationPlan:{plan:{casePlans:Array<{contract:CaseExecutionContract}>}} }

  assert.equal(response.status, 201)
  assert.equal(body.automationPlan.plan.casePlans[0].contract.dataBindings[0].mode,'runtime_dom')
})

test('generates one ready fixed plan per case and combines them into case checkpoints', async () => {
  modelPrompts.length = 0
  const fixtureContract: CaseExecutionContract = {
    ...reviewedContract,
    dataBindings: [{
      ...reviewedContract.dataBindings[0]!, mode: 'fixture', strategy: undefined,
      fixture: { value: '期中考试', evidence: '测试夹具' },
    }],
  }
  const manualContract: CaseExecutionContract = {
    ...fixtureContract,
    objective: '验证人工确认的考试状态筛选',
    dataBindings: [{
      ...fixtureContract.dataBindings[0]!, id: 'exam-status', label: '考试状态', mode: 'manual', fixture: undefined,
      manual: { value: '已发布', rationale: '测试环境固定状态' },
    }],
  }
  databaseModule.saveReview('11111111-1111-4111-8111-111111111111', {
    confirmedQuestions: [], selectedCases: ['0-TC-0', '0-TC-1'], questionReviews: {},
    caseReviews: {
      '0-TC-0': { status: 'confirmed', finalContract: fixtureContract, updatedAt: null },
      '0-TC-1': { status: 'confirmed', finalContract: manualContract, updatedAt: null },
    },
  })

  const response = await fetch(`${baseUrl}/api/automation/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      analysisId: '11111111-1111-4111-8111-111111111111', caseKeys: ['0-TC-0', '0-TC-1'], targetUrl: 'https://example.test/exams',
    }),
  })
  const body = await response.json() as { automationPlan: { plan: { casePlans: Array<{ caseKey: string; title: string; contract: CaseExecutionContract; steps: unknown[] }> } } }

  assert.equal(response.status, 201)
  assert.deepEqual(body.automationPlan.plan.casePlans.map(item => item.caseKey), ['0-TC-0', '0-TC-1'])
  assert.deepEqual(body.automationPlan.plan.casePlans.map(item => item.title), ['按考试名称筛选', '按考试状态筛选'])
  assert.equal(body.automationPlan.plan.casePlans[0]?.contract.dataBindings[0]?.fixture?.value, '期中考试')
  assert.equal(body.automationPlan.plan.casePlans[1]?.contract.dataBindings[0]?.manual?.value, '已发布')
  assert.ok(body.automationPlan.plan.casePlans.every(item => item.steps.length === item.contract.expectedAssertions.length+2))
  assert.equal(modelPrompts.length, 2)
  const sentContracts = modelPrompts.map(prompt => {
    const contractLine = prompt.split('\n').find(line => line.startsWith('最终执行契约（唯一执行依据）：'))
    assert.ok(contractLine, '模型请求必须包含最终执行契约，而不是原始用例')
    return JSON.parse(contractLine.slice('最终执行契约（唯一执行依据）：'.length)) as CaseExecutionContract
  })
  assert.deepEqual(sentContracts.find(contract => contract.objective === fixtureContract.objective), JSON.parse(JSON.stringify(caseExecutionContractSchema.parse(fixtureContract))))
  assert.deepEqual(sentContracts.find(contract => contract.objective === manualContract.objective), JSON.parse(JSON.stringify(caseExecutionContractSchema.parse(manualContract))))
  assert.ok(modelPrompts.every(prompt => !prompt.includes('选择考试状态')))
  assert.equal(modelBaseUrl.startsWith('http://127.0.0.1:'), true)
})

test('a real local browser run persists the captured case version in its report', async () => {
  const original = databaseModule.getLatestAutomationPlan()!
  const plan = { ...original, id: '33333333-3333-4333-8333-333333333333', createdAt: new Date(Date.now() + 1000).toISOString(), plan: { ...original.plan, targetUrl: `${modelBaseUrl}/exams`,casePlans:original.plan.casePlans!.map(item=>({...item,steps:item.steps.filter(step=>!step.action.startsWith('expect'))})) } }
  databaseModule.saveAutomationPlan(plan)
  const response = await fetch(`${baseUrl}/api/automation/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automationPlanId: plan.id }) })
  assert.equal(response.status, 422)
  const { execution } = await response.json()
  assert.equal(execution.status,'blocked','只导航和截图的历史计划不能视为业务通过')
  assert.equal(execution.caseSnapshots.length, 2)
  assert.equal(execution.caseSnapshots[0].resolved.contractFingerprint, plan.plan.casePlans![0].contractFingerprint)
  assert.equal(execution.caseSnapshots[0].analysisId, plan.analysisId)
  assert.ok(execution.caseSnapshots[0].revision >= 1)
  assert.deepEqual(databaseModule.getExecutionById(execution.id)?.caseSnapshots, execution.caseSnapshots)
})

test('rejects a saved plan after human semantics change even when the case is still executable', async () => {
  const plan = databaseModule.getLatestAutomationPlan()!
  const analysis = databaseModule.getAnalysisById(plan.analysisId)!
  const old = analysis.review.caseReviews!['0-TC-0']!
  databaseModule.saveReview(analysis.id, { ...analysis.review, caseReviews: {
    ...analysis.review.caseReviews, '0-TC-0': { ...old, finalContract: { ...old.finalContract, objective: '新的人工目标，旧计划不能冒充' } },
  } })
  for (const endpoint of ['/api/automation/run', '/api/automation/run/stream']) {
    const response = await fetch(`${baseUrl}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automationPlanId: plan.id }) })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /用例口径已变化/)
  }
})
