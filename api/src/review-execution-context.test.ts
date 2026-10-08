import assert from 'node:assert/strict'
import test from 'node:test'
import type { CaseExecutionContract, SavedAnalysis } from '@quality-ai/contracts'
import { collectResolvedReviewContext, resolveCaseExecutionContract } from './review-execution-context'

function makeAnalysis(): SavedAnalysis {
  return {
    id: '7aa1e1de-dcc0-4aa5-8182-c647d615c96a',
    fileName: '考试筛选需求.md',
    fileNames: ['考试筛选需求.md'],
    provider: 'test',
    model: 'test-model',
    createdAt: '2026-09-03T08:00:00.000Z',
    result: {
      versionName: '考试管理 1.0',
      productName: '教师工作台',
      overview: '支持按考试名称筛选考试。',
      requirements: [{
        title: '筛选考试',
        summary: '教师可以在当前账号可见的考试中搜索。',
        risk: '高风险',
        riskReason: '错误的测试数据会造成误报。',
        businessRules: [{ description: '搜索结果必须来自当前账号', evidence: '产品需求' }],
        pageStates: [{
          trigger: '打开考试选择器',
          initialState: '展示当前账号可见考试',
          interaction: '输入关键词',
          expectedResult: '展示匹配结果',
        }],
        questions: [{
          title: '接口失败时如何反馈',
          reason: '需求未说明失败后的页面状态',
          suggestion: '保留搜索词并允许重试',
        }],
        testCases: [{
          title: '按考试名称筛选',
          type: '主流程',
          priority: 'P0',
          preconditions: ['教师已登录考试管理页'],
          steps: ['打开考试选择器', '输入考试名称'],
          expectedResult: '列表仅展示匹配考试',
          blockedByQuestion: false,
        }, {
          title: '按指定考试名称筛选',
          type: '回归',
          priority: 'P1',
          preconditions: ['教师已登录考试管理页'],
          steps: ['打开考试选择器', '在搜索框输入“模考数学一”'],
          expectedResult: '列表展示“模考数学一”',
          blockedByQuestion: false,
        }],
      }],
    },
    review: {
      confirmedQuestions: [],
      selectedCases: [],
      questionReviews: {},
      caseReviews: {},
      updatedAt: null,
    },
  }
}

function reviewedContract(): CaseExecutionContract {
  return {
    objective: '验证考试选择器支持基于当前页面数据的部分关键词筛选',
    preconditions: ['教师已登录考试管理页'],
    steps: ['打开考试选择器', '从可见考试名称中选择部分关键词并输入'],
    expectedAssertions: ['原考试选项仍在筛选结果中', '匹配文字具有可观察的高亮标记'],
    dataBindings: [{
      id: 'exam-query',
      label: '考试搜索词',
      mode: 'runtime_dom',
      targetHint: '考试选择器搜索框',
      businessIntent: '验证部分关键词筛选',
      strategy: 'visible_option_substring',
      constraints: {
        mustComeFromCurrentDom: true,
        mustBePartialOfSource: true,
        mustRemainAfterFiltering: true,
      },
    }],
    forbiddenBehaviors: ['不得凭空生成考试名称'],
    uncertainties: [],
  }
}

test('resolves a raw test case into a legacy-compatible contract', () => {
  const resolved = resolveCaseExecutionContract(makeAnalysis(), '0-TC-0')

  assert.equal(resolved.caseKey, '0-TC-0')
  assert.equal(resolved.requirementIndex, 0)
  assert.equal(resolved.caseIndex, 0)
  assert.equal(resolved.title, '按考试名称筛选')
  assert.deepEqual(resolved.contract, {
    objective: '按考试名称筛选',
    preconditions: ['教师已登录考试管理页'],
    steps: ['打开考试选择器', '输入考试名称'],
    expectedAssertions: ['列表仅展示匹配考试'],
    dataBindings: [],
    forbiddenBehaviors: [],
    uncertainties: [],
  })
  assert.deepEqual(resolved.readiness, {
    agent: { executable: true },
    plan: { executable: true },
  })
})

test('uses a case review as the final contract without mutating the raw case', () => {
  const analysis = makeAnalysis()
  const contract = reviewedContract()
  analysis.review.caseReviews = {
    '0-TC-0': { status: 'confirmed', finalContract: contract, updatedAt: '2026-09-03T09:00:00.000Z' },
  }

  const resolved = resolveCaseExecutionContract(analysis, '0-TC-0')

  assert.deepEqual(resolved.contract, contract)
  assert.notStrictEqual(resolved.contract, contract)
  assert.deepEqual(resolved.readiness.agent, { executable: true })
  assert.equal(resolved.readiness.plan.executable, true)
  assert.deepEqual(analysis.result.requirements[0]?.testCases[0]?.steps, ['打开考试选择器', '输入考试名称'])
})

test('merges confirmed question reviews from the same requirement', () => {
  const analysis = makeAnalysis()
  analysis.review.questionReviews = {
    '0-Q-0': {
      status: 'edited',
      finalStatement: '接口失败时保留搜索词，并提供重试入口',
      updatedAt: '2026-09-03T09:10:00.000Z',
      executionContract: {
        objective: '验证搜索失败反馈',
        triggers: ['考试列表接口失败'],
        preconditions: ['搜索框中已有关键词'],
        behaviors: ['展示失败提示'],
        assertions: ['搜索词保持不变', '重试入口可见'],
        forbiddenBehaviors: ['不得清空用户输入'],
        sourceHints: ['考试选择器组件'],
        uncertainties: [],
        confidence: 'high',
      },
    },
  }

  const resolved = resolveCaseExecutionContract(analysis, '0-TC-0')

  assert.equal(resolved.resolvedQuestions.length, 1)
  assert.equal(resolved.resolvedQuestions[0]?.questionKey, '0-Q-0')
  assert.equal(resolved.resolvedQuestions[0]?.finalStatement, '接口失败时保留搜索词，并提供重试入口')
  assert.deepEqual(resolved.resolvedQuestions[0]?.assertions, ['搜索词保持不变', '重试入口可见'])
})

test('produces the same fingerprint for the same effective contract', () => {
  const first = makeAnalysis()
  first.review.caseReviews = {
    '0-TC-0': { status: 'confirmed', finalContract: reviewedContract(), updatedAt: '2026-09-03T09:00:00.000Z' },
  }
  const second = structuredClone(first)
  second.review.caseReviews!['0-TC-0']!.updatedAt = '2026-09-03T10:00:00.000Z'

  assert.equal(
    resolveCaseExecutionContract(first, '0-TC-0').contractFingerprint,
    resolveCaseExecutionContract(second, '0-TC-0').contractFingerprint,
  )
})

test('changes the fingerprint when a confirmed human statement changes', () => {
  const analysis = makeAnalysis()
  analysis.review.questionReviews = {
    '0-Q-0': { status: 'edited', finalStatement: '接口失败时允许重试', updatedAt: null },
  }
  const before = resolveCaseExecutionContract(analysis, '0-TC-0').contractFingerprint

  analysis.review.questionReviews['0-Q-0']!.finalStatement = '接口失败时保留关键词并允许重试'

  assert.notEqual(resolveCaseExecutionContract(analysis, '0-TC-0').contractFingerprint, before)
})

test('keeps old cases without concrete data compatible', () => {
  const analysis = makeAnalysis()
  analysis.review = {
    confirmedQuestions: [],
    selectedCases: ['0-TC-0'],
    updatedAt: null,
  }

  assert.deepEqual(resolveCaseExecutionContract(analysis, '0-TC-0').readiness.agent, { executable: true })
})

test('requires data review for a legacy case containing an unproven literal', () => {
  const resolved = resolveCaseExecutionContract(makeAnalysis(), '0-TC-1')

  assert.deepEqual(resolved.readiness.agent, { executable: false, reason: '用例需要确认测试数据' })
  assert.deepEqual(resolved.readiness.plan, { executable: false, reason: '用例需要确认测试数据' })
})

test('requires data review when a confirmed contract uses an unproven concrete value', () => {
  const analysis = makeAnalysis()
  const contract = reviewedContract()
  contract.steps = ['打开考试选择器', '在搜索框输入“模考数学一”']
  contract.expectedAssertions = ['列表展示“模考数学一”']
  contract.dataBindings = []
  analysis.review.caseReviews = {
    '0-TC-0': { status: 'confirmed', finalContract: contract, updatedAt: null },
  }

  const resolved = resolveCaseExecutionContract(analysis, '0-TC-0')

  assert.deepEqual(resolved.readiness.agent, { executable: false, reason: '用例需要确认测试数据' })
  assert.deepEqual(resolved.readiness.plan, { executable: false, reason: '用例需要确认测试数据' })
})

test('does not mistake quoted generic UI feedback for environment data', () => {
  const analysis = makeAnalysis()
  const contract = reviewedContract()
  contract.steps = ['点击保存']
  contract.expectedAssertions = ['页面提示“保存成功”']
  contract.dataBindings = []
  analysis.review.caseReviews = {
    '0-TC-0': { status: 'confirmed', finalContract: contract, updatedAt: null },
  }

  assert.deepEqual(resolveCaseExecutionContract(analysis, '0-TC-0').readiness, {
    agent: { executable: true },
    plan: { executable: true },
  })
})

test('accepts a runtime DOM binding for a confirmed concrete data operation', () => {
  const analysis = makeAnalysis()
  const contract = reviewedContract()
  contract.steps = ['打开考试选择器', '在搜索框输入“模考数学一”']
  contract.expectedAssertions = ['列表展示“模考数学一”']
  analysis.review.caseReviews = {
    '0-TC-0': { status: 'confirmed', finalContract: contract, updatedAt: null },
  }

  assert.deepEqual(resolveCaseExecutionContract(analysis, '0-TC-0').readiness, {
    agent: { executable: true },
    plan: { executable: true },
  })
})

test('requires data review when fixture evidence does not match a confirmed concrete value', () => {
  const analysis = makeAnalysis()
  const contract = reviewedContract()
  contract.steps = ['打开考试选择器', '在搜索框输入“模考数学一”']
  contract.expectedAssertions = ['列表展示“模考数学一”']
  contract.dataBindings = [{
    ...contract.dataBindings[0]!,
    mode: 'fixture',
    fixture: { value: '模考英语一', evidence: '测试数据协议' },
  }]
  analysis.review.caseReviews = {
    '0-TC-0': { status: 'confirmed', finalContract: contract, updatedAt: null },
  }

  const resolved = resolveCaseExecutionContract(analysis, '0-TC-0')

  assert.deepEqual(resolved.readiness.agent, { executable: false, reason: '用例需要确认测试数据' })
  assert.deepEqual(resolved.readiness.plan, { executable: false, reason: '用例需要确认测试数据' })
})

test('changes the fingerprint when case review status changes readiness', () => {
  const analysis = makeAnalysis()
  analysis.review.caseReviews = {
    '0-TC-0': { status: 'confirmed', finalContract: reviewedContract(), updatedAt: null },
  }
  const confirmedFingerprint = resolveCaseExecutionContract(analysis, '0-TC-0').contractFingerprint

  analysis.review.caseReviews['0-TC-0']!.status = 'draft'
  assert.notEqual(resolveCaseExecutionContract(analysis, '0-TC-0').contractFingerprint, confirmedFingerprint)

  analysis.review.caseReviews['0-TC-0']!.status = 'needs_data_review'
  assert.notEqual(resolveCaseExecutionContract(analysis, '0-TC-0').contractFingerprint, confirmedFingerprint)
})

test('rejects malformed and unknown case keys', () => {
  assert.throws(() => resolveCaseExecutionContract(makeAnalysis(), 'TC-0'), /测试用例编号格式错误/)
  assert.throws(() => resolveCaseExecutionContract(makeAnalysis(), '0-TC-9'), /测试用例不存在/)
})

test('collects resolved human口径 and execution assertions for selected cases', () => {
  const analysis = makeAnalysis()
  analysis.review.questionReviews = {
    '0-Q-0': {
      status: 'edited', finalStatement: '失败时保留表单并允许重试', updatedAt: null,
      executionContract: {
        objective: '验证失败反馈', triggers: ['接口失败'], preconditions: [], behaviors: ['展示失败提示'],
        assertions: ['失败提示可见'], forbiddenBehaviors: [], sourceHints: [], uncertainties: [], confidence: 'medium',
      },
    },
  }

  const contexts = collectResolvedReviewContext(analysis, ['0-TC-0'])

  assert.equal(contexts.length, 1)
  assert.equal(contexts[0]?.finalStatement, '失败时保留表单并允许重试')
  assert.deepEqual(contexts[0]?.assertions, ['失败提示可见'])
})

test('does not pass deferred review口径 into execution planning', () => {
  const analysis = makeAnalysis()
  analysis.review.questionReviews = {
    '0-Q-0': { status: 'deferred', finalStatement: '还需要确认', updatedAt: null },
  }

  assert.deepEqual(collectResolvedReviewContext(analysis, ['0-TC-0']), [])
})

test('explicit question mapping excludes unrelated reviews and only blocks on linked questions', () => {
  const analysis = makeAnalysis()
  const requirement = analysis.result.requirements[0]!
  requirement.questions.push({ title: '下载格式', reason: '未知格式', suggestion: 'CSV' })
  requirement.testCases[0]!.questionIds = ['0-Q-0']
  requirement.testCases[0]!.blockedByQuestion = false // 显式关联优先于旧布尔标记
  analysis.review.questionReviews = {
    '0-Q-1': { status: 'edited', finalStatement: '下载 CSV', updatedAt: null },
  }
  assert.equal(resolveCaseExecutionContract(analysis, '0-TC-0').readiness.agent.executable, false)
  analysis.review.questionReviews['0-Q-0'] = { status: 'edited', finalStatement: '失败可重试', updatedAt: null }
  const resolved = resolveCaseExecutionContract(analysis, '0-TC-0')
  assert.deepEqual(resolved.resolvedQuestions.map(question => question.questionKey), ['0-Q-0'])
  assert.deepEqual(resolved.questionAssociation, { mode: 'explicit', questionKeys: ['0-Q-0'] })
  assert.equal(resolved.readiness.agent.executable, true)
  analysis.review.questionReviews['0-Q-1']!.finalStatement = '改为 PDF'
  assert.equal(resolveCaseExecutionContract(analysis, '0-TC-0').contractFingerprint, resolved.contractFingerprint)
  assert.deepEqual(collectResolvedReviewContext(analysis, ['0-TC-0', '0-TC-0']).map(question => question.questionKey), ['0-Q-0'])
})

test('explicit empty mapping adds no question assertions while legacy mapping is visibly marked', () => {
  const analysis = makeAnalysis()
  const legacy = resolveCaseExecutionContract(analysis, '0-TC-0')
  assert.equal(legacy.questionAssociation.mode, 'legacy_requirement')
  assert.match(legacy.questionAssociation.warning!, /历史关联待复核/)
  analysis.review.questionReviews = { '0-Q-0': { status: 'edited', finalStatement: '失败可重试', updatedAt: null } }
  analysis.result.requirements[0]!.testCases[0]!.questionIds = []
  const explicit = resolveCaseExecutionContract(analysis, '0-TC-0')
  assert.deepEqual(explicit.resolvedQuestions, [])
  assert.equal(explicit.readiness.agent.executable, true)
  assert.notEqual(explicit.contractFingerprint, legacy.contractFingerprint)
})

test('invalid question links and unresolved contract uncertainties fail closed', () => {
  const analysis = makeAnalysis()
  analysis.result.requirements[0]!.testCases[0]!.questionIds = ['0-Q-9']
  assert.match(resolveCaseExecutionContract(analysis, '0-TC-0').readiness.agent.reason!, /关联的问题不存在/)
  analysis.result.requirements[0]!.testCases[0]!.questionIds = []
  analysis.result.requirements[0]!.testCases[0]!.blockedByQuestion = true
  assert.equal(resolveCaseExecutionContract(analysis, '0-TC-0').readiness.agent.executable, false)
  analysis.result.requirements[0]!.testCases[0]!.blockedByQuestion = false
  analysis.review.caseReviews = { '0-TC-0': { status: 'confirmed', updatedAt: null,
    finalContract: { ...reviewedContract(), uncertainties: ['成功反馈未确定'] },
  } }
  assert.match(resolveCaseExecutionContract(analysis, '0-TC-0').readiness.agent.reason!, /仍有不确定项/)
})
