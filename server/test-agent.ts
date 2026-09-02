import {
  agentDecisionSchema,
  type AgentDecision,
  type AgentTestGoal,
  type PageSnapshot,
  type ToolResult,
} from '../shared/contracts'
import type { ProjectKnowledgeProvider } from './project-knowledge/types'
import type { PageObserver } from './page-observer'
import type { SingleActionExecutor } from './single-action-executor'
import { TestPolicy, type AgentRuntimeState } from './test-policy'
import type { LiveExecutionActivity } from '../shared/contracts'
import { describeAgentDecision } from '../shared/live-execution'

export interface AgentTrajectoryItem {
  iteration: number
  snapshotId: string
  decision: AgentDecision
  observation?: {
    url: string
    title: string
    elementCount: number
    elements: Array<{ ref: string; role: string; name: string }>
    dialogs: string[]
    messages: string[]
  }
  result?: ToolResult
  projectContext?: unknown
}

export interface AgentDecisionInput {
  goal: AgentTestGoal
  snapshot: PageSnapshot
  trajectory: AgentTrajectoryItem[]
  projectContexts: unknown[]
}

export interface AgentDecisionProvider {
  decide(input: AgentDecisionInput): Promise<AgentDecision>
}

export interface TestAgentResult {
  status: 'passed' | 'failed' | 'blocked'
  summary: string
  executedSteps: number
  passedAssertions: string[]
  trajectory: AgentTrajectoryItem[]
  screenshots: string[]
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
    elementCount: snapshot.stats.discoveredElements,
    elements: snapshot.elements.slice(0, 12).map(element => ({ ref: element.ref, role: element.role, name: element.name })),
    dialogs: snapshot.dialogs.map(dialog => dialog.title),
    messages: snapshot.messages.map(message => message.text).slice(0, 8),
  }
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
    }
    const trajectory: AgentTrajectoryItem[] = []
    const projectContexts: unknown[] = []
    const screenshots: string[] = []
    let snapshot = await this.observer.observe(page)
    const maxIterations = this.policy.maxSteps + 5

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      this.options.onActivity?.({
        id: `${snapshot.snapshotId}:${iteration}:deciding`,
        phase: 'deciding',
        title: '正在分析当前页面',
        purpose: `已观察到 ${snapshot.stats.discoveredElements} 个交互元素，正在决定下一步操作`,
        iteration,
        snapshotId: snapshot.snapshotId,
        status: 'running',
      })
      let decision: AgentDecision
      try {
        decision = agentDecisionSchema.parse(await this.decisionProvider.decide({
          goal: this.goal,
          snapshot,
          trajectory,
          projectContexts,
        }))
      } catch (error) {
        return this.result('failed', `Agent 决策无效：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
      }
      try {
        this.policy.validate(decision, snapshot, state)
      } catch (error) {
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
        try {
          projectContext = await this.resolveProjectContext(decision)
        } catch (error) {
          return this.result('blocked', `项目源码上下文获取失败：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
        }
        state.projectContextRequests += 1
        this.options.onActivity?.({ ...activity, status: 'passed', message: '源码上下文读取完成' })
        projectContexts.push(projectContext)
        trajectory.push({ iteration, snapshotId: snapshot.snapshotId, decision, observation: summarizeSnapshot(snapshot), projectContext })
        try {
          snapshot = await this.observer.observe(page)
        } catch (error) {
          return this.result('failed', `源码上下文返回后页面重观测失败：${error instanceof Error ? error.message : String(error)}`, state, trajectory, screenshots)
        }
        continue
      }

      const result = await this.executor.execute(decision.snapshotId, decision.action)
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
        if (!result.retryable) return this.result('failed', result.message, state, trajectory, screenshots)
        snapshot = await this.observer.observe(page)
        continue
      }
      snapshot = await this.observer.observe(page)
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
    }
  }
}
