import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTestGoalSchema, pageSnapshotSchema } from '@quality-ai/contracts'
import { ResponsesDecisionProvider } from './responses-decision-provider'
import { RuntimeDataBindingBlockedError } from './test-data-binding'

function decisionInput() {
  return {
    goal: agentTestGoalSchema.parse({ name: '查询学生', targetUrl: 'http://localhost:5173/students', objective: '输入姓名并查询', requiredAssertions: [{ id: 'student-visible', description: '列表显示张三' }] }),
    snapshot: pageSnapshotSchema.parse({
      snapshotId: '7aa1e1de-dcc0-4aa5-8182-c647d615c96a', observedAt: new Date().toISOString(), url: 'http://localhost:5173/students', title: '学生管理', loading: false,
      elements: [{ ref: 'e1', tag: 'input', role: 'textbox', name: '学生姓名', visible: true, enabled: true }], dialogs: [], tables: [], messages: [],
      stats: { discoveredElements: 1, returnedElements: 1, truncated: false },
    }),
    trajectory: [], projectContexts: [],
  }
}

function responseWithText(text: string, status = 200) {
  return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }), { status })
}

const modelOptions = {
  apiKey: 'test-key', baseUrl: 'http://model.test/v1', model: 'test-model',
  userAgent: 'codex_cli_rs/test', originator: 'codex_cli_rs',
} as const

test('已取消的决策不发送网络请求',async()=>{
  let calls=0
  const provider=new ResponsesDecisionProvider({...modelOptions,fetchImpl:async()=>{calls++;throw new Error('不应调用')}})
  const controller=new AbortController();controller.abort(new Error('已取消'))
  await assert.rejects(provider.decide(decisionInput(),controller.signal),/已取消/)
  assert.equal(calls,0)
})

test('uses Responses API headers and returns a validated single action', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const provider = new ResponsesDecisionProvider({ ...modelOptions, fetchImpl: async (input, init) => {
    requests.push({ url: String(input), init })
    return responseWithText(JSON.stringify({ type: 'action', snapshotId: decisionInput().snapshot.snapshotId, action: { action: 'fill', elementRef: 'e1', value: '张三' }, reason: '填写查询条件' }))
  } })
  assert.equal((await provider.decide(decisionInput())).type, 'action')
  assert.equal(requests[0].url, 'http://model.test/v1/responses')
  assert.equal(new Headers(requests[0].init?.headers).get('originator'), 'codex_cli_rs')
  const body = JSON.parse(String(requests[0].init?.body)) as { instructions: string; input: Array<{ content: string }>; store: boolean }
  assert.match(body.input[0].content, /学生姓名/)
  assert.match(body.instructions, /expectAttribute/)
  assert.match(body.instructions, /press/)
  assert.equal(body.store, false)
})

test('人工历史经验进入模型上下文但不改变原始必需断言',async()=>{
  let body=''
  const provider=new ResponsesDecisionProvider({...modelOptions,fetchImpl:async(_input,init)=>{
    body=String(init?.body)
    return responseWithText(JSON.stringify({type:'blocked',reason:'缺少当前页面依据'}))
  }})
  const input=decisionInput()
  input.goal.memoryHints=[{id:'11111111-1111-4111-8111-111111111111',revision:2,lesson:'先核对可见选项',executionId:'source',projectId:'project',targetUrl:input.goal.targetUrl,sourceCommit:'a'.repeat(40)}]
  const before=structuredClone(input.goal.requiredAssertions)
  await provider.decide(input)
  assert.match(body,/先核对可见选项/)
  assert.match(body,/不得改变人工最终断言/)
  assert.deepEqual(input.goal.requiredAssertions,before)
})

test('repairs an invalid first Responses output with schema feedback', async () => {
  const bodies: string[] = []
  let call = 0
  const provider = new ResponsesDecisionProvider({ ...modelOptions, fetchImpl: async (_input, init) => {
    bodies.push(String(init?.body)); call += 1
    return responseWithText(call === 1
      ? '{"type":"action","snapshotId":"invalid","action":{"action":"click","elementRef":"e1"},"reason":"查询"}'
      : '{"type":"blocked","reason":"缺少可安全执行的信息"}')
  } })
  assert.deepEqual(await provider.decide(decisionInput()), { type: 'blocked', reason: '缺少可安全执行的信息' })
  assert.match(bodies[1], /未通过 AgentDecision Schema 校验/)
})

test('repairs an unsupported action name with the exact allowed action protocol', async () => {
  const bodies: string[] = []
  let call = 0
  const provider = new ResponsesDecisionProvider({ ...modelOptions, fetchImpl: async (_input, init) => {
    bodies.push(String(init?.body)); call += 1
    return responseWithText(call === 1
      ? `{"type":"action","snapshotId":"${decisionInput().snapshot.snapshotId}","action":{"action":"observe"},"reason":"重新观察"}`
      : `{"type":"action","snapshotId":"${decisionInput().snapshot.snapshotId}","action":{"action":"waitFor","durationMs":1000},"reason":"等待页面稳定"}`)
  } })

  const decision = await provider.decide(decisionInput())
  assert.equal(decision.type, 'action')
  assert.equal(decision.type === 'action' ? decision.action.action : '', 'waitFor')
  assert.match(bodies[1], /不支持的动作/)
  assert.match(bodies[1], /waitFor/)
  assert.match(bodies[1], /不要输出 observe/)
})

test('reports the unsupported action name after bounded repair attempts', async () => {
  const provider = new ResponsesDecisionProvider({ ...modelOptions, fetchImpl: async () => responseWithText(
    `{"type":"action","snapshotId":"${decisionInput().snapshot.snapshotId}","action":{"action":"reload"},"reason":"刷新页面"}`,
  ) })

  await assert.rejects(provider.decide(decisionInput()), /不支持的动作“reload”/)
})

test('instructs the model to resolve real DOM data before using valueRef', async () => {
  const requests: Array<{ init?: RequestInit }> = []
  const provider = new ResponsesDecisionProvider({ ...modelOptions, fetchImpl: async (_input, init) => {
    requests.push({ init })
    return responseWithText(JSON.stringify({
      type: 'resolve_test_data', snapshotId: decisionInput().snapshot.snapshotId, bindingId: 'student-keyword',
      sourceElementRef: 'e1', value: '张', reason: '从当前学生 option 中选择部分关键词',
    }))
  } })
  const input = decisionInput()
  input.goal = agentTestGoalSchema.parse({
    ...input.goal,
    executionContract: {
      caseKey: '0-TC-1', contractFingerprint: 'student-search',
      contract: {
        objective: '从真实学生 option 解析关键词', preconditions: [], steps: ['解析真实 option'], expectedAssertions: ['筛选结果'],
        dataBindings: [{
          id: 'student-keyword', label: '学生筛选关键词', mode: 'runtime_dom', targetHint: '学生姓名', businessIntent: '筛选学生',
          strategy: 'visible_option_substring', constraints: { mustComeFromCurrentDom: true, mustBePartialOfSource: true },
        }], forbiddenBehaviors: [], uncertainties: [],
      },
    },
  })

  assert.equal((await provider.decide(input)).type, 'resolve_test_data')
  const body = JSON.parse(String(requests[0]?.init?.body)) as { instructions: string; input: Array<{ content: string }> }
  assert.match(body.instructions, /resolve_test_data/)
  assert.match(body.instructions, /valueRef/)
  assert.match(body.instructions, /class、data-state/)
  assert.doesNotMatch(body.instructions, /aria-\*/)
  assert.match(body.input[0]?.content ?? '', /student-keyword/)
})

test('reports repeated malformed resolve_test_data decisions as a blocked-data domain error', async () => {
  let calls = 0
  const provider = new ResponsesDecisionProvider({ ...modelOptions, fetchImpl: async () => {
    calls += 1
    return responseWithText('{"type":"resolve_test_data","bindingId":"student-keyword"}')
  } })

  await assert.rejects(provider.decide(decisionInput()), RuntimeDataBindingBlockedError)
  assert.equal(calls, 3)
})
