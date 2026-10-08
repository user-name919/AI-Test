import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { effectScope, ref } from 'vue'
import type { SavedAnalysis } from '@quality-ai/contracts'
import { useCaseContracts } from '../../web/src/composables/useCaseContracts'
import { resolveCaseExecutionContract } from '../../api/src/review-execution-context'

function analysis(id: string): SavedAnalysis {
  return {
    id, fileName: '合成.md', fileNames: ['合成.md'], provider: 'fixture', model: 'fixture', createdAt: '2026-10-03T00:00:00Z',
    review: { confirmedQuestions: [], selectedCases: [], updatedAt: null },
    result: { versionName: id, productName: '合成项目', overview: '验证口径一致', requirements: [{
      title: '搜索', summary: '搜索', risk: '低风险', riskReason: '只读', businessRules: [], pageStates: [], questions: [],
      testCases: [{ title: id, type: '主流程', priority: 'P1', preconditions: [], steps: ['搜索'], expectedResult: '显示匹配项', blockedByQuestion: false, questionIds: [] }],
    }] },
  }
}

test('contract preview discards stale responses when switching versions and invalidates after review edits', async () => {
  const scope = effectScope()
  const current = ref<SavedAnalysis | null>(analysis('old'))
  const pending: Array<(response: Response) => void> = []
  const request: typeof fetch = () => new Promise(resolve => { pending.push(resolve) })
  const state = scope.run(() => useCaseContracts(current, request))!
  try {
    const old = resolveCaseExecutionContract(current.value!, '0-TC-0')
    current.value = analysis('new')
    const newer = resolveCaseExecutionContract(current.value, '0-TC-0')
    pending[1]!(Response.json({ caseContracts: [newer] }))
    await setImmediate()
    pending[0]!(Response.json({ caseContracts: [old] }))
    await setImmediate()
    assert.equal(state.contracts.value['0-TC-0']?.title, 'new')
    assert.equal(state.loading.value, false)
    current.value.review = { ...current.value.review, updatedAt: '2026-10-03T01:00:00Z' }
    assert.deepEqual(state.contracts.value, {})
    assert.equal(state.loading.value, true)
    pending[2]!(Response.json({ error: '读取失败' }, { status: 503 }))
    await setImmediate()
    assert.equal(state.error.value, '读取失败')
    assert.deepEqual(state.contracts.value, {})
    assert.equal(state.loading.value, false)
  } finally { scope.stop() }
})

test('sample mode never declares executable contracts and disposing ignores late responses', async () => {
  const scope = effectScope()
  const current = ref<SavedAnalysis | null>(null)
  let complete: ((response: Response) => void) | undefined
  const state = scope.run(() => useCaseContracts(current, () => new Promise(resolve => { complete = resolve })))!
  assert.deepEqual(state.contracts.value, {})
  assert.equal(state.loading.value, false)
  current.value = analysis('version')
  scope.stop()
  complete!(Response.json({ caseContracts: [resolveCaseExecutionContract(current.value, '0-TC-0')] }))
  await setImmediate()
  assert.deepEqual(state.contracts.value, {})
})
