import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import type { AgentDecisionProvider } from './test-agent'
import { TestAgent } from './test-agent'
import { PageObserver } from './page-observer'
import { SingleActionExecutor } from './single-action-executor'
import { agentTestGoalSchema } from '@quality-ai/contracts'

function runtimeDataGoal(requiredAssertions = [{ id: 'filtered', description: '来源 option 仍在筛选结果中' }]) {
  return agentTestGoalSchema.parse({
    name: '按部分关键词筛选考试', targetUrl: 'http://localhost:5173/mock-exams', objective: '从真实 option 解析部分关键词并筛选',
    requiredAssertions,
    executionContract: {
      caseKey: '0-TC-3', contractFingerprint: 'runtime-dom-binding',
      contract: {
        objective: '按部分关键词筛选考试', preconditions: [], steps: ['打开下拉框', '从真实 option 取部分关键词'], expectedAssertions: requiredAssertions.map(item => item.description),
        dataBindings: [{
          id: 'exam-keyword', label: '考试筛选关键词', mode: 'runtime_dom', targetHint: '考试搜索框', businessIntent: '筛选考试',
          strategy: 'visible_option_substring',
          constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true, mustRemainAfterFiltering: true },
        }], forbiddenBehaviors: [], uncertainties: [],
      },
    },
  })
}

test('runs an observe-decide-execute loop and requires declared assertions before finish', async testContext => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), 'quality-ai-agent-'))
  testContext.after(() => rm(artifactDirectory, { recursive: true, force: true }))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <label for="name">学生姓名</label><input id="name">
      <button onclick="document.querySelector('#result').textContent='保存成功'">保存</button>
      <div id="result"></div>
    `)
    const goal = agentTestGoalSchema.parse({
      name: '保存学生',
      targetUrl: 'http://localhost:5173/students',
      objective: '填写学生姓名并确认保存成功',
      requiredAssertions: [{ id: 'saved', description: '页面出现保存成功' }],
    })
    let turn = 0
    const decisionProvider: AgentDecisionProvider = {
      async decide({ snapshot }) {
        turn += 1
        if (turn === 1) return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'fill', elementRef: snapshot.elements.find(item => item.name === '学生姓名')?.ref ?? '' , value: '张三' },
          reason: '填写学生姓名',
        }
        if (turn === 2) return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'click', elementRef: snapshot.elements.find(item => item.name === '保存')?.ref ?? '' },
          reason: '提交表单',
        }
        if (turn === 3) return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'expectText', text: '保存成功', assertionId: 'saved' },
          reason: '验证保存结果',
        }
        return { type: 'finish', summary: '保存流程和结果验证完成' }
      },
    }
    const observer = new PageObserver()
    const executor = new SingleActionExecutor(page, observer.registry, goal.targetUrl, artifactDirectory)
    const result = await new TestAgent(goal, observer, executor, decisionProvider).run(page)
    assert.equal(result.status, 'passed')
    assert.equal(result.executedSteps, 3)
    assert.deepEqual(result.passedAssertions, ['saved'])
    assert.equal(result.trajectory[0].observation?.title, '')
    assert.ok(result.trajectory[0].observation?.elements.some(element => element.name === '学生姓名'))
    assert.equal(result.trajectory.at(-1)?.decision.type, 'finish')
    assert.equal(await page.locator('#name').inputValue(), '张三')
  } finally {
    await browser.close()
  }
})

test('rejects finish when a required assertion has not passed', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<button>保存</button>')
    const goal = agentTestGoalSchema.parse({
      name: '保存学生', targetUrl: 'http://localhost:5173', objective: '保存',
      requiredAssertions: [{ id: 'saved', description: '保存成功' }],
    })
    const provider: AgentDecisionProvider = { async decide() { return { type: 'finish', summary: '完成' } } }
    const observer = new PageObserver()
    const executor = new SingleActionExecutor(page, observer.registry, goal.targetUrl, tmpdir())
    const result = await new TestAgent(goal, observer, executor, provider).run(page)
    assert.equal(result.status, 'failed')
    assert.match(result.summary, /必要断言尚未完成/)
  } finally {
    await browser.close()
  }
})

test('re-observes and continues after a retryable technical action failure', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<button>选择考试</button><div>下拉框已展开</div>')
    const goal = agentTestGoalSchema.parse({
      name: '选择考试', targetUrl: 'http://localhost:5173', objective: '展开考试下拉框',
      requiredAssertions: [{ id: 'opened', description: '下拉框已展开' }],
    })
    let turn = 0
    let firstSnapshotId = ''
    const provider: AgentDecisionProvider = {
      async decide({ snapshot }) {
        turn += 1
        if (turn === 1) {
          firstSnapshotId = snapshot.snapshotId
          return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'click', elementRef: 'e1' }, reason: '展开下拉框' }
        }
        if (turn === 2) {
          assert.notEqual(snapshot.snapshotId, firstSnapshotId)
          return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'expectText', text: '下拉框已展开', assertionId: 'opened' }, reason: '验证展开结果' }
        }
        return { type: 'finish', summary: '已恢复并完成断言' }
      },
    }
    let execution = 0
    const executor = {
      async execute() {
        execution += 1
        if (execution === 1) return { ok: false, code: 'technical_action_failed', retryable: true, message: '元素已重新渲染', durationMs: 1, pageChanged: false }
        return { ok: true, code: 'ok', retryable: false, message: '动作执行成功', durationMs: 1, pageChanged: false }
      },
    } as unknown as SingleActionExecutor
    const observer = new PageObserver()
    const result = await new TestAgent(goal, observer, executor, provider).run(page)

    assert.equal(result.status, 'passed')
    assert.equal(result.executedSteps, 2)
    assert.equal(result.trajectory[0].result?.retryable, true)
    assert.equal(result.trajectory[0].recovery?.status,'reobserved')
    assert.deepEqual(result.passedAssertions, ['opened'])
    let failedCalls=0
    const technicalExecutor={async execute(){failedCalls++;return {ok:false,code:'technical_action_failed',retryable:true,message:'timeout',durationMs:1,pageChanged:false}}} as unknown as SingleActionExecutor
    const alternating:AgentDecisionProvider={async decide({snapshot}){return {type:'action',snapshotId:snapshot.snapshotId,action:{action:failedCalls%2?'hover':'click',elementRef:'e1'},reason:'基于新快照定位'}}}
    const exhausted=await new TestAgent(goal,new PageObserver(),technicalExecutor,alternating).run(page)
    assert.equal(exhausted.status,'blocked')
    assert.equal(failedCalls,3)
    assert.deepEqual(exhausted.trajectory.map(item=>item.recovery?.status),['reobserved','reobserved','exhausted'])
    failedCalls=0
    const assertionProvider:AgentDecisionProvider={async decide({snapshot}){return {type:'action',snapshotId:snapshot.snapshotId,action:{action:'expectText',text:'下拉框已展开',assertionId:'opened'},reason:'验证业务预期'}}}
    const assertionFailure=await new TestAgent(goal,new PageObserver(),technicalExecutor,assertionProvider).run(page)
    assert.equal(assertionFailure.status,'failed')
    assert.equal(failedCalls,1)
    assert.equal(assertionFailure.trajectory[0].recovery,undefined)
  } finally {
    await browser.close()
  }
})

test('records resolved DOM binding evidence and uses valueRef without counting resolver as a Playwright step', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <label for="search">考试搜索框</label><input id="search">
      <div role="option">模考数学一</div><div role="option">模考英语一</div>
    `)
    const goal = runtimeDataGoal([{ id: 'input', description: '搜索框使用已解析关键词' }])
    let turn = 0
    const provider: AgentDecisionProvider = {
      async decide({ snapshot }) {
        turn += 1
        const search = snapshot.elements.find(element => element.name === '考试搜索框')?.ref ?? ''
        const source = snapshot.elements.find(element => element.name === '模考数学一')?.ref ?? ''
        if (turn === 1) return {
          type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: 'exam-keyword', sourceElementRef: source,
          value: '数学', reason: '选择真实考试名称中的部分关键词',
        }
        if (turn === 2) return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'fill', elementRef: search, valueRef: 'exam-keyword' }, reason: '使用已解析关键词筛选',
        }
        if (turn === 3) return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'expectValue', elementRef: search, valueRef: 'exam-keyword', assertionId: 'input' }, reason: '确认输入来自绑定',
        }
        return { type: 'finish', summary: '筛选关键词已使用真实 DOM 数据' }
      },
    }
    const observer = new PageObserver()
    const executor = new SingleActionExecutor(page, observer.registry, goal.targetUrl, tmpdir())
    const result = await new TestAgent(goal, observer, executor, provider).run(page)

    assert.equal(result.status, 'passed')
    assert.equal(result.executedSteps, 2)
    const resolvedDataBindings = result.resolvedDataBindings ?? []
    assert.deepEqual(resolvedDataBindings, [{
      bindingId: 'exam-keyword', sourceElementRef: resolvedDataBindings[0]?.sourceElementRef,
      sourceText: '模考数学一', value: '数学', snapshotId: resolvedDataBindings[0]?.snapshotId,
      observedAt: resolvedDataBindings[0]?.observedAt, reason: '选择真实考试名称中的部分关键词',
    }])
    assert.equal(result.trajectory[0]?.decision.type, 'resolve_test_data')
    assert.equal(await page.locator('#search').inputValue(), '数学')
  } finally {
    await browser.close()
  }
})

for (const strategy of ['visible_option_full', 'non_matching_option_query'] as const) {
  test(`${strategy} 使用真实 option 解析后通过 valueRef 输入与断言`, async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent('<label for="search">考试搜索框</label><input id="search"><div role="option">合成考试甲</div>')
      const goal = runtimeDataGoal([{ id: 'input', description: '输入符合本次数据策略' }])
      const binding = goal.executionContract!.contract.dataBindings[0]
      binding.strategy = strategy
      binding.constraints = { mustComeFromCurrentDom: true }
      if (strategy === 'non_matching_option_query') binding.optionUniverse = { completeness: 'complete_local', options: ['合成考试甲'], evidence: '测试中固定的单选项本地夹具' }
      const value = strategy === 'visible_option_full' ? '合成考试甲' : '不存在的考试'
      let turn = 0
      const provider: AgentDecisionProvider = {
        async decide({ snapshot }) {
          turn += 1
          const search = snapshot.elements.find(element => element.role === 'textbox')!.ref
          if (turn === 1) return { type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: binding.id, sourceElementRef: snapshot.elements.find(element => element.role === 'option')!.ref, value, reason: '使用现场数据及已确认的候选范围' }
          if (turn === 2) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'fill', elementRef: search, valueRef: binding.id }, reason: '输入策略值' }
          if (turn === 3) return { type: 'action', snapshotId: snapshot.snapshotId, action: { action: 'expectValue', elementRef: search, valueRef: binding.id, assertionId: 'input' }, reason: '核对实际输入' }
          return { type: 'finish', summary: '已验证策略值输入' }
        },
      }
      const observer = new PageObserver()
      const result = await new TestAgent(goal, observer, new SingleActionExecutor(page, observer.registry, goal.targetUrl, tmpdir()), provider).run(page)
      assert.equal(result.status, 'passed')
      assert.equal(result.resolvedDataBindings?.[0].value, value)
      assert.equal(await page.locator('#search').inputValue(), value)
    } finally { await browser.close() }
  })
}

test('blocks the case when no safe DOM data proposal can be validated', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<label for="search">考试搜索框</label><input id="search"><div role="option">模考数学一</div>')
    const goal = runtimeDataGoal()
    const provider: AgentDecisionProvider = {
      async decide({ snapshot }) {
        return {
          type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: 'exam-keyword', sourceElementRef: 'e999',
          value: '数学', reason: '错误引用不存在的 option',
        }
      },
    }
    const observer = new PageObserver()
    const executor = new SingleActionExecutor(page, observer.registry, goal.targetUrl, tmpdir())
    const result = await new TestAgent(goal, observer, executor, provider).run(page)

    assert.equal(result.status, 'blocked')
    assert.equal(result.executedSteps, 0)
    assert.match(result.summary, /测试数据前置条件/)
  } finally {
    await browser.close()
  }
})

test('marks the product failed when a validated source disappears after filtering', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <label for="search">考试搜索框</label>
      <input id="search" oninput="document.querySelector('[role=option]').remove()">
      <div role="option">模考数学一</div>
    `)
    const goal = runtimeDataGoal()
    let turn = 0
    const provider: AgentDecisionProvider = {
      async decide({ snapshot }) {
        turn += 1
        const search = snapshot.elements.find(element => element.name === '考试搜索框')?.ref ?? ''
        const source = snapshot.elements.find(element => element.name === '模考数学一')?.ref ?? ''
        if (turn === 1) return {
          type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: 'exam-keyword', sourceElementRef: source,
          value: '数学', reason: '选择真实考试名称中的部分关键词',
        }
        return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'fill', elementRef: search, valueRef: 'exam-keyword' }, reason: '筛选真实来源 option',
        }
      },
    }
    const observer = new PageObserver()
    const executor = new SingleActionExecutor(page, observer.registry, goal.targetUrl, tmpdir())
    const result = await new TestAgent(goal, observer, executor, provider).run(page)

    assert.equal(result.status, 'failed')
    assert.match(result.summary, /筛选后仍保留来源 option/)
    assert.equal(result.executedSteps, 1)
  } finally {
    await browser.close()
  }
})

test('fails when filtering replaces the source option with a same-text non-option element', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <label for="search">考试搜索框</label>
      <input id="search" oninput="document.querySelector('[role=option]').remove(); document.body.insertAdjacentHTML('beforeend', '<button>模考数学一</button>')">
      <div role="option">模考数学一</div>
    `)
    const goal = runtimeDataGoal()
    let turn = 0
    const provider: AgentDecisionProvider = {
      async decide({ snapshot }) {
        turn += 1
        const search = snapshot.elements.find(element => element.name === '考试搜索框')?.ref ?? ''
        const source = snapshot.elements.find(element => element.name === '模考数学一' && element.role === 'option')?.ref ?? ''
        if (turn === 1) return {
          type: 'resolve_test_data', snapshotId: snapshot.snapshotId, bindingId: 'exam-keyword', sourceElementRef: source,
          value: '数学', reason: '选择真实考试名称中的部分关键词',
        }
        return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'fill', elementRef: search, valueRef: 'exam-keyword' }, reason: '筛选真实来源 option',
        }
      },
    }
    const observer = new PageObserver()
    const executor = new SingleActionExecutor(page, observer.registry, goal.targetUrl, tmpdir())
    const result = await new TestAgent(goal, observer, executor, provider).run(page)

    assert.equal(result.status, 'failed')
    assert.match(result.summary, /筛选后仍保留来源 option/)
    assert.equal(result.executedSteps, 1)
  } finally {
    await browser.close()
  }
})

test('rejects a runtime literal before calling the executor', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<label for="search">考试搜索框</label><input id="search"><div role="option">模考数学一</div>')
    const goal = runtimeDataGoal()
    let executions = 0
    const executor = {
      async execute() {
        executions += 1
        return { ok: true, code: 'ok', retryable: false, message: '不应执行', durationMs: 1, pageChanged: false }
      },
    } as unknown as SingleActionExecutor
    const provider: AgentDecisionProvider = {
      async decide({ snapshot }) {
        return {
          type: 'action', snapshotId: snapshot.snapshotId,
          action: { action: 'fill', elementRef: snapshot.elements.find(element => element.name === '考试搜索框')?.ref ?? '', value: '数学' },
          reason: '绕过真实 DOM binding',
        }
      },
    }
    const result = await new TestAgent(goal, new PageObserver(), executor, provider).run(page)

    assert.equal(result.status, 'failed')
    assert.match(result.summary, /未确认的 fixture\/manual 数据/)
    assert.equal(result.executedSteps, 0)
    assert.equal(executions, 0)
  } finally {
    await browser.close()
  }
})

test('blocks a malformed resolve_test_data candidate without calling the executor', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<label for="search">考试搜索框</label><input id="search"><div role="option">模考数学一</div>')
    const goal = runtimeDataGoal()
    let executions = 0
    const executor = {
      async execute() {
        executions += 1
        return { ok: true, code: 'ok', retryable: false, message: '不应执行', durationMs: 1, pageChanged: false }
      },
    } as unknown as SingleActionExecutor
    const provider: AgentDecisionProvider = {
      async decide() {
        return { type: 'resolve_test_data', bindingId: 'exam-keyword' } as never
      },
    }
    const result = await new TestAgent(goal, new PageObserver(), executor, provider).run(page)

    assert.equal(result.status, 'blocked')
    assert.match(result.summary, /测试数据前置条件/)
    assert.equal(result.executedSteps, 0)
    assert.equal(executions, 0)
  } finally {
    await browser.close()
  }
})

test('keeps malformed action candidates classified as failed', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<button>保存</button>')
    const goal = agentTestGoalSchema.parse({
      name: '保存', targetUrl: 'http://localhost:5173', objective: '保存',
      requiredAssertions: [{ id: 'saved', description: '保存成功' }],
    })
    const executor = { async execute() { throw new Error('不应执行') } } as unknown as SingleActionExecutor
    const provider: AgentDecisionProvider = { async decide() { return { type: 'action' } as never } }
    const result = await new TestAgent(goal, new PageObserver(), executor, provider).run(page)

    assert.equal(result.status, 'failed')
    assert.match(result.summary, /Agent 决策无效/)
    assert.equal(result.executedSteps, 0)
  } finally {
    await browser.close()
  }
})
