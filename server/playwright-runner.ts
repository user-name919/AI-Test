import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Locator, type Page } from 'playwright'
import { automationPlanSchema, type AutomationPlan, type ExecutionResult, type LiveExecutionEvent } from '../shared/contracts'
import { describeAutomationStep } from '../shared/live-execution'
import { startLivePageStream } from './live-page-stream'

interface AutomationRunnerOptions {
  artifactRoot?: string
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
  const id = randomUUID()
  const startedAt = new Date()
  const artifactDirectory = resolve(options.artifactRoot ?? 'data/artifacts', id)
  await mkdir(artifactDirectory, { recursive: true })
  const screenshots: string[] = []
  const tracePath = resolve(artifactDirectory, 'trace.zip')
  const stepResults: ExecutionResult['steps'] = []
  const browser = await chromium.launch({ headless: true })
  let executionError: string | undefined
  let livePageStream: Awaited<ReturnType<typeof startLivePageStream>> | undefined
  const emit = (event: LiveExecutionEvent) => {
    try { options.onEvent?.(event) } catch { /* disconnected live viewers must not stop the test */ }
  }
  emit({ type: 'execution_started', executionId: id, mode: 'plan', name: plan.name, targetUrl: plan.targetUrl, cases: options.cases })

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: storageStatePath })
    await context.tracing.start({ screenshots: true, snapshots: true })
    const page = await context.newPage()
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
    for (const [index, step] of plan.steps.entries()) {
      const stepStart = Date.now()
      const activity = describeAutomationStep(step, index)
      emit({ type: 'activity', executionId: id, activity })
      try {
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
        } else {
          const filePath = resolve(artifactDirectory, `${String(index + 1).padStart(2, '0')}-${step.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.png`)
          await page.screenshot({ path: filePath, fullPage: true })
          screenshots.push(filePath)
        }
        stepResults.push({ index, action: step.action, status: 'passed', durationMs: Date.now() - stepStart })
        emit({ type: 'activity', executionId: id, activity: { ...activity, status: 'passed', durationMs: Date.now() - stepStart, message: '步骤执行成功' } })
        await livePageStream?.capture().catch(() => undefined)
      } catch (error) {
        executionError = error instanceof Error ? error.message : String(error)
        stepResults.push({ index, action: step.action, status: 'failed', durationMs: Date.now() - stepStart, error: executionError })
        emit({ type: 'activity', executionId: id, activity: { ...activity, status: 'failed', durationMs: Date.now() - stepStart, message: executionError } })
        const failurePath = resolve(artifactDirectory, 'failure.png')
        await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined)
        screenshots.push(failurePath)
        await livePageStream?.capture().catch(() => undefined)
        break
      }
    }
    await livePageStream?.stop().catch(() => undefined)
    livePageStream = undefined
    await context.tracing.stop({ path: tracePath })
    await context.close()
  } finally {
    await livePageStream?.stop().catch(() => undefined)
    await browser.close()
  }

  const finishedAt = new Date()
  return {
    id,
    name: plan.name,
    targetUrl: plan.targetUrl,
    status: executionError ? 'failed' : 'passed',
    mode: 'plan',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    steps: stepResults,
    screenshots,
    tracePath,
    error: executionError,
  }
}
