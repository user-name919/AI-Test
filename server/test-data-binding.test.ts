import assert from 'node:assert/strict'
import test from 'node:test'
import type { PageSnapshot, TestDataBinding } from '../shared/contracts'
import { RuntimeDataBindingBlockedError, resolveRuntimeDataBinding } from './test-data-binding'

const snapshot: PageSnapshot = {
  snapshotId: '5b2bc1ac-188b-46c4-a96f-4ecb2ce70d50',
  observedAt: '2026-09-03T00:00:00.000Z',
  url: 'http://localhost:5173/mock-exams',
  title: '选择考试',
  loading: false,
  elements: [
    { ref: 'e1', tag: 'input', role: 'textbox', name: '考试名称', visible: true, enabled: true },
    { ref: 'e2', tag: 'div', role: 'option', name: '模考数学一', text: '模考数学一', visible: true, enabled: true },
  ],
  dialogs: [],
  tables: [],
  messages: [],
  stats: { discoveredElements: 2, returnedElements: 2, truncated: false },
}

const binding: TestDataBinding = {
  id: 'exam-keyword',
  label: '考试筛选关键词',
  mode: 'runtime_dom',
  targetHint: '选择考试搜索框',
  businessIntent: '验证按部分关键词筛选考试',
  strategy: 'visible_option_substring',
  constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true },
}

test('resolves a nonempty strict substring from a visible current option with its DOM evidence', () => {
  const resolved = resolveRuntimeDataBinding(binding, snapshot, {
    type: 'resolve_test_data',
    snapshotId: snapshot.snapshotId,
    bindingId: binding.id,
    sourceElementRef: 'e2',
    value: '数学',
    reason: '用“数学”覆盖同类考试的部分关键词筛选',
  })

  assert.deepEqual(resolved, {
    bindingId: 'exam-keyword',
    sourceElementRef: 'e2',
    sourceText: '模考数学一',
    value: '数学',
    snapshotId: snapshot.snapshotId,
    observedAt: snapshot.observedAt,
    reason: '用“数学”覆盖同类考试的部分关键词筛选',
  })
})

test('blocks a runtime binding whose source is not visible in the current snapshot', () => {
  const hiddenSnapshot = structuredClone(snapshot)
  hiddenSnapshot.elements[1].visible = false

  assert.throws(() => resolveRuntimeDataBinding(binding, hiddenSnapshot, {
    type: 'resolve_test_data', snapshotId: hiddenSnapshot.snapshotId, bindingId: binding.id,
    sourceElementRef: 'e2', value: '数学', reason: '选择关键词',
  }), RuntimeDataBindingBlockedError)
})

test('rejects fabricated and complete option values instead of accepting model literals', () => {
  for (const value of ['模考数学一', '英语']) {
    assert.throws(() => resolveRuntimeDataBinding(binding, snapshot, {
      type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: binding.id,
      sourceElementRef: 'e2', value, reason: '选择关键词',
    }), RuntimeDataBindingBlockedError)
  }
})
