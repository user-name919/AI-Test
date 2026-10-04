import {
  agentDecisionSchema,
  type AgentDecision,
  type AgentTestGoal,
  type PageSnapshot,
  type ResolvedDataBinding,
  type ToolResult,
  type SourceProjectSnapshot,
} from '@quality-ai/contracts'
import type { ProjectKnowledgeProvider } from '../integrations/project-knowledge/types'
import type { PageObserver } from './page-observer'
import type { SingleActionExecutor } from './single-action-executor'
import { TestPolicy, type AgentRuntimeState } from './test-policy'
import type { LiveExecutionActivity } from '@quality-ai/contracts'
import { describeAgentDecision } from '@quality-ai/contracts/live-execution'
import { RuntimeDataBindingBlockedError, resolveRuntimeDataBinding } from './test-data-binding'

export interface AgentTrajectoryItem {
  iteration: number
  snapshotId: string
  decision: AgentDecision
  observation?: {
    pageContext?: PageSnapshot['pageContext']
    frameContext?: PageSnapshot['frameContext']
    observationScope?: PageSnapshot['observationScope']
    url: string
    title: string
    elementCount: number
    elements: Array<{ ref: string; role: string; name: string }>
    dialogs: string[]
    messages: string[]
  }
  result?: ToolResult
  projectContext?: unknown
  sourceProject?: SourceProjectSnapshot
  resolvedDataBinding?: ResolvedDataBinding
  recovery?: { attempt: number; limit: number; status: 'reobserved' | 'exhausted' | 'observation_failed'; reason: string }
}

export interface AgentDecisionInput {
  goal: AgentTestGoal
  snapshot: PageSnapshot
  trajectory: AgentTrajectoryItem[]
  projectContexts: unknown[]
}

export interface AgentDecisionProvider {
  decide(input: AgentDecisionInput, signal?: AbortSignal): Promise<AgentDecision>
}

export interface TestAgentResult {
  status: 'passed' | 'failed' | 'blocked'
  summary: string
  executedSteps: number
  passedAssertions: string[]
  trajectory: AgentTrajectoryItem[]
  screenshots: string[]
  resolvedDataBindings?: ResolvedDataBinding[]
}

interface TestAgentOptions {
  policy?: TestPolicy
  projectProvider?: ProjectKnowledgeProvider
  onActivity?: (activity: LiveExecutionActivity) => void
  capturePage?: () => Promise<void>
}

function isAssertionAction(action: AgentDecision & { type: 'action' }) {
  return 'assertionId' in action.action ? action.action.assertionId : undefined
}

function summarizeSnapshot(snapshot: PageSnapshot): NonNullable<AgentTrajectoryItem['observation']> {
  return {
    url: snapshot.url,
    title: snapshot.title,
    pageContext: snapshot.pageContext,
    frameContext: snapshot.frameContext,
    observationScope: snapshot.observationScope,
    elementCount: snapshot.stats.discoveredElements,
    elements: snapshot.elements.slice(0, 12).map(element => ({ ref: element.ref, role: element.role, name: element.name })),
    dialogs: snapshot.dialogs.map(dialog => dialog.title),
    messages: snapshot.messages.map(message => message.text).slice(0, 8),
  }
}

function isMalformedResolveTestDataDecision(value: unknown) {
  return Boolean(value && typeof value === 'object' && 'type' in value && value.type === 'resolve_test_data')
}

export class TestAgent {
  private readonly policy: TestPolicy

  constructor(
    private readonly goal: AgentTestGoal,
    private readonly observer: PageObserver,
    private readonly executor: SingleActionExecutor,
    private readonly decisionProvider: AgentDecisionProvider,
    private readonly options: TestAgentOptions = {},
  ) {
    this.policy = options.policy ?? new TestPolicy(goal)
  }

  async run(page: Parameters<PageObserver['observe']>[0]): Promise<TestAgentResult> {
    const state: AgentRuntimeState = {
      startedAt: Date.now(),
      executedSteps: 0,
      projectContextRequests: 0,
      passedAssertions: new Set(),
      recentActionFingerprints: [],
      resolvedDataBindings: new Map(),
    }
    const trajectory: AgentTrajectoryItem[] = []
    const projectContexts: unknown[] = []
    const screenshots: string[] = []
    let recoveries=0
    const recoveryLimit=2
    let snapshot = await this.observer.observe(page)
    const maxIterations = this.policy.maxSteps + 5

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      this.options.onActivity?.({
        id: `${snapshot.snapshotId}:${iteration}:deciding`,
        phase: 'deciding',
        title: '正在分析当前页面',
        purpose: `已观察到 ${snapshot.stats.discoveredElements} 个控件或容器，正在决定下一步操作`,
        iteration,
        snapshotId: snapshot.snapshotId,
        status: 'running',
      })
      let rawDecision: unknown
      let decision: AgentDecision
      try {
        rawDecision = await this.decisionProvider.decide({
          goal: this.goal,
          snapshot,
          trajectory,
          projectContexts,
        })
        decision = agentDecisionSchema.parse(rawDecision)
      } catch (error) {
        if (error instanceof RuntimeDataBindingBlockedError || isMalformedResolveTestDataDecision(rawDecision)) {
          return this.result('blocked', `当前环境不满足测试数据前置条件：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
        }
        return this.result('failed', `Agent 决策无效：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
      }
      try {
        this.policy.validate(decision, snapshot, state)
      } catch (error) {
        if (decision.type === 'resolve_test_data' || error instanceof RuntimeDataBindingBlockedError) {
          return this.result('blocked', `当前环境不满足测试数据前置条件：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
        }
        return this.result('failed', error instanceof Error ? error.message : String(error), state, trajectory, screenshots)
      }
      const activity = describeAgentDecision(decision, snapshot, iteration)
      this.options.onActivity?.(activity)

      if (decision.type === 'finish') {
        trajectory.push({ iteration, snapshotId: snapshot.snapshotId, decision, observation: summarizeSnapshot(snapshot) })
        return this.result('passed', decision.summary, state, trajectory, screenshots)
      }
      if (decision.type === 'blocked') {
        trajectory.push({ iteration, snapshotId: snapshot.snapshotId, decision, observation: summarizeSnapshot(snapshot) })
        return this.result('blocked', decision.reason, state, trajectory, screenshots)
      }

      if (decision.type === 'need_project_context') {
        if (!this.options.projectProvider) {
          return this.result('blocked', '当前测试没有连接项目源码 Provider', state, trajectory, screenshots)
        }
        let projectContext: unknown
        let sourceProject: SourceProjectSnapshot | undefined
        try {
          const info = await this.options.projectProvider.getProjectInfo()
          sourceProject = structuredClone({id:info.id,branch:info.branch,commit:info.commit,worktree:info.worktree})
          projectContext = await this.resolveProjectContext(decision)
        } catch (error) {
          return this.result('blocked', `项目源码上下文获取失败：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
        }
        state.projectContextRequests += 1
        this.options.onActivity?.({ ...activity, status: 'passed', message: '源码上下文读取完成' })
        projectContexts.push(projectContext)
        trajectory.push({ iteration, snapshotId: snapshot.snapshotId, decision, observation: summarizeSnapshot(snapshot), projectContext, sourceProject })
        try {
          snapshot = await this.observer.observe(page)
        } catch (error) {
          return this.result('failed', `源码上下文返回后页面重观测失败：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
        }
        continue
      }

      if (decision.type === 'resolve_test_data') {
        const binding = this.goal.executionContract?.contract.dataBindings.find(item => item.id === decision.bindingId)
        try {
          if (!binding) throw new RuntimeDataBindingBlockedError(`运行时数据绑定不在当前测试目标中：${decision.bindingId}`)
          const resolved = resolveRuntimeDataBinding(binding, snapshot, decision)
          state.resolvedDataBindings?.set(resolved.bindingId, resolved)
          this.options.onActivity?.({ ...activity, status: 'passed', message: `已使用真实 DOM option“${resolved.sourceText}”解析数据` })
          trajectory.push({ iteration, snapshotId: snapshot.snapshotId, decision, observation: summarizeSnapshot(snapshot), resolvedDataBinding: resolved })
          continue
        } catch (error) {
          trajectory.push({ iteration, snapshotId: snapshot.snapshotId, decision, observation: summarizeSnapshot(snapshot) })
          return this.result('blocked', `当前环境不满足测试数据前置条件：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
        }
      }

      const result = await this.executor.execute(decision.snapshotId, decision.action, state.resolvedDataBindings)
      this.options.onActivity?.({
        ...activity,
        status: result.ok ? 'passed' : 'failed',
        durationMs: result.durationMs,
        message: result.message,
      })
      await this.options.capturePage?.()
      state.executedSteps += 1
      const fingerprint = JSON.stringify(decision.action)
      state.recentActionFingerprints = [...state.recentActionFingerprints, fingerprint].slice(-6)
      const assertionId = isAssertionAction(decision)
      if (result.ok && assertionId) state.passedAssertions.add(assertionId)
      if (result.screenshotPath) screenshots.push(result.screenshotPath)
      trajectory.push({ iteration, snapshotId: snapshot.snapshotId, decision, observation: summarizeSnapshot(snapshot), result })
      if (!result.ok) {
        if (result.code === 'write_authorization_required') return this.result('blocked', result.message, state, trajectory, screenshots)
        if (result.code === 'action_outcome_unknown') return this.result('blocked', result.message, state, trajectory, screenshots)
        if (result.code === 'fixture_unavailable') return this.result('blocked', result.message, state, trajectory, screenshots)
        if (!result.retryable || assertionId) return this.result('failed', result.message, state, trajectory, screenshots)
        const item=trajectory[trajectory.length-1]
        if(recoveries>=recoveryLimit){
          item.recovery={attempt:recoveries,limit:recoveryLimit,status:'exhausted',reason:result.message}
          return this.result('blocked', `技术操作恢复预算已用尽（${recoveryLimit} 次）：${result.message}`, state, trajectory, screenshots)
        }
        recoveries++
        try { snapshot = await this.observer.observe(page) }
        catch(error){
          const reason=error instanceof Error?error.message:String(error)
          item.recovery={attempt:recoveries,limit:recoveryLimit,status:'observation_failed',reason:`${result.message}；重观测失败：${reason}`}
          return this.result('blocked',`技术恢复时无法重新观察页面：${reason}`,state,trajectory,screenshots)
        }
        item.recovery={attempt:recoveries,limit:recoveryLimit,status:'reobserved',reason:result.message}
        continue
      }
      try { snapshot = await this.observer.observe(page) }
      catch(error){return this.result('blocked',`动作后无法观察页面：${error instanceof Error?error.message:String(error)}`,state,trajectory,screenshots)}
      if (decision.action.action === 'fill' && decision.action.valueRef) {
        const binding = state.resolvedDataBindings?.get(decision.action.valueRef)
        if (binding && this.bindingMustRemainAfterFiltering(binding.bindingId) && !this.sourceRemainsVisible(binding, snapshot)) {
          return this.result('failed', `产品筛选行为不符合已确认契约：输入“${binding.value}”后未筛选后仍保留来源 option“${binding.sourceText}”`, state, trajectory, screenshots)
        }
      }
    }

    return this.result('failed', 'Agent 决策轮次超过预算', state, trajectory, screenshots)
  }

  private async resolveProjectContext(decision: AgentDecision & { type: 'need_project_context' }) {
    const provider = this.options.projectProvider
    if (!provider) throw new Error('项目源码 Provider 未配置')
    const request = decision.request
    if (request.operation === 'resolve_route') return provider.resolveRoute({ url: request.url })
    if (request.operation === 'search_source') return provider.searchSource({ query: request.query, scopes: request.scopes })
    return provider.inspectFiles({ paths: request.paths, reason: decision.reason })
  }

  private result(
    status: TestAgentResult['status'],
    summary: string,
    state: AgentRuntimeState,
    trajectory: AgentTrajectoryItem[],
    screenshots: string[],
  ): TestAgentResult {
    return {
      status,
      summary,
      executedSteps: state.executedSteps,
      passedAssertions: [...state.passedAssertions],
      trajectory,
      screenshots,
      resolvedDataBindings: [...(state.resolvedDataBindings?.values() ?? [])],
    }
  }

  private bindingMustRemainAfterFiltering(bindingId: string) {
    return this.goal.executionContract?.contract.dataBindings.some(binding =>
      binding.id === bindingId && binding.constraints.mustRemainAfterFiltering,
    ) ?? false
  }

  private sourceRemainsVisible(binding: ResolvedDataBinding, snapshot: PageSnapshot) {
    return snapshot.elements.some(element =>
      element.visible && element.role === 'option' && (element.text?.trim() || element.name.trim()) === binding.sourceText,
    )
  }
}
