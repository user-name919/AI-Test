import { jsonrepair } from 'jsonrepair'
import { agentDecisionSchema, type AgentDecision } from '../shared/contracts'
import type { AgentDecisionInput, AgentDecisionProvider } from './test-agent'
import { getModelConfig, type ModelConfig } from './model-config'
import { ResponsesModelClient, type ModelMessage } from './model-client'
import { RuntimeDataBindingBlockedError } from './test-data-binding'

interface ResponsesDecisionProviderOptions extends Partial<ModelConfig> {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const decisionSystemPrompt = `你是 B 端网页自动化测试的单步决策器。你只能根据当前测试目标、当前语义 DOM、最近轨迹和可选源码上下文决定下一步，输出一个严格 JSON 对象，不输出 Markdown。

规则：
1. 每轮最多提出一个动作，禁止生成完整脚本或多个动作。
2. 页面元素只能使用当前 snapshotId 中存在的 elementRef，禁止编造 CSS、XPath 或元素引用。
3. 页面变化后必须基于新快照重新决策，不得沿用旧 elementRef。
4. DOM 足够时直接行动；确实无法判断时才请求项目源码，源码结论必须回到真实 DOM 验证。
5. requiredAssertions 中的每一项都必须通过带对应 assertionId 的 expect 动作验证。没有全部验证前禁止 finish。
6. 产品结果不符合预期时应执行断言并让测试失败，不得弱化或删除断言。优先选择能表达业务预期的精确断言，不要只用 expectText 代替状态、数量或属性断言。
7. press 仅用于键盘可达的组件交互；scroll 每次最多滚动 3000 像素；不得使用动作协议执行任意 JavaScript。
8. 源码上下文返回后系统会重新观察真实页面；优先使用新 DOM 中的导航入口。search_source 或 inspect_files 中发现的子模块路由不等于主应用可直接访问的 URL，未经当前部署验证不得直接 goto。
9. goto 只能使用当前部署中可从主应用访问的同源路径；不要丢失目标地址已有的应用前缀。无法确认外部可访问路径时继续操作真实导航或返回 blocked。
10. 无法安全继续时返回 blocked，不猜测账号、业务数据或不存在的页面状态。
11. 若 goal.executionContract 的 dataBindings 包含 runtime_dom，具体业务值不是示例数据：先在当前 DOM 找到可见 option，再输出 resolve_test_data。该决策不是 Playwright action，必须带当前 snapshotId、bindingId、sourceElementRef、来源 option 的非空严格子串 value 与原因。解析成功后，fill、selectOption、expectValue 对该绑定只能使用 valueRef，禁止把未经解析的文字作为 value。找不到安全来源时返回 blocked。
12. 高亮类断言只允许使用当前可观察 elementRef 的 class、data-state 属性；其预期值必须明确表达高亮或匹配（highlight、match、mark、keyword 或中文同义词）。仅看到匹配文本不算高亮通过。当前 DOM 没有这类证据时返回 blocked，不要编造 CSS 或脚本检查。

允许的决策：
- action：goto、click、fill、selectOption、check、uncheck、press、hover、scroll、expectVisible、expectHidden、expectEnabled、expectDisabled、expectChecked、expectValue、expectText、expectElementText、expectAttribute、expectCount、waitFor、screenshot
- resolve_test_data：为 runtime_dom binding 从当前可见 option 解析真实值
- need_project_context：resolve_route、search_source、inspect_files
- finish
- blocked

action.action 必须严格使用以下结构之一，不得创造 navigate、reload、observe、type、input、assert、sleep 等新动作名：
{"action":"goto","path":"/相对路径"}
{"action":"click","elementRef":"e3"}
{"action":"fill","elementRef":"e3","value":"输入内容"}
{"action":"fill","elementRef":"e3","valueRef":"已解析的 bindingId"}
{"action":"selectOption","elementRef":"e3","value":"选项值"}
{"action":"selectOption","elementRef":"e3","valueRef":"已解析的 bindingId"}
{"action":"check","elementRef":"e3"}
{"action":"uncheck","elementRef":"e3"}
{"action":"press","elementRef":"e3","key":"Enter"}
{"action":"hover","elementRef":"e3"}
{"action":"scroll","elementRef":"e3","deltaX":0,"deltaY":600}
{"action":"scroll","deltaX":0,"deltaY":600}
{"action":"expectVisible","elementRef":"e3","assertionId":"必要断言 ID"}
{"action":"expectHidden","target":{"by":"elementRef","elementRef":"e3"},"assertionId":"必要断言 ID"}
{"action":"expectHidden","target":{"by":"text","text":"加载中","exact":false},"assertionId":"必要断言 ID"}
{"action":"expectHidden","target":{"by":"role","role":"dialog","name":"编辑学生","exact":false},"assertionId":"必要断言 ID"}
{"action":"expectEnabled","elementRef":"e3","assertionId":"必要断言 ID"}
{"action":"expectDisabled","elementRef":"e3","assertionId":"必要断言 ID"}
{"action":"expectChecked","elementRef":"e3","checked":true,"assertionId":"必要断言 ID"}
{"action":"expectValue","elementRef":"e3","value":"预期值","assertionId":"必要断言 ID"}
{"action":"expectValue","elementRef":"e3","valueRef":"已解析的 bindingId","assertionId":"必要断言 ID"}
{"action":"expectText","text":"预期文字","assertionId":"必要断言 ID"}
{"action":"expectElementText","elementRef":"e3","text":"预期文字","exact":false,"assertionId":"必要断言 ID"}
{"action":"expectAttribute","elementRef":"e3","name":"aria-expanded","value":"true","match":"equals","assertionId":"必要断言 ID"}
{"action":"expectCount","containerRef":"e3","role":"option","name":"数学","exact":false,"count":1,"assertionId":"必要断言 ID"}
{"action":"waitFor","durationMs":1000}
{"action":"screenshot","name":"证据名称"}

页面尚未稳定时使用 waitFor；每次动作结束后系统会自动重新观察 DOM，不存在 observe 动作。

完整 action 决策示例：
{"type":"action","snapshotId":"当前 UUID","action":{"action":"click","elementRef":"e3"},"reason":"点击当前弹窗的保存按钮"}
源码请求示例：
{"type":"need_project_context","request":{"operation":"search_source","query":"编辑学生","scopes":["page","component"]},"reason":"DOM 中存在多个同名操作，需确认业务组件"}
完成示例：
{"type":"finish","summary":"所有必要操作和断言已完成"}
运行时数据解析示例：
{"type":"resolve_test_data","snapshotId":"当前 UUID","bindingId":"exam-keyword","sourceElementRef":"e8","value":"数学","reason":"从当前可见 option“模考数学一”选择部分关键词"}`

const allowedActionNames = [
  'goto', 'click', 'fill', 'selectOption', 'check', 'uncheck',
  'press', 'hover', 'scroll',
  'expectVisible', 'expectHidden', 'expectEnabled', 'expectDisabled', 'expectChecked',
  'expectValue', 'expectText', 'expectElementText', 'expectAttribute', 'expectCount',
  'waitFor', 'screenshot',
] as const

function decisionValidationError(candidate: unknown, error: unknown) {
  const actionName = candidate && typeof candidate === 'object'
    && 'action' in candidate && candidate.action && typeof candidate.action === 'object'
    && 'action' in candidate.action && typeof candidate.action.action === 'string'
    ? candidate.action.action
    : undefined
  if (actionName && !allowedActionNames.some(name => name === actionName)) {
    return `模型返回了不支持的动作“${actionName}”；action.action 只能是：${allowedActionNames.join('、')}`
  }
  return error instanceof Error ? error.message : String(error)
}

function isMalformedResolveTestDataDecision(candidate: unknown) {
  return Boolean(candidate && typeof candidate === 'object' && 'type' in candidate && candidate.type === 'resolve_test_data')
}

function compactInput(input: AgentDecisionInput) {
  return {
    goal: input.goal,
    currentSnapshot: input.snapshot,
    recentTrajectory: input.trajectory.slice(-8).map(item => ({ iteration: item.iteration, decision: item.decision, result: item.result })),
    projectContexts: input.projectContexts.slice(-2),
  }
}

function cleanJsonOutput(output: string) {
  return output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

export class ResponsesDecisionProvider implements AgentDecisionProvider {
  private readonly client: ResponsesModelClient

  constructor(options: ResponsesDecisionProviderOptions = {}) {
    this.client = new ResponsesModelClient(getModelConfig(options), options.fetchImpl, options.timeoutMs ?? 60_000)
  }

  async decide(input: AgentDecisionInput): Promise<AgentDecision> {
    const messages: ModelMessage[] = [
      { role: 'system', content: decisionSystemPrompt },
      { role: 'user', content: `请决定下一步。当前输入：\n${JSON.stringify(compactInput(input))}` },
    ]
    let lastError: Error | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const output = await this.client.generateText({ messages, maxOutputTokens: 1200 })
        try {
          const candidate: unknown = JSON.parse(jsonrepair(cleanJsonOutput(output)))
          return agentDecisionSchema.parse(candidate)
        } catch (error) {
          let candidate: unknown
          try { candidate = JSON.parse(jsonrepair(cleanJsonOutput(output))) } catch { candidate = undefined }
          lastError = isMalformedResolveTestDataDecision(candidate)
            ? new RuntimeDataBindingBlockedError(`resolve_test_data 决策结构无效：${decisionValidationError(candidate, error)}`)
            : new Error(decisionValidationError(candidate, error))
          if (attempt < 2) {
            messages.push({ role: 'assistant', content: output.slice(0, 8_000) })
            messages.push({ role: 'user', content: `上一个 JSON 未通过 AgentDecision Schema 校验：${lastError.message.slice(0, 2_000)}。action.action 必须从 ${allowedActionNames.join('、')} 中选择；页面未稳定请使用 waitFor，系统会自动重新观察，不要输出 observe 或 reload。请只修复结构和字段，仍然只输出一个 JSON 对象。` })
            continue
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    if (lastError instanceof RuntimeDataBindingBlockedError) throw lastError
    throw new Error(`单步决策失败：${lastError?.message ?? '未知错误'}`)
  }
}
