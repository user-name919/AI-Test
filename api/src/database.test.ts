import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import type { CaseReview, ExecutionResult, PrdAnalysis } from '@quality-ai/contracts'
import { workspaceRoot } from './config/paths'

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'quality-ai-database-test-'))
const databasePath = join(temporaryDirectory, 'quality-ai.sqlite')
const createdAt = '2026-09-03T08:00:00.000Z'

const result: PrdAnalysis = {
  versionName: '考试管理 1.0',
  productName: '教师工作台',
  overview: '验证考试选择器。',
  requirements: [{
    title: '考试筛选',
    summary: '支持部分关键词筛选。',
    risk: '高风险',
    riskReason: '测试数据必须真实。',
    businessRules: [{ description: '候选项来自当前账号', evidence: '产品需求' }],
    pageStates: [{ trigger: '展开下拉框', initialState: '显示考试列表', interaction: '输入关键词', expectedResult: '保留匹配项' }],
    questions: [],
    testCases: [{
      title: '按部分关键词筛选', type: '主流程', priority: 'P0', preconditions: ['教师已登录'],
      steps: ['展开考试选择器', '输入部分关键词'], expectedResult: '匹配考试仍在列表中', blockedByQuestion: false,
    }],
  }],
}

const caseReview: CaseReview = {
  status: 'confirmed',
  updatedAt: '2026-09-03T09:00:00.000Z',
  finalContract: {
    objective: '验证真实考试名称支持部分关键词筛选',
    preconditions: ['教师已登录'],
    steps: ['展开考试选择器', '从当前选项提取部分关键词'],
    expectedAssertions: ['来源考试仍在结果中'],
    dataBindings: [{
      id: 'exam-query', label: '考试搜索词', mode: 'runtime_dom', targetHint: '考试搜索框',
      businessIntent: '验证部分关键词筛选', strategy: 'visible_option_substring',
      constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true },
    }],
    forbiddenBehaviors: ['不得使用凭空生成的考试名称'],
    uncertainties: [],
  },
}

const legacy = new DatabaseSync(databasePath)
legacy.exec(`
  CREATE TABLE analyses (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    source_text TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE analysis_reviews (
    analysis_id TEXT PRIMARY KEY,
    confirmed_questions_json TEXT NOT NULL DEFAULT '[]',
    selected_cases_json TEXT NOT NULL DEFAULT '[]',
    question_reviews_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
  );
`)
legacy.prepare(`
  INSERT INTO analyses (id, file_name, source_text, provider, model, result_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run('legacy-analysis', '旧需求.md', '旧需求正文', 'test', 'test-model', JSON.stringify(result), createdAt)
legacy.prepare(`
  INSERT INTO analysis_reviews (analysis_id, confirmed_questions_json, selected_cases_json, question_reviews_json, updated_at)
  VALUES (?, ?, ?, ?, ?)
`).run('legacy-analysis', '[]', '["0-TC-0"]', '{}', createdAt)
legacy.close()

process.env.QUALITY_AI_DATABASE_PATH = databasePath
const databaseModule = await import('./database')

after(() => {
  delete process.env.QUALITY_AI_DATABASE_PATH
  rmSync(temporaryDirectory, { recursive: true, force: true })
})

test('legacy relative login-state paths resolve against repository root without rewriting stored data', () => {
  const environment = databaseModule.saveEnvironment({ name: '合成环境', baseUrl: 'https://example.test', targetUrl: 'https://example.test/page' })
  databaseModule.setEnvironmentStorageState(environment.id, 'data/auth/legacy.json')
  assert.equal(databaseModule.getEnvironmentById(environment.id)?.storageStatePath, join(workspaceRoot, 'data/auth/legacy.json'))
  const inspection = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = inspection.prepare('SELECT storage_state_path FROM test_environments WHERE id=?').get(environment.id) as { storage_state_path: string }
    assert.equal(row.storage_state_path, 'data/auth/legacy.json')
  } finally { inspection.close() }
})

test('incrementally adds case review storage without losing a legacy row', () => {
  const inspection = new DatabaseSync(databasePath)
  const columns = inspection.prepare('PRAGMA table_info(analysis_reviews)').all() as Array<{ name: string }>
  const storedDefault = inspection.prepare('SELECT case_reviews_json FROM analysis_reviews WHERE analysis_id = ?')
    .get('legacy-analysis') as { case_reviews_json: string }
  inspection.close()

  assert.equal(columns.some(column => column.name === 'case_reviews_json'), true)
  assert.equal(storedDefault.case_reviews_json, '{}')
  const analysis = databaseModule.getAnalysisById('legacy-analysis')
  assert.deepEqual(analysis?.review.selectedCases, ['0-TC-0'])
  assert.deepEqual(analysis?.review.caseReviews, {})
})

test('saves and reads case reviews from the isolated database', () => {
  const review = databaseModule.saveReview('legacy-analysis', {
    confirmedQuestions: [],
    selectedCases: ['0-TC-0'],
    questionReviews: {},
    caseReviews: { '0-TC-0': caseReview },
  })

  assert.deepEqual(review.caseReviews?.['0-TC-0'], caseReview)
  assert.deepEqual(databaseModule.getAnalysisById('legacy-analysis')?.review.caseReviews?.['0-TC-0'], caseReview)

  const inspection = new DatabaseSync(databasePath)
  const row = inspection.prepare('SELECT case_reviews_json FROM analysis_reviews WHERE analysis_id = ?')
    .get('legacy-analysis') as { case_reviews_json: string }
  inspection.close()
  assert.deepEqual(JSON.parse(row.case_reviews_json), { '0-TC-0': caseReview })
})

test('new analyses still initialize with an empty legacy-compatible review', () => {
  databaseModule.saveAnalysis({
    id: 'fresh-analysis',
    fileName: '新需求.md',
    fileNames: ['新需求.md'],
    sourceText: '新需求正文',
    provider: 'test',
    model: 'test-model',
    result,
    createdAt: '2026-09-03T10:00:00.000Z',
  })

  assert.deepEqual(databaseModule.getAnalysisById('fresh-analysis')?.review, {
    confirmedQuestions: [],
    selectedCases: [],
    questionReviews: {},
    caseReviews: {},
    updatedAt: null,
  })
})

test('preserves case-level execution and source-project attribution in result JSON', () => {
  const execution: ExecutionResult = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '连续执行', targetUrl: 'https://example.test/exams',
    status: 'failed', mode: 'agent', startedAt: createdAt, finishedAt: '2026-09-03T08:01:00.000Z', durationMs: 60_000,
    steps: [], screenshots: [],
    sourceProject: { id: 'exam-web', branch: 'feature/exam-search', commit: 'abc123' },
    caseResults: [{
      caseKey: '0-TC-0', title: '按部分关键词筛选', contractFingerprint: 'fingerprint', status: 'failed',
      startedFromUrl: 'https://example.test/exams', startedFromSnapshotId: 'snapshot-1', continuation: 'reused_current_page',
      resolvedDataBindings: [{ bindingId: 'exam-query', sourceElementRef: 'e1', sourceText: '期中数学考试', value: '数学', snapshotId: 'snapshot-1', observedAt: createdAt, reason: '真实候选项' }],
      passedAssertions: ['搜索框值正确'], trajectory: [], steps: [], screenshots: ['failure.png'], tracePath: 'trace.zip', error: '预期结果未出现',
    }],
  }

  databaseModule.saveExecution(execution, {
    analysisId: 'legacy-analysis', environmentId: 'test-environment', projectId: 'exam-web', caseKeys: ['0-TC-0'],
  })

  const saved = databaseModule.getExecutionById(execution.id)
  assert.deepEqual(saved?.caseResults, execution.caseResults)
  assert.deepEqual(saved?.sourceProject, execution.sourceProject)
  assert.deepEqual(saved?.caseKeys, ['0-TC-0'])
  assert.equal(saved?.projectId, 'exam-web')
})
