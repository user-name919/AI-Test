import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import type { AgentTestGoal, AutomationPlan } from '@quality-ai/contracts'
import { saveTestFixture } from './modules/test-fixtures/store'
import { runAgentTest } from './automation/agent-test-runner'
import { runAutomationPlan } from './automation/playwright-runner'
import { waitForInputReady } from './automation/input-readiness'

test('填值、原生选择、上传实际派发后注入响应故障，两模式不重试且保留上传证据', async t => {
  const root = await mkdtemp(join(tmpdir(), 'quality-ai-value-outcome-'))
  const previous = process.env.QUALITY_AI_DATA_ROOT
  process.env.QUALITY_AI_DATA_ROOT = root
  t.after(async () => {
    if (previous === undefined) delete process.env.QUALITY_AI_DATA_ROOT
    else process.env.QUALITY_AI_DATA_ROOT = previous
    await rm(root, { recursive: true, force: true })
  })
  const fixture = await saveTestFixture({ name: 'sample.txt', mimeType: 'text/plain', base64: Buffer.from('synthetic').toString('base64') })
  let writes = 0
  const server = createServer((request, response) => {
    if (request.url === '/save') { writes++; response.end('ok'); return }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<input aria-label="文本" oninput="save()"><select aria-label="选项" onchange="save()"><option value="a">甲</option><option value="b">乙</option></select>
      <input aria-label="附件" type="file" onchange="save()"><p>结果</p>
      <script>function save(){const r=new XMLHttpRequest();r.open('POST','/save',false);r.send()}</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const targetUrl = `http://127.0.0.1:${address.port}`
  for (const action of ['fill', 'selectOption', 'uploadFile'] as const) {
    const method = action === 'uploadFile' ? 'setInputFiles' : action
    // Real input and HTTP side effect first; the later exception is explicitly injected, not a real transport outage.
    const launchBrowser = async () => {
      const browser = await chromium.launch({ headless: true })
      const newContext = browser.newContext.bind(browser)
      browser.newContext = async options => {
        const context = await newContext(options)
        context.on('page', page => {
          const frame = page.mainFrame()
          const locate = frame.locator.bind(frame)
          frame.locator = (selector, options) => {
            const locator = locate(selector, options)
            if (method === 'fill') {
              const original = locator.fill.bind(locator)
              locator.fill = async (...args) => { await original(...args); throw new Error('注入：输入派发后响应丢失') }
            } else if (method === 'selectOption') {
              const original = locator.selectOption.bind(locator)
              locator.selectOption = async (...args) => { await original(...args); throw new Error('注入：输入派发后响应丢失') }
            } else {
              const original = locator.setInputFiles.bind(locator)
              locator.setInputFiles = async (...args) => { await original(...args); throw new Error('注入：输入派发后响应丢失') }
            }
            return locator
          }
        })
        return context
      }
      return browser
    }
    const value = action === 'uploadFile' ? fixture.id : 'b'
    const goals: AgentTestGoal[] = [0, 1].map(index => ({ name: `输入${index}`, targetUrl, objective: '验证输入', requiredAssertions: [{ id: 'result', description: '结果可见' }], executionContract: {
      caseKey: `0-TC-${index}`, contractFingerprint: `${action}-${index}`, contract: {
        objective: '验证输入', preconditions: [], steps: ['输入'], expectedAssertions: ['结果可见'], forbiddenBehaviors: [], uncertainties: [], writeOperations: ['修改合成测试数据'],
        dataBindings: [{ id: 'value', label: '值', mode: 'manual', targetHint: '输入控件', businessIntent: '验证输入', constraints: { mustComeFromCurrentDom: false }, manual: { value, rationale: '合成数据已确认' } }],
      },
    } }))
    const writeAuthorizations = goals.map(goal => ({ caseId: goal.executionContract!.caseKey, caseKey: goal.executionContract!.caseKey, contractFingerprint: goal.executionContract!.contractFingerprint, operations: goal.executionContract!.contract.writeOperations!, targetUrl, confirmedAt: new Date().toISOString() }))
    let decisions = 0
    const before = writes
    const dynamic = await runAgentTest(goals, undefined, { launchBrowser, writeAuthorizations, artifactRoot: root, projectProvider: {
      async getProjectInfo() { return { id: 'fixture', name: 'fixture', configuredRoot: '.', connected: true, targetOrigins: [targetUrl] } },
      async resolveRoute() { return null }, async searchSource() { return [] }, async inspectFiles() { return { projectId: 'fixture', reason: 'unused', files: [], totalCharacters: 0 } },
    }, decisionProvider: { async decide({ snapshot }) {
      decisions++
      const elementRef = snapshot.elements.find(item => item.name === (action === 'fill' ? '文本' : action === 'selectOption' ? '选项' : '附件'))!.ref
      return { type: 'action', snapshotId: snapshot.snapshotId, reason: '输入已确认值', action: action === 'uploadFile' ? { action, elementRef, fixtureId: fixture.id } : { action, elementRef, value } }
    } } })
    assert.equal(writes - before, 1, action)
    assert.equal(decisions, 1, action)
    assert.deepEqual(dynamic.caseResults!.map(item => item.status), ['blocked', 'not_run'], action)
    const result = dynamic.caseResults![0]!.trajectory[0]!.result!
    assert.equal(result.code, 'action_outcome_unknown', action)
    assert.equal(result.retryable, false)
    if (action === 'uploadFile') assert.deepEqual(result.usedFixture, fixture)
    const locator = { by: 'css' as const, value: action === 'fill' ? 'input:not([type])' : action === 'selectOption' ? 'select' : 'input[type=file]' }
    const step: AutomationPlan['steps'][number] = action === 'uploadFile' ? { action, locator, fixtureId: fixture.id }
      : action === 'selectOption' ? { action, locator, value, optionBy: 'value' } : { action, locator, value }
    const fixed = await runAutomationPlan({ name: '输入', targetUrl, steps: [], casePlans: goals.map(goal => ({
      caseKey: goal.executionContract!.caseKey, title: goal.name, contractFingerprint: goal.executionContract!.contractFingerprint, contract: goal.executionContract!.contract,
      steps: [step, { action: 'expectText', text: '结果', assertionIndex: 0 }],
    })) }, undefined, { launchBrowser, writeAuthorizations, artifactRoot: root })
    assert.equal(writes - before, 2, action)
    assert.deepEqual(fixed.caseResults!.map(item => item.status), ['blocked', 'not_run'], action)
    assert.match(fixed.caseResults![0]!.error!, /结果不明.*注入/)
    if (action === 'uploadFile') assert.deepEqual(fixed.caseResults![0]!.usedFixtures, [fixture])
  }
})

test('输入准备只读取：等待可编辑和异步选项，错误控件、取消不派发事件，隐藏文件控件保留兼容', async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<input readonly oninput="window.changed=true"><select onchange="window.changed=true"></select><input type="file" hidden><button>非输入</button>')
  const input = page.locator('input:not([type])')
  await assert.rejects(waitForInputReady(input, { action: 'fill' }, undefined, 100), /只读.*未派发/)
  await input.evaluate(element => { setTimeout(() => { (element as HTMLInputElement).readOnly = false }, 100) })
  await waitForInputReady(input, { action: 'fill' }, undefined, 1000)
  const select = page.locator('select')
  await assert.rejects(waitForInputReady(select, { action: 'selectOption', value: 'b', optionBy: 'value' }, undefined, 100), /尚无指定选项/)
  await select.evaluate(element => { setTimeout(() => { element.innerHTML = '<option value="b" label="乙">不同文字</option>' }, 100) })
  await waitForInputReady(select, { action: 'selectOption', value: '乙', optionBy: 'label' }, undefined, 1000)
  await waitForInputReady(select, { action: 'selectOption', value: '乙', optionBy: 'valueOrLabel' }, undefined, 1000)
  await waitForInputReady(page.locator('input[type=file]'), { action: 'uploadFile' })
  for (const action of ['fill', 'uploadFile'] as const) await assert.rejects(waitForInputReady(page.locator('button'), { action }), /未派发/)
  const controller = new AbortController(); controller.abort(new Error('测试取消'))
  await assert.rejects(waitForInputReady(input, { action: 'fill' }, controller.signal), /测试取消/)
  assert.equal(await page.evaluate(() => Reflect.get(window, 'changed')), undefined)
})
