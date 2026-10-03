import { existsSync } from 'node:fs'
import { getRuntimePaths } from './config/paths'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { automationPlanSchema, type AutomationPlan, type CaseExecutionResult, type ExecutionResult, type LiveExecutionEvent } from '@quality-ai/contracts'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
import { startLivePageStream } from './live-page-stream'
import { PageObserver } from './page-observer'
import { aggregateExecutionStatus, observeSessionFailure } from './agent-test-runner'
import { completeCaseResults } from './complete-case-results'

interface AutomationRunnerOptions {
  signal?: AbortSignal
  executionId?: string
  artifactRoot?: string
  launchBrowser?: () => Promise<Browser>
  cases?: Array<{ key: string; title: string }>
  onEvent?: (event: LiveExecutionEvent) => void
}

function locatorFor(page: Page, locator: { by: string; value: string; name?: string }): Locator {
  if (locator.by === 'role') return page.getByRole(locator.value as never, locator.name ? { name: locator.name } : undefined)
  if (locator.by === 'label') return page.getByLabel(locator.value)
  if (locator.by === 'text') return page.getByText(locator.value)
  return page.locator(locator.value)
}

export async function runAutomationPlan(input: unknown, storageStatePath?: string, options: AutomationRunnerOptions = {}): Promise<ExecutionResult> {
  const plan: AutomationPlan = automationPlanSchema.parse(input)
  const baseUrl = new URL(plan.targetUrl)
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('测试地址只允许 HTTP 或 HTTPS')
  if (plan.casePlans?.some(item => item.contract?.dataBindings.some(binding => binding.mode === 'runtime_dom'))) {
    throw new Error('运行时数据需要预检解析；当前固定计划不接受未绑定的 runtime_dom 契约')
  }
  const id = options.executionId ?? randomUUID()
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('执行 ID 不合法')
  const startedAt = new Date()
  const artifactDirectory = resolve(getRuntimePaths().workspaceRoot, options.artifactRoot ?? getRuntimePaths().artifactRoot, id)
  await mkdir(artifactDirectory, { recursive: true })
  const caseResults: CaseExecutionResult[] = []
  let browser: Browser | undefined
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined
  let traceStarted = false
  let infrastructureError: string | undefined
  let livePageStream: Awaited<ReturnType<typeof startLivePageStream>> | undefined
  let currentCase: CaseExecutionResult | undefined
  let cancellationPage: Page | undefined
  const stopPage = () => { void cancellationPage?.close().catch(() => undefined) }
  options.signal?.addEventListener('abort',stopPage,{once:true})
  const emit = (event: LiveExecutionEvent) => {
    try { options.onEvent?.(event) } catch { /* disconnected live viewers must not stop the test */ }
  }
  emit({ type: 'execution_started', executionId: id, mode: 'plan', name: plan.name, targetUrl: plan.targetUrl,
    cases: plan.casePlans?.map(item => ({ key: item.caseKey, title: item.title })) ?? options.cases })

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
    try {
      livePageStream = await startLivePageStream(context, page, frame => {
        emit({ type: 'browser_frame', executionId: id, caseKey: currentCase?.caseKey || undefined, caseTitle: currentCase?.title, ...frame })
      })
    } catch (error) {
      emit({ type: 'activity', executionId: id, activity: {
        id: `${id}:preview-unavailable`, phase: 'observing', title: '实时画面暂不可用',
        purpose: 'Playwright 测试仍会继续执行，完成后可查看截图和 Trace',
        status: 'info', message: error instanceof Error ? error.message : String(error),
      } })
    }
    if (plan.casePlans) {
      await page.goto(baseUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (sessionFailure()) throw new Error(sessionFailure())
    }
    const checkpoints = plan.casePlans ?? [{ caseKey: '', title: plan.name, contractFingerprint: '', steps: plan.steps }]
    for (const [caseIndex, casePlan] of checkpoints.entries()) {
      options.signal?.throwIfAborted()
      const caseDirectory = plan.casePlans
        ? resolve(artifactDirectory, `${String(caseIndex + 1).padStart(2, '0')}-${casePlan.caseKey}`)
        : artifactDirectory
      await mkdir(caseDirectory, { recursive: true })
      const tracePath = resolve(caseDirectory, 'trace.zip')
      const checkpoint: CaseExecutionResult = {
        caseKey: casePlan.caseKey, title: casePlan.title, contractFingerprint: casePlan.contractFingerprint,
        status: 'passed', startedFromUrl: page.url(), continuation: 'reused_current_page',
        resolvedDataBindings: [], passedAssertions: [], trajectory: [], steps: [], screenshots: [],
      }
      currentCase = checkpoint
      caseResults.push(checkpoint)
      let chunkStarted = false
      try {
        if (sessionFailure()) throw new Error(sessionFailure())
        await context.tracing.startChunk({ title: casePlan.title })
        chunkStarted = true
        checkpoint.startedFromSnapshotId = (await new PageObserver().observe(page)).snapshotId
        for (const [index, step] of casePlan.steps.entries()) {
          const stepStart = Date.now()
          const activity = describeAutomationStep(step, index)
          activity.id = `${casePlan.caseKey || id}:${activity.id}`
          const activityEvent = { type: 'activity' as const, executionId: id, caseKey: casePlan.caseKey || undefined, caseTitle: casePlan.title }
          emit({ ...activityEvent, activity })
          try {
            options.signal?.throwIfAborted()
            if (sessionFailure()) throw new Error(sessionFailure())
            if (step.action === 'goto') {
              const destination = new URL(step.path, baseUrl)
              if (destination.origin !== baseUrl.origin) throw new Error('步骤不能跳转到测试环境之外')
              await page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            } else if (step.action === 'click') {
              await locatorFor(page, step.locator).click({ timeout: 10_000 })
            } else if (step.action === 'fill') {
              await locatorFor(page, step.locator).fill(step.value, { timeout: 10_000 })
            } else if (step.action === 'expectText') {
              await page.getByText(step.text).first().waitFor({ state: 'visible', timeout: 10_000 })
              checkpoint.passedAssertions.push(`step-${index + 1}`)
            } else {
              const filePath = resolve(caseDirectory, `${String(index + 1).padStart(2, '0')}-${step.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.png`)
              await page.screenshot({ path: filePath, fullPage: true })
              checkpoint.screenshots.push(filePath)
            }
            if (sessionFailure()) throw new Error(sessionFailure())
            checkpoint.steps.push({ index, action: step.action, status: 'passed', durationMs: Date.now() - stepStart })
            emit({ ...activityEvent, activity: { ...activity, status: 'passed', durationMs: Date.now() - stepStart, message: '步骤执行成功' } })
            await livePageStream?.capture().catch(() => undefined)
          } catch (error) {
            checkpoint.error = error instanceof Error ? error.message : String(error)
            checkpoint.status = 'failed'
            checkpoint.steps.push({ index, action: step.action, status: 'failed', durationMs: Date.now() - stepStart, error: checkpoint.error })
            emit({ ...activityEvent, activity: { ...activity, status: 'failed', durationMs: Date.now() - stepStart, message: checkpoint.error } })
            break
          }
        }
        if (checkpoint.status === 'passed' && checkpoint.passedAssertions.length === 0) {
          checkpoint.status = 'blocked'
          checkpoint.error = '固定计划完成了操作，但没有执行任何业务断言；不能据此判定用例通过。请补充验证步骤后重新执行'
          emit({ type: 'activity', executionId: id, caseKey: casePlan.caseKey || undefined, caseTitle: casePlan.title,
            activity: { id: `${casePlan.caseKey || id}:missing-assertions`, phase: 'observing', title: '缺少断言证据',
              purpose: '操作成功不等于业务验证通过，保留本次操作事实并继续后续用例', status: 'info', message: checkpoint.error } })
        }
      } catch (error) {
        checkpoint.status = 'failed'
        checkpoint.error = error instanceof Error ? error.message : String(error)
      } finally {
        if (options.signal?.aborted) {
          checkpoint.status = 'cancelled'
          checkpoint.error = '用户取消执行；已提交的业务操作不会回滚'
        } else if (sessionFailure()) {
          infrastructureError = sessionFailure()
          checkpoint.status = 'infrastructure_failed'
          checkpoint.error = infrastructureError
        }
        if (checkpoint.status !== 'passed') {
          const failurePath = resolve(caseDirectory, 'failure.png')
          await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined)
          if (existsSync(failurePath)) checkpoint.screenshots.push(failurePath)
        }
        if (chunkStarted) await context.tracing.stopChunk({ path: tracePath }).catch(() => undefined)
        if (existsSync(tracePath)) checkpoint.tracePath = tracePath
      }
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
  return {
    id, name: plan.name, targetUrl: plan.targetUrl,
    status: options.signal?.aborted ? 'cancelled' : infrastructureError ? 'infrastructure_failed' : aggregateExecutionStatus(caseResults),
    mode: 'plan',
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    steps: caseResults.flatMap(result => result.steps).map((step, index) => ({ ...step, index })),
    screenshots: caseResults.flatMap(result => result.screenshots),
    tracePath: caseResults.find(result => result.tracePath)?.tracePath,
    error: options.signal?.aborted ? '用户取消执行；已提交的业务操作不会回滚' : infrastructureError ?? caseResults.find(result => result.error)?.error,
    caseResults: plan.casePlans ? completeCaseResults(plan.casePlans,caseResults,
      options.signal?.aborted ? '批次已取消，该用例尚未开始' : infrastructureError ?? '批次提前结束，该用例尚未开始') : undefined,
  }
}
