import { existsSync } from 'node:fs'
import { getRuntimePaths } from '../config/paths'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type FrameLocator, type Locator, type Page } from 'playwright'
import { automationPlanSchema, type AutomationPlan, type CaseExecutionResult, type ExecutionResult, type LiveExecutionEvent } from '@quality-ai/contracts'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
import { validateFixedSelectData } from './fixed-select-option'
import { captureDownload, assertDownload } from './download-capture'
import { loadTestFixture, validateFixtureReference } from '../modules/test-fixtures/store'
import { startLivePageStream } from './live-page-stream'
import { PageObserver } from './page-observer'
import { aggregateExecutionStatus, observeSessionFailure } from './agent-test-runner'
import { completeCaseResults } from './complete-case-results'
import type { PageSnapshot, TestDataBinding, ResolveTestDataDecision } from '@quality-ai/contracts'
import { resolveRuntimeDataBinding, RuntimeDataBindingBlockedError } from './test-data-binding'
import { assertFixedCount, assertFixedLocator } from './fixed-locator-assertion'
import { validateFixedAssertionCoverage } from './fixed-assertion-coverage'
import { BrowserPageSession } from './browser-page-session'
import { capturePopup } from './capture-popup'
import { ActionOutcomeUnknownError, attemptInputAction } from './action-outcome'
import { requireWriteAuthorization } from './write-authorization'

interface AutomationRunnerOptions {
  writeAuthorizations?: ExecutionResult['writeAuthorizations']
  signal?: AbortSignal
  executionId?: string
  artifactRoot?: string
  launchBrowser?: () => Promise<Browser>
  cases?: Array<{ key: string; title: string }>
  onEvent?: (event: LiveExecutionEvent) => void
  onCaseStarted?: (value: Pick<CaseExecutionResult, 'caseKey' | 'startedFromUrl'>) => void
  onCaseCompleted?: (value: CaseExecutionResult) => void
  resolveTestData?: (binding:TestDataBinding,snapshot:PageSnapshot)=>Promise<ResolveTestDataDecision>
}

type FixedLocator = Extract<AutomationPlan['steps'][number], {action:'click'}>['locator']
function selectWithin(root: Page | FrameLocator | Locator, selector: Omit<FixedLocator, 'scope' | 'framePath'>): Locator {
  if (selector.by === 'role') return root.getByRole(selector.value as never, { name: selector.name, exact: selector.exact })
  if (selector.by === 'label') return root.getByLabel(selector.value, { exact: selector.exact })
  if (selector.by === 'text') return root.getByText(selector.value, { exact: selector.exact })
  return root.locator(selector.value)
}

function locatorFor(page: Page, locator: FixedLocator): Locator {
  let root: Page | FrameLocator | Locator = frameRootFor(page, locator.framePath)
  for (const scope of locator.scope ?? []) root = selectWithin(root, scope)
  return selectWithin(root, locator)
}

function frameRootFor(page: Page, framePath: FixedLocator['framePath']): Page | FrameLocator {
  let root: Page | FrameLocator = page
  for (const selector of framePath ?? []) root = selectWithin(root, selector).contentFrame()
  return root
}

async function countWithin(page:Page,locator:FixedLocator){
  let root:Page|FrameLocator|Locator=frameRootFor(page,locator.framePath)
  // A missing frame/container must not make an expected zero pass accidentally.
  await root.locator('html').waitFor({state:'visible',timeout:10000})
  for(const scope of locator.scope??[]){
    root=selectWithin(root,scope)
    await root.waitFor({state:'visible',timeout:10000})
  }
  return selectWithin(root,locator).count()
}

export async function runAutomationPlan(input: unknown, storageStatePath?: string, options: AutomationRunnerOptions = {}): Promise<ExecutionResult> {
  const plan: AutomationPlan = automationPlanSchema.parse(input)
  requireWriteAuthorization(plan.casePlans ?? [], plan.targetUrl, options.writeAuthorizations)
  const baseUrl = new URL(plan.targetUrl)
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('测试地址只允许 HTTP 或 HTTPS')
  if (!options.resolveTestData && plan.casePlans?.some(item => item.contract?.dataBindings.some(binding => binding.mode === 'runtime_dom'))) {
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
  let uncertainAction: string | undefined
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
    const failures = new WeakMap<Page, () => string | undefined>()
    context.on('page', opened => { failures.set(opened, observeSessionFailure(browser!, opened)) })
    let page = await context.newPage()
    const initialPage = page
    cancellationPage = page
    options.signal?.throwIfAborted()
    const sessionFailure = () => failures.get(page)?.()
    const followPage = async (next:Page) => {
      page = next
      cancellationPage = next
      await livePageStream?.stop().catch(()=>undefined)
      livePageStream = undefined
      try {
        livePageStream = await startLivePageStream(context!, next, frame => {
          if(page===next)emit({ type:'browser_frame', executionId:id, caseKey:currentCase?.caseKey||undefined, caseTitle:currentCase?.title, pageUrl:next.url(), ...frame })
        })
      } catch(error) {
        emit({ type:'activity', executionId:id, activity:{
          id:`${id}:preview-unavailable`, phase:'observing', title:'实时画面暂不可用',
          purpose:'Playwright 测试仍会继续执行，完成后可查看截图和 Trace',
          status:'info', message:error instanceof Error?error.message:String(error),
        } })
      }
    }
    const pages = new BrowserPageSession(page, baseUrl.origin, followPage)
    await followPage(page)
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
      const aliases = new Map<string, Page | undefined>([['initial', initialPage], ['caseStart', page]])
      let chunkStarted = false
      try {
        options.onCaseStarted?.({caseKey:checkpoint.caseKey,startedFromUrl:checkpoint.startedFromUrl})
        if(casePlan.preparationError){
          checkpoint.status='blocked'
          checkpoint.error=casePlan.preparationError
          continue
        }
        if(casePlan.contract){
          try{validateFixedAssertionCoverage(casePlan.steps,casePlan.contract)}
          catch(error){checkpoint.status='blocked';checkpoint.error=error instanceof Error?error.message:String(error);continue}
        }
        if (sessionFailure()) throw new Error(sessionFailure())
        await context.tracing.startChunk({ title: casePlan.title })
        chunkStarted = true
        checkpoint.startedFromSnapshotId = (await new PageObserver().observe(page)).snapshotId
        for (const [index, step] of casePlan.steps.entries()) {
          const stepStart = Date.now()
          const pageBefore = pages.identity()
          let openedPage: {ref:string;url:string;alias:string} | undefined
          const activity = describeAutomationStep(step, index)
          activity.id = `${casePlan.caseKey || id}:${activity.id}`
          const activityEvent = { type: 'activity' as const, executionId: id, caseKey: casePlan.caseKey || undefined, caseTitle: casePlan.title }
          emit({ ...activityEvent, activity })
          try {
            options.signal?.throwIfAborted()
            if (sessionFailure()) throw new Error(sessionFailure())
            // Legacy ungrouped plans may begin on about:blank with goto; other actions require the configured origin.
            if(step.action!=='goto')pages.assertAllowed()
            if (step.action === 'goto') {
              const destination = new URL(step.path, baseUrl)
              if (destination.origin !== baseUrl.origin) throw new Error('步骤不能跳转到测试环境之外')
              await page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            } else if(step.action==='openPage') {
              if(aliases.has(step.pageAlias))throw new RuntimeDataBindingBlockedError('页面别名已使用，禁止重新绑定或重复点击')
              aliases.set(step.pageAlias, undefined)
              const opened = await capturePopup(page, ()=>locatorFor(page,step.locator).click({timeout:10000}), options.signal)
              openedPage = {...pages.identity(opened),alias:step.pageAlias}
              try { pages.assertAllowed(opened) }
              catch(error) { throw new RuntimeDataBindingBlockedError(error instanceof Error?error.message:String(error)) }
              aliases.set(step.pageAlias, opened)
            } else if(step.action==='switchPage') {
              const selected=aliases.get(step.pageAlias)
              if(!selected)throw new RuntimeDataBindingBlockedError('页面别名尚未绑定，禁止按URL或下标猜测页面')
              try { await pages.activate(selected) }
              catch(error) { throw new RuntimeDataBindingBlockedError(error instanceof Error?error.message:String(error)) }
            } else if (step.action === 'click') {
              const locator=locatorFor(page,step.locator)
              await locator.click({trial:true,timeout:10000})
              options.signal?.throwIfAborted()
              await attemptInputAction('click',()=>locator.click({timeout:10000}))
            } else if (step.action === 'download') {
              checkpoint.downloads ??= []
              if (checkpoint.downloads.some(item => item.downloadId === step.downloadId)) throw new Error('同一用例下载 ID 不得重复使用，请为新下载明确不同 ID')
              checkpoint.downloads.push(await captureDownload(page, () => locatorFor(page, step.locator).click({ timeout: 10000 }), caseDirectory, step.downloadId, options.signal))
            } else if (step.action === 'expectDownload') {
              await assertDownload(checkpoint.downloads?.find(item => item.downloadId === step.downloadId), step)
              checkpoint.passedAssertions.push(step.assertionIndex===undefined?`step-${index+1}`:`assertion-${step.assertionIndex}`)
            } else if (step.action === 'check' || step.action === 'uncheck' || step.action === 'hover') {
              await locatorFor(page, step.locator)[step.action]({ timeout: 10_000 })
            } else if (step.action === 'press') {
              const locator=locatorFor(page,step.locator)
              await locator.waitFor({state:'visible',timeout:10000})
              options.signal?.throwIfAborted()
              await attemptInputAction('press',()=>locator.press(step.key,{timeout:10000}))
            } else if (step.action === 'selectOption') {
              validateFixedSelectData(step.value, casePlan.contract)
              await locatorFor(page, step.locator).selectOption(
                step.optionBy === 'label' ? { label: step.value } : { value: step.value },
                { timeout: 10_000 },
              )
            } else if (step.action === 'uploadFile') {
              validateFixtureReference(step.fixtureId, casePlan.contract)
              let fixture
              try { fixture = await loadTestFixture(step.fixtureId) }
              catch { throw new RuntimeDataBindingBlockedError('已登记测试附件缺失、已改变或不可读取，请回到附件配置检查') }
              options.signal?.throwIfAborted()
              checkpoint.usedFixtures ??= []
              checkpoint.usedFixtures.push(fixture.metadata)
              await locatorFor(page, step.locator).setInputFiles({ name: fixture.metadata.name, mimeType: fixture.metadata.mimeType, buffer: fixture.buffer }, { timeout: 10_000 })
            } else if (step.action === 'fill') {
              const value=step.valueRef?checkpoint.resolvedDataBindings.find(binding=>binding.bindingId===step.valueRef)?.value:step.value
              if(value===undefined)throw new RuntimeDataBindingBlockedError(`输入引用尚未解析：${step.valueRef}`)
              if(!step.valueRef&&casePlan.contract?.dataBindings.some(binding=>binding.mode==='runtime_dom')&&!casePlan.contract.dataBindings.some(binding=>binding.mode==='fixture'?binding.fixture?.value===value:binding.mode==='manual'&&binding.manual?.value===value))throw new RuntimeDataBindingBlockedError('运行时数据不能使用未确认的固定输入')
              await locatorFor(page, step.locator).fill(value, { timeout: 10_000 })
              if(step.valueRef){
                const binding=casePlan.contract?.dataBindings.find(item=>item.id===step.valueRef)
                const resolved=checkpoint.resolvedDataBindings.find(item=>item.bindingId===step.valueRef)
                if(binding?.constraints.mustRemainAfterFiltering&&resolved){
                  try{await frameRootFor(page,step.locator.framePath).getByRole('option',{name:resolved.sourceText,exact:true}).first().waitFor({state:'visible',timeout:10_000})}
                  catch{throw new Error(`产品筛选行为不符合已确认契约：输入“${value}”后来源 option“${resolved.sourceText}”未保留`)}
                }
              }
            } else if (step.action === 'expectText') {
              const value=step.valueRef?checkpoint.resolvedDataBindings.find(binding=>binding.bindingId===step.valueRef)?.value:step.text
              if(value===undefined)throw new RuntimeDataBindingBlockedError(`断言引用尚未解析：${step.valueRef}`)
              await frameRootFor(page,step.framePath).getByText(value).first().waitFor({ state: 'visible', timeout: 10_000 })
              checkpoint.passedAssertions.push(step.assertionIndex===undefined?`step-${index+1}`:`assertion-${step.assertionIndex}`)
            } else if(step.action==='resolveTestData'){
              const binding=casePlan.contract?.dataBindings.find(item=>item.id===step.bindingId)
              if(!binding||!options.resolveTestData)throw new RuntimeDataBindingBlockedError('缺少运行时数据契约或解析能力')
              const root=frameRootFor(page,step.framePath)
              const document=await root.locator('html').elementHandle({timeout:10_000})
              if(!document)throw new RuntimeDataBindingBlockedError('测试数据框架尚未加载')
              let snapshot:PageSnapshot
              try{
                const frame=await document.ownerFrame()
                if(!frame)throw new RuntimeDataBindingBlockedError('测试数据框架已失效')
                snapshot=await new PageObserver({},pages).observe(page,frame)
              }finally{await document.dispose()}
              const proposal=await options.resolveTestData(binding,snapshot)
              options.signal?.throwIfAborted()
              const resolved=resolveRuntimeDataBinding(binding,snapshot,proposal)
              checkpoint.resolvedDataBindings=checkpoint.resolvedDataBindings.filter(item=>item.bindingId!==binding.id).concat(resolved)
            } else if(step.action==='expectCount'){
              await assertFixedCount(()=>countWithin(page,step.locator),step.count,options.signal)
              checkpoint.passedAssertions.push(step.assertionIndex===undefined?`step-${index+1}`:`assertion-${step.assertionIndex}`)
            } else if('locator' in step){
              const expected=step.action==='expectValue'?(step.valueRef?checkpoint.resolvedDataBindings.find(binding=>binding.bindingId===step.valueRef)?.value:step.value):undefined
              if(step.action==='expectValue'&&expected===undefined)throw new RuntimeDataBindingBlockedError(`断言引用尚未解析：${step.valueRef}`)
              await assertFixedLocator(locatorFor(page,step.locator),step,expected,options.signal)
              checkpoint.passedAssertions.push(step.assertionIndex===undefined?`step-${index+1}`:`assertion-${step.assertionIndex}`)
            } else {
              const filePath = resolve(caseDirectory, `${String(index + 1).padStart(2, '0')}-${step.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.png`)
              await page.screenshot({ path: filePath, fullPage: true })
              checkpoint.screenshots.push(filePath)
            }
            if (sessionFailure()) throw new Error(sessionFailure())
            checkpoint.steps.push({ index, action: step.action, status: 'passed', durationMs: Date.now() - stepStart, pageBefore, pageAfter:pages.identity(), openedPage })
            emit({ ...activityEvent, activity: { ...activity, status: 'passed', durationMs: Date.now() - stepStart, message: '步骤执行成功' } })
            await livePageStream?.capture().catch(() => undefined)
          } catch (error) {
            checkpoint.error = error instanceof Error ? error.message : String(error)
            checkpoint.status = error instanceof RuntimeDataBindingBlockedError||error instanceof ActionOutcomeUnknownError?'blocked':'failed'
            if(error instanceof ActionOutcomeUnknownError)uncertainAction=checkpoint.error
            checkpoint.steps.push({ index, action: step.action, status: 'failed', durationMs: Date.now() - stepStart, error: checkpoint.error, pageBefore, pageAfter:pages.identity(), openedPage })
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
          await page.screenshot({ path: failurePath, fullPage: true, timeout:5000 }).catch(() => undefined)
          if (existsSync(failurePath)) checkpoint.screenshots.push(failurePath)
        }
        if(uncertainAction)await page.close({runBeforeUnload:false}).catch(()=>undefined)
        if (chunkStarted) await context.tracing.stopChunk({ path: tracePath }).catch(() => undefined)
        if (existsSync(tracePath)) checkpoint.tracePath = tracePath
        options.onCaseCompleted?.(structuredClone(checkpoint))
      }
      if (infrastructureError || uncertainAction || options.signal?.aborted) break
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
    writeAuthorizations: options.writeAuthorizations,
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
      options.signal?.aborted ? '批次已取消，该用例尚未开始' : infrastructureError ?? uncertainAction ?? '批次提前结束，该用例尚未开始') : undefined,
  }
}
