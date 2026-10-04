import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Locator, Page } from 'playwright'
import { toolResultSchema, type AgentAction, type ResolvedDataBinding, type ToolResult } from '@quality-ai/contracts'
import type { ElementRegistry } from './element-registry'
import { readCheckedState } from './checked-state'
import type { CaseExecutionContract, DownloadEvidence } from '@quality-ai/contracts'
import { captureDownload, assertDownload } from './download-capture'
import type { TestFixture } from '@quality-ai/contracts/test-fixtures'
import { loadTestFixture, validateFixtureReference } from '../modules/test-fixtures/store'
import { RuntimeDataBindingBlockedError } from './test-data-binding'
import type { BrowserPageSession } from './browser-page-session'
import { guardWriteAction, WriteActionBlockedError } from './write-action-guard'
import type { ExecutionWriteAuthorization, WriteGuardEvidence } from '@quality-ai/contracts'
import { ActionOutcomeUnknownError, attemptInputAction } from './action-outcome'

function safeArtifactName(value: string) {
  return value.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 80) || 'screenshot'
}

function classifyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const retryable = lower.includes('timeout') || lower.includes('detached') || lower.includes('not visible') || lower.includes('intercepts pointer')
  return { message, retryable, code: retryable ? 'technical_action_failed' : 'action_failed' }
}

async function waitForAssertion<T>(
  read: () => Promise<T>,
  matches: (actual: T) => boolean,
  failureMessage: (actual: T) => string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs
  let actual = await read()
  while (!matches(actual) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    actual = await read()
  }
  if (!matches(actual)) throw new Error(failureMessage(actual))
}

function actionValue(
  action: Extract<AgentAction, { action: 'fill' | 'selectOption' | 'expectValue' }>,
  bindings: ReadonlyMap<string, ResolvedDataBinding> | undefined,
) {
  if (action.value !== undefined) return action.value
  const binding = action.valueRef ? bindings?.get(action.valueRef) : undefined
  if (!binding) throw new Error(`数据引用尚未解析：${action.valueRef ?? ''}`)
  return binding.value
}

export class SingleActionExecutor {
  private readonly downloads = new Map<string, DownloadEvidence>()
  constructor(
    private readonly initialPage: Page,
    private readonly registry: ElementRegistry,
    private readonly baseUrl: string,
    private readonly artifactDirectory: string,
    private readonly contract?: CaseExecutionContract,
    private readonly signal?: AbortSignal,
    private readonly pages?: BrowserPageSession,
    private readonly writeAuthorization?: ExecutionWriteAuthorization,
  ) {}

  private get page() { return this.pages?.current ?? this.initialPage }

  async execute(
    snapshotId: string,
    action: AgentAction,
    bindings?: ReadonlyMap<string, ResolvedDataBinding>,
  ): Promise<ToolResult> {
    const startedAt = Date.now()
    const previousUrl = this.page.url()
    let usedFixture: TestFixture | undefined
    let download: DownloadEvidence | undefined
    let writeGuard:WriteGuardEvidence|undefined
    try {
      this.pages?.assertAllowed()
      if (snapshotId !== this.registry.activeSnapshotId) throw new Error('页面快照已失效，必须重新观察后执行')
      let screenshotPath: string | undefined
      if(action.action==='download')writeGuard=await guardWriteAction(this.registry.resolve(snapshotId,action.elementRef),action,this.contract,this.writeAuthorization,this.baseUrl)
      if (action.action === 'switchPage') {
        if (!this.pages) throw new Error('当前执行上下文未启用标签页切换')
        await this.pages.select(snapshotId, action.pageRef)
        await this.registry.resetPage()
      } else if (action.action === 'switchFrame') {
        this.registry.selectFrame(snapshotId, action.frameRef)
      } else if(action.action==='observeRegion'){
        await this.registry.observeRegion(snapshotId,action.elementRef)
      } else if (action.action === 'download') {
        if (this.downloads.has(action.downloadId)) throw new Error('同一用例下载 ID 不得重复使用')
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        download = await captureDownload(this.page, () => locator.click({ timeout: 10000 }), this.artifactDirectory, action.downloadId, this.signal)
        this.downloads.set(action.downloadId, download)
      } else if (action.action === 'expectDownload') {
        await assertDownload(this.downloads.get(action.downloadId), action)
      } else if (action.action === 'uploadFile') {
        validateFixtureReference(action.fixtureId, this.contract)
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        let fixture
        try { fixture = await loadTestFixture(action.fixtureId) }
        catch { throw new RuntimeDataBindingBlockedError('已登记附件缺失、已改变或不可读取，请回到测试附件检查') }
        usedFixture = fixture.metadata
        await locator.setInputFiles({ name: fixture.metadata.name, mimeType: fixture.metadata.mimeType, buffer: fixture.buffer }, { timeout: 10000 })
      } else if (action.action === 'goto') {
        const destination = new URL(action.path, this.baseUrl)
        const initialTarget = new URL(this.baseUrl)
        if (destination.origin === initialTarget.origin && !destination.search && initialTarget.search) {
          destination.search = initialTarget.search
        }
        await this.page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        this.registry.resetFrame()
      } else if (action.action === 'click') {
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        await locator.click({trial:true, timeout:10000})
        writeGuard=await guardWriteAction(locator,action,this.contract,this.writeAuthorization,this.baseUrl)
        this.signal?.throwIfAborted()
        await attemptInputAction('click',()=>locator.click({timeout:10000}))
      } else if (action.action === 'fill') {
        await this.registry.resolve(snapshotId, action.elementRef).fill(actionValue(action, bindings), { timeout: 10_000 })
      } else if (action.action === 'selectOption') {
        await this.registry.resolve(snapshotId, action.elementRef).selectOption(actionValue(action, bindings), { timeout: 10_000 })
      } else if (action.action === 'check') {
        await this.registry.resolve(snapshotId, action.elementRef).check({ timeout: 10_000 })
      } else if (action.action === 'uncheck') {
        await this.registry.resolve(snapshotId, action.elementRef).uncheck({ timeout: 10_000 })
      } else if (action.action === 'press') {
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        await locator.waitFor({state:'visible',timeout:10000})
        writeGuard=await guardWriteAction(locator,action,this.contract,this.writeAuthorization,this.baseUrl)
        this.signal?.throwIfAborted()
        await attemptInputAction('press',()=>locator.press(action.key,{timeout:10000}))
      } else if (action.action === 'hover') {
        await this.registry.resolve(snapshotId, action.elementRef).hover({ timeout: 10_000 })
      } else if (action.action === 'scroll') {
        if (action.elementRef) {
          await this.registry.resolve(snapshotId, action.elementRef).evaluate((element, delta) => {
            element.scrollBy({ left: delta.x, top: delta.y, behavior: 'auto' })
          }, { x: action.deltaX, y: action.deltaY })
        } else {
          await this.registry.activeRoot(this.page).evaluate(delta => window.scrollBy({ left: delta.x, top: delta.y, behavior: 'auto' }), {
            x: action.deltaX,
            y: action.deltaY,
          })
        }
      } else if (action.action === 'expectVisible') {
        await this.registry.resolve(snapshotId, action.elementRef).waitFor({ state: 'visible', timeout: 10_000 })
      } else if (action.action === 'expectHidden') {
        let locator: Locator
        if (action.target.by === 'elementRef') locator = this.registry.resolve(snapshotId, action.target.elementRef)
        else if (action.target.by === 'text') locator = this.registry.activeRoot(this.page).getByText(action.target.text, { exact: action.target.exact }).first()
        else locator = this.registry.activeRoot(this.page).getByRole(action.target.role, { name: action.target.name, exact: action.target.exact }).first()
        await locator.waitFor({ state: 'hidden', timeout: 10_000 })
      } else if (action.action === 'expectEnabled') {
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        await waitForAssertion(() => locator.isEnabled({ timeout: 10_000 }), value => value, () => '可用状态断言失败：元素仍不可用')
      } else if (action.action === 'expectDisabled') {
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        await waitForAssertion(() => locator.isDisabled({ timeout: 10_000 }), value => value, () => '禁用状态断言失败：元素仍可用')
      } else if (action.action === 'expectChecked') {
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        await waitForAssertion(() => readCheckedState(locator), value => value === action.checked, actual => `选中状态断言失败：预期 ${action.checked}，实际 ${actual}`)
      } else if (action.action === 'expectValue') {
        const expected = actionValue(action, bindings)
        const actual = await this.registry.resolve(snapshotId, action.elementRef).inputValue({ timeout: 10_000 })
        if (actual !== expected) throw new Error(`值断言失败：预期“${expected}”，实际“${actual}”`)
      } else if (action.action === 'expectText') {
        await this.registry.activeRoot(this.page).getByText(action.text, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 })
      } else if (action.action === 'expectElementText') {
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        await waitForAssertion(
          () => locator.innerText({ timeout: 10_000 }),
          actual => action.exact ? actual.trim() === action.text : actual.includes(action.text),
          actual => `元素文本断言失败：预期${action.exact ? '等于' : '包含'}“${action.text}”，实际“${actual}”`,
        )
      } else if (action.action === 'expectAttribute') {
        const locator = this.registry.resolve(snapshotId, action.elementRef)
        await waitForAssertion(
          () => locator.getAttribute(action.name),
          actual => action.match === 'equals' ? actual === action.value : (actual?.includes(action.value) ?? false),
          actual => `属性断言失败：${action.name} 预期${action.match === 'equals' ? '等于' : '包含'}“${action.value}”，实际“${actual ?? 'null'}”`,
        )
      } else if (action.action === 'expectCount') {
        const scope = action.containerRef ? this.registry.resolve(snapshotId, action.containerRef) : this.registry.activeRoot(this.page)
        const locator = scope.getByRole(action.role, { name: action.name, exact: action.exact })
        await waitForAssertion(
          () => locator.count(),
          actual => actual === action.count,
          actual => `数量断言失败：${action.role} 预期 ${action.count} 个，实际 ${actual} 个`,
        )
      } else if (action.action === 'waitFor') {
        await this.page.waitForTimeout(action.durationMs)
      } else {
        await mkdir(this.artifactDirectory, { recursive: true })
        screenshotPath = resolve(this.artifactDirectory, `${safeArtifactName(action.name)}.png`)
        await this.page.screenshot({ path: screenshotPath, fullPage: true })
      }
      const pageChanged = previousUrl !== this.page.url()
        || ['goto', 'click', 'fill', 'selectOption', 'check', 'uncheck', 'press', 'hover', 'scroll', 'uploadFile', 'download', 'switchFrame', 'switchPage'].includes(action.action)
      return toolResultSchema.parse({
        ok: true,
        code: 'ok',
        retryable: false,
        message: '动作执行成功',
        durationMs: Date.now() - startedAt,
        pageChanged,
        screenshotPath,
        usedFixture,
        download,
        writeGuard,
      })
    } catch (error) {
      const classified = classifyError(error)
      return toolResultSchema.parse({
        ok: false,
        ...classified,
        ...(error instanceof ActionOutcomeUnknownError ? {retryable:false,code:'action_outcome_unknown'} : {}),
        ...(action.action === 'uploadFile' ? { retryable: false, code: error instanceof RuntimeDataBindingBlockedError ? 'fixture_unavailable' : 'upload_failed', usedFixture } : {}),
        ...(action.action === 'download' ? { retryable: false, code: 'download_failed' } : {}),
        ...(error instanceof WriteActionBlockedError ? {retryable:false,code:'write_authorization_required',writeGuard:error.evidence} : {writeGuard}),
        durationMs: Date.now() - startedAt,
        pageChanged: previousUrl !== this.page.url(),
      })
    }
  }
}
