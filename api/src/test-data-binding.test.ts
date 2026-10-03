import assert from 'node:assert/strict'
import test from 'node:test'
import { testDataBindingSchema, type PageSnapshot, type TestDataBinding } from '@quality-ai/contracts'
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

function proposal(value: string) {
  return { type: 'resolve_test_data' as const, snapshotId: snapshot.snapshotId, bindingId: binding.id, sourceElementRef: 'e2', value, reason: '依据现场选项选择数据' }
}

test('完整搜索接受完整名称而非部分名称，截断文字不能冒充完整选项', () => {
  const full: TestDataBinding = { ...binding, strategy: 'visible_option_full', constraints: { mustComeFromCurrentDom: true } }
  assert.equal(resolveRuntimeDataBinding(full, snapshot, proposal('模考数学一')).value, '模考数学一')
  assert.throws(() => resolveRuntimeDataBinding(full, snapshot, proposal('数学')), /完整名称/)
  const truncated = structuredClone(snapshot)
  truncated.elements[1].textTruncated = true
  assert.throws(() => resolveRuntimeDataBinding(full, truncated, proposal('模考数学一')), /截断/)
  assert.equal(resolveRuntimeDataBinding(binding, truncated, proposal('数学')).value, '数学')
})

const negative: TestDataBinding = {
  ...binding, strategy: 'non_matching_option_query', constraints: { mustComeFromCurrentDom: true },
  optionUniverse: { completeness: 'complete_local', options: ['模考数学一'], evidence: '合成单选项本地夹具，所有候选固定且无远程请求' },
}

test('无匹配负例基于已声明完整候选且现场一致，不接受仍匹配的词', () => {
  assert.equal(resolveRuntimeDataBinding(negative, snapshot, proposal('不存在的考试')).value, '不存在的考试')
  assert.throws(() => resolveRuntimeDataBinding(negative, snapshot, proposal('数学')), /仍能匹配/)
})

test('无匹配不把未知、分页、远程或缺失依据的列表当成完整范围', () => {
  for (const optionUniverse of [undefined,
    { completeness: 'unknown' as const, options: ['模考数学一'], evidence: '当前可见' },
    { completeness: 'partial_or_remote' as const, options: ['模考数学一'], evidence: '第一页' },
    { completeness: 'complete_local' as const, options: ['模考数学一'], evidence: '' },
  ]) assert.throws(() => resolveRuntimeDataBinding({ ...negative, optionUniverse }, snapshot, proposal('不存在')), /完整本地候选范围依据/)
})

test('无匹配拒绝过期候选、加载中及被截断的现场证据', () => {
  for (const update of [
    (page: PageSnapshot) => { page.loading = true },
    (page: PageSnapshot) => { page.stats.truncated = true },
    (page: PageSnapshot) => { page.elements[1].textTruncated = true },
    (page: PageSnapshot) => { page.elements[1].text = '新的考试名称' },
  ]) {
    const page = structuredClone(snapshot); update(page)
    assert.throws(() => resolveRuntimeDataBinding(negative, page, proposal('不存在')), RuntimeDataBindingBlockedError)
  }
})

test('不同策略不允许残留与其语义矛盾的约束', () => {
  assert.equal(testDataBindingSchema.safeParse({ ...negative, constraints: { ...negative.constraints, mustRemainAfterFiltering: true } }).success, false)
  assert.equal(testDataBindingSchema.safeParse({ ...binding, strategy: 'visible_option_full' }).success, false)
})

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

test('requires every runtime DOM binding to declare the strict visible-option protocol', () => {
  for (const invalidBinding of [
    { ...binding, strategy: undefined },
    { ...binding, constraints: { ...binding.constraints, mustComeFromCurrentDom: false } },
    { ...binding, constraints: { ...binding.constraints, mustBePartialOfSource: false } },
  ]) {
    assert.equal(testDataBindingSchema.safeParse(invalidBinding).success, false)
  }
})

test('requires a visible option source even when an unchecked runtime binding omits its strategy', () => {
  const nonOptionSnapshot = structuredClone(snapshot)
  nonOptionSnapshot.elements[1] = { ...nonOptionSnapshot.elements[1], role: 'button' }
  const uncheckedBinding: TestDataBinding = { ...binding, strategy: undefined }

  assert.throws(() => resolveRuntimeDataBinding(uncheckedBinding, nonOptionSnapshot, {
    type: 'resolve_test_data', snapshotId: nonOptionSnapshot.snapshotId, bindingId: binding.id,
    sourceElementRef: 'e2', value: '数学', reason: '错误地使用同名按钮',
  }), RuntimeDataBindingBlockedError)
})

test('defensively blocks weak runtime binding contracts despite a valid visible option and strict substring', () => {
  for (const uncheckedBinding of [
    { ...binding, strategy: undefined },
    { ...binding, constraints: { ...binding.constraints, mustComeFromCurrentDom: false } },
    { ...binding, constraints: { ...binding.constraints, mustBePartialOfSource: false } },
  ] satisfies TestDataBinding[]) {
    assert.throws(() => resolveRuntimeDataBinding(uncheckedBinding, snapshot, {
      type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: binding.id,
      sourceElementRef: 'e2', value: '数学', reason: '错误地绕过运行时 DOM 协议',
    }), RuntimeDataBindingBlockedError)
  }
})
