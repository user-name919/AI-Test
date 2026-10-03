import type { AgentAction, AgentDecision, AgentTestGoal, PageSnapshot, ResolvedDataBinding } from '@quality-ai/contracts'
import { validateFixtureReference } from '../modules/test-fixtures/store'

export interface AgentRuntimeState {
  startedAt: number
  executedSteps: number
  projectContextRequests: number
  passedAssertions: Set<string>
  recentActionFingerprints: string[]
  resolvedDataBindings?: Map<string, ResolvedDataBinding>
}

interface TestPolicyOptions {
  maxSteps?: number
  maxDurationMs?: number
  maxProjectContextRequests?: number
  maxRepeatedActions?: number
}

const elementActions = new Set<AgentAction['action']>([
  'click', 'fill', 'selectOption', 'check', 'uncheck', 'press', 'hover', 'scroll', 'uploadFile', 'download',
  'expectVisible', 'expectEnabled', 'expectDisabled', 'expectChecked', 'expectValue',
  'expectElementText', 'expectAttribute',
])

const enabledElementActions = new Set<AgentAction['action']>([
  'click', 'fill', 'selectOption', 'check', 'uncheck', 'press', 'uploadFile', 'download',
])

export class TestPolicy {
  readonly maxSteps: number
  private readonly maxDurationMs: number
  private readonly maxProjectContextRequests: number
  private readonly maxRepeatedActions: number

  constructor(private readonly goal: AgentTestGoal, options: TestPolicyOptions = {}) {
    this.maxSteps = options.maxSteps ?? 30
    this.maxDurationMs = options.maxDurationMs ?? 5 * 60_000
    this.maxProjectContextRequests = options.maxProjectContextRequests ?? 4
    this.maxRepeatedActions = options.maxRepeatedActions ?? 2
  }

  validate(decision: AgentDecision, snapshot: PageSnapshot, state: AgentRuntimeState) {
    if (Date.now() - state.startedAt > this.maxDurationMs) throw new Error('测试执行超过时间预算')
    if (decision.type === 'need_project_context') {
      if (state.projectContextRequests >= this.maxProjectContextRequests) throw new Error('项目源码上下文请求超过预算')
      return
    }
    if (decision.type === 'resolve_test_data') {
      if (decision.snapshotId !== snapshot.snapshotId) throw new Error(`动作引用了过期页面快照：${decision.snapshotId}`)
      if (!this.runtimeBinding(decision.bindingId)) throw new Error(`运行时数据绑定不在当前测试目标中：${decision.bindingId}`)
      return
    }
    if (decision.type === 'blocked') return
    if (decision.type === 'finish') {
      const missing = this.goal.requiredAssertions.filter(assertion => !state.passedAssertions.has(assertion.id))
      if (missing.length) throw new Error(`必要断言尚未完成：${missing.map(item => item.id).join('、')}`)
      return
    }
    if (state.executedSteps >= this.maxSteps) throw new Error(`测试步骤超过上限 ${this.maxSteps}`)
    if (decision.snapshotId !== snapshot.snapshotId) throw new Error(`动作引用了过期页面快照：${decision.snapshotId}`)
    const action = decision.action
    if (action.action === 'switchFrame' && !snapshot.frameContext?.frames.some(frame => frame.ref === action.frameRef)) throw new Error('框架引用不在当前快照中')
    if (action.action === 'uploadFile') validateFixtureReference(action.fixtureId, this.goal.executionContract?.contract)
    if (this.isValueReferenceAction(action) && action.valueRef) {
      if (!this.runtimeBinding(action.valueRef) || !state.resolvedDataBindings?.has(action.valueRef)) {
        throw new Error(`未知或未解析的数据引用：${action.valueRef}`)
      }
    }
    if (this.isValueReferenceAction(action) && action.value !== undefined && !this.literalValueIsApproved(action.value)) {
      throw new Error(`运行时数据不能使用未确认的 fixture/manual 数据：${action.value}`)
    }
    if (action.action === 'goto') {
      const destination = new URL(action.path, this.goal.targetUrl)
      if (destination.origin !== new URL(this.goal.targetUrl).origin) throw new Error('动作不能跳转到测试环境之外')
    }
    const hiddenElementRef = action.action === 'expectHidden' && action.target.by === 'elementRef'
      ? action.target.elementRef
      : undefined
    const countContainerRef = action.action === 'expectCount' ? action.containerRef : undefined
    if (elementActions.has(action.action) || hiddenElementRef || countContainerRef) {
      const elementRef = hiddenElementRef ?? countContainerRef ?? ('elementRef' in action ? action.elementRef : undefined)
      if (elementRef) {
        const element = snapshot.elements.find(item => item.ref === elementRef)
        if (!element) throw new Error(`当前页面不存在元素引用：${elementRef}`)
        if (enabledElementActions.has(action.action) && !element.enabled) {
          throw new Error(`元素当前不可用：${elementRef}`)
        }
      }
    }
    if ('assertionId' in action && !this.goal.requiredAssertions.some(assertion => assertion.id === action.assertionId)) {
      throw new Error(`断言不在测试目标中：${action.assertionId}`)
    }
    if ('assertionId' in action) {
      const assertion = this.goal.requiredAssertions.find(item => item.id === action.assertionId)
      if (assertion && /高亮|highlight/i.test(assertion.description)) {
        if (action.action !== 'expectAttribute') throw new Error('高亮断言需要可观察的元素属性或状态证据')
        if (action.name !== 'class' && action.name !== 'data-state') throw new Error('高亮断言需要 class 或 data-state 证据')
        if (/not-highlighted|unmatched|not-matched|未高亮|未匹配/i.test(action.value)) {
          throw new Error('高亮断言的属性值不能表达未高亮或未匹配')
        }
        if (!/高亮|highlight|匹配|match|标记|mark|关键词|keyword/i.test(action.value)) {
          throw new Error('高亮断言的属性值必须表达高亮或匹配')
        }
      }
    }
    const fingerprint = JSON.stringify(action)
    let repeated = 0
    for (let index = state.recentActionFingerprints.length - 1; index >= 0; index -= 1) {
      if (state.recentActionFingerprints[index] !== fingerprint) break
      repeated += 1
    }
    if (repeated >= this.maxRepeatedActions) throw new Error('检测到连续重复动作，已停止执行')
  }

  private runtimeBinding(bindingId: string) {
    return this.goal.executionContract?.contract.dataBindings.find(binding => binding.id === bindingId && binding.mode === 'runtime_dom')
  }

  private literalValueIsApproved(value: string) {
    const bindings = this.goal.executionContract?.contract.dataBindings
    if (!bindings?.length) return true
    return bindings.some(binding => {
      if (binding.mode === 'fixture') return binding.fixture?.value === value && Boolean(binding.fixture.evidence.trim())
      if (binding.mode === 'manual') return binding.manual?.value === value && Boolean(binding.manual.rationale.trim())
      return false
    })
  }

  private isValueReferenceAction(action: AgentAction): action is Extract<AgentAction, { action: 'fill' | 'selectOption' | 'expectValue' }> {
    return action.action === 'fill' || action.action === 'selectOption' || action.action === 'expectValue'
  }
}
