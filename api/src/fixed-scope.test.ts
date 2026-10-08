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

test('固定范围定位不点击背景同名按钮，局部文本不借背景通过，失败继续表格行验证', async t => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-fixed-scope-'))
  t.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<button onclick="document.querySelector('#background').textContent='误点背景'">保存</button>
      <div id="background">保存成功</div>
      <section role="dialog" aria-label="编辑订单"><div role="status">待保存</div><button onclick="this.previousElementSibling.textContent='已保存订单'">保存</button></section>
      <table aria-label="订单"><tr><td>订单甲</td><td><button onclick="document.querySelector('#background').textContent='误点甲行'">保存</button></td></tr>
      <tr><td>订单乙</td><td><button onclick="document.querySelector('#result').textContent='乙行已保存'">保存</button></td></tr></table><div id="result">未保存</div>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const dialog = [{ by: 'role' as const, value: 'dialog', name: '编辑订单', exact: true }]
  const wrong: AutomationPlan['steps'] = [{ action: 'expectElementText', locator: { by: 'role', value: 'status', scope: dialog }, text: '保存成功', exact: true, assertionIndex: 0 }]
  const right: AutomationPlan['steps'] = [
    { action: 'click', locator: { by: 'role', value: 'button', name: '保存', exact: true, scope: dialog } },
    { action: 'expectElementText', locator: { by: 'role', value: 'status', scope: dialog }, text: '已保存订单', exact: true, assertionIndex: 0 },
    { action: 'click', locator: { by: 'role', value: 'button', name: '保存', exact: true, scope: [{ by: 'role', value: 'table', name: '订单', exact: true }, { by: 'role', value: 'row', name: '订单乙 保存', exact: true }] } },
    { action: 'expectElementText', locator: { by: 'css', value: '#result' }, text: '乙行', exact: false, assertionIndex: 1 },
    { action: 'expectElementText', locator: { by: 'css', value: '#background' }, text: '保存成功', exact: true, assertionIndex: 2 },
  ]
  const contract = (expectedAssertions: string[]) => ({ objective: '限定范围', preconditions: [], steps: ['操作目标区域'], expectedAssertions, dataBindings: [], forbiddenBehaviors: [], uncertainties: [] })
  const result = await runAutomationPlan({ name: '限定区域', targetUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, steps: wrong, casePlans: [
    { caseKey: '0-TC-0', title: '背景成功不代表弹窗成功', contractFingerprint: 'a', contract: contract(['弹窗保存成功']), steps: wrong },
    { caseKey: '0-TC-1', title: '弹窗和指定行', contractFingerprint: 'b', contract: contract(['弹窗已保存', '乙行已保存', '背景未被操作']), steps: right },
  ] }, undefined, { artifactRoot })
  assert.deepEqual(result.caseResults?.map(item => item.status), ['failed', 'passed'], JSON.stringify(result.caseResults?.map(item => item.error)))
  assert.match(result.caseResults?.[0].error ?? '', /实际 "待保存"/)
  assert.equal(result.caseResults?.[1].passedAssertions.length, 3)
  assert.match(describeAutomationStep(right[0], 0).title, /编辑订单.*范围内/)
  assert.match(describeAutomationStep(right[1], 1).title, /已保存订单/)
  assert.equal(automationStepSchema.safeParse({ action: 'click', locator: { by: 'text', value: '保存', scope: Array(5).fill(dialog[0]) } }).success, false)
})
