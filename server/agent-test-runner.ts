import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser } from 'playwright'
import { agentTestGoalSchema, type AgentTestGoal, type ExecutionResult, type LiveExecutionEvent } from '../shared/contracts'
import type { ProjectKnowledgeProvider } from './project-knowledge/types'
import type { AgentDecisionProvider, TestAgentResult } from './test-agent'
import { PageObserver } from './page-observer'
import { ResponsesDecisionProvider } from './responses-decision-provider'
import { SingleActionExecutor } from './single-action-executor'
import { TestAgent } from './test-agent'
import { startLivePageStream } from './live-page-stream'

interface AgentTestRunnerOptions {
  projectProvider: ProjectKnowledgeProvider
  decisionProvider?: AgentDecisionProvider
  artifactRoot?: string
  launchBrowser?: () => Promise<Browser>
  cases?: Array<{ key: string; title: string }>
  onEvent?: (event: LiveExecutionEvent) => void
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
  goalInput: AgentTestGoal,
  storageStatePath: string | undefined,
  options: AgentTestRunnerOptions,
): Promise<ExecutionResult> {
  const goal = agentTestGoalSchema.parse(goalInput)
  const target = new URL(goal.targetUrl)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('测试地址只允许 HTTP 或 HTTPS')

  const id = randomUUID()
  const startedAt = new Date()
  const artifactDirectory = resolve(options.artifactRoot ?? 'data/artifacts', id)
  const tracePath = resolve(artifactDirectory, 'trace.zip')
  await mkdir(artifactDirectory, { recursive: true })
  const emit = (event: LiveExecutionEvent) => {
    try { options.onEvent?.(event) } catch { /* disconnected live viewers must not stop the test */ }
  }
  emit({ type: 'execution_started', executionId: id, mode: 'agent', name: goal.name, targetUrl: goal.targetUrl, cases: options.cases })

  let browser: Browser | undefined
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined
  let page: Awaited<ReturnType<NonNullable<typeof context>['newPage']>> | undefined
  let traceStarted = false
  let livePageStream: Awaited<ReturnType<typeof startLivePageStream>> | undefined
  let agentResult: TestAgentResult = {
    status: 'failed', summary: 'Agent 尚未开始执行', executedSteps: 0,
    passedAssertions: [], trajectory: [], screenshots: [],
  }

  try {
    browser = await (options.launchBrowser?.() ?? chromium.launch({ headless: true }))
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      storageState: storageStatePath,
    })
    await context.tracing.start({ screenshots: true, snapshots: true })
    traceStarted = true
    page = await context.newPage()
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    try {
      livePageStream = await startLivePageStream(context, page, frame => {
        emit({ type: 'browser_frame', executionId: id, ...frame })
      })
    } catch (error) {
      emit({
        type: 'activity', executionId: id,
        activity: {
          id: `${id}:preview-unavailable`, phase: 'observing', title: '实时画面暂不可用',
          purpose: 'Playwright 测试仍会继续执行，完成后可查看截图和 Trace',
          status: 'info', message: error instanceof Error ? error.message : String(error),
        },
      })
    }

    const observer = new PageObserver()
    const executor = new SingleActionExecutor(page, observer.registry, target.href, artifactDirectory)
    const decisionProvider = options.decisionProvider ?? new ResponsesDecisionProvider()
    agentResult = await new TestAgent(goal, observer, executor, decisionProvider, {
      projectProvider: options.projectProvider,
      onActivity: activity => emit({ type: 'activity', executionId: id, activity }),
      capturePage: () => livePageStream?.capture().catch(() => undefined) ?? Promise.resolve(),
    }).run(page)

    if (agentResult.status !== 'passed') {
      const failurePath = resolve(artifactDirectory, 'failure.png')
      await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined)
      if (existsSync(failurePath) && !agentResult.screenshots.includes(failurePath)) agentResult.screenshots.push(failurePath)
    }
  } catch (error) {
    agentResult = {
      ...agentResult,
      status: 'failed',
      summary: `Agent 运行失败：${error instanceof Error ? error.message : String(error)}`,
    }
    if (page) {
      const failurePath = resolve(artifactDirectory, 'failure.png')
      await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined)
      if (existsSync(failurePath) && !agentResult.screenshots.includes(failurePath)) agentResult.screenshots.push(failurePath)
    }
  } finally {
    await livePageStream?.stop().catch(() => undefined)
    if (context && traceStarted) await context.tracing.stop({ path: tracePath }).catch(() => undefined)
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }

  const finishedAt = new Date()
  return {
    id,
    name: goal.name,
    targetUrl: goal.targetUrl,
    status: agentResult.status,
    mode: 'agent',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    steps: executionSteps(agentResult),
    screenshots: agentResult.screenshots,
    tracePath: existsSync(tracePath) ? tracePath : undefined,
    error: agentResult.status === 'passed' ? undefined : agentResult.summary,
    agent: {
      summary: agentResult.summary,
      passedAssertions: agentResult.passedAssertions,
      trajectory: agentResult.trajectory,
    },
  }
}
