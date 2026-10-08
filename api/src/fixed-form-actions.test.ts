import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { automationStepSchema, type AutomationPlan } from '@quality-ai/contracts'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
import { runAutomationPlan } from './automation/playwright-runner'

type AutomationStep = AutomationPlan['steps'][number]

test('固定表单操作使用真实选中状态，mixed失败后同会话继续键盘和悬停', async t => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-fixed-form-'))
  t.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<label><input id="flag" type="checkbox">订阅</label>
      <div id="mixed" role="checkbox" aria-checked="mixed">部分选中</div>
      <input aria-label="筛选" onkeydown="if(event.key==='ArrowDown')this.value='实际候选'">
      <button onmouseenter="document.querySelector('#hint').hidden=false">提示入口</button>
      <div id="hint" hidden>提示内容</div>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const locator = { by: 'label' as const, value: '订阅' }
  const wrong: AutomationStep[] = [{ action: 'expectChecked', locator: { by: 'css', value: '#mixed' }, checked: false, assertionIndex: 0 }]
  const right: AutomationStep[] = [
    { action: 'check', locator },
    { action: 'check', locator },
    { action: 'expectChecked', locator, checked: true, assertionIndex: 0 },
    { action: 'uncheck', locator },
    { action: 'expectChecked', locator, checked: false, assertionIndex: 1 },
    { action: 'press', locator: { by: 'label', value: '筛选' }, key: 'ArrowDown' },
    { action: 'expectValue', locator: { by: 'label', value: '筛选' }, value: '实际候选', assertionIndex: 2 },
    { action: 'hover', locator: { by: 'role', value: 'button', name: '提示入口' } },
    { action: 'expectVisible', locator: { by: 'css', value: '#hint' }, assertionIndex: 3 },
  ]
  const contract = (expectedAssertions: string[]) => ({ objective: '表单状态', preconditions: [], steps: ['按已确认状态操作'], expectedAssertions, dataBindings: [], forbiddenBehaviors: [], uncertainties: [] })
  const result = await runAutomationPlan({ name: '表单', targetUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, steps: wrong, casePlans: [
    { caseKey: '0-TC-0', title: 'mixed不是未选中', contractFingerprint: 'wrong', contract: contract(['未选中']), steps: wrong },
    { caseKey: '0-TC-1', title: '明确状态与键盘悬停', contractFingerprint: 'right', contract: contract(['已勾选', '已取消', '键盘选择候选', '悬停展示提示']), steps: right },
  ] }, undefined, { artifactRoot })
  assert.deepEqual(result.caseResults?.map(item => item.status), ['failed', 'passed'], JSON.stringify(result.caseResults?.map(item => item.error)))
  assert.match(result.caseResults?.[0].error ?? '', /实际 "mixed"；预期 false/)
  assert.deepEqual(result.caseResults?.[1].passedAssertions, ['assertion-0', 'assertion-1', 'assertion-2', 'assertion-3'])
  assert.equal(result.caseResults?.[1].steps.length, right.length)
  assert.match(describeAutomationStep(right[4], 4).title, /未选中/)
  assert.match(describeAutomationStep(right[5], 5).title, /ArrowDown/)
  assert.equal(automationStepSchema.safeParse({ action: 'press', locator, key: 'Control+W' }).success, false)
  assert.equal(automationStepSchema.safeParse({ action: 'expectChecked', locator, checked: 'false' }).success, false)
})
