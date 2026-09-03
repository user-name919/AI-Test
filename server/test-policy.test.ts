import assert from 'node:assert/strict'
import test from 'node:test'
import type { PageSnapshot } from '../shared/contracts'
import { agentTestGoalSchema } from '../shared/contracts'
import { TestPolicy, type AgentRuntimeState } from './test-policy'

test('allows a bounded four-step project context exploration', () => {
  const goal = agentTestGoalSchema.parse({
    name: '批量生成报告', targetUrl: 'http://localhost:5173', objective: '验证报告筛选',
    requiredAssertions: [{ id: 'visible', description: '页面展示筛选结果' }],
  })
  const policy = new TestPolicy(goal)
  const state: AgentRuntimeState = {
    startedAt: Date.now(), executedSteps: 0, projectContextRequests: 3,
    passedAssertions: new Set(), recentActionFingerprints: [],
  }
  const decision = {
    type: 'need_project_context' as const,
    request: { operation: 'search_source' as const, query: '批量生成报告' },
    reason: '定位页面组件',
  }

  assert.doesNotThrow(() => policy.validate(decision, {} as PageSnapshot, state))
  state.projectContextRequests = 4
  assert.throws(() => policy.validate(decision, {} as PageSnapshot, state), /超过预算/)
})

test('guards new element actions and still detects repeated page scrolls', () => {
  const goal = agentTestGoalSchema.parse({
    name: '表单状态', targetUrl: 'http://localhost:5173', objective: '验证表单状态',
    requiredAssertions: [{ id: 'disabled', description: '提交按钮不可用' }],
  })
  const policy = new TestPolicy(goal)
  const state: AgentRuntimeState = {
    startedAt: Date.now(), executedSteps: 0, projectContextRequests: 0,
    passedAssertions: new Set(), recentActionFingerprints: [],
  }
  const snapshot = {
    snapshotId: 'f3980fe3-e6e5-4057-9dfe-4984bba475cc',
    elements: [{ ref: 'e1', enabled: false }],
  } as PageSnapshot

  assert.throws(() => policy.validate({
    type: 'action', snapshotId: snapshot.snapshotId,
    action: { action: 'press', elementRef: 'e1', key: 'Enter' }, reason: '提交',
  }, snapshot, state), /元素当前不可用/)
  assert.doesNotThrow(() => policy.validate({
    type: 'action', snapshotId: snapshot.snapshotId,
    action: { action: 'hover', elementRef: 'e1' }, reason: '查看禁用原因',
  }, snapshot, state))

  const scroll = { action: 'scroll' as const, deltaX: 0, deltaY: 600 }
  state.recentActionFingerprints = [JSON.stringify(scroll), JSON.stringify(scroll)]
  assert.throws(() => policy.validate({
    type: 'action', snapshotId: snapshot.snapshotId, action: scroll, reason: '继续滚动',
  }, snapshot, state), /连续重复动作/)
})

test('requires valueRef to name a resolved runtime binding while retaining fixture and manual literals', () => {
  const goal = agentTestGoalSchema.parse({
    name: '筛选考试', targetUrl: 'http://localhost:5173', objective: '筛选考试',
    requiredAssertions: [{ id: 'filtered', description: '保留匹配考试' }],
    executionContract: {
      caseKey: '0-TC-1', contractFingerprint: 'binding-contract',
      contract: {
        objective: '筛选考试', preconditions: [], steps: ['输入真实 option 的部分关键词'], expectedAssertions: ['保留匹配考试'],
        dataBindings: [{
          id: 'exam-keyword', label: '考试筛选关键词', mode: 'runtime_dom', targetHint: '考试搜索框', businessIntent: '筛选考试',
          strategy: 'visible_option_substring',
          constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true },
        }, {
          id: 'fixed-exam', label: '固定考试', mode: 'fixture', targetHint: '考试搜索框', businessIntent: '固定夹具兼容',
          constraints: { mustComeFromCurrentDom: false }, fixture: { value: '人工指定的考试', evidence: '测试夹具协议' },
        }, {
          id: 'manual-exam', label: '人工考试', mode: 'manual', targetHint: '考试搜索框', businessIntent: '人工数据兼容',
          constraints: { mustComeFromCurrentDom: false }, manual: { value: '人工指定的考试', rationale: '本次测试确认' },
        }],
        forbiddenBehaviors: [], uncertainties: [],
      },
    },
  })
  const policy = new TestPolicy(goal)
  const state: AgentRuntimeState = {
    startedAt: Date.now(), executedSteps: 0, projectContextRequests: 0,
    passedAssertions: new Set(), recentActionFingerprints: [], resolvedDataBindings: new Map(),
  }
  const snapshot = {
    snapshotId: 'f3980fe3-e6e5-4057-9dfe-4984bba475cc',
    elements: [{ ref: 'e1', enabled: true }],
  } as PageSnapshot

  assert.throws(() => policy.validate({
    type: 'action', snapshotId: snapshot.snapshotId,
    action: { action: 'fill', elementRef: 'e1', valueRef: 'unknown' }, reason: '使用不存在的数据绑定',
  }, snapshot, state), /未知或未解析的数据引用/)
  assert.throws(() => policy.validate({
    type: 'resolve_test_data', snapshotId: '00000000-0000-4000-8000-000000000000', bindingId: 'exam-keyword',
    sourceElementRef: 'e1', value: '数学', reason: '选择部分关键词',
  }, snapshot, state), /过期页面快照/)
  assert.doesNotThrow(() => policy.validate({
    type: 'action', snapshotId: snapshot.snapshotId,
    action: { action: 'fill', elementRef: 'e1', value: '人工指定的考试' }, reason: 'fixture/manual 保持兼容',
  }, snapshot, state))
})

test('does not accept visible text as proof for a required highlighter assertion', () => {
  const goal = agentTestGoalSchema.parse({
    name: '筛选考试', targetUrl: 'http://localhost:5173', objective: '验证高亮',
    requiredAssertions: [{ id: 'highlighted', description: '匹配关键词已高亮' }],
  })
  const policy = new TestPolicy(goal)
  const state: AgentRuntimeState = {
    startedAt: Date.now(), executedSteps: 0, projectContextRequests: 0,
    passedAssertions: new Set(), recentActionFingerprints: [],
  }
  const snapshot = {
    snapshotId: 'f3980fe3-e6e5-4057-9dfe-4984bba475cc',
    elements: [{ ref: 'e1', enabled: true }],
  } as PageSnapshot

  assert.throws(() => policy.validate({
    type: 'action', snapshotId: snapshot.snapshotId,
    action: { action: 'expectText', text: '数学', assertionId: 'highlighted' }, reason: '列表仍然显示数学',
  }, snapshot, state), /高亮断言需要可观察的元素属性或状态证据/)
})
