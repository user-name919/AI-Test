import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationPlan, TestDataBinding } from '@quality-ai/contracts'
import { automationStepSchema } from '@quality-ai/contracts'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
import { runAutomationPlan } from './automation/playwright-runner'

test('固定跨源嵌套框架定位与运行时数据不借用主页面，歧义失败后继续', async t => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-fixed-frame-'))
  t.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const inner = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(request.url === '/outer' ? '<iframe id="nested" src="/inner"></iframe>' : `<label>搜索<input oninput="document.querySelectorAll('[role=option]').forEach(e=>e.hidden=!e.textContent.includes(this.value))"></label><div role="option">真实数学课程</div><div role="option">真实英语课程</div><div id="state">未保存</div><button onclick="document.querySelector('#state').textContent='框架已保存'">保存</button>`)
  })
  await new Promise<void>(resolve => inner.listen(0, '127.0.0.1', resolve))
  const inside = inner.address(); assert.ok(inside && typeof inside !== 'string')
  const innerUrl = `http://127.0.0.1:${inside.port}`
  const outer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<div id="state">主页面成功</div><div role="option">主页面伪数据</div><button onclick="document.querySelector('#state').textContent='误点背景'">保存</button><iframe id="business" src="${innerUrl}/outer"></iframe><iframe id="other" src="${innerUrl}/outer"></iframe>`)
  })
  await new Promise<void>(resolve => outer.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for(const server of [outer,inner]) await new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())}) })
  const address = outer.address(); assert.ok(address && typeof address !== 'string')
  const framePath = [{ by: 'css' as const, value: '#business' }, { by: 'css' as const, value: '#nested' }]
  const binding: TestDataBinding = { id: 'search', label: '部分搜索', mode: 'runtime_dom', targetHint: '搜索', businessIntent: '从当前框架实际选项选部分词', constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true }, strategy: 'visible_option_substring' }
  const wrong: AutomationPlan['steps'] = [{ action: 'expectElementText', locator: { by: 'css', value: '#state', framePath }, text: '主页面成功', exact: true, assertionIndex: 0 }]
  const ambiguous: AutomationPlan['steps'] = [{ action: 'click', locator: { by: 'role', value: 'button', name: '保存', framePath: [{ by: 'css', value: 'iframe' }, framePath[1]] } }, ...wrong]
  const right: AutomationPlan['steps'] = [
    { action: 'resolveTestData', bindingId: 'search', framePath },
    { action: 'fill', locator: { by: 'label', value: '搜索', framePath }, valueRef: 'search' },
    { action: 'expectText', valueRef: 'search', framePath, assertionIndex: 0 },
    { action: 'click', locator: { by: 'role', value: 'button', name: '保存', framePath } },
    { action: 'expectElementText', locator: { by: 'css', value: '#state', framePath }, text: '框架已保存', exact: true, assertionIndex: 1 },
    { action: 'expectElementText', locator: { by: 'css', value: '#state' }, text: '主页面成功', exact: true, assertionIndex: 2 },
  ]
  const contract = (expectedAssertions: string[], dataBindings: TestDataBinding[] = []) => ({ objective: '框架内验证', preconditions: [], steps: ['进入框架并操作'], expectedAssertions, dataBindings, forbiddenBehaviors: [], uncertainties: [] })
  let sourceUrl = ''
  const result = await runAutomationPlan({ name: '跨源嵌套框架', targetUrl: `http://127.0.0.1:${address.port}`, steps: right, casePlans: [
    { caseKey: '0-TC-0', title: '主页面文本不冒充框架成功', contractFingerprint: 'a', contract: contract(['框架显示主页面成功']), steps: wrong },
    { caseKey: '0-TC-1', title: '框架歧义不静默取第一个', contractFingerprint: 'b', contract: contract(['框架显示主页面成功']), steps: ambiguous },
    { caseKey: '0-TC-2', title: '框架数据与操作', contractFingerprint: 'c', contract: contract(['过滤后实际选项存在', '框架已保存', '主页面未被误操作'], [binding]), steps: right },
  ] }, undefined, { artifactRoot, resolveTestData: async (_binding, snapshot) => {
    sourceUrl = snapshot.url
    assert.equal(snapshot.elements.some(element => element.name === '主页面伪数据'), false)
    const option = snapshot.elements.find(element => element.name === '真实数学课程')!
    return { type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: 'search', sourceElementRef: option.ref, value: '数学', reason: '从真实框架选项选严格子串' }
  } })
  assert.deepEqual(result.caseResults?.map(item=>item.status), ['failed','failed','passed'], JSON.stringify(result.caseResults?.map(item=>item.error)))
  assert.match(result.caseResults?.[1].error ?? '', /strict mode violation/)
  assert.equal(sourceUrl, `${innerUrl}/inner`)
  assert.equal(result.caseResults?.[2].resolvedDataBindings[0].sourceText, '真实数学课程')
  assert.equal(result.caseResults?.[2].passedAssertions.length, 3)
  assert.match(describeAutomationStep(right[0],0).title, /嵌入页面.*#business.*#nested/)
  assert.equal(automationStepSchema.safeParse({ action: 'click', locator: { by: 'text', value: '保存', framePath: Array(5).fill(framePath[0]) } }).success, false)
})
