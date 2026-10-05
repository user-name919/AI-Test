import { jsonrepair } from 'jsonrepair'
import { reviewExecutionContractSchema, type RequirementAnalysis, type ReviewExecutionContract } from '@quality-ai/contracts'
import { getModelConfig } from './integrations/model/config'
import { ResponsesModelClient, type ModelMessage } from './integrations/model/responses-client'
import type { ProjectKnowledgeProvider, RouteKnowledge, SourceContextFile } from './integrations/project-knowledge/types'

export interface ReviewContractInput {
  question: RequirementAnalysis['questions'][number]
  finalStatement: string
  requirement: RequirementAnalysis
  testCase: RequirementAnalysis['testCases'][number]
  sourceContext?: unknown
}

interface ReviewContractModelClient {
  generateText(input: { messages: ModelMessage[]; maxOutputTokens: number }): Promise<string>
}

interface GenerateReviewContractOptions {
  client?: ReviewContractModelClient
}

export interface ReviewSourceContext {
  route: RouteKnowledge | null
  files: SourceContextFile[]
  warnings: string[]
}

export async function collectReviewSourceContext(
  provider: ProjectKnowledgeProvider,
  targetUrl: string,
  requirement: RequirementAnalysis,
  question: RequirementAnalysis['questions'][number],
): Promise<ReviewSourceContext> {
  const warnings: string[] = []
  let route: RouteKnowledge | null = null
  try {
    route = await provider.resolveRoute({ url: targetUrl })
  } catch (error) {
    warnings.push(`路由解析未完成：${error instanceof Error ? error.message : String(error)}`)
  }

  let paths = [...new Set([route?.routeFile, route?.componentFile].filter((path): path is string => Boolean(path)))]
  if (!paths.length) {
    try {
      const matches = await provider.searchSource({ query: question.title || requirement.title, scopes: ['page', 'component'], limit: 4 })
      paths = [...new Set(matches.map(match => match.path))]
    } catch (error) {
      warnings.push(`源码搜索未完成：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!paths.length) return { route, files: [], warnings }
  try {
    const context = await provider.inspectFiles({
      paths: paths.slice(0, 4),
      reason: `辅助判断“${question.title}”的页面行为和可验证结果`,
    })
    return { route, files: context.files, warnings }
  } catch (error) {
    warnings.push(`局部源码读取未完成：${error instanceof Error ? error.message : String(error)}`)
    return { route, files: [], warnings }
  }
}

const reviewContractSystemPrompt = `你是 B 端前端测试架构师，负责把人工确认的业务口径转换成可验证的自动化执行契约。只输出 JSON 对象，不输出 Markdown。
必须遵守：
1. 人工最终口径是业务依据，AI 建议、PRD、测试用例和源码只是补充上下文。
2. 只能从提供的材料推断，不能编造接口、字段、提示文案或业务数据。
3. behaviors 描述页面可观察行为，assertions 必须是可以通过真实 DOM、可访问性状态、文本、值、数量或属性验证的断言。
4. uncertainties 记录仍然无法确定的事项；有不确定项时 confidence 不能为 high。
5. sourceHints 只记录源码中值得回到真实页面验证的线索，不把源码结论直接当作页面事实。
6. 至少给出一条 behaviors 和一条 assertions。`

function cleanJsonOutput(output: string) {
  return output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

export async function generateReviewExecutionContract(input: ReviewContractInput, options: GenerateReviewContractOptions = {}): Promise<ReviewExecutionContract> {
  if (!input.finalStatement.trim()) throw new Error('人工最终口径不能为空')
  const client = options.client ?? new ResponsesModelClient(getModelConfig())
  const messages: ModelMessage[] = [
    { role: 'system', content: reviewContractSystemPrompt },
    {
      role: 'user',
      content: `请把下面的问题和人工最终口径转换为执行契约。\n${JSON.stringify({
        question: input.question,
        humanFinalStatement: input.finalStatement,
        requirement: input.requirement,
        selectedTestCase: input.testCase,
        sourceContext: input.sourceContext ?? '未提供源码上下文，请将相关缺口写入 uncertainties',
      })}`,
    },
  ]
  const output = await client.generateText({ messages, maxOutputTokens: 4_000 })
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonrepair(cleanJsonOutput(output)))
  } catch (error) {
    throw new Error(`执行契约 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed && typeof parsed === 'object' && 'assertions' in parsed && Array.isArray(parsed.assertions) && parsed.assertions.length === 0) {
    throw new Error('至少需要一条可验证断言')
  }
  return reviewExecutionContractSchema.parse(parsed)
}
