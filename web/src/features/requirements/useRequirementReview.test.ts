import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, ref } from 'vue'
import type { SavedAnalysis } from '@quality-ai/contracts'
import { useRequirementReview } from './useRequirementReview'

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  return { promise, resolve }
}

test('修改口径后迟到的AI草案不能复活，新请求状态不被旧请求清除', async () => {
  const first = deferredResponse(), second = deferredResponse()
  let count = 0
  const { review } = fixture(() => ++count === 1 ? first.promise : second.promise)
  const oldRequest = review.generateQuestionContract(0)
  review.updateQuestionDraft(0, { target: { value: '新的人工口径' } } as unknown as Event)
  const newRequest = review.generateQuestionContract(0)
  first.resolve(Response.json({ contract: { objective: '旧规则' } }))
  await oldRequest
  assert.equal(review.contractDrafts.value['0-Q-0'], undefined)
  assert.equal(review.reviewContractBusy.value['0-Q-0'], true)
  second.resolve(Response.json({ contract: { objective: '新规则' } }))
  await newRequest
  assert.deepEqual(review.contractDrafts.value['0-Q-0'], { objective: '新规则' })
  assert.equal(review.reviewContractBusy.value['0-Q-0'], false)
})

test('切换需求版本后旧保存失败不能回滚新版本或清除其保存状态', async () => {
  const first = deferredResponse(), second = deferredResponse()
  let count = 0
  const { review, savedAnalysis, messages } = fixture(() => ++count === 1 ? first.promise : second.promise)
  const oldSave = review.saveQuestionReview(0, 'accepted')
  savedAnalysis.value = { ...savedAnalysis.value!, id: 'next-version' }
  review.applyReview(savedAnalysis.value)
  const newSave = review.saveQuestionReview(0, 'accepted')
  first.resolve(Response.json({ error: '旧版本失败' }, { status: 500 }))
  await oldSave
  assert.equal(review.confirmed.value['0-Q-0'], true)
  assert.equal(review.reviewSaving.value, true)
  assert.deepEqual(messages, [])
  second.resolve(Response.json({ review: { confirmedQuestions: ['0-Q-0'], selectedCases: [], updatedAt: null } }))
  await newSave
  assert.equal(review.reviewSaving.value, false)
  assert.deepEqual(savedAnalysis.value.review.confirmedQuestions, ['0-Q-0'])
})

function fixture(request: typeof fetch) {
  const savedAnalysis = ref<SavedAnalysis | null>({
    id: 'review-fixture', fileName: '合成.md', fileNames: ['合成.md'], provider: 'fixture', model: 'fixture', createdAt: '2026-10-05T00:00:00Z',
    review: { confirmedQuestions: [], selectedCases: ['0-TC-0'], questionReviews: {}, updatedAt: null },
    result: { versionName: '审核测试', productName: '合成', overview: '', requirements: [{
      title: '搜索', summary: '', risk: '低风险', riskReason: '', businessRules: [], pageStates: [], testCases: [],
      questions: [{ title: '匹配规则', reason: '未明确', suggestion: '按名称部分匹配' }],
    }] },
  })
  const messages: string[] = []
  const review = useRequirementReview({
    savedAnalysis, activeRequirement: ref(0), questions: computed(() => savedAnalysis.value!.result.requirements[0]!.questions),
    getSourceContext: () => ({ caseKey: '0-TC-0', projectId: 'local-project', targetUrl: 'https://example.test' }),
    notify: message => messages.push(message),
  }, request)
  review.applyReview(savedAnalysis.value!)
  return { review, savedAnalysis, messages }
}

test('人工审核独立管理版本恢复、最终口径保存及暂不确认', async () => {
  const bodies: Record<string, unknown>[] = []
  const { review, savedAnalysis } = fixture(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return Response.json({ review: { ...body, updatedAt: '2026-10-05T01:00:00Z' } })
  })
  assert.equal(review.questionDraft(0), '按名称部分匹配')
  assert.equal(review.selectedCases.value['0-TC-0'], true)
  review.updateQuestionDraft(0, { target: { value: '使用当前可见考试名称的一部分' } } as unknown as Event)
  await review.saveQuestionReview(0, 'edited')
  assert.equal(review.questionResolved('0-Q-0'), true)
  assert.equal(review.questionReviewLabel('0-Q-0'), '已保存人工口径')
  assert.equal(savedAnalysis.value!.review.questionReviews!['0-Q-0']!.finalStatement, '使用当前可见考试名称的一部分')
  assert.deepEqual(bodies[0]!.selectedCases, ['0-TC-0'])
  await review.saveQuestionReview(0, 'deferred')
  assert.equal(review.questionResolved('0-Q-0'), false)
  assert.equal(review.reviewSaving.value, false)
  review.applyReview(savedAnalysis.value!)
  assert.equal(review.questionDraft(0), '使用当前可见考试名称的一部分')
})

test('保存失败回退确认状态，不把草稿误当作服务端最终口径', async () => {
  const { review, savedAnalysis, messages } = fixture(async () => Response.json({ error: '合成保存失败' }, { status: 500 }))
  await review.saveQuestionReview(0, 'accepted')
  assert.equal(review.questionResolved('0-Q-0'), false)
  assert.equal(review.reviewSaving.value, false)
  assert.deepEqual(savedAnalysis.value!.review.confirmedQuestions, [])
  assert.match(messages[0]!, /合成保存失败/)
})

test('源码辅助只生成待审核草案，不确定项拒绝确认，修改口径清除旧草案', async () => {
  let calls = 0
  const { review, messages } = fixture(async (url, init) => {
    calls++
    assert.match(String(url), /\/review\/contract$/)
    assert.deepEqual(JSON.parse(String(init?.body)), {
      questionKey: '0-Q-0', finalStatement: '按名称部分匹配', caseKey: '0-TC-0', projectId: 'local-project', targetUrl: 'https://example.test',
    })
    return Response.json({ contract: { objective: '匹配', triggers: [], behaviors: [], assertions: [], uncertainties: ['大小写待确认'], confidence: 'low' } })
  })
  await review.generateQuestionContract(0)
  assert.equal(review.reviewContractBusy.value['0-Q-0'], false)
  assert.equal(review.questionResolved('0-Q-0'), false)
  assert.equal(review.questionReviewLabel('0-Q-0'), '执行规则待人工确认')
  await review.saveQuestionReview(0, 'accepted')
  assert.equal(calls, 1)
  assert.match(messages.at(-1)!, /不确定项/)
  review.updateQuestionDraft(0, { target: { value: '不区分大小写' } } as unknown as Event)
  assert.equal(review.contractDrafts.value['0-Q-0'], undefined)
})
