import { existsSync } from 'node:fs'
import { getRuntimePaths } from './config/paths'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import { agentTestGoalSchema, type AgentTestGoal, type CaseExecutionResult, type ExecutionResult, type LiveExecutionEvent } from '@quality-ai/contracts'
import type { ProjectKnowledgeProvider } from './project-knowledge/types'
import type { AgentDecisionProvider, TestAgentResult } from './test-agent'
import { PageObserver } from './page-observer'
import { ResponsesDecisionProvider } from './responses-decision-provider'
import { SingleActionExecutor } from './single-action-executor'
import { TestAgent } from './test-agent'
import { startLivePageStream } from './live-page-stream'
import { completeCaseResults } from './complete-case-results'

export interface AgentTestRunnerOptions {
  signal?: AbortSignal
  executionId?: string
  projectProvider: ProjectKnowledgeProvider
  decisionProvider?: AgentDecisionProvider
  artifactRoot?: string
  launchBrowser?: () => Promise<Browser>
  onEvent?: (event: LiveExecutionEvent) => void
  onCaseStarted?: (value: Pick<CaseExecutionResult, 'caseKey' | 'startedFromUrl'>) => void
  onCaseCompleted?: (value: CaseExecutionResult) => void
}

// Session failures are observed at the browser boundary, not inferred from an Agent's business verdict.
export function observeSessionFailure(browser: Browser, page: Page) {
  let failure: string | undefined
  page.on('crash', () => { failure = '浏览器页面崩溃' })
  page.on('response', response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()
      && [401, 403, 502, 503, 504].includes(response.status())) {
      failure = `测试会话认证或网络不可用：HTTP ${response.status()}`
    }
  })
  page.on('requestfailed', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()
      && request.failure()?.errorText !== 'net::ERR_ABORTED') {
      failure = `测试网络不可用：${request.failure()?.errorText ?? request.url()}`
    }
  })
  return () => failure ?? (!browser.isConnected() || page.isClosed() ? '浏览器或会话已关闭，不能继续执行' : undefined)
}

export function aggregateExecutionStatus(results: CaseExecutionResult[]): ExecutionResult['status'] {
  for (const status of ['cancelled', 'infrastructure_failed', 'failed', 'blocked'] as const) {
    if (results.some(result => result.status === status)) return status
  }
  if (!results.length || results.some(result => result.status === 'not_run')) return 'infrastructure_failed'
  return 'passed'
}

function executionSteps(result: TestAgentResult): ExecutionResult['steps'] {
  return result.trajectory.flatMap(item => {
    if (item.decision.type !== 'action' || !item.result) return []
    return [{
      index: 0,
      action: item.decision.action.action,
      status: item.result.ok ? 'passed' as const : 'failed' as const,
      durationMs: item.result.durationMs,
      error: item.result.ok ? undefined : item.result.message,
    }]
  }).map((step, index) => ({ ...step, index }))
}

export async function runAgentTest(
  goalInputs: AgentTestGoal[],
  storageStatePath: string | undefined,
  options: AgentTestRunnerOptions,
): Promise<ExecutionResult> {
  const goals = agentTestGoalSchema.array().min(1).max(20).parse(goalInputs)
  const target = new URL(goals[0]!.targetUrl)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('测试地址只允许 HTTP 或 HTTPS')
  if (goals.some(goal => new URL(goal.targetUrl).origin !== target.origin)) throw new Error('批次用例必须属于同一测试环境')
  if (goals.some(goal => !goal.executionContract)) throw new Error('每条用例必须包含已解析的执行契约')
  if (new Set(goals.map(goal => goal.executionContract!.caseKey)).size !== goals.length) throw new Error('测试用例不能重复')

  const id = options.executionId ?? randomUUID()
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('执行 ID 不合法')
  const startedAt = new Date()
  const name = goals.length === 1 ? goals[0]!.name : `${goals[0]!.name} · ${goals.length} 条用例`
  const artifactDirectory = resolve(getRuntimePaths().workspaceRoot, options.artifactRoot ?? getRuntimePaths().artifactRoot, id)
  await mkdir(artifactDirectory, { recursive: true })
  const emit = (event: LiveExecutionEvent) => {
    try { options.onEvent?.(event) } catch { /* disconnected live viewers must not stop the test */ }
  }
  emit({ type: 'execution_started', executionId: id, mode: 'agent', name, targetUrl: target.href,
    cases: goals.map(goal => ({ key: goal.executionContract!.caseKey, title: goal.name })) })

  let browser: Browser | undefined
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined
  let traceStarted = false
  let livePageStream: Awaited<ReturnType<typeof startLivePageStream>> | undefined
  let infrastructureError: string | undefined
  let currentCase: CaseExecutionResult | undefined
  let cancellationPage: Page | undefined
  const stopPage = () => { void cancellationPage?.close().catch(() => undefined) }
  options.signal?.addEventListener('abort',stopPage,{once:true})
  const caseResults: CaseExecutionResult[] = []
  const previousCaseSummaries: NonNullable<AgentTestGoal['previousCaseSummaries']> = []

  try {
    options.signal?.throwIfAborted()
    browser = await (options.launchBrowser?.() ?? chromium.launch({ headless: true }))
    options.signal?.throwIfAborted()
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: storageStatePath })
    await context.tracing.start({ screenshots: true, snapshots: true })
    traceStarted = true
    const page = await context.newPage()
    cancellationPage = page
    options.signal?.throwIfAborted()
    const sessionFailure = observeSessionFailure(browser, page)
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (sessionFailure()) throw new Error(sessionFailure())
    try {
      livePageStream = await startLivePageStream(context, page, frame => {
        emit({ type: 'browser_frame', executionId: id, caseKey: currentCase?.caseKey, caseTitle: currentCase?.title, ...frame })
      })
    } catch (error) {
      emit({ type: 'activity', executionId: id, activity: {
        id: `${id}:preview-unavailable`, phase: 'observing', title: '实时画面暂不可用',
        purpose: 'Playwright 测试仍会继续执行，完成后可查看截图和 Trace',
        status: 'info', message: error instanceof Error ? error.message : String(error),
      } })
    }
    const decisionProvider = options.decisionProvider ?? new ResponsesDecisionProvider()
    for (const [index, goal] of goals.entries()) {
      options.signal?.throwIfAborted()
      const contract = goal.executionContract!
      const caseDirectory = resolve(artifactDirectory, `${String(index + 1).padStart(2, '0')}-${contract.caseKey}`)
      await mkdir(caseDirectory, { recursive: true })
      const tracePath = resolve(caseDirectory, 'trace.zip')
      const checkpoint: CaseExecutionResult = {
        caseKey: contract.caseKey, title: goal.name, contractFingerprint: contract.contractFingerprint,
        status: 'failed', startedFromUrl: page.url(), continuation: 'reused_current_page',
        resolvedDataBindings: [], passedAssertions: [], trajectory: [], steps: [], screenshots: [],
      }
      currentCase = checkpoint
      caseResults.push(checkpoint)
      let summary = ''
      let chunkStarted = false
      try {
        if (sessionFailure()) throw new Error(sessionFailure())
        options.onCaseStarted?.({caseKey:checkpoint.caseKey,startedFromUrl:checkpoint.startedFromUrl})
        await context.tracing.startChunk({ title: `${contract.caseKey} ${goal.name}` })
        chunkStarted = true
        const observer = new PageObserver()
        const executor = new SingleActionExecutor(page, observer.registry, goal.targetUrl, caseDirectory, goal.executionContract?.contract, options.signal)
        const caseGoal: AgentTestGoal = {
          ...goal,
          previousCaseSummaries: structuredClone(previousCaseSummaries),
          sessionContinuation: '这是同一浏览器会话中的新用例。根据当前真实 DOM 决定继续、恢复或导航；前序摘要仅是背景，前序断言和数据绑定不是当前用例证据，必须重新验证。',
        }
        const result = await new TestAgent(caseGoal, observer, executor, {
          async decide(input) {
            options.signal?.throwIfAborted()
            checkpoint.startedFromSnapshotId ??= input.snapshot.snapshotId
            checkpoint.trajectory = input.trajectory
            if (sessionFailure()) throw new Error(sessionFailure())
            const decision = await decisionProvider.decide(input, options.signal)
            options.signal?.throwIfAborted()
            return decision
          },
        }, {
          projectProvider: options.projectProvider,
          onActivity: activity => emit({ type: 'activity', executionId: id, caseKey: contract.caseKey, caseTitle: goal.name, activity }),
          capturePage: () => livePageStream?.capture().catch(() => undefined) ?? Promise.resolve(),
        }).run(page)
        Object.assign(checkpoint, {
          status: result.status, resolvedDataBindings: result.resolvedDataBindings ?? [],
          passedAssertions: result.passedAssertions, trajectory: result.trajectory,
          steps: executionSteps(result), screenshots: result.screenshots,
        })
        summary = result.summary
      } catch (error) {
        summary = error instanceof Error ? error.message : String(error)
        checkpoint.resolvedDataBindings = checkpoint.trajectory.flatMap(item => item.resolvedDataBinding ?? [])
        checkpoint.steps = executionSteps({ status: 'failed', summary, executedSteps: 0,
          trajectory: checkpoint.trajectory, screenshots: checkpoint.screenshots, passedAssertions: [] })
        checkpoint.passedAssertions = checkpoint.trajectory.flatMap(item =>
          item.result?.ok && item.decision.type === 'action' && 'assertionId' in item.decision.action
            ? [item.decision.action.assertionId] : [])
      } finally {
        checkpoint.usedFixtures = checkpoint.trajectory.flatMap(item => item.result?.usedFixture ? [item.result.usedFixture] : [])
        checkpoint.downloads = checkpoint.trajectory.flatMap(item => item.result?.download ? [item.result.download] : [])
        const failure = sessionFailure()
        if (options.signal?.aborted) {
          checkpoint.status = 'cancelled'
          summary = '用户取消执行；已提交的业务操作不会回滚'
        } else if (failure) {
          infrastructureError = failure
          checkpoint.status = 'infrastructure_failed'
          summary = failure
        }
        checkpoint.continuation = checkpoint.trajectory.some(item =>
          item.decision.type === 'action' && item.decision.action.action === 'goto' && item.result?.ok,
        ) ? 'agent_recovered_page' : 'reused_current_page'
        if (checkpoint.status !== 'passed') {
          checkpoint.error = summary
          const failurePath = resolve(caseDirectory, 'failure.png')
          await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined)
          if (existsSync(failurePath)) checkpoint.screenshots.push(failurePath)
        }
        if (chunkStarted) await context.tracing.stopChunk({ path: tracePath }).catch(() => undefined)
        if (existsSync(tracePath)) checkpoint.tracePath = tracePath
        options.onCaseCompleted?.(structuredClone(checkpoint))
      }
      previousCaseSummaries.push({
        caseKey: checkpoint.caseKey, title: checkpoint.title, status: checkpoint.status, summary: summary.slice(0, 500),
        actions: checkpoint.trajectory.filter(item => item.decision.type === 'action').slice(-3)
          .map(item => item.decision.type === 'action' ? `${item.decision.action.action}: ${item.decision.reason.slice(0, 120)} (${item.result?.ok ? '成功' : '失败'})` : ''),
      })
      if (infrastructureError || options.signal?.aborted) break
    }
  } catch (error) {
    infrastructureError = error instanceof Error ? error.message : String(error)
  } finally {
    options.signal?.removeEventListener('abort',stopPage)
    await livePageStream?.stop().catch(() => undefined)
    if (context && traceStarted) await context.tracing.stop().catch(() => undefined)
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }

  const finishedAt = new Date()
  const summary = options.signal?.aborted ? '用户取消执行；已提交的业务操作不会回滚' : infrastructureError ?? previousCaseSummaries.map(item => `[${item.caseKey}] ${item.status}：${item.summary}`).join('\n')
  return {
    id, name, targetUrl: target.href, mode: 'agent',
    status: options.signal?.aborted ? 'cancelled' : infrastructureError ? 'infrastructure_failed' : aggregateExecutionStatus(caseResults),
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    steps: caseResults.flatMap(result => result.steps).map((step, index) => ({ ...step, index })),
    screenshots: caseResults.flatMap(result => result.screenshots),
    tracePath: caseResults.find(result => result.tracePath)?.tracePath,
    error: options.signal?.aborted ? summary : infrastructureError ?? (caseResults.some(result => result.status !== 'passed') ? summary : undefined),
    caseResults: completeCaseResults(goals.map(goal=>({caseKey:goal.executionContract!.caseKey,title:goal.name,contractFingerprint:goal.executionContract!.contractFingerprint})),caseResults,
      options.signal?.aborted ? '批次已取消，该用例尚未开始' : infrastructureError ?? '批次提前结束，该用例尚未开始'),
    agent: {
      summary,
      passedAssertions: caseResults.flatMap(result => result.passedAssertions),
      trajectory: caseResults.flatMap(result => result.trajectory),
    },
  }
}
