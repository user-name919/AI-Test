import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { automationStepSchema, type AutomationPlan, type CaseExecutionContract } from '@quality-ai/contracts'
import { describeAutomationStep } from '@quality-ai/contracts/live-execution'
import { validateFixedSelectData } from './fixed-select-option'
import { runAutomationPlan } from './playwright-runner'

test('固定原生下拉区分显示名与值，未确认数据受阻、不存在选项失败后继续', async t => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'quality-ai-native-select-'))
  t.after(() => rm(artifactRoot, { recursive: true, force: true }))
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<label>状态<select><option value="draft">草稿</option><option value="published">已发布</option></select></label>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const contract = (values: string[]): CaseExecutionContract => ({
    objective: '选择状态', preconditions: [], steps: ['选择已确认的状态'], expectedAssertions: ['状态为已发布'], forbiddenBehaviors: [], uncertainties: [],
    dataBindings: values.map((value, index) => ({ id: `v${index}`, label: '状态', mode: 'manual', targetHint: '状态下拉', businessIntent: '测试选择', constraints: { mustComeFromCurrentDom: false }, manual: { value, rationale: '合成夹具人工指定的选择值' } })),
  })
  const locator = { by: 'label' as const, value: '状态' }
  const steps = (value: string): AutomationPlan['steps'] => [
    { action: 'selectOption', locator, value, optionBy: 'value' },
    { action: 'expectValue', locator, value: 'published', assertionIndex: 0 },
  ]
  const valid = steps('published')
  valid.push({ action: 'selectOption', locator, value: '草稿', optionBy: 'label' }, { action: 'expectValue', locator, value: 'draft', assertionIndex: 1 })
  const validContract = contract(['published', '草稿'])
  validContract.expectedAssertions.push('再次选择后状态为草稿')
  const result = await runAutomationPlan({ name: '原生选择', targetUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, steps: steps('guessed'), casePlans: [
    { caseKey: '0-TC-0', title: '拒绝猜值', contractFingerprint: 'a', contract: contract([]), steps: steps('guessed') },
    { caseKey: '0-TC-1', title: '不存在的已确认值', contractFingerprint: 'b', contract: contract(['missing']), steps: steps('missing') },
    { caseKey: '0-TC-2', title: '按值和显示名选择', contractFingerprint: 'c', contract: validContract, steps: valid },
  ] }, undefined, { artifactRoot })
  assert.deepEqual(result.caseResults?.map(item => item.status), ['blocked', 'failed', 'passed'], JSON.stringify(result.caseResults?.map(item => item.error)))
  assert.match(result.caseResults?.[0].error ?? '', /不得猜测/)
  assert.deepEqual(result.caseResults?.[2].passedAssertions, ['assertion-0', 'assertion-1'])
  assert.match(describeAutomationStep(valid[2], 2).title, /按显示名称选择“草稿”/)
  assert.equal(automationStepSchema.parse({ action: 'selectOption', locator, value: 'draft' }).action, 'selectOption')
  assert.equal(automationStepSchema.safeParse({ action: 'selectOption', locator, value: 'draft', optionBy: 'index' }).success, false)
  assert.throws(() => validateFixedSelectData('draft'), /最终契约/)
  const noEvidence = contract(['draft'])
  noEvidence.dataBindings[0].manual!.rationale = ' '
  assert.throws(() => validateFixedSelectData('draft', noEvidence), /有依据/)
})
